// Selected-bucket ("week") drill-down payloads for the Efficiency view.
//
// Pure and serializable: no DOM, no localization. English prose never lives
// here — unavailable reasons and notes are machine codes the webview resolves
// through its localization dictionary, so the same payload renders in any locale.
//
// The detail is derived from the series the charts already draw, so a selected
// bucket can never disagree with its point on the chart. Unavailable metrics
// stay `null` with a reason; they are never substituted with zero.

import type { EfficiencyBucketPoint, ModelPeriodMetrics, SkillUsageBucketPoint } from './efficiencyAnalysis';
import { efficiencyTodayKey } from './efficiencyAnalysis';

/** Ratio metrics a bucket detail reports, mirroring the Trends tab's charts. */
export type BucketMetricId =
	| 'cost-per-kloc' | 'tokens-per-session' | 'turns-per-session'
	| 'active-minutes' | 'retry-rate' | 'apply-rate' | 'loc-per-dollar';

export type BucketMetricUnit = 'currency' | 'tokens' | 'count' | 'minutes' | 'percent' | 'ratio';

/** Why a metric has no value for the bucket. */
export type BucketUnavailableReason = 'no-sessions' | 'no-loc' | 'no-duration' | 'few-edit-turns' | 'no-code-blocks';

export interface BucketDetailMetric {
	id: BucketMetricId;
	unit: BucketMetricUnit;
	goodDirection: 'up' | 'down';
	value: number | null;
	/** The same metric in the preceding bucket of the charted series; null when unavailable or there is none. */
	prior: number | null;
	/** Relative change versus `prior`, in percent; null unless both sides exist and prior is non-zero. */
	deltaPct: number | null;
	/** True when the change moved in `goodDirection`; null when not computable or flat. */
	improved: boolean | null;
	unavailable: BucketUnavailableReason | null;
}

/** Context a reader needs before trusting the numbers. */
export type BucketNote = 'partial' | 'no-sessions' | 'no-prior';

export interface BucketDetail {
	key: string;
	label: string;
	startKey: string;
	endKey: string;
	resolution: EfficiencyBucketPoint['resolution'];
	/** True while the bucket is still filling: it reaches today but its natural span does not end today. */
	partial: boolean;
	raw: { sessions: number; tokens: number; turns: number; loc: number; cost: number };
	metrics: BucketDetailMetric[];
	notes: BucketNote[];
}

function parse(key: string): Date { return new Date(`${key}T00:00:00`); }
function fmt(d: Date): string {
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The last day a bucket would cover if it were complete. */
export function naturalBucketEndKey(point: Pick<EfficiencyBucketPoint, 'startKey' | 'resolution'>): string {
	const start = parse(point.startKey);
	if (point.resolution === 'weekly') { start.setDate(start.getDate() + 6); return fmt(start); }
	if (point.resolution === 'monthly') { return fmt(new Date(start.getFullYear(), start.getMonth() + 1, 0)); }
	return point.startKey;
}

/** True while the bucket contains today and today is not its natural last day. */
export function isPartialBucket(point: Pick<EfficiencyBucketPoint, 'startKey' | 'endKey' | 'resolution'>, now: Date): boolean {
	const today = efficiencyTodayKey(now);
	return point.endKey >= today && point.startKey <= today && naturalBucketEndKey(point) > today;
}

type MetricSpec = {
	id: BucketMetricId; unit: BucketMetricUnit; goodDirection: 'up' | 'down';
	pick: (p: EfficiencyBucketPoint) => number | null;
	reason: (p: EfficiencyBucketPoint) => BucketUnavailableReason;
};

const noSessionsOr = (fallback: BucketUnavailableReason) =>
	(p: EfficiencyBucketPoint): BucketUnavailableReason => (p.sessions === 0 ? 'no-sessions' : fallback);

const METRIC_SPECS: MetricSpec[] = [
	{ id: 'cost-per-kloc', unit: 'currency', goodDirection: 'down', pick: p => p.costPerKloc, reason: noSessionsOr('no-loc') },
	{ id: 'tokens-per-session', unit: 'tokens', goodDirection: 'down', pick: p => p.tokensPerSession, reason: () => 'no-sessions' },
	{ id: 'turns-per-session', unit: 'count', goodDirection: 'down', pick: p => p.turnsPerSession, reason: () => 'no-sessions' },
	{ id: 'active-minutes', unit: 'minutes', goodDirection: 'down', pick: p => p.activeMinutesPerSession, reason: noSessionsOr('no-duration') },
	{ id: 'retry-rate', unit: 'percent', goodDirection: 'down', pick: p => (p.retryRate === null ? null : p.retryRate * 100), reason: noSessionsOr('few-edit-turns') },
	{ id: 'apply-rate', unit: 'percent', goodDirection: 'up', pick: p => (p.applyRate === null ? null : p.applyRate * 100), reason: noSessionsOr('no-code-blocks') },
	{ id: 'loc-per-dollar', unit: 'count', goodDirection: 'up', pick: p => p.locPerDollar, reason: noSessionsOr('no-loc') },
];

/** Relative change in percent plus whether it moved in the good direction. */
export function compareValues(
	prior: number | null,
	value: number | null,
	goodDirection: 'up' | 'down',
): { deltaPct: number | null; improved: boolean | null } {
	if (prior === null || value === null || prior === 0) { return { deltaPct: null, improved: null }; }
	const deltaPct = ((value - prior) / Math.abs(prior)) * 100;
	if (Math.abs(deltaPct) < 0.05) { return { deltaPct, improved: null }; }
	return { deltaPct, improved: goodDirection === 'down' ? value < prior : value > prior };
}

/**
 * Builds the detail for the bucket at `index` of `points`. The prior bucket is
 * the previous point of the same series, so the comparison is always between
 * two buckets of the same width.
 */
export function buildBucketDetail(points: EfficiencyBucketPoint[], index: number, now: Date): BucketDetail | null {
	const p = points[index];
	if (!p) { return null; }
	const prior = index > 0 ? points[index - 1] : null;
	const partial = isPartialBucket(p, now);
	const notes: BucketNote[] = [];
	if (partial) { notes.push('partial'); }
	if (p.sessions === 0) { notes.push('no-sessions'); }
	if (!prior) { notes.push('no-prior'); }
	const metrics = METRIC_SPECS.map((spec): BucketDetailMetric => {
		const value = spec.pick(p);
		const priorValue = prior ? spec.pick(prior) : null;
		return {
			id: spec.id, unit: spec.unit, goodDirection: spec.goodDirection,
			value, prior: priorValue,
			...compareValues(priorValue, value, spec.goodDirection),
			unavailable: value === null ? spec.reason(p) : null,
		};
	});
	return {
		key: p.bucketKey, label: p.label, startKey: p.startKey, endKey: p.endKey, resolution: p.resolution,
		partial,
		raw: { sessions: p.sessions, tokens: p.tokens, turns: p.interactions, loc: p.loc, cost: p.cost },
		metrics, notes,
	};
}

/** Skill usage for one bucket, with the tracked-session denominator beside the share. */
export interface SkillBucketDetail {
	key: string;
	label: string;
	totalCalls: number;
	skillSessions: number;
	trackedSessions: number;
	skillShare: number | null;
	priorSkillShare: number | null;
	shareChangePoints: number | null;
	top: { name: string; calls: number }[];
}

export function buildSkillBucketDetail(points: SkillUsageBucketPoint[], index: number, topN = 5): SkillBucketDetail | null {
	const p = points[index];
	if (!p) { return null; }
	const prior = index > 0 ? points[index - 1] : null;
	const priorShare = prior?.skillShare ?? null;
	return {
		key: p.bucketKey, label: p.label,
		totalCalls: p.totalCalls, skillSessions: p.skillSessions, trackedSessions: p.trackedSessions,
		skillShare: p.skillShare, priorSkillShare: priorShare,
		shareChangePoints: p.skillShare !== null && priorShare !== null ? (p.skillShare - priorShare) * 100 : null,
		top: Object.entries(p.byName).filter(([, n]) => n > 0)
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
			.slice(0, topN).map(([name, calls]) => ({ name, calls })),
	};
}

/** One model's profile in a selected bucket. The sample flags are the model comparison's own floors. */
export interface ModelBucketDetail {
	model: string;
	displayName: string;
	sessions: number;
	sessionShare: number;
	editTurns: number;
	tokens: number;
	cost: number;
	loc: number;
	/** The charted metric's value in this bucket and the preceding one. */
	value: number | null;
	prior: number | null;
	deltaPct: number | null;
	improved: boolean | null;
	/** False when the bucket is below the session floor, so ratios are not trusted. */
	sampleSufficient: boolean;
	editSampleSufficient: boolean;
	/** Largest task categories by token share, for context only. */
	taskMix: { category: string; share: number }[];
}

export function buildModelBucketDetail(
	series: { metrics: ModelPeriodMetrics | null }[],
	index: number,
	pick: (m: ModelPeriodMetrics) => number | null,
	goodDirection: 'up' | 'down',
): ModelBucketDetail | null {
	const m = series[index]?.metrics;
	if (!m) { return null; }
	const priorM = index > 0 ? series[index - 1]?.metrics ?? null : null;
	const value = m.sampleSufficient ? pick(m) : null;
	const prior = priorM && priorM.sampleSufficient ? pick(priorM) : null;
	return {
		model: m.model, displayName: m.displayName,
		sessions: m.sessions, sessionShare: m.sessionShare, editTurns: m.editTurns,
		tokens: m.tokens, cost: m.cost, loc: m.loc,
		value, prior, ...compareValues(prior, value, goodDirection),
		sampleSufficient: m.sampleSufficient, editSampleSufficient: m.editSampleSufficient,
		taskMix: Object.entries(m.taskMix).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([category, share]) => ({ category, share })),
	};
}
