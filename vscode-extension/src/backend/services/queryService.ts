/**
 * Query service for backend facade.
 * Handles backend queries, caching, and filter management.
 */

import type { BackendQueryFilters, BackendSettings } from '../settings';
import { QUERY_CACHE_TTL_MS, MAX_UI_LIST_ITEMS, MIN_LOOKBACK_DAYS, MAX_LOOKBACK_DAYS, DEFAULT_LOOKBACK_DAYS } from '../constants';
import type { ModelUsage, SessionStats, StatsForPeriod } from '../types';
import type { TableClientLike } from '../storageTables';
import { CredentialService } from './credentialService';
import { DataPlaneService } from './dataPlaneService';
import { BackendUtility } from './utilityService';
import { safeStringifyError } from '../../../../src/utils/errors';
import { calculateEnvironmentalImpact } from '../../../../src/environmentalImpact';

export interface BackendQueryResultLike {
	stats: SessionStats;
	availableModels: string[];
	availableWorkspaces: string[];
	availableMachines: string[];
	availableUsers: string[];
	workspaceNamesById?: Record<string, string>;
	machineNamesById?: Record<string, string>;
	workspaceTokenTotals: Array<{ workspaceId: string; tokens: number }>;
	machineTokenTotals: Array<{ machineId: string; tokens: number }>;
}

interface EntityRollup {
	model: string;
	workspaceId: string;
	workspaceName: string;
	machineId: string;
	machineName: string;
	userId: string;
	inputTokens: number;
	outputTokens: number;
	interactions: number;
}

interface RollupAccumulator {
	modelsSet: Set<string>;
	workspacesSet: Set<string>;
	machinesSet: Set<string>;
	usersSet: Set<string>;
	workspaceNamesById: Record<string, string>;
	machineNamesById: Record<string, string>;
	totalTokens: number;
	totalInteractions: number;
	modelUsage: ModelUsage;
	workspaceTokens: Map<string, number>;
	machineTokens: Map<string, number>;
}

export interface QueryServiceDeps {
	warn: (message: string) => void;
	calculateEstimatedCost: (modelUsage: ModelUsage) => number;
}

/**
 * QueryService manages backend queries, filtering, and result caching.
 */
export class QueryService {
	private backendLastQueryResult: BackendQueryResultLike | undefined;
	private backendFilters: BackendQueryFilters = { lookbackDays: DEFAULT_LOOKBACK_DAYS };
	private backendLastQueryCacheKey: string | undefined;
	private backendLastQueryCacheAt: number | undefined;

	constructor(
		private deps: QueryServiceDeps,
		private credentialService: CredentialService,
		private dataPlaneService: DataPlaneService,
		private utility: typeof BackendUtility
	) {}

	/**
	 * Clear the query cache.
	 */
	clearQueryCache(): void {
		this.backendLastQueryCacheKey = undefined;
		this.backendLastQueryResult = undefined;
		this.backendLastQueryCacheAt = undefined;
	}

	/**
	 * Get the current filters.
	 */
	getFilters(): BackendQueryFilters {
		return { ...this.backendFilters };
	}

	/**
	 * Set filters for backend queries.
	 */
	setFilters(filters: Partial<BackendQueryFilters>): void {
		if (typeof filters.lookbackDays === 'number') {
			this.backendFilters.lookbackDays = Math.max(MIN_LOOKBACK_DAYS, Math.min(MAX_LOOKBACK_DAYS, filters.lookbackDays));
		}
		this.backendFilters.model = filters.model || undefined;
		this.backendFilters.workspaceId = filters.workspaceId || undefined;
		this.backendFilters.machineId = filters.machineId || undefined;
		this.backendFilters.userId = filters.userId || undefined;

		this.backendLastQueryCacheKey = undefined;
		this.backendLastQueryCacheAt = undefined;
		this.backendLastQueryResult = undefined;
	}

	/**
	 * Get the last query result.
	 */
	getLastQueryResult(): BackendQueryResultLike | undefined {
		return this.backendLastQueryResult;
	}

	/**
	 * Expose cache state for testing. Should only be used by tests.
	 */
	getCacheKey(): string | undefined {
		return this.backendLastQueryCacheKey;
	}

	getCacheTimestamp(): number | undefined {
		return this.backendLastQueryCacheAt;
	}

	/**
	 * Allow tests to inject cache state. Should only be used by tests.
	 */
	setCacheState(result: BackendQueryResultLike | undefined, cacheKey: string | undefined, timestamp: number | undefined): void {
		this.backendLastQueryResult = result;
		this.backendLastQueryCacheKey = cacheKey;
		this.backendLastQueryCacheAt = timestamp;
	}

	/**
	 * Build a cache key for a backend query.
	 * Validates that required fields are present to ensure cache hits are reliable.
	 */
	private buildBackendCacheKey(settings: BackendSettings, filters: BackendQueryFilters, startDayKey: string, endDayKey: string): string {
		// Validate required fields are non-empty to prevent spurious cache misses
		if (!settings.storageAccount || !settings.storageAccount.trim()) {
			throw new Error('Storage account is required to build cache key');
		}
		if (!settings.aggTable || !settings.aggTable.trim()) {
			throw new Error('Aggregate table is required to build cache key');
		}
		return JSON.stringify({
			account: settings.storageAccount,
			table: settings.aggTable,
			datasetId: settings.datasetId,
			startDayKey,
			endDayKey,
			filters
		});
	}

	private buildBackendQueryResult(acc: RollupAccumulator): BackendQueryResultLike {
		const { modelsSet, workspacesSet, machinesSet, usersSet, workspaceNamesById, machineNamesById,
			totalTokens, totalInteractions, modelUsage, workspaceTokens, machineTokens } = acc;
		const cost = this.deps.calculateEstimatedCost(modelUsage);
		const environmentalImpact = calculateEnvironmentalImpact(modelUsage, totalTokens);
		const statsForRange: StatsForPeriod = {
			tokens: totalTokens, sessions: totalInteractions,
			avgInteractionsPerSession: totalInteractions > 0 ? 1 : 0,
			avgTokensPerSession: totalInteractions > 0 ? Math.round(totalTokens / totalInteractions) : 0,
			modelUsage, editorUsage: {}, co2: environmentalImpact.co2,
			treesEquivalent: environmentalImpact.treesEquivalent,
			waterUsage: environmentalImpact.waterUsage, estimatedCost: cost
		};
		return {
			stats: { today: statsForRange, month: statsForRange, lastUpdated: new Date() },
			availableModels: Array.from(modelsSet).sort(),
			availableWorkspaces: Array.from(workspacesSet).sort(),
			availableMachines: Array.from(machinesSet).sort(),
			availableUsers: Array.from(usersSet).sort(),
			workspaceNamesById: Object.keys(workspaceNamesById).length ? workspaceNamesById : undefined,
			machineNamesById: Object.keys(machineNamesById).length ? machineNamesById : undefined,
			workspaceTokenTotals: Array.from(workspaceTokens.entries()).map(([workspaceId, tokens]) => ({ workspaceId, tokens })).sort((a, b) => b.tokens - a.tokens).slice(0, MAX_UI_LIST_ITEMS),
			machineTokenTotals: Array.from(machineTokens.entries()).map(([machineId, tokens]) => ({ machineId, tokens })).sort((a, b) => b.tokens - a.tokens).slice(0, MAX_UI_LIST_ITEMS)
		};
	}

	/**
	 * Query backend rollups for a date range.
	 */
	async queryBackendRollups(settings: BackendSettings, filters: BackendQueryFilters, startDayKey: string, endDayKey: string): Promise<BackendQueryResultLike> {
		const cacheKey = this.buildBackendCacheKey(settings, filters, startDayKey, endDayKey);
		if (this.backendLastQueryCacheKey === cacheKey && this.backendLastQueryCacheAt && Date.now() - this.backendLastQueryCacheAt < QUERY_CACHE_TTL_MS && this.backendLastQueryResult) {
			return this.backendLastQueryResult;
		}
		const creds = await this.credentialService.getBackendDataPlaneCredentialsOrThrow(settings);
		const tableClient = this.dataPlaneService.createTableClient(settings, creds.tableCredential) as unknown as TableClientLike;
		const allEntities = await this.dataPlaneService.listEntitiesForRange({ tableClient, datasetId: settings.datasetId, startDayKey, endDayKey });
		const acc: RollupAccumulator = {
			modelsSet: new Set<string>(), workspacesSet: new Set<string>(), machinesSet: new Set<string>(), usersSet: new Set<string>(),
			workspaceNamesById: {}, machineNamesById: {}, totalTokens: 0, totalInteractions: 0, modelUsage: {},
			workspaceTokens: new Map<string, number>(), machineTokens: new Map<string, number>()
		};
		for (const entity of allEntities) {
			const rollup = this.mapEntityToRollup(entity);
			if (!rollup) { continue; }
			acc.modelsSet.add(rollup.model);
			acc.workspacesSet.add(rollup.workspaceId);
			acc.machinesSet.add(rollup.machineId);
			if (rollup.userId) { acc.usersSet.add(rollup.userId); }
			if (rollup.workspaceName && !acc.workspaceNamesById[rollup.workspaceId]) { acc.workspaceNamesById[rollup.workspaceId] = rollup.workspaceName; }
			if (rollup.machineName && !acc.machineNamesById[rollup.machineId]) { acc.machineNamesById[rollup.machineId] = rollup.machineName; }
			if (!this.filterRollup(rollup, filters)) { continue; }
			this.accumulateRollup(acc, rollup);
		}
		const result = this.buildBackendQueryResult(acc);
		this.backendLastQueryResult = result;
		this.backendLastQueryCacheKey = cacheKey;
		this.backendLastQueryCacheAt = Date.now();
		return result;
	}

	/**
	 * Try to get backend detailed stats for status bar.
	 */
	async tryGetBackendDetailedStatsForStatusBar(settings: BackendSettings, isConfigured: boolean, sharingPolicy: { allowCloudSync: boolean }): Promise<SessionStats | undefined> {
		if (!sharingPolicy.allowCloudSync || !isConfigured) {
			return undefined;
		}
		try {
			const now = new Date();
			const todayKey = this.utility.toUtcDayKey(now);
			const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
			const monthStartKey = this.utility.toUtcDayKey(monthStart);

			const todayResult = await this.queryBackendRollups(settings, { lookbackDays: 1 }, todayKey, todayKey);
			const monthResult = await this.queryBackendRollups(settings, { lookbackDays: 31 }, monthStartKey, todayKey);

			return {
				today: todayResult.stats.today,
				month: monthResult.stats.today,
				lastUpdated: new Date()
			};
		} catch (e: unknown) {
			this.deps.warn(`Backend query failed: ${safeStringifyError(e)}`);
			return undefined;
		}
	}

	/**
	 * Get stats for details panel.
	 */
	async getStatsForDetailsPanel(settings: BackendSettings, isConfigured: boolean, sharingPolicy: { allowCloudSync: boolean }): Promise<SessionStats | undefined> {
		if (!sharingPolicy.allowCloudSync || !isConfigured) {
			return undefined;
		}

		const now = new Date();
		const todayKey = this.utility.toUtcDayKey(now);
		const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
		const monthStartKey = this.utility.toUtcDayKey(monthStart);
		const lookbackDays = Math.max(MIN_LOOKBACK_DAYS, Math.min(MAX_LOOKBACK_DAYS, this.backendFilters.lookbackDays ?? DEFAULT_LOOKBACK_DAYS));
		const startKey = this.utility.addDaysUtc(todayKey, -(lookbackDays - 1));

		try {
			// Month query first; ensure lastQueryResult reflects the user-selected range.
			const monthResult = await this.queryBackendRollups(settings, this.backendFilters, monthStartKey, todayKey);
			const rangeResult = await this.queryBackendRollups(settings, this.backendFilters, startKey, todayKey);

			return {
				today: rangeResult.stats.today,
				month: monthResult.stats.today,
				lastUpdated: new Date()
			};
		} catch (e: unknown) {
			this.deps.warn(`Backend query failed: ${safeStringifyError(e)}`);
			return undefined;
		}
	}

	private mapEntityToRollup(entity: any): EntityRollup | null {
		const model = (entity.model ?? '').toString();
		const workspaceId = (entity.workspaceId ?? '').toString();
		const machineId = (entity.machineId ?? '').toString();
		if (!model || !workspaceId || !machineId) {
			return null;
		}
		return {
			model,
			workspaceId,
			workspaceName: typeof entity.workspaceName === 'string' ? entity.workspaceName.trim() : '',
			machineId,
			machineName: typeof entity.machineName === 'string' ? entity.machineName.trim() : '',
			userId: (entity.userId ?? '').toString(),
			inputTokens: Number.isFinite(Number(entity.inputTokens)) ? Number(entity.inputTokens) : 0,
			outputTokens: Number.isFinite(Number(entity.outputTokens)) ? Number(entity.outputTokens) : 0,
			interactions: Number.isFinite(Number(entity.interactions)) ? Number(entity.interactions) : 0
		};
	}

	private filterRollup(rollup: EntityRollup, filters: BackendQueryFilters): boolean {
		if (filters.model && filters.model !== rollup.model) { return false; }
		if (filters.workspaceId && filters.workspaceId !== rollup.workspaceId) { return false; }
		if (filters.machineId && filters.machineId !== rollup.machineId) { return false; }
		if (filters.userId && filters.userId !== rollup.userId) { return false; }
		return true;
	}

	private accumulateRollup(acc: RollupAccumulator, rollup: EntityRollup): void {
		const tokens = rollup.inputTokens + rollup.outputTokens;
		acc.totalTokens += tokens;
		acc.totalInteractions += rollup.interactions;
		if (!acc.modelUsage[rollup.model]) {
			acc.modelUsage[rollup.model] = { inputTokens: 0, outputTokens: 0, sessions: 0 };
		}
		acc.modelUsage[rollup.model].inputTokens += rollup.inputTokens;
		acc.modelUsage[rollup.model].outputTokens += rollup.outputTokens;
		acc.workspaceTokens.set(rollup.workspaceId, (acc.workspaceTokens.get(rollup.workspaceId) ?? 0) + tokens);
		acc.machineTokens.set(rollup.machineId, (acc.machineTokens.get(rollup.machineId) ?? 0) + tokens);
	}
}
