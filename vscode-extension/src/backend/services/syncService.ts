/**
 * Sync service for backend facade.
 * Handles background sync, timer management, and daily rollup computation.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
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
import { SharingServerUploadService, type SharingServerEntry } from './sharingServerUploadService';
import { isJsonlContent } from '../../tokenEstimation';

/**
 * Interface for blob upload service to avoid circular dependency.
 */
interface BlobUploadServiceLike {
	uploadSessionFiles(
		storageAccount: string,
		settings: { enabled: boolean; containerName: string; uploadFrequencyHours: number; compressFiles: boolean },
		credential: any,
		sessionFiles: string[],
		machineId: string,
		datasetId: string
	): Promise<{ success: boolean; filesUploaded: number; message: string }>;
	shouldUpload(machineId: string, settings: { enabled: boolean; uploadFrequencyHours: number }): boolean;
	getUploadStatus(machineId: string): { lastUploadTime: number; filesUploaded: number; lastError?: string } | undefined;
}

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
	getSessionFileDataCached?: (sessionFilePath: string, mtime: number, fileSize: number) => Promise<SessionFileCache>;
	// UI refresh callback after successful sync
	updateTokenStats?: () => Promise<void>;
	// Stat helper for OpenCode DB virtual paths
	statSessionFile: (sessionFile: string) => Promise<fs.Stats>;
	// OpenCode session handling
	isOpenCodeSession?: (sessionFile: string) => boolean;
	getOpenCodeSessionData?: (sessionFile: string) => Promise<{ tokens: number; interactions: number; modelUsage: any; timestamp: number }>;
	// Crush session handling (per-project crush.db virtual paths)
	isCrushSession?: (sessionFile: string) => boolean;
	getCrushSessionData?: (sessionFile: string) => Promise<{ tokens: number; interactions: number; modelUsage: any; timestamp: number }>;
	// Visual Studio session detection (binary MessagePack — cannot be parsed as JSON)
	isVSSessionFile?: (sessionFile: string) => boolean;
	/** Returns the current GitHub OAuth access token, or undefined if not authenticated. */
	getGithubToken?: () => string | undefined;
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
	/** Stale threshold for the sync lock file (matches the sync timer interval). */
	private static readonly SYNC_LOCK_STALE_MS = BACKEND_SYNC_MIN_INTERVAL_MS;

	constructor(
		private readonly deps: SyncServiceDeps,
		private readonly credentialService: CredentialService,
		private readonly dataPlaneService: DataPlaneService,
		private readonly blobUploadService: BlobUploadServiceLike | undefined,
		private readonly utility: typeof BackendUtility,
		private readonly sharingServerUploadService: SharingServerUploadService | undefined,
	) {}

	// ── Cross-instance file lock ────────────────────────────────────────

	/**
	 * Path for the sync lock file.  Uses globalStorageUri which is already
	 * scoped per VS Code edition (stable vs insiders).
	 */
	private getSyncLockPath(): string | undefined {
		const ctx = this.deps.context;
		if (!ctx) { return undefined; }
		return path.join(ctx.globalStorageUri.fsPath, 'backend_sync.lock');
	}

	/**
	 * Try to acquire an exclusive file lock so only one VS Code window
	 * can run a backend sync at a time.
	 */
	private async acquireSyncLock(): Promise<boolean> {
		const lockPath = this.getSyncLockPath();
		if (!lockPath) { return true; } // No context → allow (tests)
		try {
			await fs.promises.mkdir(path.dirname(lockPath), { recursive: true });
			const fd = await fs.promises.open(lockPath, 'wx');
			await fd.writeFile(JSON.stringify({
				sessionId: vscode.env.sessionId,
				timestamp: Date.now()
			}));
			await fd.close();
			return true;
		} catch (err: any) {
			if (err.code !== 'EEXIST') {
				this.deps.warn(`Sync lock: unexpected error acquiring lock: ${err.message}`);
				return false;
			}
			// Lock file exists — check if stale
			try {
				const content = await fs.promises.readFile(lockPath, 'utf-8');
				const lock = JSON.parse(content);
				if (Date.now() - lock.timestamp > SyncService.SYNC_LOCK_STALE_MS) {
					this.deps.log('Sync lock: breaking stale lock from another window');
					await fs.promises.unlink(lockPath);
					try {
						const fd = await fs.promises.open(lockPath, 'wx');
						await fd.writeFile(JSON.stringify({
							sessionId: vscode.env.sessionId,
							timestamp: Date.now()
						}));
						await fd.close();
						return true;
					} catch {
						return false;
					}
				}
			} catch {
				// Lock file may have been deleted by its owner
			}
			return false;
		}
	}

	/**
	 * Release the sync lock, but only if we own it.
	 */
	private async releaseSyncLock(): Promise<void> {
		const lockPath = this.getSyncLockPath();
		if (!lockPath) { return; }
		try {
			const content = await fs.promises.readFile(lockPath, 'utf-8');
			const lock = JSON.parse(content);
			if (lock.sessionId === vscode.env.sessionId) {
				await fs.promises.unlink(lockPath);
			}
		} catch {
			// Lock file already gone or unreadable
		}
	}

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
				if (!sharingPolicy.allowCloudSync) {
					this.deps.log(`Backend sync: not starting timer (cloud sync disabled, profile: ${settings.sharingProfile})`);
				} else if (!isConfigured) {
					this.deps.log('Backend sync: not starting timer (backend not configured)');
				}
				return;
			}
			const intervalMs = BACKEND_SYNC_MIN_INTERVAL_MS;
			this.deps.log(`Backend sync: starting timer with interval ${intervalMs}ms (${intervalMs / 60000} minutes)`);
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
								vscode.commands.executeCommand('aiEngineeringFluency.configureBackend');
							}
						});
						this.stopTimer();
					}
				});
			}, intervalMs);
			// Immediate initial sync (forced to ensure settings changes take effect)
			this.syncToBackendStore(true, settings, isConfigured).catch((e) => {
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
	 * Process a session file using cached data for token counts but extracting accurate timestamps.
	 * Returns true if successful, false if cache miss (caller should parse file).
	 * Validates all cached data at runtime to prevent injection/corruption.
	 * 
	 * CRITICAL: We parse the file to extract actual interaction timestamps and create per-day
	 * rollups, but use cached token counts for performance. This ensures accurate day assignment
	 * while still benefiting from cached calculations.
	 */
	private async processCachedSessionFile(
		sessionFile: string,
		fileMtimeMs: number,
		fileSize: number,
		workspaceId: string,
		machineId: string,
		userId: string | undefined,
		rollups: Map<string, { key: DailyRollupKey; value: DailyRollupValue }>,
		startMs: number,
		now: Date
	): Promise<boolean> {
		try {
			const cachedData = await this.deps.getSessionFileDataCached!(sessionFile, fileMtimeMs, fileSize);
			
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
			
			// Parse the session file to get actual request timestamps and create per-day rollups
			// This ensures accurate day assignment while using cached token counts
			const content = await fs.promises.readFile(sessionFile, 'utf8');
			
			// Map to track per-day per-model interactions for proper distribution
			const dayModelInteractions = new Map<string, Map<string, number>>();
			
			// Detect whether this is a delta-based (VS Code Insiders) JSONL file or a CLI JSONL file.
			// Both can use .jsonl extension, but delta-based files have kind:0/1/2 numeric events
			// while CLI files use event types like user.message, assistant.message, etc.
			// Check the first non-empty line for a numeric "kind" property to distinguish.
			let isDeltaBasedJsonl = false;
			if (isJsonlContent(content)) {
				const firstLine = content.trim().split('\n')[0]?.trim();
				if (firstLine) {
					try {
						const firstEvent = JSON.parse(firstLine);
						isDeltaBasedJsonl = typeof firstEvent.kind === 'number';
					} catch { /* not valid JSON, leave as false */ }
				}
			}

			// Handle non-delta JSONL format (Copilot CLI)
			if (sessionFile.endsWith('.jsonl') && !isDeltaBasedJsonl) {
				const lines = content.trim().split('\n');
			const todayKey = this.utility.toUtcDayKey(now);
			let lineCount = 0;
			let processedLines = 0;
			
			for (const line of lines) {
				lineCount++;
				if (!line.trim()) { continue; }
				try {
					const event = JSON.parse(line);
					if (!event || typeof event !== 'object') { continue; }
					
					const normalizedTs = this.utility.normalizeTimestampToMs(event.timestamp);
					const eventMs = Number.isFinite(normalizedTs) ? normalizedTs : fileMtimeMs;
					if (!eventMs || eventMs < startMs) { continue; }
					
					const dayKey = this.utility.toUtcDayKey(new Date(eventMs));
					const model = (event.model || 'gpt-4o').toString();
					const isFileFromToday = dayKey === todayKey;
					if (isFileFromToday && processedLines < 3) {
					this.deps.log(`Backend sync: file ${sessionFile.split(/[/\\]/).pop()} line ${lineCount}: eventMs=${new Date(eventMs).toISOString()}, dayKey=${dayKey}, type=${event.type}`);
					processedLines++;
				}
						// Track interaction for this day+model (count all events, not just user.message)
						if (!dayModelInteractions.has(dayKey)) {
							dayModelInteractions.set(dayKey, new Map());
						}
						const dayMap = dayModelInteractions.get(dayKey)!;
						dayMap.set(model, (dayMap.get(model) || 0) + 1);
					} catch {
						// skip malformed line
					}
				}
			} else if (isDeltaBasedJsonl) {
				// VS Code delta-based JSONL files (.json or .jsonl extension with kind:0/1/2 events).
				// Process kind:2 events where k[0]==='requests' — each appends requests to the array.
				// Deduplicate by requestId so incrementally-added requests are counted once.
				// Track the session-level defaultModel from kind:0 and kind:2/selectedModel events so
				// that requests without an explicit modelId still resolve to the correct model key
				// (matching what getModelUsageFromSession stores in cachedData.modelUsage).
				let defaultModel = 'gpt-4o';
				const seenRequestIds = new Set<string>();
				const lines = content.trim().split('\n');
				for (const line of lines) {
					if (!line.trim()) { continue; }
					try {
						const event = JSON.parse(line);
						if (!event || typeof event !== 'object') { continue; }
						// Extract session-level default model (same logic as getModelUsageFromSession)
						if (event.kind === 0) {
							const modelId = event.v?.selectedModel?.identifier ||
								event.v?.selectedModel?.metadata?.id ||
								event.v?.inputState?.selectedModel?.metadata?.id;
							if (modelId) { defaultModel = modelId.replace(/^copilot\//, ''); }
						}
						if (event.kind === 2 && Array.isArray(event.k) && event.k[0] === 'selectedModel') {
							const modelId = event.v?.identifier || event.v?.metadata?.id;
							if (modelId) { defaultModel = modelId.replace(/^copilot\//, ''); }
						}
						// kind:2, k[0]==='requests' events append new request(s)
						if (event.kind === 2 && Array.isArray(event.k) && event.k[0] === 'requests' && Array.isArray(event.v)) {
							for (const request of event.v) {
								const req = request as ChatRequest;
								const reqId = (req as any).requestId as string | undefined;
								if (reqId && seenRequestIds.has(reqId)) { continue; }
								if (reqId) { seenRequestIds.add(reqId); }
								const normalizedTs = this.utility.normalizeTimestampToMs(
									typeof req.timestamp !== 'undefined' ? req.timestamp : undefined
								);
								const eventMs = Number.isFinite(normalizedTs) ? normalizedTs : fileMtimeMs;
								if (!eventMs || eventMs < startMs) { continue; }
								const dayKey = this.utility.toUtcDayKey(new Date(eventMs));
								// Use per-request modelId if present, otherwise fall back to the session
								// default model (mirrors getModelUsageFromSession delta logic)
								const rawModel = (req as any).modelId || (req as any).result?.metadata?.modelId;
								const model = rawModel ? (rawModel as string).replace(/^copilot\//, '') : defaultModel;
								if (!dayModelInteractions.has(dayKey)) {
									dayModelInteractions.set(dayKey, new Map());
								}
								const dayMap = dayModelInteractions.get(dayKey)!;
								dayMap.set(model, (dayMap.get(model) || 0) + 1);
							}
						}
					} catch {
						// skip malformed lines
					}
				}
			} else {
				// Handle regular JSON format (VS Code Copilot Chat legacy / OpenCode JSON)
				try {
					const sessionJson = JSON.parse(content);
					if (!sessionJson || typeof sessionJson !== 'object') {
						return false;
					}
					const sessionObj = sessionJson as Record<string, unknown>;
					const requests = Array.isArray(sessionObj.requests) ? (sessionObj.requests as unknown[]) : [];
					
					for (const request of requests) {
						const req = request as ChatRequest;
						const normalizedTs = this.utility.normalizeTimestampToMs(
							typeof req.timestamp !== 'undefined' ? req.timestamp : (sessionObj.lastMessageDate as unknown)
						);
						const eventMs = Number.isFinite(normalizedTs) ? normalizedTs : fileMtimeMs;
						if (!eventMs || eventMs < startMs) { continue; }
						
						const dayKey = this.utility.toUtcDayKey(new Date(eventMs));
						const model = this.deps.getModelFromRequest(req);

						// Track interaction for this day+model
						if (!dayModelInteractions.has(dayKey)) {
							dayModelInteractions.set(dayKey, new Map());
						}
						const dayMap = dayModelInteractions.get(dayKey)!;
						dayMap.set(model, (dayMap.get(model) || 0) + 1);
					}
				} catch (e) {
					this.deps.warn(`Backend sync: failed to parse JSON for ${sessionFile}: ${e}`);
					return false;
				}
			}
			
			// Remap event model names to cached model names when there is a mismatch.
			// CLI sessions often omit the model in individual events (defaulting to 'gpt-4o')
			// while session.shutdown provides the actual model (e.g. 'claude-sonnet-4.6').
			// Without remapping, the lookup `cachedData.modelUsage[eventModel]` silently fails.
			const cachedModelNames = Object.keys(cachedData.modelUsage);
			if (cachedModelNames.length > 0) {
				const allEventModels = new Set<string>();
				for (const modelMap of dayModelInteractions.values()) {
					for (const m of modelMap.keys()) { allEventModels.add(m); }
				}
				const unmappedModels = new Set<string>();
				for (const m of allEventModels) {
					if (!cachedData.modelUsage[m]) { unmappedModels.add(m); }
				}
				if (unmappedModels.size > 0) {
					const totalCachedTokens = cachedModelNames.reduce((sum, m) =>
						sum + cachedData.modelUsage[m].inputTokens + cachedData.modelUsage[m].outputTokens, 0);
					for (const [, modelMap] of dayModelInteractions) {
						let unmappedCount = 0;
						for (const um of unmappedModels) {
							unmappedCount += modelMap.get(um) || 0;
							modelMap.delete(um);
						}
						if (unmappedCount > 0) {
							for (const cm of cachedModelNames) {
								const ct = cachedData.modelUsage[cm].inputTokens + cachedData.modelUsage[cm].outputTokens;
								const share = totalCachedTokens > 0 ? ct / totalCachedTokens : 1 / cachedModelNames.length;
								const redistributed = Math.round(unmappedCount * share);
								if (redistributed > 0) {
									modelMap.set(cm, (modelMap.get(cm) || 0) + redistributed);
								}
							}
						}
					}
				}
			}

			// Now distribute cached token counts proportionally across day+model combinations
			// based on the actual interaction distribution we just calculated
			for (const [dayKey, modelMap] of dayModelInteractions) {
				for (const [model, interactions] of modelMap) {
					const cachedUsage = cachedData.modelUsage[model];
					if (!cachedUsage) { continue; }
					
					// Validate usage object structure
					if (!Number.isFinite(cachedUsage.inputTokens) || cachedUsage.inputTokens < 0) {
						this.deps.warn(`Backend sync: invalid inputTokens for model ${model}`);
						continue;
					}
					if (!Number.isFinite(cachedUsage.outputTokens) || cachedUsage.outputTokens < 0) {
						this.deps.warn(`Backend sync: invalid outputTokens for model ${model}`);
						continue;
					}
					
					const key: DailyRollupKey = { day: dayKey, model, workspaceId, machineId, userId };
					
					// For simplicity, if a file spans multiple days, distribute tokens proportionally
					// In practice, most session files are from a single day, so this is accurate
					const totalInteractionsForModel = Array.from(dayModelInteractions.values())
						.reduce((sum, m) => sum + (m.get(model) || 0), 0);
					
					const tokenRatio = totalInteractionsForModel > 0 ? interactions / totalInteractionsForModel : 1;
					
					// Extract fluency metrics from cached usage analysis (if available)
					const fluencyMetrics = this.extractFluencyMetricsFromCache(cachedData, tokenRatio);
					
					upsertDailyRollup(rollups, key, {
						inputTokens: Math.round(cachedUsage.inputTokens * tokenRatio),
						outputTokens: Math.round(cachedUsage.outputTokens * tokenRatio),
						interactions: interactions,
						fluencyMetrics
					});
				}
			}
			
			// Log if this file had data for multiple days (for debugging)
			if (dayModelInteractions.size > 1) {
				const days = Array.from(dayModelInteractions.keys()).sort();
				this.deps.log(`Backend sync: file ${sessionFile.split(/[/\\]/).pop()} spans ${days.length} days: ${days.join(', ')}`);
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
	 * Extract fluency metrics from cached session data and serialize for storage.
	 * @param cachedData - The cached session file data
	 * @param ratio - Optional ratio to proportionally distribute metrics (for multi-day sessions)
	 * @returns Fluency metrics object ready for storage
	 */
	private extractFluencyMetricsFromCache(cachedData: any, ratio: number = 1): any {
		if (!cachedData.usageAnalysis) {
			return undefined;
		}

		const analysis = cachedData.usageAnalysis;
		const fluencyMetrics: any = {};

		// Extract mode usage counts
		if (analysis.modeUsage) {
			fluencyMetrics.askModeCount = Math.round((analysis.modeUsage.ask || 0) * ratio);
			fluencyMetrics.editModeCount = Math.round((analysis.modeUsage.edit || 0) * ratio);
			fluencyMetrics.agentModeCount = Math.round((analysis.modeUsage.agent || 0) * ratio);
			fluencyMetrics.planModeCount = Math.round((analysis.modeUsage.plan || 0) * ratio);
			fluencyMetrics.customAgentModeCount = Math.round((analysis.modeUsage.customAgent || 0) * ratio);
		}

		// Serialize complex objects as JSON
		if (analysis.toolCalls) {
			fluencyMetrics.toolCallsJson = JSON.stringify(analysis.toolCalls);
		}

		if (analysis.contextReferences) {
			fluencyMetrics.contextRefsJson = JSON.stringify(analysis.contextReferences);
		}

		if (analysis.mcpTools) {
			fluencyMetrics.mcpToolsJson = JSON.stringify(analysis.mcpTools);
		}

		if (analysis.modelSwitching) {
			fluencyMetrics.modelSwitchingJson = JSON.stringify(analysis.modelSwitching);
		}

		// NEW: Store editScope for full agentic scoring
		if (analysis.editScope) {
			fluencyMetrics.editScopeJson = JSON.stringify(analysis.editScope);
			// Also store direct fields for easier querying
			fluencyMetrics.multiFileEdits = analysis.editScope.multiFileEdits || 0;
			fluencyMetrics.avgFilesPerEdit = analysis.editScope.avgFilesPerSession || 0;
		}

		// NEW: Store agentTypes for tool usage scoring
		if (analysis.agentTypes) {
			fluencyMetrics.agentTypesJson = JSON.stringify(analysis.agentTypes);
		}

		// NEW: Store repositories for customization scoring
		if (analysis.repositories || analysis.repositoriesWithCustomization) {
			const repoData = {
				repositories: analysis.repositories || [],
				repositoriesWithCustomization: analysis.repositoriesWithCustomization || []
			};
			fluencyMetrics.repositoriesJson = JSON.stringify(repoData);
			
			// Calculate and store customization rate
			const totalRepos = (analysis.repositories || []).length;
			const customizedRepos = (analysis.repositoriesWithCustomization || []).length;
			if (totalRepos > 0) {
				fluencyMetrics.repoCustomizationRate = customizedRepos / totalRepos;
			}
		}

		// NEW: Store applyUsage for workflow integration scoring
		if (analysis.applyUsage) {
			fluencyMetrics.applyUsageJson = JSON.stringify(analysis.applyUsage);
			fluencyMetrics.codeBlockApplyRate = analysis.applyUsage.applyRate || 0;
		}

		// NEW: Store sessionDuration data
		if (analysis.sessionDuration) {
			fluencyMetrics.sessionDurationJson = JSON.stringify(analysis.sessionDuration);
		}

		// Extract conversation patterns
		if (analysis.conversationPatterns) {
			fluencyMetrics.multiTurnSessions = analysis.conversationPatterns.multiTurnSessions || 0;
			fluencyMetrics.avgTurnsPerSession = analysis.conversationPatterns.avgTurnsPerSession || 0;
		}

		// Count this as one session
		fluencyMetrics.sessionCount = 1;

		// Only return if we have at least some fluency metrics
		return Object.keys(fluencyMetrics).length > 0 ? fluencyMetrics : undefined;
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
		
		// Warn if user dimension was requested but identity resolution failed
		if (includeUserDimension && !resolved.userId) {
			if (settings.userIdentityMode === 'teamAlias') {
				const { validateTeamAlias } = await import('../identity.js');
				const validation = validateTeamAlias(settings.userId);
				if (!validation.valid) {
					this.deps.warn(`⚠ Backend sync: User identity validation failed. Data will be synced WITHOUT user dimension.`);
					this.deps.warn(`   Reason: ${validation.error}`);
					this.deps.warn(`   Fix: Update "AI Engineering Fluency: Backend User Id" in settings to a valid team alias.`);
				}
			} else {
				this.deps.warn(`⚠ Backend sync: Could not resolve user identity for mode ${settings.userIdentityMode}. Data will be synced WITHOUT user dimension.`);
			}
		}
		
		return resolved;
	}

	/**
	 * Compute daily rollups from local session files.
	 * Uses cached session data when available to avoid re-parsing files.
	 */
	private async computeDailyRollupsFromLocalSessions(args: { lookbackDays: number; userId?: string; sessionFiles?: string[]; skipMtimeFilter?: boolean; onProgress?: (processed: number, total: number, daysFound: number) => void }): Promise<{
		rollups: Map<string, { key: DailyRollupKey; value: DailyRollupValue }>;
		workspaceNamesById: Record<string, string>;
		machineNamesById: Record<string, string>;
	}> {
		const lookbackDays = args.lookbackDays;
		const skipMtimeFilter = args.skipMtimeFilter === true;
		const onProgress = args.onProgress;
		const userId = (args.userId ?? '').trim() || undefined;
		const now = new Date();
		// Include all events from the start of the first day in the range (UTC).
		const start = new Date(now.getTime());
		start.setUTCHours(0, 0, 0, 0);
		start.setUTCDate(start.getUTCDate() - (lookbackDays - 1));
		const startMs = start.getTime();
		
		// Log the date range being processed
		const todayKey = this.utility.toUtcDayKey(now);
		const startKey = this.utility.toUtcDayKey(start);
		this.deps.log(`Backend sync: processing sessions from ${startKey} to ${todayKey} (lookback ${lookbackDays} days)`);

		const machineId = vscode.env.machineId;
		const rollups = new Map<string, { key: DailyRollupKey; value: DailyRollupValue }>();
		const workspaceNamesById: Record<string, string> = {};
		const machineNamesById: Record<string, string> = {};
		const machineName = this.utility.normalizeNameForStorage(this.utility.stripHostnameDomain(os.hostname()));
		if (machineName) {
			machineNamesById[machineId] = machineName;
		}

		// Use pre-fetched session files if provided, otherwise fetch them
		const sessionFiles = args.sessionFiles ?? await this.deps.getCopilotSessionFiles();
		const useCachedData = !!this.deps.getSessionFileDataCached;
		let cacheHits = 0;
		let cacheMisses = 0;
		let filesSkipped = 0;
		let filesProcessed = 0;
		
		const totalFiles = sessionFiles.length;
		this.deps.log(`Backend sync: analyzing ${totalFiles} session files`);

		for (const sessionFile of sessionFiles) {
			let fileMtimeMs: number | undefined;
			
			try {
				const fileStat = await this.deps.statSessionFile(sessionFile);
				fileMtimeMs = fileStat.mtimeMs;
				
				// Skip files older than lookback period (unless backfill mode bypasses this filter)
				if (!skipMtimeFilter && fileMtimeMs < startMs) {
					filesSkipped++;
					continue;
				}
				filesProcessed++;
				// Report progress every 10 files (avoids flooding the callback)
				if (onProgress && filesProcessed % 10 === 0) {
					const daysFound = new Set(Array.from(rollups.values()).map(r => r.key.day)).size;
					onProgress(filesProcessed, totalFiles, daysFound);
				}
			} catch (e) {
				this.deps.warn(`Backend sync: failed to stat session file ${sessionFile}: ${e}`);
				continue;
			}

			// Skip Visual Studio session files — they are binary MessagePack, not JSON
			if (this.deps.isVSSessionFile && this.deps.isVSSessionFile(sessionFile)) {
				filesSkipped++;
				continue;
			}

			// Handle OpenCode sessions separately (different data format)
			if (this.deps.isOpenCodeSession && this.deps.isOpenCodeSession(sessionFile)) {
				if (!this.deps.getOpenCodeSessionData) {
					filesSkipped++;
					continue;
				}
				
				try {
					const data = await this.deps.getOpenCodeSessionData(sessionFile);
					const eventMs = data.timestamp || fileMtimeMs;
					
					if (!eventMs || eventMs < startMs) {
						filesSkipped++;
						continue;
					}

					const dayKey = this.utility.toUtcDayKey(new Date(eventMs));
					const workspaceId = this.utility.extractWorkspaceIdFromSessionPath(sessionFile);
					await this.ensureWorkspaceNameResolved(workspaceId, sessionFile, workspaceNamesById);

					// Process each model's usage with per-model interaction counts
					for (const [model, usage] of Object.entries(data.modelUsage)) {
						const key: DailyRollupKey = { day: dayKey, model, workspaceId, machineId, userId };
						upsertDailyRollup(rollups as any, key, {
							inputTokens: (usage as any).inputTokens || 0,
							outputTokens: (usage as any).outputTokens || 0,
							interactions: (usage as any).interactions || 0
						});
					}
					continue;
				} catch (e) {
					this.deps.warn(`Backend sync: failed to process OpenCode session ${sessionFile}: ${e}`);
					continue;
				}
			}

			// Handle Crush sessions separately (virtual paths pointing to crush.db SQLite entries)
			if (this.deps.isCrushSession && this.deps.isCrushSession(sessionFile)) {
				if (!this.deps.getCrushSessionData) {
					filesSkipped++;
					continue;
				}

				try {
					const data = await this.deps.getCrushSessionData(sessionFile);
					const eventMs = data.timestamp || fileMtimeMs;

					if (!eventMs || eventMs < startMs) {
						filesSkipped++;
						continue;
					}

					const dayKey = this.utility.toUtcDayKey(new Date(eventMs));
					// Crush paths: <project>/.crush/crush.db#<id>  — no workspaceStorage segment
					const workspaceId = this.utility.extractWorkspaceIdFromSessionPath(sessionFile);
					await this.ensureWorkspaceNameResolved(workspaceId, sessionFile, workspaceNamesById);

					for (const [model, usage] of Object.entries(data.modelUsage)) {
						const key: DailyRollupKey = { day: dayKey, model, workspaceId, machineId, userId };
						upsertDailyRollup(rollups as any, key, {
							inputTokens: (usage as any).inputTokens || 0,
							outputTokens: (usage as any).outputTokens || 0,
							interactions: (usage as any).interactions || 0,
						});
					}
					continue;
				} catch (e) {
					this.deps.warn(`Backend sync: failed to process Crush session ${sessionFile}: ${e}`);
					continue;
				}
			}

			const workspaceId = this.utility.extractWorkspaceIdFromSessionPath(sessionFile);
			await this.ensureWorkspaceNameResolved(workspaceId, sessionFile, workspaceNamesById);

			// Try to use cached data first (faster than full recomputation)
			// Note: We still parse the file to get accurate day keys from timestamps,
			// but use cached token counts for performance
			if (useCachedData) {
				const fileStat = await this.deps.statSessionFile(sessionFile);
				const cacheSuccess = await this.processCachedSessionFile(
					sessionFile,
					fileMtimeMs,
					fileStat.size,
					workspaceId,
					machineId,
					userId,
					rollups,
					startMs,
					now
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
			// JSONL (Copilot CLI or VS Code chat .json/.jsonl with delta-based content)
			if (sessionFile.endsWith('.jsonl') || isJsonlContent(content)) {
				let defaultModel = 'gpt-4o';
				// Delta-based format can come from .json or .jsonl files; detect by first-line kind property
				let isVsCodeFormat = false;
				const firstJsonlLine = content.trim().split('\n')[0]?.trim();
				if (firstJsonlLine) {
					try {
						const firstEv = JSON.parse(firstJsonlLine);
						isVsCodeFormat = typeof firstEv.kind === 'number';
					} catch { /* leave as false */ }
				}
				const seenReqIds = new Set<string>();
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
						// VS Code delta-based: track default model from session header events
						if (isVsCodeFormat) {
							if (event.kind === 0) {
								const mId = event.v?.selectedModel?.identifier || event.v?.selectedModel?.metadata?.id || event.v?.inputState?.selectedModel?.metadata?.id;
								if (mId) { defaultModel = mId.replace(/^copilot\//, ''); }
							}
							if (event.kind === 2 && Array.isArray(event.k) && event.k[0] === 'selectedModel') {
								const mId = event.v?.identifier || event.v?.metadata?.id;
								if (mId) { defaultModel = mId.replace(/^copilot\//, ''); }
							}
							if (event.kind === 2 && Array.isArray(event.k) && event.k[0] === 'requests' && Array.isArray(event.v)) {
								for (const request of event.v) {
									const req = request as ChatRequest;
									const reqId = (req as any).requestId as string | undefined;
									if (reqId && seenReqIds.has(reqId)) { continue; }
									if (reqId) { seenReqIds.add(reqId); }
									const normalizedTs = this.utility.normalizeTimestampToMs(typeof req.timestamp !== 'undefined' ? req.timestamp : undefined);
									const eventMs = Number.isFinite(normalizedTs) ? normalizedTs : fileMtimeMs;
									if (!eventMs || eventMs < startMs) { continue; }
									const dayKey = this.utility.toUtcDayKey(new Date(eventMs));
									const rawModel = (req as any).modelId || (req as any).result?.metadata?.modelId;
									const model = rawModel ? (rawModel as string).replace(/^copilot\//, '') : defaultModel;

									let inputTokens = 0;
									let outputTokens = 0;
									// Prefer actual API token counts when available in the request
									const reqResult = (req as any).result;
									if (reqResult?.usage) {
										inputTokens = typeof reqResult.usage.promptTokens === 'number' ? reqResult.usage.promptTokens : 0;
										outputTokens = typeof reqResult.usage.completionTokens === 'number' ? reqResult.usage.completionTokens : 0;
									} else if (typeof reqResult?.promptTokens === 'number' && typeof reqResult?.outputTokens === 'number') {
										inputTokens = reqResult.promptTokens;
										outputTokens = reqResult.outputTokens;
									} else if (reqResult?.metadata && typeof reqResult.metadata.promptTokens === 'number' && typeof reqResult.metadata.outputTokens === 'number') {
										inputTokens = reqResult.metadata.promptTokens;
										outputTokens = reqResult.metadata.outputTokens;
									} else {
										// Fallback to text-based estimation
										if ((req as any).message?.text) {
											inputTokens = this.deps.estimateTokensFromText((req as any).message.text, model);
										}
										if (Array.isArray((req as any).response)) {
											for (const r of (req as any).response) {
												if (typeof r?.value === 'string') { outputTokens += this.deps.estimateTokensFromText(r.value, model); }
											}
										}
									}
									if (inputTokens === 0 && outputTokens === 0) { continue; }
									const key: DailyRollupKey = { day: dayKey, model, workspaceId, machineId, userId };
									upsertDailyRollup(rollups as any, key, { inputTokens, outputTokens, interactions: 1 });
								}
							}
							continue; // processed as VS Code delta event; skip CLI logic below
						}
						// Copilot CLI non-delta format below
						const normalizedTs = this.utility.normalizeTimestampToMs(event.timestamp);
						const eventMs = Number.isFinite(normalizedTs) ? normalizedTs : fileMtimeMs;
						if (!eventMs || eventMs < startMs) {
							continue;
						}
						const dayKey = this.utility.toUtcDayKey(new Date(eventMs));
						const model = (event.model || defaultModel).toString();

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
					// Prefer actual API token counts when available
					const result = (req as any).result;
					if (result?.usage) {
						// OLD FORMAT (pre-Feb 2026)
						inputTokens = typeof result.usage.promptTokens === 'number' ? result.usage.promptTokens : 0;
						outputTokens = typeof result.usage.completionTokens === 'number' ? result.usage.completionTokens : 0;
					} else if (typeof result?.promptTokens === 'number' && typeof result?.outputTokens === 'number') {
						// NEW FORMAT (Feb 2026+)
						inputTokens = result.promptTokens;
						outputTokens = result.outputTokens;
					} else if (result?.metadata && typeof result.metadata.promptTokens === 'number' && typeof result.metadata.outputTokens === 'number') {
						// INSIDERS FORMAT (Feb 2026+): Tokens nested under result.metadata
						inputTokens = result.metadata.promptTokens;
						outputTokens = result.metadata.outputTokens;
					} else {
						// Fallback to text-based estimation
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
		
		this.deps.log(`Backend sync: processed ${filesProcessed} files, skipped ${filesSkipped} files outside lookback period`);

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
				if (!sharingPolicy.allowCloudSync) {
					this.deps.log(`Backend sync: skipping (sharing policy does not allow cloud sync, profile: ${settings.sharingProfile})`);
				} else if (!isConfigured) {
					this.deps.log('Backend sync: skipping (backend not configured - missing storage account, subscription, or resource group)');
				}
				return;
			}

			// Avoid excessive syncing when UI refreshes frequently.
			const lastSyncAt = this.deps.context?.globalState.get<number>('backend.lastSyncAt');
			if (!force && lastSyncAt && Date.now() - lastSyncAt < BACKEND_SYNC_MIN_INTERVAL_MS) {
				const secondsSinceLastSync = Math.round((Date.now() - lastSyncAt) / 1000);
				this.deps.log(`Backend sync: skipping (last sync was ${secondsSinceLastSync}s ago, minimum interval is ${BACKEND_SYNC_MIN_INTERVAL_MS / 1000}s)`);
				return;
			}

			// Acquire cross-instance file lock to prevent concurrent syncs from multiple VS Code windows
			const lockAcquired = await this.acquireSyncLock();
			if (!lockAcquired) {
				this.deps.log('Backend sync: skipping (another VS Code window is currently syncing)');
				return;
			}

			this.backendSyncInProgress = true;
			try {
				// Sharing server backend: entirely different sync path — no Azure deps.
				if (settings.backend === 'sharingServer') {
					await this.syncToSharingServer(settings, sharingPolicy);
					try {
						await this.deps.context?.globalState.update('backend.lastSyncAt', Date.now());
					} catch (e) {
						this.deps.warn(`Backend sync: failed to update lastSyncAt: ${e}`);
					}
					this.consecutiveFailures = 0;
					return;
				}

				this.deps.log('Backend sync: starting rollup sync');
				const creds = await this.credentialService.getBackendDataPlaneCredentials(settings);
				if (!creds) {
					// Shared Key mode selected but key not available (or user canceled). Keep local mode functional.
					this.deps.warn('Backend sync: skipping (credentials not available - check authentication mode and secrets)');
					// Update timestamp to prevent stale "last sync" display
					try {
						await this.deps.context?.globalState.update('backend.lastSyncAt', Date.now());
					} catch (e) {
						this.deps.warn(`Backend sync: failed to update lastSyncAt: ${e}`);
					}
					return;
				}
				await this.dataPlaneService.ensureTableExists(settings, creds.tableCredential);
				await this.dataPlaneService.validateAccess(settings, creds.tableCredential);

				// Check blob upload status upfront (before expensive file scanning)
				let blobUploadNeeded = false;
				if (settings.blobUploadEnabled && this.blobUploadService) {
					const machineId = vscode.env.machineId;
					const uploadSettings = {
						enabled: settings.blobUploadEnabled,
						containerName: settings.blobContainerName,
						uploadFrequencyHours: settings.blobUploadFrequencyHours,
						compressFiles: settings.blobCompressFiles
					};
					blobUploadNeeded = this.blobUploadService.shouldUpload(machineId, uploadSettings);
					if (blobUploadNeeded) {
						this.deps.log('Blob upload: will upload session files after table sync');
					} else {
						const status = this.blobUploadService.getUploadStatus(machineId);
						const hoursSince = status ? Math.round((Date.now() - status.lastUploadTime) / (1000 * 60 * 60)) : 0;
						this.deps.log(`Blob upload: not needed (last upload ${hoursSince}h ago, frequency: ${settings.blobUploadFrequencyHours}h)`);
					}
				}

				// Fetch session files once and reuse for both rollups and blob upload
				const sessionFiles = await this.deps.getCopilotSessionFiles();

				const resolvedIdentity = await this.resolveEffectiveUserIdentityForSync(settings, sharingPolicy.includeUserDimension);
				const { rollups, workspaceNamesById, machineNamesById } = await this.computeDailyRollupsFromLocalSessions({ 
					lookbackDays: settings.lookbackDays, 
					userId: resolvedIdentity.userId,
					sessionFiles // Pass pre-fetched session files to avoid rescan
				});
				
				// Log day keys being synced for better visibility
				const dayKeys = new Set<string>();
				for (const { key } of rollups.values()) {
					dayKeys.add(key.day);
				}
				const sortedDays = Array.from(dayKeys).sort();
				if (sortedDays.length > 0) {
					this.deps.log(`Backend sync: processing data for ${sortedDays.length} days: ${sortedDays.join(', ')}`);
				}
				
				this.deps.log(`Backend sync: upserting ${rollups.size} rollup entities (lookback ${settings.lookbackDays} days)`);

				const tableClient = this.dataPlaneService.createTableClient(settings, creds.tableCredential);

				// One-time cleanup: delete stale Azure entities for this user before upserting.
				// Previous syncs may have written rows with incorrect model names, which create phantom
				// RowKey entries that inflate the dashboard total. We track 'backend.lastCleanSyncVersion'
				// so this runs once per cache version bump and not on every sync cycle.
				const CLEAN_SYNC_VERSION = 2; // Bump when the delete logic changes
				const lastCleanVersion = this.deps.context?.globalState.get<number>('backend.lastCleanSyncVersion') ?? 0;
				const cacheWasCleared = lastCleanVersion < CLEAN_SYNC_VERSION;
				if (cacheWasCleared && resolvedIdentity.userId && sortedDays.length > 0) {
					const startDayKey = sortedDays[0];
					const endDayKey = sortedDays[sortedDays.length - 1];
					this.deps.log(`Backend sync: cleaning stale entities for user "${resolvedIdentity.userId}" (${startDayKey} to ${endDayKey})`);
					try {
						const deleteResult = await this.dataPlaneService.deleteEntitiesForUserDataset({
							tableClient,
							userId: resolvedIdentity.userId,
							datasetId: settings.datasetId,
							startDayKey,
							endDayKey,
						});
						this.deps.log(`Backend sync: deleted ${deleteResult.deletedCount} stale entities (${deleteResult.errors.length} errors)`);
						await this.deps.context?.globalState.update('backend.lastCleanSyncVersion', CLEAN_SYNC_VERSION);
					} catch (e) {
						this.deps.warn(`Backend sync: failed to clean stale entities: ${e}`);
					}
				}

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
						interactions: value.interactions,
						fluencyMetrics: value.fluencyMetrics
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
				
				// Upload session files to Blob Storage if needed (check was done earlier)
				if (blobUploadNeeded && this.blobUploadService) {
					try {
						const machineId = vscode.env.machineId;
						const uploadSettings = {
							enabled: settings.blobUploadEnabled,
							containerName: settings.blobContainerName,
							uploadFrequencyHours: settings.blobUploadFrequencyHours,
							compressFiles: settings.blobCompressFiles
						};

						this.deps.log('Blob upload: starting');
						
						const uploadResult = await this.blobUploadService.uploadSessionFiles(
							settings.storageAccount,
							uploadSettings,
							creds.blobCredential,
							sessionFiles, // Reuse session files from rollup computation
							machineId,
							settings.datasetId
						);
						
						if (uploadResult.success) {
							this.deps.log(`Blob upload: ${uploadResult.message}`);
						} else {
							this.deps.warn(`Blob upload: ${uploadResult.message}`);
						}
					} catch (blobError: any) {
						this.deps.warn(`Blob upload: failed - ${blobError?.message ?? blobError}`);
					}
				}
				
				// DO NOT trigger UI refresh here - it causes redundant analysis and blocks UI
				// The periodic timer in extension.ts will handle UI updates
			} catch (e: any) {
				// Keep local mode functional.
				const secretsToRedact = await this.credentialService.getBackendSecretsToRedactForError(settings);
				this.deps.warn(`Backend sync: ${safeStringifyError(e, secretsToRedact)}`);
			} finally {
				this.backendSyncInProgress = false;
				await this.releaseSyncLock();
			}
		});
		return this.syncQueue;
	}

	/**
	 * Normalize vscode.env.appName to the friendly editor names used throughout the extension.
	 * "Visual Studio Code" → "VS Code", "Visual Studio Code - Insiders" → "VS Code Insiders", etc.
	 */
	private normalizeEditorName(appName: string): string {
		const name = appName.trim();
		if (name === 'Visual Studio Code') { return 'VS Code'; }
		if (name === 'Visual Studio Code - Insiders') { return 'VS Code Insiders'; }
		if (name === 'Visual Studio Code - Exploration') { return 'VS Code Exploration'; }
		// Other editors (Cursor, VSCodium, Windsurf, etc.) already use clean names
		return name || 'VS Code';
	}

	/**
	 * Sync daily rollups to the self-hosted sharing server using a GitHub Bearer token.
	 */
	private async syncToSharingServer(
		settings: BackendSettings,
		sharingPolicy: ReturnType<typeof computeBackendSharingPolicy>,
	): Promise<void> {
		if (!this.sharingServerUploadService) {
			this.deps.warn('Sharing server upload: service not available');
			return;
		}

		const githubToken = this.deps.getGithubToken?.();
		if (!githubToken) {
			this.deps.log('Sharing server upload: skipping (no GitHub token — authenticate with GitHub in VS Code first)');
			return;
		}

		const resolvedIdentity = await this.resolveEffectiveUserIdentityForSync(
			settings,
			sharingPolicy.includeUserDimension,
		);
		const { rollups, workspaceNamesById, machineNamesById } =
			await this.computeDailyRollupsFromLocalSessions({
				lookbackDays: settings.lookbackDays,
				userId: resolvedIdentity.userId,
			});

		if (rollups.size === 0) {
			this.deps.log('Sharing server upload: no data to upload');
			return;
		}

		const includeNames = sharingPolicy.includeNames;
		const entries: SharingServerEntry[] = [];
		for (const { key, value } of rollups.values()) {
			entries.push({
				day: key.day,
				model: key.model,
				workspaceId: key.workspaceId,
				workspaceName: includeNames ? workspaceNamesById[key.workspaceId] : undefined,
				machineId: key.machineId,
				machineName: includeNames ? machineNamesById[key.machineId] : undefined,
				inputTokens: value.inputTokens,
				outputTokens: value.outputTokens,
				interactions: value.interactions,
				datasetId: settings.datasetId,
				editor: this.normalizeEditorName(vscode.env.appName),
			});
		}

		this.deps.log(`Sharing server upload: uploading ${entries.length} rollup entries`);
		await this.sharingServerUploadService.uploadRollups(
			settings.sharingServerEndpointUrl,
			githubToken,
			entries,
			this.deps.log,
			this.deps.warn,
		);
	}

	/**
	 * Backfill historical data to Azure Table Storage.
	 * Scans ALL local session files (ignoring file mtime) and upserts daily rollups for every
	 * day that has local data within the given lookback window. This is safe to run at any time
	 * because the underlying upsert operation is idempotent.
	 *
	 * Use this to recover from situations where the normal sync missed data due to the
	 * mtime-based file-age filter (e.g. the backend was configured after a large volume of
	 * activity had already accumulated locally).
	 */
	async backfillSync(settings: BackendSettings, isConfigured: boolean, maxLookbackDays = 365, onProgress?: (processed: number, total: number, daysFound: number) => void): Promise<void> {
		const sharingPolicy = computeBackendSharingPolicy({
			enabled: settings.enabled,
			profile: settings.sharingProfile,
			shareWorkspaceMachineNames: settings.shareWorkspaceMachineNames
		});
		if (!sharingPolicy.allowCloudSync || !isConfigured) {
			this.deps.warn('Backfill: skipping (cloud sync disabled or backend not configured)');
			return;
		}

		this.deps.log(`Backfill: starting deep scan (up to ${maxLookbackDays} days, mtime filter disabled)`);

		const creds = await this.credentialService.getBackendDataPlaneCredentials(settings);
		if (!creds) {
			this.deps.warn('Backfill: skipping (credentials not available)');
			return;
		}

		await this.dataPlaneService.ensureTableExists(settings, creds.tableCredential);
		await this.dataPlaneService.validateAccess(settings, creds.tableCredential);

		const resolvedIdentity = await this.resolveEffectiveUserIdentityForSync(settings, sharingPolicy.includeUserDimension);
		const { rollups, workspaceNamesById, machineNamesById } = await this.computeDailyRollupsFromLocalSessions({
			lookbackDays: maxLookbackDays,
			userId: resolvedIdentity.userId,
			skipMtimeFilter: true, // backfill: open every file regardless of age
			onProgress
		});

		const dayKeys = new Set<string>();
		for (const { key } of rollups.values()) { dayKeys.add(key.day); }
		const sortedDays = Array.from(dayKeys).sort();
		this.deps.log(`Backfill: found data for ${sortedDays.length} days: ${sortedDays.slice(0, 10).join(', ')}${sortedDays.length > 10 ? '…' : ''}`);

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
				interactions: value.interactions,
				fluencyMetrics: value.fluencyMetrics
			});
			entities.push(entity);
		}

		// Signal upload phase to caller before the (potentially slow) upsert
		onProgress?.(-1, entities.length, sortedDays.length);

		// Delete stale entities for this user before upserting.
		// Previous syncs may have written rows with incorrect model names (e.g. 'gpt-4o' instead
		// of the actual model). Since the model name is part of the RowKey, corrected data creates
		// new rows while old ones persist, causing over-counting on the dashboard.
		if (resolvedIdentity.userId && sortedDays.length > 0) {
			const startDayKey = sortedDays[0];
			const endDayKey = sortedDays[sortedDays.length - 1];
			this.deps.log(`Backfill: cleaning stale entities for user "${resolvedIdentity.userId}" in date range ${startDayKey} to ${endDayKey}`);
			try {
				const deleteResult = await this.dataPlaneService.deleteEntitiesForUserDataset({
					tableClient,
					userId: resolvedIdentity.userId,
					datasetId: settings.datasetId,
					startDayKey,
					endDayKey,
				});
				this.deps.log(`Backfill: deleted ${deleteResult.deletedCount} stale entities (${deleteResult.errors.length} errors)`);
			} catch (e) {
				this.deps.warn(`Backfill: failed to clean stale entities (continuing with upsert): ${e}`);
			}
		}

		const { successCount, errors } = await this.dataPlaneService.upsertEntitiesBatch(tableClient, entities);
		if (errors.length > 0) {
			this.deps.warn(`Backfill: ${successCount}/${entities.length} entities synced, ${errors.length} failed`);
		} else {
			this.deps.log(`Backfill: ${successCount} entities synced successfully across ${sortedDays.length} days`);
		}
	}
}
