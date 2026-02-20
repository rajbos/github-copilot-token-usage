/**
 * Data plane service for backend facade.
 * Handles Table/Blob client creation, validation, and entity queries.
 */

import * as vscode from 'vscode';
import { AzureNamedKeyCredential } from '@azure/core-auth';
import type { TokenCredential } from '@azure/core-auth';
import { TableClient, TableServiceClient } from '@azure/data-tables';
import { withErrorHandling } from '../../utils/errors';
import type { BackendAggDailyEntityLike, TableClientLike } from '../storageTables';
import { buildAggPartitionKey, listAggDailyEntitiesFromTableClient } from '../storageTables';
import type { BackendSettings } from '../settings';
import { BackendUtility } from './utilityService';
import { AZURE_SDK_QUERY_TIMEOUT_MS } from '../constants';

/**
 * Wraps a promise with a timeout to prevent indefinite hangs.
 * @param promise - The promise to wrap
 * @param timeoutMs - Timeout in milliseconds
 * @param operation - Description of the operation for error messages
 * @returns Promise that rejects if timeout is exceeded
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
	let timeoutHandle: NodeJS.Timeout | undefined;
	return Promise.race([
		promise.finally(() => {
			if (timeoutHandle) {
				clearTimeout(timeoutHandle);
			}
		}),
		new Promise<never>((_, reject) => {
			timeoutHandle = setTimeout(
				() => reject(new Error(`${operation} timed out after ${timeoutMs}ms`)),
				timeoutMs
			);
		})
	]);
}

/**
 * DataPlaneService manages Azure Table Storage clients and operations.
 */
export class DataPlaneService {
	constructor(
		private readonly utility: typeof BackendUtility,
		private readonly log: (message: string) => void,
		private readonly getSecretsToRedact: (settings: BackendSettings) => Promise<string[]>
	) {}

	/**
	 * Get the Azure Table Storage endpoint for a storage account.
	 */
	private getStorageTableEndpoint(storageAccount: string): string {
		return `https://${storageAccount}.table.core.windows.net`;
	}

	/**
	 * Get the Azure Blob Storage endpoint for a storage account.
	 */
	getStorageBlobEndpoint(storageAccount: string): string {
		return `https://${storageAccount}.blob.core.windows.net`;
	}

	/**
	 * Create a TableClient for the backend aggregate table.
	 * @param settings - Backend settings with storage account and table names
	 * @param credential - Azure credential (TokenCredential or AzureNamedKeyCredential)
	 * @returns TableClient instance for the aggregate table
	 */
	createTableClient(settings: BackendSettings, credential: TokenCredential | AzureNamedKeyCredential): TableClient {
		return new TableClient(
			this.getStorageTableEndpoint(settings.storageAccount),
			settings.aggTable,
			credential as TokenCredential
		);
	}

	/**
	 * Ensure the aggregate table exists, creating it if necessary.
	 * @param settings - Backend settings with table name
	 * @param credential - Azure credential for table operations
	 * @throws Error if table creation fails (except for 409 Already Exists)
	 */
	async ensureTableExists(settings: BackendSettings, credential: TokenCredential | AzureNamedKeyCredential): Promise<void> {
		const serviceClient = new TableServiceClient(
			this.getStorageTableEndpoint(settings.storageAccount),
			credential as TokenCredential
		);
		await withErrorHandling(
			async () => {
				try {
					await serviceClient.createTable(settings.aggTable);
					this.log(`Backend sync: created table ${settings.aggTable}`);
				} catch (e: any) {
					// 409 = already exists
					const status = e?.statusCode ?? e?.code;
					if (status === 409 || e?.code === 'TableAlreadyExists') {
						this.log(`Backend sync: table ${settings.aggTable} already exists (OK)`);
						return;
					}
					throw e;
				}
			},
			'Failed to create aggregate table',
			await this.getSecretsToRedact(settings)
		);
	}

	/**
	 * Validate that we have read/write access to the backend table.
	 * @param settings - Backend settings for the table
	 * @param credential - Azure credential to test
	 * @throws Error if validation fails or permissions are missing
	 */
	async validateAccess(settings: BackendSettings, credential: TokenCredential | AzureNamedKeyCredential): Promise<void> {
		// Probe read/write access without requiring secrets.
		const tableClient = this.createTableClient(settings, credential);
		const probeEntity: { partitionKey: string; rowKey: string; type: string; updatedAt: string } = {
			partitionKey: buildAggPartitionKey(settings.datasetId, 'rbac-probe'),
			rowKey: this.utility.sanitizeTableKey(`probe:${vscode.env.machineId}`),
			type: 'rbacProbe',
			updatedAt: new Date().toISOString()
		};
		try {
			await withTimeout(
				tableClient.upsertEntity(probeEntity, 'Replace'),
				AZURE_SDK_QUERY_TIMEOUT_MS,
				'Table entity upsert'
			);
			await withTimeout(
				tableClient.deleteEntity(probeEntity.partitionKey, probeEntity.rowKey),
				AZURE_SDK_QUERY_TIMEOUT_MS,
				'Table entity delete'
			);
		} catch (e: any) {
			const status = e?.statusCode;
			if (status === 403) {
				throw new Error(
					`Missing Azure RBAC data-plane permissions for Tables. Assign 'Storage Table Data Contributor' (read/write) or 'Storage Table Data Reader' (read-only) on the Storage account or table service.`
				);
			}
			throw e;
		}
	}

	/**
	 * List aggregate entities for a date range.
	 * @param args - Query arguments with table client, dataset ID, and date range
	 * @returns Array of aggregate entities for the specified date range
	 */
	async listEntitiesForRange(args: {
		tableClient: TableClientLike;
		datasetId: string;
		startDayKey: string;
		endDayKey: string;
	}): Promise<BackendAggDailyEntityLike[]> {
		const { tableClient, datasetId, startDayKey, endDayKey } = args;
		const dayKeys = this.utility.getDayKeysInclusive(startDayKey, endDayKey);
		const all: BackendAggDailyEntityLike[] = [];
		for (const dayKey of dayKeys) {
			const partitionKey = buildAggPartitionKey(datasetId, dayKey);
			const entitiesForDay = await listAggDailyEntitiesFromTableClient({
				tableClient,
				partitionKey,
				defaultDayKey: dayKey
			});
			all.push(...entitiesForDay);
		}
		return all;
	}

	/**
	 * List entities for a date range across ALL datasets.
	 * @param args - Table client and date range
	 * @returns Array of daily aggregate entities from all datasets
	 */
	async listAllEntitiesForRange(args: {
		tableClient: TableClientLike;
		startDayKey: string;
		endDayKey: string;
	}): Promise<BackendAggDailyEntityLike[]> {
		const { tableClient, startDayKey, endDayKey } = args;
		
		// Query all entities in the date range without filtering by dataset
		// Filter by timestamp to limit the scan
		const startDate = new Date(startDayKey);
		const endDate = new Date(endDayKey);
		endDate.setUTCHours(23, 59, 59, 999); // End of day
		
		const filter = `Timestamp ge datetime'${startDate.toISOString()}' and Timestamp le datetime'${endDate.toISOString()}'`;
		
		this.log(`Querying all datasets for date range ${startDayKey} to ${endDayKey}`);
		
		const entities: BackendAggDailyEntityLike[] = [];
		const iterator = tableClient.listEntities({ queryOptions: { filter } });
		
		for await (const entity of iterator) {
			const pk = entity.partitionKey;
			const rk = entity.rowKey;
			
			// Extract day from partition key (format: datasetId|day)
			const pkParts = (pk ?? '').toString().split('|');
			const day = pkParts.length === 2 ? pkParts[1] : '';
			const datasetId = pkParts[0] ?? '';
			
			// Parse RowKey: model|workspaceId|machineId|userId
			const rkParts = (rk ?? '').toString().split('|');
			const model = rkParts[0] ?? '';
			const workspaceId = rkParts[1] ?? '';
			const machineId = rkParts[2] ?? '';
			const userId = rkParts[3] ?? '';
			
			entities.push({
				partitionKey: (pk ?? '').toString(),
				rowKey: (rk ?? '').toString(),
				datasetId,
				day,
				model,
				workspaceId,
				machineId,
				userId,
				inputTokens: entity.inputTokens,
				outputTokens: entity.outputTokens,
				interactions: entity.interactions,
				workspaceName: entity.workspaceName,
				machineName: entity.machineName
			});
		}
		
		this.log(`Found ${entities.length} entities across all datasets`);
		return entities;
	}

	/**
	 * Upsert entities in batches with retry logic for improved reliability.
	 * 
	 * @param tableClient - The table client to use
	 * @param entities - Array of entities to upsert
	 * @returns Object with success count and errors
	 */
	async upsertEntitiesBatch(
		tableClient: TableClientLike,
		entities: any[]
	): Promise<{ successCount: number; errors: Array<{ entity: any; error: Error }> }> {
		let successCount = 0;
		const errors: Array<{ entity: any; error: Error }> = [];

		// Group entities by partition key for potential future batch optimization
		const byPartition = new Map<string, any[]>();
		for (const entity of entities) {
			const pk = entity.partitionKey;
			if (!byPartition.has(pk)) {
				byPartition.set(pk, []);
			}
			byPartition.get(pk)!.push(entity);
		}

		// Upsert entities with retry logic
		for (const [partition, partitionEntities] of byPartition) {
			for (const entity of partitionEntities) {
				try {
					await this.upsertEntityWithRetry(tableClient, entity);
					successCount++;
				} catch (error) {
					errors.push({
						entity,
						error: error instanceof Error ? error : new Error(String(error))
					});
					this.log(`Failed to upsert entity in partition ${partition}: ${error}`);
				}
			}
		}

		return { successCount, errors };
	}

	/**
	 * Upsert a single entity with exponential backoff retry.
	 * 
	 * @param tableClient - The table client
	 * @param entity - Entity to upsert
	 * @param maxRetries - Maximum number of retries (default: 3)
	 */
	private async upsertEntityWithRetry(
		tableClient: TableClientLike,
		entity: any,
		maxRetries: number = 3
	): Promise<void> {
		let lastError: Error | undefined;
		
		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			try {
				await withTimeout(
					tableClient.upsertEntity(entity, 'Replace'),
					AZURE_SDK_QUERY_TIMEOUT_MS,
					'Table entity upsert'
				);
				return; // Success
			} catch (error: any) {
				lastError = error instanceof Error ? error : new Error(String(error));
				
				// Check if error is retryable (429 throttling, 503 unavailable)
				const statusCode = error?.statusCode ?? error?.code;
				const isRetryable = statusCode === 429 || statusCode === 503 || statusCode === 'ETIMEDOUT';
				
				if (!isRetryable || attempt === maxRetries) {
					throw lastError;
				}
				
				// Exponential backoff: 1s, 2s, 4s
				const delayMs = Math.pow(2, attempt) * 1000;
				this.log(`Retrying entity upsert after ${delayMs}ms (attempt ${attempt + 1}/${maxRetries})`);
				await new Promise(resolve => setTimeout(resolve, delayMs));
			}
		}
		
		throw lastError ?? new Error('Upsert failed after retries');
	}
}
