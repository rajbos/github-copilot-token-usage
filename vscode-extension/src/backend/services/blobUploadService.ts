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
import { BlobServiceClient, ContainerClient, StorageSharedKeyCredential } from '@azure/storage-blob';
import { safeStringifyError, isAuthError } from '../../../../src/utils/errors';
import { getAzureBlobStorageEndpoint } from '../../utils/azureEndpoints';
import { withoutLeakedFatalHandlers } from '../../utils/processHandlerGuard';

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
export interface UploadStatus {
	lastUploadTime: number; // Timestamp in ms
	filesUploaded: number;
	lastError?: string;
}

/**
 * Interface for the blob upload service, enabling DI and testability.
 */
export interface IBlobUploadService {
	uploadSessionFiles(
		storageAccount: string,
		settings: BlobUploadSettings,
		credential: TokenCredential | StorageSharedKeyCredential,
		sessionFiles: string[],
		machineId: string,
		datasetId: string,
		editorTypeByFile?: Map<string, string>
	): Promise<{ success: boolean; filesUploaded: number; message: string }>;
	shouldUpload(machineId: string, settings: BlobUploadSettings): boolean;
	getUploadStatus(machineId: string): UploadStatus | undefined;
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
	 * Create a BlobServiceClient for the storage account.
	 */
	private createBlobServiceClient(
		storageAccount: string,
		credential: TokenCredential | StorageSharedKeyCredential
	): BlobServiceClient {
		return new BlobServiceClient(
			getAzureBlobStorageEndpoint(storageAccount),
			credential
		);
	}

	/**
	 * Get or create a container client for log file uploads.
	 */
	async getContainerClient(
		storageAccount: string,
		containerName: string,
		credential: TokenCredential | StorageSharedKeyCredential
	): Promise<ContainerClient> {
		const blobServiceClient = this.createBlobServiceClient(storageAccount, credential);
		const containerClient = blobServiceClient.getContainerClient(containerName);
		
		// Ensure container exists
		try {
			await containerClient.createIfNotExists({
				access: undefined // Private access by default (no public access)
			});
			this.log(`Blob upload: container '${containerName}' ready`);
		} catch (error: unknown) {
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
		credential: TokenCredential | StorageSharedKeyCredential,
		sessionFiles: string[],
		machineId: string,
		datasetId: string,
		editorTypeByFile?: Map<string, string>
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

			const containerClient = await this.getContainerClient(storageAccount, settings.containerName, credential);
			// The Azure SDK's Emscripten CRC64 module installs rethrowing process-global
			// crash handlers on first use, which would make any other extension's stray
			// rejection fatal for the whole shared extension host (issue #2137).
			const result = await withoutLeakedFatalHandlers(
				() => this.uploadAllFiles(containerClient, sessionFiles, machineId, datasetId, settings.compressFiles, credential, editorTypeByFile),
				({ removed, kept }) => this.warn(
					`Blob upload: removed ${removed} rethrowing process-global crash handler(s) installed during upload`
					+ (kept > 0 ? `; left ${kept} other newly-added handler(s) in place` : '')
				)
			);

			if (result.earlyReturn) { return result.earlyReturn; }

			const { filesUploaded, errors } = result;
			if (filesUploaded > 0) {
				this.uploadStatus.set(machineId, {
					lastUploadTime: Date.now(),
					filesUploaded,
					lastError: errors.length > 0 ? errors.join('; ') : undefined
				});
				this.saveUploadStatus();
			}

			const message = errors.length > 0
				? `Uploaded ${filesUploaded}/${sessionFiles.length} files (${errors.length} errors)`
				: `Successfully uploaded ${filesUploaded} files`;

			this.log(`Blob upload: ${message}`);
			return { success: errors.length === 0, filesUploaded, message };
		} catch (error: unknown) {
			const errorMsg = safeStringifyError(error);
			this.warn(`Blob upload: failed: ${errorMsg}`);
			return { success: false, filesUploaded: 0, message: `Upload failed: ${errorMsg}` };
		}
	}

	private async uploadAllFiles(
		containerClient: ContainerClient,
		sessionFiles: string[],
		machineId: string,
		datasetId: string,
		compress: boolean,
		credential: TokenCredential | StorageSharedKeyCredential,
		editorTypeByFile?: Map<string, string>
	): Promise<{ filesUploaded: number; errors: string[]; earlyReturn?: { success: boolean; filesUploaded: number; message: string } }> {
		let filesUploaded = 0;
		const errors: string[] = [];
		for (const sessionFile of sessionFiles) {
			try {
				const editorType = editorTypeByFile?.get(sessionFile);
				await this.uploadFile(containerClient, sessionFile, machineId, datasetId, compress, editorType);
				filesUploaded++;
			} catch (error: unknown) {
				const fileName = path.basename(sessionFile);
				const errorMsg = safeStringifyError(error);
				if (isAuthError(error)) {
					const isEntraId = !('accountName' in credential);
					const hint = isEntraId
						? 'Your Entra ID identity needs the "Storage Blob Data Contributor" role on this storage account. '
						  + 'Note: the Portal Storage Browser may use Access Keys, which bypass RBAC — '
						  + 'that is different from the data plane Entra ID access the extension uses. '
						  + 'Assign the role via: az role assignment create --assignee <your-id> --role "Storage Blob Data Contributor" --scope <storage-account-resource-id>'
						: 'The storage shared key may not have blob write permission. Check that shared key access (allowSharedKeyAccess) is enabled on the storage account.';
					this.warn(`Blob upload: authorization failed for ${fileName}. ${hint}`);
					return { filesUploaded, errors, earlyReturn: { success: false, filesUploaded, message: `Authorization failed: ${hint}` } };
				}
				errors.push(`${fileName}: ${errorMsg}`);
				this.warn(`Blob upload: failed to upload ${fileName}: ${errorMsg}`);
			}
		}
		return { filesUploaded, errors };
	}

	/**
	 * Upload a single file to blob storage.
	 */
	private async uploadFile(
		containerClient: ContainerClient,
		sessionFilePath: string,
		machineId: string,
		datasetId: string,
		compress: boolean,
		editorType?: string
	): Promise<void> {
		const fileName = path.basename(sessionFilePath);
		// Open once and stat/read the same file handle (not the path) so the
		// file can't change between the mtime check and the read (TOCTOU race).
		const handle = await fs.promises.open(sessionFilePath, 'r');
		let content: Buffer;
		let mtime: string;
		try {
			const stats = await handle.stat();
			mtime = stats.mtime.toISOString().replace(/[:.]/g, '-');
			content = await handle.readFile();
		} finally {
			await handle.close();
		}

		// Create blob path: dataset/machine/YYYY-MM-DD/filename
		const blobName = `${datasetId}/${machineId}/${mtime.substring(0, 10)}/${fileName}${compress ? '.gz' : ''}`;
		const blockBlobClient = containerClient.getBlockBlobClient(blobName);

		// Compress if enabled
		const uploadContent = compress ? await gzip(content) : content;
		
		// Upload to blob storage
		await blockBlobClient.upload(uploadContent, uploadContent.length, {
			blobHTTPHeaders: {
				blobContentType: compress ? 'application/gzip' : 'application/json'
			},
			metadata: {
				originalFileName: fileName,
				machineId: machineId, // Full machine ID (Azure metadata supports up to 8KB)
				datasetId: datasetId,
				uploadedAt: new Date().toISOString(),
				compressed: compress.toString(),
				...(editorType ? { editorType } : {})
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
				// Discard entries where no files were actually uploaded (stale from failed attempts)
				const valid = Object.entries(stored).filter(([, s]) => s.filesUploaded > 0);
				this.uploadStatus = new Map(valid);
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
