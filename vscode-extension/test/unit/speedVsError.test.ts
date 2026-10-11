import test from 'node:test';
import * as assert from 'node:assert/strict';
import { compareSpeedAndQuality, reworkWorsened, MIN_CURRENT_DAYS, MIN_TURN_DETAIL_SESSIONS } from '../../../src/speedVsError';
import type { ActivityTrendWindows } from '../../../src/types';
import { totals } from './agenticFixtures';

function trend(
	current: { agentic: number; corrections: number; oneShot?: number },
	previous: { agentic: number; corrections: number; oneShot?: number },
	days: { current?: number; previous?: number } = {},
): ActivityTrendWindows {
	const window = (w: { agentic: number; corrections: number; oneShot?: number }) => totals({
		sessions: 40, sessionsWithTurnDetail: 20, agenticSessions: w.agentic,
		correctionMoments: w.corrections, editTurns: 100, oneShotEditTurns: w.oneShot ?? 80,
	});
	return { current: window(current), currentDays: days.current ?? 15, previous: window(previous), previousDays: days.previous ?? 30 };
}

test('compareSpeedAndQuality: growth with flat rework is faster-and-steadier', () => {
	// 15 per 15 days = 1/day vs 15 per 30 days = 0.5/day
	const result = compareSpeedAndQuality(trend({ agentic: 15, corrections: 10 }, { agentic: 15, corrections: 10 }));
	assert.equal(result.classification, 'faster-and-steadier');
	assert.equal(result.agenticPerDay.current, 1);
	assert.equal(result.agenticPerDay.previous, 0.5);
});

test('compareSpeedAndQuality: growth with rising corrections is faster-but-weaker', () => {
	assert.equal(compareSpeedAndQuality(trend({ agentic: 15, corrections: 20 }, { agentic: 15, corrections: 10 })).classification, 'faster-but-weaker');
});

test('compareSpeedAndQuality: growth with a falling one-shot rate is faster-but-weaker', () => {
	assert.equal(compareSpeedAndQuality(trend({ agentic: 15, corrections: 10, oneShot: 70 }, { agentic: 15, corrections: 10, oneShot: 80 })).classification, 'faster-but-weaker');
});

test('compareSpeedAndQuality: per-day normalisation — the same daily rate over a shorter window is not growth', () => {
	const flat = compareSpeedAndQuality(trend({ agentic: 15, corrections: 10 }, { agentic: 30, corrections: 10 }));
	assert.equal(flat.classification, 'steady');
});

test('compareSpeedAndQuality: rising rework without growth is rework-rising', () => {
	assert.equal(compareSpeedAndQuality(trend({ agentic: 5, corrections: 20 }, { agentic: 10, corrections: 10 })).classification, 'rework-rising');
});

test('compareSpeedAndQuality: too early in the month, too few sessions, or no trend', () => {
	assert.deepEqual(
		{ ...compareSpeedAndQuality(trend({ agentic: 15, corrections: 10 }, { agentic: 15, corrections: 10 }, { current: MIN_CURRENT_DAYS - 1 })) }.reason,
		'too-early-in-month',
	);
	const thin = trend({ agentic: 15, corrections: 10 }, { agentic: 15, corrections: 10 });
	thin.previous.sessionsWithTurnDetail = MIN_TURN_DETAIL_SESSIONS - 1;
	assert.equal(compareSpeedAndQuality(thin).reason, 'too-few-sessions');
	assert.equal(compareSpeedAndQuality(undefined).classification, 'insufficient-data');
});

test('reworkWorsened: small absolute changes and missing data do not count', () => {
	assert.equal(reworkWorsened({ current: 0.12, previous: 0.05 }, { current: null, previous: null }), false, 'rise below the absolute floor');
	assert.equal(reworkWorsened({ current: 0.2, previous: 0 }, { current: null, previous: null }), true, 'from zero, only the absolute floor applies');
	assert.equal(reworkWorsened({ current: null, previous: 1 }, { current: 0.8, previous: 0.8 }), false);
	assert.equal(reworkWorsened({ current: 1, previous: 1 }, { current: 0.76, previous: 0.8 }), false, 'a four-point drop is below the threshold');
});
