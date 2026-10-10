/**
 * Per-session context-exhaustion counters for a usage period.
 *
 * These counters carry two different denominators on purpose, and mixing them
 * up produces a plausible-looking but wrong number:
 *
 * - `sessionsConsidered` / `sessionsCompacted` cover every editor and session
 *   format, because a compaction or truncation signal is available everywhere.
 * - `sessionsNearLimit` / `sessionsWithFillData` are narrower: only Copilot
 *   CLI's `data.db` records the fill/limit pair a near-limit judgement needs,
 *   so they are counted against their own denominator rather than reusing
 *   `sessionsConsidered`.
 *
 * A session can be reported twice — once from its session-cache entry and once
 * from its `data.db` row — so the merge helpers take an `alreadyCounted` flag
 * to keep `sessionsConsidered` a true session count. Without it,
 * `sessionsNearLimit` could exceed `sessionsConsidered`.
 */
import { getSessionContextFillPercent, isSessionNearContextLimit } from '../../src/utils/contextFill';
import type { UsageAnalysisPeriod } from '../../src/types';
import type { SessionFileCache } from '../../src/types';
import type { SessionContextWindow } from './copilotAppData';
import type { TodaySessionSummary } from '../../src/types';

export type ContextPressure = NonNullable<UsageAnalysisPeriod['contextPressure']>;

/** Get-or-create the contextPressure aggregate on a usage period. */
export function ensureContextPressure(period: UsageAnalysisPeriod): ContextPressure {
	if (!period.contextPressure) {
		period.contextPressure = { sessionsConsidered: 0, sessionsCompacted: 0, sessionsNearLimit: 0, sessionsWithFillData: 0 };
	}
	return period.contextPressure;
}

/** Automatic compaction/truncation events recorded for one session, across all formats. */
export function sessionCompactionEvents(sessionData: SessionFileCache): number {
	return (sessionData.truncationCount ?? 0)
		+ (sessionData.usageAnalysis?.toolCalls.byTool['__auto_compact__'] ?? 0);
}

/**
 * True when a session carries any usable context-window or compaction signal.
 * `truncationCount` is only written when it is non-zero, so it cannot stand in
 * for "this session has context data" on its own.
 */
export function hasContextSignal(sessionData: SessionFileCache): boolean {
	return !!sessionData.maxRequestInputTokens
		|| !!sessionData.contextTier
		|| sessionCompactionEvents(sessionData) > 0;
}

/** Count one session from its cache entry towards a period's pressure counters. */
export function mergeSessionContextPressure(period: UsageAnalysisPeriod, sessionData: SessionFileCache): void {
	if (!hasContextSignal(sessionData)) { return; }
	const cp = ensureContextPressure(period);
	cp.sessionsConsidered++;
	if (sessionCompactionEvents(sessionData) > 0) { cp.sessionsCompacted++; }
}

/**
 * Fold one data.db context row into a period's pressure counters.
 *
 * `alreadyCounted` is true when `mergeSessionContextPressure` already counted
 * this session from its session-cache signals; `compacted` sessions are
 * excluded from `sessionsNearLimit` because compaction resets the fill they
 * would be judged on, and they are already represented by `sessionsCompacted`.
 */
export function mergeDbContextPressure(
	period: UsageAnalysisPeriod, info: SessionContextWindow, alreadyCounted: boolean, compacted: boolean,
): void {
	const limit = info.contextWindowLimit;
	const reached = info.contextReachedTokens;
	const hasFill = !!limit && !!reached && reached > 0;
	// A tier-only row is still a context-bearing session, so it belongs in the
	// denominator even though there is no fill to measure it against.
	if (!hasFill && !info.contextTier) { return; }
	const cp = ensureContextPressure(period);
	if (!alreadyCounted) { cp.sessionsConsidered++; }
	if (!hasFill) { return; }
	cp.sessionsWithFillData++;
	// Both the fill percentage and the near-limit rule come from the shared
	// helper the Recent Sessions column and its filter use, so this counter and
	// the list the insight links to can never answer differently. `compacted`
	// arrives as its own flag here rather than on the row, so it is mapped onto
	// the field the shared predicate reads.
	const fill = { contextWindowLimit: limit!, contextReachedTokens: reached!, truncationCount: compacted ? 1 : 0 };
	const fillPercent = getSessionContextFillPercent(fill)!;
	if (fillPercent > (cp.worstFillPercent ?? 0)) { cp.worstFillPercent = fillPercent; }
	if (isSessionNearContextLimit(fill)) { cp.sessionsNearLimit++; }
}

/**
 * Index session summaries by Copilot CLI session uuid.
 *
 * One uuid can map to several summary objects: the "Today" list is built
 * separately from the Recent Sessions lookback buckets, so the same session
 * arrives as two objects that both need stamping. `extractUuid` is injected so
 * this stays free of the extension host's path handling.
 */
export function indexSessionsByCliUuid(
	sessionLists: TodaySessionSummary[][],
	extractUuid: (filePath: string) => string | null,
): Map<string, TodaySessionSummary[]> {
	const byUuid = new Map<string, TodaySessionSummary[]>();
	for (const list of sessionLists) {
		for (const session of list) {
			const uuid = extractUuid(session.filePath);
			if (!uuid) { continue; }
			const existing = byUuid.get(uuid);
			if (!existing) { byUuid.set(uuid, [session]); }
			else if (!existing.includes(session)) { existing.push(session); }
		}
	}
	return byUuid;
}

/**
 * Stamp one data.db context row onto a session summary: the context tier (only
 * when the session did not already carry one from its own log), the selected
 * window limit, and the last known fill. The limit/fill pair is what the Recent
 * Sessions "Context" column and its near-limit filter read, so a session that
 * never gets stamped shows "—" and is never flagged.
 */
export function applyDbContextToSession(session: TodaySessionSummary, info: SessionContextWindow): void {
	if (info.contextTier && !session.contextTier) { session.contextTier = info.contextTier; }
	if (info.contextWindowLimit) { session.contextWindowLimit = info.contextWindowLimit; }
	if (info.contextReachedTokens) { session.contextReachedTokens = info.contextReachedTokens; }
}

/** Stamp every data.db row in `contextInfo` onto each summary indexed under its uuid. */
export function applyDbContextToIndexedSessions(
	sessionsByUuid: Map<string, TodaySessionSummary[]>,
	contextInfo: Map<string, SessionContextWindow>,
): void {
	for (const [uuid, info] of contextInfo) {
		for (const session of sessionsByUuid.get(uuid) ?? []) { applyDbContextToSession(session, info); }
	}
}
