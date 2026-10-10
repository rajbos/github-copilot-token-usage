import test from 'node:test';
import * as assert from 'node:assert/strict';

import {
addModelUsage,
addEditorUsage,
computeUtcDateRanges,
aggregatePeriodStats,
computeSessionTotalTokens,
computeSessionDurationMs,
reconcileModelUsageToTotal,
reconcileModelUsageToActualTokens,
distributeModelUsageToDays,
distributeExactCostToDays,
sumModelUsageTokens,
computeFallbackDailyRollup,
type SessionAggregateInput,
type UtcDateRanges,
	preferActualTokens,
} from '../../../src/statsHelpers';
import type { ModelUsage, EditorUsage, SessionFileCache, DailyRollupEntry } from '../../../src/types';
import { scaleModelUsage, preserveAutoRouting, reconcileDebugLogModelUsage } from '../../../src/statsHelpers';
import { calculateEstimatedCost } from '../../../src/tokenEstimation';
import { TASK_CATEGORIES, type TaskCategory, type TaskCategoryBreakdown } from '../../../src/taskClassification';
import { getTimeWindowStartDayKey } from '../../../src/timeWindows';

/** Builds a full TaskCategoryBreakdown (all categories present) from a partial map of non-zero shares. */
function makeShares(partial: Partial<Record<TaskCategory, number>>): TaskCategoryBreakdown {
return TASK_CATEGORIES.reduce((acc, category) => {
	acc[category] = partial[category] ?? 0;
	return acc;
}, {} as TaskCategoryBreakdown);
}

test('Auto subsets survive merging, scaling, reconciliation and debug-log replacement', () => {
	const source: ModelUsage = { model: { inputTokens: 100, outputTokens: 40, sessions: 1,
		autoRouting: { inputTokens: 40, outputTokens: 20 } } };
	const target: ModelUsage = {};
	addModelUsage(target, source);
	addModelUsage(target, source);
	addModelUsage(target, { model: { inputTokens: 100, outputTokens: 20, sessions: 1 } });
	assert.deepEqual(target.model.autoRouting, { inputTokens: 80, outputTokens: 40 });
	assert.deepEqual(source.model.autoRouting, { inputTokens: 40, outputTokens: 20 });
	assert.deepEqual(scaleModelUsage(target, 0.5).model.autoRouting, { inputTokens: 40, outputTokens: 20 });
	assert.deepEqual(reconcileModelUsageToTotal(target, 600, 300).model.autoRouting, { inputTokens: 160, outputTokens: 120 });
	const replacement: ModelUsage = { model: { inputTokens: 1_000_000, outputTokens: 1_000_000, cachedReadTokens: 500_000, sessions: 0 } };
	preserveAutoRouting(source, replacement);
	assert.deepEqual(replacement.model.autoRouting, { inputTokens: 400_000, outputTokens: 500_000, cachedReadTokens: 200_000 });
	const pricing = { model: { inputCostPerMillion: 20, outputCostPerMillion: 40,
		copilotPricing: { inputCostPerMillion: 2, outputCostPerMillion: 4, cachedInputCostPerMillion: 0.2 } } };
	assert.ok(Math.abs(calculateEstimatedCost(replacement, pricing, 'copilot') - 4.856) < 1e-12);
});

test('debug-log supplementation retains cached Auto usage, daily costs and source immutability', () => {
	const cached = makeSession({
		modelUsage: { model: { inputTokens: 100, outputTokens: 40, sessions: 1,
			autoRouting: { inputTokens: 40, outputTokens: 20 } } },
		dailyRollups: { '2026-09-11': { tokens: 140, actualTokens: 140, thinkingTokens: 0, interactions: 1, modelUsage: {} } },
	});
	const before = structuredClone(cached);
	const debug: ModelUsage = { model: { inputTokens: 1_000_000, outputTokens: 1_000_000, cachedReadTokens: 500_000, sessions: 0 } };
	const usage = reconcileDebugLogModelUsage(cached.modelUsage, debug, 1_000_000, 1_000_000);
	assert.deepEqual(usage.model.autoRouting, { inputTokens: 400_000, outputTokens: 500_000, cachedReadTokens: 200_000 });
	const daily = distributeModelUsageToDays(cached.dailyRollups!, usage)!;
	assert.deepEqual(daily['2026-09-11'].modelUsage.model.autoRouting, usage.model.autoRouting);
	assert.equal(daily['2026-09-11'].actualTokens, 2_000_000);
	assert.deepEqual(cached, before);
	assert.equal(debug.model.autoRouting, undefined);
	const noBreakdown = reconcileDebugLogModelUsage(cached.modelUsage, {}, 1_000_000, 1_000_000);
	assert.deepEqual(noBreakdown.model.autoRouting, { inputTokens: 400_000, outputTokens: 500_000 });
	const pricing = { model: { inputCostPerMillion: 20, outputCostPerMillion: 40,
		copilotPricing: { inputCostPerMillion: 2, outputCostPerMillion: 4, cachedInputCostPerMillion: 0.2 } } };
	assert.ok(Math.abs(calculateEstimatedCost(daily['2026-09-11'].modelUsage, pricing, 'copilot') - 4.856) < 1e-12);
});

test('partial debug breakdown does not transfer unmatched Auto eligibility to another model', () => {
	const original: ModelUsage = {
		autoModel: { inputTokens: 100, outputTokens: 100, sessions: 1, autoRouting: { inputTokens: 100, outputTokens: 100 } },
		manualModel: { inputTokens: 100, outputTokens: 100, sessions: 1 },
	};
	const usage = reconcileDebugLogModelUsage(original, { manualModel: { inputTokens: 200, outputTokens: 200, sessions: 0 } }, 400, 400);
	assert.equal(usage.manualModel.autoRouting, undefined);
	assert.equal(usage.autoModel, undefined);
	assert.deepEqual(original.autoModel.autoRouting, { inputTokens: 100, outputTokens: 100 });
});
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
const lastMonthStartMs = new Date(Date.UTC(lastMonthLastDay.getUTCFullYear(), lastMonthLastDay.getUTCMonth(), 1)).getTime();
return { todayUtcKey, monthUtcStartKey, lastMonthUtcStartKey, lastMonthUtcEndKey, last30DaysUtcStartKey, last30DaysStartMs, lastMonthStartMs };
}

// ── computeSessionTotalTokens ────────────────────────────────────────────────

test('computeSessionTotalTokens: sums input, output, and thinking tokens', () => {
assert.strictEqual(computeSessionTotalTokens(100, 20, 5), 125);
});

test('computeSessionTotalTokens: does not double-count cached tokens (regression)', () => {
// inputTokens already includes cache-read tokens (e.g. 100 input tokens of
// which 40 were cache reads). The total must stay 100 + 20 + 0 = 120 and
// must NOT add the 40 cached tokens again on top.
const inputTokensIncludingCache = 100;
const cachedReadTokensSubsetOfInput = 40;
const total = computeSessionTotalTokens(inputTokensIncludingCache, 20, 0);
assert.strictEqual(total, 120);
assert.notStrictEqual(total, 120 + cachedReadTokensSubsetOfInput);
});

// ── computeSessionDurationMs ─────────────────────────────────────────────────

test('computeSessionDurationMs: returns the difference between first and last interaction', () => {
assert.strictEqual(
computeSessionDurationMs('2026-07-11T10:00:00.000Z', '2026-07-11T10:12:00.000Z'),
12 * 60 * 1000,
);
});

test('computeSessionDurationMs: returns 0 for identical timestamps', () => {
assert.strictEqual(computeSessionDurationMs('2026-07-11T10:00:00.000Z', '2026-07-11T10:00:00.000Z'), 0);
});

test('computeSessionDurationMs: returns undefined when either timestamp is missing', () => {
assert.strictEqual(computeSessionDurationMs(null, '2026-07-11T10:00:00.000Z'), undefined);
assert.strictEqual(computeSessionDurationMs('2026-07-11T10:00:00.000Z', null), undefined);
assert.strictEqual(computeSessionDurationMs(undefined, undefined), undefined);
assert.strictEqual(computeSessionDurationMs('', ''), undefined);
});

test('computeSessionDurationMs: returns undefined for invalid or negative ranges', () => {
assert.strictEqual(computeSessionDurationMs('not-a-date', '2026-07-11T10:00:00.000Z'), undefined);
assert.strictEqual(computeSessionDurationMs('2026-07-11T10:00:00.000Z', 'not-a-date'), undefined);
// last before first (clock skew / corrupt data) must not yield a negative duration
assert.strictEqual(computeSessionDurationMs('2026-07-11T10:12:00.000Z', '2026-07-11T10:00:00.000Z'), undefined);
});

// ── addModelUsage ────────────────────────────────────────────────────────────

test('addModelUsage: adds a new model to an empty target', () => {
const target: ModelUsage = {};
const source: ModelUsage = { 'gpt-4': { inputTokens: 100, outputTokens: 50, sessions: 0} };
addModelUsage(target, source);
assert.deepEqual(target['gpt-4'], { inputTokens: 100, outputTokens: 50, sessions: 0});
});

test('addModelUsage: accumulates tokens for an existing model', () => {
const target: ModelUsage = { 'gpt-4': { inputTokens: 200, outputTokens: 100, sessions: 0} };
const source: ModelUsage = { 'gpt-4': { inputTokens: 50, outputTokens: 25, sessions: 0} };
addModelUsage(target, source);
assert.deepEqual(target['gpt-4'], { inputTokens: 250, outputTokens: 125, sessions: 0});
});

test('addModelUsage: merges multiple models at once', () => {
const target: ModelUsage = { 'gpt-4': { inputTokens: 100, outputTokens: 50, sessions: 0} };
const source: ModelUsage = {
'gpt-4': { inputTokens: 10, outputTokens: 5, sessions: 0},
'claude-3-5-sonnet': { inputTokens: 200, outputTokens: 100, sessions: 0},
};
addModelUsage(target, source);
assert.deepEqual(target['gpt-4'], { inputTokens: 110, outputTokens: 55, sessions: 0});
assert.deepEqual(target['claude-3-5-sonnet'], { inputTokens: 200, outputTokens: 100, sessions: 0});
});

test('addModelUsage: merges cachedReadTokens from source to empty target', () => {
const target: ModelUsage = {};
const source: ModelUsage = { 'claude-3-5-sonnet': { inputTokens: 300, outputTokens: 150, cachedReadTokens: 80, sessions: 0} };
addModelUsage(target, source);
assert.equal(target['claude-3-5-sonnet'].cachedReadTokens, 80);
});

test('addModelUsage: accumulates cachedReadTokens when both have the field', () => {
const target: ModelUsage = { 'claude-3-5-sonnet': { inputTokens: 300, outputTokens: 150, cachedReadTokens: 40, sessions: 0} };
const source: ModelUsage = { 'claude-3-5-sonnet': { inputTokens: 100, outputTokens: 50, cachedReadTokens: 20, sessions: 0} };
addModelUsage(target, source);
assert.equal(target['claude-3-5-sonnet'].cachedReadTokens, 60);
});

test('addModelUsage: merges cacheCreationTokens', () => {
const target: ModelUsage = { 'claude-3-5-sonnet': { inputTokens: 300, outputTokens: 150, sessions: 0} };
const source: ModelUsage = { 'claude-3-5-sonnet': { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 30, sessions: 0} };
addModelUsage(target, source);
assert.equal(target['claude-3-5-sonnet'].cacheCreationTokens, 30);
});

test('addModelUsage: accumulates both cache fields together', () => {
const target: ModelUsage = {
'claude-3-5-sonnet': { inputTokens: 300, outputTokens: 150, cachedReadTokens: 20, cacheCreationTokens: 10, sessions: 0}
};
const source: ModelUsage = {
'claude-3-5-sonnet': { inputTokens: 100, outputTokens: 50, cachedReadTokens: 5, cacheCreationTokens: 3, sessions: 0}
};
addModelUsage(target, source);
assert.deepEqual(target['claude-3-5-sonnet'], {
inputTokens: 400,
outputTokens: 200,
cachedReadTokens: 25,
cacheCreationTokens: 13, sessions: 0,});
});

test('addModelUsage: does not add undefined cache fields to target', () => {
const target: ModelUsage = {};
const source: ModelUsage = { 'gpt-4': { inputTokens: 100, outputTokens: 50, sessions: 0} };
addModelUsage(target, source);
assert.equal(target['gpt-4'].cachedReadTokens, undefined);
assert.equal(target['gpt-4'].cacheCreationTokens, undefined);
});

test('addModelUsage: source with empty object is a no-op', () => {
const target: ModelUsage = { 'gpt-4': { inputTokens: 100, outputTokens: 50, sessions: 0} };
addModelUsage(target, {});
assert.deepEqual(target, { 'gpt-4': { inputTokens: 100, outputTokens: 50, sessions: 0} });
});

// ── reconcileModelUsageToTotal ──────────────────────────────────────────────

test('reconcileModelUsageToTotal: returns modelUsage unchanged when target totals are zero', () => {
const modelUsage: ModelUsage = { 'gpt-4': { inputTokens: 100, outputTokens: 50, sessions: 0} };
const result = reconcileModelUsageToTotal(modelUsage, 0, 0);
assert.deepEqual(result, modelUsage);
});

test('reconcileModelUsageToTotal: no-op when the breakdown already matches the target (regression for the Input > Total bug)', () => {
// The bug this guards: Input/Output tokens (from modelUsage) must never exceed
// Total tokens (the debug-log/actualTokens total) in the details webview table.
const modelUsage: ModelUsage = { 'gpt-4': { inputTokens: 100, outputTokens: 50, sessions: 0} };
const result = reconcileModelUsageToTotal(modelUsage, 100, 50);
assert.deepEqual(result, { 'gpt-4': { inputTokens: 100, outputTokens: 50, sessions: 0} });
});

test('reconcileModelUsageToTotal: scales a single model proportionally down to the target total', () => {
// Stale pre-debug-log estimate overcounted input tokens (111 vs the debug log's
// authoritative 90) — this is the exact shape of the reported "Input > Total" bug.
const modelUsage: ModelUsage = { 'gpt-4': { inputTokens: 111, outputTokens: 40, sessions: 0} };
const result = reconcileModelUsageToTotal(modelUsage, 90, 30);
assert.deepEqual(result, { 'gpt-4': { inputTokens: 90, outputTokens: 30, sessions: 0} });
});

test('reconcileModelUsageToTotal: preserves relative shares across multiple models', () => {
const modelUsage: ModelUsage = {
'gpt-4': { inputTokens: 300, outputTokens: 100, sessions: 0},
'claude-3-5-sonnet': { inputTokens: 100, outputTokens: 100, sessions: 0},
};
// Target is double the current total (400 input / 200 output).
const result = reconcileModelUsageToTotal(modelUsage, 800, 400);
assert.deepEqual(result['gpt-4'], { inputTokens: 600, outputTokens: 200, sessions: 0});
assert.deepEqual(result['claude-3-5-sonnet'], { inputTokens: 200, outputTokens: 200, sessions: 0});
});

test('reconcileModelUsageToTotal: scales cachedReadTokens and cacheCreationTokens using the input scale factor', () => {
const modelUsage: ModelUsage = {
'claude-3-5-sonnet': { inputTokens: 200, outputTokens: 50, cachedReadTokens: 80, cacheCreationTokens: 20, sessions: 0},
};
const result = reconcileModelUsageToTotal(modelUsage, 100, 50);
assert.deepEqual(result['claude-3-5-sonnet'], {
inputTokens: 100, outputTokens: 50, cachedReadTokens: 40, cacheCreationTokens: 10, sessions: 0,});
});

test('reconcileModelUsageToTotal: attributes the whole target to an "unknown" bucket when modelUsage has no usable breakdown', () => {
const result = reconcileModelUsageToTotal({}, 100, 50);
assert.deepEqual(result, { unknown: { inputTokens: 100, outputTokens: 50, sessions: 0} });
});

test('reconcileModelUsageToTotal: sum of reconciled models always equals the target totals (no silent drift)', () => {
const modelUsage: ModelUsage = {
'gpt-4': { inputTokens: 37, outputTokens: 11, sessions: 0},
'claude-3-5-sonnet': { inputTokens: 53, outputTokens: 29, sessions: 0},
};
const result = reconcileModelUsageToTotal(modelUsage, 1000, 333);
const totalInput = Object.values(result).reduce((s, u) => s + u.inputTokens, 0);
const totalOutput = Object.values(result).reduce((s, u) => s + u.outputTokens, 0);
assert.strictEqual(totalInput, 1000);
assert.strictEqual(totalOutput, 333);
});

// ── reconcileModelUsageToActualTokens ─────────────────────────────────────────

test('reconcileModelUsageToActualTokens: no-op when the breakdown already sums to the actual total', () => {
const modelUsage: ModelUsage = { 'gpt-4': { inputTokens: 70, outputTokens: 30, sessions: 0} };
const result = reconcileModelUsageToActualTokens(modelUsage, 100);
assert.deepEqual(result, { 'gpt-4': { inputTokens: 70, outputTokens: 30, sessions: 0} });
});

test('reconcileModelUsageToActualTokens: scales input down while preserving real output counts', () => {
// Event-based CLI sessions can estimate total input from accumulated message content
// while the session total is derived from real output via an input:output ratio. When
// user content is large and model output is small, the breakdown input can exceed total.
const modelUsage: ModelUsage = { 'gpt-4o': { inputTokens: 1000, outputTokens: 100, sessions: 0} };
const result = reconcileModelUsageToActualTokens(modelUsage, 300);
// Output stays authoritative (100), input shrinks to fit the 300 total.
assert.deepEqual(result['gpt-4o'], { inputTokens: 200, outputTokens: 100, sessions: 0});
const total = Object.values(result).reduce((s, u) => s + u.inputTokens + u.outputTokens, 0);
assert.strictEqual(total, 300);
});

test('reconcileModelUsageToActualTokens: proportional fallback when output already exceeds the actual total', () => {
const modelUsage: ModelUsage = { 'o1': { inputTokens: 50, outputTokens: 200, sessions: 0} };
const result = reconcileModelUsageToActualTokens(modelUsage, 100);
const total = Object.values(result).reduce((s, u) => s + u.inputTokens + u.outputTokens, 0);
assert.strictEqual(total, 100);
assert.ok(result['o1'].outputTokens <= 100);
assert.ok(result['o1'].inputTokens <= 100);
});

test('reconcileModelUsageToActualTokens: distributes across multiple models preserving output shares', () => {
const modelUsage: ModelUsage = {
'gpt-4': { inputTokens: 500, outputTokens: 80, sessions: 0},
'claude-3-5-sonnet': { inputTokens: 300, outputTokens: 20, sessions: 0},
};
const result = reconcileModelUsageToActualTokens(modelUsage, 250);
assert.deepEqual(result['gpt-4'], { inputTokens: 94, outputTokens: 80, sessions: 0});
assert.deepEqual(result['claude-3-5-sonnet'], { inputTokens: 56, outputTokens: 20, sessions: 0});
const total = Object.values(result).reduce((s, u) => s + u.inputTokens + u.outputTokens, 0);
assert.strictEqual(total, 250);
});

test('reconcileModelUsageToActualTokens: no-op when actualTokens is zero or negative', () => {
const modelUsage: ModelUsage = { 'gpt-4': { inputTokens: 100, outputTokens: 50, sessions: 0} };
assert.deepEqual(reconcileModelUsageToActualTokens(modelUsage, 0), modelUsage);
assert.deepEqual(reconcileModelUsageToActualTokens(modelUsage, -1), modelUsage);
});

test('reconcileModelUsageToActualTokens: creates unknown bucket for empty modelUsage', () => {
const result = reconcileModelUsageToActualTokens({}, 100);
assert.deepEqual(result, { unknown: { inputTokens: 100, outputTokens: 0, sessions: 0} });
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
// Note: computeUtcDateRanges now uses LOCAL calendar dates so that "today"
// reflects the user's local clock. Tests use local date constructors
// (new Date(year, month, day, ...)) to be timezone-agnostic.
// To verify timezone behaviour: TZ=Europe/Amsterdam node --test out/test/unit/statsHelpers.test.js

test('computeUtcDateRanges: todayUtcKey is the local calendar date of the input', () => {
const now = new Date(2024, 4, 15, 14, 30, 0); // local May 15, 2024 at 14:30
const ranges = computeUtcDateRanges(now);
assert.equal(ranges.todayUtcKey, '2024-05-15');
});

// Local midnight boundary: just before local midnight — still the previous day
test('computeUtcDateRanges: just before local midnight resolves to the preceding day', () => {
const now = new Date(2024, 4, 14, 23, 59, 59, 999); // local May 14 at 23:59:59.999
const ranges = computeUtcDateRanges(now);
assert.equal(ranges.todayUtcKey, '2024-05-14');
});

// Local midnight boundary: at local midnight — flips to the new day
test('computeUtcDateRanges: at local midnight resolves to the new day', () => {
const now = new Date(2024, 4, 15, 0, 0, 0, 0); // local May 15 at 00:00:00.000
const ranges = computeUtcDateRanges(now);
assert.equal(ranges.todayUtcKey, '2024-05-15');
});

// DST transition: local date arithmetic via new Date(y, m, d) handles DST automatically
test('computeUtcDateRanges: DST spring-forward day is the correct local date', () => {
// Local March 10, 2024 at 10:00 AM — well after any spring-forward gap
const now = new Date(2024, 2, 10, 10, 0, 0); // local March 10, 2024
const ranges = computeUtcDateRanges(now);
assert.equal(ranges.todayUtcKey, '2024-03-10');
});

test('computeUtcDateRanges: DST fall-back day is the correct local date', () => {
// Local November 3, 2024 at 00:30 AM
const now = new Date(2024, 10, 3, 0, 30, 0); // local November 3, 2024
const ranges = computeUtcDateRanges(now);
assert.equal(ranges.todayUtcKey, '2024-11-03');
});

// Month rollover: last day of a month
test('computeUtcDateRanges: last day of January produces correct month boundaries', () => {
const now = new Date(2024, 0, 31, 12, 0, 0); // local January 31, 2024
const ranges = computeUtcDateRanges(now);
assert.equal(ranges.todayUtcKey, '2024-01-31');
assert.equal(ranges.monthUtcStartKey, '2024-01-01');
assert.equal(ranges.lastMonthUtcStartKey, '2023-12-01');
assert.equal(ranges.lastMonthUtcEndKey, '2023-12-31');
});

// Month rollover: first day of the next month
test('computeUtcDateRanges: first day of February produces correct month boundaries', () => {
const now = new Date(2024, 1, 1, 0, 0, 0); // local February 1, 2024 at midnight
const ranges = computeUtcDateRanges(now);
assert.equal(ranges.todayUtcKey, '2024-02-01');
assert.equal(ranges.monthUtcStartKey, '2024-02-01');
assert.equal(ranges.lastMonthUtcStartKey, '2024-01-01');
assert.equal(ranges.lastMonthUtcEndKey, '2024-01-31');
});

// Month rollover over a year boundary
test('computeUtcDateRanges: January 1st has December as previous month', () => {
const now = new Date(2025, 0, 1, 0, 0, 0); // local January 1, 2025
const ranges = computeUtcDateRanges(now);
assert.equal(ranges.monthUtcStartKey, '2025-01-01');
assert.equal(ranges.lastMonthUtcStartKey, '2024-12-01');
assert.equal(ranges.lastMonthUtcEndKey, '2024-12-31');
});

// 30-day window boundary: a file older than 30 days must fall before last30DaysStartMs
test('computeUtcDateRanges: file mtime 31 days ago is outside the 30-day window', () => {
const now = new Date(2024, 4, 15, 12, 0, 0); // local May 15 at noon
const ranges = computeUtcDateRanges(now);
// 31 local days before May 15 = April 14; any time on April 14 is before the window start
const fileOlderThan30Days = new Date(2024, 3, 14, 11, 59, 59, 999).getTime();
assert.ok(fileOlderThan30Days < ranges.last30DaysStartMs,
'mtime 31 days ago should be less than last30DaysStartMs (i.e. excluded)');
});

test('computeUtcDateRanges: file mtime exactly at window start is inside the 30-day window', () => {
const now = new Date(2024, 4, 15, 12, 0, 0); // local May 15 at noon
const ranges = computeUtcDateRanges(now);
const fileAtWindowStart = ranges.last30DaysStartMs;
assert.ok(fileAtWindowStart >= ranges.last30DaysStartMs,
'mtime at window start boundary should not be excluded');
});

test('computeUtcDateRanges: last30DaysUtcStartKey is 30 calendar dates including today', () => {
const now = new Date(2024, 4, 15, 12, 0, 0); // local May 15
const ranges = computeUtcDateRanges(now);
// April 16..May 15 inclusive is 30 calendar dates.
assert.equal(ranges.last30DaysUtcStartKey, '2024-04-16');
});

test('computeUtcDateRanges: 30-day window crosses a month boundary correctly', () => {
const now = new Date(2024, 2, 10, 12, 0, 0); // local March 10
const ranges = computeUtcDateRanges(now);
// Feb 10..Mar 10 inclusive is 30 calendar dates (2024 is a leap year: Feb has 29 days).
assert.equal(ranges.last30DaysUtcStartKey, '2024-02-10');
});

test('computeUtcDateRanges: last30DaysUtcStartKey always agrees with the Recent Sessions last30 lookback', () => {
// The two used to disagree by one day (this function started the window at
// `now - 30`, getTimeWindowStartDayKey('last30') at `now - 30 + 1`), so a
// session active exactly on the older boundary day could be counted in a
// "Last 30 Days" total without appearing in a same-labelled Recent Sessions
// list. computeUtcDateRanges now derives its boundary from the same helper,
// so this can no longer drift — this test guards that sharing.
for (const now of [
new Date(2024, 4, 15, 12, 0, 0),
new Date(2024, 2, 10, 12, 0, 0),
new Date(2025, 0, 1, 0, 0, 0),
new Date(2026, 4, 13, 10, 0, 0),
]) {
const ranges = computeUtcDateRanges(now);
assert.equal(ranges.last30DaysUtcStartKey, getTimeWindowStartDayKey('last30', now));
}
});

test('computeUtcDateRanges: last30DaysStartMs equals the local midnight of last30DaysUtcStartKey', () => {
const now = new Date(2024, 4, 15, 12, 0, 0); // local May 15 at noon
const ranges = computeUtcDateRanges(now);
// last30DaysStartKey is April 16; local midnight of April 16
const [year, month, day] = ranges.last30DaysUtcStartKey.split('-').map(Number);
const expectedMs = new Date(year, month - 1, day).getTime();
assert.equal(ranges.last30DaysStartMs, expectedMs);
});

test('computeUtcDateRanges: lastMonthStartMs equals local midnight of lastMonthUtcStartKey', () => {
const now = new Date(2026, 4, 13, 10, 0, 0); // local May 13, 2026
const ranges = computeUtcDateRanges(now);
// For May 13, previous month = April, so lastMonthUtcStartKey = 2026-04-01
const expectedMs = new Date(2026, 3, 1).getTime(); // local April 1, 2026 midnight
assert.equal(ranges.lastMonthStartMs, expectedMs);
assert.equal(ranges.lastMonthUtcStartKey, '2026-04-01');
});

test('computeUtcDateRanges: lastMonthStartMs is earlier than last30DaysStartMs when today is May 13', () => {
// On May 13, last30Days starts Apr 14 but previous month starts Apr 1.
// The file-load cutoff should be Apr 1 (lastMonthStartMs < last30DaysStartMs).
const now = new Date(2026, 4, 13, 0, 0, 0); // local May 13, 2026
const ranges = computeUtcDateRanges(now);
assert.ok(ranges.lastMonthStartMs < ranges.last30DaysStartMs,
'lastMonthStartMs should be before last30DaysStartMs when today is in the first half of the month');
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

test('aggregatePeriodStats: rollup path – populates taskCategoryUsage on the daily entry (regression: chart By Task week/month bug)', () => {
const ranges = makeRanges('2025-03-15');
const input: SessionAggregateInput = {
editorType: 'vscode',
mtime: new Date('2025-03-15T10:00:00.000Z').getTime(),
sessionData: makeSession({
taskCategory: 'Coding',
dailyRollups: {
'2025-03-15': { tokens: 100, actualTokens: 120, thinkingTokens: 0, interactions: 2, modelUsage: {}, primaryTaskCategory: 'Coding' },
},
}),
};
const result = aggregatePeriodStats([input], ranges);
const day = result.dailyStatsMap.get('2025-03-15');
assert.ok(day, 'daily entry should exist');
assert.deepEqual(day!.taskCategoryUsage, { Coding: { tokens: 120, sessions: 1 } });
});

test('aggregatePeriodStats: fallback path – populates taskCategoryUsage on the daily entry (regression: chart By Task week/month bug)', () => {
const ranges = makeRanges('2025-03-15');
const input: SessionAggregateInput = {
editorType: 'vscode',
mtime: new Date('2025-03-14T10:00:00.000Z').getTime(),
lastInteraction: '2025-03-14T10:00:00.000Z',
sessionData: makeSession({ tokens: 50, taskCategory: 'Debugging' }),
};
const result = aggregatePeriodStats([input], ranges);
const day = result.dailyStatsMap.get('2025-03-14');
assert.ok(day, 'daily entry should exist');
assert.deepEqual(day!.taskCategoryUsage, { Debugging: { tokens: 50, sessions: 1 } });
});

test('aggregatePeriodStats: rollup path – populates taskCategoryTokens/Sessions/ModelUsage on the daily entry (regression: By Task chart empty after periodic refresh)', () => {
// buildTaskCategoryTokenDatasets/SessionDatasets/CostDatasets (chartDataBuilder.ts) — the
// datasets the chart's "By Task" split actually renders from — read these three fields, not
// taskCategoryUsage. Without them, a periodic background refresh (calculateDetailedStats ->
// aggregatePeriodStats -> mergeIntoFullDailyStats) silently wipes the chart's task-category
// bars for the recent day range even though taskCategoryUsage stays populated.
const ranges = makeRanges('2025-03-15');
const input: SessionAggregateInput = {
editorType: 'vscode',
mtime: new Date('2025-03-15T10:00:00.000Z').getTime(),
sessionData: makeSession({
taskCategory: 'Coding',
dailyRollups: {
'2025-03-15': { tokens: 100, actualTokens: 120, thinkingTokens: 0, interactions: 2, modelUsage: { 'gpt-4o': { inputTokens: 80, outputTokens: 40, sessions: 1 } }, primaryTaskCategory: 'Coding' },
},
}),
};
const result = aggregatePeriodStats([input], ranges);
const day = result.dailyStatsMap.get('2025-03-15');
assert.ok(day, 'daily entry should exist');
assert.deepEqual(day!.taskCategoryTokens, { Coding: 120 });
assert.deepEqual(day!.taskCategorySessions, { Coding: 1 });
// taskCategoryModelUsage is scaled by category share (scaleModelUsage), which always
// reports sessions: 0 — session counting for this map lives in taskCategorySessions above.
assert.deepEqual(day!.taskCategoryModelUsage, { Coding: { 'gpt-4o': { inputTokens: 80, outputTokens: 40, sessions: 0 } } });
});

test('aggregatePeriodStats: rollup path – splits a mixed session across categories using per-day taskCategoryShares', () => {
// Regression for a PR review finding: the rollup path must weight by the day's own
// taskCategoryShares/primaryTaskCategory (mirroring extension.ts's addUsageToDailyEntry
// call), not collapse a multi-category session onto sessionData.taskCategory.
const ranges = makeRanges('2025-03-15');
const input: SessionAggregateInput = {
editorType: 'vscode',
mtime: new Date('2025-03-15T10:00:00.000Z').getTime(),
sessionData: makeSession({
taskCategory: 'Coding',
dailyRollups: {
'2025-03-15': {
tokens: 100, actualTokens: 100, thinkingTokens: 0, interactions: 2,
modelUsage: { 'gpt-4o': { inputTokens: 60, outputTokens: 40, sessions: 1 } },
primaryTaskCategory: 'Coding',
taskCategoryShares: makeShares({ Coding: 0.75, Debugging: 0.25 }),
},
},
}),
};
const result = aggregatePeriodStats([input], ranges);
const day = result.dailyStatsMap.get('2025-03-15');
assert.ok(day, 'daily entry should exist');
assert.deepEqual(day!.taskCategoryTokens, { Coding: 75, Debugging: 25 });
assert.deepEqual(day!.taskCategorySessions, { Coding: 0.75, Debugging: 0.25 });
// The cost chart is driven by taskCategoryModelUsage, not taskCategoryTokens — assert it
// separately so a regression in the per-category model-usage scaling doesn't slip through.
assert.deepEqual(day!.taskCategoryModelUsage, {
Coding: { 'gpt-4o': { inputTokens: 45, outputTokens: 30, sessions: 0 } },
Debugging: { 'gpt-4o': { inputTokens: 15, outputTokens: 10, sessions: 0 } },
});
});

test('aggregatePeriodStats: fallback path – populates taskCategoryTokens/Sessions/ModelUsage on the daily entry (regression: By Task chart empty after periodic refresh)', () => {
const ranges = makeRanges('2025-03-15');
const input: SessionAggregateInput = {
editorType: 'vscode',
mtime: new Date('2025-03-14T10:00:00.000Z').getTime(),
lastInteraction: '2025-03-14T10:00:00.000Z',
sessionData: makeSession({ tokens: 50, taskCategory: 'Debugging', modelUsage: { 'gpt-4o': { inputTokens: 30, outputTokens: 20, sessions: 1 } } }),
};
const result = aggregatePeriodStats([input], ranges);
const day = result.dailyStatsMap.get('2025-03-14');
assert.ok(day, 'daily entry should exist');
assert.deepEqual(day!.taskCategoryTokens, { Debugging: 50 });
assert.deepEqual(day!.taskCategorySessions, { Debugging: 1 });
assert.deepEqual(day!.taskCategoryModelUsage, { Debugging: { 'gpt-4o': { inputTokens: 30, outputTokens: 20, sessions: 0 } } });
});

test('aggregatePeriodStats: fallback path – splits a mixed session across categories using session-level taskCategoryShares', () => {
const ranges = makeRanges('2025-03-15');
const input: SessionAggregateInput = {
editorType: 'vscode',
mtime: new Date('2025-03-14T10:00:00.000Z').getTime(),
lastInteraction: '2025-03-14T10:00:00.000Z',
sessionData: makeSession({
tokens: 50,
taskCategory: 'Debugging',
taskCategoryShares: makeShares({ Debugging: 0.6, Testing: 0.4 }),
}),
};
const result = aggregatePeriodStats([input], ranges);
const day = result.dailyStatsMap.get('2025-03-14');
assert.ok(day, 'daily entry should exist');
assert.deepEqual(day!.taskCategoryTokens, { Debugging: 30, Testing: 20 });
assert.deepEqual(day!.taskCategorySessions, { Debugging: 0.6, Testing: 0.4 });
});

test('aggregatePeriodStats: rollup path – falls back to "Conversation" when neither the day nor the session has category info', () => {
// addTaskCategoryToDailyEntry's own fallback, exercised when a pre-existing cached dailyRollup
// predates task classification (no primaryTaskCategory/taskCategoryShares) AND the session
// itself has no taskCategory either.
const ranges = makeRanges('2025-03-15');
const input: SessionAggregateInput = {
editorType: 'vscode',
mtime: new Date('2025-03-15T10:00:00.000Z').getTime(),
sessionData: makeSession({
dailyRollups: {
'2025-03-15': { tokens: 100, actualTokens: 100, thinkingTokens: 0, interactions: 2, modelUsage: {} },
},
}),
};
const result = aggregatePeriodStats([input], ranges);
const day = result.dailyStatsMap.get('2025-03-15');
assert.ok(day, 'daily entry should exist');
assert.deepEqual(day!.taskCategoryTokens, { Conversation: 100 });
assert.deepEqual(day!.taskCategorySessions, { Conversation: 1 });
});

test('aggregatePeriodStats: rollup path – falls back to the session-level taskCategory (not "Conversation") when only the day rollup lacks category info', () => {
// Regression for a PR review finding: a day rollup that predates per-day task classification
// (no primaryTaskCategory/taskCategoryShares of its own) must still use the session's overall
// taskCategory — both for taskCategoryUsage (consumed by efficiencyAnalysis.ts's model
// task-mix comparison) and for the chart's per-category token/session/model-usage maps —
// rather than silently dropping to "Conversation" when the session's category is known.
const ranges = makeRanges('2025-03-15');
const input: SessionAggregateInput = {
editorType: 'vscode',
mtime: new Date('2025-03-15T10:00:00.000Z').getTime(),
sessionData: makeSession({
taskCategory: 'Refactoring',
dailyRollups: {
'2025-03-15': { tokens: 100, actualTokens: 100, thinkingTokens: 0, interactions: 2, modelUsage: {} },
},
}),
};
const result = aggregatePeriodStats([input], ranges);
const day = result.dailyStatsMap.get('2025-03-15');
assert.ok(day, 'daily entry should exist');
assert.deepEqual(day!.taskCategoryUsage, { Refactoring: { tokens: 100, sessions: 1 } });
assert.deepEqual(day!.taskCategoryTokens, { Refactoring: 100 });
assert.deepEqual(day!.taskCategorySessions, { Refactoring: 1 });
});

test('aggregatePeriodStats: rollup path – a "__proto__" task category is skipped and does not pollute Object.prototype', () => {
// Regression for a PR review security finding: taskCategory/taskCategoryShares ultimately come
// from cached/parsed session data. `if (!entry.taskCategoryModelUsage[cat]) { ... }` reads
// through the `__proto__` accessor to the real Object.prototype (truthy, so the own-property
// initializer is skipped) and addModelUsage would then write model fields directly onto it —
// the same class of bug isUnsafeObjectKey already guards against for "model" keys elsewhere in
// this file. Use JSON.parse (not an object literal) for the malicious share map so "__proto__"
// is a genuine own property, matching how untrusted JSON actually behaves.
const ranges = makeRanges('2025-03-15');
const maliciousShares = JSON.parse('{"__proto__": 1, "Coding": 0}') as TaskCategoryBreakdown;
const input: SessionAggregateInput = {
editorType: 'vscode',
mtime: new Date('2025-03-15T10:00:00.000Z').getTime(),
sessionData: makeSession({
taskCategory: '__proto__' as TaskCategory,
dailyRollups: {
'2025-03-15': {
tokens: 100, actualTokens: 100, thinkingTokens: 0, interactions: 2,
modelUsage: { 'gpt-4o': { inputTokens: 10, outputTokens: 5, sessions: 1 } },
primaryTaskCategory: '__proto__' as TaskCategory,
taskCategoryShares: maliciousShares,
},
},
}),
};
const result = aggregatePeriodStats([input], ranges);
const day = result.dailyStatsMap.get('2025-03-15');
assert.ok(day, 'daily entry should exist');
assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, 'gpt-4o'), false, 'Object.prototype must not gain model fields');
assert.equal(({} as any).tokens, undefined, 'plain objects must not inherit a stray tokens field');
assert.equal(Object.prototype.hasOwnProperty.call(day!.taskCategoryTokens ?? {}, '__proto__'), false);
assert.equal(Object.prototype.hasOwnProperty.call(day!.taskCategorySessions ?? {}, '__proto__'), false);
assert.equal(Object.prototype.hasOwnProperty.call(day!.taskCategoryModelUsage ?? {}, '__proto__'), false);
assert.equal(Object.prototype.hasOwnProperty.call(day!.taskCategoryUsage ?? {}, '__proto__'), false);
});

test('aggregatePeriodStats: rollup path – an all-zero taskCategoryShares breakdown falls back to the primary category', () => {
// Regression for a PR review finding: TaskCategoryBreakdown is always a full, all-categories
// map, so `Object.keys(taskCategoryShares).length > 0` is always true even when every share is
// 0 — that alone must not be treated as "meaningful shares", or every category gets filtered
// out by the `share <= 0` check below and the entry ends up with no attribution at all.
const ranges = makeRanges('2025-03-15');
const input: SessionAggregateInput = {
editorType: 'vscode',
mtime: new Date('2025-03-15T10:00:00.000Z').getTime(),
sessionData: makeSession({
taskCategory: 'Testing',
dailyRollups: {
'2025-03-15': {
tokens: 100, actualTokens: 100, thinkingTokens: 0, interactions: 2, modelUsage: {},
primaryTaskCategory: 'Testing',
taskCategoryShares: makeShares({}),
},
},
}),
};
const result = aggregatePeriodStats([input], ranges);
const day = result.dailyStatsMap.get('2025-03-15');
assert.ok(day, 'daily entry should exist');
assert.deepEqual(day!.taskCategoryTokens, { Testing: 100 });
assert.deepEqual(day!.taskCategorySessions, { Testing: 1 });
});

test('aggregatePeriodStats: rollup path – falls back to "Conversation" when the only known category is unsafe and there are no shares', () => {
// Regression for a PR review finding: an unsafe taskCategory (e.g. "__proto__") must not become
// the sole entry in the shares fallback map (`{ [taskCategory]: 1 }`), which would then get
// filtered out by isUnsafeObjectKey inside the loop and leave the entry with no attribution —
// it should fall through to the "Conversation" default instead, same as no category at all.
const ranges = makeRanges('2025-03-15');
const input: SessionAggregateInput = {
editorType: 'vscode',
mtime: new Date('2025-03-15T10:00:00.000Z').getTime(),
sessionData: makeSession({
dailyRollups: {
'2025-03-15': {
tokens: 100, actualTokens: 100, thinkingTokens: 0, interactions: 2, modelUsage: {},
primaryTaskCategory: '__proto__' as TaskCategory,
},
},
}),
};
const result = aggregatePeriodStats([input], ranges);
const day = result.dailyStatsMap.get('2025-03-15');
assert.ok(day, 'daily entry should exist');
assert.deepEqual(day!.taskCategoryTokens, { Conversation: 100 });
assert.deepEqual(day!.taskCategorySessions, { Conversation: 1 });
});

test('aggregatePeriodStats: rollup path – counts sub-agent sessions once per period', () => {
const ranges = makeRanges('2025-03-15');
const withSubAgents: SessionAggregateInput = {
editorType: 'vscode',
mtime: new Date('2025-03-15T10:00:00.000Z').getTime(),
sessionData: makeSession({
subAgentCalls: 3,
dailyRollups: {
'2025-03-14': { tokens: 100, actualTokens: 0, thinkingTokens: 0, interactions: 1, modelUsage: {} },
'2025-03-15': { tokens: 100, actualTokens: 0, thinkingTokens: 0, interactions: 1, modelUsage: {} },
},
}),
};
const withoutSubAgents: SessionAggregateInput = {
editorType: 'vscode',
mtime: new Date('2025-03-15T11:00:00.000Z').getTime(),
sessionData: makeSession({
dailyRollups: {
'2025-03-15': { tokens: 50, actualTokens: 0, thinkingTokens: 0, interactions: 1, modelUsage: {} },
},
}),
};
const result = aggregatePeriodStats([withSubAgents, withoutSubAgents], ranges);
assert.equal(result.todayStats.subAgentSessions, 1, 'multi-day session counted once for today');
assert.equal(result.monthStats.subAgentSessions, 1);
assert.equal(result.last30DaysStats.subAgentSessions, 1);
assert.equal(result.lastMonthStats.subAgentSessions, 0);
});

test('aggregatePeriodStats: fallback path – counts sub-agent sessions by last-activity day', () => {
const ranges = makeRanges('2025-03-15');
const input: SessionAggregateInput = {
editorType: 'vscode',
mtime: new Date('2025-03-15T10:00:00.000Z').getTime(),
sessionData: makeSession({ subAgentCalls: 1, lastInteraction: '2025-03-15T10:00:00.000Z' }),
};
const result = aggregatePeriodStats([input], ranges);
assert.equal(result.todayStats.subAgentSessions, 1);
assert.equal(result.monthStats.subAgentSessions, 1);
assert.equal(result.last30DaysStats.subAgentSessions, 1);
assert.equal(result.lastMonthStats.subAgentSessions, 0);
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

test('aggregatePeriodStats: rollup path – days before 30-day window but in previous month are included in lastMonthStats', () => {
const ranges = makeRanges('2025-03-15'); // last30DaysStart = 2025-02-13, lastMonth = Feb 2025
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
assert.equal(result.last30DaysStats.tokens, 0, 'not in last 30 days');
assert.equal(result.lastMonthStats.tokens, 500, 'Feb 10 is in previous month (Feb)');
assert.equal(result.skippedCount, 0, 'session counts because it contributed to lastMonth');
assert.ok(!result.dailyStatsMap.has('2025-02-10'), 'not in daily chart (outside 30-day window)');
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

test('aggregatePeriodStats: fallback – session older than 30 days but in previous month is included in lastMonthStats', () => {
const ranges = makeRanges('2025-03-15'); // last30DaysStart = 2025-02-13, lastMonth = Feb 2025
const input: SessionAggregateInput = {
editorType: 'vscode',
mtime: new Date('2025-02-01T10:00:00.000Z').getTime(),
lastInteraction: '2025-02-01T10:00:00.000Z',
sessionData: makeSession({ tokens: 999, interactions: 10 }),
};
const result = aggregatePeriodStats([input], ranges);
assert.equal(result.last30DaysStats.tokens, 0, 'not in last 30 days');
assert.equal(result.lastMonthStats.tokens, 999, 'Feb 1 is in previous month (Feb)');
assert.equal(result.skippedCount, 0, 'session counts because it contributed to lastMonth');
assert.ok(!result.dailyStatsMap.has('2025-02-01'), 'not in daily chart (outside 30-day window)');
});

test('aggregatePeriodStats: fallback – session from two months ago is skipped entirely', () => {
const ranges = makeRanges('2025-03-15'); // lastMonth = Feb 2025
const input: SessionAggregateInput = {
editorType: 'vscode',
mtime: new Date('2025-01-15T10:00:00.000Z').getTime(),
lastInteraction: '2025-01-15T10:00:00.000Z',
sessionData: makeSession({ tokens: 999, interactions: 10 }),
};
const result = aggregatePeriodStats([input], ranges);
assert.equal(result.last30DaysStats.tokens, 0);
assert.equal(result.lastMonthStats.tokens, 0);
assert.equal(result.skippedCount, 1, 'Jan session is outside both windows');
});

// ── Local midnight boundary ──────────────────────────────────────────────────
// These tests use local date constructors (new Date(y, m, d, h, ...)) to verify
// that midnight attribution uses the local clock, not UTC.

test('local midnight boundary: event just before local midnight attributed to that local day', () => {
const ranges = makeRanges('2025-06-20');
// Local June 19 at 23:59:59.999 — should NOT be "today" (June 20)
const ts = new Date(2025, 5, 19, 23, 59, 59, 999); // local June 19
const input: SessionAggregateInput = {
editorType: 'vscode',
mtime: ts.getTime(),
lastInteraction: ts.toISOString(), // UTC equivalent of local June 19 23:59:59.999
sessionData: makeSession({ tokens: 50, interactions: 1 }),
};
const result = aggregatePeriodStats([input], ranges);
assert.ok(!result.dailyStatsMap.has('2025-06-20'), 'not attributed to today (June 20)');
assert.equal(result.todayStats.tokens, 0, 'not today');
assert.equal(result.monthStats.tokens, 50);
});

test('local midnight boundary: event just after local midnight attributed to the new local day', () => {
const ranges = makeRanges('2025-06-20');
// Local June 20 at 00:00:01 — should be "today"
const ts = new Date(2025, 5, 20, 0, 0, 1); // local June 20
const input: SessionAggregateInput = {
editorType: 'vscode',
mtime: ts.getTime(),
lastInteraction: ts.toISOString(),
sessionData: makeSession({ tokens: 60, interactions: 1 }),
};
const result = aggregatePeriodStats([input], ranges);
assert.ok(result.dailyStatsMap.has('2025-06-20'), 'attributed to today (June 20)');
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
// Local Jan 31 at 23:59 — should go to last month (January)
const ts = new Date(2026, 0, 31, 23, 59, 0); // local Jan 31
const input: SessionAggregateInput = {
editorType: 'vscode',
mtime: ts.getTime(),
lastInteraction: ts.toISOString(),
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

// ── April 1-12 regression (May-13 scenario) ───────────────────────────────────

test('aggregatePeriodStats: rollup – April 1 day is in lastMonthStats when today is May 13', () => {
// Regression: previously the early `dayKey < last30DaysUtcStartKey` guard skipped April 1-12.
const ranges = makeRanges('2026-05-13'); // last30DaysStart = 2026-04-13, lastMonth = April 2026
const input: SessionAggregateInput = {
editorType: 'copilot-cli',
mtime: new Date('2026-04-01T12:00:00.000Z').getTime(),
sessionData: makeSession({
dailyRollups: {
'2026-04-01': { tokens: 1000, actualTokens: 1200, thinkingTokens: 0, interactions: 5, modelUsage: {} },
},
}),
};
const result = aggregatePeriodStats([input], ranges);
assert.equal(result.lastMonthStats.tokens, 1200, 'April 1 is in previous month (April)');
assert.equal(result.last30DaysStats.tokens, 0, 'April 1 is before the 30-day window (Apr 13)');
assert.ok(!result.dailyStatsMap.has('2026-04-01'), 'not in daily chart');
assert.equal(result.lastMonthStats.sessions, 1);
assert.equal(result.skippedCount, 0);
});

test('aggregatePeriodStats: rollup – mixed rollup spanning April 1-12 and April 13-30', () => {
// Session with activity both in "lastMonth only" and "both windows" ranges.
const ranges = makeRanges('2026-05-13'); // last30DaysStart = 2026-04-13, lastMonth = April 2026
const input: SessionAggregateInput = {
editorType: 'copilot-cli',
mtime: new Date('2026-04-25T12:00:00.000Z').getTime(),
sessionData: makeSession({
dailyRollups: {
'2026-04-05': { tokens: 300, actualTokens: 0, thinkingTokens: 0, interactions: 3, modelUsage: {} }, // lastMonth only
'2026-04-20': { tokens: 500, actualTokens: 0, thinkingTokens: 0, interactions: 5, modelUsage: {} }, // both windows
},
}),
};
const result = aggregatePeriodStats([input], ranges);
assert.equal(result.lastMonthStats.tokens, 800, 'both April 5 and April 20 count toward last month');
assert.equal(result.last30DaysStats.tokens, 500, 'only April 20 is within last 30 days');
assert.ok(result.dailyStatsMap.has('2026-04-20'), 'April 20 in daily chart');
assert.ok(!result.dailyStatsMap.has('2026-04-05'), 'April 5 not in daily chart');
assert.equal(result.lastMonthStats.sessions, 1, 'counted once in lastMonth');
assert.equal(result.last30DaysStats.sessions, 1, 'counted once in last30Days');
assert.equal(result.skippedCount, 0);
});

test('aggregatePeriodStats: rollup – session with only two-months-ago data is fully skipped', () => {
const ranges = makeRanges('2026-05-13'); // lastMonth = April 2026
const input: SessionAggregateInput = {
editorType: 'copilot-cli',
mtime: new Date('2026-03-15T12:00:00.000Z').getTime(),
sessionData: makeSession({
dailyRollups: {
'2026-03-15': { tokens: 999, actualTokens: 0, thinkingTokens: 0, interactions: 1, modelUsage: {} },
},
}),
};
const result = aggregatePeriodStats([input], ranges);
assert.equal(result.lastMonthStats.tokens, 0, 'March data not in April lastMonth');
assert.equal(result.last30DaysStats.tokens, 0);
assert.equal(result.skippedCount, 1);
});

test('aggregatePeriodStats: fallback – April 5 session is in lastMonthStats when today is May 13', () => {
// Regression for fallback path: previously skipped when lastActivityUtcKey < last30DaysUtcStartKey.
const ranges = makeRanges('2026-05-13'); // last30DaysStart = 2026-04-13, lastMonth = April 2026
const input: SessionAggregateInput = {
editorType: 'vscode',
mtime: new Date('2026-04-05T10:00:00.000Z').getTime(),
lastInteraction: '2026-04-05T10:00:00.000Z',
sessionData: makeSession({ tokens: 750, actualTokens: 800, interactions: 8 }),
};
const result = aggregatePeriodStats([input], ranges);
assert.equal(result.lastMonthStats.tokens, 800, 'April 5 is in previous month (April)');
assert.equal(result.last30DaysStats.tokens, 0, 'April 5 is before the 30-day window');
assert.ok(!result.dailyStatsMap.has('2026-04-05'), 'not in daily chart');
assert.equal(result.skippedCount, 0);
});

// ── Cached tokens NOT included in Tokens (input+output) ──────────────────────

test('aggregatePeriodStats: rollup – tokens total is input+output only, not including cached', () => {
// tokens = actualTokens only; cachedReadTokens tracked separately in cachedTokens
const ranges = makeRanges('2025-03-15');
const input: SessionAggregateInput = {
editorType: 'vscode',
mtime: new Date('2025-03-15T10:00:00.000Z').getTime(),
sessionData: makeSession({
dailyRollups: {
'2025-03-15': { tokens: 100, actualTokens: 200, thinkingTokens: 0, cachedReadTokens: 300, interactions: 2, modelUsage: {} },
},
}),
};
const result = aggregatePeriodStats([input], ranges);
assert.equal(result.todayStats.tokens, 200, 'tokens = actualTokens(200) only, cachedReadTokens(300) excluded');
assert.equal(result.todayStats.cachedTokens, 300, 'cachedTokens accumulates separately');
assert.equal(result.monthStats.tokens, 200);
assert.equal(result.last30DaysStats.tokens, 200);
});

test('aggregatePeriodStats: rollup – missing cachedReadTokens does not affect total', () => {
const ranges = makeRanges('2025-03-15');
const input: SessionAggregateInput = {
editorType: 'vscode',
mtime: new Date('2025-03-15T10:00:00.000Z').getTime(),
sessionData: makeSession({
dailyRollups: {
'2025-03-15': { tokens: 100, actualTokens: 150, thinkingTokens: 0, interactions: 1, modelUsage: {} },
},
}),
};
const result = aggregatePeriodStats([input], ranges);
assert.equal(result.todayStats.tokens, 150, 'no cachedReadTokens → actualTokens only');
});

test('aggregatePeriodStats: rollup – estimated tokens fallback used when actualTokens=0, cached excluded', () => {
const ranges = makeRanges('2025-03-15');
const input: SessionAggregateInput = {
editorType: 'vscode',
mtime: new Date('2025-03-15T10:00:00.000Z').getTime(),
sessionData: makeSession({
dailyRollups: {
'2025-03-15': { tokens: 100, actualTokens: 0, thinkingTokens: 0, cachedReadTokens: 50, interactions: 1, modelUsage: {} },
},
}),
};
const result = aggregatePeriodStats([input], ranges);
assert.equal(result.todayStats.tokens, 100, 'estimatedTokens(100) only; cachedReadTokens(50) excluded from total');
});

test('aggregatePeriodStats: fallback – tokens total is input+output only, cacheReadTokens excluded', () => {
const ranges = makeRanges('2025-03-15');
const input: SessionAggregateInput = {
editorType: 'vscode',
mtime: new Date('2025-03-15T10:00:00.000Z').getTime(),
lastInteraction: '2025-03-15T10:00:00.000Z',
sessionData: makeSession({ tokens: 100, actualTokens: 200, cacheReadTokens: 400, interactions: 1 }),
};
const result = aggregatePeriodStats([input], ranges);
assert.equal(result.todayStats.tokens, 200, 'tokens = actualTokens(200) only; cacheReadTokens(400) excluded');
assert.equal(result.todayStats.cachedTokens, 400, 'cachedTokens accumulates separately');
});

test('aggregatePeriodStats: fallback – no cacheReadTokens leaves total unchanged', () => {
const ranges = makeRanges('2025-03-15');
const input: SessionAggregateInput = {
editorType: 'vscode',
mtime: new Date('2025-03-15T10:00:00.000Z').getTime(),
lastInteraction: '2025-03-15T10:00:00.000Z',
sessionData: makeSession({ tokens: 100, actualTokens: 180, interactions: 1 }),
};
const result = aggregatePeriodStats([input], ranges);
assert.equal(result.todayStats.tokens, 180, 'no cacheReadTokens → actualTokens only');
});

// ── modelUsageNoExact – Copilot cost-estimate fallback attribution ───────────

test('modelUsageNoExact: Copilot-surface session without exact billing is included', () => {
const ranges = makeRanges('2025-03-15');
const usage: ModelUsage = { 'gpt-4.1': { inputTokens: 100, outputTokens: 50, sessions: 0} };
const input: SessionAggregateInput = {
editorType: 'VS Code',
mtime: new Date('2025-03-15T10:00:00.000Z').getTime(),
lastInteraction: '2025-03-15T10:00:00.000Z',
sessionData: makeSession({ modelUsage: usage, interactions: 1 }),
};
const result = aggregatePeriodStats([input], ranges);
assert.deepEqual(result.monthStats.modelUsageNoExact['gpt-4.1'], { inputTokens: 100, outputTokens: 50, sessions: 0});
assert.equal(result.monthStats.exactCopilotCostDollars, 0);
});

test('modelUsageNoExact: custom-endpoint models on a Copilot surface stay out of the Copilot estimate', () => {
// BYOK/custom endpoints are called with the user's own key, so they are billed by that
// provider and reported under their own provider group instead of GitHub Copilot.
const ranges = makeRanges('2025-03-15');
const usage: ModelUsage = {
'gpt-4.1': { inputTokens: 100, outputTokens: 50, sessions: 0},
'customendpoint/Mistral/mistral-medium-latest': { inputTokens: 1_000_000, outputTokens: 500_000, sessions: 0}
};
const input: SessionAggregateInput = {
editorType: 'VS Code',
mtime: new Date('2025-03-15T10:00:00.000Z').getTime(),
lastInteraction: '2025-03-15T10:00:00.000Z',
sessionData: makeSession({ modelUsage: usage, interactions: 1 }),
};
const result = aggregatePeriodStats([input], ranges);
assert.deepEqual(result.monthStats.modelUsageNoExact, { 'gpt-4.1': { inputTokens: 100, outputTokens: 50, sessions: 0} });
assert.equal(
result.monthStats.editorModelUsage['VS Code']['customendpoint/Mistral/mistral-medium-latest'].inputTokens,
1_000_000,
'still attributed to its own provider group via editorModelUsage'
);
});

test('modelUsageNoExact: non-Copilot session does not leak into the Copilot cost estimate (regression)', () => {
// Claude Code sessions bill Anthropic directly. Before the fix they landed in
// modelUsageNoExact and were priced at Copilot AI-Credit rates, inflating the
// "GitHub Copilot" monthly spend far beyond actual Copilot usage.
const ranges = makeRanges('2025-03-15');
const usage: ModelUsage = { 'claude-fable-5': { inputTokens: 1_000_000, outputTokens: 500_000, sessions: 0} };
const input: SessionAggregateInput = {
editorType: 'Claude Code',
mtime: new Date('2025-03-15T10:00:00.000Z').getTime(),
lastInteraction: '2025-03-15T10:00:00.000Z',
sessionData: makeSession({ modelUsage: usage, interactions: 1 }),
};
const result = aggregatePeriodStats([input], ranges);
assert.deepEqual(result.monthStats.modelUsageNoExact, {}, 'Claude Code usage must not feed the Copilot estimate');
assert.deepEqual(result.todayStats.modelUsageNoExact, {});
assert.deepEqual(result.last30DaysStats.modelUsageNoExact, {});
assert.deepEqual(result.monthStats.modelUsage['claude-fable-5'], { inputTokens: 1_000_000, outputTokens: 500_000, sessions: 0}, 'still counted in overall model usage');
assert.equal(result.monthStats.editorModelUsage['Claude Code']['claude-fable-5'].inputTokens, 1_000_000, 'still attributed to its billing group via editorModelUsage');
});

test('modelUsageNoExact: Copilot-surface session with exact nanoAiu billing uses the exact cost instead', () => {
const ranges = makeRanges('2025-03-15');
const usage: ModelUsage = { 'gpt-4.1': { inputTokens: 100, outputTokens: 50, sessions: 0} };
const input: SessionAggregateInput = {
editorType: 'VS Code',
mtime: new Date('2025-03-15T10:00:00.000Z').getTime(),
lastInteraction: '2025-03-15T10:00:00.000Z',
sessionData: makeSession({ modelUsage: usage, interactions: 1, copilotExactCostDollars: 1.25 }),
};
const result = aggregatePeriodStats([input], ranges);
assert.equal(result.monthStats.exactCopilotCostDollars, 1.25);
assert.deepEqual(result.monthStats.modelUsageNoExact, {}, 'exact-billed sessions are excluded from the estimate fallback');
});

test('modelUsageNoExact: rollup path – non-Copilot rollup days are excluded, Copilot days included', () => {
const ranges = makeRanges('2025-03-15');
const usage: ModelUsage = { 'gemini-2.5-pro': { inputTokens: 300, outputTokens: 100, sessions: 0} };
const input: SessionAggregateInput = {
editorType: 'Gemini CLI',
mtime: new Date('2025-03-15T10:00:00.000Z').getTime(),
sessionData: makeSession({
dailyRollups: {
'2025-03-15': { tokens: 400, actualTokens: 0, thinkingTokens: 0, interactions: 1, modelUsage: usage },
},
}),
};
const result = aggregatePeriodStats([input], ranges);
assert.deepEqual(result.monthStats.modelUsageNoExact, {}, 'Gemini CLI rollup must not feed the Copilot estimate');
assert.deepEqual(result.monthStats.modelUsage['gemini-2.5-pro'], { inputTokens: 300, outputTokens: 100, sessions: 0});
});

// ── per-model / per-provider session counts ───────────────────────────────────

test('aggregatePeriodStats: fallback path increments per-model and per-editor-model session counts', () => {
const ranges = makeRanges('2025-03-15');
const usage: ModelUsage = {
'gpt-4o': { inputTokens: 400, outputTokens: 100, sessions: 0},
'claude-3-5-sonnet': { inputTokens: 200, outputTokens: 100, sessions: 0},
};
const input: SessionAggregateInput = {
editorType: 'VS Code',
mtime: new Date('2025-03-15T10:00:00.000Z').getTime(),
lastInteraction: '2025-03-15T10:00:00.000Z',
sessionData: makeSession({ modelUsage: usage, interactions: 3 }),
};
const result = aggregatePeriodStats([input], ranges);
const day = result.dailyStatsMap.get('2025-03-15')!;
assert.equal(day.modelUsage['gpt-4o']?.sessions, 1);
assert.equal(day.modelUsage['claude-3-5-sonnet']?.sessions, 1);
assert.equal(day.editorModelUsage!['VS Code']['gpt-4o']?.sessions, 1);
assert.equal(day.editorModelUsage!['VS Code']['claude-3-5-sonnet']?.sessions, 1);
assert.equal(day.editorUsage['VS Code']?.sessions, 1);
});

test('aggregatePeriodStats: rollup path increments per-model and per-editor-model session counts', () => {
const ranges = makeRanges('2025-03-15');
const usage: ModelUsage = { 'gpt-4o': { inputTokens: 300, outputTokens: 100, sessions: 0} };
const input: SessionAggregateInput = {
editorType: 'VS Code',
mtime: new Date('2025-03-15T10:00:00.000Z').getTime(),
sessionData: makeSession({
dailyRollups: {
'2025-03-15': { tokens: 400, actualTokens: 0, thinkingTokens: 0, interactions: 2, modelUsage: usage },
},
}),
};
const result = aggregatePeriodStats([input], ranges);
const day = result.dailyStatsMap.get('2025-03-15')!;
assert.equal(day.modelUsage['gpt-4o']?.sessions, 1);
assert.equal(day.editorModelUsage!['VS Code']['gpt-4o']?.sessions, 1);
assert.equal(day.editorUsage['VS Code']?.sessions, 1);
});

// ── distributeModelUsageToDays ───────────────────────────────────────────────

test('distributeModelUsageToDays: distributes usage by interaction weight and re-syncs day actualTokens', () => {
	const rollups = {
		'2025-03-14': { tokens: 500, actualTokens: 0, thinkingTokens: 0, interactions: 3, modelUsage: {} },
		'2025-03-15': { tokens: 500, actualTokens: 0, thinkingTokens: 0, interactions: 1, modelUsage: {} },
	};
	const sessionUsage: ModelUsage = { 'gpt-4o': { inputTokens: 8000, outputTokens: 2000, cachedReadTokens: 4000, sessions: 0 } };
	const result = distributeModelUsageToDays(rollups, sessionUsage)!;
	assert.ok(result, 'returns distributed rollups');
	assert.equal(result['2025-03-14'].modelUsage['gpt-4o'].inputTokens, 6000, '3/4 of input');
	assert.equal(result['2025-03-15'].modelUsage['gpt-4o'].inputTokens, 2000, '1/4 of input');
	assert.equal(result['2025-03-14'].modelUsage['gpt-4o'].cachedReadTokens, 3000, 'cache reads distributed too');
	// The invariant this helper exists for: each day's actualTokens equals that
	// day's distributed input+output, so period Total >= period Input.
	assert.equal(result['2025-03-14'].actualTokens, 7500);
	assert.equal(result['2025-03-15'].actualTokens, 2500);
});

test('distributeModelUsageToDays: returns undefined when rollups have no interactions', () => {
	const rollups = {
		'2025-03-15': { tokens: 100, actualTokens: 0, thinkingTokens: 0, interactions: 0, modelUsage: {} },
	};
	assert.equal(distributeModelUsageToDays(rollups, { 'gpt-4o': { inputTokens: 10, outputTokens: 5, sessions: 0 } }), undefined);
});

test('sumModelUsageTokens: sums input+output across models, ignoring cache fields', () => {
	assert.equal(sumModelUsageTokens({
		'a': { inputTokens: 100, outputTokens: 20, cachedReadTokens: 90, sessions: 0 },
		'b': { inputTokens: 50, outputTokens: 5, sessions: 0 },
	}), 175);
});

// ── Regression: Input tokens must never exceed Total tokens per period ───────
// Shaped on real data from a machine where the details view showed
// "Input tokens" > "Total tokens" on every period: a VS Code Chat session
// whose file-based estimate was ~1.04M tokens but whose Copilot Chat debug
// log recorded ~18.5M exact API tokens. The debug-log path replaced the
// per-day modelUsage with the (much larger) debug totals but left the day
// rollup's tokens/actualTokens at the old estimate, so aggregated Input
// (from modelUsage) exceeded aggregated Total (from rollup tokens).
test('aggregatePeriodStats: debug-log-sized modelUsage cannot exceed period total after distributeModelUsageToDays (regression)', () => {
	const ranges = makeRanges('2025-03-15');
	// Day rollups as originally built from the session-file estimate.
	const rollups = {
		'2025-03-14': { tokens: 542265, actualTokens: 0, thinkingTokens: 0, interactions: 2, modelUsage: {} },
		'2025-03-15': { tokens: 500000, actualTokens: 0, thinkingTokens: 0, interactions: 2, modelUsage: {} },
	};
	// Debug-log exact totals (real session 354a5617: in=18,387,960 out=135,055).
	const debugUsage: ModelUsage = { 'gpt-4.1': { inputTokens: 18387960, outputTokens: 135055, cachedReadTokens: 17691909, sessions: 0 } };
	const distributed = distributeModelUsageToDays(rollups, debugUsage)!;
	const input: SessionAggregateInput = {
		editorType: 'VS Code',
		mtime: new Date('2025-03-15T10:00:00.000Z').getTime(),
		sessionData: makeSession({ dailyRollups: distributed }),
	};
	const result = aggregatePeriodStats([input], ranges);
	for (const [name, period] of [['last30Days', result.last30DaysStats], ['month', result.monthStats]] as const) {
		const inputTokens = Object.values(period.modelUsage).reduce((s, u) => s + u.inputTokens, 0);
		const outputTokens = Object.values(period.modelUsage).reduce((s, u) => s + u.outputTokens, 0);
		assert.ok(inputTokens + outputTokens <= period.tokens + period.thinkingTokens,
			`${name}: Input+Output (${inputTokens + outputTokens}) must not exceed Total (${period.tokens + period.thinkingTokens})`);
		assert.ok(inputTokens > 18000000, `${name}: input reflects debug-log totals`);
	}
});

// Documents the pre-fix behaviour: distributing debug-log modelUsage WITHOUT
// re-syncing day actualTokens reproduces the "Input > Total" bug in aggregation.
test('aggregatePeriodStats: stale rollup tokens with debug-log modelUsage reproduces Input > Total (bug shape)', () => {
	const ranges = makeRanges('2025-03-15');
	const buggyRollups = {
		'2025-03-15': {
			tokens: 1042265, actualTokens: 0, thinkingTokens: 0, interactions: 4,
			// Debug-log-sized usage pasted onto a day whose token counts were never updated.
			modelUsage: { 'gpt-4.1': { inputTokens: 18387960, outputTokens: 135055, sessions: 0 } },
		},
	};
	const input: SessionAggregateInput = {
		editorType: 'VS Code',
		mtime: new Date('2025-03-15T10:00:00.000Z').getTime(),
		sessionData: makeSession({ dailyRollups: buggyRollups }),
	};
	const result = aggregatePeriodStats([input], ranges);
	const inputTokens = Object.values(result.last30DaysStats.modelUsage).reduce((s, u) => s + u.inputTokens, 0);
	assert.ok(inputTokens > result.last30DaysStats.tokens,
		'unsynced rollups make Input exceed Total — this is why distributeModelUsageToDays must re-sync actualTokens');
});

// ── computeFallbackDailyRollup ───────────────────────────────────────────────
// Guards against a regression where a multi-day session (no per-request
// timestamps, e.g. an adapter with no getDailyFractions() such as Claude
// Desktop) had its entire token/interaction count bucketed under
// firstInteraction's day. An ongoing session (started days ago, still active
// today) then showed 0 for "Today" everywhere, even with real activity today.

test('computeFallbackDailyRollup: buckets under the last-activity day, not the first (regression)', () => {
	const dailyRollups: Record<string, DailyRollupEntry> = {};
	const modelUsage: ModelUsage = { 'gpt-4.1': { inputTokens: 1000, outputTokens: 500, sessions: 1 } };
	const firstInteraction = '2025-03-10T09:00:00.000Z';
	const lastInteraction = '2025-03-15T09:00:00.000Z'; // "today" in this scenario

	void firstInteraction; // not used directly — documents the bug scenario's start date
	computeFallbackDailyRollup(
		dailyRollups,
		lastInteraction,
		{ tokens: 5000, actualTokens: 4500, thinkingTokens: 0 },
		modelUsage,
		3,
	);

	assert.ok(dailyRollups['2025-03-15'], 'session activity must be attributed to the last-activity day ("today")');
	assert.ok(!dailyRollups['2025-03-10'], 'session activity must NOT be attributed to the first-interaction day');
	assert.equal(dailyRollups['2025-03-15'].tokens, 5000);
	assert.equal(dailyRollups['2025-03-15'].interactions, 3);
});

test('computeFallbackDailyRollup: falls back to firstInteraction when no lastInteraction is available', () => {
	const dailyRollups: Record<string, DailyRollupEntry> = {};
	const firstInteraction = '2025-03-10T09:00:00.000Z';
	const lastInteraction: string | null = null;
	computeFallbackDailyRollup(
		dailyRollups,
		lastInteraction ?? firstInteraction,
		{ tokens: 100, actualTokens: 100, thinkingTokens: 0 },
		{},
		1,
	);
	assert.ok(dailyRollups['2025-03-10'], 'must still fall back to firstInteraction when lastInteraction is unavailable');
});

test('computeFallbackDailyRollup: no-ops when tokens or timestamp are missing', () => {
	const dailyRollups: Record<string, DailyRollupEntry> = {};
	computeFallbackDailyRollup(dailyRollups, null, { tokens: 100 }, {}, 1);
	assert.equal(Object.keys(dailyRollups).length, 0, 'no timestamp means no rollup entry');

	computeFallbackDailyRollup(dailyRollups, '2025-03-10T09:00:00.000Z', { tokens: 0 }, {}, 1);
	assert.equal(Object.keys(dailyRollups).length, 0, 'zero tokens means no rollup entry');
});

// ── preferActualTokens ───────────────────────────────────────────────────────

test('preferActualTokens: uses the exact API-reported count when there is one', () => {
	assert.equal(preferActualTokens(5000, 4200), 5000);
});

test('preferActualTokens: falls back to the estimate when no exact count exists', () => {
	// The regression this guards: `actualTokens` is 0, not undefined, for a
	// session with no exact data — a `??` fallback would return 0 and silently
	// drop the estimate.
	assert.equal(preferActualTokens(0, 4200), 4200);
	assert.equal(preferActualTokens(undefined, 4200), 4200);
});

test('preferActualTokens: a zero estimate stays zero rather than becoming undefined', () => {
	assert.equal(preferActualTokens(0, 0), 0);
	assert.equal(preferActualTokens(undefined, 0), 0);
});

// ── Per-editor interactions (issue #1965) ────────────────────────────────────

test('aggregatePeriodStats: per-editor interactions track the day total', () => {
	// The Efficiency view's editor filter divides by this. The refresh path used
	// to bump `entry.interactions` but not the editor slice, so filtered "turns
	// per session" silently read as zero for the newest days after a background
	// refresh replaced them.
	const ranges = makeRanges('2025-03-15');
	const input: SessionAggregateInput = {
		editorType: 'vscode',
		mtime: new Date('2025-03-15T10:00:00.000Z').getTime(),
		sessionData: makeSession({
			dailyRollups: {
				'2025-03-15': { tokens: 100, actualTokens: 120, thinkingTokens: 0, interactions: 7, modelUsage: {} },
			},
		}),
	};
	const result = aggregatePeriodStats([input], ranges);
	const day = result.dailyStatsMap.get('2025-03-15');
	assert.ok(day, 'expected a daily entry for the rollup day');
	assert.equal(day.interactions, 7);
	assert.equal(day.editorUsage['vscode'].interactions, 7, 'per-editor turns must match the day total for a single-editor day');
});

test('aggregatePeriodStats: two editors on one day split the turns without losing any', () => {
	const ranges = makeRanges('2025-03-15');
	const make = (editorType: string, interactions: number): SessionAggregateInput => ({
		editorType,
		mtime: new Date('2025-03-15T10:00:00.000Z').getTime(),
		sessionData: makeSession({
			dailyRollups: {
				'2025-03-15': { tokens: 100, actualTokens: 100, thinkingTokens: 0, interactions, modelUsage: {} },
			},
		}),
	});
	const result = aggregatePeriodStats([make('vscode', 4), make('Claude Code', 6)], ranges);
	const day = result.dailyStatsMap.get('2025-03-15');
	assert.ok(day);
	const summed = Object.values(day.editorUsage).reduce((sum: number, e) => sum + (e.interactions ?? 0), 0);
	assert.equal(summed, day.interactions, 'editor slices must sum back to the day total');
	assert.equal(day.editorUsage['vscode'].interactions, 4);
	assert.equal(day.editorUsage['Claude Code'].interactions, 6);
});



// ── distributeExactCostToDays – debug-log exact cost reaches period totals ──

test('distributeExactCostToDays: splits by interactions, sums to session cost, replaces rollup cost (no double count)', () => {
	const rollups: Record<string, DailyRollupEntry> = {
		'2025-03-14': { tokens: 10, actualTokens: 10, thinkingTokens: 0, interactions: 1, modelUsage: {}, copilotExactCostDollars: 99 },
		'2025-03-15': { tokens: 30, actualTokens: 30, thinkingTokens: 0, interactions: 3, modelUsage: {} },
	};
	const out = distributeExactCostToDays(rollups, 0.8)!;
	assert.ok(Math.abs(out['2025-03-14'].copilotExactCostDollars! - 0.2) < 1e-12);
	assert.ok(Math.abs(out['2025-03-15'].copilotExactCostDollars! - 0.6) < 1e-12);
	const sum = Object.values(out).reduce((s, d) => s + (d.copilotExactCostDollars ?? 0), 0);
	assert.ok(Math.abs(sum - 0.8) < 1e-12);
	assert.equal(rollups['2025-03-14'].copilotExactCostDollars, 99, 'input is not mutated');
});

test('distributeExactCostToDays: no cost or no interactions leaves rollups unchanged (undefined)', () => {
	const rollups: Record<string, DailyRollupEntry> = {
		'2025-03-15': { tokens: 1, actualTokens: 1, thinkingTokens: 0, interactions: 2, modelUsage: {} },
	};
	assert.equal(distributeExactCostToDays(rollups, 0), undefined);
	assert.equal(distributeExactCostToDays(rollups, NaN), undefined);
	assert.equal(distributeExactCostToDays({ d: { ...rollups['2025-03-15'], interactions: 0 } }, 1), undefined);
});

test('aggregatePeriodStats: debug-log-only exact cost appears in period totals once distributed over rollups', () => {
	const ranges = makeRanges('2025-03-15');
	const rollups: Record<string, DailyRollupEntry> = {
		'2025-03-15': { tokens: 100, actualTokens: 120, thinkingTokens: 0, interactions: 2, modelUsage: {} },
	};
	const build = (dailyRollups: Record<string, DailyRollupEntry>): SessionAggregateInput => ({
		editorType: 'vscode',
		mtime: new Date('2025-03-15T10:00:00.000Z').getTime(),
		// Session-level exact cost (as buildSessionDataObject writes it) — rollups alone decide period totals.
		sessionData: makeSession({ dailyRollups, copilotExactCostDollars: 0.5 }),
	});
	// Baseline (the bug): rollups built before the debug log was read carry no exact cost.
	assert.equal(aggregatePeriodStats([build(rollups)], ranges).todayStats.exactCopilotCostDollars, 0);
	const fixed = aggregatePeriodStats([build(distributeExactCostToDays(rollups, 0.5)!)], ranges);
	assert.ok(Math.abs(fixed.todayStats.exactCopilotCostDollars - 0.5) < 1e-12);
	assert.ok(Math.abs(fixed.monthStats.exactCopilotCostDollars - 0.5) < 1e-12);
	assert.ok(Math.abs(fixed.last30DaysStats.exactCopilotCostDollars - 0.5) < 1e-12);
});
