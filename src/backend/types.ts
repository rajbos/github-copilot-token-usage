/**
 * TypeScript type definitions for the backend module.
 */

/**
 * Session file cache entry (pre-computed session data).
 * This data is validated at runtime before use to prevent injection attacks.
 * Validation checks: structure, modelUsage object, numeric bounds on all fields.
 */
export interface SessionFileCache {
	tokens: number;
	interactions: number;
	modelUsage: ModelUsage;
	mtime: number;
}

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
	clearAzureSettingsCommand(): Promise<void>;
	toggleBackendWorkspaceMachineNameSync(): Promise<void>;
	setSharingProfileCommand(): Promise<void>;
}
