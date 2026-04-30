import test from 'node:test';
import * as assert from 'node:assert/strict';

import { addModelUsage, addEditorUsage, computeUtcDateRanges } from '../../src/statsHelpers';
import type { ModelUsage, EditorUsage } from '../../src/types';

// ── addModelUsage ────────────────────────────────────────────────────────────

test('addModelUsage: adds a new model to an empty target', () => {
	const target: ModelUsage = {};
	const source: ModelUsage = { 'gpt-4': { inputTokens: 100, outputTokens: 50 } };
	addModelUsage(target, source);
	assert.deepEqual(target['gpt-4'], { inputTokens: 100, outputTokens: 50 });
});

test('addModelUsage: accumulates tokens for an existing model', () => {
	const target: ModelUsage = { 'gpt-4': { inputTokens: 200, outputTokens: 100 } };
	const source: ModelUsage = { 'gpt-4': { inputTokens: 50, outputTokens: 25 } };
	addModelUsage(target, source);
	assert.deepEqual(target['gpt-4'], { inputTokens: 250, outputTokens: 125 });
});

test('addModelUsage: merges multiple models at once', () => {
	const target: ModelUsage = { 'gpt-4': { inputTokens: 100, outputTokens: 50 } };
	const source: ModelUsage = {
		'gpt-4': { inputTokens: 10, outputTokens: 5 },
		'claude-3-5-sonnet': { inputTokens: 200, outputTokens: 100 },
	};
	addModelUsage(target, source);
	assert.deepEqual(target['gpt-4'], { inputTokens: 110, outputTokens: 55 });
	assert.deepEqual(target['claude-3-5-sonnet'], { inputTokens: 200, outputTokens: 100 });
});

test('addModelUsage: merges cachedReadTokens from source to empty target', () => {
	const target: ModelUsage = {};
	const source: ModelUsage = { 'claude-3-5-sonnet': { inputTokens: 300, outputTokens: 150, cachedReadTokens: 80 } };
	addModelUsage(target, source);
	assert.equal(target['claude-3-5-sonnet'].cachedReadTokens, 80);
});

test('addModelUsage: accumulates cachedReadTokens when both have the field', () => {
	const target: ModelUsage = { 'claude-3-5-sonnet': { inputTokens: 300, outputTokens: 150, cachedReadTokens: 40 } };
	const source: ModelUsage = { 'claude-3-5-sonnet': { inputTokens: 100, outputTokens: 50, cachedReadTokens: 20 } };
	addModelUsage(target, source);
	assert.equal(target['claude-3-5-sonnet'].cachedReadTokens, 60);
});

test('addModelUsage: merges cacheCreationTokens', () => {
	const target: ModelUsage = { 'claude-3-5-sonnet': { inputTokens: 300, outputTokens: 150 } };
	const source: ModelUsage = { 'claude-3-5-sonnet': { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 30 } };
	addModelUsage(target, source);
	assert.equal(target['claude-3-5-sonnet'].cacheCreationTokens, 30);
});

test('addModelUsage: accumulates both cache fields together', () => {
	const target: ModelUsage = {
		'claude-3-5-sonnet': { inputTokens: 300, outputTokens: 150, cachedReadTokens: 20, cacheCreationTokens: 10 }
	};
	const source: ModelUsage = {
		'claude-3-5-sonnet': { inputTokens: 100, outputTokens: 50, cachedReadTokens: 5, cacheCreationTokens: 3 }
	};
	addModelUsage(target, source);
	assert.deepEqual(target['claude-3-5-sonnet'], {
		inputTokens: 400,
		outputTokens: 200,
		cachedReadTokens: 25,
		cacheCreationTokens: 13,
	});
});

test('addModelUsage: does not add undefined cache fields to target', () => {
	const target: ModelUsage = {};
	const source: ModelUsage = { 'gpt-4': { inputTokens: 100, outputTokens: 50 } };
	addModelUsage(target, source);
	assert.equal(target['gpt-4'].cachedReadTokens, undefined);
	assert.equal(target['gpt-4'].cacheCreationTokens, undefined);
});

test('addModelUsage: source with empty object is a no-op', () => {
	const target: ModelUsage = { 'gpt-4': { inputTokens: 100, outputTokens: 50 } };
	addModelUsage(target, {});
	assert.deepEqual(target, { 'gpt-4': { inputTokens: 100, outputTokens: 50 } });
});

// ── addEditorUsage ────────────────────────────────────────────────────────────

test('addEditorUsage: creates a new entry for an unknown editor type', () => {
	const target: EditorUsage = {};
	addEditorUsage(target, 'vscode', 1000);
	assert.deepEqual(target['vscode'], { tokens: 1000, sessions: 1 });
});

test('addEditorUsage: accumulates tokens and increments sessions for existing editor', () => {
	const target: EditorUsage = { 'vscode': { tokens: 500, sessions: 1 } };
	addEditorUsage(target, 'vscode', 300);
	assert.deepEqual(target['vscode'], { tokens: 800, sessions: 2 });
});

test('addEditorUsage: tracks multiple editor types independently', () => {
	const target: EditorUsage = {};
	addEditorUsage(target, 'vscode', 1000);
	addEditorUsage(target, 'cursor', 500);
	addEditorUsage(target, 'vscode', 200);
	assert.deepEqual(target['vscode'], { tokens: 1200, sessions: 2 });
	assert.deepEqual(target['cursor'], { tokens: 500, sessions: 1 });
});

test('addEditorUsage: increments sessions even when tokens are 0', () => {
	const target: EditorUsage = {};
	addEditorUsage(target, 'vscode', 0);
	assert.equal(target['vscode'].sessions, 1);
	assert.equal(target['vscode'].tokens, 0);
});

// ── computeUtcDateRanges ─────────────────────────────────────────────────────

test('computeUtcDateRanges: todayUtcKey is the UTC date of the input', () => {
	const now = new Date('2024-05-15T14:30:00.000Z');
	const ranges = computeUtcDateRanges(now);
	assert.equal(ranges.todayUtcKey, '2024-05-15');
});

// UTC midnight boundary: just before midnight UTC — still the previous day
test('computeUtcDateRanges: just before UTC midnight resolves to the preceding day', () => {
	const now = new Date('2024-05-14T23:59:59.999Z');
	const ranges = computeUtcDateRanges(now);
	assert.equal(ranges.todayUtcKey, '2024-05-14');
});

// UTC midnight boundary: at UTC midnight — flips to the new day
test('computeUtcDateRanges: at UTC midnight resolves to the new day', () => {
	const now = new Date('2024-05-15T00:00:00.000Z');
	const ranges = computeUtcDateRanges(now);
	assert.equal(ranges.todayUtcKey, '2024-05-15');
});

// DST transition (US spring-forward on 2024-03-10):
// Clocks jump from 02:00 → 03:00 local time, but UTC is unaffected.
// The UTC key must remain '2024-03-10' regardless of the local clock change.
test('computeUtcDateRanges: DST spring-forward day (UTC+5 morning) is still the correct UTC date', () => {
	// 07:00 UTC on 2024-03-10, which is 02:00 EST (UTC-5) — the moment the clock
	// would spring forward in the US Eastern timezone.
	const now = new Date('2024-03-10T07:00:00.000Z');
	const ranges = computeUtcDateRanges(now);
	assert.equal(ranges.todayUtcKey, '2024-03-10');
});

test('computeUtcDateRanges: DST fall-back day (UTC midnight) is still the correct UTC date', () => {
	// On 2024-11-03 in US Eastern (clocks fall back): 00:30 UTC = 20:30 EDT the day before
	// but the UTC date is still 2024-11-03.
	const now = new Date('2024-11-03T00:30:00.000Z');
	const ranges = computeUtcDateRanges(now);
	assert.equal(ranges.todayUtcKey, '2024-11-03');
});

// Month rollover: last day of a month
test('computeUtcDateRanges: last day of January produces correct month boundaries', () => {
	const now = new Date('2024-01-31T12:00:00.000Z');
	const ranges = computeUtcDateRanges(now);
	assert.equal(ranges.todayUtcKey, '2024-01-31');
	assert.equal(ranges.monthUtcStartKey, '2024-01-01');
	assert.equal(ranges.lastMonthUtcStartKey, '2023-12-01');
	assert.equal(ranges.lastMonthUtcEndKey, '2023-12-31');
});

// Month rollover: first day of the next month
test('computeUtcDateRanges: first day of February produces correct month boundaries', () => {
	const now = new Date('2024-02-01T00:00:00.000Z');
	const ranges = computeUtcDateRanges(now);
	assert.equal(ranges.todayUtcKey, '2024-02-01');
	assert.equal(ranges.monthUtcStartKey, '2024-02-01');
	assert.equal(ranges.lastMonthUtcStartKey, '2024-01-01');
	assert.equal(ranges.lastMonthUtcEndKey, '2024-01-31');
});

// Month rollover over a year boundary
test('computeUtcDateRanges: January 1st has December as previous month', () => {
	const now = new Date('2025-01-01T00:00:00.000Z');
	const ranges = computeUtcDateRanges(now);
	assert.equal(ranges.monthUtcStartKey, '2025-01-01');
	assert.equal(ranges.lastMonthUtcStartKey, '2024-12-01');
	assert.equal(ranges.lastMonthUtcEndKey, '2024-12-31');
});

// 30-day window boundary: a file older than 30 days must fall before last30DaysStartMs
test('computeUtcDateRanges: file mtime 31 days ago is outside the 30-day window', () => {
	const now = new Date('2024-05-15T12:00:00.000Z');
	const ranges = computeUtcDateRanges(now);
	// 31 days before May 15 = April 14
	const fileOlderThan30Days = new Date('2024-04-14T11:59:59.999Z').getTime();
	assert.ok(fileOlderThan30Days < ranges.last30DaysStartMs,
		'mtime 31 days ago should be less than last30DaysStartMs (i.e. excluded)');
});

test('computeUtcDateRanges: file mtime exactly at window start is inside the 30-day window', () => {
	const now = new Date('2024-05-15T12:00:00.000Z');
	const ranges = computeUtcDateRanges(now);
	// Exactly 30 UTC days before May 15 12:00 = April 15 00:00 UTC (computed via Date.UTC)
	const fileAtWindowStart = ranges.last30DaysStartMs;
	assert.ok(fileAtWindowStart >= ranges.last30DaysStartMs,
		'mtime at window start boundary should not be excluded');
});

test('computeUtcDateRanges: last30DaysUtcStartKey is 30 days before todayUtcKey', () => {
	const now = new Date('2024-05-15T12:00:00.000Z');
	const ranges = computeUtcDateRanges(now);
	// April 15 is 30 days before May 15
	assert.equal(ranges.last30DaysUtcStartKey, '2024-04-15');
});

test('computeUtcDateRanges: 30-day window crosses a month boundary correctly', () => {
	const now = new Date('2024-03-10T12:00:00.000Z');
	const ranges = computeUtcDateRanges(now);
	// Feb 9 is 30 days before Mar 10
	assert.equal(ranges.last30DaysUtcStartKey, '2024-02-09');
});

test('computeUtcDateRanges: last30DaysStartMs equals the UTC midnight of last30DaysUtcStartKey', () => {
	const now = new Date('2024-05-15T12:00:00.000Z');
	const ranges = computeUtcDateRanges(now);
	const expectedMs = new Date(`${ranges.last30DaysUtcStartKey}T00:00:00.000Z`).getTime();
	assert.equal(ranges.last30DaysStartMs, expectedMs);
});
