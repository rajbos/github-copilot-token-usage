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
	// Fluency metrics (optional, aggregated from session analysis)
	fluencyMetrics?: {
		askModeCount?: number;
		editModeCount?: number;
		agentModeCount?: number;
		planModeCount?: number;
		customAgentModeCount?: number;
		toolCallsJson?: string;
		contextRefsJson?: string;
		mcpToolsJson?: string;
		modelSwitchingJson?: string;
		repoCustomizationRate?: number;
		multiTurnSessions?: number;
		avgTurnsPerSession?: number;
		multiFileEdits?: number;
		avgFilesPerEdit?: number;
		codeBlockApplyRate?: number;
		sessionCount?: number;
	};
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
	value: { inputTokens: number; outputTokens: number; interactions: number; fluencyMetrics?: DailyRollupValue['fluencyMetrics'] }
): void {
	const mapKey = dailyRollupMapKey(key);
	const existing = map.get(mapKey);

	if (existing) {
		existing.value.inputTokens += value.inputTokens;
		existing.value.outputTokens += value.outputTokens;
		existing.value.interactions += value.interactions;
		
		// Merge fluency metrics if provided
		if (value.fluencyMetrics) {
			if (!existing.value.fluencyMetrics) {
				existing.value.fluencyMetrics = {};
			}
			const ex = existing.value.fluencyMetrics;
			const val = value.fluencyMetrics;
			
			// Add numeric counts
			if (val.askModeCount !== undefined) {
				ex.askModeCount = (ex.askModeCount || 0) + val.askModeCount;
			}
			if (val.editModeCount !== undefined) {
				ex.editModeCount = (ex.editModeCount || 0) + val.editModeCount;
			}
			if (val.agentModeCount !== undefined) {
				ex.agentModeCount = (ex.agentModeCount || 0) + val.agentModeCount;
			}
			if (val.planModeCount !== undefined) {
				ex.planModeCount = (ex.planModeCount || 0) + val.planModeCount;
			}
			if (val.customAgentModeCount !== undefined) {
				ex.customAgentModeCount = (ex.customAgentModeCount || 0) + val.customAgentModeCount;
			}
			if (val.multiTurnSessions !== undefined) {
				ex.multiTurnSessions = (ex.multiTurnSessions || 0) + val.multiTurnSessions;
			}
			if (val.multiFileEdits !== undefined) {
				ex.multiFileEdits = (ex.multiFileEdits || 0) + val.multiFileEdits;
			}
			if (val.sessionCount !== undefined) {
				ex.sessionCount = (ex.sessionCount || 0) + val.sessionCount;
			}
			
			// Merge JSON objects (parse, merge, serialize)
			if (val.toolCallsJson) {
				ex.toolCallsJson = mergeJsonMetrics(ex.toolCallsJson, val.toolCallsJson);
			}
			if (val.contextRefsJson) {
				ex.contextRefsJson = mergeJsonMetrics(ex.contextRefsJson, val.contextRefsJson);
			}
			if (val.mcpToolsJson) {
				ex.mcpToolsJson = mergeJsonMetrics(ex.mcpToolsJson, val.mcpToolsJson);
			}
			if (val.modelSwitchingJson) {
				ex.modelSwitchingJson = mergeJsonMetrics(ex.modelSwitchingJson, val.modelSwitchingJson);
			}
			
			// Re-calculate averages and rates from totals
			if (ex.sessionCount && ex.sessionCount > 0) {
				if (ex.multiTurnSessions !== undefined) {
					// avgTurnsPerSession will be recalculated from aggregated data
				}
				if (ex.multiFileEdits !== undefined) {
					// avgFilesPerEdit will be recalculated from aggregated data
				}
			}
		}
	} else {
		map.set(mapKey, {
			key: { ...key },
			value: {
				inputTokens: value.inputTokens,
				outputTokens: value.outputTokens,
				interactions: value.interactions,
				...(value.fluencyMetrics ? { fluencyMetrics: { ...value.fluencyMetrics } } : {})
			}
		});
	}
}

/**
 * Helper function to merge JSON-serialized metrics objects.
 * Parses both JSONs, merges numeric values by adding them, and re-serializes.
 */
function mergeJsonMetrics(existing: string | undefined, incoming: string): string {
	try {
		const existingObj = existing ? JSON.parse(existing) : {};
		const incomingObj = JSON.parse(incoming);
		
		// Merge objects by adding numeric values
		const merged: any = { ...existingObj };
		for (const key in incomingObj) {
			if (typeof incomingObj[key] === 'number') {
				merged[key] = (merged[key] || 0) + incomingObj[key];
			} else if (typeof incomingObj[key] === 'object' && incomingObj[key] !== null) {
				// Recursively merge nested objects
				if (typeof merged[key] === 'object' && merged[key] !== null) {
					for (const subKey in incomingObj[key]) {
						if (typeof incomingObj[key][subKey] === 'number') {
							if (typeof merged[key][subKey] !== 'number') {
								merged[key][subKey] = 0;
							}
							merged[key][subKey] += incomingObj[key][subKey];
						} else {
							merged[key][subKey] = incomingObj[key][subKey];
						}
					}
				} else {
					merged[key] = incomingObj[key];
				}
			} else {
				merged[key] = incomingObj[key];
			}
		}
		
		return JSON.stringify(merged);
	} catch {
		// If parsing fails, return the incoming value
		return incoming;
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
