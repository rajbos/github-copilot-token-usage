/**
 * Query service for backend facade.
 * Handles backend queries, caching, and filter management.
 */

import type { BackendQueryFilters, BackendSettings } from '../settings';
import { QUERY_CACHE_TTL_MS, MAX_UI_LIST_ITEMS, MIN_LOOKBACK_DAYS, MAX_LOOKBACK_DAYS, DEFAULT_LOOKBACK_DAYS } from '../constants';
import type { ModelUsage, SessionStats } from '../types';
import { CredentialService } from './credentialService';
import { DataPlaneService } from './dataPlaneService';
import { BackendUtility } from './utilityService';

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

export interface QueryServiceDeps {
	warn: (message: string) => void;
	calculateEstimatedCost: (modelUsage: ModelUsage) => number;
	co2Per1kTokens: number;
	waterUsagePer1kTokens: number;
	co2AbsorptionPerTreePerYear: number;
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
	 */
	private buildBackendCacheKey(settings: BackendSettings, filters: BackendQueryFilters, startDayKey: string, endDayKey: string): string {
		return JSON.stringify({
			account: settings.storageAccount,
			table: settings.aggTable,
			datasetId: settings.datasetId,
			startDayKey,
			endDayKey,
			filters
		});
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
		const tableClient = this.dataPlaneService.createTableClient(settings, creds.tableCredential);
		const allEntities = await this.dataPlaneService.listEntitiesForRange({
			tableClient: tableClient as any,
			datasetId: settings.datasetId,
			startDayKey,
			endDayKey
		});
		const modelsSet = new Set<string>();
		const workspacesSet = new Set<string>();
		const machinesSet = new Set<string>();
		const usersSet = new Set<string>();
		const workspaceNamesById: Record<string, string> = {};
		const machineNamesById: Record<string, string> = {};

		let totalTokens = 0;
		let totalInteractions = 0;
		const modelUsage: ModelUsage = {};
		const workspaceTokens = new Map<string, number>();
		const machineTokens = new Map<string, number>();

		for (const entity of allEntities) {
			const model = (entity.model ?? '').toString();
			const workspaceId = (entity.workspaceId ?? '').toString();
			const workspaceName = typeof (entity as any).workspaceName === 'string' ? (entity as any).workspaceName.trim() : '';
			const machineId = (entity.machineId ?? '').toString();
			const machineName = typeof (entity as any).machineName === 'string' ? (entity as any).machineName.trim() : '';
			const userId = (entity.userId ?? '').toString();
			const inputTokens = Number.isFinite(Number(entity.inputTokens)) ? Number(entity.inputTokens) : 0;
			const outputTokens = Number.isFinite(Number(entity.outputTokens)) ? Number(entity.outputTokens) : 0;
			const interactions = Number.isFinite(Number(entity.interactions)) ? Number(entity.interactions) : 0;

			if (!model || !workspaceId || !machineId) {
				continue;
			}

			modelsSet.add(model);
			workspacesSet.add(workspaceId);
			machinesSet.add(machineId);
			if (userId) {
				usersSet.add(userId);
			}
			if (workspaceName && !workspaceNamesById[workspaceId]) {
				workspaceNamesById[workspaceId] = workspaceName;
			}
			if (machineName && !machineNamesById[machineId]) {
				machineNamesById[machineId] = machineName;
			}

			if (filters.model && filters.model !== model) {
				continue;
			}
			if (filters.workspaceId && filters.workspaceId !== workspaceId) {
				continue;
			}
			if (filters.machineId && filters.machineId !== machineId) {
				continue;
			}
			if (filters.userId && filters.userId !== userId) {
				continue;
			}

			const tokens = inputTokens + outputTokens;
			totalTokens += tokens;
			totalInteractions += interactions;

			if (!modelUsage[model]) {
				modelUsage[model] = { inputTokens: 0, outputTokens: 0 };
			}
			modelUsage[model].inputTokens += inputTokens;
			modelUsage[model].outputTokens += outputTokens;

			workspaceTokens.set(workspaceId, (workspaceTokens.get(workspaceId) ?? 0) + tokens);
			machineTokens.set(machineId, (machineTokens.get(machineId) ?? 0) + tokens);
		}

		const cost = this.deps.calculateEstimatedCost(modelUsage);
		const co2 = (totalTokens / 1000) * this.deps.co2Per1kTokens;
		const waterUsage = (totalTokens / 1000) * this.deps.waterUsagePer1kTokens;

		const statsForRange: any = {
			tokens: totalTokens,
			sessions: totalInteractions, // best-effort: backend store is interaction-focused
			avgInteractionsPerSession: totalInteractions > 0 ? 1 : 0,
			avgTokensPerSession: totalInteractions > 0 ? Math.round(totalTokens / totalInteractions) : 0,
			modelUsage,
			editorUsage: {},
			co2,
			treesEquivalent: co2 / this.deps.co2AbsorptionPerTreePerYear,
			waterUsage,
			estimatedCost: cost
		};

		const result: BackendQueryResultLike = {
			stats: {
				today: statsForRange,
				month: statsForRange,
				lastUpdated: new Date()
			},
			availableModels: Array.from(modelsSet).sort(),
			availableWorkspaces: Array.from(workspacesSet).sort(),
			availableMachines: Array.from(machinesSet).sort(),
			availableUsers: Array.from(usersSet).sort(),
			workspaceNamesById: Object.keys(workspaceNamesById).length ? workspaceNamesById : undefined,
			machineNamesById: Object.keys(machineNamesById).length ? machineNamesById : undefined,
			workspaceTokenTotals: Array.from(workspaceTokens.entries())
				.map(([workspaceId, tokens]) => ({ workspaceId, tokens }))
				.sort((a, b) => b.tokens - a.tokens)
				.slice(0, MAX_UI_LIST_ITEMS),
			machineTokenTotals: Array.from(machineTokens.entries())
				.map(([machineId, tokens]) => ({ machineId, tokens }))
				.sort((a, b) => b.tokens - a.tokens)
				.slice(0, MAX_UI_LIST_ITEMS)
		};

		this.backendLastQueryResult = result;
		this.backendLastQueryCacheKey = cacheKey;
		this.backendLastQueryCacheAt = Date.now();
		return result;
	}

	/**
	 * Try to get backend detailed stats for status bar.
	 */
	async tryGetBackendDetailedStatsForStatusBar(settings: BackendSettings, isConfigured: boolean, sharingPolicy: { allowCloudSync: boolean }): Promise<any | undefined> {
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
		} catch (e: any) {
			this.deps.warn(`Backend query failed: ${e?.message ?? e}`);
			return undefined;
		}
	}

	/**
	 * Get stats for details panel.
	 */
	async getStatsForDetailsPanel(settings: BackendSettings, isConfigured: boolean, sharingPolicy: { allowCloudSync: boolean }): Promise<any | undefined> {
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
		} catch (e: any) {
			this.deps.warn(`Backend query failed: ${e?.message ?? e}`);
			return undefined;
		}
	}
}
