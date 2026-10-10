/**
 * Pure analysis and computation functions for the CLI.
 *
 * This module contains stateless helpers — functions that transform data without
 * touching the filesystem, ecosystem registry, or cache.  All I/O-heavy and
 * bootstrap-dependent logic lives in helpers.ts.
 */
import { calculateEstimatedCost } from '../../src/tokenEstimation';
import { addModelUsage, scaleModelUsage } from '../../src/statsHelpers';
import { normalizePathForComparison, detectClaudeCodeEditorVariant, detectRelocatedAgentHomeFromPath } from '../../src/workspaceHelpers';
import { getPricingSourceForEditor, getBillingGroup } from '../../src/chartDataBuilder';
import { createEmptyContextRefs } from '../../src/tokenEstimation';
import type { ModelUsage, ModelPricing, PeriodStats, UsageAnalysisPeriod } from '../../src/types';
export type { PeriodStats, UsageAnalysisPeriod } from '../../src/types';

/** Type alias for a single model pricing entry from modelPricing.json. */
export type ModelPricingEntry = ModelPricing;

// Import JSON data file used by buildChartPayload
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
}

/** A single day's aggregated token data for the chart view. */
export interface DailyEntry {
	tokens: number;
	sessions: number;
	modelUsage: ModelUsage;
	editorUsage: { [editor: string]: { tokens: number; sessions: number } };
	editorModelUsage?: { [editor: string]: ModelUsage };
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

// ── Chart helpers ─────────────────────────────────────────────────────────────────────────────────────────────

const CHART_COLORS = [
	{ bg: 'rgba(54, 162, 235, 0.6)',  border: 'rgba(54, 162, 235, 1)' },
	{ bg: 'rgba(255, 99, 132, 0.6)',  border: 'rgba(255, 99, 132, 1)' },
	{ bg: 'rgba(75, 192, 192, 0.6)',  border: 'rgba(75, 192, 192, 1)' },
	{ bg: 'rgba(153, 102, 255, 0.6)', border: 'rgba(153, 102, 255, 1)' },
	{ bg: 'rgba(255, 159, 64, 0.6)',  border: 'rgba(255, 159, 64, 1)' },
	{ bg: 'rgba(255, 205, 86, 0.6)',  border: 'rgba(255, 205, 86, 1)' },
	{ bg: 'rgba(201, 203, 207, 0.6)', border: 'rgba(201, 203, 207, 1)' },
	{ bg: 'rgba(100, 181, 246, 0.6)', border: 'rgba(100, 181, 246, 1)' },
];

/**
 * Build the JSON payload consumed by the chart webview from the daily stats arrays
 * returned by `calculateDailyStats`. Includes weekly and monthly period aggregations.
 */
export function buildChartPayload(labels: string[], days: DailyEntry[], allDaysMap?: Map<string, DailyEntry>): object {
	if (!labels || !days) {
		throw new Error('buildChartPayload: labels and days are required');
	}
	if (labels.length !== days.length) {
		throw new Error(`buildChartPayload: labels.length (${labels.length}) !== days.length (${days.length})`);
	}
	const fmtKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

	const buildPeriodFromEntries = (buckets: Array<{ label: string; key: string; entry: DailyEntry }>) => {
		const entries = buckets.map(b => b.entry);
		const bLabels = buckets.map(b => b.label);
		// Sortable bucket keys (YYYY-MM-DD day / week-start, YYYY-MM month). The chart webview
		// filters each period by time window on these, and throws without them.
		const periodKeys = buckets.map(b => b.key);
		const tokensData = entries.map(e => e.tokens);
		const sessionsData = entries.map(e => e.sessions);

		const allModels = new Set<string>();
		entries.forEach(e => Object.keys(e.modelUsage).forEach(m => allModels.add(m)));
		const modelDatasets = Array.from(allModels).map((model, idx) => {
			const color = CHART_COLORS[idx % CHART_COLORS.length];
			return { label: model, data: entries.map(e => { const u = e.modelUsage[model]; return u ? u.inputTokens + u.outputTokens : 0; }), backgroundColor: color.bg, borderColor: color.border, borderWidth: 1 };
		});

		const allEditors = new Set<string>();
		entries.forEach(e => Object.keys(e.editorUsage).forEach(ed => allEditors.add(ed)));
		const editorDatasets = Array.from(allEditors).map((editor, idx) => {
			const color = CHART_COLORS[idx % CHART_COLORS.length];
			return { label: editor, data: entries.map(e => e.editorUsage[editor]?.tokens || 0), backgroundColor: color.bg, borderColor: color.border, borderWidth: 1 };
		});

		const totalTokens = tokensData.reduce((a, b) => a + b, 0);
		const totalSessions = sessionsData.reduce((a, b) => a + b, 0);
		const periodCount = buckets.length;
		const costData = entries.map(e => calculateEstimatedCost(e.modelUsage, modelPricing, 'copilot'));
		const totalCost = costData.reduce((a, b) => a + b, 0);
		const avgCostPerPeriod = periodCount > 0 ? totalCost / periodCount : 0;

		// Editor cost datasets (cost per editor using per-editor model breakdown)
		const allEditorsForCost = new Set<string>();
		entries.forEach(e => { if (e.editorModelUsage) { Object.keys(e.editorModelUsage).forEach(ed => allEditorsForCost.add(ed)); } });
		const editorCostTotals = new Map<string, number>();
		for (const editor of allEditorsForCost) {
			const total = entries.reduce((sum, e) => sum + calculateEstimatedCost(e.editorModelUsage?.[editor] ?? {}, modelPricing, getPricingSourceForEditor(editor)), 0);
			editorCostTotals.set(editor, total);
		}
		const sortedCostEditors = Array.from(allEditorsForCost).sort((a, b) => (editorCostTotals.get(b) || 0) - (editorCostTotals.get(a) || 0));
		const editorCostDatasets = sortedCostEditors.map((editor, idx) => {
			const color = CHART_COLORS[idx % CHART_COLORS.length];
			return { label: editor, data: entries.map(e => calculateEstimatedCost(e.editorModelUsage?.[editor] ?? {}, modelPricing, getPricingSourceForEditor(editor))), backgroundColor: color.bg, borderColor: color.border, borderWidth: 1 };
		});

		// Billing group cost datasets (cost per provider: "GitHub Copilot", "Anthropic", etc.)
		const allGroups = new Set<string>();
		entries.forEach(e => {
			if (!e.editorModelUsage) { return; }
			for (const [editor, mu] of Object.entries(e.editorModelUsage)) {
				for (const modelId of Object.keys(mu)) { allGroups.add(getBillingGroup(editor, modelId)); }
			}
		});
		const groupTotals = new Map<string, number>();
		for (const group of allGroups) {
			groupTotals.set(group, entries.reduce((sum, e) => {
				if (!e.editorModelUsage) { return sum; }
				const grouped: ModelUsage = {};
				for (const [editor, mu] of Object.entries(e.editorModelUsage)) {
					for (const [modelId, usage] of Object.entries(mu)) {
						if (getBillingGroup(editor, modelId) !== group) { continue; }
						addModelUsage(grouped, { [modelId]: { ...usage, sessions: 0 } });
					}
				}
				const pricingSource = group === 'GitHub Copilot' ? 'copilot' : 'provider';
				return sum + calculateEstimatedCost(grouped, modelPricing, pricingSource);
			}, 0));
		}
		const sortedGroups = Array.from(allGroups).sort((a, b) => (groupTotals.get(b) || 0) - (groupTotals.get(a) || 0));
		const billingGroupCostDatasets = sortedGroups.map((group, idx) => {
			const color = CHART_COLORS[idx % CHART_COLORS.length];
			const pricingSource = group === 'GitHub Copilot' ? 'copilot' : 'provider';
			return {
				label: group,
				data: entries.map(e => {
					if (!e.editorModelUsage) { return 0; }
					const grouped: ModelUsage = {};
					for (const [editor, mu] of Object.entries(e.editorModelUsage)) {
						for (const [modelId, usage] of Object.entries(mu)) {
							if (getBillingGroup(editor, modelId) !== group) { continue; }
							addModelUsage(grouped, { [modelId]: { ...usage, sessions: 0 } });
						}
					}
					return calculateEstimatedCost(grouped, modelPricing, pricingSource);
				}),
				backgroundColor: color.bg, borderColor: color.border, borderWidth: 1,
			};
		});

		return { labels: bLabels, periodKeys, tokensData, sessionsData, modelDatasets, editorDatasets, repositoryDatasets: [], periodCount, totalTokens, totalSessions, avgPerPeriod: periodCount > 0 ? Math.round(totalTokens / periodCount) : 0, costData, totalCost, avgCostPerPeriod, editorCostDatasets, billingGroupCostDatasets };
	};

	const mergeEntry = (target: DailyEntry, src: DailyEntry) => {
		target.tokens += src.tokens;
		target.sessions += src.sessions;
		addModelUsage(target.modelUsage, scaleModelUsage(src.modelUsage, 1));
		for (const [e, u] of Object.entries(src.editorUsage)) {
			if (!target.editorUsage[e]) { target.editorUsage[e] = { tokens: 0, sessions: 0 }; }
			target.editorUsage[e].tokens += u.tokens;
			target.editorUsage[e].sessions += u.sessions;
		}
		if (src.editorModelUsage) {
			if (!target.editorModelUsage) { target.editorModelUsage = {}; }
			for (const [editor, mu] of Object.entries(src.editorModelUsage)) {
				if (!target.editorModelUsage[editor]) { target.editorModelUsage[editor] = {}; }
				addModelUsage(target.editorModelUsage[editor], scaleModelUsage(mu, 1));
			}
		}
	};

	const emptyEntry = (): DailyEntry => ({ tokens: 0, sessions: 0, modelUsage: {}, editorUsage: {} });

	const now = new Date();

	// ── Daily period: the existing 30-day data ──────────────────────────
	const dailyBuckets = labels.map((l, i) => ({ label: l, key: l, entry: days[i] }));
	const dailyPeriod = buildPeriodFromEntries(dailyBuckets);

	// ── Weekly period: last 6 calendar weeks ───────────────────────────
	const getMondayOfWeek = (d: Date): Date => {
		const copy = new Date(d); copy.setHours(0, 0, 0, 0);
		const day = copy.getDay();
		copy.setDate(copy.getDate() - (day === 0 ? 6 : day - 1));
		return copy;
	};
	const fmtWeekLabel = (monday: Date): string => {
		const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
		if (monday.getMonth() === sunday.getMonth()) {
			return `${monday.toLocaleDateString('en-US', { month: 'short' })} ${monday.getDate()}–${sunday.getDate()}`;
		}
		return `${monday.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}–${sunday.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
	};
	const thisMonday = getMondayOfWeek(now);
	const weekBucketMap = new Map<string, { label: string; key: string; entry: DailyEntry }>();
	for (let w = 5; w >= 0; w--) {
		const monday = new Date(thisMonday); monday.setDate(thisMonday.getDate() - w * 7);
		const key = fmtKey(monday);
		weekBucketMap.set(key, { label: fmtWeekLabel(monday), key, entry: emptyEntry() });
	}
	const sourceMap = allDaysMap || new Map(labels.map((l, i) => [l, days[i]]));
	for (const [dateKey, entry] of sourceMap.entries()) {
		const monday = getMondayOfWeek(new Date(dateKey + 'T00:00:00'));
		const bucket = weekBucketMap.get(fmtKey(monday));
		if (bucket) { mergeEntry(bucket.entry, entry); }
	}
	const weeklyBuckets = Array.from(weekBucketMap.values());
	const weeklyPeriod = buildPeriodFromEntries(weeklyBuckets);

	// ── Monthly period: last 12 calendar months ────────────────────────
	const monthBucketMap = new Map<string, { label: string; key: string; entry: DailyEntry }>();
	for (let m = 11; m >= 0; m--) {
		const monthDate = new Date(now.getFullYear(), now.getMonth() - m, 1);
		const key = `${monthDate.getFullYear()}-${String(monthDate.getMonth() + 1).padStart(2, '0')}`;
		const label = monthDate.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
		monthBucketMap.set(key, { label, key, entry: emptyEntry() });
	}
	for (const [dateKey, entry] of sourceMap.entries()) {
		const monthKey = dateKey.slice(0, 7);
		const bucket = monthBucketMap.get(monthKey);
		if (bucket) { mergeEntry(bucket.entry, entry); }
	}
	const monthlyBuckets = Array.from(monthBucketMap.values());
	const monthlyPeriod = buildPeriodFromEntries(monthlyBuckets);

	// ── Editor totals map (last 30 days) ───────────────────────────────
	const editorTotalsMap: Record<string, number> = {};
	days.forEach(d => {
		Object.entries(d.editorUsage).forEach(([editor, usage]) => {
			editorTotalsMap[editor] = (editorTotalsMap[editor] || 0) + usage.tokens;
		});
	});

	return {
		// Backward-compat flat fields (daily period)
		labels: dailyPeriod.labels,
		tokensData: dailyPeriod.tokensData,
		sessionsData: dailyPeriod.sessionsData,
		modelDatasets: dailyPeriod.modelDatasets,
		editorDatasets: dailyPeriod.editorDatasets,
		editorTotalsMap,
		repositoryDatasets: [],
		repositoryTotalsMap: {},
		dailyCount: dailyPeriod.periodCount,
		totalTokens: dailyPeriod.totalTokens,
		avgTokensPerDay: dailyPeriod.periodCount > 0 ? Math.round(dailyPeriod.totalTokens / dailyPeriod.periodCount) : 0,
		totalSessions: dailyPeriod.totalSessions,
		lastUpdated: new Date().toISOString(),
		backendConfigured: false,
		periodsReady: true,
		periods: {
			day: dailyPeriod,
			week: weeklyPeriod,
			month: monthlyPeriod,
		},
	};
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
