/**
 * Sync service for backend facade.
 * Handles background sync, timer management, and daily rollup computation.
 */

import * as vscode from 'vscode';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DefaultAzureCredential } from '@azure/identity';
import { safeStringifyError } from '../../../../src/utils/errors';
import type { DailyRollupKey } from '../rollups';
import { upsertDailyRollup } from '../rollups';
import { resolveSyncTargets, type BackendSettings } from '../settings';
import { BACKEND_SYNC_MIN_INTERVAL_MS } from '../constants';
import type { DailyRollupValue, ChatRequest, SessionFileCache, ModelUsage, SyncResult, SyncTargetOutcome } from '../types';
import { resolveUserIdentityForSync, type BackendUserIdentityMode } from '../identity';
import { computeBackendSharingPolicy, hashMachineIdForTeam, hashWorkspaceIdForTeam } from '../sharingProfile';
import { createDailyAggEntity, type BackendAggDailyEntityLike } from '../storageTables';
import { CredentialService } from './credentialService';
import { DataPlaneService } from './dataPlaneService';
import { BackendUtility } from './utilityService';
import { SharingServerUploadService, type SharingServerEntry } from './sharingServerUploadService';
import { SyncLock } from './syncLock';
import { type IBlobUploadService } from './blobUploadService';
import { isJsonlContent } from '../../../../src/tokenEstimation';
import { getEditorTypeFromPath, refineEditorLabelForInteractionModeSplit } from '../../../../src/workspaceHelpers';

/** Ecosystem session per-model usage entry (input, output, optional interactions). */
type ModelUsageEntry = { inputTokens: number; outputTokens: number; interactions?: number };

/**
 * True when a parsed JSON value is a plain object usable as a session record.
 * Arrays are rejected: `typeof [] === 'object'`, so a bare `[]` line would
 * otherwise read as a valid record with no usage on it and a file of such
 * lines would look like a genuinely empty scan rather than a failed one.
 */
function isEventRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Canonical form of a Team Server endpoint URL: lower-cased origin plus path without trailing
 * slashes. The upload service strips a trailing slash before posting, so `https://x` and
 * `https://x/` hit the same endpoint and must share one cross-window lock.
 */
export function canonicalTeamServerUrl(url: string): string {
	const trimmed = url.trim();
	try {
		const parsed = new URL(trimmed);
		return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
	} catch {
		return trimmed.replace(/\/+$/, '');
	}
}

/** Canonical lock identity for each sync target; also what the lock file records as its server URL. */
export function syncTargetLockToken(kind: 'azure' | 'sharingserver', endpoint: string): string {
	return kind === 'azure' ? `azure:${endpoint.trim().toLowerCase()}` : `share:${canonicalTeamServerUrl(endpoint)}`;
}

/**
 * Lock files written by extension versions before per-endpoint locks. Their recorded server URL
 * is a `|`-joined list of the targets that window was syncing (`azure:<account>|share:<url>`).
 * While an older window may still be running, a live lock there that covers a target blocks it.
 */
const LEGACY_SYNC_LOCK_NAMES: ReadonlyArray<string | undefined> = [undefined, 'sharingserver'];

/** Whether a legacy lock's recorded server URL covers `token`. Unknown formats are treated as covering. */
export function legacyLockCoversTarget(lockServerUrl: string | undefined, token: string): boolean {
	if (!lockServerUrl) { return true; }
	return lockServerUrl.split('|').some(part => {
		if (part.startsWith('azure:')) { return syncTargetLockToken('azure', part.slice('azure:'.length)) === token; }
		if (part.startsWith('share:')) { return syncTargetLockToken('sharingserver', part.slice('share:'.length)) === token; }
		return true;
	});
}

/**
 * Lock name for one sync target endpoint: its kind plus a stable hash of the endpoint. One lock
 * file per endpoint means a window syncing to server A can never make two windows syncing to
 * server B skip serialization (which a single per-kind file, overwritten by A, would allow).
 */
export function targetSyncLockName(kind: 'azure' | 'sharingserver', endpoint: string): string {
	return `${kind}_${createHash('sha256').update(endpoint).digest('hex').slice(0, 16)}`;
}

/**
 * The workspace/machine IDs to upload for a rollup key under a sharing policy: HMAC-hashed per
 * dataset for team profiles, raw for soloFull. Every upload target (Azure rows, backfill, Team
 * Server entries) must go through this so no profile leaks raw IDs to one target but not another.
 */
export function applyIdStrategies(
	key: { workspaceId: string; machineId: string },
	datasetId: string,
	policy: Pick<ReturnType<typeof computeBackendSharingPolicy>, 'workspaceIdStrategy' | 'machineIdStrategy'>,
): { workspaceId: string; machineId: string } {
	return {
		workspaceId: policy.workspaceIdStrategy === 'hashed' ? hashWorkspaceIdForTeam({ datasetId, workspaceId: key.workspaceId }) : key.workspaceId,
		machineId: policy.machineIdStrategy === 'hashed' ? hashMachineIdForTeam({ datasetId, machineId: key.machineId }) : key.machineId,
	};
}

/** Logged when neither Azure Storage nor the Team Server is switched on and configured. */
const NO_SYNC_TARGET_REASON = 'no sync target enabled: Azure Storage needs backend.enabled plus Azure settings; Team Server needs backend.sharingServer.enabled plus an endpoint URL';

/**
 * Pure consent-timestamp parser — no side effects.
 * Returns a `Date` when `raw` represents a valid, non-future timestamp,
 * or an `Error` describing why the value is invalid.
 * The caller is responsible for any logging based on the result.
 */
export function parseConsentTimestamp(raw: unknown): Date | Error {
	const ts = (raw === null || raw === undefined) ? '' : String(raw);
	if (!ts) {
		return new Error('no consent timestamp provided');
	}
	try {
		const parsed = new Date(ts);
		if (isNaN(parsed.getTime())) {
			return new Error(`Invalid consent timestamp (not a valid date): "${ts}"`);
		}
		if (parsed.getTime() > Date.now()) {
			return new Error(`Invalid consent timestamp (future date): "${ts}" (parsed: ${parsed.toISOString()})`);
		}
		return parsed;
	} catch (e) {
		return new Error(`Failed to parse consent timestamp: "${ts}", error: ${e}`);
	}
}

/**
 * Validate and normalize consent timestamp.
 * Returns ISO string if valid, undefined if invalid or in the future.
 * Delegates parsing to {@link parseConsentTimestamp} and logs any error via the optional logger.
 */
function validateConsentTimestamp(ts: string | undefined, logger?: (msg: string) => void): string | undefined {
	if (!ts) {
		return undefined;
	}
	const result = parseConsentTimestamp(ts);
	if (result instanceof Error) {
		logger?.(result.message);
		return undefined;
	}
	return result.toISOString();
}

/** Logger callbacks for the sync service. */
export interface SyncServiceLogger {
	log: (message: string) => void;
	warn: (message: string) => void;
}

/** Session file access, stat, caching, and token estimation callbacks. */
export interface SyncServiceSessionHandlers {
	getCopilotSessionFiles: () => Promise<string[]>;
	estimateTokensFromText: (text: string, model: string) => number;
	getModelFromRequest: (request: ChatRequest) => string;
	/** Cache integration for performance. */
	getSessionFileDataCached?: (sessionFilePath: string, mtime: number, fileSize: number) => Promise<SessionFileCache>;
	/** Stat helper for OpenCode DB virtual paths. */
	statSessionFile: (sessionFile: string) => Promise<fs.Stats>;
}

/** Per-editor session detection and data extraction callbacks. */
export interface SyncServiceEditorHandlers {
	/** OpenCode session handling. */
	isOpenCodeSession?: (sessionFile: string) => boolean;
	getOpenCodeSessionData?: (sessionFile: string) => Promise<{ tokens: number; interactions: number; modelUsage: Record<string, ModelUsageEntry>; timestamp: number }>;
	/** Crush session handling (per-project crush.db virtual paths). */
	isCrushSession?: (sessionFile: string) => boolean;
	getCrushSessionData?: (sessionFile: string) => Promise<{ tokens: number; interactions: number; modelUsage: Record<string, ModelUsageEntry>; timestamp: number }>;
	/** Visual Studio session detection (binary MessagePack — cannot be parsed as JSON). */
	isVSSessionFile?: (sessionFile: string) => boolean;
}

export interface SyncServiceDeps {
	context: vscode.ExtensionContext | undefined;
	logger: SyncServiceLogger;
	sessionHandlers: SyncServiceSessionHandlers;
	editorHandlers?: SyncServiceEditorHandlers;
	/** UI refresh callback after successful sync. */
	updateTokenStats?: () => Promise<void>;
	/** Returns the current GitHub OAuth access token, or undefined if not authenticated. */
	getGithubToken?: () => string | undefined;
	/** Resolves the session-specific editor label supplied by an ecosystem adapter. */
	getEditorLabel?: (sessionFile: string) => string;
}

/**
 * SyncService manages background synchronization of local session data to the backend.
 */
export class SyncService {
	private backendSyncInProgress = false;
	private syncQueue: Promise<unknown> = Promise.resolve();
	private backendSyncInterval: NodeJS.Timeout | undefined;
	private consecutiveFailures = 0;
	private readonly MAX_CONSECUTIVE_FAILURES = 5;
	private readonly syncLock: SyncLock;

	constructor(
		private readonly deps: SyncServiceDeps,
		private readonly credentialService: CredentialService,
		private readonly dataPlaneService: DataPlaneService,
		private readonly blobUploadService: IBlobUploadService | undefined,
		private readonly utility: typeof BackendUtility,
		private readonly sharingServerUploadService: SharingServerUploadService | undefined,
	) {
		this.syncLock = new SyncLock(
			deps.context,
			deps.logger.log.bind(deps.logger),
			deps.logger.warn.bind(deps.logger),
		);
	}

	// ── Cross-instance file lock ────────────────────────────────────────

	/**
	 * Try to acquire an exclusive file lock so only one VS Code window
	 * can run a backend sync at a time.
	 *
	 * If the existing lock was written by an instance configured against a
	 * *different* server URL, the lock does not apply — both instances are
	 * syncing to independent endpoints and should not block each other.
	 */
	private async acquireSyncLock(lockName?: string, serverUrl?: string): Promise<boolean> {
		return this.syncLock.acquire(lockName, serverUrl);
	}

	/**
	 * Release the sync lock, but only if we own it.
	 */
	private async releaseSyncLock(lockName?: string): Promise<void> {
		return this.syncLock.release(lockName);
	}

	/**
	 * Determine whether the sync timer is allowed to start, logging the reason when it isn't.
	 */
	private _canStartSyncTimer(settings: BackendSettings, isConfigured: boolean): boolean {
		if (settings.sharingProfile === 'off') {
			this.deps.logger.log(`Backend sync: not starting timer (cloud sync disabled, profile: ${settings.sharingProfile})`);
			return false;
		}
		if (!isConfigured) {
			this.deps.logger.log('Backend sync: not starting timer (backend not configured)');
			return false;
		}
		const targets = resolveSyncTargets(settings);
		if (!targets.azure && !targets.sharingServer) {
			this.deps.logger.log(`Backend sync: not starting timer (${NO_SYNC_TARGET_REASON})`);
			return false;
		}
		return true;
	}

	/**
	 * Handle a failed periodic (timer-driven) sync: track consecutive failures,
	 * surface a user-facing warning/error at the relevant thresholds, and stop
	 * the timer once failures exceed {@link MAX_CONSECUTIVE_FAILURES}.
	 */
	private _handleTimerSyncFailure(e: unknown): void {
		const err = e as { message?: string } | undefined;
		this.deps.logger.warn(`Backend sync timer failed: ${err?.message ?? e}`);
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
			this.deps.logger.warn(`Backend sync: stopping timer after ${this.MAX_CONSECUTIVE_FAILURES} consecutive failures`);
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
	}

	/**
	 * Start the background sync timer if backend is enabled.
	 * @param settings - Backend settings to check if sync should be enabled
	 * @param isConfigured - Whether the backend is fully configured
	 */
	startTimerIfEnabled(settings: BackendSettings, isConfigured: boolean): void {
		try {
			this.stopTimer();
			if (!this._canStartSyncTimer(settings, isConfigured)) {
				return;
			}
			const intervalMs = BACKEND_SYNC_MIN_INTERVAL_MS;
			this.deps.logger.log(`Backend sync: starting timer with interval ${intervalMs}ms (${intervalMs / 60000} minutes)`);
			this.backendSyncInterval = setInterval(() => {
				this.syncToBackendStore(false, settings, isConfigured).catch((e) => this._handleTimerSyncFailure(e));
			}, intervalMs);
			// Immediate initial sync (forced to ensure settings changes take effect)
			this.syncToBackendStore(true, settings, isConfigured).catch((e) => {
				this.deps.logger.warn(`Backend sync initial sync failed: ${e?.message ?? e}`);
			});
		} catch (e) {
			this.deps.logger.warn(`Backend sync timer setup failed: ${e}`);
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
	getSyncQueue(): Promise<unknown> {
		return this.syncQueue;
	}


/** Arguments shared across per-session rollup helper methods. */
private makeSessionRollupArgs(
machineId: string,
userId: string | undefined,
editorForFile: string | undefined,
workspaceNamesById: Record<string, string>,
rollups: Map<string, { key: DailyRollupKey; value: DailyRollupValue }>,
startMs: number
): { machineId: string; userId: string | undefined; editorForFile: string | undefined; workspaceNamesById: Record<string, string>; rollups: Map<string, { key: DailyRollupKey; value: DailyRollupValue }>; startMs: number } {
return { machineId, userId, editorForFile, workspaceNamesById, rollups, startMs };
}

/**
 * Build day→model interaction counts from Copilot CLI non-delta JSONL format.
 * Each JSONL line is a single event; counts all events per day per model.
 */
private buildDayModelInteractionsFromCliJsonl(
content: string,
sessionFile: string,
fileMtimeMs: number,
startMs: number,
now: Date
): Map<string, Map<string, number>> | null {
const dayModelInteractions = new Map<string, Map<string, number>>();
const lines = content.trim().split('\n');
const todayKey = this.utility.toUtcDayKey(now);
let lineCount = 0;
let processedLines = 0;
const failures = { count: 0 };
for (const line of lines) {
lineCount++;
if (!line.trim()) { continue; }
processedLines = this.processCliJsonlLine(line, fileMtimeMs, startMs, todayKey, sessionFile, lineCount, processedLines, dayModelInteractions, failures);
}
// Any unreadable line means this file's usage is not fully represented here.
// Returning null makes the caller fall through to the raw-content parser, which
// counts the file towards filesFailed; swallowing it would let a malformed
// session look like a clean, empty scan on the cached path.
if (failures.count > 0) {
this.deps.logger.warn(`Backend sync: ${failures.count} unreadable line(s) in ${sessionFile} — re-reading without the cache`);
return null;
}
return dayModelInteractions;
}

private processCliJsonlLine(
line: string,
fileMtimeMs: number,
startMs: number,
todayKey: string,
sessionFile: string,
lineCount: number,
processedLines: number,
dayModelInteractions: Map<string, Map<string, number>>,
failures: { count: number }
): number {
try {
const event = JSON.parse(line);
if (!isEventRecord(event)) { failures.count++; return processedLines; }
const normalizedTs = this.utility.normalizeTimestampToMs(event.timestamp);
const eventMs = Number.isFinite(normalizedTs) ? normalizedTs : fileMtimeMs;
if (!eventMs || eventMs < startMs) { return processedLines; }
const dayKey = this.utility.toUtcDayKey(new Date(eventMs));
const model = (event.model || 'gpt-4o').toString();
if (dayKey === todayKey && processedLines < 3) {
this.deps.logger.log(`Backend sync: file ${sessionFile.split(/[/\\]/).pop()} line ${lineCount}: eventMs=${new Date(eventMs).toISOString()}, dayKey=${dayKey}, type=${event.type}`);
processedLines++;
}
if (!dayModelInteractions.has(dayKey)) { dayModelInteractions.set(dayKey, new Map()); }
const dayMap = dayModelInteractions.get(dayKey)!;
dayMap.set(model, (dayMap.get(model) || 0) + 1);
} catch {
failures.count++;
}
return processedLines;
}

/**
 * Build day→model interaction counts from VS Code delta-based JSONL format.
 * Handles kind:0/1/2 events with per-request deduplication.
 */
private buildDayModelInteractionsFromDeltaJsonl(
content: string,
fileMtimeMs: number,
startMs: number
): Map<string, Map<string, number>> | null {
const dayModelInteractions = new Map<string, Map<string, number>>();
let defaultModel = 'unknown';
const seenRequestIds = new Set<string>();
const lines = content.trim().split('\n');
let failures = 0;
for (const line of lines) {
if (!line.trim()) { continue; }
try {
const event = JSON.parse(line);
if (!isEventRecord(event)) { failures++; continue; }
defaultModel = this.updateDeltaDefaultModel(event, defaultModel);
const payload = this.readDeltaRequestsPayload(event);
if (payload === 'malformed') {
failures++;
} else if (payload !== 'not-requests') {
failures += this.processDeltaRequests(payload, defaultModel, seenRequestIds, fileMtimeMs, startMs, dayModelInteractions);
}
} catch {
failures++;
}
}
// Same contract as the other cached parsers: an unreadable line means this file
// cannot be reported as cleanly empty, so defer to the failure-aware parser.
if (failures > 0) { return null; }
return dayModelInteractions;
}

/**
 * Classify a delta event's `requests` payload so the cached and raw parsers
 * cannot disagree about the same event.
 *
 * Returns the entries when the event replaces the whole `requests` array,
 * 'not-requests' when it targets something else, and 'malformed' when it
 * targets the whole array but carries a value that cannot be read. That last
 * case used to be silently ignored, so a file of nothing but
 * `{"kind":2,"k":["requests"],"v":null}` produced an empty map on both paths,
 * left filesFailed at zero, and let the no-data branch advance the marker.
 *
 * Nested updates (`k.length > 1`, e.g. `['requests', 0, 'response']`) legitimately
 * carry non-array values, so only the top-level path can be malformed.
 */
private readDeltaRequestsPayload(event: any): unknown[] | 'not-requests' | 'malformed' {
if (event.kind !== 2 || !Array.isArray(event.k) || event.k[0] !== 'requests') { return 'not-requests'; }
if (Array.isArray(event.v)) { return event.v; }
return event.k.length === 1 ? 'malformed' : 'not-requests';
}

private updateDeltaDefaultModel(event: any, defaultModel: string): string {if (event.kind === 0) {
const modelId = this.extractModelIdFromKind0Event(event);
if (modelId) { return (modelId as string).replace(/^copilot\//, ''); }
}
if (event.kind === 2 && Array.isArray(event.k) && event.k[0] === 'selectedModel') {
const modelId = this.extractModelIdFromSelectedModelEvent(event);
if (modelId) { return (modelId as string).replace(/^copilot\//, ''); }
}
return defaultModel;
}

private extractModelIdFromKind0Event(event: any): string | undefined {
return event.v?.selectedModel?.identifier ||
event.v?.selectedModel?.metadata?.id ||
event.v?.inputState?.selectedModel?.metadata?.id;
}

private extractModelIdFromSelectedModelEvent(event: any): string | undefined {
return event.v?.identifier || event.v?.metadata?.id;
}

private processDeltaRequests(
requests: any[],
defaultModel: string,
seenRequestIds: Set<string>,
fileMtimeMs: number,
startMs: number,
dayModelInteractions: Map<string, Map<string, number>>
): number {
let failed = 0;
for (const request of requests) {
// A delta payload entry that is not an object carries no usage and cannot be
// read; counting it keeps this in step with the raw-content delta parser.
if (!isEventRecord(request)) { failed++; continue; }
this.upsertDeltaRequest(request as ChatRequest, defaultModel, seenRequestIds, fileMtimeMs, startMs, dayModelInteractions);
}
return failed;
}

private upsertDeltaRequest(
req: ChatRequest,
defaultModel: string,
seenRequestIds: Set<string>,
fileMtimeMs: number,
startMs: number,
dayModelInteractions: Map<string, Map<string, number>>
): void {
const reqId = (req as any).requestId as string | undefined;
if (reqId && seenRequestIds.has(reqId)) { return; }
if (reqId) { seenRequestIds.add(reqId); }
const normalizedTs = this.utility.normalizeTimestampToMs(req.timestamp);
const eventMs = Number.isFinite(normalizedTs) ? normalizedTs : fileMtimeMs;
if (!eventMs || eventMs < startMs) { return; }
const dayKey = this.utility.toUtcDayKey(new Date(eventMs));
const rawModel = (req as any).modelId || (req as any).result?.metadata?.modelId;
const model = rawModel ? (rawModel as string).replace(/^copilot\//, '') : defaultModel;
if (!dayModelInteractions.has(dayKey)) { dayModelInteractions.set(dayKey, new Map()); }
const dayMap = dayModelInteractions.get(dayKey)!;
dayMap.set(model, (dayMap.get(model) ?? 0) + 1);
}

/**
 * Build day→model interaction counts from regular JSON session format.
 * Returns null if the document cannot be read as a session: unparseable JSON, a
 * missing `requests` array, or any malformed record inside it. The caller treats
 * null as a cache miss and falls through to the failure-aware parser.
 */
private buildDayModelInteractionsFromJson(
content: string,
fileMtimeMs: number,
startMs: number,
sessionFile: string
): Map<string, Map<string, number>> | null {
try {
const sessionJson = JSON.parse(content);
if (!isEventRecord(sessionJson)) {
return null;
}
const sessionObj = sessionJson as Record<string, unknown>;
// Mirrors processJsonSessionFallback: a document with no `requests` array is one
// we cannot extract usage from, so it must not be reported as cleanly empty.
if (!Array.isArray(sessionObj.requests)) {
this.deps.logger.warn(`Backend sync: cached session file has no "requests" array: ${sessionFile}`);
return null;
}
const requests = sessionObj.requests as unknown[];
const dayModelInteractions = new Map<string, Map<string, number>>();
for (const request of requests) {
// processJsonSessionFallback rejects malformed request records, so this path has
// to as well: casting `[]` or `"bad"` to a ChatRequest yields no usable fields and
// silently produced an empty, successful-looking map.
if (!isEventRecord(request)) {
this.deps.logger.warn(`Backend sync: malformed request record in cached session ${sessionFile}`);
return null;
}
const req = request as ChatRequest;
const normalizedTs = this.utility.normalizeTimestampToMs(
typeof req.timestamp !== 'undefined' ? req.timestamp : (sessionObj.lastMessageDate as unknown)
);
const eventMs = Number.isFinite(normalizedTs) ? normalizedTs : fileMtimeMs;
if (!eventMs || eventMs < startMs) { continue; }
const dayKey = this.utility.toUtcDayKey(new Date(eventMs));
const model = this.deps.sessionHandlers.getModelFromRequest(req);
if (!dayModelInteractions.has(dayKey)) {
dayModelInteractions.set(dayKey, new Map());
}
const dayMap = dayModelInteractions.get(dayKey)!;
dayMap.set(model, (dayMap.get(model) || 0) + 1);
}
return dayModelInteractions;
} catch (e) {
this.deps.logger.warn(`Backend sync: failed to parse JSON for ${sessionFile}: ${e}`);
return null;
}
}

private redistributeToMappedModels(
modelMap: Map<string, number>,
unmappedModels: Set<string>,
cachedModelNames: string[],
cachedModelUsage: ModelUsage,
totalCachedTokens: number
): void {
let unmappedCount = 0;
for (const um of unmappedModels) { unmappedCount += modelMap.get(um) ?? 0; modelMap.delete(um); }
if (unmappedCount === 0) { return; }
for (const cm of cachedModelNames) {
const ct = cachedModelUsage[cm].inputTokens + cachedModelUsage[cm].outputTokens;
const share = totalCachedTokens > 0 ? ct / totalCachedTokens : 1 / cachedModelNames.length;
const redistributed = Math.round(unmappedCount * share);
if (redistributed > 0) { modelMap.set(cm, (modelMap.get(cm) ?? 0) + redistributed); }
}
}

/**
 * Remap event model names to cached model names when there is a mismatch.
 * CLI sessions often omit the model in individual events while session.shutdown
 * provides the actual model. Without remapping, token lookups silently fail.
 */
private remapUnmappedModels(
dayModelInteractions: Map<string, Map<string, number>>,
cachedModelUsage: ModelUsage
): void {
const cachedModelNames = Object.keys(cachedModelUsage);
if (cachedModelNames.length === 0) { return; }
const allEventModels = new Set<string>();
for (const modelMap of dayModelInteractions.values()) {
for (const m of modelMap.keys()) { allEventModels.add(m); }
}
const unmappedModels = new Set<string>();
for (const m of allEventModels) { if (!cachedModelUsage[m]) { unmappedModels.add(m); } }
if (unmappedModels.size === 0) { return; }
const totalCachedTokens = cachedModelNames.reduce((sum, m) =>
sum + cachedModelUsage[m].inputTokens + cachedModelUsage[m].outputTokens, 0);
for (const [, modelMap] of dayModelInteractions) {
this.redistributeToMappedModels(modelMap, unmappedModels, cachedModelNames, cachedModelUsage, totalCachedTokens);
}
}

/**
 * Build daily rollup entries from day→model interaction counts and cached token data.
 * Applies proportional fractions for multi-day sessions.
 */
private buildRollupsFromDayModelInteractions(
dayModelInteractions: Map<string, Map<string, number>>,
cachedData: SessionFileCache,
sessionFile: string,
workspaceId: string,
machineId: string,
userId: string | undefined,
rollups: Map<string, { key: DailyRollupKey; value: DailyRollupValue }>,
editor?: string
): void {
const totalInteractionsPerModel = new Map<string, number>();
for (const modelMap of dayModelInteractions.values()) {
for (const [m, c] of modelMap) {
totalInteractionsPerModel.set(m, (totalInteractionsPerModel.get(m) || 0) + c);
}
}
for (const [dayKey, modelMap] of dayModelInteractions) {
this.processModelInteractionsForDay(dayKey, modelMap, totalInteractionsPerModel, cachedData, sessionFile, workspaceId, machineId, userId, rollups, editor);
}
if (dayModelInteractions.size > 1) {
const days = Array.from(dayModelInteractions.keys()).sort();
this.deps.logger.log(`Backend sync: file ${sessionFile.split(/[/\\]/).pop()} spans ${days.length} days: ${days.join(', ')}`);
}
}

private processModelInteractionsForDay(
dayKey: string,
modelMap: Map<string, number>,
totalInteractionsPerModel: Map<string, number>,
cachedData: SessionFileCache,
sessionFile: string,
workspaceId: string,
machineId: string,
userId: string | undefined,
rollups: Map<string, { key: DailyRollupKey; value: DailyRollupValue }>,
editor?: string
): void {
for (const [model, interactions] of modelMap) {
const cachedUsage = cachedData.modelUsage[model];
if (!cachedUsage) { continue; }
const cachedInput = typeof cachedUsage.inputTokens === 'number' ? cachedUsage.inputTokens : NaN;
const cachedOutput = typeof cachedUsage.outputTokens === 'number' ? cachedUsage.outputTokens : NaN;
if (!Number.isFinite(cachedInput) || cachedInput < 0 ||
!Number.isFinite(cachedOutput) || cachedOutput < 0) {
this.deps.logger.warn(`Backend sync: invalid inputTokens or outputTokens in model usage for ${sessionFile}`);
continue;
}
const key: DailyRollupKey = { day: dayKey, model, workspaceId, machineId, userId, editor };
const totalModelInteractions = totalInteractionsPerModel.get(model) || 1;
const dayFraction = totalModelInteractions > 0 ? interactions / totalModelInteractions : 1;
const inputTokens = Math.round(cachedInput * dayFraction);
const outputTokens = Math.round(cachedOutput * dayFraction);
const fluencyMetrics = this.extractFluencyMetricsFromCache(cachedData, dayFraction);
upsertDailyRollup(rollups, key, { inputTokens, outputTokens, interactions, fluencyMetrics });
}
}

/**
 * Process an OpenCode session file and add its data to the rollups map.
 * Returns false if outside the lookback window or no handler is registered.
 * Throws on data retrieval errors (caller should catch and log).
 */
private async processOpenCodeSession(
sessionFile: string,
fileMtimeMs: number,
args: { machineId: string; userId: string | undefined; editorForFile: string | undefined; workspaceNamesById: Record<string, string>; rollups: Map<string, { key: DailyRollupKey; value: DailyRollupValue }>; startMs: number }
): Promise<boolean> {
if (!this.deps.editorHandlers?.getOpenCodeSessionData) { return false; }
const getOpenCodeSessionData = this.deps.editorHandlers.getOpenCodeSessionData;
const data = await getOpenCodeSessionData(sessionFile);
const eventMs = data.timestamp || fileMtimeMs;
if (!eventMs || eventMs < args.startMs) { return false; }
const dayKey = this.utility.toUtcDayKey(new Date(eventMs));
const workspaceId = this.utility.extractWorkspaceIdFromSessionPath(sessionFile);
await this.ensureWorkspaceNameResolved(workspaceId, sessionFile, args.workspaceNamesById);
for (const [model, usage] of Object.entries(data.modelUsage)) {
const key: DailyRollupKey = { day: dayKey, model, workspaceId, machineId: args.machineId, userId: args.userId, editor: args.editorForFile };
upsertDailyRollup(args.rollups, key, {
inputTokens: usage.inputTokens || 0,
outputTokens: usage.outputTokens || 0,
interactions: usage.interactions || 0,
});
}
return true;
}

/**
 * Process a Crush session file and add its data to the rollups map.
 * Returns false if outside the lookback window or no handler is registered.
 * Throws on data retrieval errors (caller should catch and log).
 */
private async processCrushSession(
sessionFile: string,
fileMtimeMs: number,
args: { machineId: string; userId: string | undefined; editorForFile: string | undefined; workspaceNamesById: Record<string, string>; rollups: Map<string, { key: DailyRollupKey; value: DailyRollupValue }>; startMs: number }
): Promise<boolean> {
if (!this.deps.editorHandlers?.getCrushSessionData) { return false; }
const getCrushSessionData = this.deps.editorHandlers.getCrushSessionData;
const data = await getCrushSessionData(sessionFile);
const eventMs = data.timestamp || fileMtimeMs;
if (!eventMs || eventMs < args.startMs) { return false; }
const dayKey = this.utility.toUtcDayKey(new Date(eventMs));
// Crush paths: <project>/.crush/crush.db#<id>  — no workspaceStorage segment
const workspaceId = this.utility.extractWorkspaceIdFromSessionPath(sessionFile);
await this.ensureWorkspaceNameResolved(workspaceId, sessionFile, args.workspaceNamesById);
for (const [model, usage] of Object.entries(data.modelUsage)) {
const key: DailyRollupKey = { day: dayKey, model, workspaceId, machineId: args.machineId, userId: args.userId, editor: args.editorForFile };
upsertDailyRollup(args.rollups, key, {
inputTokens: usage.inputTokens || 0,
outputTokens: usage.outputTokens || 0,
interactions: usage.interactions || 0,
});
}
return true;
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
now: Date,
editor?: string
): Promise<boolean> {
try {
const cachedData = await this.deps.sessionHandlers.getSessionFileDataCached!(sessionFile, fileMtimeMs, fileSize);
if (!this.validateCachedData(cachedData, sessionFile)) { return false; }
if (cachedData.dailyRollups && Object.keys(cachedData.dailyRollups).length > 0) {
return this.processDailyRollupsFastPath(cachedData, workspaceId, machineId, userId, rollups, editor, startMs);
}
const content = await fs.promises.readFile(sessionFile, 'utf8');
const dayModelInteractions = this.buildDayModelInteractionMap(content, sessionFile, fileMtimeMs, startMs, now);
if (dayModelInteractions === null) { return false; }
this.remapUnmappedModels(dayModelInteractions, cachedData.modelUsage);
this.buildRollupsFromDayModelInteractions(dayModelInteractions, cachedData, sessionFile, workspaceId, machineId, userId, rollups, editor);
return true;
} catch (e) {
const errorMessage = e instanceof Error ? e.message : String(e);
if (errorMessage.includes('ENOENT') || errorMessage.includes('not found')) { return false; }
this.deps.logger.warn(`Backend sync: cache error for ${sessionFile}: ${errorMessage}`);
return false;
}
}

private validateCachedData(cachedData: any, sessionFile: string): boolean {
if (!cachedData || typeof cachedData !== 'object') {
this.deps.logger.warn(`Backend sync: invalid cached data structure for ${sessionFile}`);
return false;
}
if (typeof cachedData.modelUsage !== 'object' || cachedData.modelUsage === null) {
this.deps.logger.warn(`Backend sync: invalid modelUsage in cached data for ${sessionFile}`);
return false;
}
if (!Number.isFinite(cachedData.interactions) || cachedData.interactions < 0) {
this.deps.logger.warn(`Backend sync: invalid interactions count in cached data for ${sessionFile}`);
return false;
}
return true;
}

private processDailyRollupsFastPath(
cachedData: any,
workspaceId: string,
machineId: string,
userId: string | undefined,
rollups: Map<string, { key: DailyRollupKey; value: DailyRollupValue }>,
editor: string | undefined,
startMs: number
): boolean {
const totalSessionInteractions = cachedData.interactions || 1;
const dayKeys = Object.keys(cachedData.dailyRollups).sort();
for (const dayKey of dayKeys) {
const dayEntry = cachedData.dailyRollups[dayKey];
const dayStartMs = new Date(dayKey + 'T00:00:00Z').getTime();
if (dayStartMs < startMs) { continue; }
this.processDailyRollupsDayEntry(dayKey, dayEntry, totalSessionInteractions, cachedData, workspaceId, machineId, userId, rollups, editor);
}
if (dayKeys.length > 1) {
this.deps.logger.log(`Backend sync: file spans ${dayKeys.length} days (dailyRollups fast path): ${dayKeys.join(', ')}`);
}
return true;
}

private processDailyRollupsDayEntry(
dayKey: string,
dayEntry: any,
totalSessionInteractions: number,
cachedData: any,
workspaceId: string,
machineId: string,
userId: string | undefined,
rollups: Map<string, { key: DailyRollupKey; value: DailyRollupValue }>,
editor: string | undefined
): void {
const modelEntries = Object.entries<any>(dayEntry.modelUsage).filter(([, mu]) =>
mu && ((mu.inputTokens || 0) > 0 || (mu.outputTokens || 0) > 0)
);
if (modelEntries.length === 0) { return; }
const totalDayOutput = modelEntries.reduce((s, [, mu]) => s + (mu.outputTokens || 0), 0);
const dayFraction = totalSessionInteractions > 0 ? dayEntry.interactions / totalSessionInteractions : 1;
const fluencyMetrics = this.extractFluencyMetricsFromCache(cachedData, dayFraction);
let remainingInteractions = dayEntry.interactions;
for (let i = 0; i < modelEntries.length; i++) {
const [model, mu] = modelEntries[i];
const isLast = i === modelEntries.length - 1;
const share = (!isLast && totalDayOutput > 0) ? (mu.outputTokens || 0) / totalDayOutput : 1;
const modelInteractions = isLast
? remainingInteractions
: Math.min(Math.round(dayEntry.interactions * share), remainingInteractions);
remainingInteractions -= modelInteractions;
const key: DailyRollupKey = { day: dayKey, model, workspaceId, machineId, userId, editor };
upsertDailyRollup(rollups, key, {
inputTokens: mu.inputTokens || 0,
outputTokens: mu.outputTokens || 0,
interactions: Math.max(0, modelInteractions),
fluencyMetrics,
});
}
}

private buildDayModelInteractionMap(
content: string,
sessionFile: string,
fileMtimeMs: number,
startMs: number,
now: Date
): Map<string, Map<string, number>> | null {
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
if (sessionFile.endsWith('.jsonl') && !isDeltaBasedJsonl) {
return this.buildDayModelInteractionsFromCliJsonl(content, sessionFile, fileMtimeMs, startMs, now);
} else if (isDeltaBasedJsonl) {
return this.buildDayModelInteractionsFromDeltaJsonl(content, fileMtimeMs, startMs);
} else {
return this.buildDayModelInteractionsFromJson(content, fileMtimeMs, startMs, sessionFile);
}
}
	/**
	 * Extract fluency metrics from cached session data and serialize for storage.
	 * @param cachedData - The cached session file data
	 * @param ratio - Optional ratio to proportionally distribute metrics (for multi-day sessions)
	 * @returns Fluency metrics object ready for storage
	 */
	private extractFluencyMetricsFromCache(cachedData: any, ratio: number = 1): any {
		if (!cachedData.usageAnalysis) { return undefined; }
		const analysis = cachedData.usageAnalysis;
		const fluencyMetrics: any = {
			...this.extractModeUsageFluency(analysis, ratio),
			...this.extractJsonFieldsFluency(analysis),
			...this.extractEditScopeFluency(analysis),
			...this.extractRepositoriesFluency(analysis),
			...this.extractActivityFluency(analysis),
			sessionCount: 1
		};
		return Object.keys(fluencyMetrics).length > 0 ? fluencyMetrics : undefined;
	}

	private extractModeUsageFluency(analysis: any, ratio: number): any {
		if (!analysis.modeUsage) { return {}; }
		return {
			askModeCount: Math.round((analysis.modeUsage.ask || 0) * ratio),
			editModeCount: Math.round((analysis.modeUsage.edit || 0) * ratio),
			agentModeCount: Math.round((analysis.modeUsage.agent || 0) * ratio),
			planModeCount: Math.round((analysis.modeUsage.plan || 0) * ratio),
			customAgentModeCount: Math.round((analysis.modeUsage.customAgent || 0) * ratio),
			cliModeCount: Math.round(((analysis.modeUsage.cli || 0) + (analysis.modeUsage.cliApp || 0) + (analysis.modeUsage.claudeDesktop || 0) + (analysis.modeUsage.claudeVsCode || 0)) * ratio)
		};
	}

	private extractJsonFieldsFluency(analysis: any): any {
		const result: any = {};
		if (analysis.toolCalls) { result.toolCallsJson = JSON.stringify(stripLatencyHistograms(analysis.toolCalls)); }
		if (analysis.contextReferences) { result.contextRefsJson = JSON.stringify(analysis.contextReferences); }
		if (analysis.mcpTools) { result.mcpToolsJson = JSON.stringify(stripLatencyHistograms(analysis.mcpTools)); }
		if (analysis.modelSwitching) { result.modelSwitchingJson = JSON.stringify(analysis.modelSwitching); }
		if (analysis.agentTypes) { result.agentTypesJson = JSON.stringify(analysis.agentTypes); }
		if (analysis.sessionDuration) { result.sessionDurationJson = JSON.stringify(analysis.sessionDuration); }
		return result;
	}

	private extractEditScopeFluency(analysis: any): any {
		if (!analysis.editScope) { return {}; }
		return {
			editScopeJson: JSON.stringify(analysis.editScope),
			multiFileEdits: analysis.editScope.multiFileEdits || 0,
			avgFilesPerEdit: analysis.editScope.avgFilesPerSession || 0
		};
	}

	private extractRepositoriesFluency(analysis: any): any {
		if (!analysis.repositories && !analysis.repositoriesWithCustomization) { return {}; }
		const repoData = {
			repositories: analysis.repositories || [],
			repositoriesWithCustomization: analysis.repositoriesWithCustomization || []
		};
		const result: any = { repositoriesJson: JSON.stringify(repoData) };
		const totalRepos = (analysis.repositories || []).length;
		const customizedRepos = (analysis.repositoriesWithCustomization || []).length;
		if (totalRepos > 0) { result.repoCustomizationRate = customizedRepos / totalRepos; }
		return result;
	}

	private extractActivityFluency(analysis: any): any {
		const result: any = {};
		if (analysis.applyUsage) {
			result.applyUsageJson = JSON.stringify(analysis.applyUsage);
			result.codeBlockApplyRate = analysis.applyUsage.applyRate || 0;
		}
		if (analysis.conversationPatterns) {
			result.multiTurnSessions = analysis.conversationPatterns.multiTurnSessions || 0;
			result.avgTurnsPerSession = analysis.conversationPatterns.avgTurnsPerSession || 0;
		}
		return result;
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
		this.deps.logger.log(`Backend sync: Cache performance - Hits: ${cacheHits}, Misses: ${cacheMisses}, Hit Rate: ${hitRate}%`);
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
					this.deps.logger.warn(`⚠ Backend sync: User identity validation failed. Data will be synced WITHOUT user dimension.`);
					this.deps.logger.warn(`   Reason: ${validation.error}`);
					this.deps.logger.warn(`   Fix: Update "AI Engineering Fluency: Backend User Id" in settings to a valid team alias.`);
				}
			} else {
				this.deps.logger.warn(`⚠ Backend sync: Could not resolve user identity for mode ${settings.userIdentityMode}. Data will be synced WITHOUT user dimension.`);
			}
		}
		
		return resolved;
	}


/**
 * Extract token counts from a chat request, preferring actual API-reported counts
 * and falling back to text-based estimation.
 * Handles multiple request formats (pre-Feb 2026, Feb 2026+, VS Code Insiders).
 */
private extractTokenCountsFromRequest(
req: ChatRequest,
model: string
): { inputTokens: number; outputTokens: number } {
const apiTokens = this.extractApiReportedTokens((req as any).result);
if (apiTokens) { return apiTokens; }
return this.estimateTokenCountsFromMessage(req, model);
}

private extractApiReportedTokens(result: any): { inputTokens: number; outputTokens: number } | null {
if (result?.usage) {
return {
inputTokens: typeof result.usage.promptTokens === 'number' ? result.usage.promptTokens : 0,
outputTokens: typeof result.usage.completionTokens === 'number' ? result.usage.completionTokens : 0
};
}
if (typeof result?.promptTokens === 'number' && typeof result?.outputTokens === 'number') {
return { inputTokens: result.promptTokens, outputTokens: result.outputTokens };
}
if (result?.metadata && typeof result.metadata.promptTokens === 'number' && typeof result.metadata.outputTokens === 'number') {
return { inputTokens: result.metadata.promptTokens, outputTokens: result.metadata.outputTokens };
}
return null;
}

private estimateTokenCountsFromMessage(req: ChatRequest, model: string): { inputTokens: number; outputTokens: number } {
let inputTokens = 0;
let outputTokens = 0;
const msgText = (req as any).message?.text;
if (msgText) {
inputTokens = this.deps.sessionHandlers.estimateTokensFromText(msgText, model);
} else if (req.message?.parts) {
for (const part of req.message.parts) {
if (part?.text) { inputTokens += this.deps.sessionHandlers.estimateTokensFromText(part.text, model); }
}
}
const response = (req as any).response ?? req.response;
if (Array.isArray(response)) {
for (const r of response) {
if (typeof r?.value === 'string') { outputTokens += this.deps.sessionHandlers.estimateTokensFromText(r.value, model); }
}
}
return { inputTokens, outputTokens };
}

/**
 * Process the fallback JSONL content when cached data is unavailable.
 * Handles both VS Code delta-based and Copilot CLI JSONL formats, computing tokens directly.
 */
/**
 * Roll up a JSONL session file.
 *
 * Returns the number of lines that could not be parsed or processed. Zero means
 * the file was read cleanly — which is different from it producing no rollups,
 * since a valid session file can legitimately contain no billable activity.
 */
private processJsonlSessionFallback(
content: string,
sessionFile: string,
fileMtimeMs: number,
startMs: number,
workspaceId: string,
machineId: string,
userId: string | undefined,
editorForFile: string | undefined,
rollups: Map<string, { key: DailyRollupKey; value: DailyRollupValue }>
): number {
const isVsCodeFormat = this.detectFallbackFormat(content);
const lines = content.trim().split('\n');
const ctx = { workspaceId, machineId, userId, editorForFile, rollups };
const failedLines = isVsCodeFormat
? this.runVsCodeDeltaFallback(lines, fileMtimeMs, startMs, ctx)
: this.runCliJsonlFallback(lines, fileMtimeMs, startMs, ctx);
if (failedLines > 0) {
this.deps.logger.warn(`Backend sync: ${failedLines} unparseable line(s) in ${sessionFile}`);
}
return failedLines;
}

private detectFallbackFormat(content: string): boolean {
const firstLine = content.trim().split('\n')[0]?.trim();
if (!firstLine) { return false; }
try {
const firstEv = JSON.parse(firstLine);
return typeof firstEv.kind === 'number';
} catch { return false; }
}

/** Returns the number of lines that could not be parsed or processed. */
private runVsCodeDeltaFallback(
lines: string[],
fileMtimeMs: number,
startMs: number,
ctx: { workspaceId: string; machineId: string; userId: string | undefined; editorForFile: string | undefined; rollups: Map<string, { key: DailyRollupKey; value: DailyRollupValue }> }
): number {
let defaultModel = 'unknown';
let failedLines = 0;
const seenReqIds = new Set<string>();
for (const line of lines) {
if (!line.trim()) { continue; }
try {
const event = JSON.parse(line);
if (!isEventRecord(event)) { failedLines++; continue; }
defaultModel = this.updateFallbackVsCodeModel(event, defaultModel);
failedLines += this.upsertVsCodeFallbackRequests(event, defaultModel, seenReqIds, fileMtimeMs, startMs, ctx);
} catch { failedLines++; }
}
return failedLines;
}

private updateFallbackVsCodeModel(event: any, defaultModel: string): string {
if (event.kind === 0) {
const mId = this.getFallbackKind0ModelId(event);
if (mId) { return mId.replace(/^copilot\//, ''); }
}
if (event.kind === 2 && Array.isArray(event.k) && event.k[0] === 'selectedModel') {
const mId = event.v?.identifier || event.v?.metadata?.id;
if (mId) { return mId.replace(/^copilot\//, ''); }
}
return defaultModel;
}

private getFallbackKind0ModelId(event: any): string | undefined {
return event.v?.selectedModel?.identifier ||
event.v?.selectedModel?.metadata?.id ||
event.v?.inputState?.selectedModel?.metadata?.id;
}

private upsertVsCodeFallbackRequests(
event: any,
defaultModel: string,
seenReqIds: Set<string>,
fileMtimeMs: number,
startMs: number,
ctx: { workspaceId: string; machineId: string; userId: string | undefined; editorForFile: string | undefined; rollups: Map<string, { key: DailyRollupKey; value: DailyRollupValue }> }
): number {
const payload = this.readDeltaRequestsPayload(event);
if (payload === 'malformed') { return 1; }
if (payload === 'not-requests') { return 0; }
let failed = 0;
for (const request of payload) {
// Same contract as the cached delta parser: a non-object entry is a record we
// could not read, not an absent one.
if (!isEventRecord(request)) { failed++; continue; }
this.upsertVsCodeFallbackSingleRequest(request, defaultModel, seenReqIds, fileMtimeMs, startMs, ctx);
}
return failed;
}

private upsertVsCodeFallbackSingleRequest(
request: any,
defaultModel: string,
seenReqIds: Set<string>,
fileMtimeMs: number,
startMs: number,
ctx: { workspaceId: string; machineId: string; userId: string | undefined; editorForFile: string | undefined; rollups: Map<string, { key: DailyRollupKey; value: DailyRollupValue }> }
): void {
const req = request as ChatRequest;
const reqId = (req as any).requestId as string | undefined;
if (reqId && seenReqIds.has(reqId)) { return; }
if (reqId) { seenReqIds.add(reqId); }
const normalizedTs = this.utility.normalizeTimestampToMs(typeof req.timestamp !== 'undefined' ? req.timestamp : undefined);
const eventMs = Number.isFinite(normalizedTs) ? normalizedTs : fileMtimeMs;
if (!eventMs || eventMs < startMs) { return; }
const dayKey = this.utility.toUtcDayKey(new Date(eventMs));
const rawModel = (req as any).modelId || (req as any).result?.metadata?.modelId;
const model = rawModel ? (rawModel as string).replace(/^copilot\//, '') : defaultModel;
const { inputTokens, outputTokens } = this.extractTokenCountsFromRequest(req, model);
if (inputTokens === 0 && outputTokens === 0) { return; }
const key: DailyRollupKey = { day: dayKey, model, workspaceId: ctx.workspaceId, machineId: ctx.machineId, userId: ctx.userId, editor: ctx.editorForFile };
upsertDailyRollup(ctx.rollups, key, { inputTokens, outputTokens, interactions: 1 });
}

/** Returns the number of lines that could not be parsed or processed. */
private runCliJsonlFallback(
lines: string[],
fileMtimeMs: number,
startMs: number,
ctx: { workspaceId: string; machineId: string; userId: string | undefined; editorForFile: string | undefined; rollups: Map<string, { key: DailyRollupKey; value: DailyRollupValue }> }
): number {
let defaultModel = 'unknown';
let failedLines = 0;
for (const line of lines) {
if (!line.trim()) { continue; }
try {
const event = JSON.parse(line);
if (!isEventRecord(event)) { failedLines++; continue; }
defaultModel = this.updateCliDefaultModel(event, defaultModel);
const normalizedTs = this.utility.normalizeTimestampToMs(event.timestamp);
const eventMs = Number.isFinite(normalizedTs) ? normalizedTs : fileMtimeMs;
if (!eventMs || eventMs < startMs) { continue; }
const dayKey = this.utility.toUtcDayKey(new Date(eventMs));
const model = this.getCliEventModel(event, defaultModel);
const { inputTokens, outputTokens, interactions } = this.getCliEventTokenCounts(event, model);
if (inputTokens === 0 && outputTokens === 0 && interactions === 0) { continue; }
const key: DailyRollupKey = { day: dayKey, model, workspaceId: ctx.workspaceId, machineId: ctx.machineId, userId: ctx.userId, editor: ctx.editorForFile };
upsertDailyRollup(ctx.rollups, key, { inputTokens, outputTokens, interactions });
} catch { failedLines++; }
}
return failedLines;
}

private updateCliDefaultModel(event: any, defaultModel: string): string {
if (event.type === 'session.start' && typeof event.data?.selectedModel === 'string') { return event.data.selectedModel; }
if (event.type === 'session.model_change' && typeof event.data?.newModel === 'string') { return event.data.newModel; }
return defaultModel;
}

private getCliEventModel(event: any, defaultModel: string): string {
return (event.data?.model || event.model || defaultModel).toString();
}

private getCliEventTokenCounts(event: any, model: string): { inputTokens: number; outputTokens: number; interactions: number } {
if (event.type === 'user.message' && event.data?.content) {
return { inputTokens: this.deps.sessionHandlers.estimateTokensFromText(event.data.content, model), outputTokens: 0, interactions: 1 };
}
if (event.type === 'assistant.message' && event.data?.content) {
return { inputTokens: 0, outputTokens: this.deps.sessionHandlers.estimateTokensFromText(event.data.content, model), interactions: 0 };
}
if (event.type === 'tool.result' && event.data?.output) {
return { inputTokens: this.deps.sessionHandlers.estimateTokensFromText(event.data.output, model), outputTokens: 0, interactions: 0 };
}
return { inputTokens: 0, outputTokens: 0, interactions: 0 };
}

/**
 * Process the fallback JSON content when cached data is unavailable.
 * Handles the VS Code Copilot Chat legacy JSON format.
 *
 * Returns the number of records that could not be parsed or processed: 1 when
 * the file itself is unparseable or is not a JSON object, otherwise one per
 * request that threw while being rolled up. A non-zero result means the file's
 * usage is not fully represented in `rollups`, so an empty scan that includes
 * it must not be reported as a successful no-op.
 */
private processJsonSessionFallback(
content: string,
sessionFile: string,
fileMtimeMs: number,
startMs: number,
workspaceId: string,
machineId: string,
userId: string | undefined,
editorForFile: string | undefined,
rollups: Map<string, { key: DailyRollupKey; value: DailyRollupValue }>
): number {
let sessionJson: unknown;
try {
sessionJson = JSON.parse(content);
if (!isEventRecord(sessionJson)) {
this.deps.logger.warn(`Backend sync: session file has invalid JSON structure: ${sessionFile}`);
return 1;
}
} catch (e) {
this.deps.logger.warn(`Backend sync: failed to parse JSON session file ${sessionFile}: ${e}`);
return 1;
}
const sessionObj = sessionJson as Record<string, unknown>;
// This is the catch-all branch for every non-JSONL session file, so a document
// without a `requests` array is one we cannot extract usage from at all. Falling
// back to `[]` reported it as a clean, empty file, which is exactly the "user with
// no data" signal a file we failed to understand must not produce. An empty
// `requests` array is still a genuine empty session and stays successful.
if (!Array.isArray(sessionObj.requests)) {
this.deps.logger.warn(`Backend sync: session file has no "requests" array: ${sessionFile}`);
return 1;
}
const requests = sessionObj.requests as unknown[];
let failedRequests = 0;
for (const request of requests) {
if (!isEventRecord(request)) {
this.deps.logger.warn(`Backend sync: skipping malformed request record in ${sessionFile}`);
failedRequests++;
continue;
}
try {
this.rollUpJsonRequest(request as ChatRequest, sessionObj, { fileMtimeMs, startMs, workspaceId, machineId, userId, editorForFile, rollups });
} catch (e) {
this.deps.logger.warn(`Backend sync: failed to process request in ${sessionFile}: ${e}`);
failedRequests++;
}
}
return failedRequests;
}

/** Fold a single legacy JSON request into `rollups`, skipping it when it falls outside the window or carries no tokens. */
private rollUpJsonRequest(
req: ChatRequest,
sessionObj: Record<string, unknown>,
ctx: { fileMtimeMs: number; startMs: number; workspaceId: string; machineId: string; userId: string | undefined; editorForFile: string | undefined; rollups: Map<string, { key: DailyRollupKey; value: DailyRollupValue }> }
): void {
const normalizedTs = this.utility.normalizeTimestampToMs(
typeof req.timestamp !== 'undefined' ? req.timestamp : (sessionObj.lastMessageDate as unknown)
);
const eventMs = Number.isFinite(normalizedTs) ? normalizedTs : ctx.fileMtimeMs;
if (!eventMs || eventMs < ctx.startMs) { return; }
const dayKey = this.utility.toUtcDayKey(new Date(eventMs));
const model = this.deps.sessionHandlers.getModelFromRequest(req);
const { inputTokens, outputTokens } = this.extractTokenCountsFromRequest(req, model);
if (inputTokens === 0 && outputTokens === 0) { return; }
const key: DailyRollupKey = { day: dayKey, model, workspaceId: ctx.workspaceId, machineId: ctx.machineId, userId: ctx.userId, editor: ctx.editorForFile };
upsertDailyRollup(ctx.rollups, key, { inputTokens, outputTokens, interactions: 1 });
}
	/**
	 * Compute daily rollups from local session files.
	 * Uses cached session data when available to avoid re-parsing files.
	 */
	private async computeDailyRollupsFromLocalSessions(args: { lookbackDays: number; userId?: string; sessionFiles?: string[]; skipMtimeFilter?: boolean; includeEditorDimension?: boolean; collectEditorType?: boolean; onProgress?: (processed: number, total: number, daysFound: number) => void }): Promise<{
		rollups: Map<string, { key: DailyRollupKey; value: DailyRollupValue }>;
		workspaceNamesById: Record<string, string>;
		machineNamesById: Record<string, string>;
		editorTypeByFile: Map<string, string>;
		/**
		 * Number of discovered session files that could not be read, parsed or
		 * stat'ed. These failures are logged and skipped, so an empty `rollups`
		 * map on its own cannot tell "the user genuinely has no data" apart from
		 * "the data is there but none of it could be read".
		 */
		filesFailed: number;
	}> {
		const lookbackDays = args.lookbackDays;
		const skipMtimeFilter = args.skipMtimeFilter === true;
		const includeEditorDimension = args.includeEditorDimension === true;
		const collectEditorType = args.collectEditorType === true;
		const onProgress = args.onProgress;
		const userId = (args.userId ?? '').trim() || undefined;
		const now = new Date();
		const start = new Date(now.getTime());
		start.setUTCHours(0, 0, 0, 0);
		start.setUTCDate(start.getUTCDate() - (lookbackDays - 1));
		const startMs = start.getTime();
		const todayKey = this.utility.toUtcDayKey(now);
		const startKey = this.utility.toUtcDayKey(start);
		this.deps.logger.log(`Backend sync: processing sessions from ${startKey} to ${todayKey} (lookback ${lookbackDays} days)`);

		const machineId = vscode.env.machineId;
		const rollups = new Map<string, { key: DailyRollupKey; value: DailyRollupValue }>();
		const workspaceNamesById: Record<string, string> = {};
		const machineNamesById: Record<string, string> = {};
		const editorTypeByFile = new Map<string, string>();
		const machineName = this.utility.normalizeNameForStorage(this.utility.stripHostnameDomain(os.hostname()));
		if (machineName) { machineNamesById[machineId] = machineName; }

		const sessionFiles = args.sessionFiles ?? await this.deps.sessionHandlers.getCopilotSessionFiles();
		const useCachedData = !!this.deps.sessionHandlers.getSessionFileDataCached;
		const progress = { filesSkipped: 0, filesProcessed: 0, cacheHits: 0, cacheMisses: 0, filesFailed: 0 };
		const totalFiles = sessionFiles.length;
		this.deps.logger.log(`Backend sync: analyzing ${totalFiles} session files`);

		for (const sessionFile of sessionFiles) {
			await this.processOneSessionForRollup(sessionFile, {
				skipMtimeFilter, startMs, now, machineId, userId,
				includeEditorDimension, useCachedData, rollups,
				workspaceNamesById, totalFiles, onProgress, progress,
				editorTypeByFile, collectEditorType
			});
		}

		if (useCachedData) { this.logCachePerformance(progress.cacheHits, progress.cacheMisses); }
		this.deps.logger.log(`Backend sync: processed ${progress.filesProcessed} files, skipped ${progress.filesSkipped} files outside lookback period`);
		if (progress.filesFailed > 0) {
			this.deps.logger.warn(`Backend sync: ${progress.filesFailed} session file(s) could not be read or parsed and were left out of the rollups`);
		}
		return { rollups, workspaceNamesById, machineNamesById, editorTypeByFile, filesFailed: progress.filesFailed };
	}

	private async tryProcessSpecialSession(
		sessionFile: string, fileMtimeMs: number,
		sessionArgs: ReturnType<typeof this.makeSessionRollupArgs>,
		isType: (f: string) => boolean,
		process: (f: string, mtime: number, args: ReturnType<typeof this.makeSessionRollupArgs>) => Promise<boolean>,
		filesSkipped: { count: number },
		filesFailed: { count: number }
	): Promise<boolean> {
		if (!isType(sessionFile)) { return false; }
		try {
			const processed = await process(sessionFile, fileMtimeMs, sessionArgs);
			if (!processed) { filesSkipped.count++; }
		} catch (e) {
			this.deps.logger.warn(`Backend sync: failed to process session ${sessionFile}: ${e}`);
			filesFailed.count++;
		}
		return true;
	}

	private async processOneSessionForRollup(
		sessionFile: string,
		ctx: {
			skipMtimeFilter: boolean; startMs: number; now: Date; machineId: string;
			userId: string | undefined; includeEditorDimension: boolean; useCachedData: boolean;
			rollups: Map<string, { key: DailyRollupKey; value: DailyRollupValue }>;
			workspaceNamesById: Record<string, string>; totalFiles: number;
			onProgress: ((processed: number, total: number, daysFound: number) => void) | undefined;
			progress: { filesSkipped: number; filesProcessed: number; cacheHits: number; cacheMisses: number; filesFailed: number };
			editorTypeByFile: Map<string, string>;
			collectEditorType: boolean;
		}
	): Promise<void> {
		// Classify the editor type before the lookback filter so that every
		// discovered file — including ones older than the lookback window —
		// gets an entry in the blob-upload map when the editor type can be
		// determined.  The upload list is the full discovery list, not just
		// files within the lookback.
		// When includeEditorDimension is true the rollup itself needs the
		// label, so classify unconditionally.  When it is false, only
		// classify when the blob upload needs the map, to avoid blocking
		// I/O on every table-only sync.
		const needsClassification = ctx.includeEditorDimension || ctx.collectEditorType;
		const editorForFile = needsClassification ? this.getEditorForFile(sessionFile, true) : undefined;
		if (editorForFile) { ctx.editorTypeByFile.set(sessionFile, editorForFile); }

		const fileMtimeMs = await this.statSessionFileForRollup(sessionFile, ctx);
		if (fileMtimeMs === undefined) { return; }
		const editorForRollup = ctx.includeEditorDimension ? editorForFile : undefined;
		if (this.isVSSessionFileType(sessionFile)) { ctx.progress.filesSkipped++; return; }
		const sessionArgs = this.makeSessionRollupArgs(ctx.machineId, ctx.userId, editorForRollup, ctx.workspaceNamesById, ctx.rollups, ctx.startMs);
		const skipped = { count: 0 };
		const failed = { count: 0 };
		if (await this.tryProcessSpecialSession(sessionFile, fileMtimeMs, sessionArgs, this.isOpenCodeSessionType.bind(this), this.processOpenCodeSession.bind(this), skipped, failed)) { ctx.progress.filesSkipped += skipped.count; ctx.progress.filesFailed += failed.count; return; }
		if (await this.tryProcessSpecialSession(sessionFile, fileMtimeMs, sessionArgs, this.isCrushSessionType.bind(this), this.processCrushSession.bind(this), skipped, failed)) { ctx.progress.filesSkipped += skipped.count; ctx.progress.filesFailed += failed.count; return; }
		const workspaceId = this.utility.extractWorkspaceIdFromSessionPath(sessionFile);
		await this.ensureWorkspaceNameResolved(workspaceId, sessionFile, ctx.workspaceNamesById);
		if (ctx.useCachedData) {
			const fileStat = await this.deps.sessionHandlers.statSessionFile(sessionFile);
			const cacheSuccess = await this.processCachedSessionFile(sessionFile, fileMtimeMs, fileStat.size, workspaceId, ctx.machineId, ctx.userId, ctx.rollups, ctx.startMs, ctx.now, editorForRollup);
			if (cacheSuccess) { ctx.progress.cacheHits++; return; }
			ctx.progress.cacheMisses++;
		}
		let content: string;
		try {
			content = await fs.promises.readFile(sessionFile, 'utf8');
		} catch (e) {
			this.deps.logger.warn(`Backend sync: failed to read session file ${sessionFile}: ${e}`);
			ctx.progress.filesFailed++;
			return;
		}
		this.runContentFallback(content, sessionFile, fileMtimeMs, workspaceId, editorForRollup, ctx);
	}

	/**
	 * Roll a session file up from its raw contents, counting a file whose contents
	 * could not be parsed towards `filesFailed` so that an empty scan can be told
	 * apart from a failed one.
	 */
	private runContentFallback(
		content: string,
		sessionFile: string,
		fileMtimeMs: number,
		workspaceId: string,
		editorForRollup: string | undefined,
		ctx: {
			startMs: number; machineId: string; userId: string | undefined;
			rollups: Map<string, { key: DailyRollupKey; value: DailyRollupValue }>;
			progress: { filesFailed: number };
		}
	): void {
		if (sessionFile.endsWith('.jsonl') || isJsonlContent(content)) {
			if (this.processJsonlSessionFallback(content, sessionFile, fileMtimeMs, ctx.startMs, workspaceId, ctx.machineId, ctx.userId, editorForRollup, ctx.rollups) > 0) {
				ctx.progress.filesFailed++;
			}
			return;
		}
		if (this.processJsonSessionFallback(content, sessionFile, fileMtimeMs, ctx.startMs, workspaceId, ctx.machineId, ctx.userId, editorForRollup, ctx.rollups) > 0) {
			ctx.progress.filesFailed++;
		}
	}

	private async statSessionFileForRollup(
		sessionFile: string,
		ctx: {
			skipMtimeFilter: boolean; startMs: number; totalFiles: number;
			onProgress: ((processed: number, total: number, daysFound: number) => void) | undefined;
			rollups: Map<string, { key: DailyRollupKey; value: DailyRollupValue }>;
			progress: { filesSkipped: number; filesProcessed: number; cacheHits: number; cacheMisses: number; filesFailed: number };
		}
	): Promise<number | undefined> {
		try {
			const fileStat = await this.deps.sessionHandlers.statSessionFile(sessionFile);
			const fileMtimeMs = fileStat.mtimeMs;
			if (!ctx.skipMtimeFilter && fileMtimeMs < ctx.startMs) { ctx.progress.filesSkipped++; return undefined; }
			ctx.progress.filesProcessed++;
			if (ctx.onProgress && ctx.progress.filesProcessed % 10 === 0) {
				const daysFound = new Set(Array.from(ctx.rollups.values()).map(r => r.key.day)).size;
				ctx.onProgress(ctx.progress.filesProcessed, ctx.totalFiles, daysFound);
			}
			return fileMtimeMs;
		} catch (e) {
			this.deps.logger.warn(`Backend sync: failed to stat session file ${sessionFile}: ${e}`);
			ctx.progress.filesFailed++;
			return undefined;
		}
	}

	private getEditorForFile(sessionFile: string, includeEditorDimension: boolean): string | undefined {
		if (!includeEditorDimension) { return undefined; }
		const label = this.deps.getEditorLabel?.(sessionFile) ??
			getEditorTypeFromPath(sessionFile, this.deps.editorHandlers?.isOpenCodeSession);
		// Break out "Copilot App" and "Claude (VS Code)" from the coarser path-based label so
		// the sharing-server "Editors Used" breakdown matches the local Interaction Modes view.
		return refineEditorLabelForInteractionModeSplit(sessionFile, label);
	}

	private isVSSessionFileType(sessionFile: string): boolean {
		return !!(this.deps.editorHandlers?.isVSSessionFile?.(sessionFile));
	}

	private isOpenCodeSessionType(sessionFile: string): boolean {
		return !!(this.deps.editorHandlers?.isOpenCodeSession?.(sessionFile));
	}

	private isCrushSessionType(sessionFile: string): boolean {
		return !!(this.deps.editorHandlers?.isCrushSession?.(sessionFile));
	}

	/**
	 * Sync local session data to the backend store.
	 * @param force - If true, forces sync even if recently synced
	 * @param settings - Backend settings for sync configuration
	 * @param isConfigured - Whether the backend is fully configured
	 * @throws Error if sync fails due to network or auth issues
	 */
	async syncToBackendStore(force: boolean, settings: BackendSettings, isConfigured: boolean): Promise<SyncResult> {
		const run = this.syncQueue.then(() => this.doSyncToBackendStore(force, settings, isConfigured));
		this.syncQueue = run;
		return run;
	}

	private logSyncSkipReason(isConfigured: boolean, settings: BackendSettings): void {
		if (settings.sharingProfile === 'off') {
			this.deps.logger.log(`Backend sync: skipping (sharing policy does not allow cloud sync, profile: ${settings.sharingProfile})`);
		} else if (!isConfigured) {
			this.deps.logger.log('Backend sync: skipping (neither Azure Storage nor Team Server is configured)');
		}
	}

	private async checkSyncThrottle(force: boolean): Promise<boolean> {
		const lastSyncAt = this.deps.context?.globalState.get<number>('backend.lastSyncAt');
		if (!force && lastSyncAt && Date.now() - lastSyncAt < BACKEND_SYNC_MIN_INTERVAL_MS) {
			const secondsSinceLastSync = Math.round((Date.now() - lastSyncAt) / 1000);
			this.deps.logger.log(`Backend sync: skipping (last sync was ${secondsSinceLastSync}s ago, minimum interval is ${BACKEND_SYNC_MIN_INTERVAL_MS / 1000}s)`);
			return true;
		}
		return false;
	}

	/** Updates the shared "last sync attempt" marker used only for the throttle check above. */
	private async tryUpdateLastSyncAt(): Promise<void> {
		try {
			await this.deps.context?.globalState.update('backend.lastSyncAt', Date.now());
		} catch (e) {
			this.deps.logger.warn(`Backend sync: failed to update lastSyncAt: ${e}`);
		}
	}

	/** Updates the Azure-Storage-specific "last successful sync" marker shown in its own status panel. */
	private async tryUpdateAzureLastSyncAt(): Promise<void> {
		try {
			await this.deps.context?.globalState.update('backend.azureLastSyncAt', Date.now());
		} catch (e) {
			this.deps.logger.warn(`Backend sync: failed to update azure lastSyncAt: ${e}`);
		}
	}

	/**
	 * Updates the Team Server "last successful sync" marker shown in its status panel.
	 *
	 * This tracks the usage-rollup upload only. The fluency-score upload has its
	 * own marker: the two run on different schedules and can fail independently,
	 * and while they shared this key a small score POST succeeding every couple of
	 * minutes kept the indicator green while rollup uploads failed for hours.
	 *
	 * The key is deliberately new rather than the legacy `backend.sharingServerLastSyncAt`.
	 * That value is still on disk from versions where both uploads wrote it, so it
	 * cannot be read as evidence of a rollup upload — reusing it would display a
	 * score-only timestamp as a confirmed usage sync and keep a failing rollup
	 * upload hidden behind it after upgrade. Starting empty costs one sync cycle
	 * of "never" and is self-healing.
	 */
	private async tryUpdateSharingServerLastSyncAt(): Promise<void> {
		try {
			await this.deps.context?.globalState.update('backend.sharingServerRollupLastSyncAt', Date.now());
		} catch (e) {
			this.deps.logger.warn(`Backend sync: failed to update sharing server lastSyncAt: ${e}`);
		}
	}

	/** Updates the Team Server "last successful fluency-score upload" marker, tracked separately from the rollup sync above. */
	private async tryUpdateSharingServerFluencyLastSyncAt(): Promise<void> {
		try {
			await this.deps.context?.globalState.update('backend.sharingServerFluencyLastSyncAt', Date.now());
		} catch (e) {
			this.deps.logger.warn(`Backend sync: failed to update sharing server fluency lastSyncAt: ${e}`);
		}
	}

	/** Runs the Azure Table Storage sync in isolation, logging (but not throwing) on failure. */
	private async runAzureSyncIndependently(settings: BackendSettings, sharingPolicy: ReturnType<typeof computeBackendSharingPolicy>): Promise<SyncTargetOutcome> {
		try {
			return await this.performAzureTableSync(settings, sharingPolicy);
		} catch (e: unknown) {
			const secretsToRedact = await this.credentialService.getBackendSecretsToRedactForError(settings);
			this.deps.logger.warn(`Backend sync: ${safeStringifyError(e, secretsToRedact)}`);
			return 'failed';
		}
	}

	/** Runs the Team Server (sharing server) sync in isolation, logging (but not throwing) on failure. */
	private async runSharingServerSyncIndependently(settings: BackendSettings, sharingPolicy: ReturnType<typeof computeBackendSharingPolicy>): Promise<SyncTargetOutcome> {
		try {
			// Only advance the marker when data actually reached the server. The
			// upload service swallows HTTP and network errors and returns normally,
			// so updating this unconditionally made "Last Sync" report a healthy
			// recent sync while nothing had been uploaded for hours. A delivery
			// failure throws and is caught below; `false` means the pass could not
			// run at all, which is a skip rather than a success.
			if (!await this.syncToSharingServer(settings, sharingPolicy)) { return 'skipped'; }
			await this.tryUpdateSharingServerLastSyncAt();
			return 'synced';
		} catch (ssErr: unknown) {
			this.deps.logger.warn(`Sharing server sync: failed - ${safeStringifyError(ssErr)}`);
			return 'failed';
		}
	}

	/**
	 * Runs one target's sync under that target endpoint's own cross-window lock, so two windows
	 * uploading to the same endpoint serialize regardless of their other targets, other windows'
	 * endpoints, or their `backend.backend` selector.
	 */
	private async runUnderTargetLock(kind: 'azure' | 'sharingserver', endpoint: string, label: string, run: () => Promise<SyncTargetOutcome>): Promise<SyncTargetOutcome> {
		const token = syncTargetLockToken(kind, endpoint);
		const lockName = targetSyncLockName(kind, token);
		const skipReason = `Backend sync: skipping ${label} (another VS Code window is currently syncing to the same endpoint)`;
		if (await this.isLegacyLockHeldFor(token)) {
			this.deps.logger.log(skipReason);
			return 'skipped';
		}
		if (!await this.acquireSyncLock(lockName, token)) {
			this.deps.logger.log(skipReason);
			return 'skipped';
		}
		try {
			return await run();
		} finally {
			await this.releaseSyncLock(lockName);
		}
	}

	/** Whether a window still running an older extension version holds a legacy lock covering `token`. */
	private async isLegacyLockHeldFor(token: string): Promise<boolean> {
		for (const legacyName of LEGACY_SYNC_LOCK_NAMES) {
			if (await this.syncLock.isHeldByAnotherWindow(legacyName, (url) => legacyLockCoversTarget(url, token))) {
				return true;
			}
		}
		return false;
	}

	private async doSyncToBackendStore(force: boolean, settings: BackendSettings, isConfigured: boolean): Promise<SyncResult> {
		if (this.backendSyncInProgress) { return {}; }
		if (settings.sharingProfile === 'off' || !isConfigured) {
			this.logSyncSkipReason(isConfigured, settings);
			return {};
		}

		// Azure Storage and the Team Server are independent sync targets: either, both, or
		// neither may be enabled at any time, and each must run — and report its own
		// success/failure and "last sync" timestamp — without the other affecting it.
		// Azure is gated on `backend.enabled`; the Team Server has its own toggle and must
		// not depend on the Azure one.
		const { azure: azureConfigured, sharingServer: sharingConfigured } = resolveSyncTargets(settings);
		if (!azureConfigured && !sharingConfigured) {
			this.deps.logger.log(`Backend sync: skipping (${NO_SYNC_TARGET_REASON})`);
			return {};
		}
		if (await this.checkSyncThrottle(force)) { return {}; }
		// Target gating is done above; the policy here only shapes the uploaded payload.
		const sharingPolicy = computeBackendSharingPolicy({
			enabled: true,
			profile: settings.sharingProfile,
			shareWorkspaceMachineNames: settings.shareWorkspaceMachineNames
		});

		const result: SyncResult = {};
		this.backendSyncInProgress = true;
		try {
			await this.tryUpdateLastSyncAt();
			if (azureConfigured) {
				result.azure = await this.runUnderTargetLock('azure', settings.storageAccount, 'Azure Storage',
					() => this.runAzureSyncIndependently(settings, sharingPolicy));
			}
			if (sharingConfigured) {
				result.sharingServer = await this.runUnderTargetLock('sharingserver', settings.sharingServerEndpointUrl, 'Team Server',
					() => this.runSharingServerSyncIndependently(settings, sharingPolicy));
			}
			this.consecutiveFailures = 0;
		} finally {
			this.backendSyncInProgress = false;
		}
		return result;
	}

	private checkBlobUploadNeeded(settings: BackendSettings): boolean {
		if (!settings.blobUploadEnabled || !this.blobUploadService) { return false; }
		const machineId = vscode.env.machineId;
		const uploadSettings = { enabled: settings.blobUploadEnabled, containerName: settings.blobContainerName, uploadFrequencyHours: settings.blobUploadFrequencyHours, compressFiles: settings.blobCompressFiles };
		const needed = this.blobUploadService.shouldUpload(machineId, uploadSettings);
		if (needed) {
			this.deps.logger.log('Blob upload: will upload session files after table sync');
		} else {
			const status = this.blobUploadService.getUploadStatus(machineId);
			const hoursSince = status ? Math.round((Date.now() - status.lastUploadTime) / (1000 * 60 * 60)) : 0;
			this.deps.logger.log(`Blob upload: not needed (last upload ${hoursSince}h ago, frequency: ${settings.blobUploadFrequencyHours}h)`);
		}
		return needed;
	}

	private getSortedDayKeys(rollups: Map<string, { key: DailyRollupKey; value: DailyRollupValue }>): string[] {
		const dayKeys = new Set<string>();
		for (const { key } of rollups.values()) { dayKeys.add(key.day); }
		return Array.from(dayKeys).sort();
	}

	private async maybeCleanStaleEntities(
		settings: BackendSettings,
		resolvedIdentity: { userId?: string; userKeyType?: BackendUserIdentityMode },
		sortedDays: string[],
		tableClient: any
	): Promise<void> {
		const CLEAN_SYNC_VERSION = 2;
		const lastCleanVersion = this.deps.context?.globalState.get<number>('backend.lastCleanSyncVersion') ?? 0;
		if (lastCleanVersion >= CLEAN_SYNC_VERSION || !resolvedIdentity.userId || sortedDays.length === 0) { return; }
		const startDayKey = sortedDays[0];
		const endDayKey = sortedDays[sortedDays.length - 1];
		this.deps.logger.log(`Backend sync: cleaning stale entities for user "${resolvedIdentity.userId}" (${startDayKey} to ${endDayKey})`);
		try {
			const deleteResult = await this.dataPlaneService.deleteEntitiesForUserDataset({ tableClient, userId: resolvedIdentity.userId, datasetId: settings.datasetId, startDayKey, endDayKey });
			this.deps.logger.log(`Backend sync: deleted ${deleteResult.deletedCount} stale entities (${deleteResult.errors.length} errors)`);
			await this.deps.context?.globalState.update('backend.lastCleanSyncVersion', CLEAN_SYNC_VERSION);
		} catch (e) {
			this.deps.logger.warn(`Backend sync: failed to clean stale entities: ${e}`);
		}
	}

	private buildEntitiesForSync(
		rollups: Map<string, { key: DailyRollupKey; value: DailyRollupValue }>,
		settings: BackendSettings,
		sharingPolicy: ReturnType<typeof computeBackendSharingPolicy>,
		resolvedIdentity: { userId?: string; userKeyType?: BackendUserIdentityMode },
		workspaceNamesById: Record<string, string>,
		machineNamesById: Record<string, string>
	): BackendAggDailyEntityLike[] {
		const entities: BackendAggDailyEntityLike[] = [];
		for (const { key, value } of rollups.values()) {
			const effectiveUserId = (key.userId ?? '').trim() || undefined;
			const includeConsent = sharingPolicy.includeUserDimension && !!effectiveUserId;
			const includeNames = sharingPolicy.includeNames;
			const { workspaceId: workspaceIdToStore, machineId: machineIdToStore } = applyIdStrategies(key, settings.datasetId, sharingPolicy);
			entities.push(createDailyAggEntity({
				datasetId: settings.datasetId, day: key.day, model: key.model,
				workspaceId: workspaceIdToStore, workspaceName: includeNames ? workspaceNamesById[key.workspaceId] : undefined,
				machineId: machineIdToStore, machineName: includeNames ? machineNamesById[key.machineId] : undefined,
				userId: effectiveUserId, userKeyType: resolvedIdentity.userKeyType,
				shareWithTeam: includeConsent ? true : undefined,
				consentAt: validateConsentTimestamp(settings.shareConsentAt, this.deps.logger.log),
				inputTokens: value.inputTokens, outputTokens: value.outputTokens,
				interactions: value.interactions, fluencyMetrics: value.fluencyMetrics
			}));
		}
		return entities;
	}

	private async performBlobUploadIfNeeded(settings: BackendSettings, creds: any, sessionFiles: string[], editorTypeByFile: Map<string, string>): Promise<void> {
		try {
			const machineId = vscode.env.machineId;
			const uploadSettings = { enabled: settings.blobUploadEnabled, containerName: settings.blobContainerName, uploadFrequencyHours: settings.blobUploadFrequencyHours, compressFiles: settings.blobCompressFiles };

			this.deps.logger.log('Blob upload: starting');
			const uploadResult = await this.blobUploadService!.uploadSessionFiles(settings.storageAccount, uploadSettings, creds.blobCredential, sessionFiles, machineId, settings.datasetId, editorTypeByFile);
			if (uploadResult.success) { this.deps.logger.log(`Blob upload: ${uploadResult.message}`); }
			else { this.deps.logger.warn(`Blob upload: ${uploadResult.message}`); }
		} catch (blobError: any) {
			this.deps.logger.warn(`Blob upload: failed - ${blobError?.message ?? blobError}`);
		}
	}

	/**
	 * Upserts local rollups into Azure Table Storage. Resolves `failed` — without touching the
	 * Azure "last sync" marker — when credentials are unavailable or any entity failed to upsert,
	 * so neither case can be reported as a successful sync.
	 */
	private async performAzureTableSync(settings: BackendSettings, sharingPolicy: ReturnType<typeof computeBackendSharingPolicy>): Promise<SyncTargetOutcome> {
		this.deps.logger.log('Backend sync: starting rollup sync');
		const creds = await this.credentialService.getBackendDataPlaneCredentials(settings);
		if (!creds) {
			this.deps.logger.warn('Backend sync: skipping (credentials not available - check authentication mode and secrets)');
			return 'failed';
		}
		await this.dataPlaneService.ensureTableExists(settings, creds.tableCredential);
		await this.dataPlaneService.validateAccess(settings, creds.tableCredential);

		const blobUploadNeeded = this.checkBlobUploadNeeded(settings);
		const sessionFiles = await this.deps.sessionHandlers.getCopilotSessionFiles();
		const resolvedIdentity = await this.resolveEffectiveUserIdentityForSync(settings, sharingPolicy.includeUserDimension);
		const { rollups, workspaceNamesById, machineNamesById, editorTypeByFile, filesFailed } = await this.computeDailyRollupsFromLocalSessions({
			lookbackDays: settings.lookbackDays, userId: resolvedIdentity.userId, sessionFiles,
			collectEditorType: blobUploadNeeded
		});

		const sortedDays = this.getSortedDayKeys(rollups);
		if (sortedDays.length > 0) { this.deps.logger.log(`Backend sync: processing data for ${sortedDays.length} days: ${sortedDays.join(', ')}`); }
		this.deps.logger.log(`Backend sync: upserting ${rollups.size} rollup entities (lookback ${settings.lookbackDays} days)`);

		const tableClient = this.dataPlaneService.createTableClient(settings, creds.tableCredential);
		await this.maybeCleanStaleEntities(settings, resolvedIdentity, sortedDays, tableClient);

		const entities = this.buildEntitiesForSync(rollups, settings, sharingPolicy, resolvedIdentity, workspaceNamesById, machineNamesById);
		const { successCount, errors } = await this.dataPlaneService.upsertEntitiesBatch(tableClient, entities);
		if (errors.length > 0) {
			this.deps.logger.warn(`Backend sync: ${successCount}/${entities.length} entities synced successfully, ${errors.length} failed`);
		} else {
			this.deps.logger.log(`Backend sync: ${successCount} entities synced successfully`);
		}

		// Same invariant as the Team Server marker: `upsertEntitiesBatch` catches
		// per entity and returns normally, so every entity can fail without this
		// method throwing. Advancing unconditionally made the Azure status panel
		// report a healthy recent sync while nothing had been stored.
		const outcome: SyncTargetOutcome = this.isAzureSyncSuccessful(successCount, errors.length, entities.length, filesFailed) ? 'synced' : 'failed';
		if (outcome === 'synced') {
			await this.tryUpdateAzureLastSyncAt();
			this.deps.logger.log('Backend sync: completed');
		} else {
			this.deps.logger.warn('Backend sync: completed with failures - not updating the last sync marker');
		}

		if (blobUploadNeeded && this.blobUploadService) { await this.performBlobUploadIfNeeded(settings, creds, sessionFiles, editorTypeByFile); }
		return outcome;
	}

	/**
	 * Whether an Azure Table sync pass delivered everything it found, and so may
	 * advance the "last successful sync" marker.
	 *
	 * Having nothing to store is a successful no-op, but only when the scan that
	 * produced it was clean: unreadable session files are logged and skipped, so
	 * local data can exist and still yield zero entities.
	 */
	private isAzureSyncSuccessful(successCount: number, errorCount: number, entityCount: number, filesFailed: number): boolean {
		if (errorCount > 0 || successCount !== entityCount) { return false; }
		return entityCount > 0 || filesFailed === 0;
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
	 * Sync daily rollups to the self-hosted sharing server using a GitHub Bearer token. Resolves
	 * `true` when the pass completed (including "nothing to upload") and `false` when it could not
	 * run at all (no upload service or no GitHub token). Throws when data existed but did not
	 * reach the server, so the caller records the target as failed rather than skipped.
	 */
	private async syncToSharingServer(
		settings: BackendSettings,
		sharingPolicy: ReturnType<typeof computeBackendSharingPolicy>,
	): Promise<boolean> {
		if (!this.sharingServerUploadService) {
			this.deps.logger.warn('Sharing server upload: service not available');
			return false;
		}

		const githubToken = this.deps.getGithubToken?.();
		if (!githubToken) {
			this.deps.logger.log('Sharing server upload: skipping (no GitHub token — authenticate with GitHub in VS Code first)');
			return false;
		}

		const resolvedIdentity = await this.resolveEffectiveUserIdentityForSync(
			settings,
			sharingPolicy.includeUserDimension,
		);
		const { rollups, workspaceNamesById, machineNamesById, filesFailed } =
			await this.computeDailyRollupsFromLocalSessions({
				lookbackDays: settings.lookbackDays,
				userId: resolvedIdentity.userId,
				includeEditorDimension: true,
			});

		if (rollups.size === 0) {
			// An empty scan is only a successful no-op when it is a *genuine* empty
			// scan. Unreadable or unparseable session files are logged and skipped,
			// so local data can exist and still produce no rollups — reporting that
			// as a successful sync is the same false "all good" signal this guards
			// against, just one layer earlier. Throwing rather than returning false
			// records the target as failed; false here means "could not run at all".
			if (filesFailed > 0) {
				throw new Error(`nothing to upload, but ${filesFailed} session file(s) could not be read`);
			}
			this.deps.logger.log('Sharing server upload: no data to upload');
			// Nothing to send and nothing failed: the sync ran and the server is
			// already up to date, so the marker should still advance. The failure
			// this guards against is data that exists and does not arrive, which is
			// handled by the upload result below.
			return true;
		}

		const entries = this.buildSharingServerEntries(rollups, settings, sharingPolicy, workspaceNamesById, machineNamesById);

		const totalInputTokens = entries.reduce((s, e) => s + e.inputTokens, 0);
		const totalOutputTokens = entries.reduce((s, e) => s + e.outputTokens, 0);
		this.deps.logger.log(`Sharing server upload: uploading ${entries.length} rollup entries (${(totalInputTokens + totalOutputTokens).toLocaleString()} tokens total)`);
		// uploadRollups reports HTTP/network failures and server-side rejections in its result
		// rather than throwing; turn both into errors so the caller records the target as failed.
		const upload = await this.sharingServerUploadService.uploadRollups(
			settings.sharingServerEndpointUrl,
			githubToken,
			entries,
			this.deps.logger.log,
			this.deps.logger.warn,
		);
		// `success` is already false unless the server reported every entry stored:
		// a 2xx alone is not enough, since the endpoint returns 200 with
		// `uploaded: 0` for validation or database failures. The count comparison
		// is kept as a second, local guard on the same invariant.
		if (!upload.success) {
			throw new Error(upload.message);
		}
		if (upload.entriesUploaded < entries.length) {
			throw new Error(`server accepted ${upload.entriesUploaded} of ${entries.length} entries`);
		}
		return true;
	}

	/**
	 * Build the Team Server upload payload for a set of daily rollups.
	 *
	 * Split out of syncToSharingServer purely to keep that method readable; it must
	 * stay in lockstep with buildEntitiesForSync so no sharing profile leaks raw
	 * workspace/machine IDs to one target while hashing them for the other.
	 */
	private buildSharingServerEntries(
		rollups: Map<string, { key: DailyRollupKey; value: DailyRollupValue }>,
		settings: BackendSettings,
		sharingPolicy: ReturnType<typeof computeBackendSharingPolicy>,
		workspaceNamesById: Record<string, string>,
		machineNamesById: Record<string, string>
	): SharingServerEntry[] {
		const includeNames = sharingPolicy.includeNames;
		const entries: SharingServerEntry[] = [];
		for (const { key, value } of rollups.values()) {
			// Same ID strategy as the Azure path: team profiles upload hashed workspace/machine
			// IDs, only soloFull uploads raw ones. Names are still looked up by the raw ID.
			const ids = applyIdStrategies(key, settings.datasetId, sharingPolicy);
			entries.push({
				day: key.day,
				model: key.model,
				workspaceId: ids.workspaceId,
				workspaceName: includeNames ? workspaceNamesById[key.workspaceId] : undefined,
				machineId: ids.machineId,
				machineName: includeNames ? machineNamesById[key.machineId] : undefined,
				inputTokens: value.inputTokens,
				outputTokens: value.outputTokens,
				interactions: value.interactions,
				datasetId: settings.datasetId,
				editor: key.editor ?? this.normalizeEditorName(vscode.env.appName),
				fluencyMetrics: value.fluencyMetrics as Record<string, unknown> | undefined,
			});
		}
		return entries;
	}

	/**
	 * Upload the extension's locally-computed fluency score to the sharing server.
	 * Call this after calculateMaturityScores() to keep the server dashboard in sync
	 * with the extension's AI Fluency Score panel.
	 */
	async uploadFluencyScoreToSharingServer(
		settings: BackendSettings,
		score: Record<string, unknown>,
	): Promise<void> {
		if (!this.sharingServerUploadService) { return; }
		// Same gate as rollup sync: toggle + endpoint, and a sharing profile other than 'off'.
		if (!resolveSyncTargets(settings).sharingServer) { return; }

		const githubToken = this.deps.getGithubToken?.();
		if (!githubToken) { return; }

		const uploaded = await this.sharingServerUploadService.uploadFluencyScore(
			settings.sharingServerEndpointUrl,
			githubToken,
			score,
			this.deps.logger.log,
			this.deps.logger.warn,
		);
		// The fluency score has its own marker: it is a separate, much smaller POST,
		// and letting it advance the rollup marker is exactly how a failing rollup
		// upload stayed invisible behind a succeeding score upload.
		if (uploaded) { await this.tryUpdateSharingServerFluencyLastSyncAt(); }
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
	async backfillSync(settings: BackendSettings, maxLookbackDays = 365, onProgress?: (processed: number, total: number, daysFound: number) => void): Promise<void> {
		const sharingPolicy = computeBackendSharingPolicy({
			enabled: settings.enabled,
			profile: settings.sharingProfile,
			shareWorkspaceMachineNames: settings.shareWorkspaceMachineNames
		});
		// Backfill writes to Azure Table Storage only, so it is gated solely on the Azure target
		// (backend.enabled + Azure fields + non-off profile), not on the backend.backend selector.
		if (!resolveSyncTargets(settings).azure) {
			this.deps.logger.warn('Backfill: skipping (Azure Storage sync disabled or not configured)');
			return;
		}

		this.deps.logger.log(`Backfill: starting deep scan (up to ${maxLookbackDays} days, mtime filter disabled)`);

		const creds = await this.credentialService.getBackendDataPlaneCredentials(settings);
		if (!creds) {
			this.deps.logger.warn('Backfill: skipping (credentials not available)');
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

		const sortedDays = this.getBackfillSortedDays(rollups);
		this.deps.logger.log(`Backfill: found data for ${sortedDays.length} days: ${sortedDays.slice(0, 10).join(', ')}${sortedDays.length > 10 ? '…' : ''}`);

		const tableClient = this.dataPlaneService.createTableClient(settings, creds.tableCredential);
		const entities = this.buildBackfillEntities(rollups, settings, sharingPolicy, resolvedIdentity, workspaceNamesById, machineNamesById);

		// Signal upload phase to caller before the (potentially slow) upsert
		onProgress?.(-1, entities.length, sortedDays.length);

		await this.cleanBackfillStaleEntities(tableClient, resolvedIdentity, settings, sortedDays);

		const { successCount, errors } = await this.dataPlaneService.upsertEntitiesBatch(tableClient, entities);
		if (errors.length > 0) {
			this.deps.logger.warn(`Backfill: ${successCount}/${entities.length} entities synced, ${errors.length} failed`);
		} else {
			this.deps.logger.log(`Backfill: ${successCount} entities synced successfully across ${sortedDays.length} days`);
		}
	}

	private getBackfillSortedDays(rollups: Map<string, { key: DailyRollupKey; value: DailyRollupValue }>): string[] {
		const dayKeys = new Set<string>();
		for (const { key } of rollups.values()) { dayKeys.add(key.day); }
		return Array.from(dayKeys).sort();
	}

	private buildBackfillEntities(
		rollups: Map<string, { key: DailyRollupKey; value: DailyRollupValue }>,
		settings: BackendSettings,
		sharingPolicy: ReturnType<typeof computeBackendSharingPolicy>,
		resolvedIdentity: { userId?: string; userKeyType?: BackendUserIdentityMode },
		workspaceNamesById: Record<string, string>,
		machineNamesById: Record<string, string>
	): BackendAggDailyEntityLike[] {
		const entities: BackendAggDailyEntityLike[] = [];
		for (const { key, value } of rollups.values()) {
			const effectiveUserId = (key.userId ?? '').trim() || undefined;
			const includeConsent = sharingPolicy.includeUserDimension && !!effectiveUserId;
			const includeNames = sharingPolicy.includeNames;
			const { workspaceId: workspaceIdToStore, machineId: machineIdToStore } = applyIdStrategies(key, settings.datasetId, sharingPolicy);
			entities.push(createDailyAggEntity({
				datasetId: settings.datasetId, day: key.day, model: key.model,
				workspaceId: workspaceIdToStore, workspaceName: includeNames ? workspaceNamesById[key.workspaceId] : undefined,
				machineId: machineIdToStore, machineName: includeNames ? machineNamesById[key.machineId] : undefined,
				userId: effectiveUserId, userKeyType: resolvedIdentity.userKeyType,
				shareWithTeam: includeConsent ? true : undefined,
				consentAt: validateConsentTimestamp(settings.shareConsentAt, this.deps.logger.log),
				inputTokens: value.inputTokens, outputTokens: value.outputTokens,
				interactions: value.interactions, fluencyMetrics: value.fluencyMetrics
			}));
		}
		return entities;
	}

	private async cleanBackfillStaleEntities(
		tableClient: any,
		resolvedIdentity: { userId?: string; userKeyType?: BackendUserIdentityMode },
		settings: BackendSettings,
		sortedDays: string[]
	): Promise<void> {
		if (!resolvedIdentity.userId || sortedDays.length === 0) { return; }
		const startDayKey = sortedDays[0];
		const endDayKey = sortedDays[sortedDays.length - 1];
		this.deps.logger.log(`Backfill: cleaning stale entities for user "${resolvedIdentity.userId}" in date range ${startDayKey} to ${endDayKey}`);
		try {
			const deleteResult = await this.dataPlaneService.deleteEntitiesForUserDataset({
				tableClient,
				userId: resolvedIdentity.userId,
				datasetId: settings.datasetId,
				startDayKey,
				endDayKey,
			});
			this.deps.logger.log(`Backfill: deleted ${deleteResult.deletedCount} stale entities (${deleteResult.errors.length} errors)`);
		} catch (e) {
			this.deps.logger.warn(`Backfill: failed to clean stale entities (continuing with upsert): ${e}`);
		}
	}
}

/**
 * The per-tool / per-server latency histograms (`latencyByTool`, `latencyByServer`,
 * ~25 integers per key — docs/adr/TOOL-EXECUTION-STATS.md) are a local-dashboard
 * feature and nothing server-side reads them, while an Azure Table string
 * property is capped at 64 KiB and a day's rollup keeps the union of every tool
 * seen. Drop them from the uploaded JSON so the payload stays bounded by the
 * number of distinct tools times a few counters; the count maps are kept.
 */
export function stripLatencyHistograms<T extends Record<string, unknown>>(usage: T): Omit<T, 'latencyByTool' | 'latencyByServer'> {
	const { latencyByTool: _lt, latencyByServer: _ls, ...rest } = usage as T & { latencyByTool?: unknown; latencyByServer?: unknown };
	return rest;
}
