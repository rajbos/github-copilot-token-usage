/**
 * The "details" half of session parsing: the per-file facts the Sessions list, Diagnostics
 * and Usage Analysis views show (interactions, context references, timestamps, repository).
 *
 * Like `sessionFileAnalyzer.ts` this is `vscode`-free and cache-free so it can run on a
 * worker thread. It fills in a `SessionFileDetails` skeleton the host prepared (path-derived
 * fields such as the editor label stay on the host) and reports what the host should write
 * to its cache; the host owns the actual cache update.
 */
import * as fs from 'fs';

import type { IEcosystemAdapter } from '../../../src/ecosystemAdapter';
import { getEcosystemDisplayName } from '../../../src/ecosystemAdapter';
import type { ModelUsage, SessionFileDetails } from '../../../src/types';
import { isJsonlContent, isUuidPointerFile, reconstructJsonlStateAsync } from '../../../src/tokenEstimation';
import { analyzeContextReferences, analyzeRequestContext, getModelUsageFromSession } from '../../../src/usageAnalysis';
import { extractRepositoryFromContentReferences, getRepoNameFromWorkspacePath } from '../../../src/workspaceHelpers';
import { findEcosystem, toUsageAnalysisDeps, type SessionAnalyzerDeps } from './sessionFileAnalyzer';

/** The two stat fields the details pass reads; plain data so it survives a worker round trip. */
export interface SessionStatLike {
	size: number;
	mtime: Date;
}

/** What the host should persist after a successful details pass. */
export interface SessionDetailsCacheUpdate {
	tokenResult?: { tokens: number; thinkingTokens: number; actualTokens: number };
	modelUsage?: ModelUsage;
}

export interface SessionDetailsResult {
	details: SessionFileDetails;
	/** Null when the pass failed part-way: the (partial) details are still returned, but nothing is cached. */
	cacheUpdate: SessionDetailsCacheUpdate | null;
}

function setDetailsTimestamps(details: SessionFileDetails, allTimestamps: number[], stat: SessionStatLike): void {
	// A malformed timestamp in a session log makes toISOString() throw; ignore those and fall back to the file's
	// mtime only when none are usable.
	const timestamps = allTimestamps.filter((ms) => !Number.isNaN(new Date(ms).getTime()));
	if (timestamps.length > 0) {
		timestamps.sort((a, b) => a - b);
		details.firstInteraction = new Date(timestamps[0]).toISOString();
		details.lastInteraction = new Date(timestamps[timestamps.length - 1]).toISOString();
	} else {
		details.lastInteraction = stat.mtime.toISOString();
	}
}

async function processEcosystemSessionDetails(eco: IEcosystemAdapter, sessionFile: string, details: SessionFileDetails): Promise<SessionDetailsResult> {
	const [meta, tokenResult, interactionCount, modelUsage] = await Promise.all([
		eco.getMeta(sessionFile), eco.getTokens(sessionFile), eco.countInteractions(sessionFile), eco.getModelUsage(sessionFile),
	]);
	details.title = meta.title;
	details.firstInteraction = meta.firstInteraction;
	details.lastInteraction = meta.lastInteraction;
	details.interactions = interactionCount;
	details.editorRoot = eco.getEditorRoot(sessionFile);
	details.editorName = getEcosystemDisplayName(eco, sessionFile);
	if (meta.workspacePath) {
		// Prefer the ecosystem's authoritative repository (e.g. Copilot CLI's DB "owner/repo"
		// column). Only fall back to deriving a name from the path when it's absent, and use a
		// worktree-aware derivation so app-store worktree paths resolve to the repo folder
		// instead of the transient worktree name.
		details.repository = meta.repository || getRepoNameFromWorkspacePath(meta.workspacePath);
		details.workspacePath = meta.workspacePath;
	}
	return { details, cacheUpdate: { tokenResult, modelUsage } };
}

function processUserMessageEvent(event: any, details: SessionFileDetails, timestamps: number[]): string | undefined {
	details.interactions++;
	if (event.timestamp || event.ts || event.data?.timestamp) {
		timestamps.push(new Date(event.timestamp || event.ts || event.data.timestamp).getTime());
	}
	if (event.data?.content) {
		analyzeContextReferences(event.data.content, details.contextReferences);
		return event.data.content;
	}
	return undefined;
}

function processToolExecutionEvent(event: any, details: SessionFileDetails, allContentReferences: any[]): void {
	if (event.data?.toolName === 'rename_session' && event.data?.arguments?.title) {
		details.title = event.data.arguments.title;
	}
	if (event.data?.arguments) {
		const args = event.data.arguments as Record<string, unknown>;
		for (const val of Object.values(args)) {
			if (typeof val === 'string' && val.length > 3 && (val.includes('/') || val.includes('\\'))) {
				allContentReferences.push({ kind: 'reference', reference: { fsPath: val } });
			}
		}
	}
}

function processCliJsonlEvent(event: any, details: SessionFileDetails, timestamps: number[], allContentReferences: any[]): string | undefined {
	if (event.type === 'user.message') { return processUserMessageEvent(event, details, timestamps); }
	if (event.type === 'tool.execution_start') { processToolExecutionEvent(event, details, allContentReferences); }
	return undefined;
}

async function resolveRepository(allContentReferences: any[]): Promise<string> {
	// '' is a "checked but not found" sentinel so warm-cache runs don't re-parse the file.
	return allContentReferences.length > 0 ? (await extractRepositoryFromContentReferences(allContentReferences) ?? '') : '';
}

async function processDeltaJsonlDetails(lines: string[], stat: SessionStatLike, details: SessionFileDetails, modelUsage: ModelUsage): Promise<SessionDetailsResult> {
	const timestamps: number[] = [];
	const allContentReferences: any[] = [];
	const { sessionState } = await reconstructJsonlStateAsync(lines);
	if (sessionState.creationDate) { timestamps.push(sessionState.creationDate); }
	if (sessionState.customTitle) { details.title = sessionState.customTitle; }

	const requests = sessionState.requests || [];
	details.interactions = requests.length;
	for (const request of requests) {
		if (!request) { continue; }
		if (request.timestamp) { timestamps.push(request.timestamp); }
		analyzeRequestContext(request, details.contextReferences);
		if (request.contentReferences && Array.isArray(request.contentReferences)) {
			allContentReferences.push(...request.contentReferences);
		}
	}

	setDetailsTimestamps(details, timestamps, stat);
	details.repository = await resolveRepository(allContentReferences);
	return { details, cacheUpdate: { modelUsage } };
}

async function processCliJsonlDetails(lines: string[], stat: SessionStatLike, details: SessionFileDetails, modelUsage: ModelUsage): Promise<SessionDetailsResult> {
	const timestamps: number[] = [];
	const allContentReferences: any[] = [];
	let firstUserMessage: string | undefined;
	for (const line of lines) {
		if (!line.trim()) { continue; }
		try {
			const event = JSON.parse(line);
			const userMsg = processCliJsonlEvent(event, details, timestamps, allContentReferences);
			if (userMsg && !firstUserMessage) { firstUserMessage = userMsg; }
		} catch { /* skip malformed */ }
	}

	if (!details.title && firstUserMessage) {
		const trimmed = firstUserMessage.trim();
		details.title = trimmed.length > 60 ? trimmed.slice(0, 60) + '…' : trimmed;
	}
	setDetailsTimestamps(details, timestamps, stat);
	details.repository = await resolveRepository(allContentReferences);
	return { details, cacheUpdate: { modelUsage } };
}

async function processJsonlSessionDetails(deps: SessionAnalyzerDeps, sessionFile: string, stat: SessionStatLike, details: SessionFileDetails, fileContent: string): Promise<SessionDetailsResult> {
	const lines = fileContent.trim().split('\n').filter(l => l.trim());

	let isDeltaBased = false;
	if (lines.length > 0) {
		try { const firstLine = JSON.parse(lines[0]); if (firstLine && typeof firstLine.kind === 'number') { isDeltaBased = true; } } catch { /* not delta */ }
	}

	// Compute model usage via the shared function (reusing already-read fileContent to
	// avoid a second file read) so the Diagnostics detail cache gets real per-model
	// attribution instead of only ever carrying over whatever a separate, unrelated
	// Usage/Charts analysis pass happened to have cached already.
	const modelUsage = await getModelUsageFromSession(toUsageAnalysisDeps(deps), sessionFile, fileContent);

	return isDeltaBased
		? processDeltaJsonlDetails(lines, stat, details, modelUsage)
		: processCliJsonlDetails(lines, stat, details, modelUsage);
}

function analyzeRequestMessage(message: any, contextReferences: SessionFileDetails['contextReferences']): void {
	if (!message) { return; }
	if (message.text) { analyzeContextReferences(message.text, contextReferences); }
	if (message.parts) {
		for (const part of message.parts) { if (part.text) { analyzeContextReferences(part.text, contextReferences); } }
	}
}

function processRequestVariableData(variableData: any, contextReferences: SessionFileDetails['contextReferences']): void {
	const varDataStr = JSON.stringify(variableData).toLowerCase();
	if (varDataStr.includes('workspace')) { contextReferences.workspace++; }
	if (varDataStr.includes('terminal')) { contextReferences.terminal++; }
	if (varDataStr.includes('vscode')) { contextReferences.vscode++; }
}

function processJsonRequest(request: any, details: SessionFileDetails, timestamps: number[], allContentReferences: any[]): void {
	const ts = request.timestamp || request.ts || request.result?.timestamp;
	if (ts) { timestamps.push(new Date(ts).getTime()); }
	analyzeRequestContext(request, details.contextReferences);
	analyzeRequestMessage(request.message, details.contextReferences);
	if (request.contentReferences && Array.isArray(request.contentReferences)) { allContentReferences.push(...request.contentReferences); }
	if (request.variableData) { processRequestVariableData(request.variableData, details.contextReferences); }
}

async function processJsonRequestsDetails(requests: any[], stat: SessionStatLike, details: SessionFileDetails): Promise<void> {
	details.interactions = requests.length;
	const timestamps: number[] = [];
	const allContentReferences: any[] = [];

	for (const request of requests) {
		processJsonRequest(request, details, timestamps, allContentReferences);
	}

	setDetailsTimestamps(details, timestamps, stat);
	details.repository = await resolveRepository(allContentReferences);
}

/**
 * Fills `details` (a skeleton prepared by the host) from the session file. Failures while
 * reading or parsing a plain JSON/uuid-pointer file are logged through `deps.warn` and reported
 * as a null `cacheUpdate`, matching the host's historical behaviour of returning the partial
 * details without caching them. Ecosystem-adapter and JSONL failures still reject, exactly as
 * they did when this ran inline (those branches `return` their promise without awaiting it).
 *
 * Windsurf's virtual sessions are not handled here — they need the host-only gRPC client.
 */
export async function computeSessionFileDetails(
	deps: SessionAnalyzerDeps,
	sessionFile: string,
	stat: SessionStatLike,
	details: SessionFileDetails,
): Promise<SessionDetailsResult> {
	try {
		const eco = findEcosystem(deps, sessionFile);
		if (eco) { return processEcosystemSessionDetails(eco, sessionFile, details); }

		const fileContent = await fs.promises.readFile(sessionFile, 'utf8');
		if (isUuidPointerFile(fileContent)) { return { details, cacheUpdate: {} }; }

		if (sessionFile.endsWith('.jsonl') || isJsonlContent(fileContent)) {
			return processJsonlSessionDetails(deps, sessionFile, stat, details, fileContent);
		}

		const sessionContent = JSON.parse(fileContent);
		if (sessionContent.customTitle) { details.title = sessionContent.customTitle; }
		if (Array.isArray(sessionContent.requests)) {
			await processJsonRequestsDetails(sessionContent.requests, stat, details);
		}
		const modelUsage = await getModelUsageFromSession(toUsageAnalysisDeps(deps), sessionFile, fileContent, sessionContent);
		return { details, cacheUpdate: { modelUsage } };
	} catch (error) {
		deps.warn(`Error analyzing session file details for ${sessionFile}: ${error}`);
		return { details, cacheUpdate: null };
	}
}
