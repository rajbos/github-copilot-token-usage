import * as vscode from 'vscode';

import { safeStringifyError } from '../utils/errors';
import type { BackendAggDailyEntityLike } from './storageTables';
import type { BackendQueryFilters, BackendSettings } from './settings';
import { getBackendSettings, isBackendConfigured } from './settings';
import type { SessionStats, ModelUsage, ChatRequest } from './types';
import { computeBackendSharingPolicy } from './sharingProfile';
import { CredentialService } from './services/credentialService';
import { AzureResourceService } from './services/azureResourceService';
import { DataPlaneService } from './services/dataPlaneService';
import { SyncService } from './services/syncService';
import { QueryService, type BackendQueryResultLike } from './services/queryService';
import { BackendUtility } from './services/utilityService';

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
}

export class BackendFacade {
	private deps: BackendFacadeDeps;
	private credentialService: CredentialService;
	private azureResourceService: AzureResourceService;
	private dataPlaneService: DataPlaneService;
	private syncService: SyncService;
	private queryService: QueryService;

	public constructor(deps: BackendFacadeDeps) {
		this.deps = deps;
		
		// Initialize services
		this.credentialService = new CredentialService(deps.context);
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
				getModelFromRequest: deps.getModelFromRequest
			},
			this.credentialService,
			this.dataPlaneService,
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
	}

	public stopTimer(): void {
		this.syncService.stopTimer();
	}

	public clearQueryCache(): void {
		this.queryService.clearQueryCache();
	}

	public dispose(): void {
		this.syncService.dispose();
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

	// Cache state exposed for testing
	public get backendLastQueryResult(): BackendQueryResultLike | undefined {
		return (this.queryService as any).backendLastQueryResult;
	}

	public set backendLastQueryResult(value: BackendQueryResultLike | undefined) {
		(this.queryService as any).backendLastQueryResult = value;
	}

	public get backendLastQueryCacheKey(): string | undefined {
		return (this.queryService as any).backendLastQueryCacheKey;
	}

	public set backendLastQueryCacheKey(value: string | undefined) {
		(this.queryService as any).backendLastQueryCacheKey = value;
	}

	public get backendLastQueryCacheAt(): number | undefined {
		return (this.queryService as any).backendLastQueryCacheAt;
	}

	public set backendLastQueryCacheAt(value: number | undefined) {
		(this.queryService as any).backendLastQueryCacheAt = value;
	}

	public async computeDailyRollupsFromLocalSessions(args: { lookbackDays: number; userId?: string }): Promise<{ rollups: Map<string, { key: any; value: any }>; displayNames?: { workspaces: Map<string, string>; machines: Map<string, string> } }> {
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
			tableClient: tableClient as any,
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
		return this.syncService.syncToBackendStore(force, settings, this.isConfigured(settings));
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
				vscode.window.showInformationMessage('Backend sync Shared Key stored securely for this machine.');
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
				vscode.window.showInformationMessage('Backend sync Shared Key rotated securely for this machine.');
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
		const confirm = await vscode.window.showWarningMessage(
			`Clear the stored Shared Key for '${storageAccount}' on this machine?`,
			{ modal: true },
			'Clear'
		);
		if (confirm !== 'Clear') {
			return;
		}
		try {
			await this.credentialService.clearStoredStorageSharedKey(storageAccount);
			vscode.window.showInformationMessage('Backend sync Shared Key cleared for this machine.');
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

	public async configureBackendWizard(): Promise<void> {
		return this.azureResourceService.configureBackendWizard();
	}

	public async setSharingProfileCommand(): Promise<void> {
		return this.azureResourceService.setSharingProfileCommand();
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
