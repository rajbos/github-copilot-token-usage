/**
 * Worker-thread entry point (bundled to `dist/analysisWorker.js`).
 *
 * Owns every CPU-heavy step of a refresh — reading, `JSON.parse`, token estimation, usage
 * analysis, rollups — so the extension host's event loop stays free to deliver webview
 * clicks. It builds its own adapter registry (the adapters are `vscode`-free and keep their
 * own caches), answers requests from `analysisProtocol.ts`, and holds no state the host
 * depends on: killing and respawning it is always safe.
 */
import { AsyncLocalStorage } from 'async_hooks';
import { parentPort, workerData } from 'worker_threads';

import tokenEstimatorsData from '../../../src/tokenEstimators.json';
import modelPricingData from '../../../src/modelPricing.json';
import toolNamesData from '../../../src/toolNames.json';
import type { ModelPricing, TokenEstimator } from '../../../src/types';
import { buildAdapterRegistry, createDataAccessInstances } from '../../../src/adapters';
import { estimateTokensFromText } from '../../../src/tokenEstimation';
import { setCopilotCliOtelUsageResolver, type CopilotCliOtelSessionUsage } from '../../../src/copilotCliOtel';
import { isMcpTool, extractMcpServerName } from '../../../src/workspaceHelpers';
import type { CopilotCliAdapter } from '../../../src/adapters/copilotCliAdapter';
import { analyzeSessionFile, quickAnalyzeSessionContent, supplementCacheWithDebugLog, type SessionAnalyzerDeps } from './sessionFileAnalyzer';
import { computeSessionFileDetails } from './sessionDetailsAnalyzer';
import { scanCustomizationFilesForWorkspace } from './workspaceCustomizationScan';
import type { AnalysisHostMessage, AnalysisRequest, AnalysisResponse, AnalysisWorkerData, AnalysisWorkerMessage, OtelUsageReply } from './analysisProtocol';

if (!parentPort) {
	throw new Error('analysisWorker must be started as a worker thread');
}
const port = parentPort;
const data = workerData as AnalysisWorkerData;

const post = (message: AnalysisWorkerMessage): void => port.postMessage(message);

/**
 * Which request the code currently running belongs to. A lookup that goes to the host is tagged with it (so the pool
 * knows that request is waiting on the host, not busy here), and a failed lookup is recorded on it.
 */
interface RequestContext { requestId: number; lookupError?: string }
const requestContext = new AsyncLocalStorage<RequestContext>();

// OTel-export lookups for Copilot CLI sessions are answered by the host (see setCopilotCliOtelUsageResolver).
const otelWaiters = new Map<number, { resolve: (usage: CopilotCliOtelSessionUsage | null) => void; reject: (error: Error) => void }>();
let nextRpcId = 1;
setCopilotCliOtelUsageResolver((sessionFile) => new Promise((resolve, reject) => {
	const context = requestContext.getStore();
	const rpcId = nextRpcId++;
	otelWaiters.set(rpcId, {
		resolve,
		reject: (error) => { if (context) { context.lookupError = error.message; } reject(error); },
	});
	post({ type: 'otelUsage', rpcId, requestId: context?.requestId ?? -1, sessionFile });
}));

function onOtelUsageReply(reply: OtelUsageReply): void {
	const waiter = otelWaiters.get(reply.rpcId);
	if (!waiter) { return; }
	otelWaiters.delete(reply.rpcId);
	if (reply.error !== undefined) { waiter.reject(new Error(reply.error)); }
	else { waiter.resolve(reply.usage); }
}

const tokenEstimators = tokenEstimatorsData.estimators as Record<string, TokenEstimator>;
const modelPricing = modelPricingData.pricing as { [key: string]: ModelPricing };
const toolNameMap = toolNamesData as { [key: string]: string };

const extensionUri = { fsPath: data.extensionPath, path: data.extensionPath, scheme: 'file' };
const ecosystems = buildAdapterRegistry({
	...createDataAccessInstances(extensionUri),
	estimateTokens: (text, model) => estimateTokensFromText(text, model ?? 'gpt-4', tokenEstimators),
	isMcpTool: (tool) => isMcpTool(tool),
	extractMcpServerName: (tool) => extractMcpServerName(tool, toolNameMap),
});

const copilotCliAdapter = ecosystems.find((adapter) => adapter.id === 'copilotcli') as CopilotCliAdapter | undefined;

const deps: SessionAnalyzerDeps = {
	warn: (message) => post({ type: 'warn', message }),
	ecosystems,
	tokenEstimators,
	modelPricing,
	toolNameMap,
	// No `windsurf`: its sessions are virtual (gRPC-backed) and the host keeps them in-process.
};

/**
 * Runs one request. The analysis code deliberately tolerates many failures (an unreadable file yields zeros, not an
 * exception), which is right for the data but wrong for a lookup that merely could not be answered *right now*: the
 * result would be cached as if it were complete. So if a host lookup failed during this request, the request fails
 * instead, and the file is simply tried again on the next refresh.
 */
async function handle(request: AnalysisRequest): Promise<AnalysisResponse> {
	const context: RequestContext = { requestId: request.id };
	const response = await requestContext.run(context, () => handleRequest(request));
	if (context.lookupError !== undefined && response.ok) {
		return { type: 'result', id: request.id, ok: false, error: `Copilot CLI usage lookup failed: ${context.lookupError}`, code: 'EOTELLOOKUP' };
	}
	return response;
}

async function handleRequest(request: AnalysisRequest): Promise<AnalysisResponse> {
	try {
		// This registry never ran discovery, so tell it what the host's discovery learned about this session.
		if ((request.op === 'analyze' || request.op === 'details') && request.copilotCliKinds?.length) {
			copilotCliAdapter?.noteSessionKinds(request.path, request.copilotCliKinds);
		}
		if (request.op === 'analyze') {
			const existing = request.existingRepository !== undefined ? { repository: request.existingRepository } : undefined;
			return { type: 'result', id: request.id, ok: true, result: await analyzeSessionFile(deps, request.path, request.mtime, request.size, existing) };
		}
		if (request.op === 'quick') {
			return { type: 'result', id: request.id, ok: true, result: await quickAnalyzeSessionContent(deps, request.path, request.content) };
		}
		if (request.op === 'customization') {
			return { type: 'result', id: request.id, ok: true, result: scanCustomizationFilesForWorkspace(request.workspace) };
		}
		if (request.op === 'details') {
			const stat = { size: request.size, mtime: new Date(request.mtimeMs) };
			return { type: 'result', id: request.id, ok: true, result: await computeSessionFileDetails(deps, request.path, stat, request.details) };
		}
		return { type: 'result', id: request.id, ok: true, result: await supplementCacheWithDebugLog(request.cached, request.path) };
	} catch (error) {
		const code = (error as NodeJS.ErrnoException | undefined)?.code;
		return { type: 'result', id: request.id, ok: false, error: error instanceof Error ? (error.stack ?? error.message) : String(error), ...(typeof code === 'string' ? { code } : {}) };
	}
}

/** Posts a response; if it cannot be cloned (DataCloneError), reports that instead of dying and being retried forever. */
function respond(response: AnalysisResponse): void {
	try {
		post(response);
	} catch (error) {
		post({ type: 'result', id: response.id, ok: false, error: `Could not return the analysis result: ${error instanceof Error ? error.message : String(error)}` });
	}
}

/**
 * Requests run concurrently. They are mostly waiting — on disk, and on the host's answer to an exact-usage
 * lookup that can take a minute the first time — and one request waiting must not hold up the ones behind it.
 * (Handling them strictly in order was tried; a single slow host lookup then froze every request queued on
 * the worker, and a whole refresh sat at a few percent.) CPU work still serializes on this thread by itself.
 */
port.on('message', (message: AnalysisHostMessage) => {
	if ('type' in message && message.type === 'otelUsageReply') { onOtelUsageReply(message); return; }
	void handle(message as AnalysisRequest).then(respond);
});

post({ type: 'ready' });
