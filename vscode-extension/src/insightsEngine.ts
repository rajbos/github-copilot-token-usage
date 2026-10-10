/**
 * Insights engine — evaluates personalized, data-driven nudges from usage stats.
 *
 * This module is intentionally pure (no VS Code API dependencies) so it can be
 * unit-tested with mocked data following the same pattern as onboarding.ts.
 *
 * Localization (issue #2081): every user-facing string here — titles, bodies,
 * action labels — resolves through `InsightContext.translate`, a `Translate`
 * injected by the caller, rather than through `l10n.ts`'s `t()`. Importing
 * `t()` would pull `vscode` in and end this module's purity; injection keeps it
 * VS Code-free while still rendering real localized text. `extension.ts` passes
 * the real `t()`; tests pass `createTranslator('en' | 'zh-cn')` from
 * `l10nCore.ts`, so they assert against the actually-shipped bundles.
 *
 * Two rules for adding or editing an insight:
 *   1. Never build a sentence by concatenating translated fragments with
 *      literal English glue, and never inline a `count > 1 ? 's' : ''`-style
 *      ternary into a template. Plural forms and verb agreement differ per
 *      locale, so each grammatical variant gets its own key (`.body.one` /
 *      `.body.other`) and the whole sentence lives inside it.
 *   2. Put the whole sentence in the bundle with `{0}`-style placeholders for
 *      live values, so a translator can reorder clauses freely.
 */
import type {
	UsageAnalysisPeriod,
	AutomaticCompactionStats,
	MissedPotentialWorkspace,
	WorkspaceCustomizationMatrix,
	TodaySessionSummary,
	ToolCurationAnalysis,
	RepeatedTaskReport,
	MemoryFilesAnalysis,
} from '../../src/types';
import toolNamesData from '../../src/toolNames.json';
import modelPricingData from '../../src/modelPricing.json';
import { resolveGuidMcpToolName, resolveMcpFamilyToolName, lookupKnownToolName } from '../../src/utils/toolUtils';
import { getLongContextInfo, type LongContextInfo } from '../../src/tokenEstimation';
import { CONTEXT_NEAR_LIMIT_RATIO } from '../../src/types';
import type { ModelPricing } from '../../src/types';
// Type-only: `l10nCore` itself imports no `vscode`, but importing only the type
// keeps even the bundle JSON out of this module's graph.
import type { Translate } from './l10nCore';

/**
 * Picks the `.one` or `.other` variant of a key for `count`.
 *
 * English only distinguishes one/other, which is all the shipped bundles need.
 * A locale with richer plural categories (Polish, Arabic, Russian) would need
 * this to consult `Intl.PluralRules` and the bundle to carry the extra forms —
 * deliberately not built until a bundle actually needs it, rather than guessed
 * at now.
 */
function plural(key: string, count: number): string {
	return `${key}.${count === 1 ? 'one' : 'other'}`;
}

/**
 * Joins names into a list using the locale's own separator — `, ` in English,
 * but a full-width `、` in zh-CN, which is why this is not a hardcoded `', '`.
 */
function joinNames(ctx: InsightContext, names: string[]): string {
	return names.join(ctx.translate('insight.shared.listSeparator'));
}

/**
 * The trailing " (+N more)" on a truncated list, or an empty string when the
 * list was shown in full.
 */
function moreSuffix(ctx: InsightContext, total: number, shown: number): string {
	return total > shown ? ctx.translate('insight.shared.andMore', total - shown) : '';
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

const TOOL_NAME_MAP: Record<string, string> = toolNamesData as Record<string, string>;

/**
 * Returns a human-friendly display name for an MCP tool ID.
 * 1. Exact, case-insensitive, or canonicalized (camelCase/separator) match in toolNames.json
 * 2. GUID-keyed MCP pattern (e.g. M365 Connector)
 * 3. Known MCP family (GitHub/Playwright/Context7/Tavily/Claude Browser) + known action,
 *    regardless of server-registration prefix (see issue #1760)
 * 4. Parse mcp__<server>__<tool> → "Server: Tool Name"
 * 5. Fall back to the raw ID
 */
function friendlyToolName(id: string): string {
	const known = lookupKnownToolName(id, TOOL_NAME_MAP);
	if (known) { return known; }
	const guid = resolveGuidMcpToolName(id);
	if (guid) { return guid; }
	const family = resolveMcpFamilyToolName(id);
	if (family) { return family; }
	// Parse mcp__ServerName__tool_name → "Server Name: Tool Name"
	const mcpMatch = /^mcp__([^_][^_]*)__(.+)$/.exec(id);
	if (mcpMatch) {
		const server = mcpMatch[1].replace(/_/g, ' ').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
		const tool = mcpMatch[2].replace(/_/g, ' ').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
		return `${server}: ${tool}`;
	}
	return id;
}

/** Sums all meaningful context reference counts for a period. */
function totalContextRefs(p: UsageAnalysisPeriod): number {
	const r = p.contextReferences;
	return (r.file ?? 0) + (r.codebase ?? 0) + (r.workspace ?? 0) + (r.selection ?? 0)
		+ (r.symbol ?? 0) + (r.terminal ?? 0) + (r.clipboard ?? 0) + (r.changes ?? 0)
		+ (r.pullRequest ?? 0);
}

// ── Session-hygiene helpers ────────────────────────────────────────────────
/** A single today-session is considered a "marathon" once it grows this long. */
const MARATHON_TURNS = 50;
/** ...or once it has processed this many cumulative tokens. */
const MARATHON_TOKENS = 750_000;

function isMarathonSession(s: TodaySessionSummary): boolean {
	return s.interactions >= MARATHON_TURNS || s.totalTokens >= MARATHON_TOKENS;
}

function hasMarathonSessionToday(ctx: InsightContext): boolean {
	return (ctx.todaySessions ?? []).some(isMarathonSession);
}

/** The largest today-session by turns, tie-broken by tokens. */
function biggestSessionToday(ctx: InsightContext): TodaySessionSummary | undefined {
	return (ctx.todaySessions ?? [])
		.slice()
		.sort((a, b) => (b.interactions - a.interactions) || (b.totalTokens - a.totalTokens))[0];
}

/** Short human-readable token count, e.g. 1_200_000 → "1.2M", 750_000 → "750K". */
function formatTokensShort(n: number): string {
	if (n >= 1_000_000) { return `${(n / 1_000_000).toFixed(1)}M`; }
	if (n >= 1_000) { return `${Math.round(n / 1_000)}K`; }
	return String(n);
}

/** Count of manual /compact commands in a period (Claude Code / Desktop only). */
function manualCompactCount(p: UsageAnalysisPeriod): number {
	return p.toolCalls.byTool['__slash__compact'] ?? 0;
}

// ── Long-context pricing tier helpers ──────────────────────────────────────
const MODEL_PRICING = modelPricingData.pricing as { [key: string]: ModelPricing };

/** Human-friendly model name from the pricing catalog, falling back to the raw id. */
function modelDisplayName(id: string): string {
	const names = MODEL_PRICING[id]?.displayNames;
	return names && names.length > 0 ? names[0] : id;
}

// ── Model efficiency (edit retries) helpers ────────────────────────────────

/** Minimum edit turns before a model's retry rate is considered meaningful. */
const RETRY_INSIGHT_MIN_EDIT_TURNS = 10;

/** Models with enough edit turns to compare, ranked worst (highest retry rate) first. */
function rankModelsByEditRetries(p: UsageAnalysisPeriod): { model: string; retries: number; editTurns: number; retryRate: number }[] {
	return Object.entries(p.modelEfficiency ?? {})
		.filter(([, c]) => c.editTurns >= RETRY_INSIGHT_MIN_EDIT_TURNS)
		.map(([model, c]) => ({ model, retries: c.retries, editTurns: c.editTurns, retryRate: c.retries / c.editTurns }))
		.sort((a, b) => b.retryRate - a.retryRate);
}

// ── Month-over-month trend helpers ─────────────────────────────────────────

/** Minimum sessions in a period before its per-session ratios are trusted for trend insights. */
const TREND_MIN_SESSIONS = 10;

/** Average turns per session for a period, or null when the sample is too small. */
function trendTurnsPerSession(p: UsageAnalysisPeriod | undefined): number | null {
	if (!p || p.sessions < TREND_MIN_SESSIONS || !p.conversationPatterns) { return null; }
	return p.conversationPatterns.avgTurnsPerSession;
}

/** Aggregate edit-retry rate for a period, or null when there are too few edit turns. */
function trendRetryRate(p: UsageAnalysisPeriod | undefined): number | null {
	if (!p) { return null; }
	let retries = 0;
	let editTurns = 0;
	for (const c of Object.values(p.modelEfficiency ?? {})) {
		retries += c.retries;
		editTurns += c.editTurns;
	}
	return editTurns >= RETRY_INSIGHT_MIN_EDIT_TURNS ? retries / editTurns : null;
}

/** Output price per million tokens from the pricing catalog, or null when unknown. */
function modelOutputPricePerMillion(id: string): number | null {
	return MODEL_PRICING[id]?.outputCostPerMillion ?? null;
}

/**
 * Best/worst retry-rate models with a price mismatch: the worst-retrying model
 * both retries ≥2× as often and costs ≥1.5× as much per output token as the best.
 */
function findRetryPriceMismatch(p: UsageAnalysisPeriod): { worst: { model: string; retryRate: number }; best: { model: string; retryRate: number }; priceRatio: number } | null {
	const ranked = rankModelsByEditRetries(p);
	if (ranked.length < 2) { return null; }
	const worst = ranked[0];
	const best = ranked[ranked.length - 1];
	if (best.retryRate <= 0 ? worst.retryRate < 0.25 : worst.retryRate < best.retryRate * 2) { return null; }
	const worstPrice = modelOutputPricePerMillion(worst.model);
	const bestPrice = modelOutputPricePerMillion(best.model);
	if (worstPrice === null || bestPrice === null || bestPrice <= 0) { return null; }
	const priceRatio = worstPrice / bestPrice;
	if (priceRatio < 1.5) { return null; }
	return { worst, best, priceRatio };
}

/** A today-session paired with the long-context tier info of its cheapest-threshold model. */
interface SessionLongContextStatus {
	session: TodaySessionSummary;
	info: LongContextInfo;
	model: string;
}

/**
 * Resolve the long-context pricing tier for a session's models.
 * When a session used multiple tiered models, the smallest threshold wins
 * (conservative: the first line the session could have crossed).
 */
function _sessionLongContextStatus(s: TodaySessionSummary): SessionLongContextStatus | null {
	let best: SessionLongContextStatus | null = null;
	for (const model of s.models) {
		const info = getLongContextInfo(model, MODEL_PRICING);
		if (info && (!best || info.thresholdTokens < best.info.thresholdTokens)) {
			best = { session: s, info, model };
		}
	}
	return best;
}

/** True when a session ran in an explicitly non-default Copilot CLI context tier. */
function _isNonDefaultTier(s: TodaySessionSummary): boolean {
	return !!s.contextTier && s.contextTier !== 'default';
}

/**
 * True when a session selected a non-default (larger) context window but its
 * observed context fill never needed it: the fill stayed within the model's
 * default-tier threshold, or — when the model has no tiered pricing — under
 * 60% of the selected window.
 */
function _qualifiesWindowUnused(s: TodaySessionSummary): boolean {
	if (!_isNonDefaultTier(s)) { return false; }
	const reached = s.contextReachedTokens;
	if (typeof reached !== 'number' || reached <= 0) { return false; }
	const tier = _sessionLongContextStatus(s);
	if (tier) { return reached <= tier.info.thresholdTokens; }
	return !!s.contextWindowLimit && reached <= s.contextWindowLimit * 0.6;
}

/** The fullest session today that selected a large window it never needed. */
function _windowUnusedToday(ctx: InsightContext): TodaySessionSummary | null {
	let fullest: TodaySessionSummary | null = null;
	for (const s of ctx.todaySessions ?? []) {
		if (!_qualifiesWindowUnused(s)) { continue; }
		if (!fullest || (s.contextReachedTokens ?? 0) > (fullest.contextReachedTokens ?? 0)) {
			fullest = s;
		}
	}
	return fullest;
}

/** The session that crossed its model's long-context threshold today, if any (largest request wins). */
function _longContextCrossedToday(ctx: InsightContext): SessionLongContextStatus | null {
	let worst: SessionLongContextStatus | null = null;
	for (const s of ctx.todaySessions ?? []) {
		const status = _sessionLongContextStatus(s);
		if (!status) { continue; }
		if ((s.maxRequestInputTokens ?? 0) > status.info.thresholdTokens
			&& (!worst || (s.maxRequestInputTokens ?? 0) > (worst.session.maxRequestInputTokens ?? 0))) {
			worst = status;
		}
	}
	return worst;
}

/** The largest request today (by per-request input tokens) among sessions using a tiered model. */
function _largestTieredRequestToday(ctx: InsightContext): SessionLongContextStatus | null {
	let largest: SessionLongContextStatus | null = null;
	for (const s of ctx.todaySessions ?? []) {
		if (!(s.maxRequestInputTokens && s.maxRequestInputTokens > 0)) { continue; }
		const status = _sessionLongContextStatus(s);
		if (!status) { continue; }
		if (!largest || s.maxRequestInputTokens > (largest.session.maxRequestInputTokens ?? 0)) {
			largest = status;
		}
	}
	return largest;
}

/**
 * Human-readable "how much repo fits in the default tier" estimate derived
 * from the threshold: ~4 characters per token, ~40 characters per source line.
 */
function _describeDefaultTierCapacity(ctx: InsightContext, thresholdTokens: number): string {
	const mb = (thresholdTokens * 4) / (1024 * 1024);
	const lines = Math.round(thresholdTokens / 10 / 1000);
	return ctx.translate('insight.shared.defaultTierCapacity', mb.toFixed(1), lines);
}

function autoModelUsageRatio(p: UsageAnalysisPeriod): number {
	return p.modelSwitching.totalSessions > 0 ? p.modelSwitching.autoSessions / p.modelSwitching.totalSessions : 0;
}

function usesOnlyDefaultModelSet(p: UsageAnalysisPeriod): boolean {
	const uniqueCount = new Set([...p.modelSwitching.standardModels, ...p.modelSwitching.premiumModels, ...p.modelSwitching.lowCostModels, ...p.modelSwitching.mediumCostModels, ...p.modelSwitching.highCostModels]).size;
	return uniqueCount <= 1
		&& (p.modelSwitching.autoSessions ?? 0) === 0
		&& (p.modelSwitching.foundryWindowsSessions ?? 0) === 0
		&& (p.modelSwitching.unknownProviderSessions ?? 0) === 0;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type InsightCategory = 'context' | 'agentic' | 'customization' | 'consistency' | 'tools' | 'trend';
export type InsightSeverity = 'tip' | 'opportunity' | 'celebration';
export type InsightStatus = 'new' | 'seen' | 'dismissed' | 'snoozed' | 'done';

export interface InsightContext {
	/**
	 * Resolves every user-facing string this module produces against
	 * `package.nls*.json`. Required, not optional with an English default: a
	 * missing translator must be a compile error at the call site, because the
	 * silent alternative is shipping raw `insight.*` keys into the UI.
	 *
	 * `extension.ts` passes `l10n.ts`'s `t()`; tests pass
	 * `createTranslator('en')` / `createTranslator('zh-cn')`.
	 */
	translate: Translate;
	today: UsageAnalysisPeriod;
	last30Days: UsageAnalysisPeriod;
	/** Current calendar month-to-date — enables month-over-month trend insights. */
	month?: UsageAnalysisPeriod;
	/** Previous full calendar month — enables month-over-month trend insights. */
	lastMonth?: UsageAnalysisPeriod;
	/** Automatic context compactions recorded during the trailing seven days. */
	autoCompactionsLast7Days?: AutomaticCompactionStats;
	missedPotential: MissedPotentialWorkspace[];
	customizationMatrix?: WorkspaceCustomizationMatrix | null;
	todaySessions?: TodaySessionSummary[];
	/** Optional — populated when tool-curation analysis has run. */
	curationAnalysis?: ToolCurationAnalysis | null;
	/** Optional — populated when repeated-task detection found candidates. */
	repeatedTasks?: RepeatedTaskReport | null;
	/** Optional — populated when Copilot memory-files discovery has run. */
	memoryFilesAnalysis?: MemoryFilesAnalysis | null;
}

export interface InsightState {
	status: InsightStatus;
	firstSurfacedAt: string;   // ISO timestamp
	lastSurfacedAt: string;    // ISO timestamp
	snoozeUntil?: string;      // ISO timestamp; present when status === 'snoozed'
}

/** Persisted bag of per-insight state keyed by insight id. */
export type InsightStateBag = Record<string, InsightState>;

/** A fully evaluated, display-ready insight card. */
export interface EvaluatedInsight {
	id: string;
	category: InsightCategory;
	severity: InsightSeverity;
	title: string;
	body: string;
	actionLabel?: string;
	actionCommand?: string;
	/** Optional second action, rendered alongside the primary one (e.g. an alternate next step). */
	secondaryActionLabel?: string;
	secondaryActionCommand?: string;
	status: InsightStatus;
	/** When true, this insight may also be surfaced as a VS Code toast notification. */
	allowToast?: boolean;
}

// ---------------------------------------------------------------------------
// Internal definition shape (not exported — consumers only see EvaluatedInsight)
// ---------------------------------------------------------------------------

interface InsightDefinition {
	id: string;
	category: InsightCategory;
	severity: InsightSeverity;
	/**
	 * A `package.nls.json` key, not display text — `evaluateInsights` resolves it
	 * through `ctx.translate`. The `Key` suffix on the label fields is what keeps
	 * them visibly distinct from the neighbouring `actionCommand` fields, which
	 * hold literal VS Code command ids and must never be translated.
	 */
	titleKey: string;
	buildBody: (ctx: InsightContext) => string;
	/** A `package.nls.json` key for a fixed action label. */
	actionLabelKey?: string;
	/** For an action label that depends on live data; takes precedence over `actionLabelKey`. */
	buildActionLabel?: (ctx: InsightContext) => string;
	actionCommand?: string | ((ctx: InsightContext) => string);
	/** A `package.nls.json` key for a fixed secondary action label. */
	secondaryActionLabelKey?: string;
	secondaryActionCommand?: string | ((ctx: InsightContext) => string);
	/** Returns true when this insight is applicable given the current context. */
	appliesTo: (ctx: InsightContext) => boolean;
	/** Higher weight → surfaced earlier when multiple insights apply. */
	weight: number;
	allowToast?: boolean;
}

// ---------------------------------------------------------------------------
/** Count of automatic compactions across all supported session formats in the trailing week. */
function autoCompactCount(ctx: InsightContext): number {
	return ctx.autoCompactionsLast7Days?.total ?? 0;
}

/**
 * "GitHub Copilot CLI: 3; Claude: 1" — the source names are product names and
 * stay untranslated, but the `name: count` pairing and the separator are
 * punctuation conventions a locale may differ on, so both come from the bundle.
 */
function autoCompactBreakdown(ctx: InsightContext, stats: AutomaticCompactionStats): string {
	const sources: Array<[string, number]> = [
		['GitHub Copilot CLI', stats.bySource.copilotCli],
		['Claude', stats.bySource.claude],
	];
	return sources.filter(([, count]) => count > 0)
		.map(([source, count]) => ctx.translate('insight.shared.sourceCount', source, count))
		.join(ctx.translate('insight.shared.sourceSeparator'));
}

/** Sessions in the last 30 days whose history was automatically compacted. */
function compactedSessionCount(ctx: InsightContext): number {
	return ctx.last30Days.contextPressure?.sessionsCompacted ?? 0;
}

/** Sessions in the last 30 days that almost filled their window without compacting. */
function nearLimitSessionCount(ctx: InsightContext): number {
	return ctx.last30Days.contextPressure?.sessionsNearLimit ?? 0;
}

/**
 * "N of your M sessions" phrasing for the last 30 days, or an empty string when
 * per-session context data was unavailable (e.g. no Copilot CLI / Claude sessions).
 */
function compactedSessionPhrase(ctx: InsightContext): string {
	const cp = ctx.last30Days.contextPressure;
	if (!cp || cp.sessionsConsidered === 0 || cp.sessionsCompacted === 0) { return ''; }
	const pct = Math.round((cp.sessionsCompacted / cp.sessionsConsidered) * 100);
	return ctx.translate('insight.shared.compactedSessionPhrase', cp.sessionsCompacted, cp.sessionsConsidered, pct);
}

// Starter catalog
// Sub-session agents will add entries here for trend data, context quality,
// focus times, streaks, and MCP/tool adoption insights.
// ---------------------------------------------------------------------------

export const INSIGHT_CATALOG: InsightDefinition[] = [
	// ── Customization ──────────────────────────────────────────────────────
	{
		id: 'missing-instructions',
		category: 'customization',
		severity: 'opportunity',
		titleKey: 'insight.missingInstructions.title',
		buildBody: (ctx) => {
			const count = ctx.missedPotential.length;
			const names = joinNames(ctx, ctx.missedPotential.slice(0, 3).map(w => w.workspaceName));
			return ctx.translate(plural('insight.missingInstructions.body', count), count, names, moreSuffix(ctx, count, 3));
		},
		actionLabelKey: 'insight.action.viewWorkspaceHealth',
		actionCommand: 'aiEngineeringFluency.openHealthTab',
		appliesTo: (ctx) => ctx.missedPotential.length > 0,
		weight: 90,
		allowToast: true,
	},
	{
		id: 'auto-model-efficiency',
		category: 'customization',
		severity: 'tip',
		titleKey: 'insight.autoModelEfficiency.title',
		buildBody: (ctx) => {
			const ratio = Math.round(autoModelUsageRatio(ctx.last30Days) * 100);
			return ratio > 0
				? ctx.translate('insight.autoModelEfficiency.body.some', ratio)
				: ctx.translate('insight.autoModelEfficiency.body.none');
		},
		appliesTo: (ctx) => {
			if (ctx.last30Days.sessions < 10) { return false; }
			const ratio = autoModelUsageRatio(ctx.last30Days);
			return ratio < 0.25 && ctx.last30Days.modelSwitching.totalSessions > 0;
		},
		weight: 82,
	},
	{
		id: 'foundry-local-models',
		category: 'customization',
		severity: 'celebration',
		titleKey: 'insight.foundryLocalModels.title',
		buildBody: (ctx) => {
			const sessions = ctx.last30Days.modelSwitching.foundryWindowsSessions ?? 0;
			return ctx.translate(plural('insight.foundryLocalModels.body', sessions), sessions);
		},
		appliesTo: (ctx) => (ctx.last30Days.modelSwitching.foundryWindowsSessions ?? 0) > 0,
		weight: 88,
	},
	{
		id: 'explore-model-providers',
		category: 'customization',
		severity: 'tip',
		titleKey: 'insight.exploreModelProviders.title',
		buildBody: (ctx) => ctx.translate('insight.exploreModelProviders.body'),
		actionLabelKey: 'insight.action.openExtensions',
		actionCommand: 'workbench.extensions.action.showExtensions',
		appliesTo: (ctx) => {
			if (ctx.last30Days.sessions < 10) { return false; }
			return usesOnlyDefaultModelSet(ctx.last30Days);
		},
		weight: 80,
	},

	// ── Context ─────────────────────────────────────────────────────────────
	{
		id: 'no-context-refs',
		category: 'context',
		severity: 'tip',
		titleKey: 'insight.noContextRefs.title',
		buildBody: (ctx) => {
			const sessions = ctx.last30Days.sessions;
			const total = (ctx.last30Days.contextReferences.file ?? 0)
				+ (ctx.last30Days.contextReferences.codebase ?? 0)
				+ (ctx.last30Days.contextReferences.selection ?? 0)
				+ (ctx.last30Days.contextReferences.symbol ?? 0);
			return ctx.translate(plural('insight.noContextRefs.body', total), sessions, total);
		},
		appliesTo: (ctx) => {
			if (ctx.last30Days.sessions < 10) { return false; }
			const refs = ctx.last30Days.contextReferences;
			const total = (refs.file ?? 0) + (refs.codebase ?? 0)
				+ (refs.selection ?? 0) + (refs.symbol ?? 0);
			return total < 5;
		},
		weight: 70,
	},

	// ── Agentic ─────────────────────────────────────────────────────────────
	{
		id: 'try-agent-mode',
		category: 'agentic',
		severity: 'tip',
		titleKey: 'insight.tryAgentMode.title',
		buildBody: (ctx) => {
			const editCount = ctx.last30Days.modeUsage.edit ?? 0;
			return ctx.translate(plural('insight.tryAgentMode.body', editCount), editCount);
		},
		appliesTo: (ctx) => {
			if (ctx.last30Days.sessions < 5) { return false; }
			const m = ctx.last30Days.modeUsage;
			return (m.agent ?? 0) === 0 && (m.edit ?? 0) > 3;
		},
		weight: 60,
	},

	// ── Context quality ──────────────────────────────────────────────────────
	{
		id: 'low-context-diversity',
		category: 'context',
		severity: 'opportunity',
		titleKey: 'insight.lowContextDiversity.title',
		buildBody: (ctx) => {
			const sessions = ctx.last30Days.sessions;
			const total = totalContextRefs(ctx.last30Days);
			const noContextPct = Math.round(Math.max(0, 1 - total / sessions) * 100);
			return ctx.translate('insight.lowContextDiversity.body', noContextPct, sessions);
		},
		appliesTo: (ctx) => {
			if (ctx.last30Days.sessions < 10) { return false; }
			const total = totalContextRefs(ctx.last30Days);
			return total < ctx.last30Days.sessions * 0.3;
		},
		weight: 65,
	},
	{
		id: 'only-using-file-refs',
		category: 'context',
		severity: 'tip',
		titleKey: 'insight.onlyUsingFileRefs.title',
		buildBody: (ctx) => ctx.translate('insight.onlyUsingFileRefs.body'),
		appliesTo: (ctx) => {
			const refs = ctx.last30Days.contextReferences;
			return (refs.file ?? 0) > 20 && (refs.codebase ?? 0) < 5 && (refs.selection ?? 0) < 5;
		},
		weight: 45,
	},
	{
		id: 'good-context-variety',
		category: 'context',
		severity: 'celebration',
		titleKey: 'insight.goodContextVariety.title',
		buildBody: (ctx) => {
			const refs = ctx.last30Days.contextReferences;
			const activeTypes = [
				refs.file,
				(refs.codebase ?? 0) + (refs.workspace ?? 0),
				refs.selection,
				refs.symbol,
				refs.terminal,
				refs.clipboard,
				refs.changes,
			].filter(v => (v ?? 0) > 3).length;
			return ctx.translate('insight.goodContextVariety.body', activeTypes);
		},
		appliesTo: (ctx) => {
			const refs = ctx.last30Days.contextReferences;
			const countAboveThreshold = [
				refs.file,
				(refs.codebase ?? 0) + (refs.workspace ?? 0),
				refs.selection,
				refs.symbol,
				refs.terminal,
				refs.clipboard,
				refs.changes,
			].filter(v => (v ?? 0) > 3).length;
			return countAboveThreshold >= 4;
		},
		weight: 30,
	},
	{
		id: 'conversation-depth-low',
		category: 'consistency',
		severity: 'tip',
		titleKey: 'insight.conversationDepthLow.title',
		buildBody: (ctx) => {
			const avg = ctx.last30Days.conversationPatterns.avgTurnsPerSession.toFixed(1);
			return ctx.translate('insight.conversationDepthLow.body', avg);
		},
		appliesTo: (ctx) => {
			if (ctx.last30Days.sessions < 10) { return false; }
			return ctx.last30Days.conversationPatterns.avgTurnsPerSession < 1.5;
		},
		weight: 50,
	},

	// ── Streaks / Consistency ───────────────────────────────────────────────
	{
		id: 'consistent-daily-user',
		category: 'consistency',
		severity: 'celebration',
		titleKey: 'insight.consistentDailyUser.title',
		buildBody: (ctx) => ctx.translate('insight.consistentDailyUser.body', ctx.last30Days.sessions),
		appliesTo: (ctx) => ctx.last30Days.sessions >= 25,
		weight: 45,
		allowToast: true,
	},
	{
		id: 'irregular-usage',
		category: 'consistency',
		severity: 'opportunity',
		titleKey: 'insight.irregularUsage.title',
		buildBody: (ctx) => {
			const n = ctx.last30Days.sessions;
			return ctx.translate(plural('insight.irregularUsage.body', n), n);
		},
		appliesTo: (ctx) => ctx.last30Days.sessions > 0 && ctx.last30Days.sessions < 10,
		weight: 60,
	},
	{
		id: 'mode-diversity-low',
		category: 'consistency',
		severity: 'tip',
		titleKey: 'insight.modeDiversityLow.title',
		buildBody: (ctx) => {
			const m = ctx.last30Days.modeUsage;
			const ask = m.ask ?? 0;
			const agentic = (m.agent ?? 0) + (m.plan ?? 0) + (m.customAgent ?? 0) + (m.cli ?? 0) + (m.cliApp ?? 0);
			const total = ask + (m.edit ?? 0) + agentic;
			if (total > 0 && ask > 0.85 * total) {
				return ctx.translate('insight.modeDiversityLow.body.mostlyAsk');
			}
			return ctx.translate('insight.modeDiversityLow.body.noAgent');
		},
		appliesTo: (ctx) => {
			if (ctx.last30Days.sessions < 10) { return false; }
			const m = ctx.last30Days.modeUsage;
			const ask = m.ask ?? 0;
			// Agent, Plan and Custom Agent modes and CLI interactions (terminal or
			// Copilot desktop app) are autonomous agent-mode-style usage — count them
			// as agentic, not as "ask-only".
			const agentic = (m.agent ?? 0) + (m.plan ?? 0) + (m.customAgent ?? 0) + (m.cli ?? 0) + (m.cliApp ?? 0);
			const total = ask + (m.edit ?? 0) + agentic;
			if (total < 10) { return false; }
			if (agentic > 0.15 * total) { return false; }
			return ask > 0.85 * total
				|| (agentic === 0 && total >= 15);
		},
		actionLabelKey: 'insight.action.viewInteractionModes',
		actionCommand: 'aiEngineeringFluency.openActivityTab',
		weight: 50,
	},

	// ── Tools / MCP ─────────────────────────────────────────────────────────
	{
		id: 'no-mcp-in-agent-mode',
		category: 'tools',
		severity: 'tip',
		titleKey: 'insight.noMcpInAgentMode.title',
		buildBody: (ctx) => ctx.translate('insight.noMcpInAgentMode.body'),
		appliesTo: (ctx) => {
			const m = ctx.last30Days.modeUsage;
			return (m.agent ?? 0) >= 5 && ctx.last30Days.mcpTools.total === 0;
		},
		weight: 55,
	},
	{
		id: 'mcp-tools-active',
		category: 'tools',
		severity: 'celebration',
		titleKey: 'insight.mcpToolsActive.title',
		buildBody: (ctx) => {
			const byTool = ctx.last30Days.mcpTools.byTool;
			const total = ctx.last30Days.mcpTools.total;
			let topTool: string | null = null;
			let topCount = 0;
			for (const [tool, count] of Object.entries(byTool)) {
				if (count > topCount) {
					topCount = count;
					topTool = tool;
				}
			}
			if (topTool) {
				return ctx.translate('insight.mcpToolsActive.body.topTool', friendlyToolName(topTool), topCount);
			}
			return ctx.translate('insight.mcpToolsActive.body.total', total);
		},
		appliesTo: (ctx) => ctx.last30Days.mcpTools.total >= 10,
		weight: 35,
		allowToast: false,
	},
	{
		id: 'install-extensions',
		category: 'tools',
		severity: 'tip',
		titleKey: 'insight.installExtensions.title',
		buildBody: (ctx) => ctx.translate('insight.installExtensions.body'),
		appliesTo: (ctx) => {
			if (ctx.last30Days.sessions < 10) { return false; }
			const m = ctx.last30Days.modeUsage;
			// Only show when try-agent-mode wouldn't fire (edit <= 3)
			return (m.agent ?? 0) === 0 && (m.edit ?? 0) <= 3 && ctx.last30Days.mcpTools.total === 0;
		},
		weight: 40,
	},

	// ── Conversation patterns ────────────────────────────────────────────────
	{
		id: 'mostly-single-turn',
		category: 'consistency',
		severity: 'tip',
		titleKey: 'insight.mostlySingleTurn.title',
		buildBody: (ctx) => {
			const { singleTurnSessions, multiTurnSessions } = ctx.last30Days.conversationPatterns;
			const total = singleTurnSessions + multiTurnSessions;
			const pct = total > 0 ? Math.round((singleTurnSessions / total) * 100) : 0;
			return ctx.translate('insight.mostlySingleTurn.body', pct, singleTurnSessions, total);
		},
		appliesTo: (ctx) => {
			const { singleTurnSessions, multiTurnSessions } = ctx.last30Days.conversationPatterns;
			const total = singleTurnSessions + multiTurnSessions;
			if (total < 10) { return false; }
			return singleTurnSessions / total > 0.80;
		},
		weight: 50,
	},

	// ── Trend ────────────────────────────────────────────────────────────────
	{
		id: 'sessions-trending-up',
		category: 'trend',
		severity: 'celebration',
		titleKey: 'insight.sessionsTrendingUp.title',
		buildBody: (ctx) => {
			const dailyAvg = ctx.last30Days.sessions / 30;
			const pct = Math.round((ctx.today.sessions / dailyAvg - 1) * 100);
			return ctx.translate(plural('insight.sessionsTrendingUp.body', ctx.today.sessions), ctx.today.sessions, pct, dailyAvg.toFixed(1));
		},
		appliesTo: (ctx) => {
			if (ctx.last30Days.sessions <= 0) { return false; }
			const dailyAvg = ctx.last30Days.sessions / 30;
			return ctx.today.sessions > dailyAvg * 1.3;
		},
		weight: 40,
		allowToast: true,
	},
	{
		id: 'sessions-trending-down',
		category: 'trend',
		severity: 'opportunity',
		titleKey: 'insight.sessionsTrendingDown.title',
		buildBody: (ctx) => ctx.translate('insight.sessionsTrendingDown.body'),
		appliesTo: (ctx) => {
			return ctx.last30Days.sessions > 10 && ctx.today.sessions === 0;
		},
		weight: 55,
	},
	{
		id: 'agent-mode-growth',
		category: 'trend',
		severity: 'celebration',
		titleKey: 'insight.agentModeGrowth.title',
		buildBody: (ctx) => {
			const todayTotal = ctx.today.modeUsage.ask + ctx.today.modeUsage.edit + ctx.today.modeUsage.agent;
			const last30Total = ctx.last30Days.modeUsage.ask + ctx.last30Days.modeUsage.edit + ctx.last30Days.modeUsage.agent;
			const todayPct = Math.round((ctx.today.modeUsage.agent / todayTotal) * 100);
			const last30Pct = Math.round((ctx.last30Days.modeUsage.agent / last30Total) * 100);
			return ctx.translate('insight.agentModeGrowth.body', todayPct, last30Pct);
		},
		appliesTo: (ctx) => {
			if (ctx.last30Days.modeUsage.agent <= 0 || ctx.today.modeUsage.agent <= 0) { return false; }
			const todayTotal = ctx.today.modeUsage.ask + ctx.today.modeUsage.edit + ctx.today.modeUsage.agent;
			const last30Total = ctx.last30Days.modeUsage.ask + ctx.last30Days.modeUsage.edit + ctx.last30Days.modeUsage.agent;
			if (todayTotal <= 0 || last30Total <= 0) { return false; }
			const todayShare = ctx.today.modeUsage.agent / todayTotal;
			const last30Share = ctx.last30Days.modeUsage.agent / last30Total;
			return (todayShare - last30Share) > 0.10;
		},
		weight: 45,
		allowToast: true,
	},
	{
		id: 'context-refs-trending-up',
		category: 'trend',
		severity: 'celebration',
		titleKey: 'insight.contextRefsTrendingUp.title',
		buildBody: (ctx) => {
			const todayRefs = ctx.today.contextReferences.file + ctx.today.contextReferences.codebase
				+ ctx.today.contextReferences.selection + ctx.today.contextReferences.symbol
				+ ctx.today.contextReferences.workspace + ctx.today.contextReferences.terminal
				+ ctx.today.contextReferences.vscode + ctx.today.contextReferences.implicitSelection;
			const last30Total = ctx.last30Days.contextReferences.file + ctx.last30Days.contextReferences.codebase
				+ ctx.last30Days.contextReferences.selection + ctx.last30Days.contextReferences.symbol
				+ ctx.last30Days.contextReferences.workspace + ctx.last30Days.contextReferences.terminal
				+ ctx.last30Days.contextReferences.vscode + ctx.last30Days.contextReferences.implicitSelection;
			const dailyAvg = last30Total / 30;
			const pct = Math.round((todayRefs / dailyAvg - 1) * 100);
			return ctx.translate(plural('insight.contextRefsTrendingUp.body', todayRefs), todayRefs, pct, dailyAvg.toFixed(1));
		},
		appliesTo: (ctx) => {
			const last30Total = ctx.last30Days.contextReferences.file + ctx.last30Days.contextReferences.codebase
				+ ctx.last30Days.contextReferences.selection + ctx.last30Days.contextReferences.symbol
				+ ctx.last30Days.contextReferences.workspace + ctx.last30Days.contextReferences.terminal
				+ ctx.last30Days.contextReferences.vscode + ctx.last30Days.contextReferences.implicitSelection;
			if (last30Total <= 0) { return false; }
			const dailyAvg = last30Total / 30;
			const todayTotal = ctx.today.contextReferences.file + ctx.today.contextReferences.codebase
				+ ctx.today.contextReferences.selection + ctx.today.contextReferences.symbol
				+ ctx.today.contextReferences.workspace + ctx.today.contextReferences.terminal
				+ ctx.today.contextReferences.vscode + ctx.today.contextReferences.implicitSelection;
			return todayTotal > dailyAvg * 1.4;
		},
		weight: 35,
	},

	// ── Focus & Productivity ─────────────────────────────────────────────────
	{
		id: 'productive-session-today',
		category: 'consistency',
		severity: 'celebration',
		titleKey: 'insight.productiveSessionToday.title',
		buildBody: (ctx) => {
			const best = (ctx.todaySessions ?? [])
				.filter(s => s.interactions > 20)
				.sort((a, b) => b.interactions - a.interactions)[0];
			return ctx.translate('insight.productiveSessionToday.body', best.editor, best.interactions);
		},
		appliesTo: (ctx) => {
			if (!ctx.todaySessions || ctx.todaySessions.length === 0) { return false; }
			return ctx.todaySessions.some(s => s.interactions > 20);
		},
		weight: 40,
		allowToast: true,
	},
	{
		id: 'morning-sessions-pattern',
		category: 'consistency',
		severity: 'tip',
		titleKey: 'insight.morningSessionsPattern.title',
		buildBody: (ctx) => ctx.translate('insight.morningSessionsPattern.body'),
		appliesTo: (ctx) => {
			const sessions = ctx.todaySessions ?? [];
			if (sessions.length < 3) { return false; }
			const morningSessions = sessions.filter(s => {
				if (!s.lastActivity) { return false; }
				return new Date(s.lastActivity).getHours() < 10;
			});
			return morningSessions.length >= 2;
		},
		weight: 35,
	},
	{
		id: 'short-scattered-sessions',
		category: 'consistency',
		severity: 'opportunity',
		titleKey: 'insight.shortScatteredSessions.title',
		buildBody: (ctx) => {
			const sessions = ctx.todaySessions ?? [];
			const avg = Math.round(sessions.reduce((sum, s) => sum + s.interactions, 0) / sessions.length);
			return ctx.translate('insight.shortScatteredSessions.body', sessions.length, avg);
		},
		appliesTo: (ctx) => {
			const sessions = ctx.todaySessions ?? [];
			if (sessions.length < 5) { return false; }
			const avg = sessions.reduce((sum, s) => sum + s.interactions, 0) / sessions.length;
			return avg < 5;
		},
		weight: 55,
	},

	// ── Session hygiene & compaction ─────────────────────────────────────────
	{
		id: 'marathon-session-today',
		category: 'consistency',
		severity: 'opportunity',
		titleKey: 'insight.marathonSessionToday.title',
		buildBody: (ctx) => {
			const s = biggestSessionToday(ctx);
			if (!s) { return ''; }
			const where = s.editor ? ctx.translate('insight.marathonSessionToday.inEditor', s.editor) : '';
			const turns = ctx.translate(plural('insight.shared.turns', s.interactions), s.interactions);
			const tokens = s.totalTokens > 0 ? ctx.translate('insight.marathonSessionToday.tokens', formatTokensShort(s.totalTokens)) : '';
			return ctx.translate('insight.marathonSessionToday.body', where, turns, tokens);
		},
		appliesTo: (ctx) => hasMarathonSessionToday(ctx),
		weight: 58,
		allowToast: true,
	},
	{
		id: 'very-long-sessions-pattern',
		category: 'consistency',
		severity: 'tip',
		titleKey: 'insight.veryLongSessionsPattern.title',
		buildBody: (ctx) => {
			const maxTurns = ctx.last30Days.conversationPatterns.maxTurnsInSession;
			const avg = ctx.last30Days.conversationPatterns.avgTurnsPerSession.toFixed(1);
			return ctx.translate('insight.veryLongSessionsPattern.body', maxTurns, avg);
		},
		appliesTo: (ctx) => {
			// Pattern-level insight: don't double up with the "today" marathon nudge.
			if (hasMarathonSessionToday(ctx)) { return false; }
			const cp = ctx.last30Days.conversationPatterns;
			return ctx.last30Days.sessions >= 10
				&& cp.maxTurnsInSession >= 80
				&& cp.avgTurnsPerSession >= 12;
		},
		weight: 45,
	},
	{
		id: 'frequent-manual-compaction',
		category: 'consistency',
		severity: 'celebration',
		titleKey: 'insight.frequentManualCompaction.title',
		buildBody: (ctx) => ctx.translate('insight.frequentManualCompaction.body', manualCompactCount(ctx.last30Days)),
		appliesTo: (ctx) => manualCompactCount(ctx.last30Days) >= 5,
		weight: 50,
		allowToast: true,
	},
	{
		id: 'auto-compaction-pattern',
		category: 'consistency',
		severity: 'opportunity',
		titleKey: 'insight.autoCompactionPattern.title',
		buildBody: (ctx) => {
			const stats = ctx.autoCompactionsLast7Days!;
			const n = autoCompactCount(ctx);
			return ctx.translate(plural('insight.autoCompactionPattern.body', n), n, autoCompactBreakdown(ctx, stats), compactedSessionPhrase(ctx));
		},
		appliesTo: (ctx) => autoCompactCount(ctx) > 5,
		weight: 65,
		allowToast: true,
	},
	{
		id: 'context-window-near-limit',
		category: 'context',
		severity: 'tip',
		titleKey: 'insight.contextWindowNearLimit.title',
		buildBody: (ctx) => {
			const cp = ctx.last30Days.contextPressure!;
			const n = cp.sessionsNearLimit;
			const worst = cp.worstFillPercent;
			const worstNote = worst ? ctx.translate('insight.contextWindowNearLimit.worstNote', worst) : '';
			const compacted = cp.sessionsCompacted;
			const compactedNote = compacted > 0
				? ctx.translate(plural('insight.contextWindowNearLimit.compactedNote', compacted), compacted)
				: '';
			return ctx.translate('insight.contextWindowNearLimit.body',
				n, cp.sessionsWithFillData, Math.round(CONTEXT_NEAR_LIMIT_RATIO * 100), worstNote, compactedNote);
		},
		// Always plural: `appliesTo` below only fires this insight from two
		// near-limit sessions up, so there is no one-session case to word for.
		buildActionLabel: (ctx) => ctx.translate('insight.contextWindowNearLimit.action', nearLimitSessionCount(ctx)),
		actionCommand: 'aiEngineeringFluency.showContextPressureSessions',
		appliesTo: (ctx) => {
			// Don't double up with the auto-compaction insight, which already covers
			// sessions that went past the line.
			if (autoCompactCount(ctx) > 5) { return false; }
			const cp = ctx.last30Days.contextPressure;
			return !!cp && cp.sessionsWithFillData > 0 && nearLimitSessionCount(ctx) >= 2;
		},
		weight: 60,
		allowToast: true,
	},
	{
		id: 'context-window-healthy',
		category: 'context',
		severity: 'celebration',
		titleKey: 'insight.contextWindowHealthy.title',
		buildBody: (ctx) => {
			const cp = ctx.last30Days.contextPressure!;
			const worst = cp.worstFillPercent;
			const worstNote = worst ? ctx.translate('insight.contextWindowHealthy.worstNote', worst) : '';
			return ctx.translate('insight.contextWindowHealthy.body', cp.sessionsWithFillData, worstNote);
		},
		appliesTo: (ctx) => {
			const cp = ctx.last30Days.contextPressure;
			return !!cp && cp.sessionsWithFillData >= 10
				&& compactedSessionCount(ctx) === 0
				&& nearLimitSessionCount(ctx) === 0
				&& autoCompactCount(ctx) === 0;
		},
		weight: 25,
	},

	// ── Model cost & efficiency ───────────────────────────────────────────────
	{
		id: 'high-cost-model-usage',
		category: 'agentic',
		severity: 'tip',
		titleKey: 'insight.highCostModelUsage.title',
		buildBody: (ctx) => {
			const ms = ctx.last30Days.modelSwitching;
			const pct = ms.totalRequests > 0 ? Math.round((ms.highCostRequests / ms.totalRequests) * 100) : 0;
			const models = joinNames(ctx, ms.highCostModels.slice(0, 3));
			const modelNote = models ? ctx.translate('insight.highCostModelUsage.modelNote', models) : '';
			return ctx.translate('insight.highCostModelUsage.body', pct, ms.totalRequests.toLocaleString(), modelNote);
		},
		appliesTo: (ctx) => {
			const ms = ctx.last30Days.modelSwitching;
			return ms.totalRequests >= 20
				&& (ms.highCostRequests / ms.totalRequests) > 0.70;
		},
		weight: 45,
	},

	// ── Model efficiency (edit retries, issue #1649) ──────────────────────────
	{
		id: 'model-edit-retries',
		category: 'agentic',
		severity: 'tip',
		titleKey: 'insight.modelEditRetries.title',
		buildBody: (ctx) => {
			const ranked = rankModelsByEditRetries(ctx.last30Days);
			const worst = ranked[0];
			const best = ranked.length >= 2 ? ranked[ranked.length - 1] : undefined;
			const intro = ctx.translate('insight.modelEditRetries.intro',
				modelDisplayName(worst.model), worst.retryRate.toFixed(1), worst.retries, worst.editTurns);
			if (best && best.retryRate < worst.retryRate / 2) {
				return ctx.translate('insight.modelEditRetries.body.comparison',
					intro, modelDisplayName(best.model), best.retryRate.toFixed(1));
			}
			return ctx.translate('insight.modelEditRetries.body.single', intro);
		},
		actionLabelKey: 'insight.action.viewModelEfficiency',
		actionCommand: 'aiEngineeringFluency.openModelEfficiency',
		appliesTo: (ctx) => {
			const ranked = rankModelsByEditRetries(ctx.last30Days);
			if (ranked.length === 0) { return false; }
			const worst = ranked[0];
			const best = ranked[ranked.length - 1];
			// Surface either an absolutely high retry rate, or a clear gap between models.
			return worst.retryRate >= 0.5
				|| (ranked.length >= 2 && worst.retryRate >= 0.25 && worst.retryRate >= best.retryRate * 2);
		},
		weight: 50,
	},

	// ── Efficiency trends (month over month) ──────────────────────────────────
	{
		id: 'trend-leaner-sessions',
		category: 'trend',
		severity: 'celebration',
		titleKey: 'insight.trendLeanerSessions.title',
		buildBody: (ctx) => {
			const prev = trendTurnsPerSession(ctx.lastMonth)!;
			const cur = trendTurnsPerSession(ctx.month)!;
			const pct = Math.round(((prev - cur) / prev) * 100);
			return ctx.translate('insight.trendLeanerSessions.body', cur.toFixed(1), pct, prev.toFixed(1));
		},
		actionLabelKey: 'insight.action.openEfficiencyView',
		actionCommand: 'aiEngineeringFluency.showEfficiency',
		appliesTo: (ctx) => {
			const prev = trendTurnsPerSession(ctx.lastMonth);
			const cur = trendTurnsPerSession(ctx.month);
			if (prev === null || cur === null || prev <= 0) { return false; }
			const retryPrev = trendRetryRate(ctx.lastMonth);
			const retryCur = trendRetryRate(ctx.month);
			// Celebrate only when quality did not regress alongside the drop in turns.
			const retryOk = retryPrev === null || retryCur === null || retryCur <= retryPrev * 1.1;
			return (prev - cur) / prev >= 0.15 && retryOk;
		},
		weight: 65,
		allowToast: true,
	},
	{
		id: 'trend-sessions-getting-heavier',
		category: 'trend',
		severity: 'opportunity',
		titleKey: 'insight.trendSessionsGettingHeavier.title',
		buildBody: (ctx) => {
			const prev = trendTurnsPerSession(ctx.lastMonth)!;
			const cur = trendTurnsPerSession(ctx.month)!;
			const pct = Math.round(((cur - prev) / prev) * 100);
			return ctx.translate('insight.trendSessionsGettingHeavier.body', cur.toFixed(1), pct, prev.toFixed(1));
		},
		actionLabelKey: 'insight.action.openEfficiencyView',
		actionCommand: 'aiEngineeringFluency.showEfficiency',
		appliesTo: (ctx) => {
			const prev = trendTurnsPerSession(ctx.lastMonth);
			const cur = trendTurnsPerSession(ctx.month);
			if (prev === null || cur === null || prev <= 0) { return false; }
			return (cur - prev) / prev >= 0.25;
		},
		weight: 58,
	},
	{
		id: 'retry-price-mismatch',
		category: 'trend',
		severity: 'tip',
		titleKey: 'insight.retryPriceMismatch.title',
		buildBody: (ctx) => {
			const m = findRetryPriceMismatch(ctx.last30Days)!;
			return ctx.translate('insight.retryPriceMismatch.body',
				modelDisplayName(m.worst.model), m.worst.retryRate.toFixed(1), m.priceRatio.toFixed(1),
				modelDisplayName(m.best.model), m.best.retryRate.toFixed(1));
		},
		actionLabelKey: 'insight.action.openEfficiencyView',
		actionCommand: 'aiEngineeringFluency.showEfficiency',
		appliesTo: (ctx) => findRetryPriceMismatch(ctx.last30Days) !== null,
		weight: 55,
	},

	// ── Code application habits ───────────────────────────────────────────────
	{
		id: 'low-apply-rate',
		category: 'agentic',
		severity: 'opportunity',
		titleKey: 'insight.lowApplyRate.title',
		buildBody: (ctx) => {
			const a = ctx.last30Days.applyUsage;
			return ctx.translate('insight.lowApplyRate.body', Math.round(a.applyRate), a.totalCodeBlocks);
		},
		appliesTo: (ctx) => {
			const a = ctx.last30Days.applyUsage;
			return a.totalCodeBlocks >= 20 && a.applyRate < 40;
		},
		weight: 52,
	},

	// ── Reasoning effort ─────────────────────────────────────────────────────
	{
		id: 'reasoning-effort-never-tuned',
		category: 'agentic',
		severity: 'tip',
		titleKey: 'insight.reasoningEffortNeverTuned.title',
		buildBody: (ctx) => {
			const sessions = ctx.last30Days.thinkingEffortUsage?.sessionCount ?? 0;
			return ctx.translate('insight.reasoningEffortNeverTuned.body', sessions);
		},
		appliesTo: (ctx) => {
			const eu = ctx.last30Days.thinkingEffortUsage;
			if (!eu) { return false; }
			return eu.sessionCount >= 5 && eu.switchCount === 0;
		},
		weight: 40,
	},
	{
		id: 'reasoning-effort-switcher',
		category: 'agentic',
		severity: 'celebration',
		titleKey: 'insight.reasoningEffortSwitcher.title',
		buildBody: (ctx) => {
			const eu = ctx.last30Days.thinkingEffortUsage!;
			return ctx.translate('insight.reasoningEffortSwitcher.body', eu.switchCount, eu.sessionCount);
		},
		appliesTo: (ctx) => {
			const eu = ctx.last30Days.thinkingEffortUsage;
			return !!eu && eu.sessionCount >= 3 && eu.switchCount >= 3;
		},
		weight: 30,
		allowToast: false,
	},

	// ── Multi-agent orchestration ─────────────────────────────────────────────
	{
		id: 'multi-agent-orchestration',
		category: 'agentic',
		severity: 'celebration',
		titleKey: 'insight.multiAgentOrchestration.title',
		buildBody: (ctx) => ctx.translate('insight.multiAgentOrchestration.body', ctx.last30Days.multiAgentParentSessions!),
		appliesTo: (ctx) => (ctx.last30Days.multiAgentParentSessions ?? 0) >= 3,
		weight: 35,
		allowToast: true,
	},

	// ── Sub-agent delegation (tool-call based, no hierarchy data required) ────
	{
		id: 'subagent-delegation',
		category: 'agentic',
		severity: 'celebration',
		titleKey: 'insight.subagentDelegation.title',
		buildBody: (ctx) => ctx.translate('insight.subagentDelegation.body', ctx.last30Days.delegationSessions!),
		appliesTo: (ctx) => (ctx.last30Days.delegationSessions ?? 0) >= 5 && (ctx.last30Days.multiAgentParentSessions ?? 0) < 3,
		weight: 32,
		allowToast: true,
	},

	// ── Edit scope ───────────────────────────────────────────────────────────
	{
		id: 'single-file-edits-only',
		category: 'agentic',
		severity: 'tip',
		titleKey: 'insight.singleFileEditsOnly.title',
		buildBody: (ctx) => ctx.translate('insight.singleFileEditsOnly.body', ctx.last30Days.editScope.singleFileEdits),
		appliesTo: (ctx) => {
			const es = ctx.last30Days.editScope;
			return es.singleFileEdits >= 10
				&& es.multiFileEdits === 0;
		},
		weight: 42,
	},

	// ── Context-window health ─────────────────────────────────────────────────
	{
		id: 'session-context-truncated',
		category: 'context',
		severity: 'opportunity',
		titleKey: 'insight.sessionContextTruncated.title',
		buildBody: (ctx) => {
			const truncated = (ctx.todaySessions ?? []).filter(s => (s.truncationCount ?? 0) > 0);
			const count = truncated.length;
			const totalRemoved = truncated.reduce((sum, s) => sum + (s.truncationCount ?? 0), 0);
			// Two independently-varying counts, so the sentence needs a key per
			// combination rather than one key with two interpolated noun phrases —
			// which locales with case agreement could not render correctly.
			const sessionForm = count === 1 ? 'oneSession' : 'otherSessions';
			const eventForm = totalRemoved === 1 ? 'oneEvent' : 'otherEvents';
			return ctx.translate(`insight.sessionContextTruncated.body.${sessionForm}.${eventForm}`, count, totalRemoved);
		},
		appliesTo: (ctx) => {
			return (ctx.todaySessions ?? []).some(s => (s.truncationCount ?? 0) > 0);
		},
		weight: 75,
		allowToast: true,
	},
	{
		id: 'long-context-pricing-crossed',
		category: 'context',
		severity: 'opportunity',
		titleKey: 'insight.longContextPricingCrossed.title',
		buildBody: (ctx) => {
			const crossed = _longContextCrossedToday(ctx);
			if (crossed) {
				const { session, info, model } = crossed;
				const ratio = info.defaultInputCostPerMillion > 0
					? (info.longContextInputCostPerMillion / info.defaultInputCostPerMillion).toFixed(1)
					: null;
				const rateNote = ratio
					? ctx.translate('insight.longContextPricingCrossed.rateNote',
						info.defaultInputCostPerMillion.toFixed(2), info.longContextInputCostPerMillion.toFixed(2), ratio)
					: '';
				return ctx.translate('insight.longContextPricingCrossed.body.crossed',
					formatTokensShort(session.maxRequestInputTokens ?? 0), model,
					formatTokensShort(info.thresholdTokens), rateNote,
					_describeDefaultTierCapacity(ctx, info.thresholdTokens));
			}
			const tiered = (ctx.todaySessions ?? []).find(s => _isNonDefaultTier(s) && !_qualifiesWindowUnused(s));
			return ctx.translate('insight.longContextPricingCrossed.body.tierOnly', tiered?.contextTier ?? '');
		},
		appliesTo: (ctx) => {
			// Tier-only sessions whose window usage proves the big window was
			// never needed are handled by large-context-window-unused instead.
			return _longContextCrossedToday(ctx) !== null
				|| (ctx.todaySessions ?? []).some(s => _isNonDefaultTier(s) && !_qualifiesWindowUnused(s));
		},
		weight: 74,
		allowToast: true,
	},
	{
		id: 'large-context-window-unused',
		category: 'context',
		severity: 'tip',
		titleKey: 'insight.largeContextWindowUnused.title',
		buildBody: (ctx) => {
			const s = _windowUnusedToday(ctx);
			if (!s) { return ''; }
			const reached = s.contextReachedTokens ?? 0;
			const tier = _sessionLongContextStatus(s);
			const limitNote = s.contextWindowLimit
				? ctx.translate('insight.largeContextWindowUnused.limitNote', formatTokensShort(s.contextWindowLimit))
				: '';
			const comparison = tier
				? ctx.translate('insight.largeContextWindowUnused.comparison.threshold', formatTokensShort(tier.info.thresholdTokens), tier.model)
				: ctx.translate('insight.largeContextWindowUnused.comparison.percent', Math.round((reached / (s.contextWindowLimit || reached)) * 100));
			return ctx.translate('insight.largeContextWindowUnused.body',
				s.contextTier ?? '', limitNote, formatTokensShort(reached), comparison);
		},
		appliesTo: (ctx) => _windowUnusedToday(ctx) !== null,
		weight: 52,
	},
	{
		id: 'long-context-headroom',
		category: 'context',
		severity: 'tip',
		titleKey: 'insight.longContextHeadroom.title',
		buildBody: (ctx) => {
			const largest = _largestTieredRequestToday(ctx);
			if (!largest) { return ''; }
			const { session, info, model } = largest;
			const max = session.maxRequestInputTokens ?? 0;
			const pct = Math.round((max / info.thresholdTokens) * 100);
			return ctx.translate('insight.longContextHeadroom.body',
				formatTokensShort(max), pct, formatTokensShort(info.thresholdTokens), model,
				info.defaultInputCostPerMillion.toFixed(2), info.longContextInputCostPerMillion.toFixed(2),
				_describeDefaultTierCapacity(ctx, info.thresholdTokens));
		},
		appliesTo: (ctx) => {
			// Don't double up with the crossed insight.
			if (_longContextCrossedToday(ctx) !== null) { return false; }
			const largest = _largestTieredRequestToday(ctx);
			if (!largest) { return false; }
			const max = largest.session.maxRequestInputTokens ?? 0;
			return max >= largest.info.thresholdTokens * 0.7 && max <= largest.info.thresholdTokens;
		},
		weight: 48,
	},

	// ── Tool Curation ─────────────────────────────────────────────────────────
	{
		id: 'unused-mcp-servers',
		category: 'tools',
		severity: 'opportunity',
		titleKey: 'insight.unusedMcpServers.title',
		buildBody: (ctx) => {
			const unused = ctx.curationAnalysis?.underusedMcpServers.filter(s => s.usedToolCount === 0) ?? [];
			const names = joinNames(ctx, unused.slice(0, 3).map(s => ctx.translate('insight.shared.quoted', s.server)));
			const tokens = ctx.curationAnalysis?.estimatedPromptBloat.totalTokens ?? 0;
			const tokenNote = tokens > 0 ? ctx.translate('insight.unusedMcpServers.tokenNote', tokens.toLocaleString()) : '';
			const hasExtensionServers = unused.some(s => s.extensionId);
			const hasFileServers = unused.some(s => !s.extensionId);
			let howToDisable: string;
			if (hasExtensionServers && hasFileServers) {
				howToDisable = ctx.translate('insight.unusedMcpServers.howTo.both');
			} else if (hasExtensionServers) {
				howToDisable = ctx.translate('insight.unusedMcpServers.howTo.extensions');
			} else {
				howToDisable = ctx.translate('insight.unusedMcpServers.howTo.file');
			}
			return ctx.translate(plural('insight.unusedMcpServers.body', unused.length),
				unused.length, names, moreSuffix(ctx, unused.length, 3),
				ctx.curationAnalysis?.windowDays ?? 30, tokenNote, howToDisable);
		},
		buildActionLabel: (ctx) => {
			const unused = ctx.curationAnalysis?.underusedMcpServers.filter(s => s.usedToolCount === 0) ?? [];
			const allExtension = unused.length > 0 && unused.every(s => s.extensionId);
			return ctx.translate(allExtension ? 'insight.action.manageMcpExtensions' : 'insight.action.openMcpJson');
		},
		actionCommand: (ctx) => {
			const unused = ctx.curationAnalysis?.underusedMcpServers.filter(s => s.usedToolCount === 0) ?? [];
			const allExtension = unused.length > 0 && unused.every(s => s.extensionId);
			return allExtension ? 'searchMcpExtensions' : 'aiEngineeringFluency.openMcpJson';
		},
		appliesTo: (ctx) => {
			if (!ctx.curationAnalysis) { return false; }
			return ctx.curationAnalysis.underusedMcpServers.some(s => s.usedToolCount === 0);
		},
		weight: 70,
	},
	{
		id: 'high-prompt-bloat',
		category: 'tools',
		severity: 'opportunity',
		titleKey: 'insight.highPromptBloat.title',
		buildBody: (ctx) => {
			const tokens = ctx.curationAnalysis?.estimatedPromptBloat.totalTokens ?? 0;
			const unusedCount = ctx.curationAnalysis?.unusedTools.length ?? 0;
			return ctx.translate(plural('insight.highPromptBloat.body', unusedCount),
				tokens.toLocaleString(), unusedCount, ctx.curationAnalysis?.windowDays ?? 30);
		},
		actionLabelKey: 'insight.action.viewToolCuration',
		actionCommand: 'aiEngineeringFluency.openToolsTab',
		appliesTo: (ctx) => {
			if (!ctx.curationAnalysis) { return false; }
			return ctx.curationAnalysis.estimatedPromptBloat.totalTokens > 2500;
		},
		weight: 65,
	},
	{
		id: 'stale-skills',
		category: 'customization',
		severity: 'tip',
		titleKey: 'insight.staleSkills.title',
		buildBody: (ctx) => {
			const stale = ctx.curationAnalysis?.unusedTools.filter(t => t.source === 'skill') ?? [];
			const names = joinNames(ctx, stale.slice(0, 3).map(s => ctx.translate('insight.shared.quoted', s.name)));
			return ctx.translate(plural('insight.staleSkills.body', stale.length),
				stale.length, names, moreSuffix(ctx, stale.length, 3), ctx.curationAnalysis?.windowDays ?? 30);
		},
		actionLabelKey: 'insight.action.viewToolCuration',
		actionCommand: 'aiEngineeringFluency.openToolsTab',
		appliesTo: (ctx) => {
			if (!ctx.curationAnalysis) { return false; }
			const stale = ctx.curationAnalysis.unusedTools.filter(t => t.source === 'skill');
			return stale.length >= 1;
		},
		weight: 40,
	},
	{
		id: 'stale-memory-files',
		category: 'customization',
		severity: 'tip',
		titleKey: 'insight.staleMemoryFiles.title',
		buildBody: (ctx) => {
			const analysis = ctx.memoryFilesAnalysis;
			const staleCount = analysis?.staleFileCount ?? 0;
			const largeCount = analysis?.largeFileCount ?? 0;
			const parts: string[] = [];
			if (staleCount > 0) {
				parts.push(ctx.translate(plural('insight.staleMemoryFiles.stale', staleCount), staleCount, analysis?.staleDays ?? 90));
			}
			if (largeCount > 0) {
				parts.push(ctx.translate(plural('insight.staleMemoryFiles.large', largeCount), largeCount, Math.round((analysis?.largeFileBytes ?? 0) / 1024)));
			}
			return ctx.translate('insight.staleMemoryFiles.body', parts.join(ctx.translate('insight.shared.and')));
		},
		appliesTo: (ctx) => {
			const analysis = ctx.memoryFilesAnalysis;
			if (!analysis) { return false; }
			return analysis.staleFileCount > 0 || analysis.largeFileCount > 0;
		},
		weight: 25,
	},

	// ── Corrections ─────────────────────────────────────────────────────────
	{
		id: 'corrections-user-pushback',
		category: 'customization',
		severity: 'opportunity',
		titleKey: 'insight.correctionsUserPushback.title',
		buildBody: (ctx) => {
			const c = ctx.last30Days.corrections;
			const count = c?.userCorrections ?? 0;
			const sessions = c?.sessionsWithUserCorrections ?? Math.min(count, c?.sessionsWithMoments ?? 0);
			const sessionForm = sessions === 1 ? 'oneSession' : 'otherSessions';
			const countForm = count === 1 ? 'oneCorrection' : 'otherCorrections';
			return ctx.translate(`insight.correctionsUserPushback.body.${countForm}.${sessionForm}`, count, sessions);
		},
		actionLabelKey: 'insight.action.viewCorrections',
		actionCommand: 'aiEngineeringFluency.openCorrectionsTab',
		secondaryActionLabelKey: 'insight.action.askCopilotToFix',
		secondaryActionCommand: 'aiEngineeringFluency.askCopilotAboutCorrections',
		appliesTo: (ctx) => (ctx.last30Days.corrections?.userCorrections ?? 0) >= 3,
		weight: 70,
	},
	{
		id: 'corrections-tool-errors',
		category: 'tools',
		severity: 'tip',
		titleKey: 'insight.correctionsToolErrors.title',
		buildBody: (ctx) => {
			const c = ctx.last30Days.corrections;
			const errors = c?.toolErrors ?? 0;
			const editRetries = (c?.editRetries ?? 0) + (c?.editSelfCorrections ?? 0);
			const errorForm = errors === 1 ? 'oneError' : 'otherErrors';
			const retryForm = editRetries === 1 ? 'oneRetry' : 'otherRetries';
			return ctx.translate(`insight.correctionsToolErrors.body.${errorForm}.${retryForm}`, errors, editRetries);
		},
		actionLabelKey: 'insight.action.viewCorrections',
		actionCommand: 'aiEngineeringFluency.openCorrectionsTab',
		appliesTo: (ctx) => {
			const c = ctx.last30Days.corrections;
			if (!c) { return false; }
			return c.toolErrors >= 5 || (c.editRetries + c.editSelfCorrections) >= 10;
		},
		weight: 55,
	},
	{
		id: 'corrections-user-escalation',
		category: 'customization',
		severity: 'opportunity',
		titleKey: 'insight.correctionsUserEscalation.title',
		buildBody: (ctx) => {
			const c = ctx.last30Days.corrections;
			const escalated = c?.escalatedUserCorrections ?? 0;
			const sessions = c?.sessionsWithEscalations ?? 0;
			const escalatedForm = escalated === 1 ? 'oneCorrection' : 'otherCorrections';
			const sessionForm = sessions === 1 ? 'oneSession' : 'otherSessions';
			return ctx.translate(`insight.correctionsUserEscalation.body.${escalatedForm}.${sessionForm}`, escalated, sessions);
		},
		actionLabelKey: 'insight.action.viewCorrections',
		actionCommand: 'aiEngineeringFluency.openCorrectionsTab',
		appliesTo: (ctx) => (ctx.last30Days.corrections?.escalatedUserCorrections ?? 0) >= 2,
		weight: 60,
	},
	{
		id: 'repeated-task-skill-candidate',
		category: 'customization',
		severity: 'opportunity',
		titleKey: 'insight.repeatedTaskSkillCandidate.title',
		buildBody: (ctx) => {
			const top = ctx.repeatedTasks?.clusters[0];
			const count = top?.sessionCount ?? 0;
			const prompt = top?.representativePrompt ?? '';
			const more = (ctx.repeatedTasks?.clusters.length ?? 1) - 1;
			const tail = more > 0
				? ctx.translate(plural('insight.repeatedTaskSkillCandidate.more', more), more)
				: ctx.translate('insight.repeatedTaskSkillCandidate.seeDetails');
			return ctx.translate('insight.repeatedTaskSkillCandidate.body', count, prompt, tail);
		},
		actionLabelKey: 'insight.action.viewSkillSuggestions',
		actionCommand: 'aiEngineeringFluency.openToolsTab',
		appliesTo: (ctx) => (ctx.repeatedTasks?.clusters[0]?.sessionCount ?? 0) >= 3,
		weight: 60,
	},
];

// ---------------------------------------------------------------------------
// Core evaluation functions (all pure)
// ---------------------------------------------------------------------------

/** Returns all applicable, non-dismissed insights, sorted by weight descending. */
export function evaluateInsights(
	ctx: InsightContext,
	stateBag: InsightStateBag,
	cadenceDays: number,
	lastNudgeAt: string | null,
): EvaluatedInsight[] {
	const now = new Date().toISOString();
	return INSIGHT_CATALOG
		.filter(def => def.appliesTo(ctx))
		.sort((a, b) => b.weight - a.weight)
		.map(def => {
			const existing = stateBag[def.id];
			const status = resolveStatus(existing, cadenceDays, lastNudgeAt, now);
			return {
				id: def.id,
				category: def.category,
				severity: def.severity,
				title: ctx.translate(def.titleKey),
				body: def.buildBody(ctx),
				actionLabel: def.buildActionLabel
					? def.buildActionLabel(ctx)
					: def.actionLabelKey === undefined ? undefined : ctx.translate(def.actionLabelKey),
				actionCommand: typeof def.actionCommand === 'function' ? def.actionCommand(ctx) : def.actionCommand,
				secondaryActionLabel: def.secondaryActionLabelKey === undefined ? undefined : ctx.translate(def.secondaryActionLabelKey),
				secondaryActionCommand: typeof def.secondaryActionCommand === 'function' ? def.secondaryActionCommand(ctx) : def.secondaryActionCommand,
				status,
				allowToast: def.allowToast,
			};
		})
		.filter(i => i.status !== 'dismissed');
}

/**
 * Merges newly evaluated insights into the state bag.
 * - Applicable, unseen insights get status 'new'.
 * - Existing states are preserved (seen/snoozed/done/dismissed).
 * - Insights that no longer apply are left in the bag untouched.
 * Returns the updated (mutated) bag.
 */
export function mergeInsightStates(
	evaluated: EvaluatedInsight[],
	stateBag: InsightStateBag,
	now: string,
): InsightStateBag {
	for (const insight of evaluated) {
		const existing = stateBag[insight.id];
		if (!existing) {
			stateBag[insight.id] = {
				status: 'new',
				firstSurfacedAt: now,
				lastSurfacedAt: now,
			};
		} else if (existing.status === 'new' || existing.status === 'seen') {
			// Refresh the lastSurfacedAt timestamp
			existing.lastSurfacedAt = now;
		}
	}
	return stateBag;
}

/** Counts insights with status 'new' (not snoozed, not dismissed). */
export function countNewInsights(stateBag: InsightStateBag, now: string): number {
	return Object.values(stateBag).filter(s => {
		if (s.status !== 'new') { return false; }
		if (s.snoozeUntil && s.snoozeUntil > now) { return false; }
		return true;
	}).length;
}

/**
 * Returns true when a toast notification is allowed.
 * Toast cadence: at most one per cadenceDays days.
 */
export function isToastAllowed(cadenceDays: number, lastNudgeAt: string | null, now: string): boolean {
	if (!lastNudgeAt) { return true; }
	const msSinceLastNudge = new Date(now).getTime() - new Date(lastNudgeAt).getTime();
	const msPerDay = 24 * 60 * 60 * 1000;
	return msSinceLastNudge >= cadenceDays * msPerDay;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function resolveStatus(
	existing: InsightState | undefined,
	cadenceDays: number,
	lastNudgeAt: string | null,
	now: string,
): InsightStatus {
	if (!existing) {
		return 'new';
	}
	// Respect terminal states
	if (existing.status === 'dismissed' || existing.status === 'done') {
		return existing.status;
	}
	// Check snooze expiry
	if (existing.status === 'snoozed') {
		if (existing.snoozeUntil && existing.snoozeUntil <= now) {
			// Snooze expired — resurface
			if (isToastAllowed(cadenceDays, lastNudgeAt, now)) {
				return 'new';
			}
			return 'seen';
		}
		return 'snoozed';
	}
	return existing.status;
}
