/**
 * Credential service for backend facade.
 * Handles authentication and secret management for Azure resources.
 */

import * as vscode from 'vscode';
import { DefaultAzureCredential } from '@azure/identity';
import { AzureNamedKeyCredential } from '@azure/core-auth';
import type { TokenCredential } from '@azure/core-auth';
import { StorageSharedKeyCredential } from '@azure/storage-blob';
import type { BackendSettings } from '../settings';
import { shouldPromptToSetSharedKey } from '../settings';

/**
 * CredentialService manages authentication credentials for Azure backend resources.
 */
export class CredentialService {
	constructor(private context: vscode.ExtensionContext | undefined) {}

	/**
	 * Create a DefaultAzureCredential for Azure resource access.
	 * Uses local dev sign-in (Azure CLI, VS Code, env vars, managed identity) without requiring secrets.
	 */
	createAzureCredential(): DefaultAzureCredential {
		return new DefaultAzureCredential({});
	}

	/**
	 * Get the secret storage key for a storage account's shared key.
	 */
	private getSharedKeySecretStorageKey(storageAccount: string): string {
		return `copilotTokenTracker.backend.storageSharedKey:${storageAccount}`;
	}

	/**
	 * Get the stored storage shared key for a storage account.
	 */
	async getStoredStorageSharedKey(storageAccount: string): Promise<string | undefined> {
		if (!storageAccount) {
			return undefined;
		}
		return (await this.context?.secrets.get(this.getSharedKeySecretStorageKey(storageAccount))) ?? undefined;
	}

	/**
	 * Store a storage shared key securely in VS Code SecretStorage.
	 */
	async setStoredStorageSharedKey(storageAccount: string, sharedKey: string): Promise<void> {
		if (!this.context?.secrets) {
			throw new Error('SecretStorage is unavailable in this VS Code session.');
		}
		await this.context.secrets.store(this.getSharedKeySecretStorageKey(storageAccount), sharedKey);
	}

	/**
	 * Clear the stored storage shared key for a storage account.
	 */
	async clearStoredStorageSharedKey(storageAccount: string): Promise<void> {
		if (!this.context?.secrets) {
			throw new Error('SecretStorage is unavailable in this VS Code session.');
		}
		await this.context.secrets.delete(this.getSharedKeySecretStorageKey(storageAccount));
	}

	/**
	 * Prompt the user to enter and store a storage shared key.
	 */
	private async promptForAndStoreSharedKey(storageAccount: string, promptTitle: string): Promise<boolean> {
		if (!storageAccount) {
			vscode.window.showErrorMessage('Backend storage account is not configured yet. Run "Configure Backend" first.');
			return false;
		}
		const sharedKey = await vscode.window.showInputBox({
			title: promptTitle,
			prompt: `Enter the Storage account Shared Key for '${storageAccount}'. This will be stored securely in VS Code SecretStorage and will not sync across devices.`,
			password: true,
			ignoreFocusOut: true,
			validateInput: (v) => (v && v.trim() ? undefined : 'Shared Key is required')
		});
		if (!sharedKey) {
			return false;
		}
		await this.setStoredStorageSharedKey(storageAccount, sharedKey);
		return true;
	}

	/**
	 * Ensure storage shared key is available, prompting the user if necessary.
	 */
	private async ensureStorageSharedKeyAvailableOrPrompt(settings: BackendSettings): Promise<{ sharedKey: string; secretsToRedact: string[] } | undefined> {
		const storageAccount = settings.storageAccount;
		const existing = await this.getStoredStorageSharedKey(storageAccount);
		if (!shouldPromptToSetSharedKey(settings.authMode, storageAccount, existing)) {
			if (!existing) {
				return undefined;
			}
			return { sharedKey: existing, secretsToRedact: [existing] };
		}

		const pick = await vscode.window.showWarningMessage(
			'Backend sync is set to use Storage Shared Key auth, but no key is set on this machine.',
			{ modal: false },
			'Set Shared Key',
			'Cancel'
		);
		if (pick !== 'Set Shared Key') {
			return undefined;
		}

		const stored = await this.promptForAndStoreSharedKey(storageAccount, 'Set Storage Shared Key for Backend Sync');
		if (!stored) {
			return undefined;
		}
		const sharedKey = await this.getStoredStorageSharedKey(storageAccount);
		if (!sharedKey) {
			return undefined;
		}
		return { sharedKey, secretsToRedact: [sharedKey] };
	}

	/**
	 * Get backend data plane credentials (for Table and Blob storage).
	 */
	async getBackendDataPlaneCredentials(settings: BackendSettings): Promise<{
		tableCredential: TokenCredential | AzureNamedKeyCredential;
		blobCredential: TokenCredential | StorageSharedKeyCredential;
		secretsToRedact: string[];
	} | undefined> {
		if (settings.authMode === 'entraId') {
			const credential = this.createAzureCredential();
			return {
				tableCredential: credential,
				blobCredential: credential,
				secretsToRedact: []
			};
		}

		const shared = await this.ensureStorageSharedKeyAvailableOrPrompt(settings);
		if (!shared) {
			return undefined;
		}
		const tableCredential = new AzureNamedKeyCredential(settings.storageAccount, shared.sharedKey);
		const blobCredential = new StorageSharedKeyCredential(settings.storageAccount, shared.sharedKey);
		return {
			tableCredential,
			blobCredential,
			secretsToRedact: shared.secretsToRedact
		};
	}

	/**
	 * Get backend data plane credentials, throwing if unavailable.
	 */
	async getBackendDataPlaneCredentialsOrThrow(settings: BackendSettings): Promise<{
		tableCredential: TokenCredential | AzureNamedKeyCredential;
		blobCredential: TokenCredential | StorageSharedKeyCredential;
		secretsToRedact: string[];
	}> {
		const creds = await this.getBackendDataPlaneCredentials(settings);
		if (!creds) {
			throw new Error('Backend sync is configured to use Storage Shared Key auth, but the key is not set on this machine.');
		}
		return creds;
	}

	/**
	 * Get backend secrets that should be redacted from error messages.
	 */
	async getBackendSecretsToRedactForError(settings: BackendSettings): Promise<string[]> {
		try {
			if (settings.authMode !== 'sharedKey') {
				return [];
			}
			const sharedKey = await this.getStoredStorageSharedKey(settings.storageAccount);
			return sharedKey ? [sharedKey] : [];
		} catch {
			return [];
		}
	}
}
