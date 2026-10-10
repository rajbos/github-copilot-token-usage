/**
 * Session-file analysis pipeline, free of any `vscode` dependency.
 *
 * Turning one session file into a `SessionFileCache` entry is the CPU-heavy part of every
 * refresh: it reads the file, `JSON.parse`s it (often tens of MB), estimates tokens, walks
 * every request for usage analysis and rolls the result up per day. Run on the extension
 * host that work starves the event loop, and a webview click is only delivered between
 * ticks — which is the "navigation is blocked for tens of seconds" symptom.
 *
 * Everything here is a plain function over an explicit `SessionAnalyzerDeps`, so the exact
 * same code runs either inside the worker thread (`analysisWorker.ts` in this folder, the normal
 * path) or in-process (fallback when the worker is unavailable, and for the host-only
 * Windsurf virtual sessions). Cache reads/writes deliberately stay out of this module: it
 * receives the previous entry as data and returns the new one.
 */
import * as fs from 'fs';

import type { IEcosystemAdapter } from '../../../src/ecosystemAdapter';
import type {
	DailyRollupEntry,
	ModelPricing,
	ModelUsage,
	SessionFileCache,
	SessionUsageAnalysis,
	TokenEstimator,
} from '../../../src/types';
import type { WindsurfDataAccess } from '../../../src/windsurf';
import type { TaskCategory, TaskCategoryBreakdown } from '../../../src/taskClassification';
import { classifySessionTask, buildClassificationInputFromUsageAnalysis, countDelegationToolCalls } from '../../../src/taskClassification';
import {
	reconcileModelUsageToActualTokens,
	distributeModelUsageToDays,
	distributeExactCostToDays,
	scaleModelUsage,
	reconcileDebugLogModelUsage,
} from '../../../src/statsHelpers';
import {
	estimateTokensFromText,
	estimateTokensFromJsonlSession,
	getModelFromRequest,
	isJsonlContent,
	isUuidPointerFile,
	extractSubAgentData,
	extractResponseItemText,
	extractAllTokensFromDebugLog,
	NANO_AIU_TO_DOLLARS,
} from '../../../src/tokenEstimation';
import {
	analyzeSessionUsage,
	getModelUsageFromSession,
	type UsageAnalysisDeps,
} from '../../../src/usageAnalysis';
import { extractCopilotCliSessionId, getCopilotCliExactUsage } from '../../../src/copilotCliOtel';
import { resolveDebugLogCandidatePaths } from '../../../src/workspaceHelpers';
import { toLocalDayKey } from '../../../src/utils/dayKeys';

/** The slice of Windsurf the pipeline needs; Windsurf itself imports `vscode`, so it is host-only. */
export type WindsurfSessionSource = Pick<WindsurfDataAccess, 'isWindsurfSessionFile' | 'resolveSession'>;

export interface SessionAnalyzerDeps {
	warn: (message: string) => void;
	ecosystems: IEcosystemAdapter[];
	tokenEstimators: Record<string, TokenEstimator>;
	modelPricing: { [key: string]: ModelPricing };
	toolNameMap: { [key: string]: string };
	/** Present only in-process on the host; the worker never sees Windsurf's virtual sessions. */
	windsurf?: WindsurfSessionSource;
}

type DebugLogTokens = NonNullable<ReturnType<typeof extractAllTokensFromDebugLog>>;
type DailyRollups = { [dayKey: string]: DailyRollupEntry };
type SessionMeta = {
	title: string | undefined;
	firstInteraction: string | null;
	lastInteraction: string | null;
	dailyInteractions: { [localDayKey: string]: number };
	dailyFractions?: Record<string, number>;
	workspacePath?: string;
};
type TokenResult = {
	tokens: number; thinkingTokens?: number; actualTokens?: number; cacheReadTokens?: number; copilotNanoAiu?: number;
	truncationCount?: number; messagesRemovedByTruncation?: number; maxRequestInputTokens?: number; contextTier?: string;
};

export function toUsageAnalysisDeps(deps: SessionAnalyzerDeps): UsageAnalysisDeps {
	return { warn: deps.warn, tokenEstimators: deps.tokenEstimators, modelPricing: deps.modelPricing, toolNameMap: deps.toolNameMap, ecosystems: deps.ecosystems };
}

export function findEcosystem(deps: SessionAnalyzerDeps, sessionFile: string): IEcosystemAdapter | null {
	for (const eco of deps.ecosystems) {
		if (eco.handles(sessionFile)) { return eco; }
	}
	return null;
}

function estimateText(deps: SessionAnalyzerDeps, text: string, model: string = 'gpt-4'): number {
	return estimateTokensFromText(text, model, deps.tokenEstimators);
}

// ── Reading ─────────────────────────────────────────────────────────────────

export async function preloadSessionFileContent(deps: SessionAnalyzerDeps, sessionFilePath: string): Promise<{ preloadedContent: string | undefined; preloadedParsedJson: any | undefined }> {
	if (findEcosystem(deps, sessionFilePath) !== null) { return { preloadedContent: undefined, preloadedParsedJson: undefined }; }
	// Windsurf sessions use virtual paths (windsurf://trajectory/...) — no file to read
	if (deps.windsurf?.isWindsurfSessionFile(sessionFilePath)) { return { preloadedContent: undefined, preloadedParsedJson: undefined }; }
	const preloadedContent = await fs.promises.readFile(sessionFilePath, 'utf8');
	let preloadedParsedJson: any | undefined;
	const isPlainJson = !sessionFilePath.endsWith('.jsonl') && !isJsonlContent(preloadedContent) && !isUuidPointerFile(preloadedContent);
	if (isPlainJson) {
		try { preloadedParsedJson = JSON.parse(preloadedContent); } catch { /* handled individually */ }
	}
	return { preloadedContent, preloadedParsedJson };
}

// ── Interactions ────────────────────────────────────────────────────────────

function countInteractionsInJsonlEvent(event: any): number {
	let count = 0;
	if (event.type === 'user.message') { count++; }
	if (event.kind === 2 && event.k?.[0] === 'requests' && Array.isArray(event.v)) {
		for (const request of event.v) {
			if (request.requestId) { count++; }
		}
	}
	return count;
}

function countInteractionsFromJsonlLines(lines: string[]): number {
	let interactions = 0;
	for (const line of lines) {
		if (!line.trim()) { continue; }
		try { interactions += countInteractionsInJsonlEvent(JSON.parse(line)); } catch { /* skip malformed */ }
	}
	return interactions;
}

export async function countInteractionsInSession(deps: SessionAnalyzerDeps, sessionFile: string, preloadedContent?: string, preloadedParsedJson?: any): Promise<number> {
	try {
		const eco = findEcosystem(deps, sessionFile);
		if (eco) { return eco.countInteractions(sessionFile); }

		// Windsurf sessions - API-based with interaction count, file-based fallback
		if (deps.windsurf?.isWindsurfSessionFile(sessionFile)) {
			const session = await deps.windsurf.resolveSession(sessionFile);
			return session?.interactions ?? 0;
		}

		const fileContent = preloadedContent ?? await fs.promises.readFile(sessionFile, 'utf8');
		if (isUuidPointerFile(fileContent)) { return 0; }

		if (sessionFile.endsWith('.jsonl') || isJsonlContent(fileContent)) {
			return countInteractionsFromJsonlLines(fileContent.trim().split('\n'));
		}

		const sessionContent = preloadedParsedJson !== undefined ? preloadedParsedJson : JSON.parse(fileContent);
		if (sessionContent.requests && Array.isArray(sessionContent.requests)) {
			return sessionContent.requests.length;
		}
		return 0;
	} catch (error) {
		deps.warn(`Error counting interactions in ${sessionFile}: ${error}`);
		return 0;
	}
}

// ── Metadata ────────────────────────────────────────────────────────────────

type MetadataScan = { title: string | undefined; timestamps: number[]; requestTimestamps: number[] };

async function extractWindsurfSessionMetadata(windsurf: WindsurfSessionSource, sessionFile: string): Promise<SessionMeta> {
	const session = await windsurf.resolveSession(sessionFile);
	const lastInteraction = session?.lastInteraction ?? null;
	const dailyInteractions: { [utcDayKey: string]: number } = {};
	if (lastInteraction) {
		const d = new Date(lastInteraction);
		if (!isNaN(d.getTime())) {
			dailyInteractions[d.toISOString().slice(0, 10)] = Math.max(1, session?.interactions ?? 1);
		}
	}
	return {
		title: session?.title,
		firstInteraction: session?.firstInteraction ?? null,
		lastInteraction,
		dailyInteractions,
	};
}

/**
 * Ask any discoverable ecosystem adapter that does *not* handle this file whether
 * it can still supply a workspace directory path for it. Used for files like
 * Copilot CLI events.jsonl that are discovered by an adapter but parsed generically.
 */
export async function findWorkspacePathForDiscoveredPath(deps: SessionAnalyzerDeps, sessionFile: string): Promise<string | undefined> {
	for (const eco of deps.ecosystems) {
		if (eco.handles(sessionFile)) { continue; }
		if (typeof eco.getWorkspacePathForDiscoveredPath !== 'function') { continue; }
		try {
			const cwd = await eco.getWorkspacePathForDiscoveredPath(sessionFile);
			if (cwd) { return cwd; }
		} catch { /* adapter failed; try next */ }
	}
	return undefined;
}

function metadataFromUserMessage(event: any, timestamps: number[], requestTimestamps: number[]): string | undefined {
	if (event.type !== 'user.message') { return undefined; }
	const ts = event.timestamp || event.ts || event.data?.timestamp;
	if (ts) { const ms = new Date(ts).getTime(); timestamps.push(ms); requestTimestamps.push(ms); }
	return event.data?.content as string | undefined;
}

function metadataFromRenameSession(event: any): string | undefined {
	if (event.type === 'tool.execution_start' && event.data?.toolName === 'rename_session' && event.data?.arguments?.title) {
		return event.data.arguments.title as string;
	}
	return undefined;
}

function metadataFromKind0(event: any, timestamps: number[]): string | undefined {
	if (event.kind !== 0 || !event.v) { return undefined; }
	if (event.v.creationDate) { timestamps.push(event.v.creationDate); }
	return event.v.customTitle as string | undefined;
}

function metadataFromKind2Requests(event: any, timestamps: number[], requestTimestamps: number[]): void {
	if (event.kind !== 2 || event.k?.[0] !== 'requests' || !Array.isArray(event.v)) { return; }
	for (const request of event.v) {
		if (request.timestamp) { timestamps.push(request.timestamp); requestTimestamps.push(request.timestamp); }
	}
}

function metadataFromKind1Title(event: any): string | undefined {
	if (event.kind === 1 && event.k?.includes('customTitle') && event.v) { return event.v as string; }
	return undefined;
}

function scanJsonlMetadataLines(lines: string[], timestamps: number[], requestTimestamps: number[]): { loopTitle: string | undefined; firstUserMessage: string | undefined } {
	let loopTitle: string | undefined;
	let firstUserMessage: string | undefined;
	for (const line of lines) {
		if (!line.trim()) { continue; }
		try {
			const event = JSON.parse(line);
			const userMsg = metadataFromUserMessage(event, timestamps, requestTimestamps);
			if (userMsg && !firstUserMessage) { firstUserMessage = userMsg; }
			const renameTitle = metadataFromRenameSession(event);
			if (renameTitle) { loopTitle = renameTitle; }
			const kind0Title = metadataFromKind0(event, timestamps);
			if (kind0Title) { loopTitle = kind0Title; }
			metadataFromKind2Requests(event, timestamps, requestTimestamps);
			const kind1Title = metadataFromKind1Title(event);
			if (kind1Title) { loopTitle = kind1Title; }
		} catch { /* skip malformed */ }
	}
	return { loopTitle, firstUserMessage };
}

function extractMetadataFromJsonl(lines: string[]): MetadataScan {
	const timestamps: number[] = [];
	const requestTimestamps: number[] = [];
	const { loopTitle, firstUserMessage } = scanJsonlMetadataLines(lines, timestamps, requestTimestamps);
	let title = loopTitle;
	if (!title && firstUserMessage) {
		const trimmed = firstUserMessage.trim();
		title = trimmed.length > 60 ? trimmed.slice(0, 60) + '…' : trimmed;
	}
	return { title, timestamps, requestTimestamps };
}

function extractMetadataFromJson(fileContent: string, preloadedParsedJson?: any): MetadataScan {
	let title: string | undefined;
	const timestamps: number[] = [];
	const requestTimestamps: number[] = [];
	try {
		const parsed = preloadedParsedJson !== undefined ? preloadedParsedJson : JSON.parse(fileContent);
		if (parsed.customTitle) { title = parsed.customTitle; }
		if (parsed.creationDate) { timestamps.push(parsed.creationDate); }
		if (parsed.requests && Array.isArray(parsed.requests)) {
			for (const request of parsed.requests) {
				if (request.timestamp || request.ts || request.result?.timestamp) {
					const ts = request.timestamp || request.ts || request.result?.timestamp;
					const ms = new Date(ts).getTime();
					timestamps.push(ms); requestTimestamps.push(ms);
				}
			}
		}
	} catch { /* unable to parse */ }
	return { title, timestamps, requestTimestamps };
}

export async function extractSessionMetadata(deps: SessionAnalyzerDeps, sessionFile: string, preloadedContent?: string, preloadedParsedJson?: any): Promise<SessionMeta> {
	let title: string | undefined;
	let workspacePath: string | undefined;
	const timestamps: number[] = [];
	const requestTimestamps: number[] = [];

	try {
		const eco = findEcosystem(deps, sessionFile);
		if (eco) {
			const meta = await eco.getMeta(sessionFile);
			const dailyFractions = eco.getDailyFractions ? await eco.getDailyFractions(sessionFile) : undefined;
			return { ...meta, dailyInteractions: {}, ...(dailyFractions ? { dailyFractions } : {}) };
		}

		// Some adapters discover files they do not handle (e.g. Copilot CLI events.jsonl).
		// Ask them for workspace attribution before falling back to generic parsing.
		workspacePath = await findWorkspacePathForDiscoveredPath(deps, sessionFile);

		if (deps.windsurf?.isWindsurfSessionFile(sessionFile)) {
			return extractWindsurfSessionMetadata(deps.windsurf, sessionFile);
		}

		const fileContent = preloadedContent ?? await fs.promises.readFile(sessionFile, 'utf8');
		if (isUuidPointerFile(fileContent)) {
			return { title, firstInteraction: null, lastInteraction: null, dailyInteractions: {}, workspacePath };
		}

		const scan = (sessionFile.endsWith('.jsonl') || isJsonlContent(fileContent))
			? extractMetadataFromJsonl(fileContent.trim().split('\n'))
			: extractMetadataFromJson(fileContent, preloadedParsedJson);
		title = scan.title; timestamps.push(...scan.timestamps); requestTimestamps.push(...scan.requestTimestamps);
	} catch { /* file read error */ }

	// Session logs are external input: one malformed timestamp used to make toISOString() throw and reject the
	// whole session. Keep only timestamps that denote a real instant.
	const isRealInstant = (ms: number): boolean => !Number.isNaN(new Date(ms).getTime());
	const validTimestamps = timestamps.filter(isRealInstant);
	let firstInteraction: string | null = null;
	let lastInteraction: string | null = null;
	if (validTimestamps.length > 0) {
		validTimestamps.sort((a, b) => a - b);
		firstInteraction = new Date(validTimestamps[0]).toISOString();
		lastInteraction = new Date(validTimestamps[validTimestamps.length - 1]).toISOString();
	}

	const dailyInteractions: { [localDayKey: string]: number } = {};
	for (const ts of requestTimestamps.filter(isRealInstant)) {
		const dayKey = toLocalDayKey(new Date(ts));
		dailyInteractions[dayKey] = (dailyInteractions[dayKey] || 0) + 1;
	}

	return { title, firstInteraction, lastInteraction, dailyInteractions, workspacePath };
}

// ── Token estimation ────────────────────────────────────────────────────────

function estimateRequestInputTokens(deps: SessionAnalyzerDeps, request: any): number {
	let tokens = 0;
	if (request.message?.parts) {
		for (const part of request.message.parts) {
			if (part.text) { tokens += estimateText(deps, part.text); }
		}
	}
	return tokens;
}

function estimateSubAgentTokens(deps: SessionAnalyzerDeps, subAgent: { prompt?: string; result?: string }, model: string): number {
	let tokens = 0;
	if (subAgent.prompt) { tokens += estimateText(deps, subAgent.prompt, model); }
	if (subAgent.result) { tokens += estimateText(deps, subAgent.result, model); }
	return tokens;
}

function estimateRequestOutputTokens(deps: SessionAnalyzerDeps, request: any): { output: number; thinking: number } {
	let output = 0; let thinking = 0;
	if (!request.response || !Array.isArray(request.response)) { return { output, thinking }; }
	const model = getModelFromRequest(request, deps.modelPricing);
	for (const responseItem of request.response) {
		const subAgent = extractSubAgentData(responseItem);
		if (subAgent) {
			const saModel = subAgent.modelName || model;
			output += estimateSubAgentTokens(deps, subAgent, saModel);
			continue;
		}
		const { text, isThinking } = extractResponseItemText(responseItem);
		if (!text) { continue; }
		if (isThinking) { thinking += estimateText(deps, text, model); }
		else { output += estimateText(deps, text, model); }
	}
	return { output, thinking };
}

function extractActualTokensFromRequest(request: any): number {
	if (request.result?.usage) {
		const u = request.result.usage;
		return (typeof u.promptTokens === 'number' ? u.promptTokens : 0) + (typeof u.completionTokens === 'number' ? u.completionTokens : 0);
	}
	if (typeof request.result?.promptTokens === 'number' && typeof request.result?.outputTokens === 'number') {
		return request.result.promptTokens + request.result.outputTokens;
	}
	const meta = request.result?.metadata;
	if (meta && typeof meta.promptTokens === 'number' && typeof meta.outputTokens === 'number') {
		return meta.promptTokens + meta.outputTokens;
	}
	return 0;
}

export function estimateTokensFromJsonSession(deps: SessionAnalyzerDeps, sessionContent: any): { tokens: number; thinkingTokens: number; actualTokens: number } {
	let totalInputTokens = 0; let totalOutputTokens = 0; let totalThinkingTokens = 0; let totalActualTokens = 0;
	if (!sessionContent.requests || !Array.isArray(sessionContent.requests)) {
		return { tokens: 0, thinkingTokens: 0, actualTokens: 0 };
	}
	for (const request of sessionContent.requests) {
		totalInputTokens += estimateRequestInputTokens(deps, request);
		const { output, thinking } = estimateRequestOutputTokens(deps, request);
		totalOutputTokens += output; totalThinkingTokens += thinking;
		totalActualTokens += extractActualTokensFromRequest(request);
	}
	return { tokens: totalInputTokens + totalOutputTokens + totalThinkingTokens, thinkingTokens: totalThinkingTokens, actualTokens: totalActualTokens };
}

export async function estimateTokensFromSession(deps: SessionAnalyzerDeps, sessionFilePath: string, preloadedContent?: string, preloadedParsedJson?: any): Promise<{ tokens: number; thinkingTokens: number; actualTokens: number; cacheReadTokens?: number; copilotNanoAiu?: number; truncationCount?: number; messagesRemovedByTruncation?: number; maxRequestInputTokens?: number; contextTier?: string }> {
	try {
		const eco = findEcosystem(deps, sessionFilePath);
		if (eco) { return eco.getTokens(sessionFilePath); }
		if (deps.windsurf?.isWindsurfSessionFile(sessionFilePath)) {
			const session = await deps.windsurf.resolveSession(sessionFilePath);
			const tokens = session?.tokens ?? 0;
			return { tokens, thinkingTokens: 0, actualTokens: tokens, cacheReadTokens: session?.cachedTokens };
		}
		const fileContent = preloadedContent ?? await fs.promises.readFile(sessionFilePath, 'utf8');
		if (isUuidPointerFile(fileContent)) { return { tokens: 0, thinkingTokens: 0, actualTokens: 0 }; }
		if (sessionFilePath.endsWith('.jsonl') || isJsonlContent(fileContent)) {
			const exactUsage = extractCopilotCliSessionId(sessionFilePath) ? await getCopilotCliExactUsage(sessionFilePath) : null;
			return estimateTokensFromJsonlSession(fileContent, exactUsage);
		}
		const sessionContent = preloadedParsedJson !== undefined ? preloadedParsedJson : JSON.parse(fileContent);
		return estimateTokensFromJsonSession(deps, sessionContent);
	} catch (error) {
		deps.warn(`Error parsing session file ${sessionFilePath}: ${error}`);
		return { tokens: 0, thinkingTokens: 0, actualTokens: 0 };
	}
}

// ── Debug log ───────────────────────────────────────────────────────────────

/**
 * Read all token counts from the Copilot Chat debug log companion file for a session
 * (`{workspaceStorage}/{hash}/{extension}/debug-logs/{sessionId}/main.jsonl`).
 * Returns null when no debug log is found or it contains no `llm_request` events.
 */
export async function readTokensFromDebugLog(sessionFilePath: string): Promise<DebugLogTokens | null> {
	const candidatePaths = resolveDebugLogCandidatePaths(sessionFilePath);
	if (!candidatePaths) { return null; }
	for (const debugLogPath of candidatePaths) {
		try {
			const content = await fs.promises.readFile(debugLogPath, 'utf8');
			const result = extractAllTokensFromDebugLog(content);
			if (result) { return result; }
		} catch { /* file doesn't exist or can't be read — try next variant */ }
	}
	return null;
}

function buildModelUsageFromBreakdown(modelBreakdown: Record<string, { inputTokens: number; outputTokens: number; cachedTokens: number }>): ModelUsage {
	const modelUsage: ModelUsage = {};
	for (const [model, bd] of Object.entries(modelBreakdown)) {
		modelUsage[model] = { inputTokens: bd.inputTokens, outputTokens: bd.outputTokens, sessions: 0, ...(bd.cachedTokens > 0 ? { cachedReadTokens: bd.cachedTokens } : {}) };
	}
	return modelUsage;
}

/**
 * Folds a debug log into an already-cached entry. Returns `null` when the session has no
 * usable debug log (the caller should then persist the `debugLogChecked` marker so the
 * lookup is not repeated), otherwise the supplemented entry.
 */
export async function supplementCacheWithDebugLog(cached: SessionFileCache, sessionFilePath: string): Promise<SessionFileCache | null> {
	const debugLogTokens = await readTokensFromDebugLog(sessionFilePath);
	if (!debugLogTokens || (debugLogTokens.inputTokens + debugLogTokens.outputTokens) === 0) { return null; }
	const breakdownUsage = Object.keys(debugLogTokens.modelBreakdown).length > 0
		? buildModelUsageFromBreakdown(debugLogTokens.modelBreakdown)
		: cached.modelUsage;
	// Reconcile to the debug log's totals even when the breakdown is missing or
	// partial (e.g. some requests lack a `model` attribute), so Input+Output
	// never drifts from Total — see reconcileModelUsageToTotal for why.
	const supplementModelUsage = reconcileDebugLogModelUsage(cached.modelUsage, breakdownUsage, debugLogTokens.inputTokens, debugLogTokens.outputTokens);
	// Redistribute to days via the shared helper, which also re-syncs each day's
	// actualTokens to the debug-log-sized usage — see distributeModelUsageToDays.
	const supplementDailyRollups = cached.dailyRollups
		? (distributeModelUsageToDays(cached.dailyRollups, supplementModelUsage) ?? cached.dailyRollups)
		: cached.dailyRollups;
	const supplementExactCost = debugLogTokens.copilotNanoAiu * NANO_AIU_TO_DOLLARS;
	const supplementCostRollups = supplementDailyRollups
		? (distributeExactCostToDays(supplementDailyRollups, supplementExactCost) ?? supplementDailyRollups)
		: supplementDailyRollups;
	return {
		...cached, modelUsage: supplementModelUsage, dailyRollups: supplementCostRollups,
		actualTokens: debugLogTokens.inputTokens + debugLogTokens.outputTokens,
		...(debugLogTokens.modelTurns ? { modelTurns: debugLogTokens.modelTurns } : {}),
		debugLogInputTokens: debugLogTokens.inputTokens,
		debugLogOutputTokens: debugLogTokens.outputTokens,
		...(debugLogTokens.copilotNanoAiu > 0 ? { copilotExactCostDollars: supplementExactCost } : {}),
	};
}

// ── Daily rollups ───────────────────────────────────────────────────────────

function buildDailyRollupEntry(
	tokenResult: TokenResult,
	fraction: number,
	interactions: number,
	modelUsage: ModelUsage,
	totalNanoAiu: number,
	taskCategoryShares?: TaskCategoryBreakdown,
	primaryTaskCategory?: TaskCategory,
): DailyRollupEntry {
	const dayModelUsage = scaleModelUsage(modelUsage, fraction);
	const dayExactCost = totalNanoAiu > 0 ? totalNanoAiu * NANO_AIU_TO_DOLLARS * fraction : undefined;
	return {
		tokens: Math.round(tokenResult.tokens * fraction),
		actualTokens: Math.round((tokenResult.actualTokens || 0) * fraction),
		thinkingTokens: Math.round((tokenResult.thinkingTokens || 0) * fraction),
		cachedReadTokens: 0,
		interactions,
		modelUsage: dayModelUsage,
		...(taskCategoryShares ? { taskCategoryShares } : {}),
		...(primaryTaskCategory ? { primaryTaskCategory } : {}),
		...(dayExactCost !== undefined ? { copilotExactCostDollars: dayExactCost } : {}),
	};
}

function computeRollupsFromFractions(
	fractions: Record<string, number>,
	tokenResult: TokenResult,
	modelUsage: ModelUsage,
	interactions: number,
	totalNanoAiu: number,
	taskCategoryShares?: TaskCategoryBreakdown,
	primaryTaskCategory?: TaskCategory,
): { dailyRollups: DailyRollups; totalInteractions: number } {
	const dailyRollups: DailyRollups = {};
	const totalFracInteractions = Math.max(1, interactions);
	for (const [dayKey, fraction] of Object.entries(fractions)) {
		const dayInteractions = Math.max(1, Math.round(totalFracInteractions * fraction));
		dailyRollups[dayKey] = buildDailyRollupEntry(tokenResult, fraction, dayInteractions, modelUsage, totalNanoAiu, taskCategoryShares, primaryTaskCategory);
	}
	return { dailyRollups, totalInteractions: totalFracInteractions };
}

function computeRollupsFromInteractionCounts(
	interactionMap: { [localDayKey: string]: number },
	tokenResult: TokenResult,
	modelUsage: ModelUsage,
	totalNanoAiu: number,
	taskCategoryShares?: TaskCategoryBreakdown,
	primaryTaskCategory?: TaskCategory,
): { dailyRollups: DailyRollups; totalInteractions: number } {
	const dailyRollups: DailyRollups = {};
	const totalInteractions = Object.values(interactionMap).reduce((a, b) => a + b, 0);
	for (const [dayKey, dayInteractionCount] of Object.entries(interactionMap)) {
		const fraction = dayInteractionCount / totalInteractions;
		dailyRollups[dayKey] = buildDailyRollupEntry(tokenResult, fraction, dayInteractionCount, modelUsage, totalNanoAiu, taskCategoryShares, primaryTaskCategory);
	}
	return { dailyRollups, totalInteractions };
}

function computeFallbackDailyRollup(
	dailyRollups: DailyRollups,
	lastInteraction: string | null,
	tokenResult: TokenResult,
	modelUsage: ModelUsage,
	interactions: number,
	taskCategoryShares?: TaskCategoryBreakdown,
	primaryTaskCategory?: TaskCategory,
): void {
	if (!tokenResult.tokens || !lastInteraction) { return; }
	try {
		const interactionDate = new Date(lastInteraction);
		if (isNaN(interactionDate.getTime())) { return; }
		const dayKey = toLocalDayKey(interactionDate);
		dailyRollups[dayKey] = {
			tokens: tokenResult.tokens,
			actualTokens: tokenResult.actualTokens || 0,
			thinkingTokens: tokenResult.thinkingTokens || 0,
			cachedReadTokens: 0,
			interactions: Math.max(1, interactions),
			modelUsage: scaleModelUsage(modelUsage, 1),
			...(taskCategoryShares ? { taskCategoryShares } : {}),
			...(primaryTaskCategory ? { primaryTaskCategory } : {}),
		};
	} catch { /* ignore */ }
}

function computeDailyRollups(
	sessionMeta: SessionMeta,
	tokenResult: TokenResult,
	modelUsage: ModelUsage,
	interactions: number,
	usageAnalysis: SessionUsageAnalysis,
): { dailyRollups: DailyRollups; totalInteractions: number } {
	const totalNanoAiu = tokenResult.copilotNanoAiu ?? 0;
	const taskCategoryShares = usageAnalysis.taskClassification?.categoryShares as TaskCategoryBreakdown | undefined;
	const primaryTaskCategory = usageAnalysis.taskClassification?.primaryCategory as TaskCategory | undefined;

	// Prefer pre-computed fractions from ecosystem adapters (e.g. getDailyFractions()),
	// which have accurate per-request timestamps. Fall back to dailyInteractions counts.
	if (sessionMeta.dailyFractions && Object.keys(sessionMeta.dailyFractions).length > 0) {
		return computeRollupsFromFractions(sessionMeta.dailyFractions, tokenResult, modelUsage, interactions, totalNanoAiu, taskCategoryShares, primaryTaskCategory);
	}

	const dailyInteractionMap = sessionMeta.dailyInteractions;
	const totalInteractions = Object.values(dailyInteractionMap).reduce((a, b) => a + b, 0);
	if (totalInteractions > 0) {
		return computeRollupsFromInteractionCounts(dailyInteractionMap, tokenResult, modelUsage, totalNanoAiu, taskCategoryShares, primaryTaskCategory);
	}

	// Last-resort fallback for adapters/formats with no per-request timestamps at all
	// (e.g. Claude Desktop, which has no getDailyFractions()). Bucket the whole session
	// under its *last* activity day, not its first: a multi-day session (started days ago,
	// still active today) must show up as "today"'s activity, matching the mtime-based
	// fallback the CLI uses (see extractDailyFractions) and the lastInteraction-based
	// fallback aggregatePeriodStats itself uses when dailyRollups is absent. Using
	// firstInteraction here silently buried all subsequent days' activity — including
	// "today" — under the session's start date, making Today/Details show 0.
	const dailyRollups: DailyRollups = {};
	computeFallbackDailyRollup(
		dailyRollups,
		sessionMeta.lastInteraction ?? sessionMeta.firstInteraction,
		tokenResult,
		modelUsage,
		interactions,
		taskCategoryShares,
		primaryTaskCategory,
	);
	return { dailyRollups, totalInteractions };
}

// ── Debug-log reconciliation ────────────────────────────────────────────────

function backfillDailyRollupCacheTokens(dailyRollups: DailyRollups, finalCacheReadTokens: number | undefined): void {
	if (!finalCacheReadTokens || Object.keys(dailyRollups).length === 0) { return; }
	const dayKeys = Object.keys(dailyRollups);
	if (dayKeys.length === 1) {
		dailyRollups[dayKeys[0]].cachedReadTokens = finalCacheReadTokens;
		return;
	}
	const totalForCache = dayKeys.reduce((s, k) => s + dailyRollups[k].interactions, 0);
	let remaining = finalCacheReadTokens;
	dayKeys.slice(0, -1).forEach(k => {
		const allocated = totalForCache > 0 ? Math.round(finalCacheReadTokens * dailyRollups[k].interactions / totalForCache) : 0;
		dailyRollups[k].cachedReadTokens = allocated;
		remaining -= allocated;
	});
	dailyRollups[dayKeys[dayKeys.length - 1]].cachedReadTokens = Math.max(0, remaining);
}

function applyDebugLogModelBreakdown(modelUsage: ModelUsage, debugLogTokens: DebugLogTokens | null | undefined, dailyRollups: DailyRollups): ModelUsage {
	if (!debugLogTokens || debugLogTokens.inputTokens + debugLogTokens.outputTokens === 0) { return modelUsage; }
	const breakdownUsage = buildModelUsageFromBreakdown(debugLogTokens.modelBreakdown);
	// Reconcile against the debug log's own totals even when the breakdown is
	// missing or partial (e.g. some requests lack a `model` attribute), so
	// Input+Output never drifts from Total — see reconcileModelUsageToTotal.
	const resolvedModelUsage = reconcileDebugLogModelUsage(
		modelUsage, breakdownUsage,
		debugLogTokens.inputTokens,
		debugLogTokens.outputTokens,
	);
	// Redistribute to days AND re-sync each day's actualTokens — the rollups were
	// built from the (smaller) session-file estimate, and period stats derive
	// "Total tokens" from rollup actualTokens but "Input/Output" from rollup
	// modelUsage. Leaving the old day totals in place makes Input exceed Total.
	const redistributed = distributeModelUsageToDays(dailyRollups, resolvedModelUsage);
	if (redistributed) {
		for (const [dayKey, dayRollup] of Object.entries(redistributed)) {
			dailyRollups[dayKey] = dayRollup;
		}
	}
	return resolvedModelUsage;
}

function resolveAndApplyDebugLog(
	tokenResult: TokenResult,
	debugLogTokens: DebugLogTokens | null | undefined,
	modelUsage: ModelUsage,
	dailyRollups: DailyRollups,
): { resolvedActualTokens: number | undefined; finalCacheReadTokens: number | undefined; resolvedModelUsage: ModelUsage } {
	const resolvedActualTokens = (debugLogTokens && (debugLogTokens.inputTokens + debugLogTokens.outputTokens) > 0)
		? debugLogTokens.inputTokens + debugLogTokens.outputTokens
		: tokenResult.actualTokens;

	const debugLogCached = !tokenResult.cacheReadTokens ? (debugLogTokens?.cachedTokens ?? 0) : 0;
	const resolvedCacheReadTokens = tokenResult.cacheReadTokens || debugLogCached || undefined;
	const modelCachedTotal = !resolvedCacheReadTokens ? Object.values(modelUsage).reduce((sum, u) => sum + (u.cachedReadTokens ?? 0), 0) : 0;
	const finalCacheReadTokens = resolvedCacheReadTokens || (modelCachedTotal > 0 ? modelCachedTotal : undefined);

	backfillDailyRollupCacheTokens(dailyRollups, finalCacheReadTokens);

	const resolvedModelUsage = applyDebugLogModelBreakdown(modelUsage, debugLogTokens, dailyRollups);
	// Rollups were built from the session file's nano-AIU only; the debug log's exact cost
	// (which wins at session level) must reach them too or period totals stay estimated.
	const redistributedCost = distributeExactCostToDays(dailyRollups, (debugLogTokens?.copilotNanoAiu ?? 0) * NANO_AIU_TO_DOLLARS);
	if (redistributedCost) {
		for (const [dayKey, dayRollup] of Object.entries(redistributedCost)) { dailyRollups[dayKey] = dayRollup; }
	}
	return { resolvedActualTokens, finalCacheReadTokens, resolvedModelUsage };
}

/**
 * Windsurf sessions are discovered via the gRPC API (not a re-parseable file), so the
 * data layer pre-builds a ModelUsage map and tool-call breakdown. Fold those into the
 * resolved model usage / daily rollups / analysis so Today's Sessions shows real
 * input/output/cached tokens, models and cost instead of zeros.
 */
async function applyWindsurfBreakdown(
	windsurf: WindsurfSessionSource | undefined,
	sessionFilePath: string,
	resolvedModelUsage: ModelUsage,
	dailyRollups: DailyRollups,
	usageAnalysis: SessionUsageAnalysis,
): Promise<void> {
	if (!windsurf?.isWindsurfSessionFile(sessionFilePath)) { return; }
	const session = await windsurf.resolveSession(sessionFilePath);
	if (!session) { return; }
	if (session.modelUsage && Object.keys(session.modelUsage).length > 0) {
		for (const [model, usage] of Object.entries(session.modelUsage)) {
			resolvedModelUsage[model] = { ...usage };
		}
		// Windsurf has a single activity day; mirror the model usage onto its rollup
		// so per-day model/cost aggregation matches the session totals.
		for (const day of Object.keys(dailyRollups)) {
			dailyRollups[day].modelUsage = session.modelUsage;
			if (session.cachedTokens) { dailyRollups[day].cachedReadTokens = session.cachedTokens; }
		}
	}
	if (session.toolCalls) { usageAnalysis.toolCalls = session.toolCalls; }
}

// ── Cache-entry assembly ────────────────────────────────────────────────────

/** Long-context tier fields: largest per-request prompt size and CLI context tier. */
function buildContextTierFields(
	tokenResult: { maxRequestInputTokens?: number; contextTier?: string },
	debugLogTokens: { maxRequestInputTokens?: number } | null | undefined,
): Partial<SessionFileCache> {
	// Debug-log per-request sizes are exact; fall back to the session-file value.
	const maxRequestInputTokens = Math.max(debugLogTokens?.maxRequestInputTokens ?? 0, tokenResult.maxRequestInputTokens ?? 0);
	return {
		...(maxRequestInputTokens > 0 ? { maxRequestInputTokens } : {}),
		...(tokenResult.contextTier ? { contextTier: tokenResult.contextTier } : {}),
	};
}

function buildOptionalSessionFields(
	tokenResult: TokenResult,
	debugLogTokens: DebugLogTokens | null | undefined,
	finalCacheReadTokens: number | undefined,
	copilotExactCostDollars: number | undefined,
	dailyRollups: DailyRollups,
	usageAnalysis: SessionUsageAnalysis,
): Partial<SessionFileCache> {
	const hasDebugLog = !!debugLogTokens && (debugLogTokens.inputTokens + debugLogTokens.outputTokens) > 0;
	const hasEditScope = usageAnalysis?.editScope?.linesAdded !== undefined && usageAnalysis.editScope.linesAdded > 0;
	return {
		thinkingTokens: tokenResult.thinkingTokens,
		...(finalCacheReadTokens ? { cacheReadTokens: finalCacheReadTokens } : {}),
		...(debugLogTokens?.modelTurns ? { modelTurns: debugLogTokens.modelTurns } : {}),
		...(hasDebugLog ? { debugLogInputTokens: debugLogTokens!.inputTokens, debugLogOutputTokens: debugLogTokens!.outputTokens } : {}),
		dailyRollups: Object.keys(dailyRollups).length > 0 ? dailyRollups : undefined,
		...(copilotExactCostDollars !== undefined ? { copilotExactCostDollars } : {}),
		...(tokenResult.truncationCount ? { truncationCount: tokenResult.truncationCount, messagesRemovedByTruncation: tokenResult.messagesRemovedByTruncation } : {}),
		...buildContextTierFields(tokenResult, debugLogTokens),
		...(hasEditScope ? {
			linesAdded: usageAnalysis!.editScope!.linesAdded,
			linesRemoved: usageAnalysis!.editScope!.linesRemoved ?? 0,
			...(usageAnalysis!.editScope!.languageUsage ? { languageUsage: usageAnalysis!.editScope!.languageUsage } : {}),
		} : {}),
	};
}

function buildSessionDataObject(
	tokenResult: TokenResult,
	interactions: number,
	resolvedModelUsage: ModelUsage,
	mtime: number,
	fileSize: number,
	usageAnalysis: SessionUsageAnalysis,
	sessionMeta: SessionMeta,
	resolvedActualTokens: number | undefined,
	finalCacheReadTokens: number | undefined,
	debugLogTokens: DebugLogTokens | null | undefined,
	dailyRollups: DailyRollups,
	existingCache?: Pick<SessionFileCache, 'repository'>,
): SessionFileCache {
	const copilotNanoAiu = debugLogTokens?.copilotNanoAiu ?? tokenResult.copilotNanoAiu ?? 0;
	const copilotExactCostDollars = copilotNanoAiu > 0 ? copilotNanoAiu * NANO_AIU_TO_DOLLARS : undefined;
	const optionals = buildOptionalSessionFields(tokenResult, debugLogTokens, finalCacheReadTokens, copilotExactCostDollars, dailyRollups, usageAnalysis);
	// Classified once per session (not per-render) using tool names from usageAnalysis and the
	// already-extracted session title — see src/taskClassification.ts for the heuristic + rationale.
	const taskCategory = classifySessionTask(buildClassificationInputFromUsageAnalysis(usageAnalysis, sessionMeta.title));
	// Counted once per session from the same tool-name data as the task classification;
	// powers the sub-agent badge/counters in the sessions list, details and diagnostics views.
	// MCP tools are included because some ecosystems spawn sub-agents via MCP
	// (e.g. Claude Desktop's mcp__ccd_session__spawn_task).
	const subAgentCalls = countDelegationToolCalls(usageAnalysis?.toolCalls?.byTool ?? {})
		+ countDelegationToolCalls(usageAnalysis?.mcpTools?.byTool ?? {});
	return {
		tokens: tokenResult.tokens, interactions, modelUsage: resolvedModelUsage, mtime, size: fileSize,
		usageAnalysis, title: sessionMeta.title, firstInteraction: sessionMeta.firstInteraction,
		lastInteraction: sessionMeta.lastInteraction, actualTokens: resolvedActualTokens,
		taskCategory: usageAnalysis.taskClassification?.primaryCategory ?? taskCategory,
		taskCategoryShares: usageAnalysis.taskClassification?.categoryShares,
		...(subAgentCalls > 0 ? { subAgentCalls } : {}),
		// Persist workspace attribution from the adapter so the Recent Sessions list can
		// show it without requiring a separate getSessionFileDetails() parse pass.
		...(sessionMeta.workspacePath ? { workspaceFolderPath: sessionMeta.workspacePath } : {}),
		// Repository is discovered separately by getSessionFileDetails() (via content-reference
		// git-root lookup) and is not recomputed here. Without preserving it, every cache-miss
		// rebuild of this entry (e.g. an actively-edited session whose file keeps changing)
		// would silently wipe out a previously-known repository, making it fall back to
		// "Unknown" and disappear from all "By Repository" charts — most noticeably for the
		// "Output" (lines of code) chart, since LOC is attributed to the most recently active
		// day, which is exactly the day whose cache entry keeps getting rebuilt.
		...(existingCache?.repository !== undefined ? { repository: existingCache.repository } : {}),
		...optionals,
	};
}

// ── Quick analysis (folder scan) ────────────────────────────────────────────

export type QuickSessionAnalysis = {
	interactions: number;
	tokenResult: Awaited<ReturnType<typeof estimateTokensFromSession>>;
};

/**
 * Interaction count and token estimate for one file whose content the caller already has, without touching the
 * cache or running usage analysis. Used by the Diagnostics "analyze a folder" scan, which parses arbitrary
 * user-selected files — any one of which can be large.
 */
export async function quickAnalyzeSessionContent(deps: SessionAnalyzerDeps, sessionFilePath: string, content: string): Promise<QuickSessionAnalysis> {
	const interactions = await countInteractionsInSession(deps, sessionFilePath, content);
	const tokenResult = await estimateTokensFromSession(deps, sessionFilePath, content);
	return { interactions, tokenResult };
}

// ── Entry point ─────────────────────────────────────────────────────────────

/**
 * Parses one session file into a fresh cache entry. `existing` is only consulted to carry
 * forward fields this pass cannot recompute (the discovered repository).
 */
export async function analyzeSessionFile(
	deps: SessionAnalyzerDeps,
	sessionFilePath: string,
	mtime: number,
	fileSize: number,
	existing?: Pick<SessionFileCache, 'repository'>,
): Promise<SessionFileCache> {
	const { preloadedContent, preloadedParsedJson } = await preloadSessionFileContent(deps, sessionFilePath);
	const usageDeps = toUsageAnalysisDeps(deps);

	const [tokenResult, interactions, modelUsage, usageAnalysis, sessionMeta] = await Promise.all([
		estimateTokensFromSession(deps, sessionFilePath, preloadedContent, preloadedParsedJson),
		countInteractionsInSession(deps, sessionFilePath, preloadedContent, preloadedParsedJson),
		getModelUsageFromSession(usageDeps, sessionFilePath, preloadedContent, preloadedParsedJson),
		analyzeSessionUsage(usageDeps, sessionFilePath, preloadedContent, preloadedParsedJson),
		extractSessionMetadata(deps, sessionFilePath, preloadedContent, preloadedParsedJson),
	]);

	// Reconcile the per-model breakdown to the session total. Different sources estimate
	// these independently (e.g. event-based CLI sessions derive actualTokens from real
	// output via a ratio, while modelUsage derives input from accumulated message content),
	// which can make Input+Output exceed Total in the details view.
	// `||` (not `??`): actualTokens is 0 — never undefined — when no exact usage exists,
	// so `??` would target 0 and silently skip reconciliation for estimated sessions.
	const reconciledModelUsage = reconcileModelUsageToActualTokens(modelUsage, tokenResult.actualTokens || tokenResult.tokens);
	const { dailyRollups } = computeDailyRollups(sessionMeta, tokenResult, reconciledModelUsage, interactions, usageAnalysis);
	const debugLogTokens = await readTokensFromDebugLog(sessionFilePath);
	const { resolvedActualTokens, finalCacheReadTokens, resolvedModelUsage } = resolveAndApplyDebugLog(tokenResult, debugLogTokens, reconciledModelUsage, dailyRollups);

	await applyWindsurfBreakdown(deps.windsurf, sessionFilePath, resolvedModelUsage, dailyRollups, usageAnalysis);

	return buildSessionDataObject(tokenResult, interactions, resolvedModelUsage, mtime, fileSize, usageAnalysis, sessionMeta, resolvedActualTokens, finalCacheReadTokens, debugLogTokens, dailyRollups, existing);
}
