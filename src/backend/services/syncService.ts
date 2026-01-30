/**
 * Sync service for backend facade.
 * Handles background sync, timer management, and daily rollup computation.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import { DefaultAzureCredential } from '@azure/identity';
import { safeStringifyError } from '../../utils/errors';
import type { DailyRollupKey } from '../rollups';
import { upsertDailyRollup } from '../rollups';
import type { BackendSettings } from '../settings';
import { BACKEND_SYNC_MIN_INTERVAL_MS } from '../constants';
import type { DailyRollupValue, ChatRequest, SessionFileCache } from '../types';
import { resolveUserIdentityForSync, type BackendUserIdentityMode } from '../identity';
import { computeBackendSharingPolicy, hashMachineIdForTeam, hashWorkspaceIdForTeam } from '../sharingProfile';
import { createDailyAggEntity } from '../storageTables';
import { CredentialService } from './credentialService';
import { DataPlaneService } from './dataPlaneService';
import { BackendUtility } from './utilityService';

/**
 * Validate and normalize consent timestamp.
 * Returns ISO string if valid, undefined if invalid or in the future.
 */
function validateConsentTimestamp(ts: string | undefined, logger?: (msg: string) => void): string | undefined {
	if (!ts) {
		return undefined;
	}
	try {
		const parsed = new Date(ts);
		if (isNaN(parsed.getTime())) {
			if (logger) {
				logger(`Invalid consent timestamp (not a valid date): "${ts}"`);
			}
			return undefined;
		}
		if (parsed.getTime() > Date.now()) {
			if (logger) {
				logger(`Invalid consent timestamp (future date): "${ts}" (parsed: ${parsed.toISOString()})`);
			}
			return undefined;
		}
		return parsed.toISOString();
	} catch (e) {
		if (logger) {
			logger(`Failed to parse consent timestamp: "${ts}", error: ${e}`);
		}
		return undefined;
	}
}

export interface SyncServiceDeps {
	context: vscode.ExtensionContext | undefined;
	log: (message: string) => void;
	warn: (message: string) => void;
	getCopilotSessionFiles: () => Promise<string[]>;
	estimateTokensFromText: (text: string, model: string) => number;
	getModelFromRequest: (request: ChatRequest) => string;
	// Cache integration for performance
	getSessionFileDataCached?: (sessionFilePath: string, mtime: number) => Promise<SessionFileCache>;
}

/**
 * SyncService manages background synchronization of local session data to the backend.
 */
export class SyncService {
	private backendSyncInProgress = false;
	private syncQueue = Promise.resolve();
	private backendSyncInterval: NodeJS.Timeout | undefined;
	private consecutiveFailures = 0;
	private readonly MAX_CONSECUTIVE_FAILURES = 5;

	constructor(
		private readonly deps: SyncServiceDeps,
		private readonly credentialService: CredentialService,
		private readonly dataPlaneService: DataPlaneService,
		private readonly utility: typeof BackendUtility
	) {}

	/**
	 * Start the background sync timer if backend is enabled.
	 * @param settings - Backend settings to check if sync should be enabled
	 * @param isConfigured - Whether the backend is fully configured
	 */
	startTimerIfEnabled(settings: BackendSettings, isConfigured: boolean): void {
		try {
			this.stopTimer();
			const sharingPolicy = computeBackendSharingPolicy({
				enabled: settings.enabled,
				profile: settings.sharingProfile,
				shareWorkspaceMachineNames: settings.shareWorkspaceMachineNames
			});
			if (!sharingPolicy.allowCloudSync || !isConfigured) {
				return;
			}
			const intervalMs = Math.max(BACKEND_SYNC_MIN_INTERVAL_MS, settings.lookbackDays * 60 * 1000);
			this.deps.log(`Backend sync: starting timer with interval ${intervalMs}ms`);
			this.backendSyncInterval = setInterval(() => {
				this.syncToBackendStore(false, settings, isConfigured).catch((e) => {
					this.deps.warn(`Backend sync timer failed: ${e?.message ?? e}`);
					this.consecutiveFailures++;
					
					// Show user-facing warning after first few failures
					if (this.consecutiveFailures === 3) {
						vscode.window.showWarningMessage(
							'Backend sync is experiencing issues. Check the output panel for details.',
							'Show Output'
						).then(choice => {
							if (choice === 'Show Output') {
								// User can manually open output panel via command palette
							}
						});
					}
					
					if (this.consecutiveFailures >= this.MAX_CONSECUTIVE_FAILURES) {
						this.deps.warn(`Backend sync: stopping timer after ${this.MAX_CONSECUTIVE_FAILURES} consecutive failures`);
						vscode.window.showErrorMessage(
							'Backend sync stopped after repeated failures. Check your Azure configuration.',
							'Configure Backend'
						).then(choice => {
							if (choice === 'Configure Backend') {
								vscode.commands.executeCommand('copilotTokenTracker.configureBackend');
							}
						});
						this.stopTimer();
					}
				});
			}, intervalMs);
			// Immediate initial sync
			this.syncToBackendStore(false, settings, isConfigured).catch((e) => {
				this.deps.warn(`Backend sync initial sync failed: ${e?.message ?? e}`);
			});
		} catch (e) {
			this.deps.warn(`Backend sync timer setup failed: ${e}`);
		}
	}

	/**
	 * Stop the background sync timer.
	 */
	stopTimer(): void {
		if (this.backendSyncInterval) {
			clearInterval(this.backendSyncInterval);
			this.backendSyncInterval = undefined;
			this.consecutiveFailures = 0;
		}
	}

	/**
	 * Dispose the sync service.
	 */
	dispose(): void {
		this.stopTimer();
	}

	/**
	 * Get the current sync queue promise (for testing).
	 */
	getSyncQueue(): Promise<void> {
		return this.syncQueue;
	}

	/**
	 * Process a session file using cached data.
	 * Returns true if successful, false if cache miss (caller should parse file).
	 * Validates all cached data at runtime to prevent injection/corruption.
	 */
	private async processCachedSessionFile(
		sessionFile: string,
		fileMtimeMs: number,
		workspaceId: string,
		machineId: string,
		userId: string | undefined,
		rollups: Map<string, { key: DailyRollupKey; value: DailyRollupValue }>
	): Promise<boolean> {
		try {
			const cachedData = await this.deps.getSessionFileDataCached!(sessionFile, fileMtimeMs);
			
			// Validate cached data structure to prevent injection/corruption
			if (!cachedData || typeof cachedData !== 'object') {
				this.deps.warn(`Backend sync: invalid cached data structure for ${sessionFile}`);
				return false;
			}
			if (typeof cachedData.modelUsage !== 'object' || cachedData.modelUsage === null) {
				this.deps.warn(`Backend sync: invalid modelUsage in cached data for ${sessionFile}`);
				return false;
			}
			if (!Number.isFinite(cachedData.interactions) || cachedData.interactions < 0) {
				this.deps.warn(`Backend sync: invalid interactions count in cached data for ${sessionFile}`);
				return false;
			}
			
			// Expand cached modelUsage into rollups
			const dayKey = this.utility.toUtcDayKey(new Date(fileMtimeMs));
			
			// CRITICAL FIX: Only assign interactions to first model to prevent inflation
			// When a file has multiple models, interactions should be counted once, not per-model
			let interactionsAssigned = false;
			
			for (const [model, usage] of Object.entries(cachedData.modelUsage)) {
				// Validate usage object structure
				if (!usage || typeof usage !== 'object') {
					this.deps.warn(`Backend sync: invalid usage object for model ${model} in ${sessionFile}`);
					continue;
				}
				if (!Number.isFinite(usage.inputTokens) || usage.inputTokens < 0) {
					this.deps.warn(`Backend sync: invalid inputTokens for model ${model} in ${sessionFile}`);
					continue;
				}
				if (!Number.isFinite(usage.outputTokens) || usage.outputTokens < 0) {
					this.deps.warn(`Backend sync: invalid outputTokens for model ${model} in ${sessionFile}`);
					continue;
				}
				
				const key: DailyRollupKey = { day: dayKey, model, workspaceId, machineId, userId };
				// Only assign interactions to the first valid model to prevent inflation
				const interactionsForThisModel = interactionsAssigned ? 0 : cachedData.interactions;
				interactionsAssigned = true;
				
				upsertDailyRollup(rollups, key, {
					inputTokens: usage.inputTokens,
					outputTokens: usage.outputTokens,
					interactions: interactionsForThisModel
				});
			}
			return true;
		} catch (e) {
			// Differentiate between cache miss (expected) and errors (unexpected)
			const errorMessage = e instanceof Error ? e.message : String(e);
			if (errorMessage.includes('ENOENT') || errorMessage.includes('not found')) {
				// Expected cache miss - file doesn't exist or not cached yet
				return false;
			} else {
				// Unexpected error - log as warning
				this.deps.warn(`Backend sync: cache error for ${sessionFile}: ${errorMessage}`);
				return false;
			}
		}
	}

	/**
	 * Resolve workspace name from session path if not already resolved.
	 */
	private async ensureWorkspaceNameResolved(
		workspaceId: string,
		sessionFile: string,
		workspaceNamesById: Record<string, string>
	): Promise<void> {
		if (!workspaceNamesById[workspaceId]) {
			const resolved = await this.utility.tryResolveWorkspaceNameFromSessionPath(sessionFile);
			if (resolved) {
				workspaceNamesById[workspaceId] = resolved;
			}
		}
	}

	/**
	 * Log cache performance statistics.
	 */
	private logCachePerformance(cacheHits: number, cacheMisses: number): void {
		const totalFiles = cacheHits + cacheMisses;
		if (totalFiles === 0) {return;}
		
		const hitRate = ((cacheHits / totalFiles) * 100).toFixed(1);
		this.deps.log(`Backend sync: Cache performance - Hits: ${cacheHits}, Misses: ${cacheMisses}, Hit Rate: ${hitRate}%`);
	}

	/**
	 * Resolve the effective user identity for sync.
	 */
	private async resolveEffectiveUserIdentityForSync(settings: BackendSettings, includeUserDimension: boolean): Promise<{ userId?: string; userKeyType?: BackendUserIdentityMode }> {
		let accessTokenForClaims: string | undefined;
		if (includeUserDimension && settings.userIdentityMode === 'pseudonymous' && settings.authMode === 'entraId') {
			try {
				const token = await new DefaultAzureCredential().getToken('https://storage.azure.com/.default');
				accessTokenForClaims = token?.token;
			} catch {
				// Best-effort only: fall back to omitting user dimension.
			}
		}

		const resolved = resolveUserIdentityForSync({
			shareWithTeam: includeUserDimension,
			userIdentityMode: settings.userIdentityMode,
			configuredUserId: settings.userId,
			datasetId: settings.datasetId,
			accessTokenForClaims
		});
		return resolved;
	}

	/**
	 * Compute daily rollups from local session files.
	 * Uses cached session data when available to avoid re-parsing files.
	 */
	private async computeDailyRollupsFromLocalSessions(args: { lookbackDays: number; userId?: string }): Promise<{
		rollups: Map<string, { key: DailyRollupKey; value: DailyRollupValue }>;
		workspaceNamesById: Record<string, string>;
		machineNamesById: Record<string, string>;
	}> {
		const lookbackDays = args.lookbackDays;
		const userId = (args.userId ?? '').trim() || undefined;
		const now = new Date();
		// Include all events from the start of the first day in the range (UTC).
		const start = new Date(now.getTime());
		start.setUTCHours(0, 0, 0, 0);
		start.setUTCDate(start.getUTCDate() - (lookbackDays - 1));
		const startMs = start.getTime();

		const machineId = vscode.env.machineId;
		const rollups = new Map<string, { key: DailyRollupKey; value: DailyRollupValue }>();
		const workspaceNamesById: Record<string, string> = {};
		const machineNamesById: Record<string, string> = {};
		const machineName = this.utility.normalizeNameForStorage(this.utility.stripHostnameDomain(os.hostname()));
		if (machineName) {
			machineNamesById[machineId] = machineName;
		}

		const sessionFiles = await this.deps.getCopilotSessionFiles();
		const useCachedData = !!this.deps.getSessionFileDataCached;
		let cacheHits = 0;
		let cacheMisses = 0;

		for (const sessionFile of sessionFiles) {
			let fileMtimeMs: number | undefined;
			
			try {
				const fileStat = await fs.promises.stat(sessionFile);
				fileMtimeMs = fileStat.mtimeMs;
				
				// Skip files older than lookback period
				if (fileMtimeMs < startMs) {
					continue;
				}
			} catch (e) {
				this.deps.warn(`Backend sync: failed to stat session file ${sessionFile}: ${e}`);
				continue;
			}

			const workspaceId = this.utility.extractWorkspaceIdFromSessionPath(sessionFile);
			await this.ensureWorkspaceNameResolved(workspaceId, sessionFile, workspaceNamesById);

			// Try to use cached data first (much faster than parsing)
			if (useCachedData) {
				const cacheSuccess = await this.processCachedSessionFile(
					sessionFile,
					fileMtimeMs,
					workspaceId,
					machineId,
					userId,
					rollups
				);
				
				if (cacheSuccess) {
					cacheHits++;
					continue;
				} else {
					cacheMisses++;
				}
			}

			// Fallback: parse file directly (legacy path or cache unavailable)
			let content: string;
			try {
				content = await fs.promises.readFile(sessionFile, 'utf8');
			} catch (e) {
				this.deps.warn(`Backend sync: failed to read session file ${sessionFile}: ${e}`);
				continue;
			}
			// JSONL (Copilot CLI)
			if (sessionFile.endsWith('.jsonl')) {
				const lines = content.trim().split('\n');
				for (const line of lines) {
					if (!line.trim()) {
						continue;
					}
					try {
						const event = JSON.parse(line);
						if (!event || typeof event !== 'object') {
							continue;
						}
						const normalizedTs = this.utility.normalizeTimestampToMs(event.timestamp);
						const eventMs = Number.isFinite(normalizedTs) ? normalizedTs : fileMtimeMs;
						if (!eventMs || eventMs < startMs) {
							continue;
						}
						const dayKey = this.utility.toUtcDayKey(new Date(eventMs));
						const model = (event.model || 'gpt-4o').toString();

						let inputTokens = 0;
						let outputTokens = 0;
						let interactions = 0;
						if (event.type === 'user.message' && event.data?.content) {
							inputTokens = this.deps.estimateTokensFromText(event.data.content, model);
							interactions = 1;
						} else if (event.type === 'assistant.message' && event.data?.content) {
							outputTokens = this.deps.estimateTokensFromText(event.data.content, model);
						} else if (event.type === 'tool.result' && event.data?.output) {
							inputTokens = this.deps.estimateTokensFromText(event.data.output, model);
						}
						if (inputTokens === 0 && outputTokens === 0 && interactions === 0) {
							continue;
						}

						const key: DailyRollupKey = { day: dayKey, model, workspaceId, machineId, userId };
						upsertDailyRollup(rollups as any, key, { inputTokens, outputTokens, interactions });
					} catch {
						// skip malformed line
					}
				}
				continue;
			}

			// JSON (VS Code Copilot Chat)
			let sessionJson: unknown;
			try {
				sessionJson = JSON.parse(content);
				if (!sessionJson || typeof sessionJson !== 'object') {
					this.deps.warn(`Backend sync: session file has invalid JSON structure: ${sessionFile}`);
					continue;
				}
			} catch (e) {
				this.deps.warn(`Backend sync: failed to parse JSON session file ${sessionFile}: ${e}`);
				continue;
			}
			const sessionObj = sessionJson as Record<string, unknown>; // Safe due to check above

			const requests = Array.isArray(sessionObj.requests) ? (sessionObj.requests as unknown[]) : [];
			for (const request of requests) {
				try {
					// Cast to ChatRequest since it comes from validated JSON object
					const req = request as ChatRequest;
					const normalizedTs = this.utility.normalizeTimestampToMs(
						typeof req.timestamp !== 'undefined' ? req.timestamp : (sessionObj.lastMessageDate as unknown)
					);
					const eventMs = Number.isFinite(normalizedTs) ? normalizedTs : fileMtimeMs;
					if (!eventMs || eventMs < startMs) {
						continue;
					}
					const dayKey = this.utility.toUtcDayKey(new Date(eventMs));
					const model = this.deps.getModelFromRequest(req);

					let inputTokens = 0;
					let outputTokens = 0;
					if (req.message && req.message.parts) {
						for (const part of req.message.parts) {
							if (part?.text) {
								inputTokens += this.deps.estimateTokensFromText(part.text, model);
							}
						}
					}
					if (req.response && Array.isArray(req.response)) {
						for (const responseItem of req.response) {
							if (typeof responseItem?.value === 'string') {
								outputTokens += this.deps.estimateTokensFromText(responseItem.value, model);
							}
						}
					}
					if (inputTokens === 0 && outputTokens === 0) {
						continue;
					}

					const key: DailyRollupKey = { day: dayKey, model, workspaceId, machineId, userId };
					upsertDailyRollup(rollups as any, key, { inputTokens, outputTokens, interactions: 1 });
				} catch (e) {
					this.deps.warn(`Backend sync: failed to process request in ${sessionFile}: ${e}`);
				}
			}
		}

		// Log cache performance statistics
		if (useCachedData) {
			this.logCachePerformance(cacheHits, cacheMisses);
		}

		return { rollups, workspaceNamesById, machineNamesById };
	}

	/**
	 * Sync local session data to the backend store.
	 * @param force - If true, forces sync even if recently synced
	 * @param settings - Backend settings for sync configuration
	 * @param isConfigured - Whether the backend is fully configured
	 * @throws Error if sync fails due to network or auth issues
	 */
	async syncToBackendStore(force: boolean, settings: BackendSettings, isConfigured: boolean): Promise<void> {
		this.syncQueue = this.syncQueue.then(async () => {
			if (this.backendSyncInProgress) {
				return;
			}
			const sharingPolicy = computeBackendSharingPolicy({
				enabled: settings.enabled,
				profile: settings.sharingProfile,
				shareWorkspaceMachineNames: settings.shareWorkspaceMachineNames
			});
			if (!sharingPolicy.allowCloudSync || !isConfigured) {
				return;
			}

			// Avoid excessive syncing when UI refreshes frequently.
			const lastSyncAt = this.deps.context?.globalState.get<number>('backend.lastSyncAt');
			if (!force && lastSyncAt && Date.now() - lastSyncAt < BACKEND_SYNC_MIN_INTERVAL_MS) {
				return;
			}

			this.backendSyncInProgress = true;
			try {
				this.deps.log('Backend sync: starting rollup sync');
				const creds = await this.credentialService.getBackendDataPlaneCredentials(settings);
				if (!creds) {
					// Shared Key mode selected but key not available (or user canceled). Keep local mode functional.
					return;
				}
				await this.dataPlaneService.ensureTableExists(settings, creds.tableCredential);
				await this.dataPlaneService.validateAccess(settings, creds.tableCredential);

				const resolvedIdentity = await this.resolveEffectiveUserIdentityForSync(settings, sharingPolicy.includeUserDimension);
				const { rollups, workspaceNamesById, machineNamesById } = await this.computeDailyRollupsFromLocalSessions({ lookbackDays: settings.lookbackDays, userId: resolvedIdentity.userId });
				this.deps.log(`Backend sync: upserting ${rollups.size} rollup entities (lookback ${settings.lookbackDays} days)`);

				const tableClient = this.dataPlaneService.createTableClient(settings, creds.tableCredential);
				const entities = [];
				for (const { key, value } of rollups.values()) {
					const effectiveUserId = (key.userId ?? '').trim() || undefined;
					const includeConsent = sharingPolicy.includeUserDimension && !!effectiveUserId;
					const includeNames = sharingPolicy.includeNames;
					const workspaceIdToStore = sharingPolicy.workspaceIdStrategy === 'hashed'
						? hashWorkspaceIdForTeam({ datasetId: settings.datasetId, workspaceId: key.workspaceId })
						: key.workspaceId;
					const machineIdToStore = sharingPolicy.machineIdStrategy === 'hashed'
						? hashMachineIdForTeam({ datasetId: settings.datasetId, machineId: key.machineId })
						: key.machineId;
					const workspaceName = includeNames ? workspaceNamesById[key.workspaceId] : undefined;
					const machineName = includeNames ? machineNamesById[key.machineId] : undefined;
					const entity = createDailyAggEntity({
						datasetId: settings.datasetId,
						day: key.day,
						model: key.model,
						workspaceId: workspaceIdToStore,
						workspaceName,
						machineId: machineIdToStore,
						machineName,
						userId: effectiveUserId,
						userKeyType: resolvedIdentity.userKeyType,
						shareWithTeam: includeConsent ? true : undefined,
						consentAt: validateConsentTimestamp(settings.shareConsentAt, this.deps.log),
						inputTokens: value.inputTokens,
						outputTokens: value.outputTokens,
						interactions: value.interactions
					});
					entities.push(entity);
				}

				const { successCount, errors } = await this.dataPlaneService.upsertEntitiesBatch(tableClient, entities);
				
				if (errors.length > 0) {
					this.deps.warn(`Backend sync: ${successCount}/${entities.length} entities synced successfully, ${errors.length} failed`);
				} else {
					this.deps.log(`Backend sync: ${successCount} entities synced successfully`);
				}

				this.consecutiveFailures = 0;

				try {
					await this.deps.context?.globalState.update('backend.lastSyncAt', Date.now());
				} catch (e) {
					this.deps.warn(`Backend sync: failed to update lastSyncAt: ${e}`);
				}
				
				this.deps.log('Backend sync: completed');
			} catch (e: any) {
				// Keep local mode functional.
				const secretsToRedact = await this.credentialService.getBackendSecretsToRedactForError(settings);
				this.deps.warn(`Backend sync: ${safeStringifyError(e, secretsToRedact)}`);
			} finally {
				this.backendSyncInProgress = false;
			}
		});
		return this.syncQueue;
	}
}
