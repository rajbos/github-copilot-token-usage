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

/**
 * DataPlaneService manages Azure Table Storage clients and operations.
 */
export class DataPlaneService {
	constructor(
		private utility: typeof BackendUtility,
		private log: (message: string) => void,
		private getSecretsToRedact: (settings: BackendSettings) => Promise<string[]>
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
	 */
	createTableClient(settings: BackendSettings, credential: TokenCredential | AzureNamedKeyCredential): TableClient {
		return new TableClient(this.getStorageTableEndpoint(settings.storageAccount), settings.aggTable, credential as any);
	}

	/**
	 * Ensure the aggregate table exists, creating it if necessary.
	 */
	async ensureTableExists(settings: BackendSettings, credential: TokenCredential | AzureNamedKeyCredential): Promise<void> {
		const serviceClient = new TableServiceClient(this.getStorageTableEndpoint(settings.storageAccount), credential as any);
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
	 */
	async validateAccess(settings: BackendSettings, credential: TokenCredential | AzureNamedKeyCredential): Promise<void> {
		// Probe read/write access without requiring secrets.
		const tableClient = this.createTableClient(settings, credential);
		const probeEntity = {
			partitionKey: buildAggPartitionKey(settings.datasetId, 'rbac-probe'),
			rowKey: this.utility.sanitizeTableKey(`probe:${vscode.env.machineId}`),
			type: 'rbacProbe',
			updatedAt: new Date().toISOString()
		};
		try {
			await tableClient.upsertEntity(probeEntity as any, 'Replace');
			await tableClient.deleteEntity((probeEntity as any).partitionKey, (probeEntity as any).rowKey);
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
}
