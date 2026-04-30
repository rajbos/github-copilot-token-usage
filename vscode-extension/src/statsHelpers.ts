/**
 * Pure helper functions for token stats aggregation.
 *
 * These functions have no VS Code or filesystem dependencies and can be
 * imported by extension.ts and exercised in isolation by unit tests.
 */

import type { ModelUsage, EditorUsage, DailyTokenStats, SessionFileCache } from './types';

/**
 * Merges `source` model usage into `target` (in-place).
 * All four token fields are summed: inputTokens, outputTokens,
 * cachedReadTokens (optional), and cacheCreationTokens (optional).
 */
export function addModelUsage(target: ModelUsage, source: ModelUsage): void {
for (const [model, usage] of Object.entries(source)) {
if (!target[model]) { target[model] = { inputTokens: 0, outputTokens: 0 }; }
target[model].inputTokens += usage.inputTokens;
target[model].outputTokens += usage.outputTokens;
if (usage.cachedReadTokens !== undefined) {
target[model].cachedReadTokens = (target[model].cachedReadTokens ?? 0) + usage.cachedReadTokens;
}
if (usage.cacheCreationTokens !== undefined) {
target[model].cacheCreationTokens = (target[model].cacheCreationTokens ?? 0) + usage.cacheCreationTokens;
}
}
}

/**
 * Adds editor usage (in-place) to a period's `editorUsage` map.
 * Each call increments `sessions` by 1 regardless of token count.
 */
export function addEditorUsage(target: EditorUsage, editorType: string, tokens: number): void {
if (!target[editorType]) { target[editorType] = { tokens: 0, sessions: 0 }; }
target[editorType].tokens += tokens;
target[editorType].sessions += 1;
}

/** UTC date-range keys derived from a single reference instant (`now`). */
export interface UtcDateRanges {
/** YYYY-MM-DD key for "today" in UTC. */
todayUtcKey: string;
/** YYYY-MM-DD key for the first day of the current calendar month in UTC. */
monthUtcStartKey: string;
/** YYYY-MM-DD key for the first day of the previous calendar month in UTC. */
lastMonthUtcStartKey: string;
/** YYYY-MM-DD key for the last day of the previous calendar month in UTC. */
lastMonthUtcEndKey: string;
/** YYYY-MM-DD key for the start of the rolling 30-day window in UTC. */
last30DaysUtcStartKey: string;
/** Unix timestamp (ms) for the start of the rolling 30-day window.
 *  Session files with mtime < this value are outside the 30-day window. */
last30DaysStartMs: number;
}

/**
 * Computes the UTC date-range boundaries used for period attribution.
 *
 * All calculations are UTC-based so they are unaffected by local timezone
 * offsets and DST transitions.
 */
export function computeUtcDateRanges(now: Date): UtcDateRanges {
const todayUtcKey = now.toISOString().slice(0, 10);

const monthUtcStartKey = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);

const lastMonthLastDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
const lastMonthUtcEndKey = lastMonthLastDay.toISOString().slice(0, 10);
const lastMonthUtcStartKey = new Date(Date.UTC(lastMonthLastDay.getUTCFullYear(), lastMonthLastDay.getUTCMonth(), 1)).toISOString().slice(0, 10);

const last30DaysUtcStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 30));
const last30DaysUtcStartKey = last30DaysUtcStart.toISOString().slice(0, 10);
const last30DaysStartMs = last30DaysUtcStart.getTime();

return {
todayUtcKey,
monthUtcStartKey,
lastMonthUtcStartKey,
lastMonthUtcEndKey,
last30DaysUtcStartKey,
last30DaysStartMs,
};
}

// ── aggregatePeriodStats ─────────────────────────────────────────────────────

/**
 * Per-session input for `aggregatePeriodStats`.
 * Created by the caller once the parallel file I/O phase is complete, so the
 * pure helper never touches the filesystem or VS Code APIs.
 */
export interface SessionAggregateInput {
editorType: string;
sessionData: SessionFileCache;
mtime: number; // ms since epoch (from fs.stat().mtime.getTime())
/**
 * Pre-merged last-interaction ISO timestamp.
 * Callers should pass `sessionData.lastInteraction || details.lastInteraction`.
 * When absent or null the file `mtime` is used as the attribution timestamp.
 */
lastInteraction?: string | null;
}

/** Running totals for a single time window (today / month / last-month / last-30-days). */
export interface PeriodAccumulator {
tokens: number;
thinkingTokens: number;
estimatedTokens: number;
actualTokens: number;
sessions: number;
interactions: number;
modelUsage: ModelUsage;
editorUsage: EditorUsage;
}

/** Result returned by `aggregatePeriodStats`. */
export interface AggregateResult {
todayStats: PeriodAccumulator;
monthStats: PeriodAccumulator;
lastMonthStats: PeriodAccumulator;
last30DaysStats: PeriodAccumulator;
dailyStatsMap: Map<string, DailyTokenStats>;
/** Number of sessions that contributed nothing to the last-30-days window. */
skippedCount: number;
}

function makePeriodAccumulator(): PeriodAccumulator {
return {
tokens: 0,
thinkingTokens: 0,
estimatedTokens: 0,
actualTokens: 0,
sessions: 0,
interactions: 0,
modelUsage: {},
editorUsage: {},
};
}

/**
 * Accumulates per-session token data into period buckets and a per-day map.
 *
 * Both the daily-rollup path (sessions with `dailyRollups`) and the
 * session-level fallback path (no rollups) are handled here.  All date
 * comparisons use UTC day keys (YYYY-MM-DD) so the results are identical
 * regardless of the host timezone.
 *
 * @param sessionResults  Non-null session inputs pre-filtered so that each
 *                        session's mtime is within the last-30-days window.
 *                        Null/skipped entries should be excluded before calling.
 * @param utcDateRanges   UTC day-key boundaries for the period windows.
 */
export function aggregatePeriodStats(
sessionResults: SessionAggregateInput[],
utcDateRanges: UtcDateRanges,
): AggregateResult {
const {
todayUtcKey,
monthUtcStartKey,
lastMonthUtcStartKey,
lastMonthUtcEndKey,
last30DaysUtcStartKey,
} = utcDateRanges;

const todayStats = makePeriodAccumulator();
const monthStats = makePeriodAccumulator();
const lastMonthStats = makePeriodAccumulator();
const last30DaysStats = makePeriodAccumulator();
const dailyStatsMap = new Map<string, DailyTokenStats>();
let skippedCount = 0;

for (const { editorType, sessionData, mtime, lastInteraction } of sessionResults) {
const repository = sessionData.repository || 'Unknown';

if (sessionData.dailyRollups && Object.keys(sessionData.dailyRollups).length > 0) {
// ── Per-UTC-day rollup path ──────────────────────────────────────
// Distribute tokens accurately across the days they were generated.
let addedToLast30Days = false;
let addedToMonth = false;
let addedToLastMonth = false;
let addedToToday = false;

for (const [dayKey, dayRollup] of Object.entries(sessionData.dailyRollups)) {
if (dayKey < last30DaysUtcStartKey) { continue; }

const dayTokens = dayRollup.actualTokens > 0 ? dayRollup.actualTokens : dayRollup.tokens;
const dayInteractions = dayRollup.interactions;

// Daily chart accumulation
if (!dailyStatsMap.has(dayKey)) {
dailyStatsMap.set(dayKey, {
date: dayKey,
tokens: 0,
sessions: 0,
interactions: 0,
modelUsage: {},
editorUsage: {},
repositoryUsage: {},
});
}
const dailyEntry = dailyStatsMap.get(dayKey)!;
dailyEntry.tokens += dayTokens;
dailyEntry.sessions += 1;
dailyEntry.interactions += dayInteractions;
if (!dailyEntry.editorUsage[editorType]) { dailyEntry.editorUsage[editorType] = { tokens: 0, sessions: 0 }; }
dailyEntry.editorUsage[editorType].tokens += dayTokens;
dailyEntry.editorUsage[editorType].sessions += 1;
if (!dailyEntry.repositoryUsage[repository]) { dailyEntry.repositoryUsage[repository] = { tokens: 0, sessions: 0 }; }
dailyEntry.repositoryUsage[repository].tokens += dayTokens;
dailyEntry.repositoryUsage[repository].sessions += 1;
addModelUsage(dailyEntry.modelUsage, dayRollup.modelUsage);

// Last-30-days accumulation
last30DaysStats.tokens += dayTokens;
last30DaysStats.estimatedTokens += dayRollup.tokens;
last30DaysStats.actualTokens += dayRollup.actualTokens;
last30DaysStats.thinkingTokens += dayRollup.thinkingTokens;
last30DaysStats.interactions += dayInteractions;
if (!addedToLast30Days) { last30DaysStats.sessions += 1; addedToLast30Days = true; }
addEditorUsage(last30DaysStats.editorUsage, editorType, dayTokens);
addModelUsage(last30DaysStats.modelUsage, dayRollup.modelUsage);

if (dayKey >= monthUtcStartKey) {
// This calendar month
monthStats.tokens += dayTokens;
monthStats.estimatedTokens += dayRollup.tokens;
monthStats.actualTokens += dayRollup.actualTokens;
monthStats.thinkingTokens += dayRollup.thinkingTokens;
monthStats.interactions += dayInteractions;
if (!addedToMonth) { monthStats.sessions += 1; addedToMonth = true; }
addEditorUsage(monthStats.editorUsage, editorType, dayTokens);
addModelUsage(monthStats.modelUsage, dayRollup.modelUsage);

if (dayKey === todayUtcKey) {
todayStats.tokens += dayTokens;
todayStats.estimatedTokens += dayRollup.tokens;
todayStats.actualTokens += dayRollup.actualTokens;
todayStats.thinkingTokens += dayRollup.thinkingTokens;
todayStats.interactions += dayInteractions;
if (!addedToToday) { todayStats.sessions += 1; addedToToday = true; }
addEditorUsage(todayStats.editorUsage, editorType, dayTokens);
addModelUsage(todayStats.modelUsage, dayRollup.modelUsage);
}
} else if (dayKey >= lastMonthUtcStartKey && dayKey <= lastMonthUtcEndKey) {
// Previous calendar month
lastMonthStats.tokens += dayTokens;
lastMonthStats.estimatedTokens += dayRollup.tokens;
lastMonthStats.actualTokens += dayRollup.actualTokens;
lastMonthStats.thinkingTokens += dayRollup.thinkingTokens;
lastMonthStats.interactions += dayInteractions;
if (!addedToLastMonth) { lastMonthStats.sessions += 1; addedToLastMonth = true; }
addEditorUsage(lastMonthStats.editorUsage, editorType, dayTokens);
addModelUsage(lastMonthStats.modelUsage, dayRollup.modelUsage);
}
}

if (!addedToLast30Days) { skippedCount++; }
} else {
// ── Fallback: session-level attribution using UTC boundaries ─────
// Used when the session cache has no per-day rollup data.
const interactions = sessionData.interactions;
const estimatedTokens = sessionData.tokens;
const actualTokens = sessionData.actualTokens || 0;
const tokens = actualTokens > 0 ? actualTokens : estimatedTokens;
const modelUsage = sessionData.modelUsage;

const lastInteractionStr = lastInteraction || null;
const lastActivity = lastInteractionStr ? new Date(lastInteractionStr) : new Date(mtime);
const lastActivityUtcKey = lastActivity.toISOString().slice(0, 10);

if (lastActivityUtcKey < last30DaysUtcStartKey) { skippedCount++; continue; }

// Daily chart accumulation
if (!dailyStatsMap.has(lastActivityUtcKey)) {
dailyStatsMap.set(lastActivityUtcKey, {
date: lastActivityUtcKey,
tokens: 0,
sessions: 0,
interactions: 0,
modelUsage: {},
editorUsage: {},
repositoryUsage: {},
});
}
const dailyEntry = dailyStatsMap.get(lastActivityUtcKey)!;
dailyEntry.tokens += tokens;
dailyEntry.sessions += 1;
dailyEntry.interactions += interactions;
if (!dailyEntry.editorUsage[editorType]) { dailyEntry.editorUsage[editorType] = { tokens: 0, sessions: 0 }; }
dailyEntry.editorUsage[editorType].tokens += tokens;
dailyEntry.editorUsage[editorType].sessions += 1;
if (!dailyEntry.repositoryUsage[repository]) { dailyEntry.repositoryUsage[repository] = { tokens: 0, sessions: 0 }; }
dailyEntry.repositoryUsage[repository].tokens += tokens;
dailyEntry.repositoryUsage[repository].sessions += 1;
addModelUsage(dailyEntry.modelUsage, modelUsage);

// Last-30-days accumulation
last30DaysStats.tokens += tokens;
last30DaysStats.estimatedTokens += estimatedTokens;
last30DaysStats.actualTokens += actualTokens;
last30DaysStats.thinkingTokens += (sessionData.thinkingTokens || 0);
last30DaysStats.sessions += 1;
last30DaysStats.interactions += interactions;
addEditorUsage(last30DaysStats.editorUsage, editorType, tokens);
addModelUsage(last30DaysStats.modelUsage, modelUsage);

if (lastActivityUtcKey >= monthUtcStartKey) {
monthStats.tokens += tokens;
monthStats.estimatedTokens += estimatedTokens;
monthStats.actualTokens += actualTokens;
monthStats.thinkingTokens += (sessionData.thinkingTokens || 0);
monthStats.sessions += 1;
monthStats.interactions += interactions;
addEditorUsage(monthStats.editorUsage, editorType, tokens);
addModelUsage(monthStats.modelUsage, modelUsage);

if (lastActivityUtcKey === todayUtcKey) {
todayStats.tokens += tokens;
todayStats.estimatedTokens += estimatedTokens;
todayStats.actualTokens += actualTokens;
todayStats.thinkingTokens += (sessionData.thinkingTokens || 0);
todayStats.sessions += 1;
todayStats.interactions += interactions;
addEditorUsage(todayStats.editorUsage, editorType, tokens);
addModelUsage(todayStats.modelUsage, modelUsage);
}
} else if (lastActivityUtcKey >= lastMonthUtcStartKey && lastActivityUtcKey <= lastMonthUtcEndKey) {
lastMonthStats.tokens += tokens;
lastMonthStats.estimatedTokens += estimatedTokens;
lastMonthStats.actualTokens += actualTokens;
lastMonthStats.thinkingTokens += (sessionData.thinkingTokens || 0);
lastMonthStats.sessions += 1;
lastMonthStats.interactions += interactions;
addEditorUsage(lastMonthStats.editorUsage, editorType, tokens);
addModelUsage(lastMonthStats.modelUsage, modelUsage);
}
}
}

return { todayStats, monthStats, lastMonthStats, last30DaysStats, dailyStatsMap, skippedCount };
}
