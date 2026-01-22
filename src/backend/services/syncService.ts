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
import type { DailyRollupValue, ChatRequest } from '../types';
import { resolveUserIdentityForSync, type BackendUserIdentityMode } from '../identity';
import { computeBackendSharingPolicy, hashMachineIdForTeam, hashWorkspaceIdForTeam } from '../sharingProfile';
import { createDailyAggEntity } from '../storageTables';
import { CredentialService } from './credentialService';
import { DataPlaneService } from './dataPlaneService';
import { BackendUtility } from './utilityService';

/**
 * CR-009: Validate and normalize consent timestamp.
 * Returns ISO string if valid, undefined if invalid or in the future.
 */
function validateConsentTimestamp(ts: string | undefined): string | undefined {
	if (!ts) {
		return undefined;
	}
	try {
		const parsed = new Date(ts);
		if (isNaN(parsed.getTime()) || parsed.getTime() > Date.now()) {
			return undefined; // Invalid or future date
		}
		return parsed.toISOString();
	} catch {
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
}

/**
 * SyncService manages background synchronization of local session data to the backend.
 */
export class SyncService {
	private backendSyncInProgress = false;
	private syncQueue = Promise.resolve();
	private backendSyncInterval: NodeJS.Timeout | undefined;

	constructor(
		private deps: SyncServiceDeps,
		private credentialService: CredentialService,
		private dataPlaneService: DataPlaneService,
		private utility: typeof BackendUtility
	) {}

	/**
	 * Start the background sync timer if backend is enabled.
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
		for (const sessionFile of sessionFiles) {
			let content: string;
			let fileMtimeMs: number | undefined;
			try {
				const stats = await fs.promises.stat(sessionFile);
				fileMtimeMs = stats.mtimeMs;
				content = await fs.promises.readFile(sessionFile, 'utf8');
			} catch (e) {
				this.deps.warn(`Backend sync: failed to read session file ${sessionFile}: ${e}`);
				continue;
			}

			const workspaceId = this.utility.extractWorkspaceIdFromSessionPath(sessionFile);
			if (!workspaceNamesById[workspaceId]) {
				const resolved = await this.utility.tryResolveWorkspaceNameFromSessionPath(sessionFile);
				if (resolved) {
					workspaceNamesById[workspaceId] = resolved;
				}
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
			let sessionJson: any;
			try {
				sessionJson = JSON.parse(content);
			} catch (e) {
				this.deps.warn(`Backend sync: failed to parse JSON session file ${sessionFile}: ${e}`);
				continue;
			}

			const requests = Array.isArray(sessionJson.requests) ? sessionJson.requests : [];
			for (const request of requests) {
				try {
					const normalizedTs = this.utility.normalizeTimestampToMs(
						typeof request.timestamp !== 'undefined' ? request.timestamp : sessionJson.lastMessageDate
					);
					const eventMs = Number.isFinite(normalizedTs) ? normalizedTs : fileMtimeMs;
					if (!eventMs || eventMs < startMs) {
						continue;
					}
					const dayKey = this.utility.toUtcDayKey(new Date(eventMs));
					const model = this.deps.getModelFromRequest(request);

					let inputTokens = 0;
					let outputTokens = 0;
					if (request.message && request.message.parts) {
						for (const part of request.message.parts) {
							if (part?.text) {
								inputTokens += this.deps.estimateTokensFromText(part.text, model);
							}
						}
					}
					if (request.response && Array.isArray(request.response)) {
						for (const responseItem of request.response) {
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

		return { rollups, workspaceNamesById, machineNamesById };
	}

	/**
	 * Sync local session data to the backend store.
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
				for (const { key, value } of rollups.values()) {
					const effectiveUserId = (key.userId ?? '').trim();
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
						userId: effectiveUserId || undefined,
						userKeyType: resolvedIdentity.userKeyType,
						shareWithTeam: includeConsent ? true : undefined,
						consentAt: validateConsentTimestamp(settings.shareConsentAt),
						inputTokens: value.inputTokens,
						outputTokens: value.outputTokens,
						interactions: value.interactions
					});
					await tableClient.upsertEntity(entity, 'Replace');
				}

				await this.deps.context?.globalState.update('backend.lastSyncAt', Date.now());
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
