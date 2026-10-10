import test from 'node:test';
import * as assert from 'node:assert/strict';
import { CONTEXT_NEAR_LIMIT_RATIO } from '../../../src/types';
import {
	countSessionsNearContextLimit,
	getSessionContextFillPercent,
	isSessionNearContextLimit,
	type SessionContextFill,
} from '../../../src/utils/contextFill';
import { mergeDbContextPressure } from '../../src/contextPressure';
import type { UsageAnalysisPeriod } from '../../../src/types';
import type { SessionContextWindow } from '../../src/copilotAppData';

function session(overrides: Partial<SessionContextFill> = {}): SessionContextFill {
	return { ...overrides };
}

// ---------------------------------------------------------------------------
// Fill percentage
// ---------------------------------------------------------------------------

test('getSessionContextFillPercent: returns the fill percentage', () => {
	assert.equal(getSessionContextFillPercent(session({ contextWindowLimit: 200_000, contextReachedTokens: 150_000 })), 75);
	assert.equal(getSessionContextFillPercent(session({ contextWindowLimit: 128_000, contextReachedTokens: 64_500 })), 50);
});

test('getSessionContextFillPercent: never displays a percentage the near-limit rule would not flag', () => {
	// 159,999 / 200,000 is 79.9995%. Rounding to nearest would show "80%" on a
	// row the 80% rule leaves unflagged and the filter excludes — the column
	// would contradict the badge beside it. Flooring keeps the two honest.
	const justUnder = session({ contextWindowLimit: 200_000, contextReachedTokens: 159_999 });
	assert.equal(getSessionContextFillPercent(justUnder), 79);
	assert.equal(isSessionNearContextLimit(justUnder), false);
	const atThreshold = session({ contextWindowLimit: 200_000, contextReachedTokens: 160_000 });
	assert.equal(getSessionContextFillPercent(atThreshold), 80);
	assert.equal(isSessionNearContextLimit(atThreshold), true);
});

test('getSessionContextFillPercent: clamps overshoot at 100%', () => {
	assert.equal(getSessionContextFillPercent(session({ contextWindowLimit: 100_000, contextReachedTokens: 130_000 })), 100);
});

test('getSessionContextFillPercent: undefined without a usable fill/limit pair', () => {
	assert.equal(getSessionContextFillPercent(session()), undefined);
	assert.equal(getSessionContextFillPercent(session({ contextWindowLimit: 200_000 })), undefined);
	assert.equal(getSessionContextFillPercent(session({ contextReachedTokens: 150_000 })), undefined);
	assert.equal(getSessionContextFillPercent(session({ contextWindowLimit: 200_000, contextReachedTokens: 0 })), undefined);
});

// ---------------------------------------------------------------------------
// Near-limit rule
// ---------------------------------------------------------------------------

test('isSessionNearContextLimit: true exactly at the threshold, false just below', () => {
	const limit = 200_000;
	const atThreshold = limit * CONTEXT_NEAR_LIMIT_RATIO;
	assert.equal(isSessionNearContextLimit(session({ contextWindowLimit: limit, contextReachedTokens: atThreshold })), true);
	assert.equal(isSessionNearContextLimit(session({ contextWindowLimit: limit, contextReachedTokens: atThreshold - 1 })), false);
});

test('isSessionNearContextLimit: compacted sessions are excluded', () => {
	const near = { contextWindowLimit: 200_000, contextReachedTokens: 190_000 };
	assert.equal(isSessionNearContextLimit(session(near)), true);
	assert.equal(isSessionNearContextLimit(session({ ...near, truncationCount: 1 })), false);
});

test('isSessionNearContextLimit: false without measured fill data', () => {
	assert.equal(isSessionNearContextLimit(session()), false);
	assert.equal(isSessionNearContextLimit(session({ contextWindowLimit: 200_000 })), false);
	assert.equal(isSessionNearContextLimit(session({ contextReachedTokens: 190_000 })), false);
});

test('countSessionsNearContextLimit: counts only the near-limit sessions', () => {
	const sessions: SessionContextFill[] = [
		{ contextWindowLimit: 200_000, contextReachedTokens: 190_000 },              // near
		{ contextWindowLimit: 200_000, contextReachedTokens: 100_000 },              // comfortable
		{ contextWindowLimit: 200_000, contextReachedTokens: 195_000, truncationCount: 2 }, // compacted
		{},                                                                          // no fill data
		{ contextWindowLimit: 128_000, contextReachedTokens: 128_000 },              // near
	];
	assert.equal(countSessionsNearContextLimit(sessions), 2);
});

// ---------------------------------------------------------------------------
// Agreement with the aggregate counter
// ---------------------------------------------------------------------------

/**
 * The insight quotes `sessionsNearLimit`, while the Recent Sessions filter it
 * links to uses `isSessionNearContextLimit`. If the two rules drift, the
 * insight's "N sessions" and the filtered list stop matching.
 */
test('isSessionNearContextLimit agrees with the sessionsNearLimit aggregate', () => {
	const rows: { reached: number; limit: number; compacted: boolean }[] = [
		{ reached: 190_000, limit: 200_000, compacted: false },
		{ reached: 160_000, limit: 200_000, compacted: false },
		{ reached: 159_999, limit: 200_000, compacted: false },
		{ reached: 199_000, limit: 200_000, compacted: true },
		{ reached: 10_000, limit: 200_000, compacted: false },
	];
	const period = {} as UsageAnalysisPeriod;
	for (const row of rows) {
		const info: SessionContextWindow = {
			uuid: 'u', contextTier: null, contextReachedTokens: row.reached, contextWindowLimit: row.limit,
		};
		mergeDbContextPressure(period, info, false, row.compacted);
	}
	const fills = rows.map(r => ({
		contextWindowLimit: r.limit,
		contextReachedTokens: r.reached,
		...(r.compacted ? { truncationCount: 1 } : {}),
	}));
	assert.equal(countSessionsNearContextLimit(fills), period.contextPressure!.sessionsNearLimit);
	// The aggregate's "fullest session" figure comes from the same helper as the
	// per-session column, so the two can never report different percentages.
	const worst = Math.max(...fills.map(f => getSessionContextFillPercent(f) ?? 0));
	assert.equal(period.contextPressure!.worstFillPercent, worst);
});
