/**
 * Usage analysis functions for session data processing.
 * Analysis and aggregation functions extracted from CopilotTokenTracker.
 */
import * as fs from 'fs';
import * as path from 'path';
import type {
	SessionUsageAnalysis,
	ToolCallUsage,
	ModeUsage,
	ContextReferenceUsage,
	McpToolUsage,
	EditScopeUsage,
	ApplyButtonUsage,
	SessionDurationData,
	ConversationPatterns,
	AgentTypeUsage,
	ModelSwitchingAnalysis,
	ModelUsage,
	UsageAnalysisPeriod,
	ModelPricing,
	TokenEstimator,
	LanguageUsage,
	LatencyHistogram,
} from './types';
import { mergeAutonomyUsage, recordAutonomy } from './autonomy';
import {
	classifySessionTurns,
	createEmptyTaskClassificationResult,
	type TaskTurnSignal,
	TASK_CATEGORIES,
} from './taskClassification';
import {
	computeEfficiencyFromTurns,
	jsonRequestToToolCalls,
	mergeModelEfficiency,
	applyModelUsageToEfficiency,
	type EfficiencyTurn,
} from './modelEfficiency';
import { detectCorrectionAnalysis, mergeCorrectionCounts, summarizeCorrectionMoments } from './correctionDetection';
import { createEmptyCacheBreakagePeriodStats, mergeCacheBreakageIntoPeriod } from './cacheBreakage';
import { MAX_PROMPT_LENGTH } from './repeatedTasks';
import {
	applyDelta,
	isJsonlContent,
	isUuidPointerFile,
	getModelFromRequest,
	isCopilotAutoRequest,
	getModelTier,
	getModelCostBucket,
	estimateTokensFromText,
	extractPerRequestUsageFromRawLines,
	createEmptyContextRefs,
	extractSubAgentData,
	buildReasoningEffortTimeline,
	extractResponseItemText,
} from './tokenEstimation';

/** Store the session's first user prompt (truncated) for repeated-task detection. */
function _setFirstUserPrompt(analysis: SessionUsageAnalysis, prompt: string | undefined | null): void {
	if (analysis.firstUserPrompt || !prompt || !prompt.trim()) { return; }
	analysis.firstUserPrompt = prompt.trim().slice(0, MAX_PROMPT_LENGTH);
}
import { extractCopilotCliSessionId, getCopilotCliExactUsage } from './copilotCliOtel';
import { isCopilotAppClientName } from './copilotCliStore';
import { readTextFileWithSizeGuard } from './utils/safeFileRead';
import { pathExists } from './utils/fsAsync';
import { getModelBillingProvider } from './chartDataBuilder';
import {
	getModeType,
	isMcpTool,
	normalizeMcpToolName,
	extractMcpServerName,
	normalizePathForComparison,
} from './workspaceHelpers';
import { isCopilotCliSessionPath, isJetBrainsSessionPath } from './adapters/adapterPredicates';
import { detectJetBrainsModeFromContent, type JetBrainsMode } from './jetbrains';
import type { IEcosystemAdapter } from './ecosystemAdapter';
import { isAnalyzable } from './ecosystemAdapter';
import { isUnsafeObjectKey } from './utils/protoGuard';
import { createLatencyHistogram, mergeLatencyHistogram, recordLatencyMs } from './latencyHistogram';


// ---------------------------------------------------------------------------
// Internal types for parsed session log JSON structures
// ---------------------------------------------------------------------------

/** Reference object inside a contentReferences item */
interface ContentRefObject {
fsPath?: string;
path?: string;
name?: string;
}

/** A single item from a session contentReferences array */
interface ContentRefItemRaw {
kind?: string;
reference?: ContentRefObject;
inlineReference?: ContentRefObject;
}

/** Variable container from a session request variableData field */
interface VariableDataRaw {
variables?: Array<{
kind?: string;
name?: string;
value?: { fsPath?: string; path?: string; external?: string };
}>;
}

/** A request entry in a session file */
interface SessionRequestRaw {
requestId?: string;
timestamp?: number;
timeSpentWaiting?: number;
agent?: { id?: string };
message?: {
text?: string;
parts?: Array<{ text?: string }>;
};
contentReferences?: unknown[];
variableData?: unknown;
response?: unknown[];
result?: {
timings?: { firstProgress?: number; totalElapsed?: number };
usage?: { promptTokens?: number; completionTokens?: number };
promptTokens?: number;
outputTokens?: number;
details?: string;
metadata?: {
promptTokens?: number;
outputTokens?: number;
modelId?: string;
};
};
modelId?: string;
}

/** A parsed regular JSON session content */
export interface ParsedSessionJson {
requests?: unknown[];
mode?: { id?: string };
creationDate?: number;
lastMessageDate?: number;
inputState?: {
mode?: string;
selectedModel?: { metadata?: { id?: string }; identifier?: string };
selections?: Array<{
startLineNumber?: number;
endLineNumber?: number;
startColumn?: number;
endColumn?: number;
}>;
};
selectedModel?: { metadata?: { id?: string }; identifier?: string };
}

/** Returns true if value is null or undefined. */
function _isNullish(v: unknown): v is null | undefined { return v === null || v === undefined; }

function _ipsjCheckMode(mode: unknown): boolean {
	if (typeof mode !== 'object' || mode === null || Array.isArray(mode)) { return false; }
	const m = mode as Record<string, unknown>;
	return _isNullish(m.id) || typeof m.id === 'string';
}

/**
 * Runtime type guard that validates the shape of an unknown value against ParsedSessionJson.
 * Checks structural invariants for fields that could cause runtime errors if mistyped.
 */
export function isParsedSessionJson(obj: unknown): obj is ParsedSessionJson {
	if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) { return false; }
	const o = obj as Record<string, unknown>;
	if (!_isNullish(o.requests) && !Array.isArray(o.requests)) { return false; }
	if (!_isNullish(o.mode) && !_ipsjCheckMode(o.mode)) { return false; }
	if (!_isNullish(o.creationDate) && typeof o.creationDate !== 'number') { return false; }
	if (!_isNullish(o.lastMessageDate) && typeof o.lastMessageDate !== 'number') { return false; }
	return true;
}

/** A JSONL event (delta-based or CLI format) */
interface JsonlEventRaw {
kind?: number;
k?: string[];
v?: unknown;
type?: string;
data?: {
selectedModel?: string;
newModel?: string;
reasoningEffort?: string;
content?: string;
outputTokens?: number;
result?: {
content?: unknown;
detailedContent?: unknown;
};
modelMetrics?: Record<string, {
usage?: {
inputTokens?: number;
outputTokens?: number;
cacheReadTokens?: number;
cacheWriteTokens?: number;
};
}>;
mcpServer?: string;
toolName?: string;
};
model?: string;
toolName?: string;
}

function _asuExtractMessageTextFromRequest(request: SessionRequestRaw): string {
	if (typeof request.message?.text === 'string' && request.message.text.trim()) { return request.message.text; }
	if (Array.isArray(request.message?.parts)) {
		return request.message.parts
			.map(p => typeof p?.text === 'string' ? p.text : '')
			.filter(Boolean)
			.join('\n')
			.trim();
	}
	return '';
}

function _asuExtractToolNamesFromRequest(request: SessionRequestRaw): string[] {
	if (!Array.isArray(request.response)) { return []; }
	const tools: string[] = [];
	for (const responseItemRaw of request.response as ResponseItemRaw[]) {
		if (!responseItemRaw) { continue; }
		if (responseItemRaw.kind !== 'toolInvocationSerialized' && responseItemRaw.kind !== 'prepareToolInvocation') { continue; }
		const toolName = responseItemRaw.toolId || responseItemRaw.toolName || responseItemRaw.invocationMessage?.toolName || responseItemRaw.toolSpecificData?.kind || 'unknown';
		tools.push(toolName);
	}
	return tools;
}

interface TaskClassificationBias {
	planMin: number;
	delegationMin: number;
}

function _asuGetTaskClassificationBias(analysis: SessionUsageAnalysis): TaskClassificationBias {
	const planMin = (analysis.modeUsage.plan > 0 && analysis.modeUsage.plan >= analysis.modeUsage.agent && analysis.modeUsage.plan >= analysis.modeUsage.edit) ? 0.6 : 0;
	const delegationMin = analysis.modeUsage.customAgent > 0
		? Math.min(1, analysis.modeUsage.customAgent / Math.max(1, analysis.taskClassification.turnCount))
		: 0;
	return { planMin, delegationMin };
}

function _asuGetBaseTaskClassificationShare(category: string, bias: TaskClassificationBias): number {
	if (category === 'Planning') { return bias.planMin; }
	if (category === 'Delegation') { return bias.delegationMin; }
	return 0;
}

function _asuApplyTaskClassificationBias(analysis: SessionUsageAnalysis, shares: Record<string, number>, bias: TaskClassificationBias): void {
	if (bias.planMin > 0) {
		analysis.taskClassification.primaryCategory = 'Planning';
		shares['Planning'] = Math.max(shares['Planning'], bias.planMin);
	}
	if (bias.delegationMin > 0) {
		shares['Delegation'] = Math.max(shares['Delegation'], bias.delegationMin);
	}
}

function _asuNormalizeTaskClassificationShares(analysis: SessionUsageAnalysis, shares: Record<string, number>, bias: TaskClassificationBias): void {
	const minSum = bias.planMin + bias.delegationMin;
	if (minSum >= 1) {
		for (const category of TASK_CATEGORIES) {
			shares[category] = category === 'Planning' ? bias.planMin / minSum : category === 'Delegation' ? bias.delegationMin / minSum : 0;
		}
		return;
	}

	let freeSum = 0;
	for (const category of TASK_CATEGORIES) {
		const base = _asuGetBaseTaskClassificationShare(category, bias);
		freeSum += Math.max(0, shares[category] - base);
	}
	const remaining = 1 - minSum;
	if (freeSum > 0) {
		for (const category of TASK_CATEGORIES) {
			const base = _asuGetBaseTaskClassificationShare(category, bias);
			const extra = Math.max(0, shares[category] - base);
			shares[category] = base + extra * (remaining / freeSum);
		}
		return;
	}

	shares[analysis.taskClassification.primaryCategory] = (shares[analysis.taskClassification.primaryCategory] || 0) + remaining;
}

function _asuFinalizeTaskClassificationPrimaryCategory(analysis: SessionUsageAnalysis, shares: Record<string, number>, delegationMin: number): void {
	if (delegationMin > 0 && shares['Delegation'] >= shares[analysis.taskClassification.primaryCategory]) {
		analysis.taskClassification.primaryCategory = 'Delegation';
	}
}

function _asuFinalizeTaskClassification(analysis: SessionUsageAnalysis, turns: TaskTurnSignal[]): void {
	analysis.taskClassification = turns.length > 0 ? classifySessionTurns(turns) : createEmptyTaskClassificationResult();

	const shares = analysis.taskClassification.categoryShares;
	const bias = _asuGetTaskClassificationBias(analysis);
	_asuApplyTaskClassificationBias(analysis, shares, bias);
	_asuNormalizeTaskClassificationShares(analysis, shares, bias);
	_asuFinalizeTaskClassificationPrimaryCategory(analysis, shares, bias.delegationMin);
}

function _asuEnsureTaskCategoryMaps(period: UsageAnalysisPeriod): void {
	if (!period.taskCategoryPrimarySessions) {
		period.taskCategoryPrimarySessions = {};
	}
	if (!period.taskCategoryWeightedSessions) {
		period.taskCategoryWeightedSessions = {};
	}
}

function _muaMergeTaskCategories(period: UsageAnalysisPeriod, analysis: SessionUsageAnalysis): void {
	_asuEnsureTaskCategoryMaps(period);
	const primary = analysis.taskClassification?.primaryCategory ?? 'Conversation';
	period.taskCategoryPrimarySessions![primary] = (period.taskCategoryPrimarySessions![primary] || 0) + 1;
	const shares = analysis.taskClassification?.categoryShares;
	for (const category of TASK_CATEGORIES) {
		const share = shares?.[category] ?? 0;
		if (share <= 0) { continue; }
		period.taskCategoryWeightedSessions![category] = (period.taskCategoryWeightedSessions![category] || 0) + share;
	}
}

type SelectedModelMetadataRaw = {
	identifier?: string;
	metadata?: {
		id?: string;
		family?: string;
		vendor?: string;
		extension?: { value?: string };
		modelPickerCategory?: { label?: string };
	};
};

function _cmsNormalizeText(value: unknown): string {
	return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function _cmsGetSelectedModelCandidate(event: CmsEvent): SelectedModelMetadataRaw | undefined {
	const v = event.v as { selectedModel?: SelectedModelMetadataRaw; inputState?: { selectedModel?: SelectedModelMetadataRaw } } | undefined;
	return v?.selectedModel ?? v?.inputState?.selectedModel;
}

function _cmsIsAutoModel(normalizedId: string, family: string): boolean {
	return normalizedId === 'auto' || family === 'auto' || family.includes('auto') || normalizedId.includes('/auto');
}

function _cmsIsFoundryModel(normalizedId: string, vendor: string, family: string, extension: string, category: string): boolean {
	const looksFoundry = family.includes('foundry') || family.includes('local') || extension.includes('foundry') || extension.includes('windows') || category.includes('foundry') || category.includes('windows') || normalizedId.includes('foundry');
	const looksFoundryById = normalizedId.includes('foundry') && (normalizedId.includes('microsoft') || normalizedId.includes('aitk'));
	return looksFoundryById || (vendor.includes('microsoft') && looksFoundry);
}

interface CmsModelMetaFields { family: string; vendor: string; extension: string; category: string; rawExtension: string | undefined }

function _cmsExtractModelMetaFields(modelInfo: SelectedModelMetadataRaw | undefined): CmsModelMetaFields {
	const meta = modelInfo?.metadata;
	const ext = meta?.extension;
	return {
		family: _cmsNormalizeText(meta?.family),
		vendor: _cmsNormalizeText(meta?.vendor),
		extension: _cmsNormalizeText(ext?.value),
		category: _cmsNormalizeText(meta?.modelPickerCategory?.label),
		rawExtension: ext?.value,
	};
}

function _cmsTrackModelSelectionSignals(modelId: string | undefined, modelInfo: SelectedModelMetadataRaw | undefined, analysis: SessionUsageAnalysis): void {
	const normalizedId = (modelId ?? '').replace(/^copilot\//, '');
	if (!normalizedId) { return; }
	const { family, vendor, extension, category, rawExtension } = _cmsExtractModelMetaFields(modelInfo);
	if (_cmsIsAutoModel(normalizedId, family)) { analysis.modelSwitching.autoSessions = 1; }
	if (_cmsIsFoundryModel(normalizedId, vendor, family, extension, category)) { analysis.modelSwitching.foundryWindowsSessions = 1; }
	const provider = getModelBillingProvider(normalizedId);
	if (provider === 'Other') {
		analysis.modelSwitching.unknownProviderSessions = 1;
		if (!analysis.modelSwitching.unknownProviderModels.includes(normalizedId)) { analysis.modelSwitching.unknownProviderModels.push(normalizedId); }
	}
	if (rawExtension && !analysis.modelSwitching.selectedModelExtensions.includes(rawExtension)) {
		analysis.modelSwitching.selectedModelExtensions.push(rawExtension);
	}
}

function _cmsTrackSelectionSignalsFromEvent(event: CmsEvent, analysis: SessionUsageAnalysis): void {
	if (event.type === 'session.start' && typeof event.data?.selectedModel === 'string') {
		_cmsTrackModelSelectionSignals(event.data.selectedModel, _cmsGetSelectedModelCandidate(event), analysis);
		return;
	}
	if (event.type === 'session.model_change' && typeof event.data?.newModel === 'string') {
		_cmsTrackModelSelectionSignals(event.data.newModel, _cmsGetSelectedModelCandidate(event), analysis);
		return;
	}
	const id0 = _cmsGetKind0ModelId(event);
	if (id0) {
		_cmsTrackModelSelectionSignals(id0, _cmsGetSelectedModelCandidate(event), analysis);
		return;
	}
	const id2 = _cmsGetKind2ModelId(event);
	if (id2) {
		_cmsTrackModelSelectionSignals(id2, _cmsGetSelectedModelCandidate(event), analysis);
		return;
	}
	// Also check for model field in event (for events that might have model/resolvedModel pattern)
	if (typeof event.model === 'string') {
		_cmsTrackModelSelectionSignals(event.model, _cmsGetSelectedModelCandidate(event), analysis);
		// Also detect Foundry from event model field
		_cmsDetectFoundryFromRequest(event as any, analysis);
	}
}

/** Reconstructed delta session state (from applyDelta over JSONL lines) */
interface DeltaSessionState {
	requests?: unknown[];
	creationDate?: number;
	lastMessageDate?: number;
	inputState?: {
		mode?: string;
		selectedModel?: { identifier?: string; metadata?: { id?: string } };
		selections?: Array<{
			startLineNumber?: number;
			endLineNumber?: number;
			startColumn?: number;
			endColumn?: number;
		}>;
	};
	selectedModel?: { identifier?: string; metadata?: { id?: string } };
	[key: string]: unknown;
}

/** A response item in a session request */
interface ResponseItemRaw {
	kind?: string;
	uri?: { path?: string };
	isEdit?: boolean;
	toolId?: string;
	toolName?: string;
	invocationMessage?: { toolName?: string };
	toolSpecificData?: { kind?: string };
	value?: string;
	didStartServerIds?: string[];
	inlineReference?: ContentRefObject;
}

export interface UsageAnalysisDeps {
	warn: (msg: string) => void;
	ecosystems: IEcosystemAdapter[];
	tokenEstimators: Record<string, TokenEstimator>;
	modelPricing: { [key: string]: ModelPricing };
	toolNameMap: { [key: string]: string };
}


/**
 * Increment the appropriate mode counter based on modeType string.
 */
function incrementModeUsage(modeType: string, modeUsage: ModeUsage): void {
	if (modeType === 'agent') {
		modeUsage.agent++;
	} else if (modeType === 'edit') {
		modeUsage.edit++;
	} else if (modeType === 'plan') {
		modeUsage.plan++;
	} else if (modeType === 'customAgent') {
		modeUsage.customAgent++;
	} else {
		modeUsage.ask++;
	}
}

/**
 * Record a tool invocation, routing to MCP counters or regular tool-call counters.
 */
function recordToolOrMcpInvocation(
	toolName: string,
	analysis: SessionUsageAnalysis,
	toolNameMap: { [key: string]: string }
): void {
	if (isMcpTool(toolName)) {
		// Count as MCP tool
		analysis.mcpTools.total++;
		const serverName = extractMcpServerName(toolName, toolNameMap);
		analysis.mcpTools.byServer[serverName] = (analysis.mcpTools.byServer[serverName] || 0) + 1;
		const normalizedTool = normalizeMcpToolName(toolName);
		analysis.mcpTools.byTool[normalizedTool] = (analysis.mcpTools.byTool[normalizedTool] || 0) + 1;
	} else {
		// Count as regular tool call
		analysis.toolCalls.total++;
		analysis.toolCalls.byTool[toolName] = (analysis.toolCalls.byTool[toolName] || 0) + 1;
	}
}

/**
 * Record the outcome of one completed tool call: it is counted as completed, an
 * explicit failure flag increments the failure count, and an observed
 * start→complete duration feeds the latency histogram. The only writer of the
 * `completedBy*`, `failuresBy*` and `latencyBy*` maps, so every session format
 * that gains a success flag or timestamps funnels through the same bookkeeping.
 *
 * `mcpServer` is the server name when the call is known to be an MCP call
 * (Copilot CLI tags the start event; other formats derive it from the tool-name
 * prefix). MCP calls are recorded per server under `mcpTools` only, mirroring how
 * `recordToolOrMcpInvocation` keeps MCP calls out of `toolCalls`; everything else
 * is recorded per tool under `toolCalls`.
 *
 * `success` is tri-state: `true` / `false` are explicit outcomes and count toward
 * `completedBy*` (and `failuresBy*`); `undefined` means the log recorded a result
 * but no verdict (older Copilot CLI schemas omit `success`), so the call stays out
 * of the reliability denominator entirely and only its latency is kept.
 * Unpaired or timestamp-less calls pass `undefined` for `durationMs`.
 */
export function recordToolOutcome(
	analysis: SessionUsageAnalysis,
	toolName: string,
	mcpServer: string | undefined,
	success: boolean | undefined,
	durationMs: number | undefined,
): void {
	if (!toolName || isUnsafeObjectKey(toolName)) { return; }
	const server = mcpServer && !isUnsafeObjectKey(mcpServer) ? mcpServer : undefined;
	const maps = server ? _rtoMcpMaps(analysis.mcpTools) : _rtoToolMaps(analysis.toolCalls);
	const key = server ?? toolName;
	if (success !== undefined) {
		const completed = maps.completed();
		completed[key] = (completed[key] || 0) + 1;
	}
	if (success === false) {
		const failures = maps.failures();
		failures[key] = (failures[key] || 0) + 1;
	}
	if (durationMs !== undefined && Number.isFinite(durationMs) && durationMs >= 0) {
		const latency = maps.latency();
		recordLatencyMs(latency[key] ??= createLatencyHistogram(), durationMs);
	}
}

/** Lazy accessors for the three outcome maps, so an absent map stays absent until it has a value. */
type RtoOutcomeMaps = {
	completed: () => { [key: string]: number };
	failures: () => { [key: string]: number };
	latency: () => { [key: string]: LatencyHistogram };
};

function _rtoToolMaps(tools: ToolCallUsage): RtoOutcomeMaps {
	return {
		completed: () => tools.completedByTool ??= {},
		failures: () => tools.failuresByTool ??= {},
		latency: () => tools.latencyByTool ??= {},
	};
}

function _rtoMcpMaps(mcp: McpToolUsage): RtoOutcomeMaps {
	return {
		completed: () => mcp.completedByServer ??= {},
		failures: () => mcp.failuresByServer ??= {},
		latency: () => mcp.latencyByServer ??= {},
	};
}

/** Timing metrics extracted from a single request */
interface TimingMetrics {
	timestamp: number | undefined;
	timings: { firstProgress?: number; totalElapsed?: number } | undefined;
	waitTime: number | undefined;
}

/** Agent type classification extracted from a single request */
interface AgentMetrics {
	agentType: 'editsAgent' | 'defaultAgent' | 'workspaceAgent' | 'other' | null;
}

/** Edit and codeblock metrics extracted from a single request */
interface EditMetrics {
	editedFilePaths: string[];
	codeBlocks: number;
	applies: number;
	linesAdded: number;
	linesRemoved: number;
	languageUsage: LanguageUsage;
}

function normalizeExtension(filePath: string): string {
	const name = filePath.split('/').pop()?.split('\\').pop() ?? '';
	const dotIdx = name.lastIndexOf('.');
	if (dotIdx <= 0) {
		return name.toLowerCase() || 'unknown';
	}
	return name.slice(dotIdx + 1).toLowerCase();
}

/**
 * Extract timing-related metrics (timestamp, timings, wait time) from a request.
 */
function extractTimingMetrics(req: SessionRequestRaw): TimingMetrics {
	return {
		timestamp: req.timestamp,
		timings: req.result?.timings,
		waitTime: req.timeSpentWaiting,
	};
}

/**
 * Extract agent type classification from a request.
 * Returns null agentType when no agent id is present.
 */
function extractAgentMetrics(req: SessionRequestRaw): AgentMetrics {
	if (!req.agent?.id) {
		return { agentType: null };
	}
	const agentId = req.agent.id;
	if (agentId.includes('edit')) {
		return { agentType: 'editsAgent' };
	} else if (agentId.includes('default')) {
		return { agentType: 'defaultAgent' };
	} else if (agentId.includes('workspace')) {
		return { agentType: 'workspaceAgent' };
	}
	return { agentType: 'other' };
}

// --- extractEditMetrics helpers ---

/** Accumulator for edit metrics collection across response items. */
type EemAcc = EditMetrics;

/** Process one edit object: count line additions/removals and accumulate per-language stats. */
function _eemCountLineChanges(edit: unknown, ext: string, acc: EemAcc): void {
	if (!edit || typeof edit !== 'object') { return; }
	const editObj = edit as { text?: unknown; range?: { startLineNumber?: number; endLineNumber?: number } };
	if (typeof editObj.text === 'string' && editObj.text) {
		const added = (editObj.text.match(/\n/g) ?? []).length + (editObj.text.endsWith('\n') ? 0 : 1);
		acc.linesAdded += added;
		if (!acc.languageUsage[ext]) { acc.languageUsage[ext] = { linesAdded: 0, linesRemoved: 0 }; }
		acc.languageUsage[ext].linesAdded += added;
	}
	if (editObj.range && typeof editObj.range.startLineNumber === 'number' && typeof editObj.range.endLineNumber === 'number') {
		const removed = Math.max(0, editObj.range.endLineNumber - editObj.range.startLineNumber);
		acc.linesRemoved += removed;
		if (!acc.languageUsage[ext]) { acc.languageUsage[ext] = { linesAdded: 0, linesRemoved: 0 }; }
		acc.languageUsage[ext].linesRemoved += removed;
	}
}

/** Process all edit groups within a textEditGroup response item. */
function _eemProcessEditGroups(edits: unknown[], ext: string, acc: EemAcc): void {
	for (const editGroup of edits) {
		if (!Array.isArray(editGroup)) { continue; }
		for (const edit of editGroup as unknown[]) {
			_eemCountLineChanges(edit, ext, acc);
		}
	}
}

/** Process a textEditGroup response item, accumulating file paths and line change counts. */
function _eemProcessTextEditGroup(respRaw: ResponseItemRaw, acc: EemAcc): void {
	if (!respRaw.uri) { return; }
	const filePath = respRaw.uri.path || JSON.stringify(respRaw.uri);
	acc.editedFilePaths.push(filePath);
	const ext = normalizeExtension(filePath);
	const respRawAny = respRaw as unknown as { edits?: unknown };
	if (!Array.isArray(respRawAny.edits)) { return; }
	_eemProcessEditGroups(respRawAny.edits, ext, acc);
}

/**
 * Extract edited file paths and codeblock/apply counts from a request's response items.
 */
type SingleEditObj = { text?: unknown; range?: { startLineNumber?: number; endLineNumber?: number } };

/** Count lines added/removed from a single edit object, accumulating into languageUsage. */
function _eemCountSingleEdit(editObj: SingleEditObj, ext: string, languageUsage: LanguageUsage): { linesAdded: number; linesRemoved: number } {
	let linesAdded = 0;
	let linesRemoved = 0;
	if (typeof editObj.text === 'string' && editObj.text) {
		const added = (editObj.text.match(/\n/g) ?? []).length + (editObj.text.endsWith('\n') ? 0 : 1);
		linesAdded += added;
		if (!languageUsage[ext]) { languageUsage[ext] = { linesAdded: 0, linesRemoved: 0 }; }
		languageUsage[ext].linesAdded += added;
	}
	if (editObj.range && typeof editObj.range.startLineNumber === 'number' && typeof editObj.range.endLineNumber === 'number') {
		const removed = Math.max(0, editObj.range.endLineNumber - editObj.range.startLineNumber);
		linesRemoved += removed;
		if (!languageUsage[ext]) { languageUsage[ext] = { linesAdded: 0, linesRemoved: 0 }; }
		languageUsage[ext].linesRemoved += removed;
	}
	return { linesAdded, linesRemoved };
}

/** Process all edit groups for a textEditGroup response item, returning line delta totals. */
function _eemProcessEdits(respRaw: unknown, ext: string, languageUsage: LanguageUsage): { linesAdded: number; linesRemoved: number } {
	const respRawAny = respRaw as { edits?: unknown };
	let linesAdded = 0;
	let linesRemoved = 0;
	if (!Array.isArray(respRawAny.edits)) { return { linesAdded, linesRemoved }; }
	for (const editGroup of respRawAny.edits as unknown[]) {
		if (!Array.isArray(editGroup)) { continue; }
		for (const edit of editGroup as unknown[]) {
			if (!edit || typeof edit !== 'object') { continue; }
			const delta = _eemCountSingleEdit(edit as SingleEditObj, ext, languageUsage);
			linesAdded += delta.linesAdded;
			linesRemoved += delta.linesRemoved;
		}
	}
	return { linesAdded, linesRemoved };
}

function extractEditMetrics(req: SessionRequestRaw): EditMetrics {
	const acc: EemAcc = { editedFilePaths: [], codeBlocks: 0, applies: 0, linesAdded: 0, linesRemoved: 0, languageUsage: {} };
	if (!req.response || !Array.isArray(req.response)) { return acc; }
	for (const respRaw of req.response as ResponseItemRaw[]) {
		if (!respRaw) { continue; }
		if (respRaw.kind === 'textEditGroup') { _eemProcessTextEditGroup(respRaw, acc); }
		if (respRaw.kind === 'codeblockUri') {
			acc.codeBlocks++;
			if (respRaw.isEdit === true) { acc.applies++; }
		}
	}
	return acc;
}

/** Merge language usage stats from source into target, initialising missing entries. */
function _mergeLanguageUsage(target: LanguageUsage, source: LanguageUsage): void {
	for (const [ext, usage] of Object.entries(source)) {
		if (!target[ext]) { target[ext] = { linesAdded: 0, linesRemoved: 0 }; }
		target[ext].linesAdded += usage.linesAdded;
		target[ext].linesRemoved += usage.linesRemoved;
	}
}

/** Accumulate timing-related data (timestamps, timing details, wait times, active intervals) for one request. */
function _accumulateRequestTiming(
	timing: TimingMetrics,
	timestamps: number[],
	timingsData: { firstProgress?: number; totalElapsed?: number }[],
	waitTimes: number[],
	activeIntervals: { start: number; end: number }[]
): void {
	if (timing.timestamp !== undefined) { timestamps.push(timing.timestamp); }
	if (timing.timings) { timingsData.push(timing.timings); }
	if (timing.waitTime !== undefined) { waitTimes.push(timing.waitTime); }
	if (timing.timestamp !== undefined && timing.timings?.totalElapsed !== undefined) {
		activeIntervals.push({ start: timing.timestamp, end: timing.timestamp + timing.timings.totalElapsed });
	}
}

/**
 * Process a list of session requests, accumulating enhanced metrics in-place.
 * Mutates editedFiles, timestamps, timingsData, waitTimes, activeIntervals and agentCounts.
 * Returns the total applies and total code blocks counted.
 */
function processRequestsForEnhancedMetrics(
	requests: SessionRequestRaw[],
	agentCounts: AgentTypeUsage,
	editedFiles: Set<string>,
	timestamps: number[],
	timingsData: { firstProgress?: number; totalElapsed?: number }[],
	waitTimes: number[],
	activeIntervals: { start: number; end: number }[]
): { totalApplies: number; totalCodeBlocks: number; totalLinesAdded: number; totalLinesRemoved: number; languageUsage: LanguageUsage } {
	let totalApplies = 0;
	let totalCodeBlocks = 0;
	let totalLinesAdded = 0;
	let totalLinesRemoved = 0;
	const languageUsage: LanguageUsage = {};
	for (const requestRaw of requests) {
		if (!requestRaw) { continue; }

		_accumulateRequestTiming(extractTimingMetrics(requestRaw), timestamps, timingsData, waitTimes, activeIntervals);

		const agent = extractAgentMetrics(requestRaw);
		if (agent.agentType !== null) {
			agentCounts[agent.agentType]++;
		}

		const edits = extractEditMetrics(requestRaw);
		for (const filePath of edits.editedFilePaths) { editedFiles.add(filePath); }
		totalCodeBlocks += edits.codeBlocks;
		totalApplies += edits.applies;
		totalLinesAdded += edits.linesAdded;
		totalLinesRemoved += edits.linesRemoved;
		_mergeLanguageUsage(languageUsage, edits.languageUsage);
	}
	return { totalApplies, totalCodeBlocks, totalLinesAdded, totalLinesRemoved, languageUsage };
}

// --- processDeltaSessionAnalysis helpers ---

/** Process a single reconstructed request for mode/tool/context analysis. */
function _pdsaProcessResponses(request: SessionRequestRaw, analysis: SessionUsageAnalysis, toolNameMap: Record<string, string>): void {
	if (!request.response || !Array.isArray(request.response)) { return; }
	for (const responseItemRaw of request.response as ResponseItemRaw[]) {
		if (!responseItemRaw) { continue; }
		if (responseItemRaw.kind === 'toolInvocationSerialized' || responseItemRaw.kind === 'prepareToolInvocation') {
			const toolName = responseItemRaw.toolId || responseItemRaw.toolName || responseItemRaw.invocationMessage?.toolName || responseItemRaw.toolSpecificData?.kind || 'unknown';
			recordToolOrMcpInvocation(toolName, analysis, toolNameMap);
		}
	}
}

function _pdsaProcessRequest(
	deps: Pick<UsageAnalysisDeps, 'toolNameMap'>,
	request: SessionRequestRaw,
	sessionModeType: string,
	analysis: SessionUsageAnalysis,
	taskTurns: TaskTurnSignal[]
): void {
	if (!request.requestId) { return; }
	incrementModeUsage(sessionModeType, analysis.modeUsage);
	if (request.agent?.id) {
		analysis.toolCalls.total++;
		analysis.toolCalls.byTool[request.agent.id] = (analysis.toolCalls.byTool[request.agent.id] || 0) + 1;
	}
	analyzeRequestContext(request, analysis.contextReferences);
	_pdsaProcessResponses(request, analysis, deps.toolNameMap);
	const turn: TaskTurnSignal = {
		messageText: _asuExtractMessageTextFromRequest(request),
		toolNames: _asuExtractToolNamesFromRequest(request),
	};
	taskTurns.push(turn);
}

function _pdsaGetReqModel(req: SessionRequestRaw, defaultModel: string, modelPricing: { [key: string]: ModelPricing }): string {
	return getModelFromRequest(req, modelPricing, defaultModel);
}

function _pdsaCountModelSwitches(models: string[]): number {
	let count = 0;
	for (let i = 1; i < models.length; i++) { if (models[i] !== models[i - 1]) { count++; } }
	return count;
}

function _pdsaGetSessionDefaultModel(sessionState: DeltaSessionState): string {
	const sm = sessionState.selectedModel;
	const ism = sessionState.inputState?.selectedModel;
	return (sm?.identifier || sm?.metadata?.id || ism?.identifier || ism?.metadata?.id || 'gpt-4o').replace(/^copilot\//, '');
}

/** Extract model switching statistics from a reconstructed delta session state. */
function _pdsaExtractModelSwitching(
	deps: Pick<UsageAnalysisDeps, 'modelPricing'>,
	sessionState: DeltaSessionState,
	requests: SessionRequestRaw[],
	analysis: SessionUsageAnalysis
): void {
	const sessionDefaultModel = _pdsaGetSessionDefaultModel(sessionState);

	const sm = sessionState.selectedModel;
	const ism = sessionState.inputState?.selectedModel;
	const sessionSelectedId = (sm?.identifier || ism?.identifier || '').replace(/^copilot\//, '');
	if (sessionSelectedId === 'auto') { analysis.modelSwitching.autoSessions = 1; }

	const models: string[] = [];
	for (const req of requests) {
		if (!req || !req.requestId) { continue; }
		const reqModel = _pdsaGetReqModel(req, sessionDefaultModel, deps.modelPricing);
		models.push(reqModel);
		const reqModelLower = reqModel.toLowerCase();
		if (reqModelLower.includes('foundry') && (reqModelLower.includes('microsoft') || reqModelLower.includes('aitk'))) {
			analysis.modelSwitching.foundryWindowsSessions = 1;
		}
	}
	const uniqueModels = [...new Set(models)];
	analysis.modelSwitching.uniqueModels = uniqueModels;
	analysis.modelSwitching.modelCount = uniqueModels.length;
	analysis.modelSwitching.totalRequests = models.length;
	analysis.modelSwitching.switchCount = _pdsaCountModelSwitches(models);
	applyModelTierClassification(deps.modelPricing, uniqueModels, models, analysis);
}

/** Extract thinking effort data from delta JSONL lines and populate analysis. */
function _pdsaExtractThinkingEffort(lines: string[], requests: SessionRequestRaw[], analysis: SessionUsageAnalysis): void {
	const { effortByRequestId, defaultEffort, switchCount: effortSwitchCount } = buildReasoningEffortTimeline(lines);
	if (defaultEffort === null && effortByRequestId.size === 0) { return; }
	const byEffort: { [effort: string]: number } = {};
	for (const [, effort] of effortByRequestId) {
		byEffort[effort] = (byEffort[effort] || 0) + 1;
	}
	if (effortByRequestId.size === 0 && defaultEffort !== null) {
		byEffort[defaultEffort] = requests.length;
	}
	analysis.thinkingEffort = { byEffort, switchCount: effortSwitchCount, defaultEffort };
}

/**
 * Process a fully-reconstructed delta session state to populate usage analysis.
 * Handles mode detection, context references, tool invocations, model switching,
 * thinking effort extraction, and conversation pattern derivation.
 */
function processDeltaSessionAnalysis(
	deps: Pick<UsageAnalysisDeps, 'toolNameMap' | 'modelPricing'>,
	sessionState: DeltaSessionState,
	lines: string[],
	analysis: SessionUsageAnalysis
): void {
	const taskTurns: TaskTurnSignal[] = [];
	const sessionModeType = sessionState.inputState?.mode
		? getModeType(sessionState.inputState.mode)
		: 'ask';

	// Detect implicit selections
	if (sessionState.inputState?.selections && Array.isArray(sessionState.inputState.selections)) {
		for (const sel of sessionState.inputState.selections) {
			if (sel && (sel.startLineNumber !== sel.endLineNumber || sel.startColumn !== sel.endColumn)) {
				analysis.contextReferences.implicitSelection++;
				break;
			}
		}
	}

	const requests = (sessionState.requests ?? []) as SessionRequestRaw[];
	for (const request of requests) {
		_pdsaProcessRequest(deps, request, sessionModeType, analysis, taskTurns);
	}

	_pdsaExtractModelSwitching(deps, sessionState, requests, analysis);
	_pdsaExtractThinkingEffort(lines, requests, analysis);
	_asuFinalizeTaskClassification(analysis, taskTurns);
	_applyJsonRequestsEfficiency(requests, _pdsaGetSessionDefaultModel(sessionState), deps.modelPricing, analysis);
	deriveConversationPatterns(analysis);
}

/** Session-level default model of a plain JSON Copilot Chat session. */
function _jsonSessionDefaultModel(parsed: ParsedSessionJson): string {
	return (parsed.selectedModel?.identifier || parsed.selectedModel?.metadata?.id || 'unknown').replace(/^copilot\//, '');
}

/**
 * Compute per-model efficiency counters (issue #1649) from JSON/delta session
 * requests and attach them to the analysis when any request produced a turn.
 * Also runs correction-moment detection over the same turns — requests carry
 * the user message text and response items needed for it.
 */
function _applyJsonRequestsEfficiency(
	requests: SessionRequestRaw[],
	defaultModel: string,
	modelPricing: { [key: string]: ModelPricing },
	analysis: SessionUsageAnalysis
): void {
	const turns: EfficiencyTurn[] = [];
	for (const req of requests) {
		if (!req) { continue; }
		turns.push({
			model: _pdsaGetReqModel(req, defaultModel, modelPricing),
			toolCalls: jsonRequestToToolCalls(req),
			userMessage: typeof req.message?.text === 'string' ? req.message.text : undefined,
			assistantResponse: _jsonRequestAssistantText(req),
			timestamp: typeof req.timestamp === 'number' ? new Date(req.timestamp).toISOString() : null,
		});
	}
	if (turns.length === 0) { return; }
	analysis.modelEfficiency = computeEfficiencyFromTurns(turns);
	_setFirstUserPrompt(analysis, turns.find(t => t.userMessage)?.userMessage);
	_setCorrectionDetection(analysis, turns);
}

function _setCorrectionDetection(analysis: SessionUsageAnalysis, turns: EfficiencyTurn[]): void {
	const detection = detectCorrectionAnalysis(turns);
	if (detection.moments.length === 0) { return; }
	analysis.correctionMoments = detection.moments;
	analysis.correctionCounts = detection.counts;
}

/** Concatenate the non-thinking text of a JSON request's response items (correction detection only). */
function _jsonRequestAssistantText(req: SessionRequestRaw): string | undefined {
	if (!Array.isArray(req.response)) { return undefined; }
	let text = '';
	for (const item of req.response) {
		const { text: itemText, isThinking } = extractResponseItemText(item);
		if (itemText && !isThinking) { text += itemText; }
	}
	return text || undefined;
}

// --- processJsonSessionRequests helpers ---

/** Determine the mode string for a single request based on agent id or session mode. */
function _pjsrDetermineMode(request: SessionRequestRaw, sessionContent: ParsedSessionJson): string {
	if (request.agent?.id) {
		const agentId = request.agent.id.toLowerCase();
		if (agentId.includes('edit')) { return 'edit'; }
		if (agentId.includes('agent')) { return 'agent'; }
	}
	if (sessionContent.mode?.id) {
		const modeId = sessionContent.mode.id.toLowerCase();
		if (modeId.includes('agent')) { return 'agent'; }
		if (modeId.includes('edit')) { return 'edit'; }
	}
	return 'ask';
}

/** Process one response item: route tool/MCP invocations, handle MCP server starts and inline references. */
function _pjsrProcessResponseItem(
	responseItem: ResponseItemRaw,
	analysis: SessionUsageAnalysis,
	deps: Pick<UsageAnalysisDeps, 'toolNameMap'>
): void {
	if (responseItem.kind === 'toolInvocationSerialized' || responseItem.kind === 'prepareToolInvocation') {
		const toolName = responseItem.toolId || responseItem.toolName || responseItem.invocationMessage?.toolName || 'unknown';
		recordToolOrMcpInvocation(toolName, analysis, deps.toolNameMap);
	}
	if (responseItem.kind === 'mcpServersStarting' && responseItem.didStartServerIds) {
		for (const serverId of responseItem.didStartServerIds) {
			analysis.mcpTools.total++;
			analysis.mcpTools.byServer[serverId] = (analysis.mcpTools.byServer[serverId] || 0) + 1;
		}
	}
	if (responseItem.kind === 'inlineReference' && responseItem.inlineReference) {
		analyzeContentReferences([responseItem], analysis.contextReferences);
	}
}

/** Process a single JSON session request: update mode, context references, and response items. */
function _pjsrProcessRequest(
	deps: Pick<UsageAnalysisDeps, 'toolNameMap'>,
	request: SessionRequestRaw,
	sessionContent: ParsedSessionJson,
	analysis: SessionUsageAnalysis,
	taskTurns: TaskTurnSignal[]
): void {
	const requestMode = _pjsrDetermineMode(request, sessionContent);
	if (requestMode === 'agent') { analysis.modeUsage.agent++; }
	else if (requestMode === 'edit') { analysis.modeUsage.edit++; }
	else { analysis.modeUsage.ask++; }
	analyzeRequestContext(request, analysis.contextReferences);
	if (request.response && Array.isArray(request.response)) {
		for (const responseItemRaw of request.response as ResponseItemRaw[]) {
			if (!responseItemRaw) { continue; }
			_pjsrProcessResponseItem(responseItemRaw, analysis, deps);
		}
	}
	taskTurns.push({
		messageText: _asuExtractMessageTextFromRequest(request),
		toolNames: _asuExtractToolNamesFromRequest(request),
	});
}

/**
 * Process requests in a regular JSON session file.
 * Populates mode usage, context references, and tool/MCP invocations.
 */
function processJsonSessionRequests(
	deps: Pick<UsageAnalysisDeps, 'toolNameMap' | 'modelPricing'>,
	sessionContent: ParsedSessionJson,
	analysis: SessionUsageAnalysis
): void {
	if (!sessionContent.requests || !Array.isArray(sessionContent.requests)) { return; }
	const taskTurns: TaskTurnSignal[] = [];
	for (const requestRaw of sessionContent.requests) {
		_pjsrProcessRequest(deps, requestRaw as SessionRequestRaw, sessionContent, analysis, taskTurns);
	}
	_asuFinalizeTaskClassification(analysis, taskTurns);
	_applyJsonRequestsEfficiency(
		sessionContent.requests as SessionRequestRaw[],
		_jsonSessionDefaultModel(sessionContent),
		deps.modelPricing,
		analysis
	);
}

/**
 * Merge usage analysis data into period stats
 */
function _muaMergeContextRefFields(period: UsageAnalysisPeriod, analysis: SessionUsageAnalysis): void {
	const p = period.contextReferences;
	const a = analysis.contextReferences;
	p.file += a.file;
	p.selection += a.selection;
	p.implicitSelection += a.implicitSelection || 0;
	p.symbol += a.symbol;
	p.codebase += a.codebase;
	p.workspace += a.workspace;
	p.terminal += a.terminal;
	p.vscode += a.vscode;
	p.terminalLastCommand += a.terminalLastCommand || 0;
	p.terminalSelection += a.terminalSelection || 0;
	p.clipboard += a.clipboard || 0;
	p.changes += a.changes || 0;
	p.outputPanel += a.outputPanel || 0;
	p.problemsPanel += a.problemsPanel || 0;
	p.pullRequest += a.pullRequest || 0;
	p.copilotInstructions += a.copilotInstructions || 0;
	p.agentsMd += a.agentsMd || 0;
}

/** Merge byKind and byPath maps from analysis context references into period. */
function _muaMergeContextRefMaps(period: UsageAnalysisPeriod, analysis: SessionUsageAnalysis): void {
	for (const [kind, count] of Object.entries(analysis.contextReferences.byKind || {})) {
		period.contextReferences.byKind[kind] = (period.contextReferences.byKind[kind] || 0) + count;
	}
	for (const [path, count] of Object.entries(analysis.contextReferences.byPath || {})) {
		period.contextReferences.byPath[path] = (period.contextReferences.byPath[path] || 0) + count;
	}
}

type SessionModelSwitching = SessionUsageAnalysis['modelSwitching'];

/** Add unique model names from a tier list into the period's tracked list if not already present. */
function _muaMergeTierModels(period: UsageAnalysisPeriod, ms: SessionModelSwitching): void {
	for (const model of ms.tiers.standard) {
		if (!period.modelSwitching.standardModels.includes(model)) { period.modelSwitching.standardModels.push(model); }
	}
	for (const model of ms.tiers.premium) {
		if (!period.modelSwitching.premiumModels.includes(model)) { period.modelSwitching.premiumModels.push(model); }
	}
	for (const model of ms.tiers.unknown) {
		if (!period.modelSwitching.unknownModels.includes(model)) { period.modelSwitching.unknownModels.push(model); }
	}
}

function _muaMergeUniqueStrings(target: string[], values: string[] | undefined): void {
	for (const value of values ?? []) {
		if (!target.includes(value)) { target.push(value); }
	}
}

function _muaMergeCostModels(period: UsageAnalysisPeriod, ms: SessionModelSwitching): void {
	for (const model of (ms.costBuckets?.low ?? [])) {
		if (!period.modelSwitching.lowCostModels.includes(model)) { period.modelSwitching.lowCostModels.push(model); }
	}
	for (const model of (ms.costBuckets?.medium ?? [])) {
		if (!period.modelSwitching.mediumCostModels.includes(model)) { period.modelSwitching.mediumCostModels.push(model); }
	}
	for (const model of (ms.costBuckets?.high ?? [])) {
		if (!period.modelSwitching.highCostModels.includes(model)) { period.modelSwitching.highCostModels.push(model); }
	}
}

/** Recalculate aggregate model-switching statistics from the accumulated modelsPerSession array. */
function _muaUpdateModelSwitchingStats(period: UsageAnalysisPeriod): void {
	const counts = period.modelSwitching.modelsPerSession;
	if (counts.length === 0) { return; }
	period.modelSwitching.averageModelsPerSession = counts.reduce((a, b) => a + b, 0) / counts.length;
	period.modelSwitching.maxModelsPerSession = Math.max(...counts);
	period.modelSwitching.minModelsPerSession = Math.min(...counts);
	period.modelSwitching.switchingFrequency = (counts.filter(c => c > 1).length / counts.length) * 100;
}

/** Merge model switching statistics from analysis into period. */
function _muaMergeModelSwitching(period: UsageAnalysisPeriod, analysis: SessionUsageAnalysis): void {
	if (!analysis.modelSwitching) {
		(analysis as { modelSwitching?: SessionModelSwitching }).modelSwitching = {
			uniqueModels: [], modelCount: 0, switchCount: 0,
			autoSessions: 0, foundryWindowsSessions: 0, unknownProviderSessions: 0,
			selectedModelExtensions: [], unknownProviderModels: [],
			tiers: { standard: [], premium: [], unknown: [] },
			hasMixedTiers: false, standardRequests: 0, premiumRequests: 0,
			unknownRequests: 0, totalRequests: 0,
			costBuckets: { low: [], medium: [], high: [], unknown: [] },
			hasMixedCosts: false, lowCostRequests: 0, mediumCostRequests: 0, highCostRequests: 0,
		};
	}
	if (analysis.modelSwitching.modelCount <= 0) { return; }
	const ms: SessionModelSwitching = analysis.modelSwitching;
	period.modelSwitching.totalSessions++;
	period.modelSwitching.modelsPerSession.push(ms.modelCount);
	_muaMergeTierModels(period, ms);
	_muaMergeCostModels(period, ms);
	period.modelSwitching.autoSessions += ms.autoSessions || 0;
	period.modelSwitching.foundryWindowsSessions += ms.foundryWindowsSessions || 0;
	period.modelSwitching.unknownProviderSessions += ms.unknownProviderSessions || 0;
	_muaMergeUniqueStrings(period.modelSwitching.selectedModelExtensions, ms.selectedModelExtensions);
	_muaMergeUniqueStrings(period.modelSwitching.unknownProviderModels, ms.unknownProviderModels);
	if (ms.hasMixedTiers) { period.modelSwitching.mixedTierSessions++; }
	if (ms.hasMixedCosts) { period.modelSwitching.mixedCostSessions++; }
	period.modelSwitching.standardRequests += ms.standardRequests || 0;
	period.modelSwitching.premiumRequests += ms.premiumRequests || 0;
	period.modelSwitching.unknownRequests += ms.unknownRequests || 0;
	period.modelSwitching.lowCostRequests += ms.lowCostRequests || 0;
	period.modelSwitching.mediumCostRequests += ms.mediumCostRequests || 0;
	period.modelSwitching.highCostRequests += ms.highCostRequests || 0;
	period.modelSwitching.totalRequests += ms.totalRequests || 0;
	_muaUpdateModelSwitchingStats(period);
}

/** Merge edit scope metrics from analysis into period. */
function _muaMergeEditScope(period: UsageAnalysisPeriod, analysis: SessionUsageAnalysis): void {
	if (!analysis.editScope) { return; }
	period.editScope.singleFileEdits += analysis.editScope.singleFileEdits;
	period.editScope.multiFileEdits += analysis.editScope.multiFileEdits;
	period.editScope.totalEditedFiles += analysis.editScope.totalEditedFiles;
	const editSessions = period.editScope.singleFileEdits + period.editScope.multiFileEdits;
	period.editScope.avgFilesPerSession = editSessions > 0 ? period.editScope.totalEditedFiles / editSessions : 0;
}

/** Merge apply usage (code block application) metrics from analysis into period. */
function _muaMergeApplyUsage(period: UsageAnalysisPeriod, analysis: SessionUsageAnalysis): void {
	if (!analysis.applyUsage) { return; }
	period.applyUsage.totalApplies += analysis.applyUsage.totalApplies;
	period.applyUsage.totalCodeBlocks += analysis.applyUsage.totalCodeBlocks;
	period.applyUsage.applyRate = period.applyUsage.totalCodeBlocks > 0
		? (period.applyUsage.totalApplies / period.applyUsage.totalCodeBlocks) * 100
		: 0;
}

/** Merge session duration metrics from analysis into period using weighted averaging. */
function _muaMergeSessionDuration(period: UsageAnalysisPeriod, analysis: SessionUsageAnalysis): void {
	if (!analysis.sessionDuration) { return; }
	period.sessionDuration.totalDurationMs += analysis.sessionDuration.totalDurationMs;
	period.sessionDuration.activeDurationMs += analysis.sessionDuration.activeDurationMs;
	const sessionCount = period.sessions;
	if (sessionCount <= 0) { return; }
	period.sessionDuration.avgDurationMs = period.sessionDuration.totalDurationMs / sessionCount;
	const prevFirst = period.sessionDuration.avgFirstProgressMs * (sessionCount - 1);
	period.sessionDuration.avgFirstProgressMs = (prevFirst + analysis.sessionDuration.avgFirstProgressMs) / sessionCount;
	const prevElapsed = period.sessionDuration.avgTotalElapsedMs * (sessionCount - 1);
	period.sessionDuration.avgTotalElapsedMs = (prevElapsed + analysis.sessionDuration.avgTotalElapsedMs) / sessionCount;
	const prevWait = period.sessionDuration.avgWaitTimeMs * (sessionCount - 1);
	period.sessionDuration.avgWaitTimeMs = (prevWait + analysis.sessionDuration.avgWaitTimeMs) / sessionCount;
}

/** Merge conversation pattern metrics from analysis into period. */
function _muaMergeConversationPatterns(period: UsageAnalysisPeriod, analysis: SessionUsageAnalysis): void {
	if (!analysis.conversationPatterns) { return; }
	period.conversationPatterns.multiTurnSessions += analysis.conversationPatterns.multiTurnSessions;
	period.conversationPatterns.singleTurnSessions += analysis.conversationPatterns.singleTurnSessions;
	period.conversationPatterns.maxTurnsInSession = Math.max(
		period.conversationPatterns.maxTurnsInSession,
		analysis.conversationPatterns.maxTurnsInSession
	);
	const totalSessions = period.conversationPatterns.multiTurnSessions + period.conversationPatterns.singleTurnSessions;
	if (totalSessions <= 0) { return; }
	const prevTotalTurns = period.conversationPatterns.avgTurnsPerSession * (totalSessions - 1);
	period.conversationPatterns.avgTurnsPerSession = (prevTotalTurns + analysis.conversationPatterns.avgTurnsPerSession) / totalSessions;
}

/** Merge thinking effort data from analysis into period. */
function _muaMergeThinkingEffort(period: UsageAnalysisPeriod, analysis: SessionUsageAnalysis): void {
	if (!analysis.thinkingEffort) { return; }
	if (!period.thinkingEffortUsage) {
		period.thinkingEffortUsage = { byEffort: {}, sessionCount: 0, switchCount: 0 };
	}
	period.thinkingEffortUsage.sessionCount++;
	period.thinkingEffortUsage.switchCount += analysis.thinkingEffort.switchCount;
	for (const [effort, count] of Object.entries(analysis.thinkingEffort.byEffort)) {
		period.thinkingEffortUsage.byEffort[effort] = (period.thinkingEffortUsage.byEffort[effort] || 0) + count;
	}
}

const CONTEXT_REF_NUMERIC_KEYS = [
	'file', 'selection', 'implicitSelection', 'symbol', 'codebase', 'workspace',
	'terminal', 'vscode', 'terminalLastCommand', 'terminalSelection', 'clipboard',
	'changes', 'outputPanel', 'problemsPanel', 'pullRequest', 'copilotInstructions', 'agentsMd',
] as const;

function _muaMergeCountMap(target: Record<string, number>, source: Record<string, number>): void {
	for (const [key, count] of Object.entries(source)) {
		target[key] = (target[key] || 0) + count;
	}
}

function _muaMergeContextRefs(period: UsageAnalysisPeriod, analysis: SessionUsageAnalysis): void {
	const c = period.contextReferences;
	const a = analysis.contextReferences;
	for (const key of CONTEXT_REF_NUMERIC_KEYS) {
		c[key] += a[key] || 0;
	}
	c.codeContextLines = (c.codeContextLines || 0) + (a.codeContextLines || 0);
	_muaMergeCountMap(c.byKind, a.byKind);
	_muaMergeCountMap(c.byPath, a.byPath);
}

function _muaAccumulateTierModels(
	period: UsageAnalysisPeriod,
	tiers: { standard: string[]; premium: string[]; unknown: string[] }
): void {
	for (const model of tiers.standard) {
		if (!period.modelSwitching.standardModels.includes(model)) {
			period.modelSwitching.standardModels.push(model);
		}
	}
	for (const model of tiers.premium) {
		if (!period.modelSwitching.premiumModels.includes(model)) {
			period.modelSwitching.premiumModels.push(model);
		}
	}
	for (const model of tiers.unknown) {
		if (!period.modelSwitching.unknownModels.includes(model)) {
			period.modelSwitching.unknownModels.push(model);
		}
	}
}

function _muaAccumulateCostModels(
	period: UsageAnalysisPeriod,
	costBuckets: { low?: string[]; medium?: string[]; high?: string[] }
): void {
	for (const model of costBuckets.low ?? []) {
		if (!period.modelSwitching.lowCostModels.includes(model)) {
			period.modelSwitching.lowCostModels.push(model);
		}
	}
	for (const model of costBuckets.medium ?? []) {
		if (!period.modelSwitching.mediumCostModels.includes(model)) {
			period.modelSwitching.mediumCostModels.push(model);
		}
	}
	for (const model of costBuckets.high ?? []) {
		if (!period.modelSwitching.highCostModels.includes(model)) {
			period.modelSwitching.highCostModels.push(model);
		}
	}
}

function _muaMergeEnhancedMetrics(period: UsageAnalysisPeriod, analysis: SessionUsageAnalysis): void {
	if (analysis.editScope) {
		period.editScope.singleFileEdits += analysis.editScope.singleFileEdits;
		period.editScope.multiFileEdits += analysis.editScope.multiFileEdits;
		period.editScope.totalEditedFiles += analysis.editScope.totalEditedFiles;
		const editSessions = period.editScope.singleFileEdits + period.editScope.multiFileEdits;
		period.editScope.avgFilesPerSession = editSessions > 0 ? period.editScope.totalEditedFiles / editSessions : 0;
	}
	if (analysis.applyUsage) {
		period.applyUsage.totalApplies += analysis.applyUsage.totalApplies;
		period.applyUsage.totalCodeBlocks += analysis.applyUsage.totalCodeBlocks;
		period.applyUsage.applyRate = period.applyUsage.totalCodeBlocks > 0
			? (period.applyUsage.totalApplies / period.applyUsage.totalCodeBlocks) * 100 : 0;
	}
	if (analysis.sessionDuration) {
		period.sessionDuration.totalDurationMs += analysis.sessionDuration.totalDurationMs;
		period.sessionDuration.activeDurationMs += analysis.sessionDuration.activeDurationMs;
		const sessionCount = period.sessions;
		if (sessionCount > 0) {
			period.sessionDuration.avgDurationMs = period.sessionDuration.totalDurationMs / sessionCount;
			const prevAvgFirstProgress = period.sessionDuration.avgFirstProgressMs * (sessionCount - 1);
			period.sessionDuration.avgFirstProgressMs = (prevAvgFirstProgress + analysis.sessionDuration.avgFirstProgressMs) / sessionCount;
			const prevAvgTotalElapsed = period.sessionDuration.avgTotalElapsedMs * (sessionCount - 1);
			period.sessionDuration.avgTotalElapsedMs = (prevAvgTotalElapsed + analysis.sessionDuration.avgTotalElapsedMs) / sessionCount;
			const prevAvgWaitTime = period.sessionDuration.avgWaitTimeMs * (sessionCount - 1);
			period.sessionDuration.avgWaitTimeMs = (prevAvgWaitTime + analysis.sessionDuration.avgWaitTimeMs) / sessionCount;
		}
	}
	if (analysis.conversationPatterns) {
		period.conversationPatterns.multiTurnSessions += analysis.conversationPatterns.multiTurnSessions;
		period.conversationPatterns.singleTurnSessions += analysis.conversationPatterns.singleTurnSessions;
		period.conversationPatterns.maxTurnsInSession = Math.max(
			period.conversationPatterns.maxTurnsInSession,
			analysis.conversationPatterns.maxTurnsInSession
		);
		const totalSessions = period.conversationPatterns.multiTurnSessions + period.conversationPatterns.singleTurnSessions;
		if (totalSessions > 0) {
			const prevTotalTurns = period.conversationPatterns.avgTurnsPerSession * (totalSessions - 1);
			const newTotalTurns = prevTotalTurns + analysis.conversationPatterns.avgTurnsPerSession;
			period.conversationPatterns.avgTurnsPerSession = newTotalTurns / totalSessions;
		}
	}
	if (analysis.agentTypes) {
		period.agentTypes.editsAgent += analysis.agentTypes.editsAgent;
		period.agentTypes.defaultAgent += analysis.agentTypes.defaultAgent;
		period.agentTypes.workspaceAgent += analysis.agentTypes.workspaceAgent;
		period.agentTypes.other += analysis.agentTypes.other;
	}
	_muaMergeThinkingEffort(period, analysis);
	_muaMergeModelEfficiency(period, analysis);
}

/** Merge a session's per-model efficiency counters (issue #1649) into the period aggregate. */
function _muaMergeModelEfficiency(period: UsageAnalysisPeriod, analysis: SessionUsageAnalysis): void {
	if (!analysis.modelEfficiency) { return; }
	if (!period.modelEfficiency) { period.modelEfficiency = {}; }
	mergeModelEfficiency(period.modelEfficiency, analysis.modelEfficiency);
}

/** Merge a session's mode usage counters (incl. the optional cliApp/claudeDesktop/claudeVsCode splits) into the period aggregate. */
function _muaMergeModeUsage(period: UsageAnalysisPeriod, analysis: SessionUsageAnalysis): void {
	period.modeUsage.ask += analysis.modeUsage.ask;
	period.modeUsage.edit += analysis.modeUsage.edit;
	period.modeUsage.agent += analysis.modeUsage.agent;
	period.modeUsage.plan += analysis.modeUsage.plan;
	period.modeUsage.customAgent += analysis.modeUsage.customAgent;
	period.modeUsage.cli += analysis.modeUsage.cli;
	period.modeUsage.cliApp = (period.modeUsage.cliApp ?? 0) + (analysis.modeUsage.cliApp ?? 0);
	period.modeUsage.claudeDesktop = (period.modeUsage.claudeDesktop ?? 0) + (analysis.modeUsage.claudeDesktop ?? 0);
	period.modeUsage.claudeVsCode = (period.modeUsage.claudeVsCode ?? 0) + (analysis.modeUsage.claudeVsCode ?? 0);
	mergeAutonomyUsage(period, analysis.autonomyUsage);
}

/**
 * Fold one session's per-model token usage (and estimated provider cost) into a
 * period's model efficiency aggregate (issue #1649). Called by consumers that
 * already hold the session's cached ModelUsage, so no extra session parsing is
 * needed. Safe to call for sessions that produced no turn-derived counters.
 */
export function mergeModelEfficiencyTokens(
	period: UsageAnalysisPeriod,
	modelUsage: ModelUsage | undefined,
	modelPricing: { [key: string]: ModelPricing }
): void {
	if (!modelUsage || Object.keys(modelUsage).length === 0) { return; }
	if (!period.modelEfficiency) { period.modelEfficiency = {}; }
	applyModelUsageToEfficiency(period.modelEfficiency, modelUsage, modelPricing);
}

/**
 * Merge usage analysis data into period stats
 */
export function mergeUsageAnalysis(period: UsageAnalysisPeriod, analysis: SessionUsageAnalysis): void {
	period.toolCalls.total += analysis.toolCalls.total;
	for (const [tool, count] of Object.entries(analysis.toolCalls.byTool)) {
		period.toolCalls.byTool[tool] = (period.toolCalls.byTool[tool] || 0) + count;
	}
	if (analysis.toolCalls.outputTokensByTool) {
		if (!period.toolCalls.outputTokensByTool) { period.toolCalls.outputTokensByTool = {}; }
		for (const [tool, tokens] of Object.entries(analysis.toolCalls.outputTokensByTool)) {
			period.toolCalls.outputTokensByTool[tool] = (period.toolCalls.outputTokensByTool[tool] || 0) + tokens;
		}
	}
	_muaMergeToolOutcomes(period, analysis);
	_muaMergeModeUsage(period, analysis);
	_muaMergeContextRefs(period, analysis);
	period.mcpTools.total += analysis.mcpTools.total;
	for (const [server, count] of Object.entries(analysis.mcpTools.byServer)) {
		period.mcpTools.byServer[server] = (period.mcpTools.byServer[server] || 0) + count;
	}
	for (const [tool, count] of Object.entries(analysis.mcpTools.byTool)) {
		period.mcpTools.byTool[tool] = (period.mcpTools.byTool[tool] || 0) + count;
	}
	if (analysis.skillCalls) {
		if (!period.skillCalls) { period.skillCalls = { total: 0, byName: {} }; }
		period.skillCalls.total += analysis.skillCalls.total;
		for (const [name, count] of Object.entries(analysis.skillCalls.byName)) {
			period.skillCalls.byName[name] = (period.skillCalls.byName[name] || 0) + count;
		}
	}
	_muaMergeModelSwitching(period, analysis);
	_muaMergeEnhancedMetrics(period, analysis);
	_muaMergeTaskCategories(period, analysis);
	_muaMergeCorrections(period, analysis);
	_muaMergeCacheBreakage(period, analysis);
}

/** Fold per-tool / per-MCP-server failure counts and latency histograms into the period (all optional, all additive). */
function _muaMergeToolOutcomes(period: UsageAnalysisPeriod, analysis: SessionUsageAnalysis): void {
	const { toolCalls, mcpTools } = analysis;
	if (toolCalls.completedByTool) {
		period.toolCalls.completedByTool = _muaSumCounts(period.toolCalls.completedByTool, toolCalls.completedByTool);
	}
	if (mcpTools.completedByServer) {
		period.mcpTools.completedByServer = _muaSumCounts(period.mcpTools.completedByServer, mcpTools.completedByServer);
	}
	if (toolCalls.failuresByTool) {
		period.toolCalls.failuresByTool = _muaSumCounts(period.toolCalls.failuresByTool, toolCalls.failuresByTool);
	}
	if (toolCalls.latencyByTool) {
		period.toolCalls.latencyByTool = _muaMergeHistograms(period.toolCalls.latencyByTool, toolCalls.latencyByTool);
	}
	if (mcpTools.failuresByServer) {
		period.mcpTools.failuresByServer = _muaSumCounts(period.mcpTools.failuresByServer, mcpTools.failuresByServer);
	}
	if (mcpTools.latencyByServer) {
		period.mcpTools.latencyByServer = _muaMergeHistograms(period.mcpTools.latencyByServer, mcpTools.latencyByServer);
	}
}

/** Add a per-key count map into an (optional) period map, creating it on first use. */
function _muaSumCounts(into: { [key: string]: number } | undefined, from: { [key: string]: number }): { [key: string]: number } {
	const target = into ?? {};
	for (const [key, count] of Object.entries(from)) {
		target[key] = (target[key] || 0) + count;
	}
	return target;
}

/** Merge a per-key latency histogram map into an (optional) period map, creating it on first use. */
function _muaMergeHistograms(
	into: { [key: string]: LatencyHistogram } | undefined,
	from: { [key: string]: LatencyHistogram },
): { [key: string]: LatencyHistogram } {
	const target = into ?? {};
	for (const [key, histogram] of Object.entries(from)) {
		mergeLatencyHistogram(target[key] ??= createLatencyHistogram(), histogram);
	}
	return target;
}

/** Fold a session's cache-breakage result into the period's aggregated stats. */
function _muaMergeCacheBreakage(period: UsageAnalysisPeriod, analysis: SessionUsageAnalysis): void {
	if (!analysis.cacheBreakage) { return; }
	if (!period.cacheBreakage) { period.cacheBreakage = createEmptyCacheBreakagePeriodStats(); }
	mergeCacheBreakageIntoPeriod(period.cacheBreakage, analysis.cacheBreakage);
}

/** Fold a session's correction moments into the period's aggregated counters. */
function _muaMergeCorrections(period: UsageAnalysisPeriod, analysis: SessionUsageAnalysis): void {
	if (!analysis.correctionMoments || analysis.correctionMoments.length === 0) { return; }
	if (!period.corrections) {
		period.corrections = { userCorrections: 0, editRetries: 0, editSelfCorrections: 0, toolErrors: 0, toolErrorsRetried: 0, agentSelfCorrections: 0, escalatedUserCorrections: 0, sessionsWithMoments: 0, sessionsWithUserCorrections: 0, sessionsWithEscalations: 0 };
	}
	const counts = analysis.correctionCounts ?? summarizeCorrectionMoments(analysis.correctionMoments);
	mergeCorrectionCounts(period.corrections, counts);
	period.corrections.sessionsWithMoments++;
	if (counts.userCorrections > 0) { period.corrections.sessionsWithUserCorrections!++; }
	if (counts.escalatedUserCorrections > 0) { period.corrections.sessionsWithEscalations!++; }
}

/** @internal lookup table for analyzeContextReferences */
const CONTEXT_REF_PATTERNS: ReadonlyArray<readonly [RegExp, keyof ContextReferenceUsage]> = [
	[/#file/gi, 'file'],
	[/#selection/gi, 'selection'],
	[/#symbol/gi, 'symbol'],
	[/#sym(?![:\w])/gi, 'symbol'],
	[/#codebase/gi, 'codebase'],
	[/#terminalLastCommand/gi, 'terminalLastCommand'],
	[/#terminalSelection/gi, 'terminalSelection'],
	[/#clipboard/gi, 'clipboard'],
	[/#changes/gi, 'changes'],
	[/#outputPanel/gi, 'outputPanel'],
	[/#problemsPanel\b/gi, 'problemsPanel'],
	[/#pr\b/gi, 'pullRequest'],
	[/#pullRequest\b/gi, 'pullRequest'],
	[/@workspace/gi, 'workspace'],
	[/@terminal/gi, 'terminal'],
	[/@vscode/gi, 'vscode'],
] as const;


export function analyzeContextReferences(text: string, refs: ContextReferenceUsage): void {
	for (const [pattern, prop] of CONTEXT_REF_PATTERNS) {
		const matches = text.match(pattern);
		if (matches) { (refs[prop] as number) += matches.length; }
	}
}

function _acrGetReference(contentRef: ContentRefItemRaw): ContentRefObject | null {
	const kind = contentRef.kind;
	if (kind === 'reference' && contentRef.reference) { return contentRef.reference; }
	if (kind === 'inlineReference' && contentRef.inlineReference) { return contentRef.inlineReference; }
	return null;
}

function _acrClassifyFilePath(fsPath: string, normalizedPath: string, refs: ContextReferenceUsage): void {
	if (normalizedPath.endsWith('/.github/copilot-instructions.md') ||
		normalizedPath.includes('.github/copilot-instructions.md')) {
		refs.copilotInstructions++;
	} else if (normalizedPath.endsWith('/agents.md') || normalizedPath.match(/\/agents\.md$/i)) {
		refs.agentsMd++;
	} else if (normalizedPath.endsWith('.instructions.md') || normalizedPath.includes('.instructions.md')) {
		refs.copilotInstructions++;
	} else {
		refs.file++;
	}
	const pathKey = fsPath.length > 100 ? '...' + fsPath.substring(fsPath.length - 97) : fsPath;
	refs.byPath[pathKey] = (refs.byPath[pathKey] || 0) + 1;
}

function _acrProcessReference(reference: ContentRefObject, kind: string | undefined, refs: ContextReferenceUsage): void {
	const fsPath = reference.fsPath || reference.path;
	if (typeof fsPath === 'string') {
		_acrClassifyFilePath(fsPath, normalizePathForComparison(fsPath), refs);
	}
	const symbolName = reference.name;
	if (typeof symbolName === 'string' && kind === 'reference') {
		refs.symbol++;
		const symbolKey = `#sym:${symbolName}`;
		refs.byPath[symbolKey] = (refs.byPath[symbolKey] || 0) + 1;
	}
}

/**
 * Analyze contentReferences from session log data to track specific file attachments.
 * Looks for kind: "reference" entries and tracks by kind, path patterns.
 * Also increments specific category counters like refs.file when appropriate.
 */
export function analyzeContentReferences(contentReferences: unknown[], refs: ContextReferenceUsage): void {
	if (!Array.isArray(contentReferences)) { return; }
	for (const item of contentReferences) {
		if (!item || typeof item !== 'object') { continue; }
		const contentRef = item as ContentRefItemRaw;
		const kind = contentRef.kind;
		if (typeof kind === 'string') {
			refs.byKind[kind] = (refs.byKind[kind] || 0) + 1;
		}
		if (kind === 'pullRequest') { refs.pullRequest++; continue; }
		const reference = _acrGetReference(contentRef);
		if (reference) { _acrProcessReference(reference, kind, refs); }
	}
}

type VariableItemRaw = { kind?: string; name?: string; value?: { fsPath?: string; path?: string; external?: string } };

function _avdProcessVariable(variable: VariableItemRaw, refs: ContextReferenceUsage): void {
	const kind = variable.kind;
	if (typeof kind === 'string') {
		refs.byKind[kind] = (refs.byKind[kind] || 0) + 1;
	}
	// VS Code stores images with kind='image' in variableData; map to 'copilot.image' so
	// maturity scoring (which checks byKind['copilot.image']) detects them correctly.
	if (kind === 'image') {
		refs.byKind['copilot.image'] = (refs.byKind['copilot.image'] || 0) + 1;
	}
	// Explicit file variable attachments count the same as #file: text references.
	if (kind === 'file') {
		refs.file++;
	}
	if (kind === 'generic' && typeof variable.name === 'string' && variable.name.startsWith('sym:')) {
		refs.symbol++;
		const symbolKey = `#${variable.name}`;
		refs.byPath[symbolKey] = (refs.byPath[symbolKey] || 0) + 1;
	}
}

/**
 * Analyze variableData to track prompt file attachments and other variable-based context.
 * This captures automatic attachments like copilot-instructions.md via variable system.
 */
export function analyzeVariableData(variableData: unknown, refs: ContextReferenceUsage): void {
	if (!variableData || typeof variableData !== 'object') {
		return;
	}
	const data = variableData as VariableDataRaw;
	if (!Array.isArray(data.variables)) {
		return;
	}

	for (const variable of data.variables) {
		if (!variable || typeof variable !== 'object') { continue; }
		_avdProcessVariable(variable as VariableItemRaw, refs);
	}
}

/**
 * Derive conversation patterns from already-computed mode usage.
 * Called before every return in analyzeSessionUsage to ensure all file formats get patterns.
 */
export function deriveConversationPatterns(analysis: SessionUsageAnalysis): void {
	const totalRequests = analysis.modeUsage.ask + analysis.modeUsage.edit + analysis.modeUsage.agent + analysis.modeUsage.cli;
	analysis.conversationPatterns = {
		multiTurnSessions: totalRequests > 1 ? 1 : 0,
		singleTurnSessions: totalRequests === 1 ? 1 : 0,
		avgTurnsPerSession: totalRequests,
		maxTurnsInSession: totalRequests
	};
}

function _arcProcessDynamicPart(part: Record<string, unknown>, refs: ContextReferenceUsage): void {
	if (part['kind'] !== 'dynamic') { return; }
	const range = (part['data'] as Record<string, unknown> | undefined)?.['range'] as Record<string, unknown> | undefined;
	const start = typeof range?.['startLineNumber'] === 'number' ? range['startLineNumber'] : 0;
	const end = typeof range?.['endLineNumber'] === 'number' ? range['endLineNumber'] : 0;
	if (end >= start && end > 0) {
		refs.codeContextLines = (refs.codeContextLines || 0) + (end - start + 1);
	}
}

function _arcProcessPromptPart(part: Record<string, unknown>, refs: ContextReferenceUsage): void {
	if (part['kind'] !== 'prompt') { return; }
	const cmd = (part['slashPromptCommand'] as Record<string, unknown> | undefined)?.['command'];
	if (typeof cmd === 'string') {
		refs.byKind['prompt'] = (refs.byKind['prompt'] || 0) + 1;
	}
}

function _arcProcessPart(part: unknown, refs: ContextReferenceUsage): void {
	if (!part || typeof part !== 'object') { return; }
	const p = part as Record<string, unknown>;
	if (typeof p['text'] === 'string') { analyzeContextReferences(p['text'], refs); }
	_arcProcessDynamicPart(p, refs);
	_arcProcessPromptPart(p, refs);
}

function _arcProcessMessage(msg: Record<string, unknown>, refs: ContextReferenceUsage): void {
	if (typeof msg['text'] === 'string') { analyzeContextReferences(msg['text'], refs); }
	const parts = msg['parts'];
	if (!Array.isArray(parts)) { return; }
	for (const part of parts) {
		_arcProcessPart(part, refs);
	}
}

/**
 * Analyze a request object for all context references.
 * This is the unified method that processes text, contentReferences, and variableData.
 */
export function analyzeRequestContext(request: unknown, refs: ContextReferenceUsage): void {
	if (!request || typeof request !== 'object') { return; }
	const req = request as Record<string, unknown>;

	// Analyze user message text for context references
	const message = req['message'];
	if (message && typeof message === 'object') {
		_arcProcessMessage(message as Record<string, unknown>, refs);
	}
	const contentRefs = req['contentReferences'];
	if (Array.isArray(contentRefs)) { analyzeContentReferences(contentRefs, refs); }
	const variableData = req['variableData'];
	if (variableData !== undefined) { analyzeVariableData(variableData, refs); }
}

/**
 * Classifies unique models by tier and counts requests per tier.
 * Called before each early return in analyzeSessionUsage so that all session
 * formats (OpenCode, Visual Studio, Crush, Continue) populate the tier-breakdown
 * shown by the Multi-Model Usage section in the usage analysis view.
 */
/**
 * Read Claude Code session events from a JSONL file for usage analysis.
 * Lightweight: only used internally by analyzeSessionUsage.
 */
export async function readClaudeCodeEventsForAnalysis(sessionFilePath: string): Promise<any[]> {
	try {
		const content = await fs.promises.readFile(sessionFilePath, 'utf8');
		const lines = content.trim().split('\n');
		const events: unknown[] = [];
		for (const line of lines) {
			if (!line.trim()) { continue; }
			try { events.push(JSON.parse(line)); } catch { /* skip */ }
		}
		return events;
	} catch {
		return [];
	}
}

// eslint-disable-next-line sonarjs/cognitive-complexity
export function applyModelTierClassification(
	modelPricing: { [key: string]: ModelPricing },
	uniqueModels: string[],
	allModelRequests: string[],
	analysis: SessionUsageAnalysis
): void {
	const standard: string[] = [];
	const premium: string[] = [];
	const unknown: string[] = [];
	for (const model of uniqueModels) {
		const tier = getModelTier(model, modelPricing);
		if (tier === 'standard') { standard.push(model); }
		else if (tier === 'premium') { premium.push(model); }
		else { unknown.push(model); }
	}
	analysis.modelSwitching.tiers = { standard, premium, unknown };
	analysis.modelSwitching.hasMixedTiers = standard.length > 0 && premium.length > 0;
	const costBuckets = { low: [] as string[], medium: [] as string[], high: [] as string[], unknown: [] as string[] };
	for (const model of uniqueModels) {
		const bucket = getModelCostBucket(model, modelPricing);
		if (bucket === 'low') { costBuckets.low.push(model); }
		else if (bucket === 'medium') { costBuckets.medium.push(model); }
		else if (bucket === 'high') { costBuckets.high.push(model); }
		else { costBuckets.unknown.push(model); }
	}
	analysis.modelSwitching.costBuckets = costBuckets;
	const nonUnknownBuckets = [costBuckets.low, costBuckets.medium, costBuckets.high].filter(b => b.length > 0).length;
	analysis.modelSwitching.hasMixedCosts = nonUnknownBuckets >= 2;
	let stdReq = 0, premReq = 0, unkReq = 0;
	let lowReq = 0, medReq = 0, highReq = 0;
	for (const model of allModelRequests) {
		const tier = getModelTier(model, modelPricing);
		if (tier === 'standard') { stdReq++; }
		else if (tier === 'premium') { premReq++; }
		else { unkReq++; }
		const bucket = getModelCostBucket(model, modelPricing);
		if (bucket === 'low') { lowReq++; }
		else if (bucket === 'medium') { medReq++; }
		else if (bucket === 'high') { highReq++; }
	}
	analysis.modelSwitching.standardRequests = stdReq;
	analysis.modelSwitching.premiumRequests = premReq;
	analysis.modelSwitching.unknownRequests = unkReq;
	analysis.modelSwitching.lowCostRequests = lowReq;
	analysis.modelSwitching.mediumCostRequests = medReq;
	analysis.modelSwitching.highCostRequests = highReq;
}

type TierCounts = { standard: number; premium: number; unknown: number };
type CostCounts = { low: number; medium: number; high: number; unknown: number };

function _cmsIncrementTierCount(model: string, tierCounts: TierCounts, modelPricing: { [key: string]: ModelPricing }): void {
	const tier = getModelTier(model, modelPricing);
	if (tier === 'standard') { tierCounts.standard++; }
	else if (tier === 'premium') { tierCounts.premium++; }
	else { tierCounts.unknown++; }
}

function _cmsIncrementCostCount(model: string, costCounts: CostCounts, modelPricing: { [key: string]: ModelPricing }): void {
	const bucket = getModelCostBucket(model, modelPricing);
	if (bucket === 'low') { costCounts.low++; }
	else if (bucket === 'medium') { costCounts.medium++; }
	else if (bucket === 'high') { costCounts.high++; }
	else { costCounts.unknown++; }
}

function _cmsApplyTierCounts(tierCounts: TierCounts, analysis: SessionUsageAnalysis): void {
	analysis.modelSwitching.standardRequests = tierCounts.standard;
	analysis.modelSwitching.premiumRequests = tierCounts.premium;
	analysis.modelSwitching.unknownRequests = tierCounts.unknown;
	analysis.modelSwitching.totalRequests = tierCounts.standard + tierCounts.premium + tierCounts.unknown;
}

function _cmsApplyCostCounts(costCounts: CostCounts, analysis: SessionUsageAnalysis): void {
	analysis.modelSwitching.lowCostRequests = costCounts.low;
	analysis.modelSwitching.mediumCostRequests = costCounts.medium;
	analysis.modelSwitching.highCostRequests = costCounts.high;
	analysis.modelSwitching.totalRequests = costCounts.low + costCounts.medium + costCounts.high + costCounts.unknown;
}

function _cmsClassifyModels(uniqueModels: string[], modelPricing: { [key: string]: ModelPricing }): { standard: string[]; premium: string[]; unknown: string[] } {
	const standard: string[] = [], premium: string[] = [], unknown: string[] = [];
	for (const model of uniqueModels) {
		const tier = getModelTier(model, modelPricing);
		if (tier === 'standard') { standard.push(model); }
		else if (tier === 'premium') { premium.push(model); }
		else { unknown.push(model); }
	}
	return { standard, premium, unknown };
}

/**
 * Detect Auto model usage from a request object by checking for the pattern:
 * - model field equals "auto", or
 * - both model and resolvedModel fields are present (indicating Auto was used and resolved to a specific model)
 */
function _cmsDetectAutoFromRequest(request: SessionRequestRaw | any, analysis: SessionUsageAnalysis): void {
	// Check for explicit model === "auto" at request level
	if (request.model === 'auto') {
		analysis.modelSwitching.autoSessions = 1;
		return;
	}
	// Check for pattern: both model and resolvedModel (auto resolution indicator)
	if (request.model && request.resolvedModel && request.model !== request.resolvedModel) {
		// If there's a different resolved model than requested model, Auto was used
		analysis.modelSwitching.autoSessions = 1;
		return;
	}
	// Also check in result.metadata
	if (request.result?.metadata) {
		if (request.result.metadata.model === 'auto') {
			analysis.modelSwitching.autoSessions = 1;
			return;
		}
		if (request.result.metadata.model && request.result.metadata.resolvedModel && 
		    request.result.metadata.model !== request.result.metadata.resolvedModel) {
			analysis.modelSwitching.autoSessions = 1;
			return;
		}
	}
}

/**
 * Detect Foundry/local model usage from request object by checking model field patterns
 */
function _cmsDetectFoundryFromRequest(request: SessionRequestRaw | any, analysis: SessionUsageAnalysis): void {
	if (!request.model) { return; }
	const modelStr = String(request.model).toLowerCase();
	// Check for patterns like "aitk-foundry-local/..." or "Microsoft Foundry on Windows"
	if (modelStr.includes('foundry') && (modelStr.includes('microsoft') || modelStr.includes('aitk'))) {
		analysis.modelSwitching.foundryWindowsSessions = 1;
	}
}

function _cmsCountJsonRequests(sessionContent: ParsedSessionJson, analysis: SessionUsageAnalysis, modelPricing: { [key: string]: ModelPricing }): void {
	if (!sessionContent.requests || !Array.isArray(sessionContent.requests)) { return; }
	let previousModel: string | null = null;
	let switchCount = 0;
	const tierCounts: TierCounts = { standard: 0, premium: 0, unknown: 0 };
	const costCounts: CostCounts = { low: 0, medium: 0, high: 0, unknown: 0 };
	for (const requestRaw of sessionContent.requests) {
		const currentModel = getModelFromRequest(requestRaw as SessionRequestRaw, modelPricing);
		if (previousModel && currentModel !== previousModel) { switchCount++; }
		previousModel = currentModel;
		_cmsIncrementTierCount(currentModel, tierCounts, modelPricing);
		_cmsIncrementCostCount(currentModel, costCounts, modelPricing);
		// Track Auto model usage: when 'model' field equals 'auto' or when both 'model' and 'resolved model' exist
		_cmsDetectAutoFromRequest(requestRaw as SessionRequestRaw, analysis);
		// Track Foundry model usage from request-level model field
		_cmsDetectFoundryFromRequest(requestRaw as SessionRequestRaw, analysis);
	}
	analysis.modelSwitching.switchCount = switchCount;
	_cmsApplyTierCounts(tierCounts, analysis);
	_cmsApplyCostCounts(costCounts, analysis);
}

function _cmsTrackSelectionSignalsFromParsedJson(sessionContent: ParsedSessionJson, analysis: SessionUsageAnalysis): void {
	_cmsTrackModelSelectionSignals(sessionContent.selectedModel?.identifier || sessionContent.selectedModel?.metadata?.id, sessionContent.selectedModel, analysis);
	_cmsTrackModelSelectionSignals(sessionContent.inputState?.selectedModel?.identifier || sessionContent.inputState?.selectedModel?.metadata?.id, sessionContent.inputState?.selectedModel, analysis);
}

type CmsEvent = JsonlEventRaw & { type?: string; data?: { selectedModel?: string; newModel?: string }; model?: string };

function _cmsGetKind0ModelId(event: CmsEvent): string | null {
	if (event.kind !== 0) { return null; }
	const v = event.v as { selectedModel?: { identifier?: string; metadata?: { id?: string } }; inputState?: { selectedModel?: { identifier?: string; metadata?: { id?: string } } } } | undefined;
	if (!v) { return null; }
	const sm = v.selectedModel;
	const ism = v.inputState?.selectedModel;
	const id = sm?.identifier || sm?.metadata?.id || ism?.identifier || ism?.metadata?.id;
	if (!id) { return null; }
	return id.replace(/^copilot\//, '');
}

function _cmsGetKind2ModelId(event: CmsEvent): string | null {
	if (event.kind !== 2 || event.k?.[0] !== 'selectedModel') { return null; }
	const v = event.v as { identifier?: string; metadata?: { id?: string } } | undefined;
	const id = v?.identifier || v?.metadata?.id;
	if (!id) { return null; }
	return id.replace(/^copilot\//, '');
}

function _cmsExtractDefaultModel(event: CmsEvent, currentDefault: string): string {
	const id0 = _cmsGetKind0ModelId(event);
	if (id0) { return id0; }
	const id2 = _cmsGetKind2ModelId(event);
	if (id2) { return id2; }
	if (event.type === 'session.start' && typeof event.data?.selectedModel === 'string') { return event.data.selectedModel; }
	if (event.type === 'session.model_change' && typeof event.data?.newModel === 'string') { return event.data.newModel; }
	return currentDefault;
}

function _cmsGetJsonlRequestModel(request: unknown, defaultModel: string, modelPricing: { [key: string]: ModelPricing }): string {
	return getModelFromRequest(request as SessionRequestRaw, modelPricing, defaultModel);
}

function _cmsCountEventRequests(event: CmsEvent, tierCounts: TierCounts, costCounts: CostCounts, defaultModel: string, modelPricing: { [key: string]: ModelPricing }): void {
	if (event.type === 'user.message') {
		const model = event.model || defaultModel;
		_cmsIncrementTierCount(model, tierCounts, modelPricing);
		_cmsIncrementCostCount(model, costCounts, modelPricing);
		return;
	}
	if (event.kind !== 2 || event.k?.[0] !== 'requests' || !Array.isArray(event.v)) { return; }
	for (const request of event.v as unknown[]) {
		const model = _cmsGetJsonlRequestModel(request, defaultModel, modelPricing);
		_cmsIncrementTierCount(model, tierCounts, modelPricing);
		_cmsIncrementCostCount(model, costCounts, modelPricing);
	}
}

function _cmsCountJsonlRequests(lines: string[], analysis: SessionUsageAnalysis, modelPricing: { [key: string]: ModelPricing }): void {
	const tierCounts: TierCounts = { standard: 0, premium: 0, unknown: 0 };
	const costCounts: CostCounts = { low: 0, medium: 0, high: 0, unknown: 0 };
	let defaultModel = 'unknown';
	for (const line of lines) {
		if (!line.trim()) { continue; }
		try {
			const event = JSON.parse(line) as CmsEvent;
			defaultModel = _cmsExtractDefaultModel(event, defaultModel);
			_cmsTrackSelectionSignalsFromEvent(event, analysis);
			_cmsCountEventRequests(event, tierCounts, costCounts, defaultModel, modelPricing);
		} catch { /* skip malformed lines */ }
	}
	_cmsApplyTierCounts(tierCounts, analysis);
	_cmsApplyCostCounts(costCounts, analysis);
}

/**
 * Calculate model switching statistics for a session file.
 * This method updates the analysis.modelSwitching field in place.
 */
// eslint-disable-next-line complexity, sonarjs/cognitive-complexity
export async function calculateModelSwitching(deps: Pick<UsageAnalysisDeps, 'warn' | 'modelPricing' | 'tokenEstimators' | 'ecosystems'>, sessionFile: string, analysis: SessionUsageAnalysis, preloadedContent?: string, preloadedParsedJson?: unknown): Promise<void> {
	try {
		// Use non-cached method to avoid circular dependency
		// (getSessionFileDataCached -> analyzeSessionUsage -> getModelUsageFromSessionCached -> getSessionFileDataCached)
		const modelUsage = await getModelUsageFromSession(deps, sessionFile, preloadedContent, preloadedParsedJson);
		const modelCount = modelUsage ? Object.keys(modelUsage).length : 0;
		if (!modelUsage || modelCount === 0) { return; }
		const uniqueModels = Object.keys(modelUsage);
		analysis.modelSwitching.uniqueModels = uniqueModels;
		analysis.modelSwitching.modelCount = uniqueModels.length;
		const tiers = _cmsClassifyModels(uniqueModels, deps.modelPricing);
		analysis.modelSwitching.tiers = tiers;
		analysis.modelSwitching.hasMixedTiers = tiers.standard.length > 0 && tiers.premium.length > 0;
		const costBuckets = { low: [] as string[], medium: [] as string[], high: [] as string[], unknown: [] as string[] };
		for (const model of uniqueModels) {
			const bucket = getModelCostBucket(model, deps.modelPricing);
			if (bucket === 'low') { costBuckets.low.push(model); }
			else if (bucket === 'medium') { costBuckets.medium.push(model); }
			else if (bucket === 'high') { costBuckets.high.push(model); }
			else { costBuckets.unknown.push(model); }
		}
		analysis.modelSwitching.costBuckets = costBuckets;
		const nonUnknownBuckets = [costBuckets.low, costBuckets.medium, costBuckets.high].filter(b => b.length > 0).length;
		analysis.modelSwitching.hasMixedCosts = nonUnknownBuckets >= 2;
		const fileContent = preloadedContent ?? await fs.promises.readFile(sessionFile, 'utf8');
		// Check if this is a UUID-only file (new Copilot CLI format)
		if (isUuidPointerFile(fileContent)) {
			return;
		}
		const isJsonl = sessionFile.endsWith('.jsonl') || isJsonlContent(fileContent);
		if (!isJsonl) {
			const parsed: unknown = preloadedParsedJson !== undefined ? preloadedParsedJson : JSON.parse(fileContent);
			if (!isParsedSessionJson(parsed)) { deps.warn(`Unexpected session format in ${sessionFile}`); return; }
			_cmsTrackSelectionSignalsFromParsedJson(parsed, analysis);
			_cmsCountJsonRequests(parsed, analysis, deps.modelPricing);
		} else {
			_cmsCountJsonlRequests(fileContent.trim().split('\n'), analysis, deps.modelPricing);
		}
	} catch (error) {
		deps.warn(`Error calculating model switching for ${sessionFile}: ${error}`);
	}
}

type TemState = {
	totalApplies: number; totalCodeBlocks: number; totalLinesAdded: number; totalLinesRemoved: number;
	allLanguageUsage: LanguageUsage; editedFiles: Set<string>; timestamps: number[];
	timingsData: { firstProgress?: number; totalElapsed?: number }[]; waitTimes: number[];
	activeIntervals: { start: number; end: number }[];
	agentCounts: { editsAgent: number; defaultAgent: number; workspaceAgent: number; other: number };
};

/**
 * Merge overlapping/adjacent [start, end] intervals and sum their combined length.
 * Used to compute "active" time (interactive use + tool/agent wait) while excluding
 * idle gaps between an agent's response and the next user message.
 */
function mergeIntervalsAndSumMs(intervals: { start: number; end: number }[]): number {
	if (intervals.length === 0) { return 0; }
	const sorted = [...intervals].sort((a, b) => a.start - b.start);
	let totalMs = 0;
	let curStart = sorted[0].start;
	let curEnd = sorted[0].end;
	for (let i = 1; i < sorted.length; i++) {
		const { start, end } = sorted[i];
		if (start <= curEnd) {
			// Overlapping or contiguous: extend the current merged window.
			curEnd = Math.max(curEnd, end);
		} else {
			totalMs += curEnd - curStart;
			curStart = start;
			curEnd = end;
		}
	}
	totalMs += curEnd - curStart;
	return totalMs;
}

function _temMergeLocUsage(dest: LanguageUsage, src: LanguageUsage): void {
	for (const [ext, usage] of Object.entries(src)) {
		if (!dest[ext]) { dest[ext] = { linesAdded: 0, linesRemoved: 0 }; }
		dest[ext].linesAdded += usage.linesAdded;
		dest[ext].linesRemoved += usage.linesRemoved;
	}
}

function _temProcessDeltaJsonl(lines: string[], state: TemState): void {
	let isDeltaBased = false;
	if (lines.length > 0) {
		try { const fl = JSON.parse(lines[0]); if (fl && typeof fl.kind === 'number') { isDeltaBased = true; } } catch { /* not delta */ }
	}
	if (!isDeltaBased) { return; }
	let sessionState: DeltaSessionState = {};
	for (const line of lines) {
		try { sessionState = applyDelta(sessionState, JSON.parse(line)) as DeltaSessionState; } catch { /* skip */ }
	}
	if (sessionState.creationDate !== undefined) { state.timestamps.push(sessionState.creationDate); }
	if (sessionState.lastMessageDate !== undefined) { state.timestamps.push(sessionState.lastMessageDate); }
	const result = processRequestsForEnhancedMetrics((sessionState.requests || []) as SessionRequestRaw[], state.agentCounts, state.editedFiles, state.timestamps, state.timingsData, state.waitTimes, state.activeIntervals);
	state.totalApplies = result.totalApplies; state.totalCodeBlocks = result.totalCodeBlocks;
	state.totalLinesAdded = result.totalLinesAdded; state.totalLinesRemoved = result.totalLinesRemoved;
	_temMergeLocUsage(state.allLanguageUsage, result.languageUsage);
}

function _temProcessJsonFile(deps: Pick<UsageAnalysisDeps, 'warn'>, sessionFile: string, parsed: unknown, state: TemState): boolean {
	if (!isParsedSessionJson(parsed)) { deps.warn(`Unexpected session format in ${sessionFile}`); return false; }
	if (parsed.creationDate) { state.timestamps.push(parsed.creationDate); }
	if (parsed.lastMessageDate) { state.timestamps.push(parsed.lastMessageDate); }
	const result = processRequestsForEnhancedMetrics((parsed.requests ?? []) as SessionRequestRaw[], state.agentCounts, state.editedFiles, state.timestamps, state.timingsData, state.waitTimes, state.activeIntervals);
	state.totalApplies = result.totalApplies; state.totalCodeBlocks = result.totalCodeBlocks;
	state.totalLinesAdded = result.totalLinesAdded; state.totalLinesRemoved = result.totalLinesRemoved;
	_temMergeLocUsage(state.allLanguageUsage, result.languageUsage);
	return true;
}

function _temStoreResults(analysis: SessionUsageAnalysis, state: TemState): void {
	const editSessionCount = state.editedFiles.size > 0 ? 1 : 0;
	analysis.editScope = {
		singleFileEdits: state.editedFiles.size === 1 ? 1 : 0,
		multiFileEdits: state.editedFiles.size > 1 ? 1 : 0,
		totalEditedFiles: state.editedFiles.size,
		avgFilesPerSession: editSessionCount > 0 ? state.editedFiles.size / editSessionCount : 0,
		linesAdded: state.totalLinesAdded,
		linesRemoved: state.totalLinesRemoved,
		...(Object.keys(state.allLanguageUsage).length > 0 ? { languageUsage: state.allLanguageUsage } : {}),
	};
	analysis.applyUsage = {
		totalApplies: state.totalApplies, totalCodeBlocks: state.totalCodeBlocks,
		applyRate: state.totalCodeBlocks > 0 ? (state.totalApplies / state.totalCodeBlocks) * 100 : 0
	};
	const totalDurationMs = state.timestamps.length >= 2 ? Math.max(...state.timestamps) - Math.min(...state.timestamps) : 0;
	const avgFirstProgressMs = state.timingsData.length > 0 ? state.timingsData.reduce((s, t) => s + (t.firstProgress || 0), 0) / state.timingsData.length : 0;
	const avgTotalElapsedMs = state.timingsData.length > 0 ? state.timingsData.reduce((s, t) => s + (t.totalElapsed || 0), 0) / state.timingsData.length : 0;
	const avgWaitTimeMs = state.waitTimes.length > 0 ? state.waitTimes.reduce((s, w) => s + w, 0) / state.waitTimes.length : 0;
	const activeDurationMs = mergeIntervalsAndSumMs(state.activeIntervals);
	analysis.sessionDuration = { totalDurationMs, avgDurationMs: totalDurationMs, avgFirstProgressMs, avgTotalElapsedMs, avgWaitTimeMs, activeDurationMs };
	deriveConversationPatterns(analysis);
	analysis.agentTypes = state.agentCounts;
}

function _temCountLines(text: string): number {
	return text.length > 0 ? (text.match(/\n/g) ?? []).length + (text.endsWith('\n') ? 0 : 1) : 0;
}

function _temHandleExecutionStart(
	event: any,
	pendingEdits: Map<string, { filePath: string; added: number; removed: number }>
): void {
	const toolName: unknown = event.data?.toolName;
	const args: Record<string, unknown> = event.data?.arguments ?? {};
	const toolCallId: unknown = event.data?.toolCallId;
	const filePath: unknown = args.path;
	if (typeof filePath !== 'string' || !filePath || typeof toolCallId !== 'string') { return; }
	if (toolName !== 'edit' && toolName !== 'create') { return; }
	const rawNew = toolName === 'edit' ? args.new_str : args.file_text;
	const rawOld = toolName === 'edit' ? args.old_str : undefined;
	const newText = typeof rawNew === 'string' ? rawNew : '';
	const oldText = typeof rawOld === 'string' ? rawOld : '';
	pendingEdits.set(toolCallId, { filePath, added: _temCountLines(newText), removed: _temCountLines(oldText) });
}

function _temHandleExecutionComplete(
	event: any,
	pendingEdits: Map<string, { filePath: string; added: number; removed: number }>,
	state: TemState
): void {
	if (event.data?.success !== true) { return; }
	const toolCallId: unknown = event.data?.toolCallId;
	if (typeof toolCallId !== 'string') { return; }
	const pending = pendingEdits.get(toolCallId);
	if (!pending) { return; }
	pendingEdits.delete(toolCallId);
	state.totalLinesAdded += pending.added;
	state.totalLinesRemoved += pending.removed;
	state.editedFiles.add(pending.filePath);
	const ext = normalizeExtension(pending.filePath);
	if (!state.allLanguageUsage[ext]) { state.allLanguageUsage[ext] = { linesAdded: 0, linesRemoved: 0 }; }
	state.allLanguageUsage[ext].linesAdded += pending.added;
	state.allLanguageUsage[ext].linesRemoved += pending.removed;
}

function _temProcessNonDeltaJsonlEdits(lines: string[], state: TemState): void {
	const pendingEdits = new Map<string, { filePath: string; added: number; removed: number }>();
	for (const line of lines) {
		try {
			const event = JSON.parse(line);
			if (event.type === 'tool.execution_start') {
				_temHandleExecutionStart(event, pendingEdits);
			} else if (event.type === 'tool.execution_complete') {
				_temHandleExecutionComplete(event, pendingEdits, state);
			}
		} catch { /* skip malformed lines */ }
	}
}

/**
 * Track enhanced metrics from session files:
 * - Edit scope (single vs multi-file edits)
 * - Apply button usage (codeblockUri with isEdit flag)
 * - Session duration data
 * - Conversation patterns (multi-turn sessions)
 * - Agent type usage
 */
export async function trackEnhancedMetrics(deps: Pick<UsageAnalysisDeps, 'warn'>, sessionFile: string, analysis: SessionUsageAnalysis, preloadedContent?: string, preloadedParsedJson?: unknown): Promise<void> {
	try {
		const fileContent = preloadedContent ?? await fs.promises.readFile(sessionFile, 'utf8');
		if (isUuidPointerFile(fileContent)) { return; }
		const isJsonl = sessionFile.endsWith('.jsonl') || isJsonlContent(fileContent);
		const state: TemState = {
			totalApplies: 0, totalCodeBlocks: 0, totalLinesAdded: 0, totalLinesRemoved: 0,
			allLanguageUsage: {}, editedFiles: new Set<string>(), timestamps: [], timingsData: [], waitTimes: [],
			activeIntervals: [],
			agentCounts: { editsAgent: 0, defaultAgent: 0, workspaceAgent: 0, other: 0 },
		};
		if (isJsonl) {
			const lines = fileContent.trim().split('\n').filter((l: string) => l.trim());
			_temProcessDeltaJsonl(lines, state);
			if (!_asuIsDeltaBased(lines)) {
				// Non-delta JSONL (Copilot CLI format): extract LOC from edit/create tool calls.
				// Match execution_start to execution_complete by toolCallId so only successful edits count.
				_temProcessNonDeltaJsonlEdits(lines, state);
			}
		} else {
			const parsed = preloadedParsedJson !== undefined ? preloadedParsedJson : JSON.parse(fileContent);
			if (!_temProcessJsonFile(deps, sessionFile, parsed, state)) { return; }
		}
		_temStoreResults(analysis, state);
	} catch (error) {
		deps.warn(`Error tracking enhanced metrics from ${sessionFile}: ${error}`);
	}
}

/**
 * Increment `analysis.skillCalls` for `skillName`, lazily initializing the bucket.
 * Shared low-level helper — every adapter capable of resolving a specific skill/command
 * name from its own session format (whatever that format's representation looks like)
 * funnels through this one function, so `skillCalls` stays consistent across editors.
 */
export function addSkillCall(analysis: SessionUsageAnalysis, skillName: string): void {
	if (!analysis.skillCalls) { analysis.skillCalls = { total: 0, byName: {} }; }
	analysis.skillCalls.total++;
	analysis.skillCalls.byName[skillName] = (analysis.skillCalls.byName[skillName] || 0) + 1;
}

/**
 * Create an empty SessionUsageAnalysis object, used as the baseline for adapter analyzeUsage() implementations.
 */
export function createEmptySessionUsageAnalysis(): SessionUsageAnalysis {
	return {
		toolCalls: { total: 0, byTool: {} },
		modeUsage: { ask: 0, edit: 0, agent: 0, plan: 0, customAgent: 0, cli: 0 },
		contextReferences: createEmptyContextRefs(),
		mcpTools: { total: 0, byServer: {}, byTool: {} },
		taskClassification: createEmptyTaskClassificationResult(),
		skillCalls: { total: 0, byName: {} },
		modelSwitching: {
			uniqueModels: [],
			modelCount: 0,
			switchCount: 0,
			autoSessions: 0,
			foundryWindowsSessions: 0,
			unknownProviderSessions: 0,
			selectedModelExtensions: [],
			unknownProviderModels: [],
			tiers: { standard: [], premium: [], unknown: [] },
			hasMixedTiers: false,
			standardRequests: 0,
			premiumRequests: 0,
			unknownRequests: 0,
			totalRequests: 0,
			costBuckets: { low: [], medium: [], high: [], unknown: [] },
			hasMixedCosts: false,
			lowCostRequests: 0,
			mediumCostRequests: 0,
			highCostRequests: 0,
		},
	};
}

/** Mutable mode state passed through JSONL event handlers. */
type AsuModeState = { sessionMode: string };
/** A tool call seen on tool.execution_start and awaiting its tool.execution_complete. */
type AsuPendingToolCall = {
	toolName: string;
	args: Record<string, string>;
	effCall?: EfficiencyTurn['toolCalls'][number];
	/** MCP server name tagged on the start event (`data.mcpServerName` / `data.mcpServer`), if any. */
	mcpServerName?: string;
	/** Epoch ms of the start event, or undefined when the event had no parseable timestamp. */
	startedAt?: number;
};

/** Mutable CLI tracking state passed through JSONL event handlers. */
type AsuCliState = {
	defaultModel: string;
	defaultEffort: string | null;
	requestCount: number;
	effortByRequest: { [effort: string]: number };
	pendingToolCalls: Map<string, AsuPendingToolCall>;
	editedFilePaths: Set<string>;
	/** Per-user-turn tool-call sequences for model efficiency metrics (issue #1649). */
	efficiencyTurns: EfficiencyTurn[];
};

/** Append a tool call to the current (or an implicit first) efficiency turn. */
function _asuAppendEfficiencyToolCall(cliState: AsuCliState, toolName: string, args: Record<string, string> | undefined): EfficiencyTurn['toolCalls'][number] {
	let turn = cliState.efficiencyTurns[cliState.efficiencyTurns.length - 1];
	if (!turn) {
		turn = { model: cliState.defaultModel, toolCalls: [] };
		cliState.efficiencyTurns.push(turn);
	}
	const call: EfficiencyTurn['toolCalls'][number] = { toolName, arguments: args ? JSON.stringify(args) : undefined };
	turn.toolCalls.push(call);
	return call;
}

/** Check if the first JSONL line indicates a delta-based VS Code incremental format. */
function _asuIsDeltaBased(lines: string[]): boolean {
	if (lines.length === 0) { return false; }
	try {
		const first = JSON.parse(lines[0]);
		return first && typeof first.kind === 'number';
	} catch { return false; }
}

/** Reconstruct delta state from all lines and dispatch to processDeltaSessionAnalysis. */
function _asuReconstructAndProcessDeltaState(
	deps: UsageAnalysisDeps,
	lines: string[],
	analysis: SessionUsageAnalysis
): void {
	let sessionState: DeltaSessionState = {};
	let permissionLevel: string | undefined;
	// permissionLevel (autopilot vs default) can be toggled mid-session, so remember the value in
	// force when each request first appeared rather than only the final one.
	const levelByRequest: (string | undefined)[] = [];
	for (const line of lines) {
		try {
			const delta = JSON.parse(line);
			sessionState = applyDelta(sessionState, delta) as DeltaSessionState;
			permissionLevel = _asuReadPermissionLevel(delta) ?? permissionLevel;
			const requestCount = Array.isArray(sessionState.requests) ? sessionState.requests.length : 0;
			while (levelByRequest.length < requestCount) { levelByRequest.push(permissionLevel); }
		} catch { /* skip invalid lines */ }
	}
	processDeltaSessionAnalysis(deps, sessionState, lines, analysis);
	if (Array.isArray(sessionState.requests)) {
		(sessionState.requests as SessionRequestRaw[]).forEach((req, i) => { if (req?.requestId) { recordAutonomy(analysis, levelByRequest[i]); } });
	}
}

/** Read a VS Code `inputState.permissionLevel` value from a kind-0 (header) or kind-1 (patch) delta event. */
function _asuReadPermissionLevel(delta: any): string | undefined {
	if (delta?.kind === 0 && typeof delta.v?.inputState?.permissionLevel === 'string') { return delta.v.inputState.permissionLevel; }
	if (delta?.kind === 1 && delta.k?.[0] === 'inputState' && delta.k?.[1] === 'permissionLevel' && typeof delta.v === 'string') { return delta.v; }
	return undefined;
}

/** Check if a selection range represents an actual selection (not just cursor position). */
function _asuCheckImplicitSelection(selections: unknown[], refs: ContextReferenceUsage): void {
	for (const sel of selections) {
		 
		const s = sel as any;
		if (s && (s.startLineNumber !== s.endLineNumber || s.startColumn !== s.endColumn)) {
			refs.implicitSelection++;
			break;
		}
	}
}

/** Handle VS Code incremental format kind=0 (session header) events. */
 
function _asuHandleKind0Event(event: any, analysis: SessionUsageAnalysis, modeState: AsuModeState): void {
	if (event.kind !== 0 || !event.v?.inputState?.mode) { return; }
	modeState.sessionMode = getModeType(event.v.inputState.mode);
	if (!Array.isArray(event.v?.inputState?.selections)) { return; }
	_asuCheckImplicitSelection(event.v.inputState.selections, analysis.contextReferences);
}

/** Handle VS Code incremental format kind=1 (incremental update) events. */
 
function _asuHandleKind1Event(event: any, analysis: SessionUsageAnalysis, modeState: AsuModeState): void {
	if (event.kind !== 1) { return; }
	if (event.k?.includes('mode') && event.v) { modeState.sessionMode = getModeType(event.v); }
	if (event.k?.includes('selections') && Array.isArray(event.v)) {
		_asuCheckImplicitSelection(event.v, analysis.contextReferences);
	}
	if (event.k?.includes('contentReferences') && Array.isArray(event.v)) {
		analyzeContentReferences(event.v, analysis.contextReferences);
	}
	if (event.k?.includes('variableData') && event.v) {
		analyzeVariableData(event.v, analysis.contextReferences);
	}
}

/** Extract the tool name from a response item. */
function _asuExtractToolName(item: ResponseItemRaw): string {
	return item.toolId || item.toolName || item.invocationMessage?.toolName || item.toolSpecificData?.kind || 'unknown';
}

/** Record tool invocations from a full response array (kind=2 with requests). */
function _asuProcessResponseItems(items: ResponseItemRaw[], analysis: SessionUsageAnalysis): void {
	for (const item of items) {
		if (!item) { continue; }
		if (item.kind === 'toolInvocationSerialized' || item.kind === 'prepareToolInvocation') {
			analysis.toolCalls.total++;
			const toolName = _asuExtractToolName(item);
			analysis.toolCalls.byTool[toolName] = (analysis.toolCalls.byTool[toolName] || 0) + 1;
		}
	}
}

/** Record tool invocations from a response update array (kind=2 with response). */
function _asuProcessResponseUpdates(items: unknown[], analysis: SessionUsageAnalysis): void {
	for (const responseItem of items) {
		const item = responseItem as ResponseItemRaw;
		if (!item) { continue; }
		if (item.kind === 'toolInvocationSerialized') {
			analysis.toolCalls.total++;
			const toolName = _asuExtractToolName(item);
			analysis.toolCalls.byTool[toolName] = (analysis.toolCalls.byTool[toolName] || 0) + 1;
		}
	}
}

/** Process a single request from a kind=2 requests array. */
 
function _asuProcessRequest(request: any, analysis: SessionUsageAnalysis, sessionMode: string): void {
	if (request.requestId) { incrementModeUsage(sessionMode, analysis.modeUsage); }
	if (request.agent?.id) {
		analysis.toolCalls.total++;
		analysis.toolCalls.byTool[request.agent.id] = (analysis.toolCalls.byTool[request.agent.id] || 0) + 1;
	}
	analyzeRequestContext(request, analysis.contextReferences);
	if (request.response && Array.isArray(request.response)) {
		_asuProcessResponseItems(request.response, analysis);
	}
}

/** Handle VS Code incremental format kind=2 (batch add) events. */
 
function _asuHandleKind2Event(event: any, analysis: SessionUsageAnalysis, modeState: AsuModeState, toolNameMap: { [key: string]: string }): void {
	if (event.kind !== 2) { return; }
	if (event.k?.[0] === 'requests' && Array.isArray(event.v)) {
		for (const request of event.v) {
			_asuProcessRequest(request, analysis, modeState.sessionMode);
		}
	}
	if (event.k?.includes('response') && Array.isArray(event.v)) {
		_asuProcessResponseUpdates(event.v, analysis);
	}
}

function _asuHandleSessionStartEvent(data: Record<string, unknown>, cliState: AsuCliState): void {
	if (typeof data.selectedModel === 'string') { cliState.defaultModel = data.selectedModel; }
	if (typeof data.reasoningEffort === 'string') { cliState.defaultEffort = data.reasoningEffort; }
}

function _asuHandleUserMessageMode(jetBrainsMode: JetBrainsMode | null, analysis: SessionUsageAnalysis): void {
	if (jetBrainsMode === 'agent') { analysis.modeUsage.agent++; }
	else if (jetBrainsMode === 'ask') { analysis.modeUsage.ask++; }
	else { analysis.modeUsage.cli++; }
}

/**
 * Analyze CLI user.message attachments (images pasted from clipboard and @file references).
 * Images arrive with a displayName ending in '-clipboard.png'.
 * File/code references attached via @filename arrive with displayName '<N> lines' (for code)
 * or as the bare filename (for non-image files like markdown docs).
 */
export function analyzeCliAttachments(attachments: unknown, refs: ContextReferenceUsage): void {
	if (!Array.isArray(attachments)) { return; }
	for (const att of attachments) {
		if (!att || typeof att !== 'object') { continue; }
		const displayName: unknown = (att as Record<string, unknown>)['displayName'];
		if (typeof displayName !== 'string') { continue; }
		if (/clipboard\.png$/i.test(displayName)) {
			// Clipboard image pasted into the CLI chat
			refs.byKind['copilot.image'] = (refs.byKind['copilot.image'] || 0) + 1;
		} else if (/^\d+ lines$/.test(displayName) || /\.[a-z0-9]+$/i.test(displayName)) {
			// @file reference: either 'N lines' (code file) or 'filename.ext' (doc/text file)
			refs.file++;
		}
	}
}

/**
 * Resolve a user-typed slash invocation from Copilot CLI's plain-text `user.message` content
 * (e.g. `/graphify`, `/chronicle standup`). Unlike Claude Code (which wraps explicit
 * invocations in `<command-message>`/`<command-name>` tags), Copilot CLI's raw command is
 * the literal message text — no wrapper. Deliberately agnostic (no allowlist), matching
 * any registered skill/command name, not just a hardcoded few.
 */
export function extractInvokedSkillNameFromPlainText(content: unknown): string | null {
	if (typeof content !== 'string') { return null; }
	const m = content.trim().match(/^\/([a-zA-Z0-9_-]+)(?:\s|$)/);
	return m ? m[1] : null;
}

function _asuCorrectionUserMessage(event: any): string | undefined {
	const content = event.data?.content;
	if (typeof content !== 'string') { return undefined; }
	const source = event.data?.source;
	const generated = (typeof source === 'string' && (source.startsWith('skill-') || source.startsWith('agent-')))
		|| /^\s*<(?:skill-context|cross_session_message|system_(?:notification|reminder))\b/i.test(content);
	return generated ? undefined : content;
}

/** Create the efficiency turn for a user.message event (with human text for correction detection). */
function _asuCreateEfficiencyTurn(event: any, cliState: AsuCliState): EfficiencyTurn {
	return {
		model: event.model || cliState.defaultModel,
		toolCalls: [],
		userMessage: _asuCorrectionUserMessage(event),
		timestamp: typeof event.timestamp === 'string' ? event.timestamp : null,
	};
}

/** Handle Copilot CLI events (session.start, session.model_change, user.message). */

function _asuProcessCliEvents(event: any, cliState: AsuCliState, analysis: SessionUsageAnalysis, jetBrainsMode: JetBrainsMode | null): void {
	if (event.type === 'session.start' && event.data) { _asuHandleSessionStartEvent(event.data as Record<string, unknown>, cliState); }
	if (event.type === 'session.model_change' && typeof event.data?.newModel === 'string') { cliState.defaultModel = event.data.newModel; }
	_asuAccumulateAssistantText(event, cliState);
	if (event.type === 'user.message') {
		cliState.requestCount++;
		const effort = typeof event.data?.reasoningEffort === 'string' ? event.data.reasoningEffort : cliState.defaultEffort;
		if (effort) { cliState.effortByRequest[effort] = (cliState.effortByRequest[effort] || 0) + 1; }
		cliState.efficiencyTurns.push(_asuCreateEfficiencyTurn(event, cliState));
		analyzeCliAttachments(event.data?.attachments, analysis.contextReferences);
		_asuHandleUserMessageMode(jetBrainsMode, analysis);
		recordAutonomy(analysis, event.data?.agentMode);
		const skillName = extractInvokedSkillNameFromPlainText(event.data?.content);
		if (skillName) { addSkillCall(analysis, skillName); }
	}
}

/** Accumulate assistant.message response text onto the current turn (correction detection only). */
function _asuAccumulateAssistantText(event: any, cliState: AsuCliState): void {
	if (event.type !== 'assistant.message') { return; }
	const content = event.data?.content;
	const turn = cliState.efficiencyTurns[cliState.efficiencyTurns.length - 1];
	if (typeof content === 'string' && content && turn) {
		turn.assistantResponse = (turn.assistantResponse ?? '') + content;
	}
}

function _asuExtractCliUserMessageText(event: any): string {
	if (typeof event?.data?.content === 'string' && event.data.content.trim()) { return event.data.content; }
	if (typeof event?.data?.message === 'string' && event.data.message.trim()) { return event.data.message; }
	if (typeof event?.content === 'string' && event.content.trim()) { return event.content; }
	return '';
}

function _asuExtractShellCommandFromArgs(args: unknown): string | undefined {
	if (!args || typeof args !== 'object') { return undefined; }
	const argObj = args as Record<string, unknown>;
	const keys = ['command', 'cmd', 'script'];
	for (const key of keys) {
		const val = argObj[key];
		if (typeof val === 'string' && val.trim()) { return val; }
	}
	return undefined;
}

function _asuCollectTaskTurnFromEvent(event: any, currentTurn: TaskTurnSignal | null, taskTurns: TaskTurnSignal[]): TaskTurnSignal | null {
	let nextTurn = currentTurn;
	if (event.type === 'user.message') {
		if (nextTurn) { taskTurns.push(nextTurn); }
		nextTurn = { messageText: _asuExtractCliUserMessageText(event), toolNames: [], shellCommands: [] };
	}
	if (event.type !== 'tool.call' && event.type !== 'tool.execution_start' && event.type !== 'tool.result') { return nextTurn; }
	const toolName = event.data?.toolName || event.toolName || 'unknown';
	if (!nextTurn) { nextTurn = { toolNames: [], shellCommands: [] }; }
	nextTurn.toolNames = nextTurn.toolNames ?? [];
	nextTurn.toolNames.push(toolName);
	const shellCmd = _asuExtractShellCommandFromArgs(event.data?.arguments);
	if (!shellCmd) { return nextTurn; }
	nextTurn.shellCommands = nextTurn.shellCommands ?? [];
	nextTurn.shellCommands.push(shellCmd);
	return nextTurn;
}

/** Handle tool.call / tool.result / tool.execution_start events. */

function _asuHandleToolCallEvent(event: any, analysis: SessionUsageAnalysis, toolNameMap: { [key: string]: string }): void {
	if (event.type !== 'tool.call' && event.type !== 'tool.result' && event.type !== 'tool.execution_start') { return; }
	// Events tagged with an MCP server are counted by _asuHandleMcpToolEvent only — never
	// here as well, otherwise one MCP call would land in both toolCalls and mcpTools.
	if (_asuEventMcpServerName(event)) { return; }
	const toolName = event.data?.toolName || event.toolName || 'unknown';
	recordToolOrMcpInvocation(toolName, analysis, toolNameMap);
	// Copilot CLI wraps autonomous skill invocations behind a generic "skill" tool call
	// (lowercase, unlike Claude Code's "Skill") — only tool.execution_start is confirmed to
	// carry `arguments.skill`; gate on that exact event type to avoid any risk of the other
	// two event types (tool.call/tool.result, an older/parallel schema) double-counting.
	if (event.type === 'tool.execution_start' && toolName === 'skill') {
		const skillName = event.data?.arguments?.skill;
		if (typeof skillName === 'string' && skillName.trim()) { addSkillCall(analysis, skillName.trim()); }
	}
}

/**
 * MCP server name an event is tagged with, or undefined for a non-MCP event.
 * Copilot CLI's `tool.execution_start` events for MCP tools carry `data.mcpServerName`
 * (plus `data.mcpToolName`) rather than `data.mcpServer`, and their `toolName` is
 * `<server>-<tool>` (e.g. `github-mcp-server-get_file_contents`), which `isMcpTool()`
 * does not recognise — so the server tag is the only reliable MCP signal there.
 */
function _asuEventMcpServerName(event: any): string | undefined {
	// First non-empty tag wins: a blank `mcpServer` must not mask a valid `mcpServerName`.
	for (const candidate of [event?.data?.mcpServer, event?.data?.mcpServerName]) {
		if (typeof candidate === 'string' && candidate.trim()) { return candidate.trim(); }
	}
	return undefined;
}

/** Handle mcp.tool.call events and events with data.mcpServer / data.mcpServerName set. */
 
function _asuHandleMcpToolEvent(event: any, analysis: SessionUsageAnalysis): void {
	const taggedServer = _asuEventMcpServerName(event);
	if (event.type !== 'mcp.tool.call' && !taggedServer) { return; }
	analysis.mcpTools.total++;
	const serverName = taggedServer || 'unknown';
	const mcpToolName = event.data?.toolName || event.toolName || 'unknown';
	analysis.mcpTools.byServer[serverName] = (analysis.mcpTools.byServer[serverName] || 0) + 1;
	const normalizedMcpTool = normalizeMcpToolName(mcpToolName);
	analysis.mcpTools.byTool[normalizedMcpTool] = (analysis.mcpTools.byTool[normalizedMcpTool] || 0) + 1;
}

/** Handle tool.call / tool.result / mcp.tool.call events. */
 
function _asuHandleToolAndMcpEvents(event: any, analysis: SessionUsageAnalysis, toolNameMap: { [key: string]: string }): void {
	_asuHandleToolCallEvent(event, analysis, toolNameMap);
	_asuHandleMcpToolEvent(event, analysis);
}

/** Count non-empty lines in text, ignoring a trailing newline. */
function _asuCountTextLines(text: string): number {
	if (!text) { return 0; }
	const lines = text.split('\n');
	if (lines[lines.length - 1] === '') { lines.pop(); }
	return lines.length;
}

/** Ensure editScope is initialized on the analysis object. */
function _asuEnsureEditScope(analysis: SessionUsageAnalysis): void {
	if (!analysis.editScope) {
		analysis.editScope = { singleFileEdits: 0, multiFileEdits: 0, totalEditedFiles: 0, avgFilesPerSession: 0, linesAdded: 0, linesRemoved: 0 };
	}
}

/** Handle tool.execution_start — stores pending tool call info for all tools (LOC + output token tracking). */
function _asuHandleToolStart(event: any, cliState: AsuCliState, toolNameMap: { [key: string]: string }): void {
	const { toolCallId, toolName, arguments: args } = event.data ?? {};
	if (toolCallId && toolName) {
		const effCall = _asuAppendEfficiencyToolCall(cliState, toolName, args);
		// An untagged start whose name isMcpTool() recognises (JetBrains, older Copilot CLI) was
		// counted under mcpTools by recordToolOrMcpInvocation; derive the same server here so its
		// completion is recorded against that server rather than under toolCalls.
		const mcpServerName = _asuEventMcpServerName(event)
			?? (isMcpTool(toolName) ? extractMcpServerName(toolName, toolNameMap) : undefined);
		cliState.pendingToolCalls.set(toolCallId, { toolName, args: args ?? {}, mcpServerName, effCall, startedAt: _asuEventEpochMs(event) });
	}
}

/** Parse an event's ISO timestamp to epoch ms, or undefined when absent/invalid. */
function _asuEventEpochMs(event: any): number | undefined {
	const ts = typeof event?.timestamp === 'string' ? Date.parse(event.timestamp) : NaN;
	return Number.isNaN(ts) ? undefined : ts;
}

/** Observed start→complete duration for a pending call, or undefined when either timestamp is missing. */
function _asuToolDurationMs(pending: AsuPendingToolCall, completeEvent: any): number | undefined {
	const completedAt = _asuEventEpochMs(completeEvent);
	if (pending.startedAt === undefined || completedAt === undefined) { return undefined; }
	const delta = completedAt - pending.startedAt;
	return delta >= 0 ? delta : undefined;
}

/** Extract LOC counts from a completed CLI tool call and update editScope. */
function _asuApplyToolLoc(pending: { toolName: string; args: Record<string, string> }, cliState: AsuCliState, analysis: SessionUsageAnalysis): void {
	const linesAdded = pending.toolName === 'edit'
		? _asuCountTextLines(pending.args.new_str ?? '')
		: _asuCountTextLines(pending.args.file_text ?? '');
	const linesRemoved = pending.toolName === 'edit' ? _asuCountTextLines(pending.args.old_str ?? '') : 0;
	_asuEnsureEditScope(analysis);
	analysis.editScope!.linesAdded = (analysis.editScope!.linesAdded ?? 0) + linesAdded;
	analysis.editScope!.linesRemoved = (analysis.editScope!.linesRemoved ?? 0) + linesRemoved;
	const filePath = pending.args.path ?? '';
	cliState.editedFilePaths.add(filePath);
	const ext = normalizeExtension(filePath);
	if (!analysis.editScope!.languageUsage) { analysis.editScope!.languageUsage = {}; }
	if (!analysis.editScope!.languageUsage[ext]) { analysis.editScope!.languageUsage[ext] = { linesAdded: 0, linesRemoved: 0 }; }
	analysis.editScope!.languageUsage[ext].linesAdded += linesAdded;
	analysis.editScope!.languageUsage[ext].linesRemoved += linesRemoved;
}

/**
 * Extract plain text from a tool result content value (string or content-block array).
 * Shared by the Copilot CLI path and the Claude-family adapters, whose `tool_result`
 * blocks use the same `string | {type:'text', text}[]` shape.
 */
export function extractToolResultText(content: unknown): string {
	if (typeof content === 'string') { return content; }
	if (Array.isArray(content)) {
		// Claude / Copilot CLI blocks carry `text`; JetBrains result blocks carry `value`.
		return content
			.filter((b: any) => b?.type === 'text' && (typeof b.text === 'string' || typeof b.value === 'string'))
			.map((b: any) => (typeof b.text === 'string' ? b.text : b.value) as string)
			.join('');
	}
	return '';
}

/**
 * Text of a `tool.execution_complete` result across the shapes the CLI family writes:
 * Copilot CLI's full output lives in `result.detailedContent` (preferred, as the token
 * estimator does) with `result.content` as the trimmed fallback; JetBrains puts typed
 * blocks in `result.result[]` with a `value` field. Empty string when none apply.
 */
export function extractToolExecutionResultText(result: unknown): string {
	if (!result || typeof result !== 'object') { return ''; }
	const r = result as Record<string, unknown>;
	if (typeof r.detailedContent === 'string' && r.detailedContent) { return r.detailedContent; }
	const fromContent = extractToolResultText(r.content);
	if (fromContent) { return fromContent; }
	return extractToolResultText(r.result);
}

/** Handle tool.execution_complete — applies LOC tracking for edit/create and counts output tokens for all non-MCP tools. */
function _asuHandleToolComplete(event: any, cliState: AsuCliState, analysis: SessionUsageAnalysis): void {
	const { toolCallId, success, result } = event.data ?? {};
	const pending = toolCallId ? cliState.pendingToolCalls.get(toolCallId) : undefined;
	if (toolCallId) { cliState.pendingToolCalls.delete(toolCallId); }
	if (!pending) { return; }
	_asuMarkEffCallError(pending, success);
	// Only an explicit boolean is an outcome; a missing flag (older schemas) keeps the call out of the
	// reliability denominator while its latency is still recorded.
	recordToolOutcome(analysis, pending.toolName, pending.mcpServerName, typeof success === 'boolean' ? success : undefined, _asuToolDurationMs(pending, event));
	if (success && (pending.toolName === 'edit' || pending.toolName === 'create')) {
		_asuApplyToolLoc(pending, cliState, analysis);
	}
	// Size result text only for calls with an explicit verdict: outputTokensByTool is divided by
	// completedByTool (cost-vs-speed map), so a verdict-less result must not join the numerator either.
	if (typeof success !== 'boolean' || pending.mcpServerName || isMcpTool(pending.toolName)) { return; }
	const resultText = extractToolExecutionResultText(result);
	if (!resultText) { return; }
	const tokens = estimateTokensFromText(resultText);
	if (!analysis.toolCalls.outputTokensByTool) { analysis.toolCalls.outputTokensByTool = {}; }
	analysis.toolCalls.outputTokensByTool[pending.toolName] = (analysis.toolCalls.outputTokensByTool[pending.toolName] || 0) + tokens;
}

/** Mark the efficiency tool call of a completed call as failed (correction detection). */
function _asuMarkEffCallError(pending: AsuPendingToolCall, success: unknown): void {
	if (success === false && pending.effCall) { pending.effCall.isError = true; }
}

/** Handle tool.execution_start / tool.execution_complete for CLI LOC tracking. */
function _asuHandleCliLocEvent(event: any, cliState: AsuCliState, analysis: SessionUsageAnalysis, toolNameMap: { [key: string]: string }): void {
	if (event.type === 'tool.execution_start') { _asuHandleToolStart(event, cliState, toolNameMap); }
	else if (event.type === 'tool.execution_complete') { _asuHandleToolComplete(event, cliState, analysis); }
}
/** Finalize editScope file counts from accumulated CLI tool LOC state. */
function _asuApplyCliLocToEditScope(cliState: AsuCliState, analysis: SessionUsageAnalysis): void {
	if (cliState.editedFilePaths.size === 0) { return; }
	_asuEnsureEditScope(analysis);
	const fileCount = cliState.editedFilePaths.size;
	analysis.editScope!.totalEditedFiles = fileCount;
	analysis.editScope!.singleFileEdits = fileCount === 1 ? 1 : 0;
	analysis.editScope!.multiFileEdits = fileCount > 1 ? 1 : 0;
	analysis.editScope!.avgFilesPerSession = fileCount;
}

/** Dispatch a single JSONL event to the appropriate event handlers. */
 
function _asuProcessJsonlEvent(event: any, analysis: SessionUsageAnalysis, modeState: AsuModeState, cliState: AsuCliState, jetBrainsMode: JetBrainsMode | null, toolNameMap: { [key: string]: string }): void {
	_asuHandleKind0Event(event, analysis, modeState);
	_asuHandleKind1Event(event, analysis, modeState);
	_asuHandleKind2Event(event, analysis, modeState, toolNameMap);
	_asuProcessCliEvents(event, cliState, analysis, jetBrainsMode);
	_asuHandleToolAndMcpEvents(event, analysis, toolNameMap);
	_asuHandleCliLocEvent(event, cliState, analysis, toolNameMap);
}

/** Store CLI thinking effort data from the accumulated CLI state. */
function _asuApplyCliThinkingEffort(cliState: AsuCliState, analysis: SessionUsageAnalysis): void {
	if (cliState.defaultEffort === null && Object.keys(cliState.effortByRequest).length === 0) { return; }
	const byEffort = Object.keys(cliState.effortByRequest).length > 0
		? cliState.effortByRequest
		: (cliState.defaultEffort !== null ? { [cliState.defaultEffort]: cliState.requestCount } : {});
	analysis.thinkingEffort = { byEffort, switchCount: 0, defaultEffort: cliState.defaultEffort };
}

/** Process a non-delta JSONL session file (Copilot CLI or VS Code incremental). */
async function _asuProcessNonDeltaJsonl(
	deps: UsageAnalysisDeps,
	sessionFile: string,
	lines: string[],
	fileContent: string,
	analysis: SessionUsageAnalysis
): Promise<void> {
	const taskTurns: TaskTurnSignal[] = [];
	const modeState: AsuModeState = { sessionMode: 'ask' };
	const cliState: AsuCliState = {
		defaultModel: 'unknown', defaultEffort: null, requestCount: 0, effortByRequest: {},
		pendingToolCalls: new Map(), editedFilePaths: new Set(), efficiencyTurns: [],
	};
	const isJetBrains = isJetBrainsSessionPath(sessionFile);
	const jetBrainsMode: JetBrainsMode | null = isJetBrains ? detectJetBrainsModeFromContent(fileContent) : null;
	let currentTurn: TaskTurnSignal | null = null;

	for (const line of lines) {
		if (!line.trim()) { continue; }
		try {
			const event = JSON.parse(line);
			currentTurn = _asuCollectTaskTurnFromEvent(event, currentTurn, taskTurns);
			_asuProcessJsonlEvent(event, analysis, modeState, cliState, jetBrainsMode, deps.toolNameMap);
		} catch { /* skip malformed lines */ }
	}
	if (currentTurn) { taskTurns.push(currentTurn); }

	_asuApplyCliLocToEditScope(cliState, analysis);
	_asuApplyCliThinkingEffort(cliState, analysis);
	_asuFinalizeTaskClassification(analysis, taskTurns);
	if (cliState.efficiencyTurns.length > 0) {
		analysis.modelEfficiency = computeEfficiencyFromTurns(cliState.efficiencyTurns);
		_setFirstUserPrompt(analysis, cliState.efficiencyTurns.find(t => t.userMessage)?.userMessage);
		_setCorrectionDetection(analysis, cliState.efficiencyTurns);
	}
	await calculateModelSwitching(deps, sessionFile, analysis, fileContent);
	// Track LOC/edit metrics for CLI sessions (delta path already handles this above)
	await trackEnhancedMetrics(deps, sessionFile, analysis, fileContent);
	deriveConversationPatterns(analysis);
}

async function _asuProcessJsonlUsage(
	deps: UsageAnalysisDeps,
	sessionFile: string,
	fileContent: string,
	analysis: SessionUsageAnalysis
): Promise<void> {
	const lines = fileContent.trim().split('\n').filter((l: string) => l.trim());
	if (_asuIsDeltaBased(lines)) {
		_asuReconstructAndProcessDeltaState(deps, lines, analysis);
		await trackEnhancedMetrics(deps, sessionFile, analysis, fileContent);
		if (!analysis.taskClassification) { analysis.taskClassification = createEmptyTaskClassificationResult(); }
		return;
	}
	await _asuProcessNonDeltaJsonl(deps, sessionFile, lines, fileContent, analysis);
}

async function _asuProcessJsonUsage(
	deps: UsageAnalysisDeps,
	sessionFile: string,
	fileContent: string,
	preloadedParsedJson: unknown,
	analysis: SessionUsageAnalysis
): Promise<void> {
	const parsed: unknown = preloadedParsedJson !== undefined ? preloadedParsedJson : JSON.parse(fileContent);
	if (!isParsedSessionJson(parsed)) {
		deps.warn(`Unexpected session format in ${sessionFile}`);
		return;
	}
	processJsonSessionRequests(deps, parsed, analysis);
	await calculateModelSwitching(deps, sessionFile, analysis, fileContent, preloadedParsedJson);
	await trackEnhancedMetrics(deps, sessionFile, analysis, fileContent, preloadedParsedJson);
}

/**
 * Compute model efficiency counters (issue #1649) for an ecosystem adapter's
 * session from its buildTurns output, unless the adapter's analyzeUsage
 * already provided them. Efficiency is optional — never fail analysis over it.
 */
async function _addTurnEfficiencyFromAdapter(eco: IEcosystemAdapter, sessionFile: string, analysis: SessionUsageAnalysis): Promise<void> {
	if (analysis.modelEfficiency && analysis.correctionMoments && analysis.correctionCounts && analysis.firstUserPrompt) { return; }
	if (!eco.buildTurns) { return; }
	try {
		const { turns } = await eco.buildTurns(sessionFile);
		if (!analysis.modelEfficiency) {
			const eff = computeEfficiencyFromTurns(turns);
			if (Object.keys(eff).length > 0) { analysis.modelEfficiency = eff; }
		}
		if (!analysis.correctionMoments) {
			_setCorrectionDetection(analysis, turns);
		}
		_setFirstUserPrompt(analysis, turns.find(t => t.userMessage)?.userMessage);
	} catch { /* efficiency and correction moments are optional */ }
}

/**
 * Copilot CLI sessions started via the Copilot desktop app record
 * `client_name: github/autopilot` in the workspace.yaml sitting next to their
 * events.jsonl. Break those interactions out of `modeUsage.cli` into
 * `modeUsage.cliApp` so views can distinguish app-hosted sessions from plain
 * terminal CLI usage. Runs after conversation patterns are derived so the
 * per-session turn totals are unaffected by the split.
 *
 * Scoped to Copilot CLI session-state paths only: other JSONL ecosystems
 * (Claude Code, OpenCode, …) never carry a workspace.yaml, and probing for one
 * would log noisy open errors via readTextFileWithSizeGuard.
 */
async function _asuApplyCopilotAppSplit(sessionFile: string, analysis: SessionUsageAnalysis): Promise<void> {
	if (analysis.modeUsage.cli === 0 || !isCopilotCliSessionPath(sessionFile)) { return; }
	const yamlPath = path.join(path.dirname(sessionFile), 'workspace.yaml');
	if (!await pathExists(yamlPath)) { return; }
	const content = await readTextFileWithSizeGuard(yamlPath, 'usageAnalysis');
	if (content === undefined) { return; }
	const clientMatch = content.match(/^client_name:\s*(.+)$/m);
	if (clientMatch && isCopilotAppClientName(clientMatch[1].trim())) {
		analysis.modeUsage.cliApp = analysis.modeUsage.cli;
		analysis.modeUsage.cli = 0;
	}
}

/**
 * Analyze a session file for usage patterns (tool calls, modes, context references, MCP tools)
 */
export async function analyzeSessionUsage(deps: UsageAnalysisDeps, sessionFile: string, preloadedContent?: string, preloadedParsedJson?: unknown): Promise<SessionUsageAnalysis> {
	const analysis: SessionUsageAnalysis = createEmptySessionUsageAnalysis();

	try {
		const eco = deps.ecosystems.find(e => e.handles(sessionFile));
		if (eco && isAnalyzable(eco)) {
			const result = await eco.analyzeUsage(sessionFile, { modelPricing: deps.modelPricing, toolNameMap: deps.toolNameMap });
			if (!result.taskClassification) { result.taskClassification = createEmptyTaskClassificationResult(); }
			await _addTurnEfficiencyFromAdapter(eco, sessionFile, result);
			return result;
		}
		if (sessionFile.startsWith('windsurf://') || sessionFile.startsWith('devin://')) {
			analysis.taskClassification = createEmptyTaskClassificationResult();
			return analysis;
		}

		const fileContent = preloadedContent ?? await fs.promises.readFile(sessionFile, 'utf8');
		const isJsonl = sessionFile.endsWith('.jsonl') || isJsonlContent(fileContent);

		if (isJsonl) {
			await _asuProcessJsonlUsage(deps, sessionFile, fileContent, analysis);
		} else {
			await _asuProcessJsonUsage(deps, sessionFile, fileContent, preloadedParsedJson, analysis);
		}
	} catch (error) {
		deps.warn(`Error analyzing session usage from ${sessionFile}: ${error}`);
	}
	if (!analysis.taskClassification) { analysis.taskClassification = createEmptyTaskClassificationResult(); }

	await _asuApplyCopilotAppSplit(sessionFile, analysis);
	return analysis;
}

/**
 * Try to extract exact token usage from a session request result,
 * checking all known storage formats (OLD, NEW, INSIDERS).
 * Returns true if tokens were extracted; false if text-based estimation is needed.
 */
function tryExtractExactTokenUsage(
	request: SessionRequestRaw,
	model: string,
	modelUsage: ModelUsage
): boolean {
	if (request.result?.usage) {
		// OLD FORMAT (pre-Feb 2026)
		const u = request.result.usage;
		modelUsage[model].inputTokens += typeof u.promptTokens === 'number' ? u.promptTokens : 0;
		modelUsage[model].outputTokens += typeof u.completionTokens === 'number' ? u.completionTokens : 0;
		return true;
	}
	if (typeof request.result?.promptTokens === 'number' && typeof request.result?.outputTokens === 'number') {
		// NEW FORMAT (Feb 2026+)
		modelUsage[model].inputTokens += request.result.promptTokens;
		modelUsage[model].outputTokens += request.result.outputTokens;
		return true;
	}
	if (request.result?.metadata && typeof request.result.metadata.promptTokens === 'number' && typeof request.result.metadata.outputTokens === 'number') {
		// INSIDERS FORMAT (Feb 2026+): Tokens nested under result.metadata
		modelUsage[model].inputTokens += request.result.metadata.promptTokens;
		modelUsage[model].outputTokens += request.result.metadata.outputTokens;
		return true;
	}
	return false;
}

/**
 * Accumulate sub-agent token usage from a response item array into modelUsage.
 * Sub-agent invocations are additive (not included in parent token counts).
 */
function accumulateSubAgentTokenUsage(
	responseItems: ResponseItemRaw[],
	baseModel: string,
	modelUsage: ModelUsage,
	tokenEstimators: Record<string, TokenEstimator>
): void {
	for (const responseItem of responseItems) {
		const subAgent = extractSubAgentData(responseItem);
		if (subAgent) {
			const saModel = subAgent.modelName || baseModel;
			// Untrusted `modelName` string from parsed session JSON — see protoGuard.ts.
			if (isUnsafeObjectKey(saModel)) { continue; }
			if (!modelUsage[saModel]) { modelUsage[saModel] = { inputTokens: 0, outputTokens: 0, sessions: 0 }; }
			if (subAgent.prompt) { modelUsage[saModel].inputTokens += estimateTokensFromText(subAgent.prompt, saModel, tokenEstimators); }
			if (subAgent.result) { modelUsage[saModel].outputTokens += estimateTokensFromText(subAgent.result, saModel, tokenEstimators); }
		}
	}
}

type GmusDeps = Pick<UsageAnalysisDeps, 'warn' | 'tokenEstimators' | 'modelPricing'>;

type GmusJsonlState = {
	defaultModel: string;
	isDeltaBased: boolean;
	sessionState: DeltaSessionState;
	cliShutdownModelUsage: ModelUsage | null;
	cliRealOutputByModel: { [model: string]: number } | null;
	totalCliToolCalls: number;
};

type CliShutdownMetricsEntry = { usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number } };

function _gmusApplyMetricEntry(modelName: string, usage: NonNullable<CliShutdownMetricsEntry['usage']>, dest: ModelUsage): void {
	// Untrusted `modelName` key from a parsed modelMetrics JSON object (JSON.parse
	// creates own "__proto__" properties, so Object.entries can yield it) — see protoGuard.ts.
	if (isUnsafeObjectKey(modelName)) { return; }
	if (!dest[modelName]) { dest[modelName] = { inputTokens: 0, outputTokens: 0, sessions: 0 }; }
	dest[modelName].inputTokens += typeof usage.inputTokens === 'number' ? usage.inputTokens : 0;
	dest[modelName].outputTokens += typeof usage.outputTokens === 'number' ? usage.outputTokens : 0;
	const cacheRead = typeof usage.cacheReadTokens === 'number' ? usage.cacheReadTokens : 0;
	const cacheWrite = typeof usage.cacheWriteTokens === 'number' ? usage.cacheWriteTokens : 0;
	if (cacheRead > 0) { dest[modelName].cachedReadTokens = (dest[modelName].cachedReadTokens ?? 0) + cacheRead; }
	if (cacheWrite > 0) { dest[modelName].cacheCreationTokens = (dest[modelName].cacheCreationTokens ?? 0) + cacheWrite; }
}

/** Accumulate per-model token data from a session.shutdown modelMetrics block. */
function _gmusProcessCliShutdownMetrics(
	modelMetrics: Record<string, CliShutdownMetricsEntry>,
	cliShutdownModelUsage: ModelUsage
): void {
	for (const [modelName, metrics] of Object.entries(modelMetrics)) {
		if (!metrics?.usage) { continue; }
		_gmusApplyMetricEntry(modelName, metrics.usage, cliShutdownModelUsage);
	}
}

/** Handle an assistant.message event, recording real or estimated output tokens. */
 
function _gmusHandleAssistantMessage(event: any, model: string, state: GmusJsonlState, modelUsage: ModelUsage, deps: GmusDeps): void {
	const realOutput = typeof event.data?.outputTokens === 'number' ? event.data.outputTokens : 0;
	if (realOutput > 0) {
		if (!state.cliRealOutputByModel) { state.cliRealOutputByModel = {}; }
		state.cliRealOutputByModel[model] = (state.cliRealOutputByModel[model] ?? 0) + realOutput;
	} else if (event.data?.content) {
		modelUsage[model].outputTokens += estimateTokensFromText(event.data.content, model, deps.tokenEstimators);
	}
}

/** Handle a session.shutdown event, accumulating CLI shutdown model metrics into state. */
 
function _gmusHandleShutdownEvent(event: any, state: GmusJsonlState): void {
	if (!event.data?.modelMetrics) { return; }
	if (!state.cliShutdownModelUsage) { state.cliShutdownModelUsage = {}; }
	_gmusProcessCliShutdownMetrics(event.data.modelMetrics as Record<string, CliShutdownMetricsEntry>, state.cliShutdownModelUsage);
}

/** Dispatch a CLI-format JSONL event to the appropriate token accumulation handler. */
 
function _gmusProcessCliEventLine(event: any, model: string, state: GmusJsonlState, modelUsage: ModelUsage, deps: GmusDeps): void {
	if (event.type === 'session.shutdown') {
		_gmusHandleShutdownEvent(event, state);
	} else if (event.type === 'user.message' && event.data?.content) {
		modelUsage[model].inputTokens += estimateTokensFromText(event.data.content, model, deps.tokenEstimators);
	} else if (event.type === 'assistant.message') {
		_gmusHandleAssistantMessage(event, model, state, modelUsage, deps);
	} else if (event.type === 'tool.execution_start') {
		state.totalCliToolCalls++;
	} else if (event.type === 'tool.execution_complete') {
		const toolContent = event.data?.result?.content || event.data?.result?.detailedContent;
		if (toolContent) { modelUsage[model].inputTokens += estimateTokensFromText(String(toolContent), model, deps.tokenEstimators); }
	}
}

/** Extract the model identifier from a kind-0 (session header) delta event, or null if absent. */
 
function _gmusExtractKind0Model(event: any): string | null {
	if (event.kind !== 0) { return null; }
	return event.v?.selectedModel?.identifier || event.v?.selectedModel?.metadata?.id || event.v?.inputState?.selectedModel?.metadata?.id || null;
}

/** Extract the model identifier from a kind-2 selectedModel update event, or null if absent. */
 
function _gmusExtractKind2Model(event: any): string | null {
	if (event.kind !== 2 || event.k?.[0] !== 'selectedModel') { return null; }
	return event.v?.identifier || event.v?.metadata?.id || null;
}

/** Update the default model tracked in state based on model-selection events. */
 
function _gmusUpdateDefaultModelFromEvent(event: any, state: GmusJsonlState): void {
	if (event.type === 'session.start' && typeof event.data?.selectedModel === 'string') {
		state.defaultModel = event.data.selectedModel;
		return;
	}
	if (event.type === 'session.model_change' && typeof event.data?.newModel === 'string') {
		state.defaultModel = event.data.newModel;
		return;
	}
	const kind0Model = _gmusExtractKind0Model(event);
	if (kind0Model) { state.defaultModel = kind0Model.replace(/^copilot\//, ''); }
	const kind2Model = _gmusExtractKind2Model(event);
	if (kind2Model) { state.defaultModel = kind2Model.replace(/^copilot\//, ''); }
}

/** Process a single parsed JSONL event, updating state and model usage. */
 
function _gmusProcessJsonlLine(event: any, state: GmusJsonlState, modelUsage: ModelUsage, deps: GmusDeps): void {
	if (typeof event.kind === 'number') {
		state.isDeltaBased = true;
		state.sessionState = applyDelta(state.sessionState, event) as DeltaSessionState;
	}
	_gmusUpdateDefaultModelFromEvent(event, state);
	const model = event.data?.model || event.model || state.defaultModel;
	// Untrusted `model` string from parsed session JSONL — see protoGuard.ts.
	if (isUnsafeObjectKey(model)) { return; }
	if (!modelUsage[model]) { modelUsage[model] = { inputTokens: 0, outputTokens: 0, sessions: 0 }; }
	if (!state.isDeltaBased) { _gmusProcessCliEventLine(event, model, state, modelUsage, deps); }
}

/** Parse all JSONL lines into accumulated state and model usage. Returns the session state. */
function _gmusParseJsonlLines(lines: string[], modelUsage: ModelUsage, deps: GmusDeps): GmusJsonlState {
	const state: GmusJsonlState = {
		defaultModel: 'unknown', isDeltaBased: false, sessionState: {},
		cliShutdownModelUsage: null, cliRealOutputByModel: null, totalCliToolCalls: 0
	};
	for (const line of lines) {
		if (!line.trim()) { continue; }
		try {
			 
			const event: any = JSON.parse(line);
			_gmusProcessJsonlLine(event, state, modelUsage, deps);
		} catch { /* skip malformed lines */ }
	}
	return state;
}

/** Estimate token counts for a delta request by parsing message text and response content. */
function _gmusEstimateDeltaRequestTokens(request: SessionRequestRaw, requestModel: string, modelUsage: ModelUsage, deps: GmusDeps): void {
	if (request.message?.text) {
		modelUsage[requestModel].inputTokens += estimateTokensFromText(request.message.text, requestModel, deps.tokenEstimators);
	}
	if (request.response && Array.isArray(request.response)) {
		for (const responseItem of request.response as ResponseItemRaw[]) {
			const { text } = extractResponseItemText(responseItem);
			if (text) { modelUsage[requestModel].outputTokens += estimateTokensFromText(text, requestModel, deps.tokenEstimators); }
		}
	}
}

/** Process a single delta-format request, extracting or estimating token usage. */
function _gmusProcessDeltaRequest(request: SessionRequestRaw, defaultModel: string, modelUsage: ModelUsage, deps: GmusDeps): void {
	if (!request.requestId) { return; }
	const requestModel = getModelFromRequest(request, deps.modelPricing, defaultModel);
	// Untrusted `modelId` string from parsed session JSON — see protoGuard.ts.
	if (isUnsafeObjectKey(requestModel)) { return; }
	if (!modelUsage[requestModel]) { modelUsage[requestModel] = { inputTokens: 0, outputTokens: 0, sessions: 0 }; }
	const before = { ...modelUsage[requestModel] };
	if (!tryExtractExactTokenUsage(request, requestModel, modelUsage)) {
		_gmusEstimateDeltaRequestTokens(request, requestModel, modelUsage, deps);
	}
	recordAutoRequestUsage(request, modelUsage[requestModel], before);
	if (request.response && Array.isArray(request.response)) {
		accumulateSubAgentTokenUsage(request.response as ResponseItemRaw[], requestModel, modelUsage, deps.tokenEstimators);
	}
}

/** Iterate and process all delta-based requests from reconstructed session state. */
function _gmusProcessDeltaRequests(state: GmusJsonlState, modelUsage: ModelUsage, deps: GmusDeps): void {
	if (!state.isDeltaBased || !state.sessionState.requests || !Array.isArray(state.sessionState.requests)) { return; }
	for (const requestRaw of state.sessionState.requests) {
		if (!requestRaw) { continue; }
		_gmusProcessDeltaRequest(requestRaw as SessionRequestRaw, state.defaultModel, modelUsage, deps);
	}
}

/** Apply regex-based fallback extraction to fill in any requests that reconstruction missed. */
function _gmusDeltaFallbackExtraction(lines: string[], state: GmusJsonlState, modelUsage: ModelUsage, deps: GmusDeps): void {
	const rawModelUsage = extractPerRequestUsageFromRawLines(lines);
	for (const [reqIdx, extracted] of rawModelUsage) {
		const request = state.sessionState.requests?.[reqIdx] as SessionRequestRaw | undefined;
		if (!request) { continue; }
		if (request.result?.usage || (typeof request.result?.promptTokens === 'number') || (request.result?.metadata && typeof request.result.metadata.promptTokens === 'number')) { continue; }
		const requestModel = getModelFromRequest(request, deps.modelPricing, state.defaultModel);
		// Untrusted `modelId` string from parsed session JSON — see protoGuard.ts.
		if (isUnsafeObjectKey(requestModel)) { continue; }
		if (!modelUsage[requestModel]) { modelUsage[requestModel] = { inputTokens: 0, outputTokens: 0, sessions: 0 }; }
		const before = { ...modelUsage[requestModel] };
		modelUsage[requestModel].inputTokens += extracted.promptTokens;
		modelUsage[requestModel].outputTokens += extracted.outputTokens;
		recordAutoRequestUsage(request, modelUsage[requestModel], before);
	}
}

/** Build estimated model usage for sessions using per-turn real output without a shutdown event. */
function _gmusBuildEstimatedCliUsage(state: GmusJsonlState, modelUsage: ModelUsage): ModelUsage {
	const numTurns = Math.max(1, Math.round(state.totalCliToolCalls / 2));
	const contextFactor = Math.max(1, (numTurns + 1) / 2);
	const estimatedUsage: ModelUsage = {};
	for (const [m, realOutput] of Object.entries(state.cliRealOutputByModel!)) {
		const accumulatedInput = modelUsage[m]?.inputTokens ?? 0;
		estimatedUsage[m] = { inputTokens: Math.round(accumulatedInput * contextFactor), outputTokens: realOutput, sessions: 0 };
	}
	return estimatedUsage;
}

/** Process all JSONL lines and return resolved model usage, or null to use accumulated modelUsage. */
function _gmusProcessJsonlContent(lines: string[], modelUsage: ModelUsage, deps: GmusDeps): ModelUsage | null {
	const state = _gmusParseJsonlLines(lines, modelUsage, deps);
	if (!state.isDeltaBased && state.cliShutdownModelUsage) { return state.cliShutdownModelUsage; }
	if (!state.isDeltaBased && state.cliRealOutputByModel) { return _gmusBuildEstimatedCliUsage(state, modelUsage); }
	_gmusProcessDeltaRequests(state, modelUsage, deps);
	_gmusDeltaFallbackExtraction(lines, state, modelUsage, deps);
	return null;
}

/** Estimate input/output tokens for a JSON-format request from message text and response content. */
function _gmusProcessJsonRequestEstimate(request: SessionRequestRaw, model: string, modelUsage: ModelUsage, deps: GmusDeps): void {
	if (request.message?.parts) {
		for (const part of request.message.parts) {
			if (part.text) { modelUsage[model].inputTokens += estimateTokensFromText(part.text, model, deps.tokenEstimators); }
		}
	}
	if (request.response && Array.isArray(request.response)) {
		for (const responseItem of request.response as ResponseItemRaw[]) {
			const { text } = extractResponseItemText(responseItem);
			if (text) { modelUsage[model].outputTokens += estimateTokensFromText(text, model, deps.tokenEstimators); }
		}
	}
}

/** Record the parent's eligible token delta before adding any sub-agent usage. */
function recordAutoRequestUsage(request: SessionRequestRaw, usage: ModelUsage[string], before: ModelUsage[string]): void {
	if (!isCopilotAutoRequest(request)) { return; }
	usage.autoRouting = {
		inputTokens: (usage.autoRouting?.inputTokens ?? 0) + usage.inputTokens - before.inputTokens,
		outputTokens: (usage.autoRouting?.outputTokens ?? 0) + usage.outputTokens - before.outputTokens,
	};
}

/** Process a single JSON-format session request, accumulating its token usage. */
function _gmusProcessJsonRequest(request: SessionRequestRaw, modelUsage: ModelUsage, deps: GmusDeps): void {
	const model = getModelFromRequest(request, deps.modelPricing);
	// Untrusted `model` string from parsed session JSON — see protoGuard.ts.
	if (isUnsafeObjectKey(model)) { return; }
	if (!modelUsage[model]) { modelUsage[model] = { inputTokens: 0, outputTokens: 0, sessions: 0 }; }
	const before = { ...modelUsage[model] };
	if (!tryExtractExactTokenUsage(request, model, modelUsage)) { _gmusProcessJsonRequestEstimate(request, model, modelUsage, deps); }
	recordAutoRequestUsage(request, modelUsage[model], before);
	if (request.response && Array.isArray(request.response)) {
		accumulateSubAgentTokenUsage(request.response as ResponseItemRaw[], model, modelUsage, deps.tokenEstimators);
	}
}

/** Iterate and process all requests from a parsed JSON session file. */
function _gmusProcessJsonRequests(sessionContent: ParsedSessionJson, modelUsage: ModelUsage, deps: GmusDeps): void {
	if (!sessionContent.requests || !Array.isArray(sessionContent.requests)) { return; }
	for (const requestRaw of sessionContent.requests) {
		_gmusProcessJsonRequest(requestRaw as SessionRequestRaw, modelUsage, deps);
	}
}

/** Resolve model usage for a JSONL-format session, preferring exact billing usage when available. */
async function _gmusResolveJsonl(sessionFile: string, fileContent: string, modelUsage: ModelUsage, deps: GmusDeps): Promise<ModelUsage> {
	// Copilot CLI events.jsonl: prefer exact per-model usage from the
	// session-store.db assistant_usage_events billing table, falling back to the
	// opt-in OpenTelemetry file export and finally the ratio-based estimate below.
	if (extractCopilotCliSessionId(sessionFile)) {
		const exact = await getCopilotCliExactUsage(sessionFile);
		if (exact && Object.keys(exact.modelUsage).length > 0) { return exact.modelUsage; }
	}
	const lines = fileContent.trim().split('\n');
	const result = _gmusProcessJsonlContent(lines, modelUsage, deps);
	return result ?? modelUsage;
}

/** Resolve model usage from a session file's content, dispatching by format. */
async function _gmusResolveFromContent(sessionFile: string, fileContent: string, modelUsage: ModelUsage, deps: GmusDeps, preloadedParsedJson?: unknown): Promise<ModelUsage> {
	if (isUuidPointerFile(fileContent)) { return modelUsage; }
	const isJsonl = sessionFile.endsWith('.jsonl') || isJsonlContent(fileContent);
	if (isJsonl) {
		return _gmusResolveJsonl(sessionFile, fileContent, modelUsage, deps);
	}
	const parsed: unknown = preloadedParsedJson !== undefined ? preloadedParsedJson : JSON.parse(fileContent);
	if (!isParsedSessionJson(parsed)) { deps.warn(`Unexpected session format in ${sessionFile}`); return modelUsage; }
	_gmusProcessJsonRequests(parsed, modelUsage, deps);
	return modelUsage;
}

export async function getModelUsageFromSession(deps: Pick<UsageAnalysisDeps, 'warn' | 'tokenEstimators' | 'modelPricing' | 'ecosystems'>, sessionFile: string, preloadedContent?: string, preloadedParsedJson?: unknown): Promise<ModelUsage> {
	const modelUsage: ModelUsage = {};
	if (deps.ecosystems) {
		const eco = deps.ecosystems.find(e => e.handles(sessionFile));
		if (eco) { return eco.getModelUsage(sessionFile); }
	}
	if (sessionFile.startsWith('windsurf://') || sessionFile.startsWith('devin://')) {
		return modelUsage;
	}
	try {
		const fileContent = preloadedContent ?? await fs.promises.readFile(sessionFile, 'utf8');
		return await _gmusResolveFromContent(sessionFile, fileContent, modelUsage, deps, preloadedParsedJson);
	} catch (error) {
		deps.warn(`Error getting model usage from ${sessionFile}: ${error}`);
	}
	return modelUsage;
}
