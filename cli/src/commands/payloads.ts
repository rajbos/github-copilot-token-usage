/**
 * Shared payload factory functions for CLI command JSON output.
 *
 * Each command emits a specific JSON shape; these helpers centralise the
 * construction so that the `all` command (which bundles every view into one
 * response) and the individual commands stay in sync automatically.
 */
import type { DetailedStats, UsageAnalysisStats, UsageAnalysisPeriod } from '../../../src/types';

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

/** Empty chart payload (no session files found). */
export function createEmptyChartPayload(now = new Date()) {
	return {
		labels: [], tokensData: [], sessionsData: [], modelDatasets: [],
		editorDatasets: [], editorTotalsMap: {}, repositoryDatasets: [],
		repositoryTotalsMap: {}, dailyCount: 0, totalTokens: 0,
		avgTokensPerDay: 0, totalSessions: 0,
		lastUpdated: now.toISOString(), backendConfigured: false,
	};
}

/** Empty usage-analysis payload (no session files found). */
export function createEmptyUsageAnalysisPayload(now = new Date()) {
	return {
		today: {}, last30Days: {}, month: {}, lastMonth: {},
		locale: Intl.DateTimeFormat().resolvedOptions().locale,
		lastUpdated: now.toISOString(), backendConfigured: false,
	};
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
 * Full usage-analysis payload built from computed stats.
 * Intentionally machine-readable: each period may carry an optional `autonomyUsage`
 * ({ autonomous, supervised, plan, other } prompt counts); it is absent when no session reported a mode.
 */
export function createUsageAnalysisPayload(stats: UsageAnalysisStats, now = new Date()) {
	return {
		...stats,
		locale: Intl.DateTimeFormat().resolvedOptions().locale,
		lastUpdated: now.toISOString(),
		backendConfigured: false,
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
