/**
 * Daily rollup computation logic.
 * Handles aggregation of session data into daily rollups per dimension.
 */

import type { DailyRollupValue } from './types';

/**
 * Key identifying a unique daily rollup (dimensions).
 */
export interface DailyRollupKey {
	day: string;           // YYYY-MM-DD
	model: string;
	workspaceId: string;
	machineId: string;
	userId?: string;
}

/**
 * Map entry containing both key and value for a daily rollup.
 */
export interface DailyRollupMapEntryLike {
	key: DailyRollupKey;
	value: DailyRollupValueLike;
}

/**
 * Daily rollup value (can be interface or plain object).
 */
export interface DailyRollupValueLike {
	inputTokens: number;
	outputTokens: number;
	interactions: number;
}

/**
 * Builds a stable map key from rollup dimensions.
 * Empty string userIds are normalized to undefined for consistent keying.
 * 
 * @param key - The rollup key containing all dimensions
 * @returns Stable JSON string key suitable for Map operations
 */
export function dailyRollupMapKey(key: DailyRollupKey): string {
	const userId = (key.userId ?? '').trim();
	return JSON.stringify({
		day: key.day,
		model: key.model,
		workspaceId: key.workspaceId,
		machineId: key.machineId,
		userId: userId || undefined
	});
}

/**
 * Upserts a daily rollup into a map, merging values if key already exists.
 * If a rollup with matching dimensions exists, token counts and interactions are added.
 * Otherwise, a new entry is created.
 * 
 * @param map - The map to update (modified in place)
 * @param key - The rollup key identifying dimensions
 * @param value - The rollup value to add (tokens and interactions)
 */
export function upsertDailyRollup(
	map: Map<string, { key: DailyRollupKey; value: DailyRollupValue }>,
	key: DailyRollupKey,
	value: { inputTokens: number; outputTokens: number; interactions: number }
): void {
	const mapKey = dailyRollupMapKey(key);
	const existing = map.get(mapKey);

	if (existing) {
		existing.value.inputTokens += value.inputTokens;
		existing.value.outputTokens += value.outputTokens;
		existing.value.interactions += value.interactions;
	} else {
		map.set(mapKey, {
			key: { ...key },
			value: {
				inputTokens: value.inputTokens,
				outputTokens: value.outputTokens,
				interactions: value.interactions
			}
		});
	}
}

/**
 * Converts a UTC day key (YYYY-MM-DD) to an ISO week key (YYYY-Www).
 * Uses ISO 8601 week date system (week starts on Monday).
 * @param utcDayKey - Day in YYYY-MM-DD format
 * @returns ISO week key in YYYY-Www format
 */
export function isoWeekKeyFromUtcDayKey(utcDayKey: string): string {
	const date = new Date(`${utcDayKey}T00:00:00.000Z`);
	
	// Get ISO week number (ISO 8601: week starts on Monday, first week has Thursday)
	const target = new Date(date.valueOf());
	const dayNumber = (date.getUTCDay() + 6) % 7; // Monday = 0
	target.setUTCDate(target.getUTCDate() - dayNumber + 3); // Move to Thursday of this week
	const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4)); // Jan 4 is always in week 1
	const weekNumber = 1 + Math.floor((target.getTime() - firstThursday.getTime()) / 604800000); // 604800000 = 7 days in ms
	
	// ISO week year (may differ from calendar year for week 1 and week 53)
	const isoYear = target.getUTCFullYear();
	
	return `${isoYear}-W${weekNumber.toString().padStart(2, '0')}`;
}

/**
 * Aggregates rollup values by a specific dimension.
 * @param rollups - Array of rollup entries
 * @param dimension - The dimension to group by ('model', 'workspaceId', 'machineId', 'userId')
 * @returns Map of dimension value to aggregated rollup value
 */
export function aggregateByDimension(
	rollups: DailyRollupMapEntryLike[],
	dimension: keyof DailyRollupKey
): Map<string, DailyRollupValue> {
	const result = new Map<string, DailyRollupValue>();

	for (const entry of rollups) {
		const dimValue = entry.key[dimension]?.toString() || 'unknown';
		const existing = result.get(dimValue);

		if (existing) {
			existing.inputTokens += entry.value.inputTokens;
			existing.outputTokens += entry.value.outputTokens;
			existing.interactions += entry.value.interactions;
		} else {
			result.set(dimValue, {
				inputTokens: entry.value.inputTokens,
				outputTokens: entry.value.outputTokens,
				interactions: entry.value.interactions
			});
		}
	}

	return result;
}

/**
 * Filters rollup entries by dimension value.
 * @param rollups - Array of rollup entries
 * @param dimension - The dimension to filter by
 * @param value - The value to match
 * @returns Filtered array
 */
export function filterByDimension(
	rollups: DailyRollupMapEntryLike[],
	dimension: keyof DailyRollupKey,
	value: string
): DailyRollupMapEntryLike[] {
	return rollups.filter(entry => entry.key[dimension] === value);
}
