/**
 * Speed paired with error: is agent adoption growing without rework growing
 * with it?
 *
 * GitHub's Agentic Engineering System warns against "measuring speed without
 * measuring error and rework": as agent use expands, error rates should stay
 * flat or fall. This module compares this month to date with the whole of last
 * month (src/repoAgentActivity.ts `buildActivityTrend`), normalising adoption
 * per day because the two windows differ in length, and reading rework as
 * rates so the length difference does not matter there.
 *
 * It never changes the Fluency Score stage — that is a documented contract.
 * It only sits next to it. Pure — no VS Code API.
 */
import type { ActivityTrendWindows, AgentActivityTotals } from './types';

/** The current window needs this many days… Tunable. */
export const MIN_CURRENT_DAYS = 7;
/** …and each window this many sessions with turn detail. Tunable. */
export const MIN_TURN_DETAIL_SESSIONS = 10;
/** Agentic sessions per day must rise by this fraction to count as growth. Tunable. */
export const ADOPTION_GROWTH = 0.15;
/** …with at least this many agentic sessions in the current window. Tunable. */
export const MIN_CURRENT_AGENTIC_SESSIONS = 5;
/** Corrections per session must rise by this fraction… Tunable. */
export const REWORK_RISE = 0.2;
/** …and by at least this much in absolute terms, to count as worse. Tunable. */
export const MIN_REWORK_RISE_ABSOLUTE = 0.1;
/** A one-shot edit rate drop of this many percentage points also counts as worse. Tunable. */
export const ONE_SHOT_DROP_POINTS = 5;

export type SpeedQualityClass =
	/** More agent use, rework flat or better. */
	| 'faster-and-steadier'
	/** More agent use and more rework — speed bought with errors. */
	| 'faster-but-weaker'
	/** Agent use flat, rework rising. */
	| 'rework-rising'
	/** Nothing moved enough to call. */
	| 'steady'
	| 'insufficient-data';

export interface PeriodPair {
	current: number | null;
	previous: number | null;
}

export interface SpeedQualityComparison {
	classification: SpeedQualityClass;
	/** Agentic sessions per day. */
	agenticPerDay: PeriodPair;
	correctionsPerSession: PeriodPair;
	/** In [0, 1]. */
	oneShotRate: PeriodPair;
	/** Why the data is insufficient, when it is. */
	reason?: 'too-early-in-month' | 'too-few-sessions';
}

function perSession(t: AgentActivityTotals): number | null {
	return t.sessionsWithTurnDetail > 0 ? t.correctionMoments / t.sessionsWithTurnDetail : null;
}

function oneShot(t: AgentActivityTotals): number | null {
	return t.editTurns > 0 ? t.oneShotEditTurns / t.editTurns : null;
}

/** True when rework got measurably worse between the two windows. */
export function reworkWorsened(corrections: PeriodPair, oneShotRate: PeriodPair): boolean {
	const c = corrections.current;
	const cp = corrections.previous;
	const correctionsUp = c !== null && cp !== null
		&& c - cp >= MIN_REWORK_RISE_ABSOLUTE
		&& (cp === 0 || (c - cp) / cp >= REWORK_RISE);
	const o = oneShotRate.current;
	const op = oneShotRate.previous;
	const oneShotDown = o !== null && op !== null && (op - o) * 100 >= ONE_SHOT_DROP_POINTS;
	return correctionsUp || oneShotDown;
}

/** Compare this month to date against last month. */
export function compareSpeedAndQuality(trend: ActivityTrendWindows | null | undefined): SpeedQualityComparison {
	const empty: PeriodPair = { current: null, previous: null };
	if (!trend) {
		return { classification: 'insufficient-data', agenticPerDay: empty, correctionsPerSession: empty, oneShotRate: empty, reason: 'too-few-sessions' };
	}
	const { current, previous } = trend;
	const agenticPerDay: PeriodPair = {
		current: trend.currentDays > 0 ? current.agenticSessions / trend.currentDays : null,
		previous: trend.previousDays > 0 ? previous.agenticSessions / trend.previousDays : null,
	};
	const correctionsPerSession: PeriodPair = { current: perSession(current), previous: perSession(previous) };
	const oneShotRate: PeriodPair = { current: oneShot(current), previous: oneShot(previous) };
	const base = { agenticPerDay, correctionsPerSession, oneShotRate };

	if (trend.currentDays < MIN_CURRENT_DAYS) {
		return { ...base, classification: 'insufficient-data', reason: 'too-early-in-month' };
	}
	if (current.sessionsWithTurnDetail < MIN_TURN_DETAIL_SESSIONS || previous.sessionsWithTurnDetail < MIN_TURN_DETAIL_SESSIONS) {
		return { ...base, classification: 'insufficient-data', reason: 'too-few-sessions' };
	}
	const growing = current.agenticSessions >= MIN_CURRENT_AGENTIC_SESSIONS
		&& agenticPerDay.current !== null && agenticPerDay.previous !== null
		&& agenticPerDay.current >= agenticPerDay.previous * (1 + ADOPTION_GROWTH)
		&& agenticPerDay.current > agenticPerDay.previous;
	const worse = reworkWorsened(correctionsPerSession, oneShotRate);
	const classification: SpeedQualityClass = growing
		? (worse ? 'faster-but-weaker' : 'faster-and-steadier')
		: (worse ? 'rework-rising' : 'steady');
	return { ...base, classification };
}
