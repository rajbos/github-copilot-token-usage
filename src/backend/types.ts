/**
 * TypeScript type definitions for the backend module.
 */

/**
 * Model usage statistics (tokens per model).
 */
export interface ModelUsage {
	[model: string]: {
		inputTokens: number;
		outputTokens: number;
	};
}

/**
 * Daily rollup value (aggregated stats for a day).
 */
export interface DailyRollupValue {
	inputTokens: number;
	outputTokens: number;
	interactions: number;
}

/**
 * Storage entity for daily aggregates.
 * This is the shape stored in Azure Tables.
 */
export interface BackendAggDailyEntity {
	partitionKey: string;
	rowKey: string;
	schemaVersion: 1 | 2 | 3;
	datasetId: string;
	day: string;
	model: string;
	workspaceId: string;
	workspaceName?: string;
	machineId: string;
	machineName?: string;
	userId?: string;
	userKeyType?: 'pseudonymous' | 'teamAlias' | 'entraObjectId';
	shareWithTeam?: boolean;
	consentAt?: string;
	inputTokens: number;
	outputTokens: number;
	interactions: number;
	updatedAt: string;
}

/**
 * Query result from the backend.
 */
export interface BackendQueryResult {
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

/**
 * Session statistics.
 */
export interface SessionStats {
	today: StatsForPeriod;
	month: StatsForPeriod;
	lastUpdated: Date;
}

/**
 * Stats for a specific time period.
 */
export interface StatsForPeriod {
	tokens: number;
	sessions: number;
	avgInteractionsPerSession: number;
	avgTokensPerSession: number;
	modelUsage: ModelUsage;
	editorUsage: EditorUsage;
	co2: number;
	treesEquivalent: number;
	waterUsage: number;
	estimatedCost: number;
}

/**
 * Editor usage statistics.
 */
export interface EditorUsage {
	[editorType: string]: {
		tokens: number;
		sessions: number;
	};
}

/**
 * Chat request interface for Copilot session files.
 */
export interface ChatRequest {
	timestamp?: number | string;
	message?: {
		parts?: Array<{ text?: string }>;
	};
	response?: Array<{ value?: string }>;
	model?: string;
	[key: string]: unknown;
}

/**
 * Backend facade interface (for dependency injection).
 */
export interface BackendFacadeInterface {
	getSettings(): unknown;
	isConfigured(settings: unknown): boolean;
	getStatsForDetailsPanel(): Promise<SessionStats | undefined>;
	tryGetBackendDetailedStatsForStatusBar(settings: unknown): Promise<SessionStats | undefined>;
	setFilters(filters: unknown): void;
	getFilters(): unknown;
	getLastQueryResult(): BackendQueryResult | undefined;
	syncToBackendStore(force: boolean): Promise<void>;
	startTimerIfEnabled(): void;
	stopTimer(): void;
	dispose(): void;
	configureBackendWizard(): Promise<void>;
	setBackendSharedKey(): Promise<void>;
	rotateBackendSharedKey(): Promise<void>;
	clearBackendSharedKey(): Promise<void>;
	toggleBackendWorkspaceMachineNameSync(): Promise<void>;
	setSharingProfileCommand(): Promise<void>;
}
