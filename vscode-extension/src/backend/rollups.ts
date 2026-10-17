/**
 * Daily rollup computation logic.
 * Handles aggregation of session data into daily rollups per dimension.
 */

import type { DailyRollupValue } from './types';
import { isObject } from '../../../src/utils/typeGuards';

/**
 * Key identifying a unique daily rollup (dimensions).
 */
export interface DailyRollupKey {
	day: string;           // YYYY-MM-DD
	model: string;
	workspaceId: string;
	machineId: string;
	userId?: string;
	editor?: string;       // Friendly editor name (e.g. 'VS Code', 'Copilot CLI'). Optional — omit for Azure Storage path.
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
		cliModeCount?: number;
		toolCallsJson?: string;
		contextRefsJson?: string;
		mcpToolsJson?: string;
		modelSwitchingJson?: string;
		editScopeJson?: string; // NEW: Edit scope metrics
		agentTypesJson?: string; // NEW: Agent type distribution
		repositoriesJson?: string; // NEW: Repository lists
		applyUsageJson?: string; // NEW: Apply usage metrics
		sessionDurationJson?: string; // NEW: Session duration data
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
	const entry: Record<string, unknown> = {
		day: key.day,
		model: key.model,
		workspaceId: key.workspaceId,
		machineId: key.machineId,
		userId: userId || undefined,
	};
	// Only include editor in the map key when it is explicitly set.
	// This keeps Azure Storage rollups (which omit editor) unchanged.
	if (key.editor) {
		entry.editor = key.editor;
	}
	return JSON.stringify(entry);
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

		if (value.fluencyMetrics) {
			if (!existing.value.fluencyMetrics) {
				existing.value.fluencyMetrics = {};
			}
			_mergeNumericFluencyMetrics(existing.value.fluencyMetrics, value.fluencyMetrics);
			_mergeJsonFluencyMetrics(existing.value.fluencyMetrics, value.fluencyMetrics);
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

function _addCount(existing: number | undefined, delta: number): number {
	return (existing || 0) + delta;
}

type FluencyMetrics = NonNullable<DailyRollupValue['fluencyMetrics']>;

/** Fluency metric keys representing simple counts that are summed during rollup merge. */
const NUMERIC_FLUENCY_FIELDS = [
	'askModeCount', 'editModeCount', 'agentModeCount', 'planModeCount',
	'customAgentModeCount', 'cliModeCount', 'multiTurnSessions', 'multiFileEdits', 'sessionCount'
] as const satisfies ReadonlyArray<keyof FluencyMetrics>;

type NumericFluencyMetricKey = typeof NUMERIC_FLUENCY_FIELDS[number];

/** Fluency metric keys that are JSON-serialized objects, paired with their merge strategy. */
const JSON_FLUENCY_FIELD_MERGERS = [
	{ key: 'toolCallsJson', merge: mergeJsonMetrics },
	{ key: 'contextRefsJson', merge: mergeJsonMetrics },
	{ key: 'mcpToolsJson', merge: mergeJsonMetrics },
	{ key: 'modelSwitchingJson', merge: mergeJsonMetrics },
	{ key: 'editScopeJson', merge: mergeJsonMetrics },
	{ key: 'agentTypesJson', merge: mergeJsonMetrics },
	{ key: 'repositoriesJson', merge: mergeRepositoriesJson },
	{ key: 'applyUsageJson', merge: mergeJsonMetrics },
	{ key: 'sessionDurationJson', merge: mergeJsonMetrics },
] as const satisfies ReadonlyArray<{
	key: keyof FluencyMetrics;
	merge: (existing: string | undefined, incoming: string) => string;
}>;

function _mergeNumericFluencyMetrics(ex: FluencyMetrics, val: FluencyMetrics): void {
	for (const field of NUMERIC_FLUENCY_FIELDS) {
		const incoming = val[field as NumericFluencyMetricKey];
		if (incoming !== undefined) {
			ex[field as NumericFluencyMetricKey] = _addCount(ex[field as NumericFluencyMetricKey], incoming);
		}
	}
}

function _mergeJsonFluencyMetrics(ex: FluencyMetrics, val: FluencyMetrics): void {
	const exR = ex as Record<string, string | undefined>;
	const valR = val as Record<string, string | undefined>;
	for (const { key, merge } of JSON_FLUENCY_FIELD_MERGERS) {
		const incoming = valR[key];
		if (incoming) {
			exR[key] = merge(exR[key], incoming);
		}
	}
}

function mergeNumericValues(existing: unknown, delta: number): number {
	return (typeof existing === 'number' ? existing : 0) + delta;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The additive latency histogram shape from src/latencyHistogram.ts: `{ count, sumMs, buckets[] }`. */
function isLatencyHistogramLike(value: unknown): value is { count: number; sumMs: number; buckets: number[] } {
	return isPlainRecord(value) && typeof value.count === 'number' && Array.isArray(value.buckets);
}

/** Element-wise sum of two histograms; bucket arrays of different length are padded, never truncated. */
function mergeLatencyHistogramLike(
	existing: { count: number; sumMs: number; buckets: number[] },
	incoming: { count: number; sumMs: number; buckets: number[] }
): { count: number; sumMs: number; buckets: number[] } {
	const buckets = [...existing.buckets];
	incoming.buckets.forEach((n, i) => { buckets[i] = (buckets[i] ?? 0) + (typeof n === 'number' ? n : 0); });
	return {
		count: existing.count + incoming.count,
		sumMs: (typeof existing.sumMs === 'number' ? existing.sumMs : 0) + (typeof incoming.sumMs === 'number' ? incoming.sumMs : 0),
		buckets,
	};
}

/**
 * Add `incoming` into `existing` key by key. Numbers add; nested records recurse so
 * per-tool maps of histograms (`latencyByTool`) or counts stay additive across the
 * sessions rolled into one day — assigning the incoming object wholesale would keep
 * only the last session's histogram and corrupt uploaded p50/p95.
 */
function mergeNestedObject(
	existing: Record<string, unknown>,
	incoming: Record<string, unknown>
): Record<string, unknown> {
	const merged = { ...existing };
	for (const key in incoming) {
		const incomingVal = incoming[key];
		const existingVal = existing[key];
		if (typeof incomingVal === 'number') {
			merged[key] = mergeNumericValues(existingVal, incomingVal);
		} else if (isLatencyHistogramLike(incomingVal) && isLatencyHistogramLike(existingVal)) {
			merged[key] = mergeLatencyHistogramLike(existingVal, incomingVal);
		} else if (isPlainRecord(incomingVal) && isPlainRecord(existingVal)) {
			merged[key] = mergeNestedObject(existingVal, incomingVal);
		} else {
			merged[key] = incomingVal;
		}
	}
	return merged;
}

function mergeMetricEntry(existing: unknown, incoming: unknown): unknown {
	if (typeof incoming === 'number') {
		return mergeNumericValues(existing, incoming);
	}
	if (isObject(incoming) && isObject(existing)) {
		return mergeNestedObject(existing, incoming);
	}
	return incoming;
}

/**
 * Helper function to merge JSON-serialized metrics objects.
 * Parses both JSONs, merges numeric values by adding them, and re-serializes.
 */
function mergeJsonMetrics(existing: string | undefined, incoming: string): string {
	try {
		const existingObj: Record<string, unknown> = existing ? JSON.parse(existing) : {};
		const incomingObj: Record<string, unknown> = JSON.parse(incoming);

		const merged: Record<string, unknown> = { ...existingObj };
		for (const key in incomingObj) {
			merged[key] = mergeMetricEntry(merged[key], incomingObj[key]);
		}

		return JSON.stringify(merged);
	} catch {
		// If parsing fails, return the incoming value
		return incoming;
	}
}

/**
 * Helper function to merge repository arrays from JSON.
 * Merges and deduplicates repository lists.
 */
function mergeRepositoriesJson(existing: string | undefined, incoming: string): string {
	try {
		const existingData = existing ? JSON.parse(existing) : { repositories: [], repositoriesWithCustomization: [] };
		const incomingData = JSON.parse(incoming);
		
		// Merge and deduplicate arrays
		const mergedRepos = [...new Set([...(existingData.repositories || []), ...(incomingData.repositories || [])])];
		const mergedCustomized = [...new Set([...(existingData.repositoriesWithCustomization || []), ...(incomingData.repositoriesWithCustomization || [])])];
		
		return JSON.stringify({
			repositories: mergedRepos,
			repositoriesWithCustomization: mergedCustomized
		});
	} catch {
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
