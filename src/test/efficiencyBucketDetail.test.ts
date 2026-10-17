import test from 'node:test';
import * as assert from 'node:assert/strict';

import {
	buildEfficiencyBuckets,
	buildEfficiencyBucketSeries,
	buildSkillUsageSeries,
	type EfficiencyDailyVolume,
	type EfficiencyRange,
	type EfficiencySessionInput,
} from '../efficiencyAnalysis';
import {
	buildBucketDetail,
	buildModelBucketDetail,
	buildSkillBucketDetail,
	compareValues,
	isPartialBucket,
	naturalBucketEndKey,
} from '../efficiencyBucketDetail';

// Wednesday 2026-07-15: the week of Mon 07-13 is partial, the earlier weeks are complete.
const NOW = new Date(2026, 6, 15, 12);
const RANGE: EfficiencyRange = { id: 'custom', label: 'test', startKey: '2026-06-29', endKey: '2026-07-15' };

function vol(date: string, sessions: number, tokens: number, loc: number, cost: number): EfficiencyDailyVolume {
	return { date, sessions, tokens, interactions: sessions * 4, loc, cost };
}

function series(volume: EfficiencyDailyVolume[], sessions: EfficiencySessionInput[] = []) {
	return buildEfficiencyBucketSeries(volume, sessions, buildEfficiencyBuckets(RANGE, 'weekly'));
}

test('naturalBucketEndKey: weekly is start+6, monthly is the last day of the month, daily is itself', () => {
	assert.equal(naturalBucketEndKey({ startKey: '2026-07-13', resolution: 'weekly' }), '2026-07-19');
	assert.equal(naturalBucketEndKey({ startKey: '2026-02-01', resolution: 'monthly' }), '2026-02-28');
	assert.equal(naturalBucketEndKey({ startKey: '2026-07-15', resolution: 'daily' }), '2026-07-15');
});

test('isPartialBucket: only a bucket that reaches today before its natural end is partial', () => {
	const points = series([vol('2026-06-30', 2, 1000, 100, 1)]);
	assert.equal(points.length, 3);
	assert.equal(isPartialBucket(points[0], NOW), false);
	assert.equal(isPartialBucket(points[2], NOW), true);
	// On the bucket's own last day it is complete.
	assert.equal(isPartialBucket({ ...points[2], endKey: '2026-07-19' }, new Date(2026, 6, 19)), false);
});

test('buildBucketDetail: reports raw volume, derived ratios and the change versus the previous bucket', () => {
	const volume = [vol('2026-06-30', 2, 2000, 1000, 2), vol('2026-07-07', 2, 3000, 2000, 2)];
	const detail = buildBucketDetail(series(volume), 1, NOW)!;
	assert.deepEqual(detail.raw, { sessions: 2, tokens: 3000, turns: 8, loc: 2000, cost: 2 });
	const tokens = detail.metrics.find(m => m.id === 'tokens-per-session')!;
	assert.equal(tokens.value, 1500);
	assert.equal(tokens.prior, 1000);
	assert.equal(tokens.deltaPct, 50);
	assert.equal(tokens.improved, false); // more tokens per session is the worse direction
	assert.equal(detail.partial, false);
	assert.deepEqual(detail.notes, []);
});

test('buildBucketDetail: unavailable metrics stay null with a reason, never zero', () => {
	const detail = buildBucketDetail(series([vol('2026-06-30', 2, 2000, 0, 2)]), 0, NOW)!;
	const kloc = detail.metrics.find(m => m.id === 'cost-per-kloc')!;
	assert.equal(kloc.value, null);
	assert.equal(kloc.unavailable, 'no-loc');
	const retry = detail.metrics.find(m => m.id === 'retry-rate')!;
	assert.equal(retry.value, null);
	assert.equal(retry.unavailable, 'few-edit-turns');
	assert.ok(detail.notes.includes('no-prior'));
});

test('buildBucketDetail: a retry rate below the edit-turn floor stays null; at the floor it is a percentage', () => {
	const few: EfficiencySessionInput = { dayKey: '2026-06-30', editTurns: 4, retries: 2 };
	const enough: EfficiencySessionInput = { dayKey: '2026-06-30', editTurns: 10, retries: 2 };
	const vols = [vol('2026-06-30', 1, 100, 10, 1)];
	assert.equal(buildBucketDetail(series(vols, [few]), 0, NOW)!.metrics.find(m => m.id === 'retry-rate')!.value, null);
	assert.equal(buildBucketDetail(series(vols, [enough]), 0, NOW)!.metrics.find(m => m.id === 'retry-rate')!.value, 20);
});

test('buildBucketDetail: the in-progress bucket is flagged partial; an empty bucket says no sessions', () => {
	const detail = buildBucketDetail(series([vol('2026-06-30', 1, 100, 10, 1)]), 2, NOW)!;
	assert.equal(detail.partial, true);
	assert.deepEqual(detail.notes, ['partial', 'no-sessions']);
	assert.equal(detail.metrics.find(m => m.id === 'tokens-per-session')!.unavailable, 'no-sessions');
});

test('buildBucketDetail: out-of-range index yields null', () => {
	assert.equal(buildBucketDetail(series([]), 9, NOW), null);
});

test('compareValues: zero prior and flat changes do not invent a direction', () => {
	assert.deepEqual(compareValues(0, 5, 'down'), { deltaPct: null, improved: null });
	assert.deepEqual(compareValues(null, 5, 'down'), { deltaPct: null, improved: null });
	assert.equal(compareValues(10, 10, 'up').improved, null);
	assert.equal(compareValues(10, 5, 'down').improved, true);
});

test('buildSkillBucketDetail: carries the tracked-session denominator and the share change in points', () => {
	const sessions: EfficiencySessionInput[] = [
		{ dayKey: '2026-06-30', skillCalls: { graphify: 2 } }, { dayKey: '2026-06-30' },
		{ dayKey: '2026-07-07', skillCalls: { graphify: 1, lint: 3 } }, { dayKey: '2026-07-08', skillCalls: { lint: 1 } },
	];
	const skills = buildSkillUsageSeries(sessions, buildEfficiencyBuckets(RANGE, 'weekly'));
	const detail = buildSkillBucketDetail(skills.weeks, 1)!;
	assert.equal(detail.trackedSessions, 2);
	assert.equal(detail.skillSessions, 2);
	assert.equal(detail.totalCalls, 5);
	assert.equal(detail.skillShare, 1);
	assert.equal(detail.shareChangePoints, 50);
	assert.deepEqual(detail.top, [{ name: 'lint', calls: 4 }, { name: 'graphify', calls: 1 }]);
});

test('buildModelBucketDetail: hides ratios below the sample floor and keeps volume visible', () => {
	const metrics = (sampleSufficient: boolean, cost: number) => ({
		model: 'm', displayName: 'M', periodLabel: 'x', sessions: 2, sessionShare: 2, calls: 3, editTurns: 12, tokens: 900, cost, loc: 50,
		taskMix: { debugging: 0.6, feature: 0.4 }, sampleSufficient, editSampleSufficient: sampleSufficient,
	}) as never;
	const pick = (m: { cost: number }) => m.cost;
	const low = buildModelBucketDetail([{ metrics: metrics(true, 2) }, { metrics: metrics(false, 4) }], 1, pick as never, 'down')!;
	assert.equal(low.value, null);
	assert.equal(low.prior, 2);
	assert.equal(low.deltaPct, null);
	assert.equal(low.tokens, 900);
	assert.equal(low.sampleSufficient, false);
	assert.deepEqual(low.taskMix[0], { category: 'debugging', share: 0.6 });
	const ok = buildModelBucketDetail([{ metrics: metrics(true, 2) }, { metrics: metrics(true, 3) }], 1, pick as never, 'down')!;
	assert.equal(ok.deltaPct, 50);
	assert.equal(ok.improved, false);
	assert.equal(buildModelBucketDetail([{ metrics: null }], 0, pick as never, 'down'), null);
});
