/**
 * Azure Resource service for backend facade.
 * Handles Azure resource management wizard and sharing profile configuration.
 */

import * as vscode from 'vscode';
import { ResourceManagementClient } from '@azure/arm-resources';
import { StorageManagementClient } from '@azure/arm-storage';
import { SubscriptionClient } from '@azure/arm-subscriptions';
import { TableServiceClient } from '@azure/data-tables';
import { BlobServiceClient } from '@azure/storage-blob';
import { safeStringifyError, isAzurePolicyDisallowedError, isStorageLocalAuthDisallowedByPolicyError } from '../../utils/errors';
import type { BackendAuthMode, BackendSettings } from '../settings';
import { validateTeamAlias, type BackendUserIdentityMode } from '../identity';
import { CredentialService } from './credentialService';
import { DataPlaneService } from './dataPlaneService';

export interface AzureResourceServiceDeps {
	log: (message: string) => void;
	updateTokenStats?: () => Promise<void>;
	getSettings: () => BackendSettings;
	startTimerIfEnabled: () => void;
	syncToBackendStore: (force: boolean) => Promise<void>;
	clearQueryCache: () => void;
}

/**
 * AzureResourceService manages the backend configuration wizard and sharing profile settings.
 */
export class AzureResourceService {
	constructor(
		private deps: AzureResourceServiceDeps,
		private credentialService: CredentialService,
		private dataPlaneService: DataPlaneService
	) {}

	/**
	 * Configure backend wizard (MVP: Storage Tables only).
	 */
	async configureBackendWizard(): Promise<void> {
		const config = vscode.workspace.getConfiguration('copilotTokenTracker');
		const credential = this.credentialService.createAzureCredential();

		// Sanity check that we can get a token (common failure is "not logged in")
		try {
			await credential.getToken('https://management.azure.com/.default');
		} catch (e: any) {
			vscode.window.showErrorMessage(
				`Azure authentication failed. Sign in using Azure CLI (az login) or VS Code Azure Account, then retry. Details: ${e?.message ?? e}`
			);
			return;
		}

		// 1) Choose subscription
		const subscriptionClient = new SubscriptionClient(credential);
		const subs: Array<{ id: string; name: string }> = [];
		for await (const s of subscriptionClient.subscriptions.list()) {
			if (s.subscriptionId) {
				subs.push({ id: s.subscriptionId, name: s.displayName || s.subscriptionId });
			}
		}
		if (subs.length === 0) {
			vscode.window.showErrorMessage('No Azure subscriptions found for the current identity.');
			return;
		}
		const pickedSub = await vscode.window.showQuickPick(
			subs.map(s => ({ label: s.name, description: s.id, subscriptionId: s.id })),
			{ title: 'Select Azure subscription for backend sync' }
		);
		if (!pickedSub) {
			return;
		}
		const subscriptionId = pickedSub.subscriptionId;

		// 2) Choose or create resource group
		const resourceClient = new ResourceManagementClient(credential, subscriptionId);
		const rgNames: string[] = [];
		for await (const rg of resourceClient.resourceGroups.list()) {
			if (rg.name) {
				rgNames.push(rg.name);
			}
		}
		rgNames.sort();
		const rgPick = await vscode.window.showQuickPick(
			[
				{ label: '$(add) Create new resource group…', description: '' },
				...rgNames.map(name => ({ label: name, description: 'Existing resource group' }))
			],
			{ title: 'Select or create an Azure resource group' }
		);
		if (!rgPick) {
			return;
		}

		let resourceGroup = rgPick.label;
		let location = 'eastus';
		if (resourceGroup.includes('Create new resource group')) {
			const name = await vscode.window.showInputBox({
				title: 'New resource group name',
				placeHolder: 'e.g. copilot-token-tracker-rg',
				validateInput: (v) => (v && v.length >= 1 ? undefined : 'Resource group name is required')
			});
			if (!name) {
				return;
			}
			resourceGroup = name;

			const loc = await vscode.window.showQuickPick(
				['eastus', 'eastus2', 'westus2', 'westeurope', 'northeurope', 'uksouth', 'australiaeast', 'japaneast', 'southeastasia'],
				{ title: 'Resource group location' }
			);
			if (!loc) {
				return;
			}
			location = loc;

			try {
				await resourceClient.resourceGroups.createOrUpdate(resourceGroup, { location });
			} catch (e: any) {
				vscode.window.showErrorMessage(
					`Failed to create resource group. You may need 'Contributor' on the subscription or appropriate RG permissions. Details: ${e?.message ?? e}`
				);
				return;
			}
		} else {
			// Fetch location for existing RG
			try {
				const rg = await resourceClient.resourceGroups.get(resourceGroup);
				if (rg.location) {
					location = rg.location;
				}
			} catch (e) {
				// Use default location if fetch fails (non-critical)
				this.deps.log(`Could not fetch resource group location, using default: ${e}`);
			}
		}

		const authPick = await vscode.window.showQuickPick(
			[
				{
					label: 'Entra ID (RBAC)',
					description: 'Recommended: Use DefaultAzureCredential for Storage Tables/Blob (no secrets).',
					authMode: 'entraId' as BackendAuthMode,
					picked: true
				},
				{
					label: 'Storage Shared Key',
					description: 'Advanced: Use Storage account key (stored securely in VS Code SecretStorage on this machine only).',
					authMode: 'sharedKey' as BackendAuthMode
				}
			],
			{
				title: 'Select backend authentication mode',
				ignoreFocusOut: true,
				placeHolder: 'Entra ID (RBAC) is recommended for most users'
			}
		);
		if (!authPick) {
			return;
		}
		const authMode = authPick.authMode;

		// 3) Choose or create storage account
		const storageMgmt = new StorageManagementClient(credential, subscriptionId);
		const saNames: string[] = [];
		for await (const sa of storageMgmt.storageAccounts.listByResourceGroup(resourceGroup)) {
			if (sa.name) {
				saNames.push(sa.name);
			}
		}
		saNames.sort();
		const saPick = await vscode.window.showQuickPick(
			[
				{ label: '$(add) Create new storage account…', description: '' },
				...saNames.map(name => ({ label: name, description: 'Existing storage account' }))
			],
			{ title: 'Select or create a Storage account for backend sync' }
		);
		if (!saPick) {
			return;
		}

		const RESERVED_NAMES = ['microsoft', 'azure', 'windows', 'test', 'prod', 'admin'];
		
		let storageAccount = saPick.label;
		if (storageAccount.includes('Create new storage account')) {
			const name = await vscode.window.showInputBox({
				title: 'New storage account name',
				placeHolder: 'lowercase letters and numbers, 3-24 chars',
				validateInput: (v) => {
					if (!v) {
						return 'Storage account name is required';
					}
					const lower = v.toLowerCase();
					if (!/^[a-z0-9]{3,24}$/.test(lower)) {
						return 'Must be 3-24 chars, lowercase letters and numbers only';
					}
					if (RESERVED_NAMES.includes(lower)) {
						return `"${lower}" is a reserved name. Choose a different name.`;
					}
					return undefined;
				}
			});
			if (!name) {
				return;
			}
			storageAccount = name;

			const loc = await vscode.window.showQuickPick(
				[location, 'eastus', 'eastus2', 'westus2', 'westeurope', 'northeurope', 'uksouth', 'australiaeast', 'japaneast', 'southeastasia'],
				{ title: 'Storage account location' }
			);
			if (!loc) {
				return;
			}
			location = loc;

			const createStorageAccountParams = {
				location,
				sku: { name: 'Standard_LRS' },
				kind: 'StorageV2',
				enableHttpsTrafficOnly: true,
				minimumTlsVersion: 'TLS1_2',
				// Respect the chosen auth mode: disable Shared Key when Entra ID is selected.
				allowSharedKeyAccess: authMode === 'sharedKey',
				defaultToOAuthAuthentication: authMode === 'entraId',
				// Low-risk hardening: disallow public access to blobs/containers.
				allowBlobPublicAccess: false
			} as const;

			try {
				await storageMgmt.storageAccounts.beginCreateAndWait(resourceGroup, storageAccount, createStorageAccountParams as any);
			} catch (e: any) {
				if (isAzurePolicyDisallowedError(e) || isStorageLocalAuthDisallowedByPolicyError(e)) {
					const extra = isStorageLocalAuthDisallowedByPolicyError(e)
						? '\n\nThis policy typically requires disabling local authentication (Shared Key). Select Entra ID auth (Shared Key disabled) or create a storage account externally that meets your org policies.'
						: '';
					const choice = await vscode.window.showWarningMessage(
						`Storage account creation was blocked by Azure Policy (RequestDisallowedByPolicy).${extra}\n\nTo continue, select an existing compliant Storage account in this resource group (or create one externally that meets your org policies), then re-run the wizard if needed.`,
						{ modal: true },
						'Choose existing Storage account'
					);
					if (choice === 'Choose existing Storage account') {
						if (saNames.length === 0) {
							vscode.window.showErrorMessage(
								`No existing Storage accounts were found in resource group '${resourceGroup}'. Create one externally that complies with your org policies (including Shared Key disabled), then re-run the wizard.`
							);
							return;
						}
						const existingPick = await vscode.window.showQuickPick(
							saNames.map(name => ({ label: name, description: 'Existing storage account' })),
							{ title: 'Select an existing Storage account for backend sync' }
						);
						if (!existingPick) {
							return;
						}
						storageAccount = existingPick.label;
					} else {
						return;
					}
				} else {
					vscode.window.showErrorMessage(
						`Failed to create storage account. You may need 'Storage Account Contributor' (or 'Contributor') on the resource group. Details: ${e?.message ?? e}`
					);
					return;
				}
			}
		}

		// 4) Ensure tables exist (+ optional containers)
		const aggTable = await vscode.window.showInputBox({
			title: 'Aggregate rollup table name (required)',
			value: config.get<string>('backend.aggTable', 'usageAggDaily'),
			validateInput: (v) => (v ? undefined : 'Table name is required')
		});
		if (!aggTable) {
			return;
		}

		const createEvents = await vscode.window.showQuickPick(['No (MVP)', 'Yes (create usageEvents table)'], {
			title: 'Create optional usageEvents table?'
		});
		if (!createEvents) {
			return;
		}

		const createRaw = await vscode.window.showQuickPick(['No (MVP)', 'Yes (create raw blob container)'], {
			title: 'Create optional raw blob container?'
		});
		if (!createRaw) {
			return;
		}

		const datasetId = (await vscode.window.showInputBox({
			title: 'Dataset ID',
			value: config.get<string>('backend.datasetId', 'default')
		}))?.trim();
		if (!datasetId) {
			return;
		}
		const profilePick = await vscode.window.showQuickPick(
			[
				{
					label: 'Solo / Full Fidelity (personal dataset)',
					description: 'Uploads usage + raw workspace/machine IDs and names to your dataset.',
					profile: 'soloFull' as const
				},
				{
					label: 'Team / Anonymized (recommended)',
					description: 'Uploads usage with hashed workspace/machine IDs. No per-user identifier; no names.',
					profile: 'teamAnonymized' as const
				},
				{
					label: 'Team / Pseudonymous',
					description: 'Uploads usage + stable per-user key (derived from Entra claims). IDs hashed; no names by default.',
					profile: 'teamPseudonymous' as const
				},
				{
					label: 'Team / Identified (explicit)',
					description: 'Uploads usage + explicit identity (alias or Entra object ID). IDs hashed; no names by default.',
					profile: 'teamIdentified' as const
				}
			],
			{ title: 'Select Sharing Profile', ignoreFocusOut: true }
		);
		if (!profilePick) {
			return;
		}

		const sharingProfile = profilePick.profile;
		const shareWithTeam = sharingProfile === 'teamPseudonymous' || sharingProfile === 'teamIdentified';
		let shareConsentAt = '';
		let userIdentityMode = config.get<BackendUserIdentityMode>('backend.userIdentityMode', 'pseudonymous');
		let userId = '';
		let userIdMode: 'alias' | 'custom' = 'alias';
		let shareWorkspaceMachineNames = config.get<boolean>('backend.shareWorkspaceMachineNames', false);

		if (sharingProfile === 'soloFull') {
			// Personal dataset: include workspace/machine names by default.
			userId = '';
			userIdMode = 'alias';
			shareWorkspaceMachineNames = true;
		} else if (sharingProfile === 'teamAnonymized') {
			// Strongest team posture: no user identifier and no names.
			userId = '';
			userIdMode = 'alias';
			shareWorkspaceMachineNames = false;
		} else if (sharingProfile === 'teamPseudonymous') {
			shareConsentAt = new Date().toISOString();
			userIdentityMode = 'pseudonymous';
			if (authMode !== 'entraId') {
				vscode.window.showErrorMessage('Team / Pseudonymous requires Entra ID (RBAC) auth mode. Re-run the wizard and choose Entra ID.');
				return;
			}
			userId = '';
			userIdMode = 'alias';
			shareWorkspaceMachineNames = false;
		} else {
			// teamIdentified
			shareConsentAt = new Date().toISOString();
			const modePick = await vscode.window.showQuickPick(
				[
					{
						label: 'Team alias (recommended)',
						description: 'User-chosen handle like dev-01 (strictly validated; avoid real names/emails).',
						mode: 'teamAlias' as const
					},
					{
						label: 'Entra object ID (advanced)',
						description: 'Stores a GUID that uniquely identifies you (sensitive).',
						mode: 'entraObjectId' as const
					}
				],
				{ title: 'User identity mode (Team / Identified)', ignoreFocusOut: true }
			);
			if (!modePick) {
				return;
			}
			userIdentityMode = modePick.mode;

			if (userIdentityMode === 'teamAlias') {
				const userIdInput = await vscode.window.showInputBox({
					title: 'Team alias',
					prompt: 'Enter a short, non-PII alias (lowercase letters/digits/dash only). Do not use email or real names.',
					value: config.get<string>('backend.userId', ''),
					placeHolder: 'e.g. dev-01',
					ignoreFocusOut: true,
					validateInput: (v) => {
						const res = validateTeamAlias(v);
						return res.valid ? undefined : res.error;
					}
				});
				if (userIdInput === undefined) {
					return;
				}
				userId = userIdInput.trim();
				userIdMode = 'alias';
			} else {
				const objectIdInput = await vscode.window.showInputBox({
					title: 'Entra object ID (GUID)',
					prompt: 'Enter your Entra object ID (GUID). WARNING: uniquely identifies you. Only enable if your team requires it.',
					value: config.get<string>('backend.userId', ''),
					placeHolder: '00000000-0000-0000-0000-000000000000',
					ignoreFocusOut: true,
					validateInput: (v) => {
						const trimmed = (v ?? '').trim();
						return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(trimmed)
							? undefined
							: 'Must be a GUID (Entra object ID).';
					}
				});
				if (objectIdInput === undefined) {
					return;
				}
				userId = objectIdInput.trim();
				userIdMode = 'custom';
			}
			shareWorkspaceMachineNames = false;
		}

		if (sharingProfile === 'teamPseudonymous' || sharingProfile === 'teamIdentified') {
			const namesPick = await vscode.window.showQuickPick(
				[
					{
						label: 'No (recommended)',
						description: 'Keep workspace/machine names private; store only opaque IDs.',
						shareNames: false as const
					},
					{
						label: 'Yes (store workspace & machine names)',
						description: 'May contain sensitive info (project names, hostname).',
						shareNames: true as const
					}
				],
				{ title: 'Also store workspace and machine names?', ignoreFocusOut: true }
			);
			if (!namesPick) {
				return;
			}
			shareWorkspaceMachineNames = namesPick.shareNames;
		}

		// Save config now (so subsequent calls have correct values)
		await config.update('backend.subscriptionId', subscriptionId, vscode.ConfigurationTarget.Global);
		await config.update('backend.resourceGroup', resourceGroup, vscode.ConfigurationTarget.Global);
		await config.update('backend.storageAccount', storageAccount, vscode.ConfigurationTarget.Global);
		await config.update('backend.aggTable', aggTable, vscode.ConfigurationTarget.Global);
		await config.update('backend.datasetId', datasetId, vscode.ConfigurationTarget.Global);
		await config.update('backend.sharingProfile', sharingProfile, vscode.ConfigurationTarget.Global);
		await config.update('backend.userId', userId, vscode.ConfigurationTarget.Global);
		await config.update('backend.userIdMode', userIdMode, vscode.ConfigurationTarget.Global);
		await config.update('backend.shareWithTeam', shareWithTeam, vscode.ConfigurationTarget.Global);
		await config.update('backend.shareWorkspaceMachineNames', shareWorkspaceMachineNames, vscode.ConfigurationTarget.Global);
		await config.update('backend.shareConsentAt', shareConsentAt, vscode.ConfigurationTarget.Global);
		await config.update('backend.userIdentityMode', userIdentityMode, vscode.ConfigurationTarget.Global);
		await config.update('backend.authMode', authMode, vscode.ConfigurationTarget.Global);
		await config.update('backend.enabled', true, vscode.ConfigurationTarget.Global);

		const finalSettings = this.deps.getSettings();
		try {
			const creds = await this.credentialService.getBackendDataPlaneCredentials(finalSettings);
			if (!creds) {
				vscode.window.showWarningMessage(
					'Backend sync was configured, but Storage Shared Key is not set on this machine yet. Backend sync will fall back to local stats until you set the key.'
				);
				this.deps.startTimerIfEnabled();
				await this.deps.updateTokenStats?.();
				return;
			}
			await this.dataPlaneService.ensureTableExists(finalSettings, creds.tableCredential);
			await this.dataPlaneService.validateAccess(finalSettings, creds.tableCredential);
		} catch (e: any) {
			vscode.window.showErrorMessage(`Backend sync configured, but access validation failed: ${safeStringifyError(e)}`);
			return;
		}

		if (createEvents.startsWith('Yes')) {
			try {
				const creds = await this.credentialService.getBackendDataPlaneCredentials(finalSettings);
				if (!creds) {
					// User chose sharedKey but no key. Skip optional resources.
				} else {
					const endpoint = `https://${finalSettings.storageAccount}.table.core.windows.net`;
					const serviceClient = new TableServiceClient(endpoint, creds.tableCredential as any);
					await serviceClient.createTable(finalSettings.eventsTable);
					this.deps.log(`Created optional events table: ${finalSettings.eventsTable}`);
				}
			} catch (e) {
				this.deps.log(`Optional events table creation failed (non-blocking): ${safeStringifyError(e)}`);
			}
		}
		if (createRaw.startsWith('Yes')) {
			try {
				const creds = await this.credentialService.getBackendDataPlaneCredentials(finalSettings);
				if (!creds) {
					// User chose sharedKey but no key. Skip optional resources.
				} else {
					const endpoint = this.dataPlaneService.getStorageBlobEndpoint(finalSettings.storageAccount);
					const blobClient = new BlobServiceClient(endpoint, creds.blobCredential as any);
					const containerClient = blobClient.getContainerClient(finalSettings.rawContainer);
					await containerClient.createIfNotExists();
				}
			} catch (e) {
				this.deps.log(`Optional raw container creation failed (non-blocking): ${safeStringifyError(e)}`);
			}
		}

		this.deps.startTimerIfEnabled();
		await this.deps.syncToBackendStore(true);
		await this.deps.updateTokenStats?.();
		vscode.window.showInformationMessage('Backend sync configured. Initial sync completed (or queued).');
	}

	/**
	 * Set sharing profile command.
	 */
	async setSharingProfileCommand(): Promise<void> {
		const config = vscode.workspace.getConfiguration('copilotTokenTracker');
		const currentSettings = this.deps.getSettings();
		const currentProfile = currentSettings.sharingProfile;

		// Present profile options with "what leaves the machine" summary
		const profileOptions = [
			{
				label: 'Off',
				description: 'No cloud sync. Local-only stats.',
				detail: 'Nothing leaves this machine.',
				profile: 'off' as const,
				sharingLevel: 0
			},
			{
				label: 'Team / Anonymized',
				description: 'Recommended for teams. Usage + hashed IDs; no user key, no names.',
				detail: 'What leaves: day keys, model IDs, token counts, hashed workspace/machine IDs.',
				profile: 'teamAnonymized' as const,
				sharingLevel: 1
			},
			{
				label: 'Team / Pseudonymous',
				description: 'Usage + stable per-user key (Entra-derived); hashed IDs; no names by default.',
				detail: 'What leaves: same as Anonymized + a stable user key (reversible only within this dataset).',
				profile: 'teamPseudonymous' as const,
				sharingLevel: 2
			},
			{
				label: 'Team / Identified',
				description: 'Explicit identity (alias/Entra OID); hashed IDs; no names by default.',
				detail: 'What leaves: same as Pseudonymous + explicit user identifier (visible to dataset viewers).',
				profile: 'teamIdentified' as const,
				sharingLevel: 3
			},
			{
				label: 'Solo / Full Fidelity',
				description: 'Personal dataset. Raw IDs + names.',
				detail: 'What leaves: usage + raw workspace/machine IDs + workspace/machine names.',
				profile: 'soloFull' as const,
				sharingLevel: 4
			}
		];

		const currentLevelIndex = profileOptions.findIndex(p => p.profile === currentProfile);
		const currentLevel = currentLevelIndex >= 0 ? profileOptions[currentLevelIndex].sharingLevel : 0;

		const picked = await vscode.window.showQuickPick(profileOptions, {
			title: 'Set Sharing Profile',
			placeHolder: `Current: ${currentProfile}`,
			ignoreFocusOut: true
		});

		if (!picked) {
			return;
		}

		const newProfile = picked.profile;

		// If transitioning to a more permissive profile (higher sharing level), require explicit confirmation
		if (picked.sharingLevel > currentLevel) {
			const confirmMsg = [
				`⚠️  You are enabling ${picked.label}.`,
				'',
				picked.detail,
				'',
				'Team datasets may be visible to others with dataset access.',
				'',
				'Do you want to proceed?'
			].join('\\n');

			const confirm = await vscode.window.showWarningMessage(
				confirmMsg,
				{ modal: true },
				'Yes, Enable'
			);

			if (confirm !== 'Yes, Enable') {
				return;
			}
		}

		const existingUserId = config.get<string>('backend.userId', '');
		const existingUserIdMode = config.get<'alias' | 'custom'>('backend.userIdMode', 'alias');
		const existingIdentityMode = config.get<'pseudonymous' | 'teamAlias' | 'entraObjectId'>('backend.userIdentityMode', 'pseudonymous');

		// Set profile-specific defaults
		let shareWithTeam = false;
		let shareWorkspaceMachineNames = false;
		let userId: string = existingUserId;
		let userIdMode: 'alias' | 'custom' = existingUserIdMode;
		let userIdentityMode: 'pseudonymous' | 'teamAlias' | 'entraObjectId' = existingIdentityMode;
		let shareConsentAt = '';

		if (newProfile === 'off') {
			// No cloud sync
			shareWithTeam = false;
			shareWorkspaceMachineNames = false;
			userId = '';
			userIdMode = 'alias';
			userIdentityMode = 'pseudonymous';
			shareConsentAt = '';
		} else if (newProfile === 'soloFull') {
			shareWithTeam = false;
			shareWorkspaceMachineNames = true;
			userId = '';
			userIdMode = 'alias';
			userIdentityMode = 'pseudonymous';
			shareConsentAt = '';
		} else if (newProfile === 'teamAnonymized') {
			shareWithTeam = false;
			shareWorkspaceMachineNames = false;
			userId = '';
			userIdMode = 'alias';
			userIdentityMode = 'pseudonymous';
			shareConsentAt = '';
		} else if (newProfile === 'teamPseudonymous') {
			shareWithTeam = true;
			shareWorkspaceMachineNames = false;
			userIdentityMode = 'pseudonymous';
			shareConsentAt = new Date().toISOString();
			userId = '';
			userIdMode = 'alias';
		} else if (newProfile === 'teamIdentified') {
			shareWithTeam = true;
			shareWorkspaceMachineNames = false;
			// Keep existing userIdentityMode if already set
			const existingMode = config.get<'pseudonymous' | 'teamAlias' | 'entraObjectId'>('backend.userIdentityMode');
			if (existingMode === 'teamAlias' || existingMode === 'entraObjectId') {
				userIdentityMode = existingMode;
			} else {
				userIdentityMode = 'teamAlias';
			}
			shareConsentAt = new Date().toISOString();
		}

		// For team profiles with user dimension, optionally ask about names
		if ((newProfile === 'teamPseudonymous' || newProfile === 'teamIdentified') && picked.sharingLevel > currentLevel) {
			const namesPick = await vscode.window.showQuickPick(
				[
					{
						label: 'No (recommended)',
						description: 'Keep workspace/machine names private.',
						shareNames: false
					},
					{
						label: 'Yes',
						description: 'Also upload workspace/machine names (may contain project names, hostname).',
						shareNames: true
					}
				],
				{
					title: 'Also share workspace and machine names?',
					ignoreFocusOut: true
				}
			);
			if (namesPick) {
				shareWorkspaceMachineNames = namesPick.shareNames;
			}
		}

		// Save settings
		await config.update('backend.sharingProfile', newProfile, vscode.ConfigurationTarget.Global);
		await config.update('backend.shareWithTeam', shareWithTeam, vscode.ConfigurationTarget.Global);
		await config.update('backend.shareWorkspaceMachineNames', shareWorkspaceMachineNames, vscode.ConfigurationTarget.Global);
		await config.update('backend.userId', userId, vscode.ConfigurationTarget.Global);
		await config.update('backend.userIdMode', userIdMode, vscode.ConfigurationTarget.Global);
		await config.update('backend.userIdentityMode', userIdentityMode, vscode.ConfigurationTarget.Global);
		await config.update('backend.shareConsentAt', shareConsentAt, vscode.ConfigurationTarget.Global);

		// Clear facade cache to prevent showing old cached data with different privacy level
		this.deps.clearQueryCache();

		// If backend is enabled, restart timer and sync
		if (currentSettings.enabled) {
			this.deps.startTimerIfEnabled();
			await this.deps.syncToBackendStore(true);
		}

		vscode.window.showInformationMessage(`Sharing profile updated to: ${newProfile}`);
	}
}
