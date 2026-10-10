import './vscode-shim-register';
import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as vscode from 'vscode';

import { SyncService, applyIdStrategies, canonicalTeamServerUrl, legacyLockCoversTarget, syncTargetLockToken, targetSyncLockName, type SyncServiceDeps } from '../../src/backend/services/syncService';
import { BackendUtility } from '../../src/backend/services/utilityService';
import { getBackendSettings, resolveSyncTargets, type BackendSettings } from '../../src/backend/settings';
import { hashMachineIdForTeam, hashWorkspaceIdForTeam } from '../../src/backend/sharingProfile';
import { inferSharingProfile } from '../../src/backend/settingsValidation';

/**
 * Azure Storage and the self-hosted Team Server are independent upload targets.
 * Azure is gated on `backend.enabled`; the Team Server on its own
 * `backend.sharingServer.enabled` + endpoint URL. A sharing profile of `off` blocks both.
 */

const AZURE_FIELDS = { subscriptionId: 'sub', resourceGroup: 'rg', storageAccount: 'sa', aggTable: 'agg' };
const NO_AZURE_FIELDS = { subscriptionId: '', resourceGroup: '', storageAccount: '', aggTable: 'usageAggDaily' };
const TEAM_SERVER = { sharingServerEnabled: true, sharingServerEndpointUrl: 'https://team.example.com' };
const NO_TEAM_SERVER = { sharingServerEnabled: false, sharingServerEndpointUrl: '' };

function makeSettings(overrides: Partial<BackendSettings>): BackendSettings {
	return {
		enabled: false,
		backend: 'storageTables',
		authMode: 'entraId',
		datasetId: 'default',
		sharingProfile: 'teamAnonymized',
		shareWithTeam: false,
		shareWorkspaceMachineNames: false,
		shareConsentAt: '',
		userIdentityMode: 'pseudonymous',
		userId: '',
		userIdMode: 'alias',
		...NO_AZURE_FIELDS,
		eventsTable: 'usageEvents',
		lookbackDays: 7,
		includeMachineBreakdown: false,
		blobUploadEnabled: false,
		blobContainerName: 'copilot-session-logs',
		blobUploadFrequencyHours: 24,
		blobCompressFiles: true,
		...NO_TEAM_SERVER,
		...overrides,
	};
}

const teamServerOnly = () => makeSettings({ enabled: false, ...TEAM_SERVER });
const azureOnly = () => makeSettings({ enabled: true, ...AZURE_FIELDS });
const both = () => makeSettings({ enabled: true, ...AZURE_FIELDS, ...TEAM_SERVER });

// ── resolveSyncTargets ────────────────────────────────────────────────────

test('resolveSyncTargets: Team Server only does not need backend.enabled', () => {
	assert.deepEqual(resolveSyncTargets(teamServerOnly()), { azure: false, sharingServer: true });
});

test('resolveSyncTargets: Azure only', () => {
	assert.deepEqual(resolveSyncTargets(azureOnly()), { azure: true, sharingServer: false });
});

test('resolveSyncTargets: both targets enabled', () => {
	assert.deepEqual(resolveSyncTargets(both()), { azure: true, sharingServer: true });
});

test('resolveSyncTargets: profile off disables every target', () => {
	assert.deepEqual(resolveSyncTargets({ ...both(), sharingProfile: 'off' }), { azure: false, sharingServer: false });
});

test('resolveSyncTargets: Azure stays gated on backend.enabled even when its fields are filled', () => {
	const settings = makeSettings({ enabled: false, ...AZURE_FIELDS, ...TEAM_SERVER });
	assert.deepEqual(resolveSyncTargets(settings), { azure: false, sharingServer: true });
});

test('resolveSyncTargets: Team Server needs both the toggle and an endpoint URL', () => {
	assert.equal(resolveSyncTargets(makeSettings({ sharingServerEnabled: true, sharingServerEndpointUrl: '' })).sharingServer, false);
	assert.equal(resolveSyncTargets(makeSettings({ sharingServerEnabled: false, sharingServerEndpointUrl: 'https://x' })).sharingServer, false);
});

// ── profile inference ─────────────────────────────────────────────────────

test('inferSharingProfile: an enabled Team Server alone infers teamAnonymized, not off', () => {
	(vscode as any).__mock.reset();
	(vscode as any).__mock.setConfig({
		'aiEngineeringFluency.backend.enabled': false,
		'aiEngineeringFluency.backend.sharingServer.enabled': true,
		'aiEngineeringFluency.backend.sharingServer.endpointUrl': 'https://team.example.com',
	});
	const s = getBackendSettings();
	assert.equal(s.sharingProfile, 'teamAnonymized');
	assert.deepEqual(resolveSyncTargets(s), { azure: false, sharingServer: true });
});

test('inferSharingProfile: neither target enabled still infers off', () => {
	(vscode as any).__mock.reset();
	(vscode as any).__mock.setConfig({
		'aiEngineeringFluency.backend.enabled': false,
		'aiEngineeringFluency.backend.sharingServer.enabled': false,
	});
	assert.equal(getBackendSettings().sharingProfile, 'off');
});

test('inferSharingProfile: an explicit off profile wins over an enabled target', () => {
	assert.equal(inferSharingProfile('off', true, false, 'pseudonymous'), 'off');
});

// ── SyncService gating ────────────────────────────────────────────────────

interface Calls { azure: number; teamServer: number; backfillAzure: number; fluencyScore: number; uploaded: any[] }

function makeService(logs: string[], context?: vscode.ExtensionContext): { svc: SyncService; calls: Calls } {
	const calls: Calls = { azure: 0, teamServer: 0, backfillAzure: 0, fluencyScore: 0, uploaded: [] };
	const deps: SyncServiceDeps = {
		context,
		logger: { log: (m) => logs.push(m), warn: (m) => logs.push(m) },
		sessionHandlers: {
			getCopilotSessionFiles: async () => [],
			estimateTokensFromText: () => 0,
			getModelFromRequest: () => 'gpt-4o',
			statSessionFile: async () => ({ mtimeMs: Date.now(), size: 0 } as any),
		},
		editorHandlers: {},
		getGithubToken: () => 'gh-token',
	};
	const credSvc = {
		getBackendDataPlaneCredentials: async () => { calls.backfillAzure++; return undefined; },
		getBackendSecretsToRedactForError: async () => [],
	};
	const dataSvc = {
		ensureTableExists: async () => { calls.azure++; },
		validateAccess: async () => {},
		createTableClient: () => ({}),
		upsertEntitiesBatch: async () => ({ successCount: 0, errors: [] }),
		deleteEntitiesForUserDataset: async () => ({ deletedCount: 0, errors: [] }),
	};
	const sharingServerSvc = {
		uploadRollups: async (_url: string, _token: string, entries: any[]) => { calls.teamServer++; calls.uploaded.push(...entries); return { success: true, entriesUploaded: entries.length, message: 'ok' }; },
		uploadFluencyScore: async () => { calls.fluencyScore++; return true; },
	};
	const svc = new SyncService(deps, credSvc as any, dataSvc as any, undefined, BackendUtility, sharingServerSvc as any);
	// Azure table sync and session parsing are exercised elsewhere; here we only need to know
	// which targets a sync pass attempts, so give it one rollup to upload.
	(svc as any).performAzureTableSync = async () => { calls.azure++; return 'synced'; };
	(svc as any).computeDailyRollupsFromLocalSessions = async () => ({
		rollups: new Map([['k', {
			key: { day: '2026-01-01', model: 'gpt-4o', workspaceId: 'ws', machineId: 'm', editor: 'VS Code' },
			value: { inputTokens: 10, outputTokens: 20, interactions: 1 },
		}]]),
		workspaceNamesById: { ws: 'my-repo' },
		machineNamesById: { m: 'my-laptop' },
	});
	return { svc, calls };
}

test('syncToBackendStore: Team Server only uploads rollups without backend.enabled', async () => {
	const logs: string[] = [];
	const { svc, calls } = makeService(logs);
	await svc.syncToBackendStore(true, teamServerOnly(), true);
	assert.equal(calls.teamServer, 1, `expected a Team Server upload. Logs:\n${logs.join('\n')}`);
	assert.equal(calls.azure, 0, 'Azure must not be attempted when backend.enabled is false');
});

test('syncToBackendStore: Azure only never contacts the Team Server', async () => {
	const logs: string[] = [];
	const { svc, calls } = makeService(logs);
	await svc.syncToBackendStore(true, azureOnly(), true);
	assert.equal(calls.azure, 1);
	assert.equal(calls.teamServer, 0);
});

test('syncToBackendStore: both targets sync independently', async () => {
	const logs: string[] = [];
	const { svc, calls } = makeService(logs);
	await svc.syncToBackendStore(true, both(), true);
	assert.equal(calls.azure, 1);
	assert.equal(calls.teamServer, 1);
});

test('syncToBackendStore: profile off uploads nowhere', async () => {
	const logs: string[] = [];
	const { svc, calls } = makeService(logs);
	await svc.syncToBackendStore(true, { ...both(), sharingProfile: 'off' }, true);
	assert.equal(calls.azure, 0);
	assert.equal(calls.teamServer, 0);
	assert.ok(logs.some(m => m.includes('does not allow cloud sync')));
});

test('syncToBackendStore: Azure fields without backend.enabled and no Team Server uploads nowhere', async () => {
	const logs: string[] = [];
	const { svc, calls } = makeService(logs);
	await svc.syncToBackendStore(true, makeSettings({ enabled: false, ...AZURE_FIELDS }), true);
	assert.equal(calls.azure, 0);
	assert.equal(calls.teamServer, 0);
	assert.ok(logs.some(m => m.includes('no sync target enabled')));
});

test('startTimerIfEnabled: Team Server only starts the timer', () => {
	const logs: string[] = [];
	const { svc } = makeService(logs);
	svc.startTimerIfEnabled(teamServerOnly(), true);
	assert.ok(logs.some(m => m.includes('starting timer with interval')), `Logs:\n${logs.join('\n')}`);
	svc.dispose();
});

test('startTimerIfEnabled: profile off does not start the timer', () => {
	const logs: string[] = [];
	const { svc } = makeService(logs);
	svc.startTimerIfEnabled({ ...teamServerOnly(), sharingProfile: 'off' }, true);
	assert.ok(!logs.some(m => m.includes('starting timer with interval')));
	assert.ok(logs.some(m => m.includes('cloud sync disabled')));
	svc.dispose();
});

test('startTimerIfEnabled: no enabled target does not start the timer', () => {
	const logs: string[] = [];
	const { svc } = makeService(logs);
	svc.startTimerIfEnabled(makeSettings({ enabled: false, ...AZURE_FIELDS }), true);
	assert.ok(!logs.some(m => m.includes('starting timer with interval')));
	assert.ok(logs.some(m => m.includes('no sync target enabled')));
	svc.dispose();
});

test('backfillSync: stays Azure-only, so a Team Server-only setup skips it', async () => {
	const logs: string[] = [];
	const { svc, calls } = makeService(logs);
	await svc.backfillSync(teamServerOnly(), 30);
	assert.equal(calls.backfillAzure, 0, 'backfill must not request Azure credentials');
	assert.ok(logs.some(m => m.startsWith('Backfill: skipping')));
});

test('backfillSync: Azure only proceeds to fetch Azure credentials', async () => {
	const logs: string[] = [];
	const { svc, calls } = makeService(logs);
	await svc.backfillSync(azureOnly(), 30);
	assert.equal(calls.backfillAzure, 1);
});

test('backfillSync: ignores the legacy backend.backend selector when Azure is enabled', async () => {
	const logs: string[] = [];
	const { svc, calls } = makeService(logs);
	await svc.backfillSync({ ...azureOnly(), backend: 'sharingServer' }, 30);
	assert.equal(calls.backfillAzure, 1);
});

// ── fluency-score upload ──────────────────────────────────────────────────

test('uploadFluencyScoreToSharingServer: Team Server only uploads', async () => {
	const { svc, calls } = makeService([]);
	await svc.uploadFluencyScoreToSharingServer(teamServerOnly(), { overallStage: 'exploring' });
	assert.equal(calls.fluencyScore, 1);
});

test('uploadFluencyScoreToSharingServer: profile off blocks the score upload like rollup sync', async () => {
	const { svc, calls } = makeService([]);
	await svc.uploadFluencyScoreToSharingServer({ ...teamServerOnly(), sharingProfile: 'off' }, { overallStage: 'exploring' });
	assert.equal(calls.fluencyScore, 0);
});

// ── cross-window locking is keyed by target, not by backend.backend ──────

function withLockDir(fn: (context: vscode.ExtensionContext, dir: string) => Promise<void>): Promise<void> {
	const dir = fs.mkdtempSync(path.join(process.cwd(), 'sync-targets-lock-'));
	const state = new Map<string, unknown>();
	const context = {
		globalStorageUri: { fsPath: dir },
		globalState: { get: (k: string) => state.get(k), update: async (k: string, v: unknown) => { state.set(k, v); } },
	} as unknown as vscode.ExtensionContext;
	return fn(context, dir).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

/** Simulates another window holding the lock for a Team Server endpoint. */
function holdTeamServerLock(dir: string, endpointUrl: string): void {
	const serverUrl = syncTargetLockToken('sharingserver', endpointUrl);
	const file = `backend_sync_${targetSyncLockName('sharingserver', serverUrl)}.lock`;
	fs.writeFileSync(path.join(dir, file), JSON.stringify({ sessionId: 'other-window', timestamp: Date.now(), serverUrl }));
}

for (const backend of ['storageTables', 'sharingServer'] as const) {
	test(`sync lock: another window uploading to the same Team Server blocks it (backend.backend=${backend})`, async () => {
		await withLockDir(async (context, dir) => {
			holdTeamServerLock(dir, TEAM_SERVER.sharingServerEndpointUrl);
			const logs: string[] = [];
			const { svc, calls } = makeService(logs, context);
			await svc.syncToBackendStore(true, { ...teamServerOnly(), backend }, true);
			assert.equal(calls.teamServer, 0, `Logs:\n${logs.join('\n')}`);
			assert.ok(logs.some(m => m.includes('skipping Team Server')));
		});
	});
}

test('sync lock: a held Team Server lock does not block this window\'s Azure sync', async () => {
	await withLockDir(async (context, dir) => {
		holdTeamServerLock(dir, TEAM_SERVER.sharingServerEndpointUrl);
		const { svc, calls } = makeService([], context);
		await svc.syncToBackendStore(true, both(), true);
		assert.equal(calls.azure, 1);
		assert.equal(calls.teamServer, 0);
	});
});

test('sync lock: a lock held for a different Team Server does not block', async () => {
	await withLockDir(async (context, dir) => {
		holdTeamServerLock(dir, 'https://other-team.example.com');
		const { svc, calls } = makeService([], context);
		await svc.syncToBackendStore(true, teamServerOnly(), true);
		assert.equal(calls.teamServer, 1);
	});
});

test('sync lock: each endpoint gets its own lock file, so another endpoint\'s lock cannot weaken it', async () => {
	await withLockDir(async (context, dir) => {
		// Window A holds server A. Window B takes server B's lock and keeps it while uploading...
		holdTeamServerLock(dir, 'https://other-team.example.com');
		let releaseB!: () => void;
		const bUploading = new Promise<void>(r => { releaseB = r; });
		const b = makeService([], context);
		let bStarted!: () => void;
		const bHasLock = new Promise<void>(r => { bStarted = r; });
		(b.svc as any).runSharingServerSyncIndependently = async () => { b.calls.teamServer++; bStarted(); await bUploading; };
		const bSync = b.svc.syncToBackendStore(true, teamServerOnly(), true);
		await bHasLock;
		// ...so window C, targeting the same server B, must be blocked rather than run concurrently.
		const logs: string[] = [];
		const c = makeService(logs, context);
		await c.svc.syncToBackendStore(true, teamServerOnly(), true);
		assert.equal(c.calls.teamServer, 0, `Logs:\n${logs.join('\n')}`);
		assert.ok(logs.some(m => m.includes('skipping Team Server')));
		releaseB();
		await bSync;
		assert.equal(b.calls.teamServer, 1);
	});
});

test('sync lock: Team Server URLs differing only by trailing slash or host case share one lock', async () => {
	assert.equal(canonicalTeamServerUrl('https://Team.Example.com/'), 'https://team.example.com');
	assert.equal(canonicalTeamServerUrl('https://team.example.com/base//'), 'https://team.example.com/base');
	await withLockDir(async (context, dir) => {
		holdTeamServerLock(dir, 'https://team.example.com');
		const logs: string[] = [];
		const { svc, calls } = makeService(logs, context);
		await svc.syncToBackendStore(true, { ...teamServerOnly(), sharingServerEndpointUrl: 'https://TEAM.example.com/' }, true);
		assert.equal(calls.teamServer, 0, `Logs:\n${logs.join('\n')}`);
	});
});

// ── legacy lock files from extension versions before per-endpoint locks ─

function holdLegacyLock(dir: string, file: string, serverUrl: string | undefined, timestamp = Date.now()): void {
	fs.writeFileSync(path.join(dir, file), JSON.stringify({ sessionId: 'old-version-window', timestamp, serverUrl }));
}

for (const file of ['backend_sync.lock', 'backend_sync_sharingserver.lock']) {
	test(`legacy lock: a live ${file} covering this Team Server blocks it during an upgrade`, async () => {
		await withLockDir(async (context, dir) => {
			holdLegacyLock(dir, file, `azure:sa|share:${TEAM_SERVER.sharingServerEndpointUrl}/`);
			const logs: string[] = [];
			const { svc, calls } = makeService(logs, context);
			await svc.syncToBackendStore(true, both(), true);
			assert.equal(calls.teamServer, 0, `Logs:\n${logs.join('\n')}`);
			assert.equal(calls.azure, 0, 'the legacy composite lock also covers azure:sa');
		});
	});
}

test('legacy lock: one covering a different endpoint, or stale, does not block', async () => {
	await withLockDir(async (context, dir) => {
		holdLegacyLock(dir, 'backend_sync_sharingserver.lock', 'share:https://other-team.example.com');
		holdLegacyLock(dir, 'backend_sync.lock', `share:${TEAM_SERVER.sharingServerEndpointUrl}`, Date.now() - 60 * 60 * 1000);
		const { svc, calls } = makeService([], context);
		await svc.syncToBackendStore(true, teamServerOnly(), true);
		assert.equal(calls.teamServer, 1);
	});
});

test('legacyLockCoversTarget: matches composite entries canonically; unknown formats cover conservatively', () => {
	const share = syncTargetLockToken('sharingserver', 'https://team.example.com');
	assert.equal(legacyLockCoversTarget('azure:sa|share:https://team.example.com/', share), true);
	assert.equal(legacyLockCoversTarget('azure:sa', share), false);
	assert.equal(legacyLockCoversTarget('azure:SA', syncTargetLockToken('azure', 'sa')), true);
	assert.equal(legacyLockCoversTarget(undefined, share), true);
	assert.equal(legacyLockCoversTarget('https://mystorage.table.core.windows.net', share), true);
});

// ── Team Server payloads honour the profile's ID strategy ────────────────

for (const profile of ['teamAnonymized', 'teamPseudonymous', 'teamIdentified'] as const) {
	test(`Team Server upload: ${profile} sends hashed workspace/machine IDs and no names`, async () => {
		const { svc, calls } = makeService([]);
		await svc.syncToBackendStore(true, { ...teamServerOnly(), sharingProfile: profile, datasetId: 'ds1' }, true);
		assert.equal(calls.uploaded.length, 1);
		const [entry] = calls.uploaded;
		assert.equal(entry.workspaceId, hashWorkspaceIdForTeam({ datasetId: 'ds1', workspaceId: 'ws' }));
		assert.equal(entry.machineId, hashMachineIdForTeam({ datasetId: 'ds1', machineId: 'm' }));
		assert.notEqual(entry.workspaceId, 'ws');
		assert.notEqual(entry.machineId, 'm');
		assert.equal(entry.workspaceName, undefined);
		assert.equal(entry.machineName, undefined);
	});
}

test('Team Server upload: the inferred default profile (Team Server-only, nothing set) hashes IDs', async () => {
	(vscode as any).__mock.reset();
	(vscode as any).__mock.setConfig({
		'aiEngineeringFluency.backend.sharingServer.enabled': true,
		'aiEngineeringFluency.backend.sharingServer.endpointUrl': 'https://team.example.com',
	});
	const settings = getBackendSettings();
	const { svc, calls } = makeService([]);
	await svc.syncToBackendStore(true, settings, true);
	assert.equal(calls.uploaded.length, 1);
	assert.equal(calls.uploaded[0].workspaceId, hashWorkspaceIdForTeam({ datasetId: settings.datasetId, workspaceId: 'ws' }));
	assert.equal(calls.uploaded[0].machineId, hashMachineIdForTeam({ datasetId: settings.datasetId, machineId: 'm' }));
});

test('Team Server upload: soloFull keeps raw IDs and names (personal full fidelity)', async () => {
	const { svc, calls } = makeService([]);
	await svc.syncToBackendStore(true, { ...teamServerOnly(), sharingProfile: 'soloFull' }, true);
	const [entry] = calls.uploaded;
	assert.equal(entry.workspaceId, 'ws');
	assert.equal(entry.machineId, 'm');
	assert.equal(entry.workspaceName, 'my-repo');
	assert.equal(entry.machineName, 'my-laptop');
});

test('applyIdStrategies: hashes per dataset only when the policy says so', () => {
	const key = { workspaceId: 'ws', machineId: 'm' };
	assert.deepEqual(applyIdStrategies(key, 'ds', { workspaceIdStrategy: 'raw', machineIdStrategy: 'raw' }), key);
	const hashed = applyIdStrategies(key, 'ds', { workspaceIdStrategy: 'hashed', machineIdStrategy: 'hashed' });
	assert.equal(hashed.workspaceId, hashWorkspaceIdForTeam({ datasetId: 'ds', workspaceId: 'ws' }));
	assert.equal(hashed.machineId, hashMachineIdForTeam({ datasetId: 'ds', machineId: 'm' }));
});

// ── per-target results reported to Sync Now ──────────────────────────────

test('syncToBackendStore reports each attempted target\'s outcome', async () => {
	const { svc } = makeService([]);
	assert.deepEqual(await svc.syncToBackendStore(true, both(), true), { azure: 'synced', sharingServer: 'synced' });
	assert.deepEqual(await svc.syncToBackendStore(true, teamServerOnly(), true), { sharingServer: 'synced' });
	assert.deepEqual(await svc.syncToBackendStore(true, { ...both(), sharingProfile: 'off' }, true), {});
});

test('syncToBackendStore reports a failed Team Server upload as failed, not synced', async () => {
	const { svc } = makeService([]);
	(svc as any).sharingServerUploadService.uploadRollups = async () => { throw new Error('HTTP 500'); };
	assert.deepEqual(await svc.syncToBackendStore(true, both(), true), { azure: 'synced', sharingServer: 'failed' });
});

test('syncToBackendStore reports a Team Server with no GitHub token as skipped', async () => {
	const { svc } = makeService([]);
	(svc as any).deps.getGithubToken = () => undefined;
	assert.deepEqual(await svc.syncToBackendStore(true, teamServerOnly(), true), { sharingServer: 'skipped' });
});

test('syncToBackendStore reports a lock held by another window as skipped', async () => {
	await withLockDir(async (context, dir) => {
		holdTeamServerLock(dir, TEAM_SERVER.sharingServerEndpointUrl);
		const { svc } = makeService([], context);
		assert.deepEqual(await svc.syncToBackendStore(true, teamServerOnly(), true), { sharingServer: 'skipped' });
	});
});

// ── failures reported without a throw must not count as synced ───────────

test('syncToBackendStore: a Team Server HTTP failure (reported, not thrown) is failed', async () => {
	const { svc } = makeService([]);
	(svc as any).sharingServerUploadService.uploadRollups = async () => ({ success: false, entriesUploaded: 0, message: 'HTTP 502: bad gateway' });
	assert.deepEqual(await svc.syncToBackendStore(true, teamServerOnly(), true), { sharingServer: 'failed' });
});

test('syncToBackendStore: entries the Team Server rejected make the target failed', async () => {
	const { svc } = makeService([]);
	(svc as any).sharingServerUploadService.uploadRollups = async () => ({ success: true, entriesUploaded: 0, message: 'Uploaded 0 entries' });
	assert.deepEqual(await svc.syncToBackendStore(true, teamServerOnly(), true), { sharingServer: 'failed' });
});

test('syncToBackendStore: missing Azure credentials are reported as failed', async () => {
	const { svc } = makeService([]);
	delete (svc as any).performAzureTableSync; // use the real Azure path; the credential stub returns undefined
	assert.deepEqual(await svc.syncToBackendStore(true, azureOnly(), true), { azure: 'failed' });
});

test('syncToBackendStore: partial Azure upsert errors are reported as failed', async () => {
	const { svc } = makeService([]);
	delete (svc as any).performAzureTableSync;
	(svc as any).credentialService.getBackendDataPlaneCredentials = async () => ({ tableCredential: {} });
	(svc as any).dataPlaneService.upsertEntitiesBatch = async () => ({ successCount: 0, errors: [{ error: 'boom' }] });
	assert.deepEqual(await svc.syncToBackendStore(true, azureOnly(), true), { azure: 'failed' });
});

test('uploadFluencyScoreToSharingServer: a failed score POST does not mark a Team Server sync', async () => {
	const state = new Map<string, unknown>();
	const context = { globalState: { get: (k: string) => state.get(k), update: async (k: string, v: unknown) => { state.set(k, v); } } } as unknown as vscode.ExtensionContext;
	const { svc } = makeService([], context);
	(svc as any).sharingServerUploadService.uploadFluencyScore = async () => false;
	await svc.uploadFluencyScoreToSharingServer(teamServerOnly(), { overallStage: 'exploring' });
	assert.equal(state.get('backend.sharingServerRollupLastSyncAt'), undefined);
});
