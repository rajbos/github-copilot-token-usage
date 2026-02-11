/**
 * Blob upload service for backend facade.
 * Handles uploading local Copilot session log files to Azure Blob Storage.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { promisify } from 'util';
import type { TokenCredential } from '@azure/core-auth';
import { AzureNamedKeyCredential } from '@azure/core-auth';
import { BlobServiceClient, ContainerClient } from '@azure/storage-blob';
import { safeStringifyError } from '../../utils/errors';

const gzip = promisify(zlib.gzip);

/**
 * Settings for blob upload functionality.
 */
export interface BlobUploadSettings {
	enabled: boolean;
	containerName: string;
	uploadFrequencyHours: number; // How often to upload (default: 24 hours)
	compressFiles: boolean; // Whether to gzip files before upload
}

/**
 * Upload status tracking per machine.
 */
interface UploadStatus {
	lastUploadTime: number; // Timestamp in ms
	filesUploaded: number;
	lastError?: string;
}

/**
 * BlobUploadService manages uploading session log files to Azure Blob Storage.
 */
export class BlobUploadService {
	private uploadStatus: Map<string, UploadStatus> = new Map();
	
	constructor(
		private readonly log: (message: string) => void,
		private readonly warn: (message: string) => void,
		private readonly context: vscode.ExtensionContext | undefined
	) {
		// Load previous upload status from global state
		this.loadUploadStatus();
	}

	/**
	 * Get the Azure Blob Storage endpoint for a storage account.
	 */
	private getStorageBlobEndpoint(storageAccount: string): string {
		return `https://${storageAccount}.blob.core.windows.net`;
	}

	/**
	 * Create a BlobServiceClient for the storage account.
	 */
	private createBlobServiceClient(
		storageAccount: string,
		credential: TokenCredential | AzureNamedKeyCredential
	): BlobServiceClient {
		return new BlobServiceClient(
			this.getStorageBlobEndpoint(storageAccount),
			credential as TokenCredential
		);
	}

	/**
	 * Get or create a container client for log file uploads.
	 */
	async getContainerClient(
		storageAccount: string,
		containerName: string,
		credential: TokenCredential | AzureNamedKeyCredential
	): Promise<ContainerClient> {
		const blobServiceClient = this.createBlobServiceClient(storageAccount, credential);
		const containerClient = blobServiceClient.getContainerClient(containerName);
		
		// Ensure container exists
		try {
			await containerClient.createIfNotExists({
				access: undefined // Private access by default (no public access)
			});
			this.log(`Blob upload: container '${containerName}' ready`);
		} catch (error: any) {
			this.warn(`Blob upload: failed to ensure container exists: ${safeStringifyError(error)}`);
			throw error;
		}
		
		return containerClient;
	}

	/**
	 * Check if it's time to upload based on the configured frequency.
	 */
	shouldUpload(machineId: string, settings: BlobUploadSettings): boolean {
		if (!settings.enabled) {
			return false;
		}

		const status = this.uploadStatus.get(machineId);
		if (!status) {
			return true; // First upload
		}

		const now = Date.now();
		const hoursSinceLastUpload = (now - status.lastUploadTime) / (1000 * 60 * 60);
		return hoursSinceLastUpload >= settings.uploadFrequencyHours;
	}

	/**
	 * Upload session log files to Azure Blob Storage.
	 */
	async uploadSessionFiles(
		storageAccount: string,
		settings: BlobUploadSettings,
		credential: TokenCredential | AzureNamedKeyCredential,
		sessionFiles: string[],
		machineId: string,
		datasetId: string
	): Promise<{ success: boolean; filesUploaded: number; message: string }> {
		try {
			if (!settings.enabled) {
				return { success: false, filesUploaded: 0, message: 'Blob upload disabled' };
			}

			if (!this.shouldUpload(machineId, settings)) {
				const status = this.uploadStatus.get(machineId);
				const hoursSince = status ? Math.round((Date.now() - status.lastUploadTime) / (1000 * 60 * 60)) : 0;
				return {
					success: true,
					filesUploaded: 0,
					message: `Upload skipped (last upload ${hoursSince}h ago, frequency: ${settings.uploadFrequencyHours}h)`
				};
			}

			const containerClient = await this.getContainerClient(
				storageAccount,
				settings.containerName,
				credential
			);

			let filesUploaded = 0;
			const errors: string[] = [];

			// Upload each session file
			for (const sessionFile of sessionFiles) {
				try {
					await this.uploadFile(
						containerClient,
						sessionFile,
						machineId,
						datasetId,
						settings.compressFiles
					);
					filesUploaded++;
				} catch (error: any) {
					const fileName = path.basename(sessionFile);
					const errorMsg = safeStringifyError(error);
					errors.push(`${fileName}: ${errorMsg}`);
					this.warn(`Blob upload: failed to upload ${fileName}: ${errorMsg}`);
				}
			}

			// Update upload status
			this.uploadStatus.set(machineId, {
				lastUploadTime: Date.now(),
				filesUploaded,
				lastError: errors.length > 0 ? errors.join('; ') : undefined
			});
			this.saveUploadStatus();

			const message = errors.length > 0
				? `Uploaded ${filesUploaded}/${sessionFiles.length} files (${errors.length} errors)`
				: `Successfully uploaded ${filesUploaded} files`;

			this.log(`Blob upload: ${message}`);
			return { success: errors.length === 0, filesUploaded, message };

		} catch (error: any) {
			const errorMsg = safeStringifyError(error);
			this.warn(`Blob upload: failed: ${errorMsg}`);
			
			// Update status with error
			this.uploadStatus.set(machineId, {
				lastUploadTime: Date.now(),
				filesUploaded: 0,
				lastError: errorMsg
			});
			this.saveUploadStatus();
			
			return { success: false, filesUploaded: 0, message: `Upload failed: ${errorMsg}` };
		}
	}

	/**
	 * Upload a single file to blob storage.
	 */
	private async uploadFile(
		containerClient: ContainerClient,
		sessionFilePath: string,
		machineId: string,
		datasetId: string,
		compress: boolean
	): Promise<void> {
		const fileName = path.basename(sessionFilePath);
		const stats = fs.statSync(sessionFilePath);
		const mtime = stats.mtime.toISOString().replace(/[:.]/g, '-');
		
		// Create blob path: dataset/machine/YYYY-MM-DD/filename
		const blobName = `${datasetId}/${machineId}/${mtime.substring(0, 10)}/${fileName}${compress ? '.gz' : ''}`;
		const blockBlobClient = containerClient.getBlockBlobClient(blobName);

		// Read file content
		const content = await fs.promises.readFile(sessionFilePath);
		
		// Compress if enabled
		const uploadContent = compress ? await gzip(content) : content;
		
		// Upload to blob storage
		await blockBlobClient.upload(uploadContent, uploadContent.length, {
			blobHTTPHeaders: {
				blobContentType: compress ? 'application/gzip' : 'application/json'
			},
			metadata: {
				originalFileName: fileName,
				machineId: machineId.substring(0, 16), // Truncate for metadata
				datasetId: datasetId,
				uploadedAt: new Date().toISOString(),
				compressed: compress.toString()
			}
		});
	}

	/**
	 * Get upload status for a machine.
	 */
	getUploadStatus(machineId: string): UploadStatus | undefined {
		return this.uploadStatus.get(machineId);
	}

	/**
	 * Load upload status from global state.
	 */
	private loadUploadStatus(): void {
		if (!this.context) {
			return;
		}

		try {
			const stored = this.context.globalState.get<Record<string, UploadStatus>>('blobUploadStatus');
			if (stored) {
				this.uploadStatus = new Map(Object.entries(stored));
				this.log(`Blob upload: loaded status for ${this.uploadStatus.size} machine(s)`);
			}
		} catch (error) {
			this.warn(`Blob upload: failed to load status: ${safeStringifyError(error)}`);
		}
	}

	/**
	 * Save upload status to global state.
	 */
	private saveUploadStatus(): void {
		if (!this.context) {
			return;
		}

		try {
			const toStore = Object.fromEntries(this.uploadStatus);
			this.context.globalState.update('blobUploadStatus', toStore);
		} catch (error) {
			this.warn(`Blob upload: failed to save status: ${safeStringifyError(error)}`);
		}
	}

	/**
	 * Clear upload status for testing/reset.
	 */
	clearUploadStatus(): void {
		this.uploadStatus.clear();
		if (this.context) {
			this.context.globalState.update('blobUploadStatus', undefined);
		}
	}
}
