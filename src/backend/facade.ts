import * as vscode from 'vscode';

import { safeStringifyError } from '../utils/errors';
import type { BackendAggDailyEntityLike } from './storageTables';
import type { BackendQueryFilters, BackendSettings } from './settings';
import { getBackendSettings, isBackendConfigured } from './settings';
import type { SessionStats, ModelUsage, ChatRequest, SessionFileCache, DailyRollupValue } from './types';
import type { DailyRollupKey } from './rollups';
import { computeBackendSharingPolicy } from './sharingProfile';
import { CredentialService } from './services/credentialService';
import { AzureResourceService } from './services/azureResourceService';
import { DataPlaneService } from './services/dataPlaneService';
import { SyncService } from './services/syncService';
import { QueryService, type BackendQueryResultLike } from './services/queryService';
import { BackendUtility } from './services/utilityService';
import { BlobUploadService } from './services/blobUploadService';
import { BackendConfigPanel, type BackendConfigPanelState } from './configPanel';
import { applyDraftToSettings, getPrivacyBadge, needsConsent, toDraft, validateDraft, type BackendConfigDraft } from './configurationFlow';
import { ConfirmationMessages, SuccessMessages, ErrorMessages } from './ui/messages';

// Re-export BackendQueryResultLike for external consumers
export type { BackendQueryResultLike };

export interface BackendFacadeDeps {
	context: vscode.ExtensionContext | undefined;
	log: (message: string) => void;
	warn: (message: string) => void;
	updateTokenStats?: () => Promise<void>;
	calculateEstimatedCost: (modelUsage: ModelUsage) => number;
	co2Per1kTokens: number;
	waterUsagePer1kTokens: number;
	co2AbsorptionPerTreePerYear: number;

	getCopilotSessionFiles: () => Promise<string[]>;
	estimateTokensFromText: (text: string, model: string) => number;
	getModelFromRequest: (request: ChatRequest) => string;
	// Cache integration for performance
	getSessionFileDataCached?: (sessionFilePath: string, mtime: number, fileSize: number) => Promise<SessionFileCache>;
}

export class BackendFacade {
	private readonly deps: BackendFacadeDeps;
	private readonly credentialService: CredentialService;
	private readonly azureResourceService: AzureResourceService;
	private readonly dataPlaneService: DataPlaneService;
	private readonly syncService: SyncService;
	private readonly queryService: QueryService;
	private readonly blobUploadService: BlobUploadService;
	private configPanel: BackendConfigPanel | undefined;

	public constructor(deps: BackendFacadeDeps) {
		this.deps = deps;
		
		// Initialize services
		this.credentialService = new CredentialService(deps.context);
		this.blobUploadService = new BlobUploadService(
			deps.log,
			deps.warn,
			deps.context
		);
		this.dataPlaneService = new DataPlaneService(
			BackendUtility,
			deps.log,
			(settings) => this.credentialService.getBackendSecretsToRedactForError(settings)
		);
		this.queryService = new QueryService(
			{
				warn: deps.warn,
				calculateEstimatedCost: deps.calculateEstimatedCost,
				co2Per1kTokens: deps.co2Per1kTokens,
				waterUsagePer1kTokens: deps.waterUsagePer1kTokens,
				co2AbsorptionPerTreePerYear: deps.co2AbsorptionPerTreePerYear
			},
			this.credentialService,
			this.dataPlaneService,
			BackendUtility
		);
		this.syncService = new SyncService(
			{
				context: deps.context,
				log: deps.log,
				warn: deps.warn,
				getCopilotSessionFiles: deps.getCopilotSessionFiles,
				estimateTokensFromText: deps.estimateTokensFromText,
				getModelFromRequest: deps.getModelFromRequest,
				getSessionFileDataCached: deps.getSessionFileDataCached,
				updateTokenStats: deps.updateTokenStats
			},
			this.credentialService,
			this.dataPlaneService,
			this.blobUploadService,
			BackendUtility
		);
		this.azureResourceService = new AzureResourceService(
			{
				log: deps.log,
				updateTokenStats: deps.updateTokenStats,
				getSettings: () => this.getSettings(),
				startTimerIfEnabled: () => this.startTimerIfEnabled(),
				syncToBackendStore: (force) => this.syncToBackendStore(force),
				clearQueryCache: () => this.clearQueryCache()
			},
			this.credentialService,
			this.dataPlaneService
		);
	}

	public startTimerIfEnabled(): void {
		const settings = this.getSettings();
		this.syncService.startTimerIfEnabled(settings, this.isConfigured(settings));
		this.clearQueryCache();
	}

	public stopTimer(): void {
		this.syncService.stopTimer();
	}

	public clearQueryCache(): void {
		this.queryService.clearQueryCache();
	}

	public dispose(): void {
		this.syncService.dispose();
		this.configPanel?.dispose();
	}

	public getSettings(): BackendSettings {
		return getBackendSettings();
	}

	public isConfigured(settings: BackendSettings): boolean {
		return isBackendConfigured(settings);
	}

	public getFilters(): BackendQueryFilters {
		return this.queryService.getFilters();
	}

	public setFilters(filters: Partial<BackendQueryFilters>): void {
		this.queryService.setFilters(filters);
		// Clear query cache when filters change
		this.clearQueryCache();
	}

	public getLastQueryResult(): BackendQueryResultLike | undefined {
		return this.queryService.getLastQueryResult();
	}

	// Utility methods exposed for testing
	public extractWorkspaceIdFromSessionPath(sessionPath: string): string {
		return BackendUtility.extractWorkspaceIdFromSessionPath(sessionPath);
	}

	public sanitizeTableKey(value: string): string {
		return BackendUtility.sanitizeTableKey(value);
	}

	public addDaysUtc(dayKey: string, days: number): string {
		return BackendUtility.addDaysUtc(dayKey, days);
	}

	public getDayKeysInclusive(startDayKey: string, endDayKey: string): string[] {
		return BackendUtility.getDayKeysInclusive(startDayKey, endDayKey);
	}

	public get syncQueue(): Promise<void> {
		return this.syncService.getSyncQueue();
	}

	// Cache state exposed for testing via QueryService accessors
	public get backendLastQueryResult(): BackendQueryResultLike | undefined {
		return this.queryService.getLastQueryResult();
	}

	public set backendLastQueryResult(value: BackendQueryResultLike | undefined) {
		this.queryService.setCacheState(value, this.queryService.getCacheKey(), this.queryService.getCacheTimestamp());
	}

	public get backendLastQueryCacheKey(): string | undefined {
		return this.queryService.getCacheKey();
	}

	public set backendLastQueryCacheKey(value: string | undefined) {
		// Query service manages cache key internally; use setCacheState() for full control
		this.queryService.setCacheState(this.backendLastQueryResult, value, this.queryService.getCacheTimestamp());
	}

	public get backendLastQueryCacheAt(): number | undefined {
		return this.queryService.getCacheTimestamp();
	}

	public set backendLastQueryCacheAt(value: number | undefined) {
		// Query service manages cache timestamp internally; use setCacheState() for full control
		this.queryService.setCacheState(this.backendLastQueryResult, this.queryService.getCacheKey(), value);
	}

	/**
	 * Compute daily rollups from local session files.
	 * Public wrapper for test access to sync service's private method.
	 * @param args - Lookback period and optional user ID for filtering
	 * @returns Map of rollups with workspace/machine display names
	 */
	public async computeDailyRollupsFromLocalSessions(args: { lookbackDays: number; userId?: string }): Promise<{ rollups: Map<string, { key: DailyRollupKey; value: DailyRollupValue }>; displayNames?: { workspaces: Map<string, string>; machines: Map<string, string> } }> {
		// Delegate to syncService which already has the implementation
		const result = await (this.syncService as any).computeDailyRollupsFromLocalSessions(args);
		// The syncService returns:
		// { rollups: Map<string, { key, value }>, workspaceNamesById, machineNamesById }
		// Convert to the format expected by tests:
		// { rollups: Map<string, DailyRollupMapEntryLike> }
		return {
			rollups: result.rollups,
			displayNames: {
				workspaces: new Map(Object.entries(result.workspaceNamesById || {})),
				machines: new Map(Object.entries(result.machineNamesById || {}))
			}
		};
	}

	public async getAggEntitiesForRange(settings: BackendSettings, startDayKey: string, endDayKey: string): Promise<BackendAggDailyEntityLike[]> {
		const creds = await this.credentialService.getBackendDataPlaneCredentialsOrThrow(settings);
		const tableClient = this.dataPlaneService.createTableClient(settings, creds.tableCredential);
		return await this.dataPlaneService.listEntitiesForRange({
			tableClient,
			datasetId: settings.datasetId,
			startDayKey,
			endDayKey
		});
	}

	public async getBackendSecretsToRedactForError(settings: BackendSettings): Promise<string[]> {
		return this.credentialService.getBackendSecretsToRedactForError(settings);
	}

	public async syncToBackendStore(force: boolean): Promise<void> {
		const settings = this.getSettings();
		const result = await this.syncService.syncToBackendStore(force, settings, this.isConfigured(settings));
		this.clearQueryCache();
		// UI update is now handled by syncService after successful completion
		return result;
	}

	public async tryGetBackendDetailedStatsForStatusBar(settings: BackendSettings): Promise<any | undefined> {
		const sharingPolicy = computeBackendSharingPolicy({
			enabled: settings.enabled,
			profile: settings.sharingProfile,
			shareWorkspaceMachineNames: settings.shareWorkspaceMachineNames
		});
		return this.queryService.tryGetBackendDetailedStatsForStatusBar(settings, this.isConfigured(settings), sharingPolicy);
	}

	public async getStatsForDetailsPanel(): Promise<any | undefined> {
		const settings = this.getSettings();
		const sharingPolicy = computeBackendSharingPolicy({
			enabled: settings.enabled,
			profile: settings.sharingProfile,
			shareWorkspaceMachineNames: settings.shareWorkspaceMachineNames
		});
		return this.queryService.getStatsForDetailsPanel(settings, this.isConfigured(settings), sharingPolicy);
	}

	public async queryBackendRollups(settings: BackendSettings, filters: BackendQueryFilters, startDayKey: string, endDayKey: string): Promise<BackendQueryResultLike> {
		return this.queryService.queryBackendRollups(settings, filters, startDayKey, endDayKey);
	}

	public async setBackendSharedKey(): Promise<void> {
		const settings = this.getSettings();
		const storageAccount = settings.storageAccount;
		try {
			const ok = await this.promptForAndStoreSharedKey(storageAccount, 'Set Storage Shared Key for Backend Sync');
			if (ok) {
				vscode.window.showInformationMessage(SuccessMessages.keyUpdated(storageAccount));
			}
		} catch (e) {
			vscode.window.showErrorMessage(`Failed to set Shared Key: ${safeStringifyError(e)}`);
		}
	}

	public async rotateBackendSharedKey(): Promise<void> {
		const settings = this.getSettings();
		const storageAccount = settings.storageAccount;
		try {
			const ok = await this.promptForAndStoreSharedKey(storageAccount, 'Rotate Storage Shared Key for Backend Sync');
			if (ok) {
				vscode.window.showInformationMessage(SuccessMessages.keyUpdated(storageAccount));
			}
		} catch (e) {
			vscode.window.showErrorMessage(`Failed to rotate Shared Key: ${safeStringifyError(e)}`);
		}
	}

	public async clearBackendSharedKey(): Promise<void> {
		const settings = this.getSettings();
		const storageAccount = settings.storageAccount;
		if (!storageAccount) {
			vscode.window.showErrorMessage('Backend storage account is not configured yet.');
			return;
		}
		const conf = ConfirmationMessages.clearKey();
		const confirm = await vscode.window.showWarningMessage(
			conf.message,
			{ modal: true, detail: conf.detail },
			conf.button
		);
		if (confirm !== conf.button) {
			return;
		}
		try {
			await this.credentialService.clearStoredStorageSharedKey(storageAccount);
			vscode.window.showInformationMessage(SuccessMessages.completed('Shared key removed'));
		} catch (e) {
			vscode.window.showErrorMessage(`Failed to clear Shared Key: ${safeStringifyError(e)}`);
		}
	}

	public async toggleBackendWorkspaceMachineNameSync(): Promise<void> {
		const config = vscode.workspace.getConfiguration('copilotTokenTracker');
		const current = config.get<boolean>('backend.shareWorkspaceMachineNames', false);
		const next = !current;
		await config.update('backend.shareWorkspaceMachineNames', next, vscode.ConfigurationTarget.Global);
		const enabled = config.get<boolean>('backend.shareWithTeam', false);
		const suffix = enabled
			? ''
			: ' (Note: this only affects team sharing mode; personal mode always includes names)';
		vscode.window.showInformationMessage(`Backend: workspace/machine name sync ${next ? 'enabled' : 'disabled'}${suffix}`);
	}

	private async getConfigPanelState(draftOverride?: BackendConfigDraft): Promise<BackendConfigPanelState> {
		const settings = this.getSettings();
		const draft = draftOverride ?? toDraft(settings);
		const sharedKeySet = !!(draft.storageAccount && (await this.credentialService.getStoredStorageSharedKey(draft.storageAccount)));
		const privacyBadge = getPrivacyBadge(draft.sharingProfile, draft.shareWorkspaceMachineNames);
		const authStatus = draft.authMode === 'sharedKey'
			? sharedKeySet
				? 'Auth: Shared Key stored on this machine'
				: 'Auth: Shared Key missing on this machine'
			: 'Auth: Entra ID (RBAC)';
		return {
			draft,
			sharedKeySet,
			privacyBadge,
			isConfigured: this.isConfigured(settings),
			authStatus,
			shareConsentAt: settings.shareConsentAt
		};
	}

	private async updateConfiguration(next: BackendSettings): Promise<void> {
		if (!this.deps.context) {
			throw new Error('Extension context is unavailable; cannot update configuration.');
		}
		const config = vscode.workspace.getConfiguration('copilotTokenTracker');
		await Promise.all([
			config.update('backend.enabled', next.enabled, vscode.ConfigurationTarget.Global),
			config.update('backend.authMode', next.authMode, vscode.ConfigurationTarget.Global),
			config.update('backend.datasetId', next.datasetId, vscode.ConfigurationTarget.Global),
			config.update('backend.sharingProfile', next.sharingProfile, vscode.ConfigurationTarget.Global),
			config.update('backend.shareWithTeam', next.shareWithTeam, vscode.ConfigurationTarget.Global),
			config.update('backend.shareWorkspaceMachineNames', next.shareWorkspaceMachineNames, vscode.ConfigurationTarget.Global),
			config.update('backend.shareConsentAt', next.shareConsentAt, vscode.ConfigurationTarget.Global),
			config.update('backend.userIdentityMode', next.userIdentityMode, vscode.ConfigurationTarget.Global),
			config.update('backend.userId', next.userId, vscode.ConfigurationTarget.Global),
			config.update('backend.userIdMode', next.userIdMode, vscode.ConfigurationTarget.Global),
			config.update('backend.subscriptionId', next.subscriptionId, vscode.ConfigurationTarget.Global),
			config.update('backend.resourceGroup', next.resourceGroup, vscode.ConfigurationTarget.Global),
			config.update('backend.storageAccount', next.storageAccount, vscode.ConfigurationTarget.Global),
			config.update('backend.aggTable', next.aggTable, vscode.ConfigurationTarget.Global),
			config.update('backend.eventsTable', next.eventsTable, vscode.ConfigurationTarget.Global),
			config.update('backend.lookbackDays', next.lookbackDays, vscode.ConfigurationTarget.Global),
			config.update('backend.includeMachineBreakdown', next.includeMachineBreakdown, vscode.ConfigurationTarget.Global)
		]);
	}

	private async showConfigPanel(): Promise<void> {
		if (!this.deps.context?.extensionUri) {
			vscode.window.showErrorMessage('Extension context is unavailable; cannot open backend configuration.');
			return;
		}
		if (!this.configPanel) {
				this.configPanel = new BackendConfigPanel(this.deps.context.extensionUri, {
					getState: () => this.getConfigPanelState(),
					onSave: async (draft) => this.saveDraft(draft),
					onDiscard: () => this.getConfigPanelState(),
					onStayLocal: () => this.disableBackend(),
					onTestConnection: async (draft) => this.testConnectionFromDraft(draft),
					onUpdateSharedKey: async (storageAccount, draft) => this.updateSharedKey(storageAccount, draft),
					onLaunchWizard: async () => this.launchConfigureWizardFromPanel(),
					onClearAzureSettings: async () => this.clearAzureSettings()
				});
		}
		await this.configPanel.show();
	}

	private async launchConfigureWizardFromPanel(): Promise<BackendConfigPanelState> {
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: 'Launching Azure backend configuration wizard...',
				cancellable: false
			},
			async () => {
				await this.azureResourceService.configureBackendWizard();
			}
		);
		this.startTimerIfEnabled();
		this.deps.updateTokenStats?.();
		this.clearQueryCache();
		return this.getConfigPanelState();
	}

	private async disableBackend(): Promise<BackendConfigPanelState> {
		const settings = this.getSettings();
		const draft: BackendConfigDraft = { ...toDraft(settings), enabled: false, sharingProfile: 'off', shareWorkspaceMachineNames: false, includeMachineBreakdown: false };
		const next = applyDraftToSettings(settings, draft, undefined);
		await this.updateConfiguration(next);
		this.startTimerIfEnabled();
		this.deps.updateTokenStats?.();
		this.clearQueryCache();
		return this.getConfigPanelState(draft);
	}

	private async clearAzureSettings(): Promise<BackendConfigPanelState> {
		const confirmed = await vscode.window.showWarningMessage(
			'Clear all Azure settings?',
			{ modal: true, detail: 'This will remove all Azure resource IDs, credentials, and backend configuration. You will need to reconfigure the backend to use it again.' },
			'Clear Settings'
		);
		if (confirmed !== 'Clear Settings') {
			return this.getConfigPanelState();
		}
		
		const settings = this.getSettings();
		// Clear shared key if exists
		if (settings.storageAccount) {
			try {
				await this.credentialService.clearStoredStorageSharedKey(settings.storageAccount);
			} catch (e) {
				// Continue even if key clear fails
			}
		}
		
		// Create a draft with empty Azure settings
		const draft: BackendConfigDraft = {
			enabled: false,
			authMode: 'entraId',
			sharingProfile: 'off',
			shareWorkspaceMachineNames: false,
			includeMachineBreakdown: false,
			datasetId: 'default',
			lookbackDays: 30,
			subscriptionId: '',
			resourceGroup: '',
			storageAccount: '',
			aggTable: 'usageAggDaily',
			eventsTable: 'usageEvents',
			userIdentityMode: 'pseudonymous',
			userId: ''
		};
		
		const next = applyDraftToSettings(settings, draft, undefined);
		await this.updateConfiguration(next);
		this.startTimerIfEnabled();
		this.deps.updateTokenStats?.();
		this.clearQueryCache();
		return this.getConfigPanelState(draft);
	}

	private async saveDraft(draft: BackendConfigDraft): Promise<{ state: BackendConfigPanelState; errors?: Record<string, string>; message?: string }> {
		const validation = validateDraft(draft);
		if (!validation.valid) {
			return { state: await this.getConfigPanelState(draft), errors: validation.errors, message: 'Fix validation issues before saving.' };
		}
		const previousSettings = this.getSettings();
		const previousDraft = toDraft(previousSettings);
		const consent = needsConsent(previousDraft, draft);
		let consentAt: string | undefined = previousSettings.shareConsentAt;
		if (consent.required) {
			const conf = ConfirmationMessages.privacyUpgrade(consent.reasons);
			const choice = await vscode.window.showWarningMessage(
				conf.message,
				{ modal: true, detail: conf.detail },
				conf.button
			);
			if (choice !== conf.button) {
				return { state: await this.getConfigPanelState(draft), errors: validation.errors, message: 'Consent is required to apply these changes.' };
			}
			consentAt = new Date().toISOString();
		}
		const next = applyDraftToSettings(previousSettings, draft, consentAt);
		await this.updateConfiguration(next);
		this.startTimerIfEnabled();
		this.clearQueryCache();
		// UI update happens automatically after sync completes via syncService callback
		return { state: await this.getConfigPanelState(), message: 'Settings saved.' };
	}

	private async testConnectionFromDraft(draft: BackendConfigDraft): Promise<{ ok: boolean; message: string }> {
		if (!draft.enabled) {
			return { ok: false, message: 'Backend is disabled. Enable it to test the connection.' };
		}
		const validation = validateDraft(draft);
		if (!validation.valid) {
			return { ok: false, message: 'Fix validation errors first.' };
		}
		const prev = this.getSettings();
		const settings = applyDraftToSettings(prev, draft, prev.shareConsentAt);
		
		return await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: 'Testing connection to Azure Storage...',
				cancellable: false
			},
			async () => {
				try {
					const creds = await this.credentialService.getBackendDataPlaneCredentials(settings);
					if (!creds) {
						return { ok: false, message: ErrorMessages.auth('Shared Key required for this auth mode') };
					}
					await this.dataPlaneService.validateAccess(settings, creds.tableCredential);
					return { ok: true, message: SuccessMessages.connected() };
				} catch (error: any) {
					const details = error?.message || String(error);
					if (details.includes('403') || details.includes('Forbidden')) {
						return { ok: false, message: ErrorMessages.auth('Check storage account permissions') };
					}
					if (details.includes('404') || details.includes('NotFound')) {
						return { ok: false, message: 'Storage account or table not found. Verify resource names.' };
					}
					if (details.includes('ENOTFOUND') || details.includes('ETIMEDOUT')) {
						return { ok: false, message: ErrorMessages.connection('Check network and storage account name') };
					}
					return { ok: false, message: details };
				}
			}
		);
	}

	private async updateSharedKey(storageAccount: string, draft?: BackendConfigDraft): Promise<{ ok: boolean; message: string; state?: BackendConfigPanelState }> {
		if (!storageAccount || !storageAccount.trim()) {
			return { ok: false, message: 'Storage account is required before setting a shared key.' };
		}
		try {
			const ok = await this.promptForAndStoreSharedKey(storageAccount, 'Set Storage Shared Key');
			if (!ok) {
				return { ok: false, message: 'Shared key not updated.' };
			}
			return { ok: true, message: 'Shared key stored for this machine.', state: await this.getConfigPanelState(draft ?? toDraft(this.getSettings())) };
		} catch (error: any) {
			return { ok: false, message: error?.message || String(error) };
		}
	}

	public async configureBackendWizard(): Promise<void> {
		await this.showConfigPanel();
	}

	public async clearAzureSettingsCommand(): Promise<void> {
		const settings = this.getSettings();
		// Clear shared key if exists
		if (settings.storageAccount) {
			try {
				await this.credentialService.clearStoredStorageSharedKey(settings.storageAccount);
			} catch (e) {
				// Continue even if key clear fails
			}
		}

		const config = vscode.workspace.getConfiguration('copilotTokenTracker');
		await Promise.all([
			config.update('backend.enabled', false, vscode.ConfigurationTarget.Global),
			config.update('backend.authMode', 'entraId', vscode.ConfigurationTarget.Global),
			config.update('backend.sharingProfile', 'off', vscode.ConfigurationTarget.Global),
			config.update('backend.shareWithTeam', false, vscode.ConfigurationTarget.Global),
			config.update('backend.shareWorkspaceMachineNames', false, vscode.ConfigurationTarget.Global),
			config.update('backend.shareConsentAt', '', vscode.ConfigurationTarget.Global),
			config.update('backend.subscriptionId', '', vscode.ConfigurationTarget.Global),
			config.update('backend.resourceGroup', '', vscode.ConfigurationTarget.Global),
			config.update('backend.storageAccount', '', vscode.ConfigurationTarget.Global),
			config.update('backend.aggTable', 'usageAggDaily', vscode.ConfigurationTarget.Global),
			config.update('backend.eventsTable', 'usageEvents', vscode.ConfigurationTarget.Global),
			config.update('backend.userId', '', vscode.ConfigurationTarget.Global),
		]);

		this.startTimerIfEnabled();
		this.deps.updateTokenStats?.();
		this.clearQueryCache();
		
		vscode.window.showInformationMessage('Azure settings cleared successfully.');
	}

	public async setSharingProfileCommand(): Promise<void> {
		const result = await this.azureResourceService.setSharingProfileCommand();
		this.clearQueryCache();
		return result;
	}

	// Helper method for shared key prompting (used by setBackendSharedKey and rotateBackendSharedKey)
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
		await this.credentialService.setStoredStorageSharedKey(storageAccount, sharedKey);
		return true;
	}
}
