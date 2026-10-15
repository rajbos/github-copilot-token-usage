import type { DetailedStats, PeriodStats } from '../../src/types';

/**
 * Periods the Fluency Score "My AI Coding Toolbox" card can honestly show. These are exactly the
 * windows the extension aggregates over every session file (not the capped diagnostics file set),
 * so each figure covers the whole period it is labelled with.
 */
export type ShareCardPeriodId = 'today' | 'last30' | 'currentMonth' | 'lastMonth';

export interface ShareCardPeriodData {
	period: ShareCardPeriodId;
	sessions: number;
	interactions: number;
	tokens: number;
	/** Editors with activity in the period, busiest first. */
	editors: Array<{ name: string; sessions: number }>;
}

function toPeriodData(period: ShareCardPeriodId, stats: PeriodStats): ShareCardPeriodData {
	const editors = Object.entries(stats.editorUsage ?? {})
		.map(([name, usage]) => ({ name, sessions: usage.sessions, interactions: usage.interactions ?? 0 }))
		.filter((e) => e.sessions > 0)
		.sort((a, b) => b.sessions - a.sessions || a.name.localeCompare(b.name));
	return {
		period,
		sessions: stats.sessions,
		interactions: editors.reduce((sum, e) => sum + e.interactions, 0),
		tokens: stats.tokens,
		editors: editors.map(({ name, sessions }) => ({ name, sessions })),
	};
}

/** Builds the share-card payload from the aggregated stats, or `undefined` when none are available yet. */
export function buildShareCardData(stats: DetailedStats | undefined): ShareCardPeriodData[] | undefined {
	if (!stats) { return undefined; }
	return [
		toPeriodData('last30', stats.last30Days),
		toPeriodData('today', stats.today),
		toPeriodData('currentMonth', stats.month),
		toPeriodData('lastMonth', stats.lastMonth),
	];
}
