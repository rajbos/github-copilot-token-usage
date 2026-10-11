/**
 * Pure analysis and computation functions for the CLI.
 *
 * This module contains stateless helpers — functions that transform data without
 * touching the filesystem, ecosystem registry, or cache.  All I/O-heavy and
 * bootstrap-dependent logic lives in helpers.ts.
 */
import { calculateEstimatedCost } from '../../src/tokenEstimation';
import { addModelUsage, scaleModelUsage } from '../../src/statsHelpers';
import { normalizePathForComparison, detectClaudeCodeEditorVariant, detectRelocatedAgentHomeFromPath, getRepoDisplayName } from '../../src/workspaceHelpers';
import { buildChartData } from '../../src/chartDataBuilder';
import { buildEfficiencyViewData, formatAttributionDateEnUs, NO_PR_VALUE_INPUTS, type EfficiencySessionAnalysis } from '../../src/efficiencyViewBuilder';
import type { EfficiencySessionInput, EfficiencyViewData } from '../../src/efficiencyAnalysis';
import { createEmptyContextRefs } from '../../src/tokenEstimation';
import type { ChartDataPayload, DailyTokenStats, LanguageUsage, ModelUsage, ModelPricing, PeriodStats, UsageAnalysisPeriod, UsageAnalysisStats } from '../../src/types';
import type { TaskCategory, TaskCategoryBreakdown } from '../../src/taskClassification';
export type { PeriodStats, UsageAnalysisPeriod } from '../../src/types';

/** Type alias for a single model pricing entry from modelPricing.json. */
export type ModelPricingEntry = ModelPricing;

// Import JSON data file used for chart cost estimation
import modelPricingData from '../../src/modelPricing.json';
const modelPricing = modelPricingData.pricing as Record<string, ModelPricingEntry>;

// ── Types ────────────────────────────────────────────────────────────────────────────────

// ── Session data types ─────────────────────────────────────────────────────────────────────

export interface SessionData {
	file: string;
	tokens: number;
	thinkingTokens: number;
	/** Actual LLM tokens from session.shutdown or request-level usage data. 0 means unavailable. */
	actualTokens: number;
	interactions: number;
	modelUsage: ModelUsage;
	/**
	 * Exact GitHub Copilot billing in nano-AI-units (0 when unavailable): the latest
	 * `totalNanoAiu` from a Copilot CLI `session.usage_checkpoint`/`session.shutdown`, the
	 * Copilot CLI billing store, or a Copilot Chat debug log. 1 AI credit = 1e9 nanoAiu.
	 */
	copilotNanoAiu: number;
	lastModified: Date;
	editorSource: string;
	/**
	 * Per-UTC-day token fractions, keyed by "YYYY-MM-DD".
	 * Values sum to 1.0. Built from interaction timestamps extracted from the session file.
	 * Falls back to { [mtimeDateKey]: 1.0 } when no timestamps are available.
	 *
	 * This is the canonical attribution mechanism for all session formats:
	 *  - Copilot CLI JSONL: from user.message event timestamps
	 *  - VS Code delta JSONL: from kind:0/1/2 request timestamps
	 *  - VS Code JSON: from requests[].timestamp fields
	 *  - Ecosystem adapters: mtime fallback (until adapter implements getDailyFractions)
	 */
	dailyFractions: Record<string, number>;
	/** Repository the session worked in, via the shared resolveSessionRepository(); absent when none. */
	repository?: string;
	/** Task attribution, via the shared resolveSessionTaskAttribution(). */
	taskCategory?: TaskCategory;
	taskCategoryShares?: TaskCategoryBreakdown;
	/** Session-level lines of code, via the shared sessionLocFromUsageAnalysis(). */
	linesAdded?: number;
	linesRemoved?: number;
	languageUsage?: LanguageUsage;
	/**
	 * The slice of the session's usage analysis the Efficiency view reads (per-model turn
	 * counters, active duration, apply usage, skill calls). Kept slim because it is cached.
	 */
	usageAnalysis?: EfficiencySessionAnalysis;
	/** Set once the view attributes above were derived (see processSessionFileForViews in helpers.ts). */
	viewAttributesResolved?: true;
	/**
	 * DB-backed sessions: the session's own last-activity time the view attributes were derived
	 * for. The entry is keyed by the shared database's stat, so a different value means they are
	 * outdated (see sessionVersion in helpers.ts).
	 */
	viewActivityMs?: number;
}

// ── Billing group helpers ────────────────────────────────────────────────────────────────────
// These used to be a hand-maintained copy of chartDataBuilder.ts's table and helpers. The copy
// drifted: it never gained the `glm` prefix, so GLM models (which Mistral Vibe routes to, and
// which are priced in modelPricing.json) billed to the catch-all "Other" group in the CLI while
// the extension grouped them under Z.ai. It also matched on the raw id rather than
// getModelLookupCandidates(), so `copilot/`-prefixed and custom-endpoint ids fell through too.
// Importing the shared implementation removes that whole class of drift — see AGENTS.md,
// "CLI Must Reuse Shared Functions".

// ── Pure helpers ───────────────────────────────────────────────────────────────────────────────────────

/** Returns actual tokens when available (more accurate), else falls back to estimated. */
export function effectiveTokens(data: SessionData): number {
	if (!data) { return 0; }
	return data.actualTokens > 0 ? data.actualTokens : data.tokens;
}

/** Determine editor source from file path, returning the same friendly display names used by the VS Code extension. */
export function getEditorSourceFromPath(filePath: string): string {
	const normalized = normalizePathForComparison(filePath);
	// Eclipse Copilot conversations live in the workspace metadata; check before the
	// generic VS Code fallthrough (the path can pass through a 'code' folder).
	if (normalized.includes('com.microsoft.copilot.eclipse')) { return 'Eclipse'; }
	// JetBrains must be checked before the broad /.copilot/ check (both use /.copilot/).
	if (normalized.includes('/.copilot/jb/')) { return 'JetBrains'; }
	// Copilot CLI: check specific sub-paths to avoid misclassifying JetBrains or other /.copilot/ entries.
	if (normalized.includes('/.copilot/session-store.db#')) { return 'Copilot CLI'; }
	if (normalized.includes('/.copilot/session-state/')) { return 'Copilot CLI'; }
	if (normalized.includes('/.crush/crush.db#')) { return 'Crush'; }
	// Hermes (<HERMES_HOME>/state.db#<id>) and Devin CLI (<...>/devin/cli/sessions.db#<id>)
	// virtual DB session paths — mirrors detectCliAgentStoreFromPath in src/workspaceHelpers.ts.
	if (normalized.includes('hermes/state.db#')) { return 'Hermes'; }
	if (normalized.includes('devin/cli/sessions.db#')) { return 'Devin CLI'; }
	// Cline task files live under <variant>/User/globalStorage/saoudrizwan.claude-dev/
	// — must be checked before the generic /cursor/ and VS Code fallthrough below.
	if (normalized.includes('/saoudrizwan.claude-dev/tasks/')) { return 'Cline'; }
	// Kilo Code (OpenCode fork): virtual DB session paths <...>/.local/share/kilo/kilo.db#ses_<id>.
	if (normalized.includes('/kilo/kilo.db#')) { return 'Kilo Code'; }
	if (normalized.includes('/opencode/')) { return 'OpenCode'; }
	// OpenAI Codex CLI (~/.codex): must be checked before the generic 'code'-based
	// fallbacks below ('codex' contains 'code' and would misclassify as VS Code).
	if (normalized.includes('/.codex/')) { return 'Codex CLI'; }
	// $CODEX_HOME / $VIBE_HOME / $HERMES_HOME pointing at a folder not named like the default.
	const relocatedAgent = detectRelocatedAgentHomeFromPath(normalized);
	if (relocatedAgent) { return relocatedAgent; }
	if (normalized.includes('/.pi/agent/sessions/')) { return 'Pi'; }
	// Kiro CLI (~/.kiro/sessions/cli) and Kiro IDE (kiro.kiroagent global storage) are separate editors.
	if (normalized.includes('/.kiro/sessions/cli/')) { return 'Kiro CLI'; }
	if (normalized.includes('/kiro.kiroagent/workspace-sessions/')) { return 'Kiro'; }
	if (normalized.includes('/.continue/sessions/')) { return 'Continue'; }
	if (normalized.includes('/claude-code-sessions/')) { return 'Claude Desktop Cowork'; }
	if (normalized.includes('/local-agent-mode-sessions/')) { return 'Claude Desktop Cowork'; }
	if (normalized.includes('/.claude/projects/')) { return detectClaudeCodeEditorVariant(filePath); }
	if (normalized.includes('/.vibe/logs/session/')) { return 'Mistral Vibe'; }
	// Antigravity must be checked before Gemini CLI: both live under ~/.gemini/.
	if (normalized.includes('/.gemini/antigravity/brain/')) { return 'Antigravity'; }
	if (normalized.includes('/.gemini/tmp/') && normalized.includes('/chats/session-') && normalized.endsWith('.jsonl')) { return 'Gemini CLI'; }
	if (normalized.includes('/cursor/')) { return 'Cursor'; }
	if (normalized.includes('/code - insiders/')) { return 'VS Code Insiders'; }
	if (normalized.includes('/code - exploration/')) { return 'VS Code Exploration'; }
	if (normalized.includes('/vscodium/')) { return 'VSCodium'; }
	if (normalized.includes('.vscode-server-insiders/')) { return 'VS Code Server (Insiders)'; }
	if (normalized.includes('.vscode-server')) { return 'VS Code Server'; }
	// Visual Studio / SSMS Copilot Chat sessions. Mirrors isVisualStudioPath() and
	// isSsmsPath() in src/workspaceHelpers.ts — keep the three roots and the
	// `/sessions/` requirement in step across both.
	if (normalized.includes('/copilot-chat/') && normalized.includes('/sessions/')) {
		if (normalized.includes('/ssmsgithubcopilot/copilot-chat/')) { return 'SSMS'; }
		if (normalized.includes('/.vs/') || normalized.includes('/vsgithubcopilot/copilot-chat/')) { return 'Visual Studio'; }
	}
	return 'VS Code';
}

/**
 * Run async tasks with bounded concurrency.
 * Items are processed up to `limit` at a time, avoiding I/O and memory saturation.
 */
export async function runWithConcurrency<T, R>(
	items: T[],
	fn: (item: T, index: number) => Promise<R>,
	limit = 20
): Promise<(R | undefined)[]> {
	if (items.length === 0) { return []; }
	const results: (R | undefined)[] = new Array(items.length);
	let idx = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (idx < items.length) {
			const i = idx++;
			try { results[i] = await fn(items[i], i); } catch { results[i] = undefined; }
		}
	});
	await Promise.all(workers);
	return results;
}

// ── Period stats factories and accumulators ────────────────────────────────────────────────────────────────────

export function createEmptyPeriodStats(): PeriodStats {
	return {
		tokens: 0,
		thinkingTokens: 0,
		estimatedTokens: 0,
		actualTokens: 0,
		sessions: 0,
		avgInteractionsPerSession: 0,
		avgTokensPerSession: 0,
		modelUsage: {},
		editorUsage: {},
		co2: 0,
		treesEquivalent: 0,
		waterUsage: 0,
		estimatedCost: 0,
	};
}

export function aggregateIntoPeriod(period: PeriodStats, data: SessionData, fraction: number): void {
	const displayTok = Math.round(effectiveTokens(data) * fraction);
	const thinkingTok = Math.round(data.thinkingTokens * fraction);
	const actualTok = Math.round(data.actualTokens * fraction);

	period.tokens += displayTok;
	period.thinkingTokens += thinkingTok;
	period.estimatedTokens += Math.round(data.tokens * fraction);
	period.actualTokens += actualTok;
	period.sessions++;

	// Merge model usage proportionally
	addModelUsage(period.modelUsage, scaleModelUsage(data.modelUsage, fraction));

	// Track interactions proportionally for the running average
	const interactions = Math.round(data.interactions * fraction);
	const totalInteractions = period.avgInteractionsPerSession * (period.sessions - 1) + interactions;
	period.avgInteractionsPerSession = period.sessions > 0 ? totalInteractions / period.sessions : 0;

	// Editor usage
	if (!period.editorUsage[data.editorSource]) {
		period.editorUsage[data.editorSource] = { tokens: 0, sessions: 0 };
	}
	period.editorUsage[data.editorSource].tokens += displayTok;
	period.editorUsage[data.editorSource].sessions++;
}

export function createEmptyUsageAnalysisPeriod(): UsageAnalysisPeriod {
	return {
		sessions: 0,
		toolCalls: { total: 0, byTool: {} },
		modeUsage: { ask: 0, edit: 0, agent: 0, plan: 0, customAgent: 0, cli: 0 },
		contextReferences: createEmptyContextRefs(),
		mcpTools: { total: 0, byServer: {}, byTool: {} },
		modelSwitching: {
			modelsPerSession: [],
			totalSessions: 0,
			averageModelsPerSession: 0,
			maxModelsPerSession: 0,
			minModelsPerSession: 0,
			switchingFrequency: 0,
			autoSessions: 0,
			foundryWindowsSessions: 0,
			unknownProviderSessions: 0,
			selectedModelExtensions: [],
			unknownProviderModels: [],
			standardModels: [],
			premiumModels: [],
			lowCostModels: [],
			mediumCostModels: [],
			highCostModels: [],
			unknownModels: [],
			mixedTierSessions: 0,
			mixedCostSessions: 0,
			standardRequests: 0,
			premiumRequests: 0,
			unknownRequests: 0,
			totalRequests: 0,
			lowCostRequests: 0,
			mediumCostRequests: 0,
			highCostRequests: 0,
		},
		repositories: [],
		repositoriesWithCustomization: [],
		editScope: {
			singleFileEdits: 0,
			multiFileEdits: 0,
			totalEditedFiles: 0,
			avgFilesPerSession: 0,
		},
		applyUsage: {
			totalApplies: 0,
			totalCodeBlocks: 0,
			applyRate: 0,
		},
		sessionDuration: {
			totalDurationMs: 0,
			avgDurationMs: 0,
			avgFirstProgressMs: 0,
			avgTotalElapsedMs: 0,
			avgWaitTimeMs: 0,
			activeDurationMs: 0,
		},
		conversationPatterns: {
			multiTurnSessions: 0,
			singleTurnSessions: 0,
			avgTurnsPerSession: 0,
			maxTurnsInSession: 0,
		},
		agentTypes: {
			editsAgent: 0,
			defaultAgent: 0,
			workspaceAgent: 0,
			other: 0,
		},
		taskCategoryPrimarySessions: {},
		taskCategoryWeightedSessions: {},
	};
}

// ── Chart payload ─────────────────────────────────────────────────────────────────────────────────────────

/** Host settings the CLI passes to the shared chart builder; the extension reads these from its config. */
export interface CliChartOptions {
	backendConfigured?: boolean;
	compactNumbers?: boolean;
	/** Injectable for tests. */
	now?: Date;
}

/**
 * The chart webview's payload, built by the same shared `buildChartData()` the extension uses —
 * the CLI only supplies its host dependencies. There is deliberately no CLI-side copy of the
 * period/bucket/dataset logic: a field the webview starts requiring (e.g. `periodKeys`, #2304)
 * reaches every host at once. See #2316 and AGENTS.md, "CLI Must Reuse Shared Functions".
 */
export function buildChartPayload(dailyStats: DailyTokenStats[], options: CliChartOptions = {}): ChartDataPayload {
	return buildChartData(dailyStats, {
		getRepoDisplayName,
		calculateEstimatedCost: (modelUsage, pricingSource) => calculateEstimatedCost(modelUsage, modelPricing, pricingSource),
		backendConfigured: options.backendConfigured ?? false,
		compactNumbers: options.compactNumbers ?? false,
		now: options.now,
	});
}

/** The zero-state chart payload (no session files): the same builder over no days, so the shape cannot drift. */
export function createEmptyChartPayload(now: Date = new Date()): ChartDataPayload {
	return buildChartPayload([], { now });
}

/** Inputs the CLI gathers for the Efficiency view; see `buildEfficiencyPayload`. */
export interface CliEfficiencyInputs {
	dailyStats: DailyTokenStats[];
	usage: UsageAnalysisStats;
	sessionInputs: EfficiencySessionInput[];
	now?: Date;
}

/**
 * The Efficiency webview's payload, built by the same shared `buildEfficiencyViewData()` the
 * extension uses. The CLI has no PR data, team backend or display settings, so those take
 * their "not configured" values.
 */
export function buildEfficiencyPayload(inputs: CliEfficiencyInputs): EfficiencyViewData {
	return buildEfficiencyViewData({
		dailyStats: inputs.dailyStats,
		usage: inputs.usage,
		sessionInputs: inputs.sessionInputs,
		now: inputs.now ?? new Date(),
		calculateEstimatedCost: (modelUsage, pricingSource) => calculateEstimatedCost(modelUsage, modelPricing, pricingSource),
		prValueInputs: NO_PR_VALUE_INPUTS,
		formatAttributionDate: formatAttributionDateEnUs,
		backendConfigured: false,
		compactNumbers: false,
		isDebugMode: false,
	});
}

// ── Formatting utilities ────────────────────────────────────────────────────────────────────────────────

/** Format a number with thousand separators */
export function fmt(n: number): string {
	if (n == null || !Number.isFinite(n)) { return '0'; }
	return Math.round(n).toLocaleString('en-US');
}

/** Format token counts for display */
export function formatTokens(tokens: number): string {
	if (tokens == null || !Number.isFinite(tokens) || tokens < 0) { return '0'; }
	if (tokens >= 1_000_000_000) {
		return `${(tokens / 1_000_000_000).toFixed(1)}B`;
	}
	if (tokens >= 1_000_000) {
		return `${(tokens / 1_000_000).toFixed(1)}M`;
	}
	if (tokens >= 1_000) {
		return `${(tokens / 1_000).toFixed(1)}K`;
	}
	return tokens.toString();
}
