/**
 * Azure Storage Tables client and operations.
 * Handles interactions with Azure Tables for storing and querying daily rollup data.
 */

import { AZURE_TABLES_FORBIDDEN_CHARS, SCHEMA_VERSION_NO_USER, SCHEMA_VERSION_WITH_USER, SCHEMA_VERSION_WITH_USER_AND_CONSENT } from './constants';
import type { DailyRollupKey } from './rollups';
import type { BackendUserIdentityMode } from './identity';

/**
 * Interface for Azure TableClient-like objects.
 * Used for dependency injection and testing.
 */
export interface TableClientLike {
	listEntities(options?: any): AsyncIterableIterator<any>;
	upsertEntity(entity: any, mode?: 'Merge' | 'Replace'): Promise<any>;
	deleteEntity(partitionKey: string, rowKey: string): Promise<any>;
	createTable?(): Promise<any>;
}

/**
 * Daily aggregate entity structure (as stored in Azure Tables).
 */
export interface BackendAggDailyEntityLike {
	partitionKey: string;
	rowKey: string;
	schemaVersion?: number;
	datasetId?: string;
	day?: string;
	model?: string;
	workspaceId?: string;
	workspaceName?: string;
	machineId?: string;
	machineName?: string;
	userId?: string;
	userKeyType?: string;
	shareWithTeam?: boolean;
	consentAt?: string;
	inputTokens?: number;
	outputTokens?: number;
	interactions?: number;
	updatedAt?: string;
	
	// Fluency metrics (schema version 4+)
	askModeCount?: number;
	editModeCount?: number;
	agentModeCount?: number;
	planModeCount?: number;
	customAgentModeCount?: number;
	toolCallsJson?: string; // Serialized ToolCallUsage: { total, byTool: {...} }
	contextRefsJson?: string; // Serialized ContextReferenceUsage
	mcpToolsJson?: string; // Serialized McpToolUsage: { total, byServer, byTool }
	modelSwitchingJson?: string; // Serialized ModelSwitchingAnalysis
	repoCustomizationRate?: number; // 0-1 indicating % of repos with customization
	multiTurnSessions?: number;
	avgTurnsPerSession?: number;
	multiFileEdits?: number;
	avgFilesPerEdit?: number;
	codeBlockApplyRate?: number;
	sessionCount?: number; // Number of unique sessions for this rollup
}

/**
 * Sanitizes a string for use in Azure Tables PartitionKey or RowKey.
 * Replaces forbidden characters: / \ # ?
 * @param value - The string to sanitize
 * @returns Sanitized string safe for Azure Tables keys
 */
export function sanitizeTableKey(value: string): string {
	if (!value) {
		return value;
	}
	let result = value;
	for (const char of AZURE_TABLES_FORBIDDEN_CHARS) {
		result = result.replace(new RegExp(`\\${char}`, 'g'), '_');
	}
	// Also replace control characters (0x00-0x1F, 0x7F-0x9F)
	result = result.replace(/[\x00-\x1F\x7F-\x9F]/g, '_');
	return result;
}

/**
 * Builds the partition key for aggregate daily entities.
 * Format: ds:{datasetId}|d:{YYYY-MM-DD}
 * @param datasetId - The dataset identifier
 * @param dayKey - The day in YYYY-MM-DD format
 * @returns Sanitized partition key
 */
export function buildAggPartitionKey(datasetId: string, dayKey: string): string {
	const raw = `ds:${datasetId}|d:${dayKey}`;
	return sanitizeTableKey(raw);
}

/**
 * Builds the row key for aggregate daily entities.
 * This is a stable hash of the rollup dimensions.
 * @param key - The daily rollup key (model, workspace, machine, userId)
 * @returns Sanitized row key
 */
export function stableDailyRollupRowKey(key: DailyRollupKey): string {
	// Create a stable, readable row key from dimensions
	const userId = (key.userId ?? '').trim();
	const parts = [
		`m:${key.model}`,
		`w:${key.workspaceId}`,
		`mc:${key.machineId}`
	];
	if (userId) {
		parts.push(`u:${userId}`);
	}
	const raw = parts.join('|');
	return sanitizeTableKey(raw);
}

const ALLOWED_FIELDS = ['PartitionKey', 'RowKey', 'model', 'workspaceId', 'machineId', 'userId'];

/**
 * Builds an OData filter expression for Azure Tables queries.
 * @param field - The field name
 * @param value - The value to filter by
 * @returns OData filter string
 */
export function buildOdataEqFilter(field: string, value: string): string {
	if (!ALLOWED_FIELDS.includes(field)) {
		throw new Error(`Invalid filter field: ${field}`);
	}
	// Escape single quotes in value
	const escaped = value.replace(/'/g, "''");
	return `${field} eq '${escaped}'`;
}

/**
 * Lists all daily aggregate entities from a table partition.
 * @param args - Arguments including tableClient, partitionKey, and defaultDayKey
 * @returns Array of entities
 */
export async function listAggDailyEntitiesFromTableClient(args: {
	tableClient: TableClientLike;
	partitionKey: string;
	defaultDayKey: string;
	logger?: Pick<Console, 'error'>;
}): Promise<BackendAggDailyEntityLike[]> {
	const { tableClient, partitionKey, defaultDayKey } = args;
	const logger = args.logger ?? console;
	const results: BackendAggDailyEntityLike[] = [];

	try {
		const queryOptions = {
			queryOptions: {
				filter: buildOdataEqFilter('PartitionKey', partitionKey)
			}
		};

		for await (const entity of tableClient.listEntities(queryOptions)) {
			const dayString = entity.day?.toString() || defaultDayKey;
			
			if (!entity.model || !entity.workspaceId || !entity.machineId) {
				logger.error(`Skipping entity with missing required fields: ${entity.rowKey}`);
				continue;
			}

			const inputTokens = typeof entity.inputTokens === 'number' ? Math.max(0, entity.inputTokens) : 0;
			const outputTokens = typeof entity.outputTokens === 'number' ? Math.max(0, entity.outputTokens) : 0;
			const interactions = typeof entity.interactions === 'number' ? Math.max(0, entity.interactions) : 0;
			const userId = entity.userId?.toString()?.trim() || undefined;

			// Normalize entity to our interface
			const normalized: BackendAggDailyEntityLike = {
				partitionKey: entity.partitionKey?.toString() || partitionKey,
				rowKey: entity.rowKey?.toString() || '',
				schemaVersion: typeof entity.schemaVersion === 'number' ? entity.schemaVersion : undefined,
				datasetId: entity.datasetId?.toString() || '',
				day: dayString,
				model: entity.model.toString(),
				workspaceId: entity.workspaceId.toString(),
				workspaceName: typeof entity.workspaceName === 'string' && entity.workspaceName.trim() ? entity.workspaceName.trim() : undefined,
				machineId: entity.machineId.toString(),
				machineName: typeof entity.machineName === 'string' && entity.machineName.trim() ? entity.machineName.trim() : undefined,
				userId,
				userKeyType: entity.userKeyType?.toString() || undefined,
				shareWithTeam: typeof entity.shareWithTeam === 'boolean' ? entity.shareWithTeam : undefined,
				consentAt: entity.consentAt?.toString() || undefined,
				inputTokens,
				outputTokens,
				interactions,
				updatedAt: entity.updatedAt?.toString() || new Date().toISOString()
			};

			results.push(normalized);
		}
	} catch (error) {
		// Log error but don't throw - return empty array for graceful degradation
		logger.error(`Failed to list entities for partition ${partitionKey}:`, error);
	}

	return results;
}

/**
 * Creates a daily aggregate entity for upsert to Azure Tables.
 * @param args - Entity creation arguments
 * @returns Entity object ready for TableClient.upsertEntity()
 */
export function createDailyAggEntity(args: {
	datasetId: string;
	day: string;
	model: string;
	workspaceId: string;
	workspaceName?: string;
	machineId: string;
	machineName?: string;
	userId?: string;
	userKeyType?: BackendUserIdentityMode;
	shareWithTeam?: boolean;
	consentAt?: string;
	inputTokens: number;
	outputTokens: number;
	interactions: number;
	// Fluency metrics (optional)
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
}): any {
	const { datasetId, day, model, workspaceId, workspaceName, machineId, machineName, userId, userKeyType, shareWithTeam, consentAt, inputTokens, outputTokens, interactions, fluencyMetrics } = args;
	
	const effectiveUserId = (userId ?? '').trim();
	const key: DailyRollupKey = {
		day,
		model,
		workspaceId,
		machineId,
		userId: effectiveUserId || undefined
	};

	const partitionKey = buildAggPartitionKey(datasetId, day);
	const rowKey = stableDailyRollupRowKey(key);

	const hasFluencyMetrics = fluencyMetrics && Object.keys(fluencyMetrics).length > 0;
	const schemaVersion = hasFluencyMetrics
		? 4 // SCHEMA_VERSION_WITH_FLUENCY_METRICS
		: effectiveUserId && shareWithTeam
			? 3 // SCHEMA_VERSION_WITH_USER_AND_CONSENT
			: effectiveUserId
				? 2 // SCHEMA_VERSION_WITH_USER
				: 1; // SCHEMA_VERSION_NO_USER

	return {
		partitionKey,
		rowKey,
		schemaVersion,
		datasetId,
		day,
		model,
		workspaceId,
		...(workspaceName ? { workspaceName } : {}),
		machineId,
		...(machineName ? { machineName } : {}),
		...(effectiveUserId ? { userId: effectiveUserId } : {}),
		...(effectiveUserId && shareWithTeam ? { userKeyType, shareWithTeam: true, consentAt } : {}),
		inputTokens,
		outputTokens,
		interactions,
		updatedAt: new Date().toISOString(),
		// Add fluency metrics if provided
		...(fluencyMetrics?.askModeCount !== undefined ? { askModeCount: fluencyMetrics.askModeCount } : {}),
		...(fluencyMetrics?.editModeCount !== undefined ? { editModeCount: fluencyMetrics.editModeCount } : {}),
		...(fluencyMetrics?.agentModeCount !== undefined ? { agentModeCount: fluencyMetrics.agentModeCount } : {}),
		...(fluencyMetrics?.planModeCount !== undefined ? { planModeCount: fluencyMetrics.planModeCount } : {}),
		...(fluencyMetrics?.customAgentModeCount !== undefined ? { customAgentModeCount: fluencyMetrics.customAgentModeCount } : {}),
		...(fluencyMetrics?.toolCallsJson ? { toolCallsJson: fluencyMetrics.toolCallsJson } : {}),
		...(fluencyMetrics?.contextRefsJson ? { contextRefsJson: fluencyMetrics.contextRefsJson } : {}),
		...(fluencyMetrics?.mcpToolsJson ? { mcpToolsJson: fluencyMetrics.mcpToolsJson } : {}),
		...(fluencyMetrics?.modelSwitchingJson ? { modelSwitchingJson: fluencyMetrics.modelSwitchingJson } : {}),
		...(fluencyMetrics?.repoCustomizationRate !== undefined ? { repoCustomizationRate: fluencyMetrics.repoCustomizationRate } : {}),
		...(fluencyMetrics?.multiTurnSessions !== undefined ? { multiTurnSessions: fluencyMetrics.multiTurnSessions } : {}),
		...(fluencyMetrics?.avgTurnsPerSession !== undefined ? { avgTurnsPerSession: fluencyMetrics.avgTurnsPerSession } : {}),
		...(fluencyMetrics?.multiFileEdits !== undefined ? { multiFileEdits: fluencyMetrics.multiFileEdits } : {}),
		...(fluencyMetrics?.avgFilesPerEdit !== undefined ? { avgFilesPerEdit: fluencyMetrics.avgFilesPerEdit } : {}),
		...(fluencyMetrics?.codeBlockApplyRate !== undefined ? { codeBlockApplyRate: fluencyMetrics.codeBlockApplyRate } : {}),
		...(fluencyMetrics?.sessionCount !== undefined ? { sessionCount: fluencyMetrics.sessionCount } : {})
	};
}
