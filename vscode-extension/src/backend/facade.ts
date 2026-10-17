import * as vscode from "vscode";
import type { Stats } from "fs";

import { safeStringifyError, isAuthError, isNotFoundError, isNetworkError } from "../../../src/utils/errors";
import {
  BackendConfigPanel,
  type BackendConfigPanelState,
} from "./configPanel";
import {
  applyDraftToSettings,
  getPrivacyBadge,
  needsConsent,
  toDraft,
  validateDraft,
  type BackendConfigDraft,
} from "./configurationFlow";
import { MAX_LOOKBACK_DAYS } from "./constants";
import type { DailyRollupKey } from "./rollups";
import { AzureResourceService } from "./services/azureResourceService";
import { BlobUploadService } from "./services/blobUploadService";
import { CredentialService } from "./services/credentialService";
import { DataPlaneService } from "./services/dataPlaneService";
import {
  QueryService,
  type BackendQueryResultLike,
} from "./services/queryService";
import { SharingServerUploadService } from "./services/sharingServerUploadService";
import { SyncService } from "./services/syncService";
import { BackendUtility } from "./services/utilityService";
import type { BackendQueryFilters, BackendSettings } from "./settings";
import type { SyncResult } from "./types";
import { getBackendSettings, isBackendConfigured, isAnyBackendConfigured } from "./settings";
import { applySettingsAtomically } from "./settingsBatch";
import { computeBackendSharingPolicy } from "./sharingProfile";
import type { BackendAggDailyEntityLike } from "./storageTables";
import type {
  ChatRequest,
  DailyRollupValue,
  ModelUsage,
  SessionFileCache,
} from "./types";
import {
  ConfirmationMessages,
  ErrorMessages,
  SuccessMessages,
} from "./ui/messages";

// Re-export BackendQueryResultLike for external consumers
export type { BackendQueryResultLike };

export interface BackendFacadeDeps {
  context: vscode.ExtensionContext | undefined;
  log: (message: string) => void;
  warn: (message: string) => void;
  updateTokenStats?: () => Promise<void>;
  calculateEstimatedCost: (modelUsage: ModelUsage) => number;

  getCopilotSessionFiles: () => Promise<string[]>;
  estimateTokensFromText: (text: string, model: string) => number;
  getModelFromRequest: (request: ChatRequest) => string;
  // Cache integration for performance
  getSessionFileDataCached?: (
    sessionFilePath: string,
    mtime: number,
    fileSize: number,
  ) => Promise<SessionFileCache>;
  // Stat helper for OpenCode DB virtual paths
  statSessionFile: (sessionFile: string) => Promise<Stats>;
  // OpenCode session handling
  isOpenCodeSession?: (sessionFile: string) => boolean;
  getOpenCodeSessionData?: (sessionFile: string) => Promise<{
    tokens: number;
    interactions: number;
    modelUsage: ModelUsage;
    timestamp: number;
  }>;
  // Crush session handling (per-project crush.db virtual paths)
  isCrushSession?: (sessionFile: string) => boolean;
  getCrushSessionData?: (sessionFile: string) => Promise<{
    tokens: number;
    interactions: number;
    modelUsage: ModelUsage;
    timestamp: number;
  }>;
  // Visual Studio session detection (binary MessagePack — cannot be parsed as JSON)
  isVSSessionFile?: (sessionFile: string) => boolean;
  /** Resolves session-specific labels such as Copilot CLI (App). */
  getEditorLabel?: (sessionFile: string) => string;
  /** Returns the current GitHub OAuth access token, or undefined if not authenticated. */
  getGithubToken?: () => string | undefined;
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
      deps.context,
    );
    this.dataPlaneService = new DataPlaneService(
      BackendUtility,
      deps.log,
      (settings) =>
        this.credentialService.getBackendSecretsToRedactForError(settings),
    );
    this.queryService = new QueryService(
      {
        warn: deps.warn,
        calculateEstimatedCost: deps.calculateEstimatedCost,
      },
      this.credentialService,
      this.dataPlaneService,
      BackendUtility,
    );
    this.syncService = new SyncService(
      {
        context: deps.context,
        logger: {
          log: deps.log,
          warn: deps.warn,
        },
        sessionHandlers: {
          getCopilotSessionFiles: deps.getCopilotSessionFiles,
          estimateTokensFromText: deps.estimateTokensFromText,
          getModelFromRequest: deps.getModelFromRequest,
          getSessionFileDataCached: deps.getSessionFileDataCached,
          statSessionFile: deps.statSessionFile,
        },
        editorHandlers: {
          isOpenCodeSession: deps.isOpenCodeSession,
          getOpenCodeSessionData: deps.getOpenCodeSessionData,
          isCrushSession: deps.isCrushSession,
          getCrushSessionData: deps.getCrushSessionData,
          isVSSessionFile: deps.isVSSessionFile,
        },
        updateTokenStats: deps.updateTokenStats,
        getGithubToken: deps.getGithubToken,
        getEditorLabel: deps.getEditorLabel,
      },
      this.credentialService,
      this.dataPlaneService,
      this.blobUploadService,
      BackendUtility,
      new SharingServerUploadService(),
    );
    this.azureResourceService = new AzureResourceService(
      {
        log: deps.log,
        updateTokenStats: deps.updateTokenStats,
        getSettings: () => this.getSettings(),
        startTimerIfEnabled: () => this.startTimerIfEnabled(),
        syncToBackendStore: (force) => this.syncToBackendStore(force),
        clearQueryCache: () => this.clearQueryCache(),
      },
      this.credentialService,
      this.dataPlaneService,
    );
  }

  public startTimerIfEnabled(): void {
    const settings = this.getSettings();
    this.syncService.startTimerIfEnabled(settings, this.isAnyConfigured(settings));
    this.clearQueryCache();
  }

  public stopTimer(): void {
    this.syncService.stopTimer();
  }

  public clearQueryCache(): void {
    this.queryService.clearQueryCache();
  }

  private afterConfigChange(): void {
    this.startTimerIfEnabled();
    this.deps.updateTokenStats?.();
    this.clearQueryCache();
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

  /**
   * Whether *either* backend (Azure Storage or the Team Server) is configured. Azure Storage
   * and the Team Server are independent sync targets that can each be enabled on their own,
   * so sync scheduling must not require both or gate on the legacy `backend.backend` selector.
   */
  public isAnyConfigured(settings: BackendSettings): boolean {
    return isAnyBackendConfigured(settings);
  }

  /**
   * Resolves the effective user identity for the current user based on the backend configuration.
   * This is the userId that would be used when syncing data to the backend.
   * For dashboard purposes, this always attempts resolution to match historical sync behavior.
   */
  public async resolveEffectiveUserId(
    settings: BackendSettings,
  ): Promise<string | undefined> {
    // Import identity resolution function
    const { resolveUserIdentityForSync, validateTeamAlias } =
      await import("./identity.js");
    const { DefaultAzureCredential } = await import("@azure/identity");

    // Get access token for pseudonymous mode if needed
    let accessTokenForClaims: string | undefined;
    if (
      settings.userIdentityMode === "pseudonymous" &&
      settings.authMode === "entraId"
    ) {
      try {
        const token = await new DefaultAzureCredential().getToken(
          "https://storage.azure.com/.default",
        );
        accessTokenForClaims = token?.token;
      } catch {
        // Best-effort only: fall back to undefined
      }
    }

    // Debug logging for team alias mode
    if (settings.userIdentityMode === "teamAlias") {
      const validation = validateTeamAlias(settings.userId);
      this.deps.log(
        `[Backend] Team alias validation - input: "${settings.userId}", valid: ${validation.valid}, ${validation.valid ? `alias: "${validation.data.alias}"` : `error: ${validation.error}`}`,
      );
    }

    // Always pass shareWithTeam: true to resolve identity for dashboard viewing,
    // even if current sharing policy excludes user dimension. We want to match
    // the identity that was used during previous syncs.
    const resolved = resolveUserIdentityForSync({
      shareWithTeam: true,
      userIdentityMode: settings.userIdentityMode,
      configuredUserId: settings.userId,
      datasetId: settings.datasetId,
      accessTokenForClaims,
    });

    this.deps.log(
      `[Backend] Resolved userId: ${resolved.userId || "(none)"}, userKeyType: ${resolved.userKeyType || "(none)"}`,
    );

    return resolved.userId;
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

  public get syncQueue(): Promise<unknown> {
    return this.syncService.getSyncQueue();
  }

  public async uploadFluencyScoreToSharingServer(
    settings: BackendSettings,
    score: Record<string, unknown>,
  ): Promise<void> {
    return this.syncService.uploadFluencyScoreToSharingServer(settings, score);
  }

  // Cache state exposed for testing via QueryService accessors
  public get backendLastQueryResult(): BackendQueryResultLike | undefined {
    return this.queryService.getLastQueryResult();
  }

  public set backendLastQueryResult(value: BackendQueryResultLike | undefined) {
    this.queryService.setCacheState(
      value,
      this.queryService.getCacheKey(),
      this.queryService.getCacheTimestamp(),
    );
  }

  public get backendLastQueryCacheKey(): string | undefined {
    return this.queryService.getCacheKey();
  }

  public set backendLastQueryCacheKey(value: string | undefined) {
    // Query service manages cache key internally; use setCacheState() for full control
    this.queryService.setCacheState(
      this.backendLastQueryResult,
      value,
      this.queryService.getCacheTimestamp(),
    );
  }

  public get backendLastQueryCacheAt(): number | undefined {
    return this.queryService.getCacheTimestamp();
  }

  public set backendLastQueryCacheAt(value: number | undefined) {
    // Query service manages cache timestamp internally; use setCacheState() for full control
    this.queryService.setCacheState(
      this.backendLastQueryResult,
      this.queryService.getCacheKey(),
      value,
    );
  }

  /**
   * Compute daily rollups from local session files.
   * Public wrapper for test access to sync service's private method.
   * @param args - Lookback period and optional user ID for filtering
   * @returns Map of rollups with workspace/machine display names
   */
  public async computeDailyRollupsFromLocalSessions(args: {
    lookbackDays: number;
    userId?: string;
  }): Promise<{
    rollups: Map<string, { key: DailyRollupKey; value: DailyRollupValue }>;
    displayNames?: {
      workspaces: Map<string, string>;
      machines: Map<string, string>;
    };
  }> {
    // Delegate to syncService which already has the implementation.
    // computeDailyRollupsFromLocalSessions is private on SyncService; we define a
    // standalone interface and double-cast (via unknown) to preserve type-safety at
    // the call site rather than using an untyped "as any".
    interface SyncServiceInternals {
      computeDailyRollupsFromLocalSessions(args: {
        lookbackDays: number;
        userId?: string;
      }): Promise<{
        rollups: Map<string, { key: DailyRollupKey; value: DailyRollupValue }>;
        workspaceNamesById: Record<string, string>;
        machineNamesById: Record<string, string>;
      }>;
    }
    const result = await (
      this.syncService as unknown as SyncServiceInternals
    ).computeDailyRollupsFromLocalSessions(args);
    // The syncService returns:
    // { rollups: Map<string, { key, value }>, workspaceNamesById, machineNamesById }
    // Convert to the format expected by tests:
    // { rollups: Map<string, DailyRollupMapEntryLike> }
    return {
      rollups: result.rollups,
      displayNames: {
        workspaces: new Map(Object.entries(result.workspaceNamesById || {})),
        machines: new Map(Object.entries(result.machineNamesById || {})),
      },
    };
  }

  public async getAggEntitiesForRange(
    settings: BackendSettings,
    startDayKey: string,
    endDayKey: string,
  ): Promise<BackendAggDailyEntityLike[]> {
    const creds =
      await this.credentialService.getBackendDataPlaneCredentialsOrThrow(
        settings,
      );
    const tableClient = this.dataPlaneService.createTableClient(
      settings,
      creds.tableCredential,
    );
    return await this.dataPlaneService.listEntitiesForRange({
      tableClient,
      datasetId: settings.datasetId,
      startDayKey,
      endDayKey,
    });
  }

  /**
   * Get all entities across ALL datasets for a date range (for cross-team dashboard).
   */
  public async getAllAggEntitiesForRange(
    settings: BackendSettings,
    startDayKey: string,
    endDayKey: string,
  ): Promise<BackendAggDailyEntityLike[]> {
    const creds =
      await this.credentialService.getBackendDataPlaneCredentialsOrThrow(
        settings,
      );
    const tableClient = this.dataPlaneService.createTableClient(
      settings,
      creds.tableCredential,
    );
    return await this.dataPlaneService.listAllEntitiesForRange({
      tableClient,
      startDayKey,
      endDayKey,
    });
  }

  /**
   * Delete all aggregate table entities for a specific user + dataset combination.
   * Used by the Team Dashboard per-row cleanup feature.
   *
   * @param userId - The user identifier (without u: prefix)
   * @param datasetId - The dataset identifier (without ds: prefix)
   * @returns Object with deleted count and any errors
   */
  public async deleteUserDataset(
    userId: string,
    datasetId: string,
  ): Promise<{
    deletedCount: number;
    errors: Array<{ partitionKey: string; rowKey: string; error: Error }>;
  }> {
    const settings = this.getSettings();
    const creds =
      await this.credentialService.getBackendDataPlaneCredentialsOrThrow(
        settings,
      );
    const tableClient = this.dataPlaneService.createTableClient(
      settings,
      creds.tableCredential,
    );

    // Use a wide date range (max lookback) to catch all data
    const now = new Date();
    const todayKey = BackendUtility.toUtcDayKey(now);
    const startKey = BackendUtility.addDaysUtc(todayKey, -MAX_LOOKBACK_DAYS);

    const result = await this.dataPlaneService.deleteEntitiesForUserDataset({
      tableClient,
      userId,
      datasetId,
      startDayKey: startKey,
      endDayKey: todayKey,
    });

    // Clear query cache so subsequent queries reflect the deletion
    this.clearQueryCache();

    return result;
  }

  public async getBackendSecretsToRedactForError(
    settings: BackendSettings,
  ): Promise<string[]> {
    return this.credentialService.getBackendSecretsToRedactForError(settings);
  }

  public async syncToBackendStore(force: boolean): Promise<SyncResult | void> {
    const settings = this.getSettings();
    const result = await this.syncService.syncToBackendStore(
      force,
      settings,
      this.isAnyConfigured(settings),
    );
    this.clearQueryCache();
    // UI update is now handled by syncService after successful completion
    return result;
  }

  /**
   * Backfill historical data to Azure Table Storage.
   * Scans ALL local session files (ignoring the mtime-based age filter) and upserts daily
   * rollups for every day within the given lookback window (default 365 days).
   * Use this when the normal sync has missed data due to the mtime filter.
   */
  public async backfillHistoricalData(
    maxLookbackDays = 365,
    onProgress?: (processed: number, total: number, daysFound: number) => void,
  ): Promise<void> {
    const settings = this.getSettings();
    await this.syncService.backfillSync(settings, maxLookbackDays, onProgress);
    this.clearQueryCache();
  }

  public async tryGetBackendDetailedStatsForStatusBar(
    settings: BackendSettings,
  ): Promise<unknown> {
    const sharingPolicy = computeBackendSharingPolicy({
      enabled: settings.enabled,
      profile: settings.sharingProfile,
      shareWorkspaceMachineNames: settings.shareWorkspaceMachineNames,
    });
    return this.queryService.tryGetBackendDetailedStatsForStatusBar(
      settings,
      this.isConfigured(settings),
      sharingPolicy,
    );
  }

  public async getStatsForDetailsPanel(): Promise<unknown> {
    const settings = this.getSettings();
    const sharingPolicy = computeBackendSharingPolicy({
      enabled: settings.enabled,
      profile: settings.sharingProfile,
      shareWorkspaceMachineNames: settings.shareWorkspaceMachineNames,
    });
    return this.queryService.getStatsForDetailsPanel(
      settings,
      this.isConfigured(settings),
      sharingPolicy,
    );
  }

  public async queryBackendRollups(
    settings: BackendSettings,
    filters: BackendQueryFilters,
    startDayKey: string,
    endDayKey: string,
  ): Promise<BackendQueryResultLike> {
    return this.queryService.queryBackendRollups(
      settings,
      filters,
      startDayKey,
      endDayKey,
    );
  }

  public async setBackendSharedKey(): Promise<void> {
    return this.manageSharedKeyCommand("set");
  }

  public async rotateBackendSharedKey(): Promise<void> {
    return this.manageSharedKeyCommand("rotate");
  }

  private async manageSharedKeyCommand(action: "set" | "rotate"): Promise<void> {
    const settings = this.getSettings();
    const storageAccount = settings.storageAccount;
    const promptTitle =
      action === "set"
        ? "Set Storage Shared Key for Backend Sync"
        : "Rotate Storage Shared Key for Backend Sync";
    const errorPrefix = action === "set" ? "Failed to set" : "Failed to rotate";
    try {
      const ok = await this.promptForAndStoreSharedKey(storageAccount, promptTitle);
      if (ok) {
        vscode.window.showInformationMessage(
          SuccessMessages.keyUpdated(storageAccount),
        );
      }
    } catch (e: unknown) {
      vscode.window.showErrorMessage(
        `${errorPrefix} Shared Key: ${safeStringifyError(e)}`,
      );
    }
  }

  public async clearBackendSharedKey(): Promise<void> {
    const settings = this.getSettings();
    const storageAccount = settings.storageAccount;
    if (!storageAccount) {
      vscode.window.showErrorMessage(
        "Backend storage account is not configured yet.",
      );
      return;
    }
    const conf = ConfirmationMessages.clearKey();
    const confirm = await vscode.window.showWarningMessage(
      conf.message,
      { modal: true, detail: conf.detail },
      conf.button,
    );
    if (confirm !== conf.button) {
      return;
    }
    try {
      await this.credentialService.clearStoredStorageSharedKey(storageAccount);
      vscode.window.showInformationMessage(
        SuccessMessages.completed("Shared key removed"),
      );
    } catch (e) {
      vscode.window.showErrorMessage(
        `Failed to clear Shared Key: ${safeStringifyError(e)}`,
      );
    }
  }

  public async toggleBackendWorkspaceMachineNameSync(): Promise<void> {
    const config = vscode.workspace.getConfiguration("aiEngineeringFluency");
    const current = config.get<boolean>(
      "backend.shareWorkspaceMachineNames",
      false,
    );
    const next = !current;
    await config.update(
      "backend.shareWorkspaceMachineNames",
      next,
      vscode.ConfigurationTarget.Global,
    );
    const suffix = this.getShareWithTeamSuffix();
    vscode.window.showInformationMessage(
      `Backend: workspace/machine name sync ${next ? "enabled" : "disabled"}${suffix}`,
    );
  }

  private getShareWithTeamSuffix(): string {
    const config = vscode.workspace.getConfiguration("aiEngineeringFluency");
    const enabled = config.get<boolean>("backend.shareWithTeam", false);
    return enabled
      ? ""
      : " (Note: this only affects team sharing mode; personal mode always includes names)";
  }

  private async getConfigPanelState(
    draftOverride?: BackendConfigDraft,
  ): Promise<BackendConfigPanelState> {
    const settings = this.getSettings();
    const draft = draftOverride ?? toDraft(settings);
    const sharedKeySet = !!(
      draft.azureResources.storageAccount &&
      (await this.credentialService.getStoredStorageSharedKey(
        draft.azureResources.storageAccount,
      ))
    );
    const privacyBadge = getPrivacyBadge(
      draft.sharing.sharingProfile,
      draft.sharing.shareWorkspaceMachineNames,
    );
    const authStatus =
      draft.authMode === "sharedKey"
        ? sharedKeySet
          ? "Auth: Shared Key stored on this machine"
          : "Auth: Shared Key missing on this machine"
        : "Auth: Entra ID (RBAC)";
    const lastSyncAt = this.deps.context?.globalState?.get<number>("backend.lastSyncAt");
    const githubTokenAvailable = !!(this.deps.getGithubToken?.());
    return {
      draft,
      sharedKeySet,
      privacyBadge,
      isConfigured: this.isConfigured(settings),
      authStatus,
      githubTokenAvailable,
      shareConsentAt: settings.shareConsentAt,
      lastSyncAt,
    };
  }

  private async updateConfiguration(next: BackendSettings): Promise<void> {
    if (!this.deps.context) {
      throw new Error(
        "Extension context is unavailable; cannot update configuration.",
      );
    }
    const config = vscode.workspace.getConfiguration("aiEngineeringFluency");
    // One batch, so the settings-change sync never runs against a half-applied save.
    await applySettingsAtomically(() => Promise.all([
      ...this.buildSharingConfigUpdates(config, next),
      ...this.buildAzureConfigUpdates(config, next),
      ...this.buildBlobAndServerConfigUpdates(config, next),
    ]));
  }

  private buildSharingConfigUpdates(
    config: vscode.WorkspaceConfiguration,
    next: BackendSettings,
  ): Thenable<void>[] {
    const T = vscode.ConfigurationTarget.Global;
    return [
      config.update("backend.enabled", next.enabled, T),
      config.update("backend.authMode", next.authMode, T),
      config.update("backend.datasetId", next.datasetId, T),
      config.update("backend.sharingProfile", next.sharingProfile, T),
      config.update("backend.shareWithTeam", next.shareWithTeam, T),
      config.update("backend.shareWorkspaceMachineNames", next.shareWorkspaceMachineNames, T),
      config.update("backend.shareConsentAt", next.shareConsentAt, T),
      config.update("backend.userIdentityMode", next.userIdentityMode, T),
      config.update("backend.userId", next.userId, T),
      config.update("backend.userIdMode", next.userIdMode, T),
    ];
  }

  private buildAzureConfigUpdates(
    config: vscode.WorkspaceConfiguration,
    next: BackendSettings,
  ): Thenable<void>[] {
    const T = vscode.ConfigurationTarget.Global;
    return [
      config.update("backend.subscriptionId", next.subscriptionId, T),
      config.update("backend.resourceGroup", next.resourceGroup, T),
      config.update("backend.storageAccount", next.storageAccount, T),
      config.update("backend.aggTable", next.aggTable, T),
      config.update("backend.eventsTable", next.eventsTable, T),
      config.update("backend.lookbackDays", next.lookbackDays, T),
      config.update("backend.includeMachineBreakdown", next.includeMachineBreakdown, T),
    ];
  }

  private buildBlobAndServerConfigUpdates(
    config: vscode.WorkspaceConfiguration,
    next: BackendSettings,
  ): Thenable<void>[] {
    const T = vscode.ConfigurationTarget.Global;
    return [
      config.update("backend.blobUploadEnabled", next.blobUploadEnabled, T),
      config.update("backend.blobContainerName", next.blobContainerName, T),
      config.update("backend.blobUploadFrequencyHours", next.blobUploadFrequencyHours, T),
      config.update("backend.blobCompressFiles", next.blobCompressFiles, T),
      config.update("backend.backend", next.backend, T),
      config.update("backend.sharingServer.enabled", next.sharingServerEnabled, T),
      config.update("backend.sharingServer.endpointUrl", next.sharingServerEndpointUrl, T),
    ];
  }

  private async showConfigPanel(): Promise<void> {
    if (!this.deps.context?.extensionUri) {
      vscode.window.showErrorMessage(
        "Extension context is unavailable; cannot open backend configuration.",
      );
      return;
    }
    // Create a new panel if we don't have one or if it was disposed
    if (!this.configPanel || this.configPanel.isDisposed()) {
      this.configPanel = new BackendConfigPanel(
        this.deps.context.extensionUri,
        {
          getState: () => this.getConfigPanelState(),
          onSave: async (draft) => this.saveDraft(draft),
          onDiscard: () => this.getConfigPanelState(),
          onStayLocal: () => this.disableBackend(),
          onTestConnection: async (draft) =>
            this.testConnectionFromDraft(draft),
          onUpdateSharedKey: async (storageAccount, draft) =>
            this.updateSharedKey(storageAccount, draft),
          onLaunchWizard: async () => this.launchConfigureWizardFromPanel(),
          onClearAzureSettings: async () => this.clearAzureSettings(),
        },
      );
    }
    await this.configPanel.show();
  }

  private async launchConfigureWizardFromPanel(): Promise<BackendConfigPanelState> {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Launching Azure backend configuration wizard...",
        cancellable: false,
      },
      async () => {
        await this.azureResourceService.configureBackendWizard();
      },
    );
    this.afterConfigChange();
    return this.getConfigPanelState();
  }

  private async disableBackend(): Promise<BackendConfigPanelState> {
    const settings = this.getSettings();
    const disableBase = toDraft(settings);
    const draft: BackendConfigDraft = {
      ...disableBase,
      enabled: false,
      includeMachineBreakdown: false,
      sharing: { ...disableBase.sharing, sharingProfile: "off", shareWorkspaceMachineNames: false },
    };
    const next = applyDraftToSettings(settings, draft, undefined);
    await this.updateConfiguration(next);
    this.afterConfigChange();
    return this.getConfigPanelState(draft);
  }

  private async clearAzureSettings(): Promise<BackendConfigPanelState> {
    const confirmed = await vscode.window.showWarningMessage(
      "Clear all Azure settings?",
      {
        modal: true,
        detail:
          "This will remove all Azure resource IDs, credentials, and backend configuration. You will need to reconfigure the backend to use it again.",
      },
      "Clear Settings",
    );
    if (confirmed !== "Clear Settings") {
      return this.getConfigPanelState();
    }

    const settings = this.getSettings();
    // Clear shared key if exists
    if (settings.storageAccount) {
      try {
        await this.credentialService.clearStoredStorageSharedKey(
          settings.storageAccount,
        );
      } catch (_e: unknown) {
        // Continue even if key clear fails
      }
    }

    // Create a draft with empty Azure settings
    const draft: BackendConfigDraft = {
      enabled: false,
      backend: "storageTables",
      authMode: "entraId",
      datasetId: "default",
      lookbackDays: 30,
      includeMachineBreakdown: false,
      azureResources: {
        subscriptionId: "",
        resourceGroup: "",
        storageAccount: "",
        aggTable: "usageAggDaily",
        eventsTable: "usageEvents",
      },
      identity: {
        userIdentityMode: "pseudonymous",
        userId: "",
      },
      blobUpload: {
        blobUploadEnabled: false,
        blobContainerName: "copilot-session-logs",
        blobUploadFrequencyHours: 24,
        blobCompressFiles: true,
      },
      sharing: {
        sharingProfile: "off",
        shareWorkspaceMachineNames: false,
        sharingServerEnabled: false,
        sharingServerEndpointUrl: "",
      },
    };

    const next = applyDraftToSettings(settings, draft, undefined);
    await this.updateConfiguration(next);
    this.afterConfigChange();
    return this.getConfigPanelState(draft);
  }

  private async saveDraft(draft: BackendConfigDraft): Promise<{
    state: BackendConfigPanelState;
    errors?: Record<string, string>;
    message?: string;
  }> {
    const validation = validateDraft(draft);
    if (!validation.valid) {
      return {
        state: await this.getConfigPanelState(draft),
        errors: validation.errors,
        message: "Fix validation issues before saving.",
      };
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
        conf.button,
      );
      if (choice !== conf.button) {
        return {
          state: await this.getConfigPanelState(draft),
          errors: validation.errors,
          message: "Consent is required to apply these changes.",
        };
      }
      consentAt = new Date().toISOString();
    }
    const next = applyDraftToSettings(previousSettings, draft, consentAt);
    await this.updateConfiguration(next);
    this.startTimerIfEnabled();
    this.clearQueryCache();
    // UI update happens automatically after sync completes via syncService callback
    return {
      state: await this.getConfigPanelState(),
      message: "Settings saved.",
    };
  }

  private async testConnectionFromDraft(
    draft: BackendConfigDraft,
  ): Promise<{ ok: boolean; message: string }> {
    if (!draft.enabled) {
      return {
        ok: false,
        message: "Backend is disabled. Enable it to test the connection.",
      };
    }
    const validation = validateDraft(draft);
    if (!validation.valid) {
      return { ok: false, message: "Fix validation errors first." };
    }
    const prev = this.getSettings();
    const settings = applyDraftToSettings(prev, draft, prev.shareConsentAt);

    return await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Testing connection to Azure Storage...",
        cancellable: false,
      },
      async () => {
        try {
          const creds =
            await this.credentialService.getBackendDataPlaneCredentials(
              settings,
            );
          if (!creds) {
            return {
              ok: false,
              message: ErrorMessages.auth(
                "Shared Key required for this auth mode",
              ),
            };
          }
          await this.dataPlaneService.validateAccess(
            settings,
            creds.tableCredential,
          );
          return { ok: true, message: SuccessMessages.connected() };
        } catch (error: unknown) {
          if (isAuthError(error)) {
            return { ok: false, message: ErrorMessages.auth("Check storage account permissions") };
          }
          if (isNotFoundError(error)) {
            return { ok: false, message: "Storage account or table not found. Verify resource names." };
          }
          if (isNetworkError(error)) {
            return { ok: false, message: ErrorMessages.connection("Check network and storage account name") };
          }
          return { ok: false, message: safeStringifyError(error) };
        }
      },
    );
  }

  private async updateSharedKey(
    storageAccount: string,
    draft?: BackendConfigDraft,
  ): Promise<{
    ok: boolean;
    message: string;
    state?: BackendConfigPanelState;
  }> {
    if (!storageAccount || !storageAccount.trim()) {
      return {
        ok: false,
        message: "Storage account is required before setting a shared key.",
      };
    }
    try {
      const ok = await this.promptForAndStoreSharedKey(
        storageAccount,
        "Set Storage Shared Key",
      );
      if (!ok) {
        return { ok: false, message: "Shared key not updated." };
      }
      return {
        ok: true,
        message: "Shared key stored for this machine.",
        state: await this.getConfigPanelState(
          draft ?? toDraft(this.getSettings()),
        ),
      };
    } catch (error: unknown) {
      return { ok: false, message: safeStringifyError(error) };
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
        await this.credentialService.clearStoredStorageSharedKey(
          settings.storageAccount,
        );
      } catch (_e: unknown) {
        // Continue even if key clear fails
      }
    }

    // Build a clean reset draft (same defaults used by clearAzureSettings)
    const draft: BackendConfigDraft = {
      enabled: false,
      backend: "storageTables",
      authMode: "entraId",
      datasetId: "default",
      lookbackDays: 30,
      includeMachineBreakdown: false,
      azureResources: {
        subscriptionId: "",
        resourceGroup: "",
        storageAccount: "",
        aggTable: "usageAggDaily",
        eventsTable: "usageEvents",
      },
      identity: {
        userIdentityMode: "pseudonymous",
        userId: "",
      },
      blobUpload: {
        blobUploadEnabled: false,
        blobContainerName: "copilot-session-logs",
        blobUploadFrequencyHours: 24,
        blobCompressFiles: true,
      },
      sharing: {
        sharingProfile: "off",
        shareWorkspaceMachineNames: false,
        sharingServerEnabled: false,
        sharingServerEndpointUrl: "",
      },
    };
    const next = applyDraftToSettings(settings, draft, undefined);
    await this.updateConfiguration(next);
    this.afterConfigChange();

    vscode.window.showInformationMessage(
      "Azure settings cleared successfully.",
    );
  }

  public async setSharingProfileCommand(): Promise<void> {
    const result = await this.azureResourceService.setSharingProfileCommand();
    this.clearQueryCache();
    return result;
  }

  // Helper method for shared key prompting (used by setBackendSharedKey and rotateBackendSharedKey)
  private async promptForAndStoreSharedKey(
    storageAccount: string,
    promptTitle: string,
  ): Promise<boolean> {
    if (!storageAccount) {
      vscode.window.showErrorMessage(
        'Backend storage account is not configured yet. Run "Configure Backend" first.',
      );
      return false;
    }
    const sharedKey = await vscode.window.showInputBox({
      title: promptTitle,
      prompt: `Enter the Storage account Shared Key for '${storageAccount}'. This will be stored securely in VS Code SecretStorage and will not sync across devices.`,
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) =>
        v && v.trim() ? undefined : "Shared Key is required",
    });
    if (!sharedKey) {
      return false;
    }
    await this.credentialService.setStoredStorageSharedKey(
      storageAccount,
      sharedKey,
    );
    return true;
  }
}











