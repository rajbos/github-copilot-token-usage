/**
 * Azure Resource service for backend facade.
 * Handles Azure resource management wizard and sharing profile configuration.
 */

import * as vscode from 'vscode';
import { ResourceManagementClient } from '@azure/arm-resources';
import { StorageManagementClient } from '@azure/arm-storage';
import { SubscriptionClient } from '@azure/arm-resources-subscriptions';
import { TableServiceClient } from '@azure/data-tables';
import { safeStringifyError, isAzurePolicyDisallowedError, isStorageLocalAuthDisallowedByPolicyError } from '../../utils/errors';
import type { BackendAuthMode, BackendSettings } from '../settings';
import { validateTeamAlias, type BackendUserIdentityMode } from '../identity';
import { CredentialService } from './credentialService';
import { DataPlaneService } from './dataPlaneService';

interface ResourceGroupResult {
	resourceGroup: string;
	location: string;
}

interface TableConfig {
	aggTable: string;
	createEvents: string;
	datasetId: string;
}

interface SharingProfileResult {
	sharingProfile: 'soloFull' | 'teamAnonymized' | 'teamPseudonymous' | 'teamIdentified';
	shareWithTeam: boolean;
	shareConsentAt: string;
	userIdentityMode: BackendUserIdentityMode;
	userId: string;
	userIdMode: 'alias' | 'custom';
	shareWorkspaceMachineNames: boolean;
}

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
		const config = vscode.workspace.getConfiguration('aiEngineeringFluency');
		const credential = this.credentialService.createAzureCredential();

		if (!await this._verifyAzureAuth(credential)) { return; }

		const subscriptionId = await this._pickSubscription(credential);
		if (!subscriptionId) { return; }

		const rgResult = await this._pickOrCreateResourceGroup(credential, subscriptionId);
		if (!rgResult) { return; }

		const authMode = await this._pickAuthMode();
		if (!authMode) { return; }

		const storageAccount = await this._pickOrCreateStorageAccount(
			credential, subscriptionId, rgResult.resourceGroup, rgResult.location, authMode
		);
		if (!storageAccount) { return; }

		const tableConfig = await this._configureTableSettings(config);
		if (!tableConfig) { return; }

		const profile = await this._configureSharingProfile(config, authMode);
		if (!profile) { return; }

		await this._saveConfigAndActivate(config, subscriptionId, rgResult, storageAccount, tableConfig, authMode, profile);
	}

	private async _verifyAzureAuth(credential: any): Promise<boolean> {
		try {
			await credential.getToken('https://management.azure.com/.default');
			return true;
		} catch (e: any) {
			vscode.window.showErrorMessage(
				`Azure authentication failed. Sign in using Azure CLI (az login) or VS Code Azure Account, then retry. Details: ${e?.message ?? e}`
			);
			return false;
		}
	}

	private async _pickSubscription(credential: any): Promise<string | null> {
		const subscriptionClient = new SubscriptionClient(credential);
		const subs: Array<{ id: string; name: string }> = [];
		for await (const s of subscriptionClient.subscriptions.list()) {
			if (s.subscriptionId) {
				subs.push({ id: s.subscriptionId, name: s.displayName || s.subscriptionId });
			}
		}
		if (subs.length === 0) {
			vscode.window.showErrorMessage('No Azure subscriptions found for the current identity.');
			return null;
		}
		const pickedSub = await vscode.window.showQuickPick(
			subs.map(s => ({ label: s.name, description: s.id, subscriptionId: s.id })),
			{ title: 'Step 1 of 7: Select Azure Subscription' }
		);
		return pickedSub?.subscriptionId ?? null;
	}

	private async _pickOrCreateResourceGroup(credential: any, subscriptionId: string): Promise<ResourceGroupResult | null> {
		const resourceClient = new ResourceManagementClient(credential, subscriptionId);
		const rgNames: string[] = [];
		for await (const rg of resourceClient.resourceGroups.list()) {
			if (rg.name) { rgNames.push(rg.name); }
		}
		rgNames.sort();
		const rgPick = await vscode.window.showQuickPick(
			[
				{ label: '$(add) Create new resource group…', description: '' },
				...rgNames.map(name => ({ label: name, description: 'Existing resource group' }))
			],
			{ title: 'Step 2 of 7: Choose Resource Group' }
		);
		if (!rgPick) { return null; }

		if (rgPick.label.includes('Create new resource group')) {
			return this._createNewResourceGroup(resourceClient);
		}

		// Fetch location for existing RG
		let location = 'eastus';
		try {
			const rg = await resourceClient.resourceGroups.get(rgPick.label);
			if (rg.location) { location = rg.location; }
		} catch (e) {
			this.deps.log(`Could not fetch resource group location, using default: ${e}`);
		}
		return { resourceGroup: rgPick.label, location };
	}

	private async _createNewResourceGroup(resourceClient: ResourceManagementClient): Promise<ResourceGroupResult | null> {
		const name = await vscode.window.showInputBox({
			title: 'Step 3 of 7: New Resource Group Name',
			placeHolder: 'copilot-tokens-rg',
			validateInput: (v) => (v && v.length >= 1 ? undefined : 'Resource group name is required')
		});
		if (!name) { return null; }

		const loc = await vscode.window.showQuickPick(
			['eastus', 'eastus2', 'westus2', 'westeurope', 'northeurope', 'uksouth', 'australiaeast', 'japaneast', 'southeastasia'],
			{ title: 'Step 4 of 7: Choose Location for Resource Group' }
		);
		if (!loc) { return null; }

		try {
			await resourceClient.resourceGroups.createOrUpdate(name, { location: loc });
		} catch (e: any) {
			vscode.window.showErrorMessage(
				`Failed to create resource group. You may need 'Contributor' on the subscription or appropriate RG permissions. Details: ${e?.message ?? e}`
			);
			return null;
		}
		return { resourceGroup: name, location: loc };
	}

	private async _pickAuthMode(): Promise<BackendAuthMode | null> {
		const authPick = await vscode.window.showQuickPick(
			[
				{
					label: 'Entra ID (RBAC)',
					description: 'Recommended: Uses your identity, no secrets stored',
					authMode: 'entraId' as BackendAuthMode,
					picked: true
				},
				{
					label: 'Storage Shared Key',
					description: 'Advanced: Stored securely on this device only',
					authMode: 'sharedKey' as BackendAuthMode
				}
			],
			{ title: 'Step 5 of 7: Choose Authentication Mode', ignoreFocusOut: true, placeHolder: 'Entra ID recommended' }
		);
		return authPick?.authMode ?? null;
	}

	private async _pickOrCreateStorageAccount(
		credential: any,
		subscriptionId: string,
		resourceGroup: string,
		location: string,
		authMode: BackendAuthMode
	): Promise<string | null> {
		const storageMgmt = new StorageManagementClient(credential, subscriptionId);
		const saNames: string[] = [];
		for await (const sa of storageMgmt.storageAccounts.listByResourceGroup(resourceGroup)) {
			if (sa.name) { saNames.push(sa.name); }
		}
		saNames.sort();
		const saPick = await vscode.window.showQuickPick(
			[
				{ label: '$(add) Create new storage account…', description: '' },
				...saNames.map(name => ({ label: name, description: 'Existing storage account' }))
			],
			{ title: 'Step 6 of 7: Choose Storage Account' }
		);
		if (!saPick) { return null; }
		if (!saPick.label.includes('Create new storage account')) { return saPick.label; }

		const RESERVED_NAMES = ['microsoft', 'azure', 'windows', 'test', 'prod', 'admin'];
		const name = await vscode.window.showInputBox({
			title: 'Step 6 of 7: New Storage Account Name',
			placeHolder: 'copilottokensrg',
			validateInput: (v) => {
				if (!v) { return 'Storage account name is required'; }
				const lower = v.toLowerCase();
				if (!/^[a-z0-9]{3,24}$/.test(lower)) { return 'Must be 3-24 chars, lowercase letters and numbers only'; }
				if (RESERVED_NAMES.includes(lower)) { return `"${lower}" is a reserved name. Choose a different name.`; }
				return undefined;
			}
		});
		if (!name) { return null; }

		const loc = await vscode.window.showQuickPick(
			[location, 'eastus', 'eastus2', 'westus2', 'westeurope', 'northeurope', 'uksouth', 'australiaeast', 'japaneast', 'southeastasia'],
			{ title: 'Step 6 of 7: Choose Location for Storage Account' }
		);
		if (!loc) { return null; }

		const createStorageAccountParams = {
			location: loc,
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
			await storageMgmt.storageAccounts.beginCreateAndWait(resourceGroup, name, createStorageAccountParams as any);
			return name;
		} catch (e: any) {
			if (isAzurePolicyDisallowedError(e) || isStorageLocalAuthDisallowedByPolicyError(e)) {
				return this._handlePolicyBlockedStorageCreation(e, saNames, resourceGroup);
			}
			vscode.window.showErrorMessage(
				`Failed to create storage account. You may need 'Storage Account Contributor' (or 'Contributor') on the resource group. Details: ${e?.message ?? e}`
			);
			return null;
		}
	}

	private async _handlePolicyBlockedStorageCreation(e: any, saNames: string[], resourceGroup: string): Promise<string | null> {
		const extra = isStorageLocalAuthDisallowedByPolicyError(e)
			? '\n\nThis policy typically requires disabling local authentication (Shared Key). Select Entra ID auth (Shared Key disabled) or create a storage account externally that meets your org policies.'
			: '';
		const choice = await vscode.window.showWarningMessage(
			`Storage account creation was blocked by Azure Policy (RequestDisallowedByPolicy).${extra}\n\nTo continue, select an existing compliant Storage account in this resource group (or create one externally that meets your org policies), then re-run the wizard if needed.`,
			{ modal: true },
			'Choose existing Storage account'
		);
		if (choice !== 'Choose existing Storage account') { return null; }

		if (saNames.length === 0) {
			vscode.window.showErrorMessage(
				`No existing Storage accounts were found in resource group '${resourceGroup}'. Create one externally that complies with your org policies (including Shared Key disabled), then re-run the wizard.`
			);
			return null;
		}
		const existingPick = await vscode.window.showQuickPick(
			saNames.map(name => ({ label: name, description: 'Existing storage account' })),
			{ title: 'Select an existing Storage account for backend sync' }
		);
		return existingPick?.label ?? null;
	}

	private async _configureTableSettings(config: vscode.WorkspaceConfiguration): Promise<TableConfig | null> {
		const aggTable = await vscode.window.showInputBox({
			title: 'Aggregate Table Name',
			value: config.get<string>('backend.aggTable', 'usageAggDaily'),
			placeHolder: 'usageAggDaily',
			validateInput: (v) => (v ? undefined : 'Table name is required')
		});
		if (!aggTable) { return null; }

		const createEvents = await vscode.window.showQuickPick(
			['No (recommended)', 'Yes (create usageEvents table)'],
			{ title: 'Create Optional Events Table?', placeHolder: 'Most users should select No' }
		);
		if (!createEvents) { return null; }

		const datasetId = (await vscode.window.showInputBox({
			title: 'Step 6 of 7: Dataset ID',
			value: config.get<string>('backend.datasetId', 'default'),
			placeHolder: 'my-team-copilot'
		}))?.trim();
		if (!datasetId) { return null; }

		return { aggTable, createEvents, datasetId };
	}

	private async _configureSharingProfile(config: vscode.WorkspaceConfiguration, authMode: BackendAuthMode): Promise<SharingProfileResult | null> {
		const profilePick = await vscode.window.showQuickPick(
			[
				{ label: 'Solo / Full Fidelity (personal dataset)', description: 'Your private storage with real workspace and machine names', profile: 'soloFull' as const },
				{ label: 'Team / Anonymized (recommended)', description: 'Hashed IDs only, no user identifier, no workspace/machine names', profile: 'teamAnonymized' as const },
				{ label: 'Team / Pseudonymous', description: 'Derived user key (privacy-preserving hash), hashed IDs, no workspace/machine names by default', profile: 'teamPseudonymous' as const },
				{ label: 'Team / Identified (explicit)', description: 'Visible user identity (your alias or Entra ID), hashed IDs, no workspace/machine names by default', profile: 'teamIdentified' as const }
			],
			{ title: 'Step 7 of 7: Choose Sharing Profile', ignoreFocusOut: true }
		);
		if (!profilePick) { return null; }

		const sharingProfile = profilePick.profile;
		const shareWithTeam = sharingProfile === 'teamPseudonymous' || sharingProfile === 'teamIdentified';
		let shareConsentAt = '';
		let userIdentityMode = config.get<BackendUserIdentityMode>('backend.userIdentityMode', 'pseudonymous');
		let userId = '';
		let userIdMode: 'alias' | 'custom' = 'alias';
		let shareWorkspaceMachineNames: boolean;

		if (sharingProfile === 'soloFull') {
			shareWorkspaceMachineNames = true;
		} else if (sharingProfile === 'teamAnonymized') {
			shareWorkspaceMachineNames = false;
		} else if (sharingProfile === 'teamPseudonymous') {
			shareConsentAt = new Date().toISOString();
			userIdentityMode = 'pseudonymous';
			if (authMode !== 'entraId') {
				vscode.window.showErrorMessage('Team / Pseudonymous requires Entra ID (RBAC) auth mode. Re-run the wizard and choose Entra ID.');
				return null;
			}
			shareWorkspaceMachineNames = false;
		} else {
			// teamIdentified
			shareConsentAt = new Date().toISOString();
			const identityResult = await this._pickTeamIdentity(config);
			if (!identityResult) { return null; }
			userIdentityMode = identityResult.userIdentityMode;
			userId = identityResult.userId;
			userIdMode = identityResult.userIdMode;
			shareWorkspaceMachineNames = false;
		}

		if (sharingProfile === 'teamPseudonymous' || sharingProfile === 'teamIdentified') {
			const namesPick = await vscode.window.showQuickPick(
				[
					{ label: 'No (recommended)', description: 'Keep workspace/machine names private; store only opaque IDs.', shareNames: false as const },
					{ label: 'Yes (store workspace & machine names)', description: 'May contain sensitive info (project names, hostname).', shareNames: true as const }
				],
				{ title: 'Also store workspace and machine names?', ignoreFocusOut: true }
			);
			if (!namesPick) { return null; }
			shareWorkspaceMachineNames = namesPick.shareNames;
		}

		return { sharingProfile, shareWithTeam, shareConsentAt, userIdentityMode, userId, userIdMode, shareWorkspaceMachineNames };
	}

	private async _pickTeamIdentity(config: vscode.WorkspaceConfiguration): Promise<{ userIdentityMode: BackendUserIdentityMode; userId: string; userIdMode: 'alias' | 'custom' } | null> {
		const modePick = await vscode.window.showQuickPick(
			[
				{ label: 'Team alias (recommended)', description: 'Non-identifying handle like alex-dev', mode: 'teamAlias' as const },
				{ label: 'Entra object ID (advanced)', description: 'Unique GUID identifier (sensitive)', mode: 'entraObjectId' as const }
			],
			{ title: 'Step 7 of 7: Choose Identity Mode', ignoreFocusOut: true }
		);
		if (!modePick) { return null; }

		if (modePick.mode === 'teamAlias') {
			const userIdInput = await vscode.window.showInputBox({
				title: 'Step 7 of 7: Team Alias',
				prompt: 'Enter a short, non-PII alias (lowercase letters/digits/dash only). Do not use email or real names.',
				value: config.get<string>('backend.userId', ''),
				placeHolder: 'alex-dev',
				ignoreFocusOut: true,
				validateInput: (v) => { const res = validateTeamAlias(v); return res.valid ? undefined : res.error; }
			});
			if (userIdInput === undefined) { return null; }
			return { userIdentityMode: 'teamAlias', userId: userIdInput.trim(), userIdMode: 'alias' };
		} else {
			const objectIdInput = await vscode.window.showInputBox({
				title: 'Step 7 of 7: Entra Object ID',
				prompt: 'Enter your Entra object ID (GUID). WARNING: uniquely identifies you. Only enable if your team requires it.',
				value: config.get<string>('backend.userId', ''),
				placeHolder: '00000000-0000-0000-0000-000000000000',
				ignoreFocusOut: true,
				validateInput: (v) => {
					const trimmed = (v ?? '').trim();
					return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(trimmed)
						? undefined : 'Must be a GUID (Entra object ID).';
				}
			});
			if (objectIdInput === undefined) { return null; }
			return { userIdentityMode: 'entraObjectId', userId: objectIdInput.trim(), userIdMode: 'custom' };
		}
	}

	private async _saveConfigAndActivate(
		config: vscode.WorkspaceConfiguration,
		subscriptionId: string,
		rgResult: ResourceGroupResult,
		storageAccount: string,
		tableConfig: TableConfig,
		authMode: BackendAuthMode,
		profile: SharingProfileResult
	): Promise<void> {
		await config.update('backend.subscriptionId', subscriptionId, vscode.ConfigurationTarget.Global);
		await config.update('backend.resourceGroup', rgResult.resourceGroup, vscode.ConfigurationTarget.Global);
		await config.update('backend.storageAccount', storageAccount, vscode.ConfigurationTarget.Global);
		await config.update('backend.aggTable', tableConfig.aggTable, vscode.ConfigurationTarget.Global);
		await config.update('backend.datasetId', tableConfig.datasetId, vscode.ConfigurationTarget.Global);
		await config.update('backend.sharingProfile', profile.sharingProfile, vscode.ConfigurationTarget.Global);
		await config.update('backend.userId', profile.userId, vscode.ConfigurationTarget.Global);
		await config.update('backend.userIdMode', profile.userIdMode, vscode.ConfigurationTarget.Global);
		await config.update('backend.shareWithTeam', profile.shareWithTeam, vscode.ConfigurationTarget.Global);
		await config.update('backend.shareWorkspaceMachineNames', profile.shareWorkspaceMachineNames, vscode.ConfigurationTarget.Global);
		await config.update('backend.shareConsentAt', profile.shareConsentAt, vscode.ConfigurationTarget.Global);
		await config.update('backend.userIdentityMode', profile.userIdentityMode, vscode.ConfigurationTarget.Global);
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

		if (tableConfig.createEvents.startsWith('Yes')) {
			try {
				const creds = await this.credentialService.getBackendDataPlaneCredentials(finalSettings);
				if (creds) {
					const endpoint = `https://${finalSettings.storageAccount}.table.core.windows.net`;
					const serviceClient = new TableServiceClient(endpoint, creds.tableCredential as any);
					await serviceClient.createTable(finalSettings.eventsTable);
					this.deps.log(`Created optional events table: ${finalSettings.eventsTable}`);
				}
			} catch (e) {
				this.deps.log(`Optional events table creation failed (non-blocking): ${safeStringifyError(e)}`);
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
		const config = vscode.workspace.getConfiguration('aiEngineeringFluency');
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
				description: 'Recommended for teams. Usage + hashed IDs; no user key, no workspace/machine names.',
				detail: 'What leaves: day keys, model IDs, token counts, hashed workspace/machine IDs.',
				profile: 'teamAnonymized' as const,
				sharingLevel: 1
			},
			{
				label: 'Team / Pseudonymous',
				description: 'Usage + derived user key (privacy-preserving hash); hashed IDs; no workspace/machine names by default.',
				detail: 'What leaves: same as Anonymized + a stable user key (reversible only within this dataset).',
				profile: 'teamPseudonymous' as const,
				sharingLevel: 2
			},
			{
				label: 'Team / Identified',
				description: 'Usage + visible user identity (your alias or Entra ID); hashed IDs; no workspace/machine names by default.',
				detail: 'What leaves: same as Pseudonymous + explicit user identifier (visible to dataset viewers).',
				profile: 'teamIdentified' as const,
				sharingLevel: 3
			},
			{
				label: 'Solo / Full Fidelity',
				description: 'Personal dataset. Raw IDs + real workspace/machine names.',
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
