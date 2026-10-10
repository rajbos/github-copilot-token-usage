/**
 * Per-session context-window fill helpers.
 *
 * The aggregate counters in `ContextPressureStats` answer "how many sessions
 * nearly ran out of context window"; these helpers answer "which ones", so the
 * Recent Sessions table can show and filter the very sessions the
 * `context-window-near-limit` insight counts.
 *
 * Keep the near-limit rule here in one place: the aggregate counter
 * (`mergeDbContextPressure` in the extension) and the session-level filter must
 * agree, or the insight's "N sessions" and the filtered list would disagree.
 */
import { CONTEXT_NEAR_LIMIT_RATIO } from '../types';

/** The subset of a session summary these helpers need. */
export interface SessionContextFill {
	/** Selected input-token window limit (Copilot CLI, from data.db). */
	contextWindowLimit?: number;
	/** Last known context fill in tokens (Copilot CLI, from data.db). */
	contextReachedTokens?: number;
	/** Automatic compaction/truncation events recorded for the session. */
	truncationCount?: number;
}

/**
 * How full a session's context window got, as a 0-100 percentage, or undefined
 * when the session carries no measured fill (only Copilot CLI's `data.db`
 * records the fill/limit pair). Clamped at 100.
 *
 * Rounded *down*, not to nearest, so the number shown can never contradict the
 * near-limit badge beside it: at 159,999 of 200,000 the raw ratio is 79.9995%,
 * which rounding to nearest would display as "80%" on a row the 80% rule
 * deliberately leaves unflagged and the filter excludes.
 */
export function getSessionContextFillPercent(session: SessionContextFill): number | undefined {
	const limit = session.contextWindowLimit;
	const reached = session.contextReachedTokens;
	if (!limit || !reached || reached <= 0) { return undefined; }
	return Math.min(100, Math.floor((reached / limit) * 100));
}

/**
 * True when a session filled at least `CONTEXT_NEAR_LIMIT_RATIO` of its window
 * *without* compacting — the same rule `mergeDbContextPressure` counts into
 * `sessionsNearLimit`.
 *
 * Compacted sessions are excluded because compaction resets the fill they would
 * be judged on; they are represented by `sessionsCompacted` instead.
 * `truncationCount` is the compaction signal for the only session format that
 * reports a fill (Copilot CLI), so it stands in for the broader
 * `sessionCompactionEvents` here.
 */
export function isSessionNearContextLimit(session: SessionContextFill): boolean {
	if (session.truncationCount) { return false; }
	const limit = session.contextWindowLimit;
	const reached = session.contextReachedTokens;
	if (!limit || !reached || reached <= 0) { return false; }
	return reached >= limit * CONTEXT_NEAR_LIMIT_RATIO;
}

/** Count of sessions in `sessions` that are near their context limit. */
export function countSessionsNearContextLimit(sessions: readonly SessionContextFill[]): number {
	return sessions.reduce((n, s) => n + (isSessionNearContextLimit(s) ? 1 : 0), 0);
}
