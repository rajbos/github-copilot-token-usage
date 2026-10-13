import test from 'node:test';
import * as assert from 'node:assert/strict';

import { buildTtftBuckets, buildTtftModelSeries } from '../ttftAnalysis';
import type { TtftSample } from '../tokenEstimation';

function sample(dateStr: string, model: string, ttftSeconds: number): TtftSample {
	return { tsMs: new Date(`${dateStr}T12:00:00`).getTime(), model, ttftSeconds };
}

// ── buildTtftBuckets ───────────────────────────────────────────────────────

test('buildTtftBuckets: returns an empty array for no samples', () => {
	assert.deepEqual(buildTtftBuckets([], 'day'), []);
});

test('buildTtftBuckets: day granularity averages same-day samples, keeps different days separate', () => {
	const samples = [
		sample('2026-09-01', 'claude-sonnet-5', 0.4),
		sample('2026-09-01', 'claude-sonnet-5', 0.6),
		sample('2026-09-02', 'claude-sonnet-5', 1.0),
	];
	const buckets = buildTtftBuckets(samples, 'day');
	assert.equal(buckets.length, 2);
	assert.equal(buckets[0].key, '2026-09-01');
	assert.equal(buckets[0].avgSeconds, 0.5);
	assert.equal(buckets[0].count, 2);
	assert.equal(buckets[1].avgSeconds, 1.0);
	assert.equal(buckets[1].count, 1);
});

test('buildTtftBuckets: buckets are sorted ascending by key', () => {
	const samples = [
		sample('2026-09-05', 'gpt-5', 0.5),
		sample('2026-09-01', 'gpt-5', 0.5),
		sample('2026-09-03', 'gpt-5', 0.5),
	];
	const buckets = buildTtftBuckets(samples, 'day');
	const keys = buckets.map(b => b.key);
	assert.deepEqual(keys, [...keys].sort((a, b) => a.localeCompare(b)));
});

test('buildTtftBuckets: per-model breakdown within a bucket averages each model independently', () => {
	const samples = [
		sample('2026-09-01', 'claude-sonnet-5', 0.4),
		sample('2026-09-01', 'claude-sonnet-5', 0.6),
		sample('2026-09-01', 'gpt-5', 1.2),
	];
	const buckets = buildTtftBuckets(samples, 'day');
	assert.equal(buckets.length, 1);
	assert.equal(buckets[0].byModel['claude-sonnet-5'].avgSeconds, 0.5);
	assert.equal(buckets[0].byModel['claude-sonnet-5'].count, 2);
	assert.equal(buckets[0].byModel['gpt-5'].avgSeconds, 1.2);
	assert.equal(buckets[0].byModel['gpt-5'].count, 1);
});

test('buildTtftBuckets: week granularity groups samples from the same ISO (Monday-start) week', () => {
	// 2026-09-01 is a Tuesday; 2026-09-06 is the following Sunday — same week.
	const samples = [
		sample('2026-09-01', 'gpt-5', 0.4),
		sample('2026-09-06', 'gpt-5', 0.6),
		sample('2026-09-08', 'gpt-5', 1.0), // the next Tuesday — a different week
	];
	const buckets = buildTtftBuckets(samples, 'week');
	assert.equal(buckets.length, 2);
	assert.equal(buckets[0].count, 2);
	assert.equal(buckets[0].avgSeconds, 0.5);
	assert.equal(buckets[1].count, 1);
});

test('buildTtftBuckets: month granularity groups samples from the same calendar month', () => {
	const samples = [
		sample('2026-09-01', 'gpt-5', 0.4),
		sample('2026-09-28', 'gpt-5', 0.6),
		sample('2026-10-01', 'gpt-5', 1.0),
	];
	const buckets = buildTtftBuckets(samples, 'month');
	assert.equal(buckets.length, 2);
	assert.equal(buckets[0].key, '2026-09');
	assert.equal(buckets[0].count, 2);
	assert.equal(buckets[1].key, '2026-10');
});

// ── buildTtftModelSeries ───────────────────────────────────────────────────

test('buildTtftModelSeries: aligns each model\'s data to the buckets, using null for buckets with no samples for that model', () => {
	const samples = [
		sample('2026-09-01', 'claude-sonnet-5', 0.5),
		sample('2026-09-02', 'gpt-5', 1.0),
	];
	const buckets = buildTtftBuckets(samples, 'day');
	const series = buildTtftModelSeries(buckets);
	assert.equal(series.length, 2);
	const claude = series.find(s => s.model === 'claude-sonnet-5')!;
	const gpt = series.find(s => s.model === 'gpt-5')!;
	assert.deepEqual(claude.data, [0.5, null]);
	assert.deepEqual(gpt.data, [null, 1.0]);
});

test('buildTtftModelSeries: ranks models by total sample count, most-sampled first', () => {
	const samples = [
		sample('2026-09-01', 'rare-model', 0.5),
		sample('2026-09-01', 'common-model', 0.5),
		sample('2026-09-02', 'common-model', 0.5),
		sample('2026-09-03', 'common-model', 0.5),
	];
	const buckets = buildTtftBuckets(samples, 'day');
	const series = buildTtftModelSeries(buckets);
	assert.equal(series[0].model, 'common-model');
	assert.equal(series[1].model, 'rare-model');
});

test('buildTtftModelSeries: caps at maxModels, dropping the longest tail rather than folding it into an "Other" average', () => {
	const samples = ['a', 'b', 'c', 'd'].map(m => sample('2026-09-01', m, 0.5));
	const buckets = buildTtftBuckets(samples, 'day');
	const series = buildTtftModelSeries(buckets, 2);
	assert.equal(series.length, 2);
});

test('buildTtftModelSeries: returns an empty array for no buckets', () => {
	assert.deepEqual(buildTtftModelSeries([]), []);
});
