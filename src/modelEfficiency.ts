/**
 * Model Efficiency analysis module (issue #1649).
 *
 * Computes per-model efficiency metrics — one-shot rate, retry rate,
 * self-correction rate, cost per call, cost per edit, output tokens per call,
 * cache hit rate — from structured per-turn tool-call data, inspired by
 * codeburn's model efficiency report.
 *
 * Definitions (heuristics, documented so they stay comparable across editors):
 * - "call"            = one user-request turn. One agentic turn may span multiple
 *                       underlying API requests; the user turn is the closest unit
 *                       available consistently across all supported editors.
 * - "edit turn"       = a turn containing at least one file-edit tool call.
 * - "retry"           = a repeat edit call to a file whose *immediately preceding*
 *                       tool call was an edit to the same file (a failed edit
 *                       retried right away, e.g. old-string mismatch).
 * - "self-correction" = a repeat edit to a file already edited earlier in the same
 *                       turn, with other tool calls in between (the model ran
 *                       something, saw a problem, and went back to fix its edit).
 * - "one-shot"        = an edit turn with no retries and no self-corrections.
 *
 * This module is intentionally pure (no VS Code API, no filesystem access) so it
 * can be unit-tested with mocked data and reused by the CLI and the webview.
 */
import type { DailyModelEfficiency, DailyModelEfficiencyEntry, DailyTokenStats, ModelEfficiencyCounters, ModelEfficiencyUsage, ModelPricing, ModelUsage, SessionFileCache } from './types';
import { calculateEstimatedCost } from './tokenEstimation';
import { addModelUsage } from './statsHelpers';
import { isUnsafeObjectKey } from './utils/protoGuard';

// ---------------------------------------------------------------------------
// Edit-tool detection
// ---------------------------------------------------------------------------

/**
 * Known file-edit tool names across all supported editors, lowercased.
 * Covers Copilot Chat/CLI, Claude Code, Cline, Gemini CLI, OpenCode, Crush,
 * Codex CLI, Kiro, and Windsurf. Read-only and terminal tools are deliberately
 * excluded — only tools that write file content count as edits.
 */
const EDIT_TOOL_NAMES = new Set([
	// Copilot CLI / OpenCode / Crush
	'edit', 'create', 'write', 'patch', 'multiedit',
	// Claude Code (lowercased)
	'notebookedit',
	// Copilot Chat / VS Code
	'editfiles', 'edit_files', 'edit_file', 'apply_patch', 'applypatch',
	'create_file', 'createfile', 'write_file', 'writefile',
	'insert_edit_into_file', 'insertedit', 'replace_string_in_file', 'replacestring',
	'edit_notebook_file', 'editnotebook', 'str_replace_editor', 'str_replace',
	'copilot_editfiles', 'copilot_editfile', 'copilot_writefile', 'copilot_applypatch',
	'copilot_createfile', 'copilot_insertedit', 'copilot_replacestring', 'copilot_editnotebook',
	// Cline
	'write_to_file', 'replace_in_file', 'apply_diff',
	// Gemini CLI
	'replace',
	// Kiro
	'fswrite', 'fsappend', 'strreplace',
	// Windsurf
	'windsurf_file_edit', 'windsurf_file_create',
]);

/** Returns true when the (raw) tool name is a known file-edit tool. */
export function isEditToolName(toolName: string): boolean {
	return EDIT_TOOL_NAMES.has(toolName.toLowerCase());
}

/** Argument keys that carry the target file path across the supported editors. */
const FILE_PATH_ARG_KEYS = [
	'file_path', 'filePath', 'path', 'absolute_path', 'absolutePath',
	'target_file', 'targetFile', 'file', 'filename', 'fileName', 'notebook_path',
];

/**
 * Extract the target file path from a tool call's JSON-serialized arguments.
 * Returns null when the arguments are missing, unparsable, or carry no
 * recognizable path key.
 */
export function extractEditFilePath(argumentsJson: string | undefined): string | null {
	if (!argumentsJson) { return null; }
	let args: unknown;
	try { args = JSON.parse(argumentsJson); } catch { return null; }
	if (!args || typeof args !== 'object') { return null; }
	const obj = args as Record<string, unknown>;
	for (const key of FILE_PATH_ARG_KEYS) {
		const value = obj[key];
		if (typeof value === 'string' && value) { return value; }
	}
	// VS Code-style uri objects: { uri: { path: '/...' } } or { uri: { fsPath: '...' } }
	const uri = obj.uri;
	if (uri && typeof uri === 'object') {
		const uriObj = uri as Record<string, unknown>;
		if (typeof uriObj.fsPath === 'string' && uriObj.fsPath) { return uriObj.fsPath; }
		if (typeof uriObj.path === 'string' && uriObj.path) { return uriObj.path; }
	}
	return null;
}

// ---------------------------------------------------------------------------
// Counter computation from turn data
// ---------------------------------------------------------------------------

/**
 * Minimal structural view of a chat turn needed for efficiency analysis.
 * `ChatTurn` from types.ts satisfies this shape.
 *
 * The optional message/timestamp/isError fields are not used by the efficiency
 * counters themselves — they are populated where the format provides them so
 * the same turn list can be fed to correctionDetection.detectCorrectionMoments.
 */
export interface EfficiencyTurn {
	model: string | null;
	toolCalls: { toolName: string; arguments?: string; result?: string; isError?: boolean }[];
	/** Raw user message text (correction detection only). */
	userMessage?: string;
	/** Raw assistant response text (correction detection only). */
	assistantResponse?: string;
	/** Turn timestamp (correction detection only). */
	timestamp?: string | null;
}

export function createEmptyModelEfficiencyCounters(): ModelEfficiencyCounters {
	return {
		calls: 0, toolCalls: 0, editTurns: 0, oneShotEditTurns: 0, retries: 0, selfCorrections: 0,
		editToolCalls: 0, inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cost: 0,
	};
}

function ensureCounters(eff: ModelEfficiencyUsage, model: string): ModelEfficiencyCounters {
	if (!eff[model]) { eff[model] = createEmptyModelEfficiencyCounters(); }
	return eff[model];
}

/** Analyze one turn's ordered tool calls and fold the results into the model's counters. */
function analyzeTurnToolCalls(toolCalls: { toolName: string; arguments?: string }[], counters: ModelEfficiencyCounters): void {
	let editCalls = 0;
	let retries = 0;
	let selfCorrections = 0;
	counters.toolCalls = (counters.toolCalls ?? 0) + toolCalls.length;
	const editedFiles = new Set<string>();
	// File edited by the immediately preceding tool call, or null when the
	// preceding call was not an edit (or there is no preceding call).
	let lastEditFile: string | null = null;
	let unknownPathCounter = 0;

	for (const call of toolCalls) {
		if (!isEditToolName(call.toolName)) {
			lastEditFile = null;
			continue;
		}
		editCalls++;
		// Edits without an extractable path get a unique placeholder so they never
		// produce false retry/self-correction positives.
		const file = extractEditFilePath(call.arguments) ?? `\u0000unknown-${unknownPathCounter++}`;
		if (editedFiles.has(file)) {
			if (lastEditFile === file) { retries++; } else { selfCorrections++; }
		}
		editedFiles.add(file);
		lastEditFile = file;
	}

	counters.editToolCalls += editCalls;
	if (editCalls > 0) {
		counters.editTurns++;
		counters.retries += retries;
		counters.selfCorrections += selfCorrections;
		if (retries === 0 && selfCorrections === 0) { counters.oneShotEditTurns++; }
	}
}

/**
 * Compute per-model efficiency counters from a session's chat turns.
 * Turns without a model are attributed to 'unknown'.
 * Token/cost fields are left at zero — fold them in with applyModelUsageToEfficiency.
 */
export function computeEfficiencyFromTurns(turns: EfficiencyTurn[]): ModelEfficiencyUsage {
	const eff: ModelEfficiencyUsage = {};
	for (const turn of turns) {
		const model = turn.model || 'unknown';
		const counters = ensureCounters(eff, model);
		counters.calls++;
		analyzeTurnToolCalls(turn.toolCalls ?? [], counters);
	}
	return eff;
}

// ---------------------------------------------------------------------------
// Copilot Chat JSON request support
// ---------------------------------------------------------------------------

/**
 * Minimal structural view of a Copilot Chat JSON session request.
 * `SessionRequestRaw` satisfies this shape. Edits appear as response items of
 * kind 'textEditGroup' (with the edited file's uri); tool invocations appear as
 * kind 'toolInvocationSerialized'/'prepareToolInvocation'.
 */
export interface EfficiencyJsonRequest {
	response?: { kind?: string; uri?: { path?: string; fsPath?: string } }[] | unknown[];
}

/**
 * Convert a Copilot Chat JSON request's response items into the tool-call
 * sequence shape used by computeEfficiencyFromTurns. textEditGroup items become
 * edit calls; other tool invocations become generic calls (so an intervening
 * test run still distinguishes self-correction from an immediate retry).
 */
export function jsonRequestToToolCalls(request: EfficiencyJsonRequest): { toolName: string; arguments?: string }[] {
	const toolCalls: { toolName: string; arguments?: string }[] = [];
	if (!request.response || !Array.isArray(request.response)) { return toolCalls; }
	for (const item of request.response as { kind?: string; uri?: { path?: string; fsPath?: string } }[]) {
		if (!item || typeof item !== 'object') { continue; }
		if (item.kind === 'textEditGroup') {
			const path = item.uri?.fsPath || item.uri?.path;
			toolCalls.push({ toolName: 'edit', arguments: path ? JSON.stringify({ path }) : undefined });
		} else if (item.kind === 'toolInvocationSerialized' || item.kind === 'prepareToolInvocation') {
			toolCalls.push({ toolName: 'toolInvocation' });
		}
	}
	return toolCalls;
}

// ---------------------------------------------------------------------------
// Merging and token/cost enrichment
// ---------------------------------------------------------------------------

/** Sum source counters into target (used when merging sessions into a period). */
export function mergeModelEfficiency(target: ModelEfficiencyUsage, source: ModelEfficiencyUsage | undefined): void {
	if (!source) { return; }
	for (const [model, counters] of Object.entries(source)) {
		const t = ensureCounters(target, model);
		t.calls += counters.calls;
		t.toolCalls = (t.toolCalls ?? 0) + (counters.toolCalls ?? 0);
		t.editTurns += counters.editTurns;
		t.oneShotEditTurns += counters.oneShotEditTurns;
		t.retries += counters.retries;
		t.selfCorrections += counters.selfCorrections;
		t.editToolCalls += counters.editToolCalls;
		t.inputTokens += counters.inputTokens;
		t.outputTokens += counters.outputTokens;
		t.cachedReadTokens += counters.cachedReadTokens;
		t.cost += counters.cost;
	}
}

/**
 * Fold one session's per-model token usage (and its estimated provider cost)
 * into the efficiency aggregate. Creates entries for models that produced no
 * turn counters (their rate metrics render as "—" but cache hit rate and token
 * totals still work).
 */
export function applyModelUsageToEfficiency(
	eff: ModelEfficiencyUsage,
	modelUsage: ModelUsage | undefined,
	modelPricing: { [key: string]: ModelPricing } = {}
): void {
	if (!modelUsage) { return; }
	for (const [model, usage] of Object.entries(modelUsage)) {
		const counters = ensureCounters(eff, model);
		counters.inputTokens += usage.inputTokens || 0;
		counters.outputTokens += usage.outputTokens || 0;
		counters.cachedReadTokens += usage.cachedReadTokens || 0;
		counters.cost += calculateEstimatedCost({ [model]: usage }, modelPricing);
	}
}

// ---------------------------------------------------------------------------
// Daily (time-sliceable) per-model efficiency
// ---------------------------------------------------------------------------

export function createEmptyDailyModelEfficiencyEntry(): DailyModelEfficiencyEntry {
	return {
		...createEmptyModelEfficiencyCounters(),
		sessions: 0, sessionShare: 0, activeDurationMs: 0, durationSessionShare: 0,
		linesAdded: 0, linesRemoved: 0, applies: 0, codeBlocks: 0,
	};
}

/**
 * The day entry for `model`, created on demand.
 *
 * Returns null for a prototype-polluting key: model ids come from parsed
 * session logs, and `target['__proto__']` is truthy, so an unguarded lookup
 * would hand back `Object.prototype` and the counter writes that follow would
 * land on it. `statsHelpers` guards the same pattern — see protoGuard.ts.
 */
function ensureDailyEntry(target: DailyModelEfficiency, model: string): DailyModelEfficiencyEntry | null {
	if (isUnsafeObjectKey(model)) { return null; }
	if (!target[model]) { target[model] = createEmptyDailyModelEfficiencyEntry(); }
	return target[model];
}

/**
 * Session-level signals that are not measured per model and therefore have to be
 * attributed to the session's models by token share.
 */
export interface SessionEfficiencyAttribution {
	/** Per-model token usage for the whole session — the source of the split weights. */
	modelUsage?: ModelUsage;
	/** Per-model turn counters for the session (already exact per model, never split). */
	modelEfficiency?: ModelEfficiencyUsage;
	/** Net active session duration in ms (excluding idle gaps), if derivable. */
	activeDurationMs?: number;
	linesAdded?: number;
	linesRemoved?: number;
	applies?: number;
	codeBlocks?: number;
}

/**
 * Token-share weights for a session's models, normalized to sum to 1.
 *
 * Weights come from `modelUsage` (input + output tokens). When a session carries
 * no token breakdown, the per-model token counters are tried next, and finally
 * the session is split equally across the models that produced turn counters.
 * Returns an empty map when the session names no model at all.
 */
export function computeModelTokenShares(input: SessionEfficiencyAttribution): Map<string, number> {
	const weights = new Map<string, number>();
	let total = 0;
	const add = (model: string, w: number): void => {
		if (w <= 0) { return; }
		weights.set(model, (weights.get(model) ?? 0) + w);
		total += w;
	};

	for (const [model, usage] of Object.entries(input.modelUsage ?? {})) {
		add(model, (usage.inputTokens || 0) + (usage.outputTokens || 0));
	}
	if (total === 0) {
		for (const [model, c] of Object.entries(input.modelEfficiency ?? {})) {
			add(model, c.inputTokens + c.outputTokens);
		}
	}
	if (total === 0) {
		const models = new Set([...Object.keys(input.modelUsage ?? {}), ...Object.keys(input.modelEfficiency ?? {})]);
		for (const model of models) { add(model, 1); }
	}
	if (total === 0) { return new Map(); }

	for (const [model, w] of weights) { weights.set(model, w / total); }
	return weights;
}


/**
 * Synthetic model ids the Copilot CLI offers in its model picker. Neither is a
 * model: each turn is routed to one or more real models, and the CLI's
 * `session.shutdown` metrics are keyed by the models that actually ran — while
 * the session's turn counters are keyed by the id the user picked.
 */
export const SYNTHETIC_ROUTER_MODELS: ReadonlySet<string> = new Set(['hydrafusion', 'auto']);

/**
 * The synthetic router a session ran under, when its token usage is keyed by
 * the real models that served the router's turns.
 *
 * Without this the router shows up in the Efficiency view's model comparison
 * with edit turns but zero sessions, tokens and cost, while the real models
 * absorb its tokens and cost without the matching edit turns — distorting
 * both sides. Returns `undefined` when the session was not routed, or when its
 * usage is already keyed by the router (VS Code Chat and Kiro CLI record Auto
 * that way), or when turns ran under *both* routers: the shutdown metrics
 * cannot be partitioned between them, so neither is re-keyed rather than
 * crediting one router with the other's tokens.
 */
export function findRoutedSessionModel(
	modelUsage: ModelUsage | undefined,
	modelEfficiency: ModelEfficiencyUsage | undefined,
): string | undefined {
	let router: string | undefined;
	for (const model of Object.keys(modelEfficiency ?? {})) {
		if (!SYNTHETIC_ROUTER_MODELS.has(model) || modelUsage?.[model]) { continue; }
		if (router !== undefined) { return undefined; }
		router = model;
	}
	return router;
}

/**
 * The key a usage entry lands on for efficiency attribution: the router when
 * the session was routed and this model only served the router's turns, else
 * the model itself. A model that also ran turns under its own name (picked
 * directly for part of the session) keeps its own usage.
 */
function efficiencyModelKey(model: string, router: string | undefined, modelEfficiency: ModelEfficiencyUsage | undefined): string {
	return router && !modelEfficiency?.[model] ? router : model;
}

/**
 * Re-keys a routed session's token usage onto the router id so the router can
 * be compared as a model in its own right. Returns `modelUsage` unchanged when
 * the session was not routed. Pure: never mutates its input.
 *
 * Token fields are merged through the shared `addModelUsage` helper, so a new
 * `ModelUsage` field is picked up here automatically. Per-session usage marks
 * each model with `sessions` 0 or 1; the folded router entry keeps that
 * meaning (one session, not one per real model) rather than the helper's sum.
 */
export function attributeRoutedModelUsage(
	modelUsage: ModelUsage | undefined,
	modelEfficiency: ModelEfficiencyUsage | undefined,
): ModelUsage | undefined {
	const router = findRoutedSessionModel(modelUsage, modelEfficiency);
	if (!router || !modelUsage) { return modelUsage; }
	const result: ModelUsage = {};
	let routerSessions = 0;
	for (const [model, usage] of Object.entries(modelUsage)) {
		const key = efficiencyModelKey(model, router, modelEfficiency);
		addModelUsage(result, { [key]: usage });
		if (key === router) { routerSessions = Math.max(routerSessions, usage.sessions || 0); }
	}
	if (result[router]) { result[router].sessions = routerSessions; }
	return result;
}

/**
 * Folds one day's per-model token usage (and its estimated provider cost) into a
 * daily efficiency aggregate, incrementing the per-model session count.
 *
 * Call this once per session *per day* it was active, so token and cost totals
 * line up with the day's other token series.
 *
 * `modelEfficiency` is the session's turn counters. When they show the session
 * ran under a synthetic router (see {@link findRoutedSessionModel}), the usage
 * of the real models that served it lands on the router's entry instead — priced
 * at each real model's own rate, since the router has no price of its own.
 */
export function accumulateDailyModelTokens(
	target: DailyModelEfficiency,
	modelUsage: ModelUsage | undefined,
	modelPricing: { [key: string]: ModelPricing } = {},
	modelEfficiency?: ModelEfficiencyUsage,
): void {
	if (!modelUsage) { return; }
	const router = findRoutedSessionModel(modelUsage, modelEfficiency);
	const counted = new Set<string>();
	for (const [model, usage] of Object.entries(modelUsage)) {
		const key = efficiencyModelKey(model, router, modelEfficiency);
		const entry = ensureDailyEntry(target, key);
		if (!entry) { continue; }
		entry.inputTokens += usage.inputTokens || 0;
		entry.outputTokens += usage.outputTokens || 0;
		entry.cachedReadTokens += usage.cachedReadTokens || 0;
		entry.cost += calculateEstimatedCost({ [model]: usage }, modelPricing);
		// One session, however many real models the router spread it over.
		if (!counted.has(key)) { entry.sessions += 1; counted.add(key); }
	}
}

/**
 * Folds one session's behavioural signals into a daily efficiency aggregate:
 * per-model turn counters are added exactly, while session-level duration, LOC
 * and apply counts are split across models by token share.
 *
 * Unlike {@link accumulateDailyModelTokens}, this must be called *once per
 * session* (on the day of its last activity), because the underlying counters
 * describe the whole session and cannot be attributed to individual days.
 */
export function accumulateDailyModelCounters(target: DailyModelEfficiency, input: SessionEfficiencyAttribution): void {
	const shares = computeModelTokenShares(input);
	if (shares.size === 0) { return; }

	for (const [model, counters] of Object.entries(input.modelEfficiency ?? {})) {
		const entry = ensureDailyEntry(target, model);
		if (!entry) { continue; }
		entry.calls += counters.calls;
		entry.toolCalls = (entry.toolCalls ?? 0) + (counters.toolCalls ?? 0);
		entry.editTurns += counters.editTurns;
		entry.oneShotEditTurns += counters.oneShotEditTurns;
		entry.retries += counters.retries;
		entry.selfCorrections += counters.selfCorrections;
		entry.editToolCalls += counters.editToolCalls;
	}

	const hasDuration = (input.activeDurationMs ?? 0) > 0;
	for (const [model, share] of shares) {
		const entry = ensureDailyEntry(target, model);
		if (!entry) { continue; }
		entry.sessionShare += share;
		if (hasDuration) {
			entry.activeDurationMs += input.activeDurationMs! * share;
			entry.durationSessionShare += share;
		}
		entry.linesAdded += (input.linesAdded ?? 0) * share;
		entry.linesRemoved += (input.linesRemoved ?? 0) * share;
		entry.applies += (input.applies ?? 0) * share;
		entry.codeBlocks += (input.codeBlocks ?? 0) * share;
	}
}

/**
 * Maps a parsed session cache entry onto the attribution input shape, preferring
 * the session's own LOC totals and falling back to its edit-scope analysis.
 */
export function buildSessionEfficiencyAttribution(sessionData: SessionFileCache): SessionEfficiencyAttribution {
	const analysis = sessionData.usageAnalysis;
	return {
		// Routed sessions are re-keyed so the router's token share lands on the
		// same entry as its turn counters (see findRoutedSessionModel).
		modelUsage: attributeRoutedModelUsage(sessionData.modelUsage, analysis?.modelEfficiency),
		modelEfficiency: analysis?.modelEfficiency,
		activeDurationMs: analysis?.sessionDuration?.activeDurationMs,
		linesAdded: sessionData.linesAdded ?? analysis?.editScope?.linesAdded,
		linesRemoved: sessionData.linesRemoved ?? analysis?.editScope?.linesRemoved,
		applies: analysis?.applyUsage?.totalApplies,
		codeBlocks: analysis?.applyUsage?.totalCodeBlocks,
	};
}

/** Sums `src` into `target` — used when rolling days up into weeks/months. */export function mergeDailyModelEfficiency(target: DailyModelEfficiency, src: DailyModelEfficiency | undefined): void {
	if (!src) { return; }
	for (const [model, s] of Object.entries(src)) {
		const t = ensureDailyEntry(target, model);
		if (!t) { continue; }
		t.calls += s.calls;
		t.toolCalls = (t.toolCalls ?? 0) + (s.toolCalls ?? 0);
		t.editTurns += s.editTurns;
		t.oneShotEditTurns += s.oneShotEditTurns;
		t.retries += s.retries;
		t.selfCorrections += s.selfCorrections;
		t.editToolCalls += s.editToolCalls;
		t.inputTokens += s.inputTokens;
		t.outputTokens += s.outputTokens;
		t.cachedReadTokens += s.cachedReadTokens;
		t.cost += s.cost;
		t.sessions += s.sessions;
		t.sessionShare += s.sessionShare;
		t.activeDurationMs += s.activeDurationMs;
		t.durationSessionShare += s.durationSessionShare;
		t.linesAdded += s.linesAdded;
		t.linesRemoved += s.linesRemoved;
		t.applies += s.applies;
		t.codeBlocks += s.codeBlocks;
	}
}

// ---------------------------------------------------------------------------
// Derived display metrics
// ---------------------------------------------------------------------------

/** Derived per-model rates for display. Null means the denominator was zero (render as "—"). */
export interface ModelEfficiencyRates {
	/** Share of edit turns completed without retries or self-corrections (0..1). */
	oneShotRate: number | null;
	/** Average retries per edit turn. */
	retryRate: number | null;
	/** Average self-corrections per edit turn. */
	selfCorrectionRate: number | null;
	/** Average estimated cost per user-request turn (USD). */
	costPerCall: number | null;
	/** Average estimated cost per edit turn (USD). */
	costPerEdit: number | null;
	/** Average output tokens per user-request turn. */
	outputTokensPerCall: number | null;
	/** Average tool invocations per user-request turn. */
	toolCallsPerCall: number | null;
	/** Cache-read share of input tokens (0..1). */
	cacheHitRate: number | null;
}

export function deriveModelEfficiencyRates(c: ModelEfficiencyCounters): ModelEfficiencyRates {
	return {
		oneShotRate: c.editTurns > 0 ? c.oneShotEditTurns / c.editTurns : null,
		retryRate: c.editTurns > 0 ? c.retries / c.editTurns : null,
		selfCorrectionRate: c.editTurns > 0 ? c.selfCorrections / c.editTurns : null,
		costPerCall: c.calls > 0 ? c.cost / c.calls : null,
		costPerEdit: c.editTurns > 0 ? c.cost / c.editTurns : null,
		outputTokensPerCall: c.calls > 0 ? c.outputTokens / c.calls : null,
		toolCallsPerCall: c.calls > 0 ? (c.toolCalls ?? 0) / c.calls : null,
		// Cap at 1.0: some providers report cachedReadTokens > inputTokens (e.g. DeepSeek).
		cacheHitRate: c.inputTokens > 0 ? Math.min(1, c.cachedReadTokens / c.inputTokens) : null,
	};
}

// ---------------------------------------------------------------------------
// Low-usage filter helpers
// ---------------------------------------------------------------------------

/**
 * Returns the Q1 (25th-percentile) turn count from the usage data as the
 * low-usage cut-off threshold, or null when there are fewer than 4 models
 * (not enough data to define a meaningful outlier boundary).
 *
 * Models with `calls <= threshold` are considered low-usage and can be hidden
 * by the "Exclude low-usage models" filter in the efficiency panel.
 */
export function computeEfficiencyLowUsageThreshold(usage: ModelEfficiencyUsage): number | null {
	const calls = Object.values(usage).map(c => c.calls).sort((a, b) => a - b);
	if (calls.length < 4) { return null; }
	return calls[Math.floor((calls.length - 1) * 0.25)];
}

/**
 * Detects a natural "long tail" cutoff in per-model local usage and returns the names of the
 * models that fall after it, so the UI can collapse them into an "Other models" group.
 *
 * Ranks models by call count (descending) and finds the steepest proportional drop between two
 * consecutive models. Everything at or after that drop is treated as the tail, but only when the
 * drop is a genuine cliff (usage falls to less than half) and at least two models remain in the
 * tail — otherwise usage tapers off gradually and no grouping is applied (empty set returned).
 */
export function computeLongTailModels(usage: ModelEfficiencyUsage): Set<string> {
	const ranked = Object.entries(usage)
		.map(([model, counters]) => ({ model, calls: counters.calls }))
		.sort((a, b) => b.calls - a.calls);
	let cutoffIndex = -1;
	let smallestRatio = 1;
	for (let i = 1; i < ranked.length; i++) {
		const previousCalls = ranked[i - 1].calls;
		if (previousCalls <= 0) { continue; }
		const ratio = ranked[i].calls / previousCalls;
		if (ratio < smallestRatio) {
			smallestRatio = ratio;
			cutoffIndex = i;
		}
	}
	const tailLength = cutoffIndex === -1 ? 0 : ranked.length - cutoffIndex;
	if (cutoffIndex === -1 || smallestRatio >= 0.5 || tailLength < 2) { return new Set(); }
	return new Set(ranked.slice(cutoffIndex).map(entry => entry.model));
}

// ---------------------------------------------------------------------------
// Day + per-editor accumulation (kept paired by construction)
// ---------------------------------------------------------------------------

/**
 * The per-editor slice of a day's model-efficiency counters, created on demand.
 *
 * Every session belongs to exactly one editor, so merging all slices of a day
 * reproduces that day's `modelEfficiency` exactly. The Efficiency view's editor
 * filter depends on that invariant holding, which is why the two writes below
 * live in one function rather than at each call site: a caller cannot update
 * the day total and forget the editor slice.
 */
function getOrCreateEditorSlice(entry: DailyTokenStats, editor: string): DailyModelEfficiency {
	if (!entry.modelEfficiency) { entry.modelEfficiency = {}; }
	if (!entry.editorModelEfficiency) { entry.editorModelEfficiency = {}; }
	if (!entry.editorModelEfficiency[editor]) { entry.editorModelEfficiency[editor] = {}; }
	return entry.editorModelEfficiency[editor];
}

/**
 * Folds a session's token/cost usage into both the day total and the editor
 * slice. See {@link getOrCreateEditorSlice} for why these are not separate calls.
 * `modelEfficiency` is the session's turn counters, used to re-key routed
 * sessions (see {@link accumulateDailyModelTokens}).
 */
export function accumulateDayAndEditorModelTokens(
	entry: DailyTokenStats,
	editor: string,
	modelUsage: ModelUsage,
	pricing: { [model: string]: ModelPricing },
	modelEfficiency?: ModelEfficiencyUsage,
): void {
	const slice = getOrCreateEditorSlice(entry, editor);
	accumulateDailyModelTokens(entry.modelEfficiency!, modelUsage, pricing, modelEfficiency);
	accumulateDailyModelTokens(slice, modelUsage, pricing, modelEfficiency);
}

/**
 * Folds a session's per-model turn counters (and its token-share-attributed
 * duration, LOC and apply counts) into both the day total and the editor slice.
 */
export function accumulateDayAndEditorModelCounters(
	entry: DailyTokenStats,
	editor: string,
	input: SessionEfficiencyAttribution,
): void {
	const slice = getOrCreateEditorSlice(entry, editor);
	accumulateDailyModelCounters(entry.modelEfficiency!, input);
	accumulateDailyModelCounters(slice, input);
}
