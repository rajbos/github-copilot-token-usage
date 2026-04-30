import test from 'node:test';
import * as assert from 'node:assert/strict';

import {
addModelUsage,
addEditorUsage,
computeUtcDateRanges,
aggregatePeriodStats,
type SessionAggregateInput,
type UtcDateRanges,
} from '../../src/statsHelpers';
import type { ModelUsage, EditorUsage, SessionFileCache } from '../../src/types';

// ── Helper factory ───────────────────────────────────────────────────────────

function makeSession(overrides: Partial<SessionFileCache> = {}): SessionFileCache {
return {
tokens: 100,
interactions: 1,
modelUsage: {},
mtime: 0,
actualTokens: 0,
thinkingTokens: 0,
...overrides,
};
}

/** Build a UtcDateRanges object from a "today" UTC day key (YYYY-MM-DD). */
function makeRanges(todayUtcKey: string): UtcDateRanges {
const [year, month, day] = todayUtcKey.split('-').map(Number);
// month is 1-based here; Date.UTC uses 0-based months
const monthUtcStartKey = new Date(Date.UTC(year, month - 1, 1)).toISOString().slice(0, 10);
const lastMonthLastDay = new Date(Date.UTC(year, month - 1, 0));
const lastMonthUtcEndKey = lastMonthLastDay.toISOString().slice(0, 10);
const lastMonthUtcStartKey = new Date(
Date.UTC(lastMonthLastDay.getUTCFullYear(), lastMonthLastDay.getUTCMonth(), 1),
).toISOString().slice(0, 10);
const last30DaysUtcStart = new Date(Date.UTC(year, month - 1, day - 30));
const last30DaysUtcStartKey = last30DaysUtcStart.toISOString().slice(0, 10);
const last30DaysStartMs = last30DaysUtcStart.getTime();
return { todayUtcKey, monthUtcStartKey, lastMonthUtcStartKey, lastMonthUtcEndKey, last30DaysUtcStartKey, last30DaysStartMs };
}

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

// ── aggregatePeriodStats – rollup path ───────────────────────────────────────

test('aggregatePeriodStats: rollup path – today attribution', () => {
const ranges = makeRanges('2025-03-15');
const input: SessionAggregateInput = {
editorType: 'vscode',
mtime: new Date('2025-03-15T10:00:00.000Z').getTime(),
sessionData: makeSession({
dailyRollups: {
'2025-03-15': { tokens: 100, actualTokens: 120, thinkingTokens: 0, interactions: 2, modelUsage: {} },
},
}),
};
const result = aggregatePeriodStats([input], ranges);
assert.equal(result.todayStats.tokens, 120, 'uses actualTokens when > 0');
assert.equal(result.todayStats.sessions, 1);
assert.equal(result.todayStats.interactions, 2);
assert.equal(result.monthStats.tokens, 120);
assert.equal(result.last30DaysStats.tokens, 120);
assert.equal(result.skippedCount, 0);
});

test('aggregatePeriodStats: rollup path – falls back to tokens when actualTokens is 0', () => {
const ranges = makeRanges('2025-03-15');
const input: SessionAggregateInput = {
editorType: 'vscode',
mtime: new Date('2025-03-15T10:00:00.000Z').getTime(),
sessionData: makeSession({
dailyRollups: {
'2025-03-15': { tokens: 100, actualTokens: 0, thinkingTokens: 0, interactions: 1, modelUsage: {} },
},
}),
};
const result = aggregatePeriodStats([input], ranges);
assert.equal(result.todayStats.tokens, 100, 'falls back to estimated tokens');
});

test('aggregatePeriodStats: rollup path – last-month attribution', () => {
const ranges = makeRanges('2025-04-01');
// March entry → previous calendar month
const input: SessionAggregateInput = {
editorType: 'vscode',
mtime: new Date('2025-03-31T10:00:00.000Z').getTime(),
sessionData: makeSession({
dailyRollups: {
'2025-03-31': { tokens: 200, actualTokens: 0, thinkingTokens: 0, interactions: 1, modelUsage: {} },
},
}),
};
const result = aggregatePeriodStats([input], ranges);
assert.equal(result.lastMonthStats.tokens, 200);
assert.equal(result.monthStats.tokens, 0, 'should not bleed into this month');
assert.equal(result.todayStats.tokens, 0);
});

test('aggregatePeriodStats: rollup path – month boundary (first day of month goes to this month)', () => {
const ranges = makeRanges('2025-04-15');
const input: SessionAggregateInput = {
editorType: 'vscode',
mtime: new Date('2025-04-01T10:00:00.000Z').getTime(),
sessionData: makeSession({
dailyRollups: {
'2025-04-01': { tokens: 300, actualTokens: 0, thinkingTokens: 0, interactions: 1, modelUsage: {} },
},
}),
};
const result = aggregatePeriodStats([input], ranges);
assert.equal(result.monthStats.tokens, 300, 'first day of month belongs to this month');
assert.equal(result.lastMonthStats.tokens, 0);
});

test('aggregatePeriodStats: rollup path – days before 30-day window are excluded', () => {
const ranges = makeRanges('2025-03-15'); // last30DaysStart = 2025-02-13
const input: SessionAggregateInput = {
editorType: 'vscode',
mtime: new Date('2025-02-10T10:00:00.000Z').getTime(),
sessionData: makeSession({
dailyRollups: {
'2025-02-10': { tokens: 500, actualTokens: 0, thinkingTokens: 0, interactions: 1, modelUsage: {} },
},
}),
};
const result = aggregatePeriodStats([input], ranges);
assert.equal(result.last30DaysStats.tokens, 0);
assert.equal(result.skippedCount, 1);
});

test('aggregatePeriodStats: rollup path – partial session straddles 30-day boundary', () => {
const ranges = makeRanges('2025-03-15'); // last30DaysStart = 2025-02-13
const input: SessionAggregateInput = {
editorType: 'vscode',
mtime: new Date('2025-03-01T10:00:00.000Z').getTime(),
sessionData: makeSession({
dailyRollups: {
'2025-02-12': { tokens: 100, actualTokens: 0, thinkingTokens: 0, interactions: 1, modelUsage: {} }, // excluded
'2025-02-14': { tokens: 200, actualTokens: 0, thinkingTokens: 0, interactions: 2, modelUsage: {} }, // included
'2025-03-01': { tokens: 300, actualTokens: 0, thinkingTokens: 0, interactions: 3, modelUsage: {} }, // included
},
}),
};
const result = aggregatePeriodStats([input], ranges);
assert.equal(result.last30DaysStats.tokens, 500, '200 + 300 — only in-window days');
assert.equal(result.last30DaysStats.interactions, 5);
assert.equal(result.skippedCount, 0);
});

test('aggregatePeriodStats: rollup path – session is counted once in sessions even with many days', () => {
const ranges = makeRanges('2025-03-15');
const input: SessionAggregateInput = {
editorType: 'vscode',
mtime: new Date('2025-03-15T10:00:00.000Z').getTime(),
sessionData: makeSession({
dailyRollups: {
'2025-03-10': { tokens: 100, actualTokens: 0, thinkingTokens: 0, interactions: 1, modelUsage: {} },
'2025-03-11': { tokens: 100, actualTokens: 0, thinkingTokens: 0, interactions: 1, modelUsage: {} },
'2025-03-12': { tokens: 100, actualTokens: 0, thinkingTokens: 0, interactions: 1, modelUsage: {} },
},
}),
};
const result = aggregatePeriodStats([input], ranges);
assert.equal(result.last30DaysStats.sessions, 1, 'one session regardless of days with rollups');
assert.equal(result.monthStats.sessions, 1);
assert.equal(result.last30DaysStats.tokens, 300);
});

// ── aggregatePeriodStats – fallback path ─────────────────────────────────────

test('aggregatePeriodStats: fallback – uses lastInteraction for UTC day key', () => {
const ranges = makeRanges('2025-03-15');
const input: SessionAggregateInput = {
editorType: 'vscode',
mtime: new Date('2025-03-14T22:00:00.000Z').getTime(), // local-time "yesterday" in UTC-5, but UTC "yesterday"
lastInteraction: '2025-03-15T00:30:00.000Z', // UTC today
sessionData: makeSession({ tokens: 150, interactions: 3 }),
};
const result = aggregatePeriodStats([input], ranges);
assert.equal(result.todayStats.tokens, 150, 'attributed to UTC today via lastInteraction');
assert.equal(result.todayStats.sessions, 1);
});

test('aggregatePeriodStats: fallback – falls back to mtime when lastInteraction absent', () => {
const ranges = makeRanges('2025-03-15');
const mtime = new Date('2025-03-15T10:00:00.000Z').getTime();
const input: SessionAggregateInput = {
editorType: 'cursor',
mtime,
sessionData: makeSession({ tokens: 80, interactions: 2 }),
// lastInteraction deliberately omitted
};
const result = aggregatePeriodStats([input], ranges);
assert.equal(result.todayStats.tokens, 80, 'mtime used as fallback when no lastInteraction');
assert.equal(result.dailyStatsMap.get('2025-03-15')?.tokens, 80);
});

test('aggregatePeriodStats: fallback – uses actualTokens when > 0', () => {
const ranges = makeRanges('2025-03-15');
const input: SessionAggregateInput = {
editorType: 'vscode',
mtime: new Date('2025-03-15T10:00:00.000Z').getTime(),
lastInteraction: '2025-03-15T10:00:00.000Z',
sessionData: makeSession({ tokens: 100, actualTokens: 180, interactions: 1 }),
};
const result = aggregatePeriodStats([input], ranges);
assert.equal(result.todayStats.tokens, 180, 'actualTokens preferred over estimated');
});

test('aggregatePeriodStats: fallback – session older than 30 days is skipped', () => {
const ranges = makeRanges('2025-03-15'); // last30DaysStart = 2025-02-13
const input: SessionAggregateInput = {
editorType: 'vscode',
mtime: new Date('2025-02-01T10:00:00.000Z').getTime(),
lastInteraction: '2025-02-01T10:00:00.000Z',
sessionData: makeSession({ tokens: 999, interactions: 10 }),
};
const result = aggregatePeriodStats([input], ranges);
assert.equal(result.last30DaysStats.tokens, 0);
assert.equal(result.skippedCount, 1);
});

// ── UTC midnight boundary ────────────────────────────────────────────────────

test('UTC midnight boundary: event just before UTC midnight attributed to that UTC day', () => {
const ranges = makeRanges('2025-06-20');
// 2025-06-19T23:59:59Z is still UTC 2025-06-19
const input: SessionAggregateInput = {
editorType: 'vscode',
mtime: new Date('2025-06-19T23:59:59.999Z').getTime(),
lastInteraction: '2025-06-19T23:59:59.999Z',
sessionData: makeSession({ tokens: 50, interactions: 1 }),
};
const result = aggregatePeriodStats([input], ranges);
assert.ok(result.dailyStatsMap.has('2025-06-19'), 'attributed to 2025-06-19');
assert.ok(!result.dailyStatsMap.has('2025-06-20'), 'not attributed to 2025-06-20');
assert.equal(result.todayStats.tokens, 0, 'not today');
assert.equal(result.monthStats.tokens, 50);
});

test('UTC midnight boundary: event just after UTC midnight attributed to the new UTC day', () => {
const ranges = makeRanges('2025-06-20');
// 2025-06-20T00:00:01Z is UTC 2025-06-20 (today)
const input: SessionAggregateInput = {
editorType: 'vscode',
mtime: new Date('2025-06-20T00:00:01.000Z').getTime(),
lastInteraction: '2025-06-20T00:00:01.000Z',
sessionData: makeSession({ tokens: 60, interactions: 1 }),
};
const result = aggregatePeriodStats([input], ranges);
assert.ok(result.dailyStatsMap.has('2025-06-20'), 'attributed to 2025-06-20');
assert.equal(result.todayStats.tokens, 60, 'today');
});

// ── DST transition ───────────────────────────────────────────────────────────

test('DST spring-forward: UTC key is correct regardless of local clock shift', () => {
// US spring forward 2025-03-09: clocks skip from 02:00 EST to 03:00 EDT.
// UTC is unaffected — 07:00 UTC is always on 2025-03-09.
const ranges = makeRanges('2025-03-09');
const input: SessionAggregateInput = {
editorType: 'vscode',
// 07:00 UTC on 2025-03-09 → "2:00 AM EST" / "3:00 AM EDT" in US/Eastern, still 2025-03-09 UTC
mtime: new Date('2025-03-09T07:00:00.000Z').getTime(),
lastInteraction: '2025-03-09T07:00:00.000Z',
sessionData: makeSession({ tokens: 75, interactions: 1 }),
};
const result = aggregatePeriodStats([input], ranges);
assert.equal(result.todayStats.tokens, 75, 'correctly attributed to DST transition day');
assert.ok(result.dailyStatsMap.has('2025-03-09'));
});

test('DST fall-back: UTC key is correct when local clock falls back', () => {
// US fall back 2025-11-02: clocks repeat 01:00 EDT → 01:00 EST.
// UTC 06:30 is unambiguously on 2025-11-02.
const ranges = makeRanges('2025-11-02');
const input: SessionAggregateInput = {
editorType: 'vscode',
mtime: new Date('2025-11-02T06:30:00.000Z').getTime(),
lastInteraction: '2025-11-02T06:30:00.000Z',
sessionData: makeSession({ tokens: 90, interactions: 1 }),
};
const result = aggregatePeriodStats([input], ranges);
assert.equal(result.todayStats.tokens, 90);
assert.ok(result.dailyStatsMap.has('2025-11-02'));
});

// ── Month rollover ───────────────────────────────────────────────────────────

test('month rollover: last day of month goes to last-month', () => {
// "today" is 2025-04-01; 2025-03-31 is the last day of last month
const ranges = makeRanges('2025-04-01');
const input: SessionAggregateInput = {
editorType: 'vscode',
mtime: new Date('2025-03-31T12:00:00.000Z').getTime(),
lastInteraction: '2025-03-31T12:00:00.000Z',
sessionData: makeSession({ tokens: 400, interactions: 4 }),
};
const result = aggregatePeriodStats([input], ranges);
assert.equal(result.lastMonthStats.tokens, 400, 'last day of month → last month');
assert.equal(result.monthStats.tokens, 0, 'no bleed into current month');
assert.equal(result.todayStats.tokens, 0);
});

test('month rollover: first day of month goes to this month', () => {
const ranges = makeRanges('2025-04-15');
const input: SessionAggregateInput = {
editorType: 'vscode',
mtime: new Date('2025-04-01T00:00:00.000Z').getTime(),
lastInteraction: '2025-04-01T00:00:00.000Z',
sessionData: makeSession({ tokens: 250, interactions: 2 }),
};
const result = aggregatePeriodStats([input], ranges);
assert.equal(result.monthStats.tokens, 250, 'first day of month → this month');
assert.equal(result.lastMonthStats.tokens, 0);
});

test('month rollover: Jan 31 → last month when today is Feb 01', () => {
const ranges = makeRanges('2026-02-01');
const input: SessionAggregateInput = {
editorType: 'vscode',
mtime: new Date('2026-01-31T23:59:00.000Z').getTime(),
lastInteraction: '2026-01-31T23:59:00.000Z',
sessionData: makeSession({ tokens: 111, interactions: 1 }),
};
const result = aggregatePeriodStats([input], ranges);
assert.equal(result.lastMonthStats.tokens, 111, 'Jan 31 goes to last month when today is Feb 01');
assert.equal(result.monthStats.tokens, 0);
});

// ── dailyStatsMap accumulation ───────────────────────────────────────────────

test('dailyStatsMap: multiple sessions on same day are summed', () => {
const ranges = makeRanges('2025-03-15');
const inputs: SessionAggregateInput[] = [
{
editorType: 'vscode',
mtime: new Date('2025-03-15T08:00:00.000Z').getTime(),
lastInteraction: '2025-03-15T08:00:00.000Z',
sessionData: makeSession({ tokens: 100, interactions: 1 }),
},
{
editorType: 'cursor',
mtime: new Date('2025-03-15T14:00:00.000Z').getTime(),
lastInteraction: '2025-03-15T14:00:00.000Z',
sessionData: makeSession({ tokens: 200, interactions: 2 }),
},
];
const result = aggregatePeriodStats(inputs, ranges);
const day = result.dailyStatsMap.get('2025-03-15')!;
assert.ok(day, 'daily entry for today');
assert.equal(day.tokens, 300, '100 + 200');
assert.equal(day.sessions, 2);
assert.equal(day.interactions, 3);
assert.equal(day.editorUsage['vscode']?.tokens, 100);
assert.equal(day.editorUsage['cursor']?.tokens, 200);
});

test('dailyStatsMap: rollup entries create one entry per day key', () => {
const ranges = makeRanges('2025-03-15');
const input: SessionAggregateInput = {
editorType: 'vscode',
mtime: new Date('2025-03-15T10:00:00.000Z').getTime(),
sessionData: makeSession({
dailyRollups: {
'2025-03-14': { tokens: 50, actualTokens: 0, thinkingTokens: 0, interactions: 1, modelUsage: {} },
'2025-03-15': { tokens: 75, actualTokens: 0, thinkingTokens: 0, interactions: 2, modelUsage: {} },
},
}),
};
const result = aggregatePeriodStats([input], ranges);
assert.ok(result.dailyStatsMap.has('2025-03-14'));
assert.ok(result.dailyStatsMap.has('2025-03-15'));
assert.equal(result.dailyStatsMap.get('2025-03-14')?.tokens, 50);
assert.equal(result.dailyStatsMap.get('2025-03-15')?.tokens, 75);
});

// ── Empty / edge cases ────────────────────────────────────────────────────────

test('aggregatePeriodStats: empty input returns zero-valued accumulators', () => {
const ranges = makeRanges('2025-03-15');
const result = aggregatePeriodStats([], ranges);
assert.equal(result.todayStats.tokens, 0);
assert.equal(result.monthStats.tokens, 0);
assert.equal(result.last30DaysStats.tokens, 0);
assert.equal(result.lastMonthStats.tokens, 0);
assert.equal(result.dailyStatsMap.size, 0);
assert.equal(result.skippedCount, 0);
});

test('aggregatePeriodStats: session with empty dailyRollups uses fallback path', () => {
const ranges = makeRanges('2025-03-15');
// dailyRollups is an empty object → should fall through to the session-level fallback
const input: SessionAggregateInput = {
editorType: 'vscode',
mtime: new Date('2025-03-15T10:00:00.000Z').getTime(),
lastInteraction: '2025-03-15T10:00:00.000Z',
sessionData: makeSession({ tokens: 77, dailyRollups: {} }),
};
const result = aggregatePeriodStats([input], ranges);
assert.equal(result.todayStats.tokens, 77, 'fallback used when dailyRollups is empty');
});
