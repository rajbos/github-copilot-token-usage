/**
 * Shared payload factory functions for CLI command JSON output.
 *
 * Each command emits a specific JSON shape; these helpers centralise the
 * construction so that the `all` command (which bundles every view into one
 * response) and the individual commands stay in sync automatically.
 */
import type { DetailedStats, UsageAnalysisStats, UsageAnalysisPeriod } from '../../../src/types';
import { buildUsageAnalysisViewData } from '../../../src/usageAnalysisViewBuilder';
import { standaloneUsageAnalysisViewInputs } from '../usageAnalysisView';
import { createEmptyUsageAnalysisPeriod } from '../analysis';

// ---------------------------------------------------------------------------
// Empty-state payloads (returned when no session files are discovered)
// ---------------------------------------------------------------------------

/** Empty details/usage payload (no session files found). */
export function createEmptyDetailsPayload(now = new Date()) {
	return {
		today: {}, month: {}, lastMonth: {}, last30Days: {},
		lastUpdated: now.toISOString(), backendConfigured: false,
	};
}

/** Empty chart payload — built by the shared chart builder, see analysis.ts. */
export { createEmptyChartPayload } from '../analysis';

/**
 * Empty usage-analysis payload (no session files found): the same shared builder over empty
 * stats, so the zero-state response carries every field the view reads instead of a
 * hand-written subset.
 */
export function createEmptyUsageAnalysisPayload(now = new Date()) {
	return createUsageAnalysisPayload({
		today: createEmptyUsageAnalysisPeriod(),
		last30Days: createEmptyUsageAnalysisPeriod(),
		month: createEmptyUsageAnalysisPeriod(),
		lastMonth: createEmptyUsageAnalysisPeriod(),
		lastUpdated: now,
	}, now);
}

/** Empty fluency/maturity payload (no session files found). */
export function createEmptyFluencyPayload() {
	return {};
}

// ---------------------------------------------------------------------------
// Full payloads (returned when session files are present)
// ---------------------------------------------------------------------------

/** Full details/usage payload built from computed stats. */
export function createDetailsPayload(stats: DetailedStats) {
	return {
		today:      stats.today,
		month:      stats.month,
		lastMonth:  stats.lastMonth,
		last30Days: stats.last30Days,
		lastUpdated: stats.lastUpdated.toISOString(),
		backendConfigured: false,
	};
}

/**
 * Full usage-analysis payload: the shared `buildUsageAnalysisViewData()` the extension and
 * desktop app use, over stats from `withUsageAnalysisViewStats()`. Fields the view does not
 * read but CLI consumers do (`recentSessions`, `agenticDailyTrend`, …) pass through from
 * the stats.
 * Intentionally machine-readable: each period may carry an optional `autonomyUsage`
 * ({ autonomous, supervised, plan, other } prompt counts); it is absent when no session reported a mode.
 */
export function createUsageAnalysisPayload(stats: UsageAnalysisStats, now = new Date()) {
	const locale = Intl.DateTimeFormat().resolvedOptions().locale;
	return {
		...stats,
		...buildUsageAnalysisViewData({ ...stats, lastUpdated: now }, standaloneUsageAnalysisViewInputs(locale)),
	};
}

/** Full fluency/maturity payload built from scored results. */
export function createFluencyPayload(scores: {
	overallStage: number;
	overallLabel: string;
	categories: { category: string; icon: string; stage: number; evidence: string[]; tips: string[] }[];
	period: UsageAnalysisPeriod;
	lastUpdated: string;
}) {
	return {
		overallStage: scores.overallStage,
		overallLabel: scores.overallLabel,
		categories:   scores.categories,
		period:       scores.period,
		lastUpdated:  scores.lastUpdated,
		backendConfigured: false,
	};
}
