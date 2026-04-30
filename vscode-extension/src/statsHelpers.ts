/**
 * Pure helper functions for token stats aggregation.
 *
 * These functions have no VS Code or filesystem dependencies and can be
 * imported by extension.ts and exercised in isolation by unit tests.
 */

import type { ModelUsage, EditorUsage } from './types';

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
