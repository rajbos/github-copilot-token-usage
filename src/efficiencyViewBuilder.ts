/**
 * Assembles the Efficiency view's payload (`window.__INITIAL_EFFICIENCY__`) from
 * already-gathered inputs.
 *
 * This is the one place that payload is built: the VS Code extension and the
 * desktop app (through the CLI's Node-side collectors) both call
 * {@link buildEfficiencyViewData}, and differ only in how they gather the
 * inputs and in host settings. Keeping assembly here, rather than inside a host,
 * is what stops a field the view needs from reaching one host and not the other
 * (see #2304, #2316).
 *
 * Pure: no `vscode`, no filesystem, no caching. The calculations themselves live
 * in `efficiencyAnalysis.ts`.
 */
import type { DailyTokenStats, ModelUsage, SessionFileCache, SessionUsageAnalysis, UsageAnalysisStats } from './types';
import { preferActualTokens } from './statsHelpers';
import {
	buildEfficiencyTrends,
	buildSkillUsageTrends,
	computeCostAttribution,
	computeEfficiencyDeltas,
	computeSkillImpact,
	computeValueSignals,
	getTrailingWindowBoundaries,
	listComparableModels,
	listEfficiencyEditors,
	resolveEfficiencyRange,
	splitModelDayByEditor,
	splitTrailingWindows,
	toEfficiencyDailyVolume,
	type EfficiencyDailyVolume,
	type EfficiencyDeps,
	type EfficiencySessionInput,
	type EfficiencyViewData,
	type ModelDailyInput,
	type PeriodVolumeTotals,
	type ValueSignalsInput,
} from './efficiencyAnalysis';

/**
 * Weeks of session logs walked for the Efficiency view's behavioural inputs
 * (duration, retries, applies, skills). Shorter than the year of daily volume
 * aggregates because it costs a full session-file scan — longer time presets
 * therefore show behavioural gaps rather than invented values.
 */
export const EFFICIENCY_BEHAVIOR_WEEKS = 12;

/**
 * The slice of a session's usage analysis the Efficiency view reads. `editScope` is the
 * lines-of-code fallback buildSessionEfficiencyAttribution() uses for deletion-only sessions,
 * which carry no top-level LOC (see sessionLocFromUsageAnalysis).
 */
export type EfficiencySessionAnalysis = Pick<SessionUsageAnalysis, 'modelEfficiency' | 'sessionDuration' | 'applyUsage' | 'skillCalls' | 'editScope'>;

/** The session fields {@link toEfficiencySessionInput} reads; a `SessionFileCache` satisfies it. */
export type EfficiencySessionSource = Pick<SessionFileCache, 'interactions' | 'tokens' | 'actualTokens'> & {
	usageAnalysis?: Partial<EfficiencySessionAnalysis>;
};

/**
 * Maps one session to the pure-module input shape for efficiency trends.
 * `dayKey` is the local day of the session's last activity.
 */
export function toEfficiencySessionInput(session: EfficiencySessionSource, dayKey: string, editor?: string): EfficiencySessionInput {
	const ua = session.usageAnalysis;
	let editTurns = 0, retries = 0;
	for (const c of Object.values(ua?.modelEfficiency ?? {})) { editTurns += c.editTurns; retries += c.retries; }
	const skillCalls = ua?.skillCalls?.byName && Object.keys(ua.skillCalls.byName).length > 0
		? ua.skillCalls.byName
		: undefined;
	return {
		dayKey,
		activeDurationMs: ua?.sessionDuration?.activeDurationMs,
		editTurns,
		retries,
		applies: ua?.applyUsage?.totalApplies,
		codeBlocks: ua?.applyUsage?.totalCodeBlocks,
		interactions: session.interactions,
		totalTokens: preferActualTokens(session.actualTokens, session.tokens),
		skillCalls,
		editor,
	};
}

/** Sums token/session/cost totals for the daily entries within one calendar month (YYYY-MM). */
export function monthVolumeTotals(dailyStats: DailyTokenStats[], monthKey: string, deps: EfficiencyDeps): PeriodVolumeTotals {
	let tokens = 0, sessions = 0, estimatedCost = 0;
	for (const day of dailyStats) {
		if (day.date.slice(0, 7) !== monthKey) { continue; }
		tokens += day.tokens;
		sessions += day.sessions;
		estimatedCost += deps.calculateEstimatedCost(day.modelUsage, 'copilot');
	}
	return { tokens, sessions, estimatedCost };
}

/**
 * Trims the daily stats down to the per-model slice the Models tab needs, over
 * the last year so month-vs-month comparisons have history to draw on. Days
 * without per-model data are dropped to keep the webview payload small.
 */
export function buildModelDailyPayload(dailyStats: DailyTokenStats[], now: Date): ModelDailyInput[] {
	// Same snapped cutoff as the volume payload: the 1-year preset starts on
	// the first of the month, so a flat 365-day window would leave the drift
	// chart's earliest bucket short of up to a month of data.
	const cutoffKey = resolveEfficiencyRange('last1y', now).startKey;
	const payload: ModelDailyInput[] = [];
	for (const day of dailyStats) {
		if (day.date < cutoffKey || !day.modelEfficiency || Object.keys(day.modelEfficiency).length === 0) { continue; }
		const split = splitModelDayByEditor(day);
		payload.push(...(split.length > 0 ? split : [{
			date: day.date,
			modelEfficiency: day.modelEfficiency,
			...(day.taskCategoryUsage ? { taskCategoryUsage: day.taskCategoryUsage } : {}),
		}]));
	}
	return payload;
}

/**
 * Compact per-day volume aggregates for the trailing year — the payload the
 * Efficiency view's time presets, drill-down and editor filter recompute
 * from. Numbers only: no session titles, paths, prompts or repositories.
 */
export function buildEfficiencyDailyVolumePayload(dailyStats: DailyTokenStats[], now: Date, deps: EfficiencyDeps): EfficiencyDailyVolume[] {
	// Cut off at the start of the widest preset rather than a flat day count:
	// the 1-year preset snaps back to the first of the month, so a plain
	// 365-day window would leave its earliest month half-empty.
	const cutoffKey = resolveEfficiencyRange('last1y', now).startKey;
	return toEfficiencyDailyVolume(dailyStats.filter(d => d.date >= cutoffKey), deps);
}

/** Everything {@link buildEfficiencyViewData} needs; hosts differ only in how they gather it. */
export interface EfficiencyViewInputs {
	/** Daily stats over (at least) the trailing year, oldest first. */
	dailyStats: DailyTokenStats[];
	usage: UsageAnalysisStats;
	sessionInputs: EfficiencySessionInput[];
	now: Date;
	calculateEstimatedCost: (modelUsage: ModelUsage, pricingSource: 'provider' | 'copilot') => number;
	/** The PR half of the Value metrics. Null counts render as the "PRs never loaded" hint. */
	prValueInputs: Pick<ValueSignalsInput, 'userPrs' | 'mergedPrs' | 'aiPrs' | 'prsSince'>;
	/** Formats one Cost Attribution window boundary in the host's display language. */
	formatAttributionDate: (date: Date) => string;
	backendConfigured: boolean;
	compactNumbers: boolean;
	isDebugMode: boolean;
}

/** No PR data: the Value tab shows its "load repository PRs" hint instead of zeroes. */
export const NO_PR_VALUE_INPUTS: EfficiencyViewInputs['prValueInputs'] = { userPrs: null, mergedPrs: null, aiPrs: null, prsSince: null };

/** Formats a Cost Attribution boundary in US English — the fallback for hosts without a display language. */
export function formatAttributionDateEnUs(date: Date): string {
	return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function monthKeyOf(d: Date): string {
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Builds the Efficiency view's payload from gathered inputs. */
export function buildEfficiencyViewData(inputs: EfficiencyViewInputs): EfficiencyViewData {
	const { dailyStats, usage, sessionInputs, now } = inputs;
	const deps: EfficiencyDeps = { calculateEstimatedCost: inputs.calculateEstimatedCost, now };
	const weekly = buildEfficiencyTrends(dailyStats, sessionInputs, deps);
	const modelDaily = buildModelDailyPayload(dailyStats, now);
	const dailyVolume = buildEfficiencyDailyVolumePayload(dailyStats, now, deps);
	const skillTrends = buildSkillUsageTrends(sessionInputs, deps);
	const skillImpact = computeSkillImpact(sessionInputs);
	const { prevDays, curDays } = splitTrailingWindows(dailyStats, now);
	const attributionBoundaries = getTrailingWindowBoundaries(now);
	const attribution = computeCostAttribution(prevDays, curDays, deps);
	const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
	const deltas = computeEfficiencyDeltas(
		usage.month, usage.lastMonth,
		monthVolumeTotals(dailyStats, monthKeyOf(now), deps),
		monthVolumeTotals(dailyStats, monthKeyOf(lastMonthDate), deps),
	);
	const curCost = curDays.reduce((s, d) => s + inputs.calculateEstimatedCost(d.modelUsage, 'copilot'), 0);
	const curLoc = curDays.reduce((s, d) => s + (d.linesAdded ?? 0) + (d.linesRemoved ?? 0), 0);
	const value = computeValueSignals({
		...inputs.prValueInputs,
		periodCost: curCost,
		applyUsage: usage.last30Days.applyUsage,
		linesChanged: curLoc,
		now,
	});
	const fmt = inputs.formatAttributionDate;
	return {
		weekly,
		hasLoc: weekly.some(w => w.loc > 0),
		hasDuration: weekly.some(w => w.activeMinutesPerSession !== null),
		hasRetry: weekly.some(w => w.retryRate !== null),
		hasApply: weekly.some(w => w.applyRate !== null),
		attribution,
		attributionWindows: {
			prev: 'previous 30 days',
			cur: 'last 30 days',
			prevRange: `${fmt(attributionBoundaries.prevStart)}–${fmt(attributionBoundaries.prevEnd)}`,
			curRange: `${fmt(attributionBoundaries.curStart)}–${fmt(attributionBoundaries.curEnd)}`,
		},
		deltas,
		deltaWindows: {
			prev: lastMonthDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
			cur: `${now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })} (to date)`,
		},
		value,
		skillTrends,
		skillImpact,
		hasSkills: skillTrends.totalCalls > 0,
		modelDaily,
		hasModelComparison: listComparableModels(modelDaily).filter(m => m.sampleSufficient).length >= 2,
		dailyVolume,
		sessionSamples: sessionInputs,
		editors: listEfficiencyEditors(dailyVolume),
		behaviorWindowDays: EFFICIENCY_BEHAVIOR_WEEKS * 7,
		cacheBreakage: usage.last30Days.cacheBreakage ?? null,
		lastUpdated: now.toISOString(),
		backendConfigured: inputs.backendConfigured,
		compactNumbers: inputs.compactNumbers,
		// Same detected locale the Usage Analysis view formats with, so both
		// views group numbers and place currency symbols identically.
		locale: usage.locale,
		isDebugMode: inputs.isDebugMode,
	};
}
