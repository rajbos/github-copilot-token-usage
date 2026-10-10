import './vscode-shim-register';
import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import * as vscode from 'vscode';

// We can test timer management and the syncQueue serialization.
// Most sync methods require heavy I/O mocking.
import { SyncService, parseConsentTimestamp, type SyncServiceDeps } from '../../src/backend/services/syncService';
import { CredentialService } from '../../src/backend/services/credentialService';
import { DataPlaneService } from '../../src/backend/services/dataPlaneService';
import { BackendUtility } from '../../src/backend/services/utilityService';

/** Flat override shape that mirrors the original SyncServiceDeps properties for convenient test setup. */
interface FlatDepsOverrides {
	context?: vscode.ExtensionContext | undefined;
	log?: (message: string) => void;
	warn?: (message: string) => void;
	getCopilotSessionFiles?: () => Promise<string[]>;
	estimateTokensFromText?: (text: string, model: string) => number;
	getModelFromRequest?: (request: any) => string;
	getSessionFileDataCached?: (sessionFilePath: string, mtime: number, fileSize: number) => Promise<any>;
	updateTokenStats?: () => Promise<void>;
	statSessionFile?: (sessionFile: string) => Promise<any>;
	isOpenCodeSession?: (sessionFile: string) => boolean;
	getOpenCodeSessionData?: (sessionFile: string) => Promise<any>;
	isCrushSession?: (sessionFile: string) => boolean;
	getCrushSessionData?: (sessionFile: string) => Promise<any>;
	isVSSessionFile?: (sessionFile: string) => boolean;
	getGithubToken?: () => string | undefined;
	getEditorLabel?: (sessionFile: string) => string;
}

function makeDeps(overrides?: FlatDepsOverrides): SyncServiceDeps {
	return {
		context: overrides?.context ?? undefined,
		logger: {
			log: overrides?.log ?? (() => {}),
			warn: overrides?.warn ?? (() => {}),
		},
		sessionHandlers: {
			getCopilotSessionFiles: overrides?.getCopilotSessionFiles ?? (async () => []),
			estimateTokensFromText: overrides?.estimateTokensFromText ?? (() => 0),
			getModelFromRequest: overrides?.getModelFromRequest ?? (() => 'gpt-4o'),
			getSessionFileDataCached: overrides?.getSessionFileDataCached,
			statSessionFile: overrides?.statSessionFile ?? (async () => ({ mtimeMs: Date.now(), size: 100 } as any)),
		},
		editorHandlers: {
			isOpenCodeSession: overrides?.isOpenCodeSession,
			getOpenCodeSessionData: overrides?.getOpenCodeSessionData,
			isCrushSession: overrides?.isCrushSession,
			getCrushSessionData: overrides?.getCrushSessionData,
			isVSSessionFile: overrides?.isVSSessionFile,
		},
		updateTokenStats: overrides?.updateTokenStats,
		getGithubToken: overrides?.getGithubToken,
		getEditorLabel: overrides?.getEditorLabel,
	};
}

function makeService(depsOverrides?: FlatDepsOverrides): SyncService {
	const deps = makeDeps(depsOverrides);
	const credSvc = new CredentialService(undefined as any);
	const dataSvc = new DataPlaneService(BackendUtility, () => {}, async () => []);
	return new SyncService(deps, credSvc, dataSvc, undefined, BackendUtility, undefined);
}

/**
 * Create a SyncService with custom credential/data-plane/blob services for integration-level tests.
 */
function makeServiceWithServices(
	depsOverrides?: FlatDepsOverrides,
	credSvcOverride?: any,
	dataSvcOverride?: any,
	blobSvcOverride?: any
): SyncService {
	const deps = makeDeps(depsOverrides);
	const credSvc = credSvcOverride ?? new CredentialService(undefined as any);
	const dataSvc = dataSvcOverride ?? new DataPlaneService(BackendUtility, () => {}, async () => []);
	return new SyncService(deps, credSvc, dataSvc, blobSvcOverride ?? undefined, BackendUtility, undefined);
}

/**
 * Helper to create a temp file with given content.
 * Returns { filePath, cleanup }.
 */
function createTempFile(content: string, ext = '.json'): { filePath: string; cleanup: () => void } {
	const dir = fs.mkdtempSync(path.join(process.cwd(), 'sync-test-'));
	// Mimics a workspaceStorage path so extractWorkspaceIdFromSessionPath returns a proper ID
	const wsDir = path.join(dir, 'workspaceStorage', 'test-ws-id', 'chatSessions');
	fs.mkdirSync(wsDir, { recursive: true });
	const filePath = path.join(wsDir, `session${ext}`);
	fs.writeFileSync(filePath, content, 'utf8');
	return {
		filePath,
		cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
	};
}

// ── startTimerIfEnabled / stopTimer ──────────────────────────────────────

test('startTimerIfEnabled does not start timer when cloud sync is disabled', () => {
	const svc = makeService();
	svc.startTimerIfEnabled(
		{ enabled: true, sharingProfile: 'off', shareWorkspaceMachineNames: false } as any,
		true
	);
	// No error thrown, timer should not be running. dispose cleans up either way.
	svc.dispose();
});

test('startTimerIfEnabled does not start timer when not configured', () => {
	const svc = makeService();
	svc.startTimerIfEnabled(
		{ enabled: true, sharingProfile: 'soloFull', shareWorkspaceMachineNames: false } as any,
		false // not configured
	);
	svc.dispose();
});

test('startTimerIfEnabled starts timer when configured and cloud sync is allowed', () => {
	const svc = makeService();
	svc.startTimerIfEnabled(
		{ enabled: true, sharingProfile: 'soloFull', shareWorkspaceMachineNames: false } as any,
		true
	);
	// Timer was started; stopping should not error
	svc.stopTimer();
	svc.dispose();
});

test('startTimerIfEnabled logs the cloud-sync-disabled reason when the profile forbids cloud sync', () => {
	const logs: string[] = [];
	const svc = makeService({ log: (m) => logs.push(m) });
	svc.startTimerIfEnabled(
		{ enabled: true, sharingProfile: 'off', shareWorkspaceMachineNames: false } as any,
		true
	);
	assert.ok(logs.some(m => m.includes('cloud sync disabled') && m.includes('off')));
	svc.dispose();
});

test('startTimerIfEnabled logs the not-configured reason when cloud sync is allowed but backend is unconfigured', () => {
	const logs: string[] = [];
	const svc = makeService({ log: (m) => logs.push(m) });
	svc.startTimerIfEnabled(
		{ enabled: true, sharingProfile: 'soloFull', shareWorkspaceMachineNames: false } as any,
		false
	);
	assert.ok(logs.some(m => m.includes('backend not configured')));
	assert.ok(!logs.some(m => m.includes('cloud sync disabled')));
	svc.dispose();
});

test('stopTimer is idempotent', () => {
	const svc = makeService();
	svc.stopTimer();
	svc.stopTimer(); // no error
	svc.dispose();
});

test('dispose stops timer', () => {
	const svc = makeService();
	svc.startTimerIfEnabled(
		{ enabled: true, sharingProfile: 'soloFull', shareWorkspaceMachineNames: false } as any,
		true
	);
	svc.dispose();
	// Should not throw on double dispose
	svc.dispose();
});

// ── syncToBackendStore ───────────────────────────────────────────────────

test('syncToBackendStore skips when not configured', async () => {
	const logs: string[] = [];
	const svc = makeService({ log: (m) => logs.push(m) });
	await svc.syncToBackendStore(false, { enabled: false } as any, false);
	// Should log that sync was skipped
	assert.ok(logs.some(m => m.toLowerCase().includes('skip') || m.toLowerCase().includes('disabled') || m.toLowerCase().includes('not configured')));
});

test('syncToBackendStore skips when cloud sync policy disallows', async () => {
	const logs: string[] = [];
	const svc = makeService({ log: (m) => logs.push(m) });
	await svc.syncToBackendStore(false, {
		enabled: true,
		sharingProfile: 'off',
		shareWorkspaceMachineNames: false
	} as any, true);
	assert.ok(logs.some(m => m.toLowerCase().includes('cloud sync disabled') || m.toLowerCase().includes('skip')));
});

// ── extractFluencyMetricsFromCache (private) ─────────────────────────────

test('extractFluencyMetricsFromCache returns undefined when usageAnalysis is missing', () => {
	const svc = makeService();
	const result = (svc as any).extractFluencyMetricsFromCache({}, 1);
	assert.equal(result, undefined);
});

test('extractFluencyMetricsFromCache returns undefined for empty usageAnalysis', () => {
	const svc = makeService();
	const result = (svc as any).extractFluencyMetricsFromCache({ usageAnalysis: {} }, 1);
	// sessionCount is always added, so result should have at least that
	assert.ok(result);
	assert.equal(result.sessionCount, 1);
});

test('extractFluencyMetricsFromCache extracts mode usage with ratio=1', () => {
	const svc = makeService();
	const cached = {
		usageAnalysis: {
			modeUsage: { ask: 10, edit: 5, agent: 3, plan: 2, customAgent: 1, cli: 0 }
		}
	};
	const result = (svc as any).extractFluencyMetricsFromCache(cached, 1);
	assert.equal(result.askModeCount, 10);
	assert.equal(result.editModeCount, 5);
	assert.equal(result.agentModeCount, 3);
	assert.equal(result.planModeCount, 2);
	assert.equal(result.customAgentModeCount, 1);
	assert.equal(result.sessionCount, 1);
});

test('extractFluencyMetricsFromCache applies ratio to mode usage', () => {
	const svc = makeService();
	const cached = {
		usageAnalysis: {
			modeUsage: { ask: 10, edit: 4 }
		}
	};
	const result = (svc as any).extractFluencyMetricsFromCache(cached, 0.5);
	assert.equal(result.askModeCount, 5);
	assert.equal(result.editModeCount, 2);
});

test('extractFluencyMetricsFromCache serializes toolCalls as JSON', () => {
	const svc = makeService();
	const toolCalls = { search: 5, edit: 3 };
	const cached = { usageAnalysis: { toolCalls } };
	const result = (svc as any).extractFluencyMetricsFromCache(cached, 1);
	assert.equal(result.toolCallsJson, JSON.stringify(toolCalls));
});

test('extractFluencyMetricsFromCache serializes contextReferences as JSON', () => {
	const svc = makeService();
	const contextReferences = { file: 2, symbol: 1 };
	const cached = { usageAnalysis: { contextReferences } };
	const result = (svc as any).extractFluencyMetricsFromCache(cached, 1);
	assert.equal(result.contextRefsJson, JSON.stringify(contextReferences));
});

test('extractFluencyMetricsFromCache serializes mcpTools as JSON', () => {
	const svc = makeService();
	const mcpTools = { tool1: 3 };
	const cached = { usageAnalysis: { mcpTools } };
	const result = (svc as any).extractFluencyMetricsFromCache(cached, 1);
	assert.equal(result.mcpToolsJson, JSON.stringify(mcpTools));
});

test('extractFluencyMetricsFromCache serializes modelSwitching as JSON', () => {
	const svc = makeService();
	const modelSwitching = { switches: 2 };
	const cached = { usageAnalysis: { modelSwitching } };
	const result = (svc as any).extractFluencyMetricsFromCache(cached, 1);
	assert.equal(result.modelSwitchingJson, JSON.stringify(modelSwitching));
});

test('extractFluencyMetricsFromCache extracts editScope with direct fields', () => {
	const svc = makeService();
	const editScope = { multiFileEdits: 4, avgFilesPerSession: 2.5 };
	const cached = { usageAnalysis: { editScope } };
	const result = (svc as any).extractFluencyMetricsFromCache(cached, 1);
	assert.equal(result.editScopeJson, JSON.stringify(editScope));
	assert.equal(result.multiFileEdits, 4);
	assert.equal(result.avgFilesPerEdit, 2.5);
});

test('extractFluencyMetricsFromCache extracts agentTypes', () => {
	const svc = makeService();
	const agentTypes = { coding: 3, testing: 1 };
	const cached = { usageAnalysis: { agentTypes } };
	const result = (svc as any).extractFluencyMetricsFromCache(cached, 1);
	assert.equal(result.agentTypesJson, JSON.stringify(agentTypes));
});

test('extractFluencyMetricsFromCache extracts repositories and customization rate', () => {
	const svc = makeService();
	const cached = {
		usageAnalysis: {
			repositories: ['repo-a', 'repo-b', 'repo-c'],
			repositoriesWithCustomization: ['repo-a']
		}
	};
	const result = (svc as any).extractFluencyMetricsFromCache(cached, 1);
	const parsed = JSON.parse(result.repositoriesJson);
	assert.deepEqual(parsed.repositories, ['repo-a', 'repo-b', 'repo-c']);
	assert.deepEqual(parsed.repositoriesWithCustomization, ['repo-a']);
	assert.ok(Math.abs(result.repoCustomizationRate - 1/3) < 0.01);
});

test('extractFluencyMetricsFromCache extracts applyUsage', () => {
	const svc = makeService();
	const applyUsage = { applyRate: 0.75, applies: 3, codeBlocks: 4 };
	const cached = { usageAnalysis: { applyUsage } };
	const result = (svc as any).extractFluencyMetricsFromCache(cached, 1);
	assert.equal(result.applyUsageJson, JSON.stringify(applyUsage));
	assert.equal(result.codeBlockApplyRate, 0.75);
});

test('extractFluencyMetricsFromCache extracts sessionDuration', () => {
	const svc = makeService();
	const sessionDuration = { totalMinutes: 45, avgMinutes: 15 };
	const cached = { usageAnalysis: { sessionDuration } };
	const result = (svc as any).extractFluencyMetricsFromCache(cached, 1);
	assert.equal(result.sessionDurationJson, JSON.stringify(sessionDuration));
});

test('extractFluencyMetricsFromCache extracts conversationPatterns', () => {
	const svc = makeService();
	const cached = {
		usageAnalysis: {
			conversationPatterns: { multiTurnSessions: 3, avgTurnsPerSession: 5.5 }
		}
	};
	const result = (svc as any).extractFluencyMetricsFromCache(cached, 1);
	assert.equal(result.multiTurnSessions, 3);
	assert.equal(result.avgTurnsPerSession, 5.5);
});

test('extractFluencyMetricsFromCache handles all metrics combined', () => {
	const svc = makeService();
	const cached = {
		usageAnalysis: {
			modeUsage: { ask: 1, edit: 2, agent: 3, plan: 0, customAgent: 0, cli: 0 },
			toolCalls: { search: 1 },
			contextReferences: { file: 1 },
			mcpTools: { t: 1 },
			modelSwitching: { s: 1 },
			editScope: { multiFileEdits: 1, avgFilesPerSession: 1 },
			agentTypes: { coding: 1 },
			repositories: ['r1'],
			repositoriesWithCustomization: ['r1'],
			applyUsage: { applyRate: 1, applies: 1, codeBlocks: 1 },
			sessionDuration: { totalMinutes: 10 },
			conversationPatterns: { multiTurnSessions: 1, avgTurnsPerSession: 3 }
		}
	};
	const result = (svc as any).extractFluencyMetricsFromCache(cached, 1);
	// Verify all keys are present
	assert.ok(result.askModeCount !== undefined);
	assert.ok(result.toolCallsJson);
	assert.ok(result.contextRefsJson);
	assert.ok(result.mcpToolsJson);
	assert.ok(result.modelSwitchingJson);
	assert.ok(result.editScopeJson);
	assert.ok(result.agentTypesJson);
	assert.ok(result.repositoriesJson);
	assert.ok(result.applyUsageJson);
	assert.ok(result.sessionDurationJson);
	assert.equal(result.multiTurnSessions, 1);
	assert.equal(result.sessionCount, 1);
	assert.equal(result.repoCustomizationRate, 1);
});

test('extractFluencyMetricsFromCache defaults ratio to 1', () => {
	const svc = makeService();
	const cached = {
		usageAnalysis: {
			modeUsage: { ask: 7 }
		}
	};
	const result = (svc as any).extractFluencyMetricsFromCache(cached);
	assert.equal(result.askModeCount, 7);
});

// ── logCachePerformance (private) ────────────────────────────────────────

test('logCachePerformance logs hit rate', () => {
	const logs: string[] = [];
	const svc = makeService({ log: (m) => logs.push(m) });
	(svc as any).logCachePerformance(8, 2);
	assert.ok(logs.some(m => m.includes('80.0%')));
	assert.ok(logs.some(m => m.includes('Hits: 8')));
});

test('logCachePerformance does nothing when totalFiles is 0', () => {
	const logs: string[] = [];
	const svc = makeService({ log: (m) => logs.push(m) });
	(svc as any).logCachePerformance(0, 0);
	assert.equal(logs.length, 0);
});

// ── ensureWorkspaceNameResolved (private) ────────────────────────────────

test('ensureWorkspaceNameResolved skips if already resolved', async () => {
	const svc = makeService();
	const names: Record<string, string> = { 'ws1': 'MyWorkspace' };
	await (svc as any).ensureWorkspaceNameResolved('ws1', '/some/path', names);
	assert.equal(names['ws1'], 'MyWorkspace');
});

test('ensureWorkspaceNameResolved resolves from path if not in map', async () => {
	// BackendUtility.tryResolveWorkspaceNameFromSessionPath reads workspace.json
	// which won't exist for our test path, so name stays unresolved
	const svc = makeService();
	const names: Record<string, string> = {};
	await (svc as any).ensureWorkspaceNameResolved('ws2', '/nonexistent/path', names);
	// Not resolved since file doesn't exist, but no error thrown
	assert.equal(names['ws2'], undefined);
});

// ── processCachedSessionFile (private, JSON format) ──────────────────────

test('processCachedSessionFile returns false for invalid cached data', async () => {
	const svc = makeService({
		getSessionFileDataCached: async () => null as any,
	});
	const rollups = new Map();
	const result = await (svc as any).processCachedSessionFile(
		'/fake/session.json', Date.now(), 100, 'ws', 'machine', undefined, rollups, 0, new Date()
	);
	assert.equal(result, false);
});

test('processCachedSessionFile returns false for null modelUsage', async () => {
	const svc = makeService({
		getSessionFileDataCached: async () => ({ tokens: 0, mtime: 0, interactions: 1, modelUsage: null }) as any,
	});
	const rollups = new Map();
	const result = await (svc as any).processCachedSessionFile(
		'/fake/session.json', Date.now(), 100, 'ws', 'machine', undefined, rollups, 0, new Date()
	);
	assert.equal(result, false);
});

test('processCachedSessionFile returns false for negative interactions', async () => {
	const svc = makeService({
		getSessionFileDataCached: async () => ({ tokens: 0, mtime: 0, interactions: -1, modelUsage: {} }),
	});
	const rollups = new Map();
	const result = await (svc as any).processCachedSessionFile(
		'/fake/session.json', Date.now(), 100, 'ws', 'machine', undefined, rollups, 0, new Date()
	);
	assert.equal(result, false);
});

test('processCachedSessionFile processes JSON session with cached data', async () => {
	const now = new Date();
	const timestamp = now.getTime() - 60000; // 1 minute ago
	const sessionContent = JSON.stringify({
		requests: [{
			timestamp,
			message: { parts: [{ text: 'hello' }] },
			response: [{ value: 'world' }]
		}]
	});
	const tmpFile = createTempFile(sessionContent);
	try {
		const svc = makeService({
			getSessionFileDataCached: async () => ({
				tokens: 300, mtime: Date.now(),
				interactions: 1,
				modelUsage: { 'gpt-4o': { inputTokens: 100, outputTokens: 200 } }
			}),
			getModelFromRequest: () => 'gpt-4o',
		});
		const rollups = new Map();
		const result = await (svc as any).processCachedSessionFile(
			tmpFile.filePath, Date.now(), 100, 'ws', 'machine', undefined, rollups,
			timestamp - 1000, // startMs before the event
			now
		);
		assert.equal(result, true);
		assert.ok(rollups.size > 0);
	} finally {
		tmpFile.cleanup();
	}
});

test('processCachedSessionFile processes JSONL session with cached data', async () => {
	const now = new Date();
	const timestamp = now.getTime() - 60000;
	const jsonlContent = [
		JSON.stringify({ type: 'user.message', timestamp, model: 'gpt-4o', data: { content: 'hello' } }),
		JSON.stringify({ type: 'assistant.message', timestamp: timestamp + 1000, model: 'gpt-4o', data: { content: 'world' } })
	].join('\n');
	const tmpFile = createTempFile(jsonlContent, '.jsonl');
	try {
		const svc = makeService({
			getSessionFileDataCached: async () => ({
				tokens: 150, mtime: Date.now(),
				interactions: 1,
				modelUsage: { 'gpt-4o': { inputTokens: 50, outputTokens: 100 } }
			}),
		});
		const rollups = new Map();
		const result = await (svc as any).processCachedSessionFile(
			tmpFile.filePath, Date.now(), 100, 'ws', 'machine', undefined, rollups,
			timestamp - 1000,
			now
		);
		assert.equal(result, true);
	} finally {
		tmpFile.cleanup();
	}
});

test('processCachedSessionFile skips invalid inputTokens in model usage', async () => {
	const now = new Date();
	const timestamp = now.getTime() - 60000;
	const sessionContent = JSON.stringify({
		requests: [{
			timestamp,
			message: { parts: [{ text: 'hello' }] },
			response: [{ value: 'world' }]
		}]
	});
	const tmpFile = createTempFile(sessionContent);
	try {
		const warns: string[] = [];
		const svc = makeService({
			warn: (m) => warns.push(m),
			getSessionFileDataCached: async () => ({
				tokens: 195, mtime: Date.now(),
				interactions: 1,
				modelUsage: { 'gpt-4o': { inputTokens: -5, outputTokens: 200 } }
			}),
			getModelFromRequest: () => 'gpt-4o',
		});
		const rollups = new Map();
		const result = await (svc as any).processCachedSessionFile(
			tmpFile.filePath, Date.now(), 100, 'ws', 'machine', undefined, rollups,
			timestamp - 1000, now
		);
		assert.equal(result, true);
		// Rollups should be empty because invalid input tokens were skipped
		assert.equal(rollups.size, 0);
		assert.ok(warns.some(m => m.includes('invalid inputTokens')));
	} finally {
		tmpFile.cleanup();
	}
});

test('processCachedSessionFile returns false on ENOENT cache miss', async () => {
	const svc = makeService({
		getSessionFileDataCached: async () => { throw new Error('ENOENT: file not found'); },
	});
	const rollups = new Map();
	const result = await (svc as any).processCachedSessionFile(
		'/fake/session.json', Date.now(), 100, 'ws', 'machine', undefined, rollups, 0, new Date()
	);
	assert.equal(result, false);
});

test('processCachedSessionFile returns false on unexpected error', async () => {
	const warns: string[] = [];
	const svc = makeService({
		warn: (m) => warns.push(m),
		getSessionFileDataCached: async () => { throw new Error('network error'); },
	});
	const rollups = new Map();
	const result = await (svc as any).processCachedSessionFile(
		'/fake/session.json', Date.now(), 100, 'ws', 'machine', undefined, rollups, 0, new Date()
	);
	assert.equal(result, false);
	assert.ok(warns.some(m => m.includes('cache error')));
});

// Ecosystem sessions (Mistral Vibe, Claude Desktop Cowork) always have dailyRollups
// populated by getSessionFileDataCached via the firstInteraction fallback. These tests verify
// that processCachedSessionFile fast path correctly handles that data structure — without
// needing a real session file on disk.

test('processCachedSessionFile fast path handles Mistral Vibe-style dailyRollups', async () => {
	const now = new Date();
	const dayKey = now.toISOString().slice(0, 10);
	const startMs = new Date(dayKey + 'T00:00:00Z').getTime() - 1000; // day started before startMs check
	const svc = makeService({
		getSessionFileDataCached: async () => ({
			tokens: 8000, mtime: Date.now(),
			interactions: 5,
			modelUsage: { 'devstral-2': { inputTokens: 5000, outputTokens: 3000 } },
			dailyRollups: {
				[dayKey]: {
					tokens: 8000,
					actualTokens: 8000,
					thinkingTokens: 0,
					interactions: 5,
					modelUsage: { 'devstral-2': { inputTokens: 5000, outputTokens: 3000 } },
				}
			}
		}),
	});
	const rollups = new Map();
	const result = await (svc as any).processCachedSessionFile(
		'/home/user/.vibe/logs/session/session_20250101_120000_abc/meta.json',
		Date.now(), 100, 'ws', 'machine', undefined, rollups, startMs, now
	);
	assert.equal(result, true);
	assert.equal(rollups.size, 1);
	const entry = Array.from(rollups.values())[0] as any;
	assert.equal(entry.key.model, 'devstral-2');
	assert.equal(entry.value.inputTokens, 5000);
	assert.equal(entry.value.outputTokens, 3000);
	assert.equal(entry.value.interactions, 5);
});

test('processCachedSessionFile fast path skips day before startMs', async () => {
	const now = new Date();
	const yesterdayKey = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);
	// startMs = today midnight → yesterday is excluded
	const todayMidnightMs = new Date(now.toISOString().slice(0, 10) + 'T00:00:00Z').getTime();
	const svc = makeService({
		getSessionFileDataCached: async () => ({
			tokens: 1000, mtime: Date.now(),
			interactions: 2,
			modelUsage: { 'devstral': { inputTokens: 600, outputTokens: 400 } },
			dailyRollups: {
				[yesterdayKey]: {
					tokens: 1000,
					actualTokens: 1000,
					thinkingTokens: 0,
					interactions: 2,
					modelUsage: { 'devstral': { inputTokens: 600, outputTokens: 400 } },
				}
			}
		}),
	});
	const rollups = new Map();
	const result = await (svc as any).processCachedSessionFile(
		'/home/user/.vibe/logs/session/session_20250101_120000_abc/meta.json',
		Date.now(), 100, 'ws', 'machine', undefined, rollups, todayMidnightMs, now
	);
	assert.equal(result, true);
	assert.equal(rollups.size, 0, 'yesterday session should be filtered out by startMs');
});

// ── computeDailyRollupsFromLocalSessions (private, fallback path) ────────

test('computeDailyRollupsFromLocalSessions processes JSON files in fallback path', async () => {
	const now = new Date();
	const timestamp = now.getTime() - 60000;
	const sessionContent = JSON.stringify({
		requests: [{
			timestamp,
			message: { parts: [{ text: 'hello world' }] },
			response: [{ value: 'response text' }]
		}]
	});
	const tmpFile = createTempFile(sessionContent);
	try {
		const svc = makeService({
			getCopilotSessionFiles: async () => [tmpFile.filePath],
			estimateTokensFromText: (text: string) => text.length,
			getModelFromRequest: () => 'gpt-4o',
			statSessionFile: async () => ({ mtimeMs: Date.now(), size: 100 } as any),
			// No getSessionFileDataCached → forces fallback path
		});
		const result = await (svc as any).computeDailyRollupsFromLocalSessions({
			lookbackDays: 7,
			userId: undefined
		});
		assert.ok(result.rollups.size > 0);
		// Verify a rollup was created
		const first = Array.from(result.rollups.values())[0] as any;
		assert.equal(first.key.model, 'gpt-4o');
		assert.ok(first.value.inputTokens > 0);
		assert.ok(first.value.outputTokens > 0);
		assert.equal(first.value.interactions, 1);
	} finally {
		tmpFile.cleanup();
	}
});

test('computeDailyRollupsFromLocalSessions processes JSONL files in fallback path', async () => {
	const now = new Date();
	const timestamp = now.getTime() - 60000;
	const jsonlContent = [
		JSON.stringify({ type: 'user.message', timestamp, model: 'claude-sonnet', data: { content: 'hello' } }),
		JSON.stringify({ type: 'assistant.message', timestamp: timestamp + 1000, model: 'claude-sonnet', data: { content: 'reply' } })
	].join('\n');
	const tmpFile = createTempFile(jsonlContent, '.jsonl');
	try {
		const svc = makeService({
			getCopilotSessionFiles: async () => [tmpFile.filePath],
			estimateTokensFromText: (text: string) => text.length,
			statSessionFile: async () => ({ mtimeMs: Date.now(), size: 100 } as any),
		});
		const result = await (svc as any).computeDailyRollupsFromLocalSessions({
			lookbackDays: 7,
			userId: 'user1'
		});
		assert.ok(result.rollups.size > 0);
		const first = Array.from(result.rollups.values())[0] as any;
		assert.equal(first.key.model, 'claude-sonnet');
		assert.equal(first.key.userId, 'user1');
	} finally {
		tmpFile.cleanup();
	}
});

test('syncToSharingServer preserves the Copilot App editor label in uploaded rollups', async () => {
	const dayKey = new Date().toISOString().slice(0, 10);
	const sessionFile = '/home/user/.copilot/session-state/app-session/events.jsonl';
	const uploadedEntries: Array<{ editor?: string }> = [];
	const svc = new SyncService(
		makeDeps({
			getGithubToken: () => 'github-token',
			getCopilotSessionFiles: async () => [sessionFile],
			getEditorLabel: () => 'Copilot CLI (App)',
			statSessionFile: async () => ({ mtimeMs: Date.now(), size: 100 } as any),
			getSessionFileDataCached: async () => ({
				tokens: 300,
				mtime: Date.now(),
				interactions: 1,
				modelUsage: { 'gpt-4o': { inputTokens: 100, outputTokens: 200 } },
				dailyRollups: {
					[dayKey]: {
						tokens: 300,
						actualTokens: 300,
						thinkingTokens: 0,
						interactions: 1,
						modelUsage: { 'gpt-4o': { inputTokens: 100, outputTokens: 200 } },
					},
				},
			}),
		}),
		{} as any,
		{} as any,
		undefined,
		BackendUtility,
		{
			uploadRollups: async (_endpoint: string, _token: string, entries: Array<{ editor?: string }>) => {
				uploadedEntries.push(...entries);
				return { success: true, entriesUploaded: entries.length, message: 'Uploaded' };
			},
		} as any,
	);

	await (svc as any).syncToSharingServer(
		{ lookbackDays: 7, datasetId: 'default', sharingServerEndpointUrl: 'https://sharing.example.com' },
		{ allowCloudSync: true, includeUserDimension: false, includeNames: false },
	);

	assert.deepEqual(uploadedEntries.map(entry => entry.editor), ['Copilot CLI (App)']);
});

test('computeDailyRollupsFromLocalSessions skips files older than lookback', async () => {
	const now = new Date();
	const oldTimestamp = now.getTime() - 30 * 24 * 60 * 60 * 1000; // 30 days ago
	const sessionContent = JSON.stringify({
		requests: [{
			timestamp: oldTimestamp,
			message: { parts: [{ text: 'old' }] },
			response: [{ value: 'old reply' }]
		}]
	});
	const tmpFile = createTempFile(sessionContent);
	try {
		const svc = makeService({
			getCopilotSessionFiles: async () => [tmpFile.filePath],
			estimateTokensFromText: (text: string) => text.length,
			statSessionFile: async () => ({ mtimeMs: oldTimestamp, size: 100 } as any),
		});
		const result = await (svc as any).computeDailyRollupsFromLocalSessions({
			lookbackDays: 7,
			userId: undefined
		});
		// File is too old, should be skipped
		assert.equal(result.rollups.size, 0);
	} finally {
		tmpFile.cleanup();
	}
});

test('computeDailyRollupsFromLocalSessions uses cached path when available', async () => {
	const now = new Date();
	const timestamp = now.getTime() - 60000;
	const sessionContent = JSON.stringify({
		requests: [{
			timestamp,
			message: { parts: [{ text: 'hello' }] },
			response: [{ value: 'world' }]
		}]
	});
	const tmpFile = createTempFile(sessionContent);
	try {
		let cacheWasCalled = false;
		const svc = makeService({
			getCopilotSessionFiles: async () => [tmpFile.filePath],
			estimateTokensFromText: (text: string) => text.length,
			getModelFromRequest: () => 'gpt-4o',
			statSessionFile: async () => ({ mtimeMs: Date.now(), size: 100 } as any),
			getSessionFileDataCached: async () => {
				cacheWasCalled = true;
				return {
					tokens: 300, mtime: Date.now(),
					interactions: 1,
					modelUsage: { 'gpt-4o': { inputTokens: 100, outputTokens: 200 } }
				};
			}
		});
		const result = await (svc as any).computeDailyRollupsFromLocalSessions({
			lookbackDays: 7,
			userId: undefined
		});
		assert.ok(cacheWasCalled);
		assert.ok(result.rollups.size > 0);
	} finally {
		tmpFile.cleanup();
	}
});

test('computeDailyRollupsFromLocalSessions handles stat errors gracefully', async () => {
	const warns: string[] = [];
	const svc = makeService({
		warn: (m) => warns.push(m),
		getCopilotSessionFiles: async () => ['/nonexistent/session.json'],
		statSessionFile: async () => { throw new Error('ENOENT'); },
	});
	const result = await (svc as any).computeDailyRollupsFromLocalSessions({
		lookbackDays: 7,
		userId: undefined
	});
	assert.equal(result.rollups.size, 0);
	assert.ok(warns.some(m => m.includes('failed to stat')));
});

test('computeDailyRollupsFromLocalSessions handles OpenCode sessions', async () => {
	const now = new Date();
	const timestamp = now.getTime() - 60000;
	const svc = makeService({
		getCopilotSessionFiles: async () => ['/fake/opencode/session.json'],
		statSessionFile: async () => ({ mtimeMs: Date.now(), size: 100 } as any),
		isOpenCodeSession: () => true,
		getOpenCodeSessionData: async () => ({
			tokens: 300,
			interactions: 2,
			modelUsage: {
				'claude-sonnet': { inputTokens: 100, outputTokens: 200, interactions: 2 }
			},
			timestamp
		}),
	});
	const result = await (svc as any).computeDailyRollupsFromLocalSessions({
		lookbackDays: 7,
		userId: undefined
	});
	assert.ok(result.rollups.size > 0);
	const first = Array.from(result.rollups.values())[0] as any;
	assert.equal(first.key.model, 'claude-sonnet');
});

test('computeDailyRollupsFromLocalSessions skips OpenCode sessions without handler', async () => {
	const svc = makeService({
		getCopilotSessionFiles: async () => ['/fake/opencode/session.json'],
		statSessionFile: async () => ({ mtimeMs: Date.now(), size: 100 } as any),
		isOpenCodeSession: () => true,
		// No getOpenCodeSessionData
	});
	const result = await (svc as any).computeDailyRollupsFromLocalSessions({
		lookbackDays: 7,
		userId: undefined
	});
	assert.equal(result.rollups.size, 0);
});

// ── Ecosystem session pipeline regression tests ───────────────────────────
// These tests verify the full pipeline for Mistral Vibe and Claude Desktop
// Cowork sessions. Before the fix, getSessionFileDataCached returned no
// dailyRollups for ecosystem sessions, causing processCachedSessionFile to
// fall through to the slow path which could not parse meta.json/custom JSONL
// files, and silently returned true with zero rollups.
//
// The fix populates dailyRollups in getSessionFileDataCached using
// firstInteraction when dailyInteractions is empty (always the case for
// ecosystem sessions). These tests verify the full cached pipeline round-trip.

test('computeDailyRollupsFromLocalSessions: Mistral Vibe session produces non-zero rollups (regression)', async () => {
	const now = new Date();
	const dayKey = now.toISOString().slice(0, 10);
	// Mistral Vibe session — no actual file on disk needed; fast path uses dailyRollups from cache.
	const sessionFile = '/home/user/.vibe/logs/session/session_20260101_120000_abcdef/meta.json';
	const svc = makeService({
		getCopilotSessionFiles: async () => [sessionFile],
		statSessionFile: async () => ({ mtimeMs: Date.now(), size: 1024 } as any),
		getSessionFileDataCached: async () => ({
			tokens: 12000,
			interactions: 7,
			modelUsage: { 'devstral-2': { inputTokens: 8000, outputTokens: 4000 } },
			mtime: Date.now(),
			size: 1024,
			firstInteraction: now.toISOString(),
			dailyRollups: {
				[dayKey]: {
					tokens: 12000,
					actualTokens: 12000,
					thinkingTokens: 0,
					interactions: 7,
					modelUsage: { 'devstral-2': { inputTokens: 8000, outputTokens: 4000 } },
				}
			}
		}),
	});
	const result = await (svc as any).computeDailyRollupsFromLocalSessions({
		lookbackDays: 7,
		userId: undefined
	});
	assert.ok(result.rollups.size > 0, 'Mistral Vibe session must produce at least one rollup');
	const entry = Array.from(result.rollups.values())[0] as any;
	assert.equal(entry.key.model, 'devstral-2');
	assert.equal(entry.value.inputTokens, 8000);
	assert.equal(entry.value.outputTokens, 4000);
	assert.equal(entry.value.interactions, 7);
});

test('computeDailyRollupsFromLocalSessions: Claude Desktop Cowork session produces non-zero rollups (regression)', async () => {
	const now = new Date();
	const dayKey = now.toISOString().slice(0, 10);
	const sessionFile = '/home/user/AppData/Local/Packages/Claude_abc/LocalCache/Roaming/claude/local-agent-mode-sessions/session.jsonl';
	const svc = makeService({
		getCopilotSessionFiles: async () => [sessionFile],
		statSessionFile: async () => ({ mtimeMs: Date.now(), size: 2048 } as any),
		getSessionFileDataCached: async () => ({
			tokens: 5000,
			interactions: 3,
			modelUsage: { 'claude-sonnet-4': { inputTokens: 3000, outputTokens: 2000 } },
			mtime: Date.now(),
			size: 2048,
			firstInteraction: now.toISOString(),
			dailyRollups: {
				[dayKey]: {
					tokens: 5000,
					actualTokens: 5000,
					thinkingTokens: 0,
					interactions: 3,
					modelUsage: { 'claude-sonnet-4': { inputTokens: 3000, outputTokens: 2000 } },
				}
			}
		}),
	});
	const result = await (svc as any).computeDailyRollupsFromLocalSessions({
		lookbackDays: 7,
		userId: undefined
	});
	assert.ok(result.rollups.size > 0, 'Claude Desktop Cowork session must produce at least one rollup');
	const entry = Array.from(result.rollups.values())[0] as any;
	assert.equal(entry.key.model, 'claude-sonnet-4');
	assert.equal(entry.value.inputTokens, 3000);
	assert.equal(entry.value.outputTokens, 2000);
});

test('computeDailyRollupsFromLocalSessions handles malformed JSON gracefully', async () => {
	const tmpFile = createTempFile('not valid json');
	try {
		const warns: string[] = [];
		const svc = makeService({
			warn: (m) => warns.push(m),
			getCopilotSessionFiles: async () => [tmpFile.filePath],
			statSessionFile: async () => ({ mtimeMs: Date.now(), size: 100 } as any),
		});
		const result = await (svc as any).computeDailyRollupsFromLocalSessions({
			lookbackDays: 7,
			userId: undefined
		});
		assert.equal(result.rollups.size, 0);
		assert.ok(warns.some(m => m.includes('failed to parse')));
	} finally {
		tmpFile.cleanup();
	}
});

// ── getSyncQueue ─────────────────────────────────────────────────────────

test('getSyncQueue returns resolved promise initially', async () => {
	const svc = makeService();
	await svc.getSyncQueue(); // Should not throw
});

// ── syncToBackendStore: credential and data-plane flow ───────────────────

test('syncToBackendStore skips when credentials are not available', async () => {
	const logs: string[] = [];
	const warns: string[] = [];
	const svc = makeServiceWithServices(
		{ log: (m) => logs.push(m), warn: (m) => warns.push(m) },
		{
			getBackendDataPlaneCredentials: async () => undefined,
			getBackendSecretsToRedactForError: async () => [],
		}
	);
	await svc.syncToBackendStore(true, {
		enabled: true,
		sharingProfile: 'soloFull',
		shareWorkspaceMachineNames: false,
		subscriptionId: 'sub1',
		resourceGroup: 'rg1',
		storageAccount: 'sa1',
		aggTable: 'usageAgg',
		datasetId: 'ds1',
		lookbackDays: 7,
	} as any, true);
	assert.ok(warns.some(m => m.includes('credentials not available')));
});

test('syncToBackendStore completes full sync flow with mocked services', async () => {
	const now = new Date();
	const timestamp = now.getTime() - 60000;
	const sessionContent = JSON.stringify({
		requests: [{
			timestamp,
			message: { parts: [{ text: 'hello world' }] },
			response: [{ value: 'response text' }]
		}]
	});
	const tmpFile = createTempFile(sessionContent);
	try {
		const logs: string[] = [];
		let upsertedEntities: any[] = [];
		const svc = makeServiceWithServices(
			{
				log: (m) => logs.push(m),
				warn: () => {},
				getCopilotSessionFiles: async () => [tmpFile.filePath],
				estimateTokensFromText: (text: string) => text.length,
				getModelFromRequest: () => 'gpt-4o',
				statSessionFile: async () => ({ mtimeMs: Date.now(), size: 100 } as any),
			},
			{
				getBackendDataPlaneCredentials: async () => ({
					tableCredential: { getToken: async () => ({ token: 'test', expiresOnTimestamp: Date.now() + 3600000 }) },
					blobCredential: {},
					secretsToRedact: [],
				}),
				getBackendSecretsToRedactForError: async () => [],
			},
			{
				ensureTableExists: async () => {},
				validateAccess: async () => {},
				createTableClient: () => ({
					async *listEntities() {},
					upsertEntity: async (entity: any) => { upsertedEntities.push(entity); },
					deleteEntity: async () => ({}),
				}),
				upsertEntitiesBatch: async (_tc: any, entities: any[]) => {
					upsertedEntities = entities;
					return { successCount: entities.length, errors: [] };
				},
			}
		);
		await svc.syncToBackendStore(true, {
			enabled: true,
			sharingProfile: 'soloFull',
			shareWorkspaceMachineNames: false,
			subscriptionId: 'sub1',
			resourceGroup: 'rg1',
			storageAccount: 'sa1',
			aggTable: 'usageAgg',
			datasetId: 'ds1',
			lookbackDays: 7,
			blobUploadEnabled: false,
		} as any, true);
		assert.ok(logs.some(m => m.includes('completed')));
		assert.ok(upsertedEntities.length > 0);
	} finally {
		tmpFile.cleanup();
	}
});

test('syncToBackendStore logs warning when upsertEntitiesBatch has errors', async () => {
	const now = new Date();
	const timestamp = now.getTime() - 60000;
	const sessionContent = JSON.stringify({
		requests: [{
			timestamp,
			message: { parts: [{ text: 'hello' }] },
			response: [{ value: 'world' }]
		}]
	});
	const tmpFile = createTempFile(sessionContent);
	try {
		const warns: string[] = [];
		const svc = makeServiceWithServices(
			{
				log: () => {},
				warn: (m) => warns.push(m),
				getCopilotSessionFiles: async () => [tmpFile.filePath],
				estimateTokensFromText: (text: string) => text.length,
				getModelFromRequest: () => 'gpt-4o',
				statSessionFile: async () => ({ mtimeMs: Date.now(), size: 100 } as any),
			},
			{
				getBackendDataPlaneCredentials: async () => ({
					tableCredential: {},
					blobCredential: {},
					secretsToRedact: [],
				}),
				getBackendSecretsToRedactForError: async () => [],
			},
			{
				ensureTableExists: async () => {},
				validateAccess: async () => {},
				createTableClient: () => ({}),
				upsertEntitiesBatch: async (_tc: any, entities: any[]) => ({
					successCount: 0,
					errors: entities.map((e: any) => ({ entity: e, error: new Error('write failed') })),
				}),
			}
		);
		await svc.syncToBackendStore(true, {
			enabled: true,
			sharingProfile: 'soloFull',
			shareWorkspaceMachineNames: false,
			subscriptionId: 'sub1',
			resourceGroup: 'rg1',
			storageAccount: 'sa1',
			aggTable: 'usageAgg',
			datasetId: 'ds1',
			lookbackDays: 7,
			blobUploadEnabled: false,
		} as any, true);
		assert.ok(warns.some(m => m.includes('failed')));
	} finally {
		tmpFile.cleanup();
	}
});

test('syncToBackendStore does NOT update the Azure lastSync marker when every entity fails to upsert', async () => {
	// `upsertEntitiesBatch` catches per entity and returns normally, so a total
	// write failure never throws. The Azure status panel used to show a healthy
	// recent sync in exactly that case — the same defect as the Team Server marker.
	const globalState = new Map<string, unknown>();
	const lockDir = fs.mkdtempSync(path.join(process.cwd(), 'azure-marker-test-'));
	const mockContext = {
		globalState: {
			get: (key: string) => globalState.get(key),
			update: async (key: string, value: unknown) => { globalState.set(key, value); },
		},
		globalStorageUri: { fsPath: lockDir },
	} as unknown as vscode.ExtensionContext;
	const sessionContent = JSON.stringify({
		requests: [{ timestamp: Date.now() - 60000, message: { parts: [{ text: 'hello' }] }, response: [{ value: 'world' }] }]
	});
	const tmpFile = createTempFile(sessionContent);
	try {
		let entityCount = 0;
		const svc = new SyncService(
			makeDeps({
				context: mockContext,
				getCopilotSessionFiles: async () => [tmpFile.filePath],
				estimateTokensFromText: (text: string) => text.length,
				getModelFromRequest: () => 'gpt-4o',
				statSessionFile: async () => ({ mtimeMs: Date.now(), size: 100 } as any),
			}),
			{
				getBackendDataPlaneCredentials: async () => ({ tableCredential: {}, blobCredential: {}, secretsToRedact: [] }),
				getBackendSecretsToRedactForError: async () => [],
			} as any,
			{
				ensureTableExists: async () => {},
				validateAccess: async () => {},
				createTableClient: () => ({}),
				upsertEntitiesBatch: async (_tc: any, entities: any[]) => {
					entityCount = entities.length;
					return { successCount: 0, errors: entities.map((e: any) => ({ entity: e, error: new Error('write failed') })) };
				},
			} as any,
			undefined,
			BackendUtility,
			undefined,
		);
		await svc.syncToBackendStore(true, {
			enabled: true, sharingProfile: 'soloFull', shareWorkspaceMachineNames: false,
			subscriptionId: 'sub1', resourceGroup: 'rg1', storageAccount: 'sa1',
			aggTable: 'usageAgg', datasetId: 'ds1', lookbackDays: 7, blobUploadEnabled: false,
		} as any, true);
		assert.ok(entityCount > 0, 'Test must exercise a real upsert, not the empty-scan path');
		assert.equal(globalState.get('backend.azureLastSyncAt'), undefined, 'Every entity failed, so the Azure marker must not advance');
	} finally {
		tmpFile.cleanup();
		fs.rmSync(lockDir, { recursive: true, force: true });
	}
});

test('syncToBackendStore updates the Azure lastSync marker when every entity is stored', async () => {
	const globalState = new Map<string, unknown>();
	const lockDir = fs.mkdtempSync(path.join(process.cwd(), 'azure-marker-ok-test-'));
	const mockContext = {
		globalState: {
			get: (key: string) => globalState.get(key),
			update: async (key: string, value: unknown) => { globalState.set(key, value); },
		},
		globalStorageUri: { fsPath: lockDir },
	} as unknown as vscode.ExtensionContext;
	const sessionContent = JSON.stringify({
		requests: [{ timestamp: Date.now() - 60000, message: { parts: [{ text: 'hello' }] }, response: [{ value: 'world' }] }]
	});
	const tmpFile = createTempFile(sessionContent);
	try {
		const svc = new SyncService(
			makeDeps({
				context: mockContext,
				getCopilotSessionFiles: async () => [tmpFile.filePath],
				estimateTokensFromText: (text: string) => text.length,
				getModelFromRequest: () => 'gpt-4o',
				statSessionFile: async () => ({ mtimeMs: Date.now(), size: 100 } as any),
			}),
			{
				getBackendDataPlaneCredentials: async () => ({ tableCredential: {}, blobCredential: {}, secretsToRedact: [] }),
				getBackendSecretsToRedactForError: async () => [],
			} as any,
			{
				ensureTableExists: async () => {},
				validateAccess: async () => {},
				createTableClient: () => ({}),
				upsertEntitiesBatch: async (_tc: any, entities: any[]) => ({ successCount: entities.length, errors: [] }),
			} as any,
			undefined,
			BackendUtility,
			undefined,
		);
		await svc.syncToBackendStore(true, {
			enabled: true, sharingProfile: 'soloFull', shareWorkspaceMachineNames: false,
			subscriptionId: 'sub1', resourceGroup: 'rg1', storageAccount: 'sa1',
			aggTable: 'usageAgg', datasetId: 'ds1', lookbackDays: 7, blobUploadEnabled: false,
		} as any, true);
		assert.ok(globalState.get('backend.azureLastSyncAt'), 'A fully successful Azure sync must advance its marker');
	} finally {
		tmpFile.cleanup();
		fs.rmSync(lockDir, { recursive: true, force: true });
	}
});

test('syncToBackendStore handles ensureTableExists or validateAccess failure gracefully', async () => {
	const warns: string[] = [];
	const svc = makeServiceWithServices(
		{
			log: () => {},
			warn: (m) => warns.push(m),
		},
		{
			getBackendDataPlaneCredentials: async () => ({
				tableCredential: {},
				blobCredential: {},
				secretsToRedact: [],
			}),
			getBackendSecretsToRedactForError: async () => [],
		},
		{
			ensureTableExists: async () => { throw new Error('network error'); },
			validateAccess: async () => {},
			createTableClient: () => ({}),
			upsertEntitiesBatch: async () => ({ successCount: 0, errors: [] }),
		}
	);
	await svc.syncToBackendStore(true, {
		enabled: true,
		sharingProfile: 'soloFull',
		shareWorkspaceMachineNames: false,
		subscriptionId: 'sub1',
		resourceGroup: 'rg1',
		storageAccount: 'sa1',
		aggTable: 'usageAgg',
		datasetId: 'ds1',
		lookbackDays: 7,
		blobUploadEnabled: false,
	} as any, true);
	assert.ok(warns.some(m => m.includes('network error')));
});

test('syncToBackendStore still attempts sharing server sync when Azure sync fails', async () => {
	const logs: string[] = [];
	const warns: string[] = [];
	const sharingServerSvc = { uploadRollups: async (_u: string, _t: string, entries: unknown[]) => ({ success: true, entriesUploaded: entries.length, message: 'ok' }), uploadFluencyScore: async () => true };
	const svc = new SyncService(
		makeDeps({
			log: (m) => logs.push(m),
			warn: (m) => warns.push(m),
			getGithubToken: () => undefined,
		}),
		{
			getBackendDataPlaneCredentials: async () => ({
				tableCredential: {},
				blobCredential: {},
				secretsToRedact: [],
			}),
			getBackendSecretsToRedactForError: async () => [],
		} as any,
		{
			ensureTableExists: async () => { throw new Error('Azure connection failed'); },
			validateAccess: async () => {},
			createTableClient: () => ({}),
			upsertEntitiesBatch: async () => ({ successCount: 0, errors: [] }),
		} as any,
		undefined,
		BackendUtility,
		sharingServerSvc as any,
	);
	await svc.syncToBackendStore(true, {
		enabled: true,
		backend: 'storageTables',
		sharingProfile: 'teamIdentified',
		shareWorkspaceMachineNames: false,
		storageAccount: 'sa1',
		subscriptionId: 'sub1',
		resourceGroup: 'rg1',
		aggTable: 'usageAgg',
		eventsTable: 'usageEvents',
		lookbackDays: 7,
		sharingServerEnabled: true,
		sharingServerEndpointUrl: 'https://test-sharing-server/',
		shareWithTeam: true,
		userIdentityMode: 'pseudonymous',
		userId: '',
		userIdMode: 'alias',
		datasetId: 'default',
		shareConsentAt: '',
		includeMachineBreakdown: false,
		blobUploadEnabled: false,
		blobContainerName: '',
		blobUploadFrequencyHours: 24,
		blobCompressFiles: true,
		authMode: 'entraId',
	} as any, true);
	assert.ok(warns.some(m => m.includes('Azure connection failed')), `Expected Azure error in warns. Got: ${warns.join('\n')}`);
	// Sharing server sync should still be attempted (no GitHub token → skipping log appears)
	assert.ok(
		logs.some(m => m.includes('Sharing server upload: skipping')),
		`Expected sharing server sync attempt even after Azure failure. Logs: ${logs.join('\n')}`
	);
});

test('syncToBackendStore tracks Azure and Team Server "last sync" independently — a successful sharing-server sync updates only its own timestamp when Azure fails', async () => {
	const globalState = new Map<string, unknown>();
	const lockDir = fs.mkdtempSync(path.join(process.cwd(), 'sync-lock-test-'));
	const mockContext = {
		globalState: {
			get: (key: string) => globalState.get(key),
			update: async (key: string, value: unknown) => { globalState.set(key, value); },
		},
		globalStorageUri: { fsPath: lockDir },
	} as unknown as vscode.ExtensionContext;
	const sharingServerSvc = { uploadRollups: async (_u: string, _t: string, entries: unknown[]) => ({ success: true, entriesUploaded: entries.length, message: 'ok' }), uploadFluencyScore: async () => true };
	const svc = new SyncService(
		makeDeps({
			context: mockContext,
			getGithubToken: () => 'fake-token',
			getCopilotSessionFiles: async () => [],
		}),
		{
			getBackendDataPlaneCredentials: async () => ({
				tableCredential: {},
				blobCredential: {},
				secretsToRedact: [],
			}),
			getBackendSecretsToRedactForError: async () => [],
		} as any,
		{
			ensureTableExists: async () => { throw new Error('Azure connection failed'); },
			validateAccess: async () => {},
			createTableClient: () => ({}),
			upsertEntitiesBatch: async () => ({ successCount: 0, errors: [] }),
		} as any,
		undefined,
		BackendUtility,
		sharingServerSvc as any,
	);
	await svc.syncToBackendStore(true, {
		enabled: true,
		backend: 'storageTables',
		sharingProfile: 'teamAnonymized',
		shareWorkspaceMachineNames: false,
		storageAccount: 'sa1',
		subscriptionId: 'sub1',
		resourceGroup: 'rg1',
		aggTable: 'usageAgg',
		eventsTable: 'usageEvents',
		lookbackDays: 7,
		sharingServerEnabled: true,
		sharingServerEndpointUrl: 'https://test-sharing-server/',
		shareWithTeam: false,
		userIdentityMode: 'pseudonymous',
		userId: '',
		userIdMode: 'alias',
		datasetId: 'default',
		shareConsentAt: '',
		includeMachineBreakdown: false,
		blobUploadEnabled: false,
		blobContainerName: '',
		blobUploadFrequencyHours: 24,
		blobCompressFiles: true,
		authMode: 'entraId',
	} as any, true);
	assert.ok(globalState.get('backend.sharingServerRollupLastSyncAt'), 'Team Server sync succeeded and should update its own lastSync marker');
	assert.equal(globalState.get('backend.azureLastSyncAt'), undefined, 'Azure sync failed and must NOT update the Azure-specific lastSync marker');
	fs.rmSync(lockDir, { recursive: true, force: true });
});

test('uploadFluencyScoreToSharingServer updates its own fluency marker and leaves the rollup marker alone', async () => {
	const globalState = new Map<string, unknown>();
	const mockContext = {
		globalState: {
			get: (key: string) => globalState.get(key),
			update: async (key: string, value: unknown) => { globalState.set(key, value); },
		},
	} as unknown as vscode.ExtensionContext;
	const sharingServerSvc = { uploadRollups: async (_u: string, _t: string, entries: unknown[]) => ({ success: true, entriesUploaded: entries.length, message: 'ok' }), uploadFluencyScore: async () => true };
	const svc = new SyncService(
		makeDeps({
			context: mockContext,
			getGithubToken: () => 'fake-token',
		}),
		{} as any,
		{} as any,
		undefined,
		BackendUtility,
		sharingServerSvc as any,
	);
	await svc.uploadFluencyScoreToSharingServer({
		sharingServerEnabled: true,
		sharingServerEndpointUrl: 'https://test-sharing-server/',
	} as any, { overallStage: 'exploring' });
	assert.ok(
		globalState.get('backend.sharingServerFluencyLastSyncAt'),
		'A successful fluency-score upload must update the fluency-specific marker'
	);
	assert.equal(
		globalState.get('backend.sharingServerRollupLastSyncAt'),
		undefined,
		'The score upload says nothing about rollup delivery, so it must not touch the usage-sync marker'
	);
});

test('a successful rollup sync writes the new marker and never revives the shared legacy key', async () => {
	// Older versions wrote backend.sharingServerLastSyncAt from BOTH uploads, so a
	// value left on disk there may have come from a score upload alone. Reading it
	// as the Usage Sync timestamp after upgrade would show a fresh, confirmed-looking
	// rollup sync that never happened — the exact bug this split removes, carried
	// across the upgrade by persisted state.
	const legacyValue = Date.parse('2020-01-01T00:00:00.000Z');
	const globalState = new Map<string, unknown>([['backend.sharingServerLastSyncAt', legacyValue]]);
	const mockContext = {
		globalState: {
			get: (key: string) => globalState.get(key),
			update: async (key: string, value: unknown) => { globalState.set(key, value); },
		},
	} as unknown as vscode.ExtensionContext;
	let rollupAttempts = 0;
	const svc = new SyncService(
		makeDeps({
			context: mockContext,
			getGithubToken: () => 'fake-token',
			getCopilotSessionFiles: async () => ['/home/user/.copilot/session-state/s/events.jsonl'],
			statSessionFile: async () => ({ mtimeMs: Date.now(), size: 100 } as any),
			getSessionFileDataCached: async () => ({
				tokens: 300,
				mtime: Date.now(),
				interactions: 1,
				modelUsage: { 'gpt-4o': { inputTokens: 100, outputTokens: 200 } },
				dailyRollups: {
					[new Date().toISOString().slice(0, 10)]: {
						tokens: 300,
						actualTokens: 300,
						thinkingTokens: 0,
						interactions: 1,
						modelUsage: { 'gpt-4o': { inputTokens: 100, outputTokens: 200 } },
					},
				},
			}),
		}),
		{} as any,
		{} as any,
		undefined,
		BackendUtility,
		{
			uploadRollups: async (_u: string, _t: string, entries: unknown[]) => {
				rollupAttempts++;
				return { success: true, entriesUploaded: entries.length, message: 'ok' };
			},
			uploadFluencyScore: async () => true,
		} as any,
	);

	await (svc as any).runSharingServerSyncIndependently(
		{ sharingServerEnabled: true, sharingServerEndpointUrl: 'https://test-sharing-server/', lookbackDays: 7, datasetId: 'default' } as any,
		{ allowCloudSync: true, includeUserDimension: false, includeNames: false } as any,
	);

	// Without this the test would pass through the empty-scan no-op, which advances
	// the marker without ever uploading anything and so proves nothing about delivery.
	assert.ok(rollupAttempts > 0, 'Guard: a real rollup upload must have been attempted');
	assert.ok(
		globalState.get('backend.sharingServerRollupLastSyncAt'),
		'A successful rollup sync must write the rollup-specific marker'
	);
	assert.equal(
		globalState.get('backend.sharingServerLastSyncAt'),
		legacyValue,
		'The retired shared key must be left alone, not written or migrated into the new one'
	);
});

test('uploadFluencyScoreToSharingServer does NOT update the lastSync marker when the upload fails', async () => {
	const globalState = new Map<string, unknown>();
	const mockContext = {
		globalState: {
			get: (key: string) => globalState.get(key),
			update: async (key: string, value: unknown) => { globalState.set(key, value); },
		},
	} as unknown as vscode.ExtensionContext;
	// The upload service reports failures through its warn callback and returns
	// normally, so a completed call says nothing about whether the score landed.
	const sharingServerSvc = { uploadRollups: async () => ({ success: true, entriesUploaded: 1, message: 'Uploaded 1 entries' }), uploadFluencyScore: async () => false };
	const svc = new SyncService(
		makeDeps({
			context: mockContext,
			getGithubToken: () => 'fake-token',
		}),
		{} as any,
		{} as any,
		undefined,
		BackendUtility,
		sharingServerSvc as any,
	);
	await svc.uploadFluencyScoreToSharingServer({
		sharingServerEnabled: true,
		sharingServerEndpointUrl: 'https://test-sharing-server/',
	} as any, { overallStage: 'exploring' });
	assert.equal(
		globalState.get('backend.sharingServerFluencyLastSyncAt'),
		undefined,
		'A failed fluency-score upload must not report a successful sync'
	);
});

test('syncToSharingServer reports failure when the upload does not succeed', async () => {
	const dayKey = new Date().toISOString().slice(0, 10);
	// Rollups must actually exist: an upload that fails with data to send is the
	// case that matters, and it is invisible to the caller otherwise because the
	// upload service reports errors through warn and returns normally.
	const svc = new SyncService(
		makeDeps({
			getGithubToken: () => 'github-token',
			getCopilotSessionFiles: async () => ['/home/user/.copilot/session-state/s/events.jsonl'],
			statSessionFile: async () => ({ mtimeMs: Date.now(), size: 100 } as any),
			getSessionFileDataCached: async () => ({
				tokens: 300,
				mtime: Date.now(),
				interactions: 1,
				modelUsage: { 'gpt-4o': { inputTokens: 100, outputTokens: 200 } },
				dailyRollups: {
					[dayKey]: {
						tokens: 300,
						actualTokens: 300,
						thinkingTokens: 0,
						interactions: 1,
						modelUsage: { 'gpt-4o': { inputTokens: 100, outputTokens: 200 } },
					},
				},
			}),
		}),
		{} as any,
		{} as any,
		undefined,
		BackendUtility,
		{ uploadRollups: async () => ({ success: false, entriesUploaded: 0, message: 'Upload failed: fetch failed' }) } as any,
	);

	await assert.rejects(
		() => (svc as any).syncToSharingServer(
			{ lookbackDays: 7, datasetId: 'default', sharingServerEndpointUrl: 'https://sharing.example.com' },
			{ allowCloudSync: true, includeUserDimension: false, includeNames: false },
		),
		/fetch failed/,
		'syncToSharingServer must throw when entries existed but did not reach the server',
	);
});

test('syncToSharingServer reports failure when session files exist but none could be read', async () => {
	// An empty rollup map is ambiguous: it is also what a scan produces when every
	// discovered session file fails to stat/read/parse. Treating that as a
	// successful no-op would advance "Last Sync" while local data never left the
	// machine — the same false signal, one layer earlier.
	const svc = new SyncService(
		makeDeps({
			getGithubToken: () => 'github-token',
			getCopilotSessionFiles: async () => ['/home/user/.copilot/session-state/s/events.jsonl'],
			statSessionFile: async () => { throw new Error('EACCES: permission denied'); },
		}),
		{} as any,
		{} as any,
		undefined,
		BackendUtility,
		{ uploadRollups: async () => ({ success: true, entriesUploaded: 0, message: 'Uploaded' }) } as any,
	);

	await assert.rejects(
		() => (svc as any).syncToSharingServer(
			{ lookbackDays: 7, datasetId: 'default', sharingServerEndpointUrl: 'https://sharing.example.com' },
			{ allowCloudSync: true, includeUserDimension: false, includeNames: false },
		),
		/could not be read/,
		'Unreadable session files are a failed scan, not an empty one',
	);
});

test('syncToSharingServer reports failure when a JSONL session file has no parseable lines', async () => {
	// A .jsonl whose lines are all malformed produces no rollups and used to look
	// identical to a user with no data: the per-line catches in the JSONL fallback
	// were silent, so filesFailed stayed 0 and "Last Sync" advanced.
	const tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'jsonl-parse-test-'));
	const sessionFile = path.join(tmpDir, 'events.jsonl');
	fs.writeFileSync(sessionFile, 'this is not json\n{"broken": \n<html>nope</html>\n', 'utf8');
	try {
		const svc = new SyncService(
			makeDeps({
				getGithubToken: () => 'github-token',
				getCopilotSessionFiles: async () => [sessionFile],
				statSessionFile: async () => ({ mtimeMs: Date.now(), size: 100 } as any),
				getSessionFileDataCached: undefined,
			}),
			{} as any,
			{} as any,
			undefined,
			BackendUtility,
			{ uploadRollups: async () => ({ success: true, entriesUploaded: 0, message: 'Uploaded' }) } as any,
		);

		await assert.rejects(
			() => (svc as any).syncToSharingServer(
				{ lookbackDays: 7, datasetId: 'default', sharingServerEndpointUrl: 'https://sharing.example.com' },
				{ allowCloudSync: true, includeUserDimension: false, includeNames: false },
			),
			/could not be read/,
			'An unparseable session file is a failed scan, not an empty one',
		);
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test('syncToSharingServer reports failure when a JSONL session file holds only array records', async () => {
	// `typeof [] === 'object'` and `[]` is truthy, so a bare array line slipped past
	// the "is this an object" guard and read as a valid event carrying no usage.
	const tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'jsonl-array-test-'));
	const sessionFile = path.join(tmpDir, 'events.jsonl');
	fs.writeFileSync(sessionFile, '[]\n[1,2,3]\n[]\n', 'utf8');
	try {
		const svc = new SyncService(
			makeDeps({
				getGithubToken: () => 'github-token',
				getCopilotSessionFiles: async () => [sessionFile],
				statSessionFile: async () => ({ mtimeMs: Date.now(), size: 100 } as any),
				getSessionFileDataCached: undefined,
			}),
			{} as any,
			{} as any,
			undefined,
			BackendUtility,
			{ uploadRollups: async () => ({ success: true, entriesUploaded: 0, message: 'Uploaded' }) } as any,
		);

		await assert.rejects(
			() => (svc as any).syncToSharingServer(
				{ lookbackDays: 7, datasetId: 'default', sharingServerEndpointUrl: 'https://sharing.example.com' },
				{ allowCloudSync: true, includeUserDimension: false, includeNames: false },
			),
			/could not be read/,
			'Array-valued JSONL records are malformed, not empty events',
		);
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test('syncToSharingServer reports failure when legacy JSON requests are all malformed', async () => {
	// The legacy JSON fallback caught each request error and still returned success,
	// so a session whose every request is unusable produced no rollups and looked
	// like a user with genuinely no data.
	const tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'json-request-test-'));
	const sessionFile = path.join(tmpDir, 'session.json');
	fs.writeFileSync(sessionFile, JSON.stringify({ requests: [null, 'nope', 42] }), 'utf8');
	try {
		const svc = new SyncService(
			makeDeps({
				getGithubToken: () => 'github-token',
				getCopilotSessionFiles: async () => [sessionFile],
				statSessionFile: async () => ({ mtimeMs: Date.now(), size: 100 } as any),
				getSessionFileDataCached: undefined,
			}),
			{} as any,
			{} as any,
			undefined,
			BackendUtility,
			{ uploadRollups: async () => ({ success: true, entriesUploaded: 0, message: 'Uploaded' }) } as any,
		);

		await assert.rejects(
			() => (svc as any).syncToSharingServer(
				{ lookbackDays: 7, datasetId: 'default', sharingServerEndpointUrl: 'https://sharing.example.com' },
				{ allowCloudSync: true, includeUserDimension: false, includeNames: false },
			),
			/could not be read/,
			'Unusable request records are a failed scan, not an empty one',
		);
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test('syncToSharingServer reports failure when a legacy JSON session has no requests array', async () => {
	// A document without a `requests` array is one this fallback cannot extract any
	// usage from, but it used to fall back to `[]` and read as a clean empty file —
	// indistinguishable from a user with genuinely no data.
	const tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'json-norequests-test-'));
	const sessionFile = path.join(tmpDir, 'session.json');
	fs.writeFileSync(sessionFile, JSON.stringify({ version: 3, requesterUsername: 'someone' }), 'utf8');
	try {
		const svc = new SyncService(
			makeDeps({
				getGithubToken: () => 'github-token',
				getCopilotSessionFiles: async () => [sessionFile],
				statSessionFile: async () => ({ mtimeMs: Date.now(), size: 100 } as any),
				getSessionFileDataCached: undefined,
			}),
			{} as any,
			{} as any,
			undefined,
			BackendUtility,
			{ uploadRollups: async () => ({ success: true, entriesUploaded: 0, message: 'Uploaded' }) } as any,
		);

		await assert.rejects(
			() => (svc as any).syncToSharingServer(
				{ lookbackDays: 7, datasetId: 'default', sharingServerEndpointUrl: 'https://sharing.example.com' },
				{ allowCloudSync: true, includeUserDimension: false, includeNames: false },
			),
			/could not be read/,
			'A session file we cannot understand is a failed scan, not an empty one',
		);
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test('syncToSharingServer reports failure for a malformed file even when the cached path handles it', async () => {
	// The normal extension wiring always supplies getSessionFileDataCached, so a cache
	// hit returns before the failure-aware raw-content parser ever runs. The cached
	// JSONL/legacy parsers used to swallow unreadable lines and hand back an empty
	// map, which made a malformed session indistinguishable from a clean no-data scan
	// on the exact path production takes.
	const tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'cached-malformed-test-'));
	const sessionFile = path.join(tmpDir, 'events.jsonl');
	fs.writeFileSync(sessionFile, 'not json at all\n{"broken":\n', 'utf8');
	let cacheLookups = 0;
	try {
		const svc = new SyncService(
			makeDeps({
				getGithubToken: () => 'github-token',
				getCopilotSessionFiles: async () => [sessionFile],
				statSessionFile: async () => ({ mtimeMs: Date.now(), size: 100 } as any),
				// Valid cached data with no precomputed dailyRollups, which is what sends
				// processCachedSessionFile through the content-based interaction parsers.
				getSessionFileDataCached: async () => {
					cacheLookups++;
					return { tokens: 0, mtime: Date.now(), interactions: 0, modelUsage: {} };
				},
			}),
			{} as any,
			{} as any,
			undefined,
			BackendUtility,
			{ uploadRollups: async () => ({ success: true, entriesUploaded: 0, message: 'Uploaded' }) } as any,
		);

		await assert.rejects(
			() => (svc as any).syncToSharingServer(
				{ lookbackDays: 7, datasetId: 'default', sharingServerEndpointUrl: 'https://sharing.example.com' },
				{ allowCloudSync: true, includeUserDimension: false, includeNames: false },
			),
			/could not be read/,
			'A malformed session must count as a failed file on the cached path too',
		);
		assert.ok(cacheLookups > 0, 'Guard: the cached path must actually have been exercised');
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test('syncToSharingServer reports failure for malformed request records on the cached legacy-JSON path', async () => {
	// The cached legacy-JSON parser checked that `requests` was an array but not what
	// was inside it, so `[[], "bad"]` cast cleanly to ChatRequest, produced no usage
	// and returned a successful empty map — the raw-content parser rejects exactly
	// these records, so the two paths disagreed on the same file.
	const tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'cached-json-bad-test-'));
	const sessionFile = path.join(tmpDir, 'session.json');
	fs.writeFileSync(sessionFile, JSON.stringify({ requests: [[], 'bad'] }), 'utf8');
	let cacheLookups = 0;
	try {
		const svc = new SyncService(
			makeDeps({
				getGithubToken: () => 'github-token',
				getCopilotSessionFiles: async () => [sessionFile],
				statSessionFile: async () => ({ mtimeMs: Date.now(), size: 100 } as any),
				getSessionFileDataCached: async () => {
					cacheLookups++;
					return { tokens: 0, mtime: Date.now(), interactions: 0, modelUsage: {} };
				},
			}),
			{} as any,
			{} as any,
			undefined,
			BackendUtility,
			{ uploadRollups: async () => ({ success: true, entriesUploaded: 0, message: 'Uploaded' }) } as any,
		);

		await assert.rejects(
			() => (svc as any).syncToSharingServer(
				{ lookbackDays: 7, datasetId: 'default', sharingServerEndpointUrl: 'https://sharing.example.com' },
				{ allowCloudSync: true, includeUserDimension: false, includeNames: false },
			),
			/could not be read/,
			'Malformed request records must fail the scan on the cached path too',
		);
		assert.ok(cacheLookups > 0, 'Guard: the cached path must actually have been exercised');
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test('syncToSharingServer reports failure for malformed delta request entries on the cached path', async () => {
	// Delta-format sessions carry their requests inside an event payload, which was
	// iterated without validating the entries for the same reason.
	const tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'cached-delta-bad-test-'));
	const sessionFile = path.join(tmpDir, 'events.jsonl');
	fs.writeFileSync(
		sessionFile,
		JSON.stringify({ kind: 1, v: { requests: [] } }) + '\n' +
		JSON.stringify({ kind: 2, k: ['requests'], v: [[], 'bad'] }) + '\n',
		'utf8',
	);
	let cacheLookups = 0;
	try {
		const svc = new SyncService(
			makeDeps({
				getGithubToken: () => 'github-token',
				getCopilotSessionFiles: async () => [sessionFile],
				statSessionFile: async () => ({ mtimeMs: Date.now(), size: 100 } as any),
				getSessionFileDataCached: async () => {
					cacheLookups++;
					return { tokens: 0, mtime: Date.now(), interactions: 0, modelUsage: {} };
				},
			}),
			{} as any,
			{} as any,
			undefined,
			BackendUtility,
			{ uploadRollups: async () => ({ success: true, entriesUploaded: 0, message: 'Uploaded' }) } as any,
		);

		await assert.rejects(
			() => (svc as any).syncToSharingServer(
				{ lookbackDays: 7, datasetId: 'default', sharingServerEndpointUrl: 'https://sharing.example.com' },
				{ allowCloudSync: true, includeUserDimension: false, includeNames: false },
			),
			/could not be read/,
			'Malformed delta request entries must fail the scan',
		);
		assert.ok(cacheLookups > 0, 'Guard: the cached path must actually have been exercised');
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test('syncToSharingServer reports failure when a delta requests event carries a non-array payload', async () => {
	// `{"kind":2,"k":["requests"],"v":null}` targets the whole requests array but
	// carries a value neither parser can read. Both used to skip the event, so the
	// file produced an empty map on the cached path and no failure on the raw path:
	// filesFailed stayed 0 and the no-data branch could advance the marker.
	const tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'delta-nonarray-test-'));
	const sessionFile = path.join(tmpDir, 'events.jsonl');
	fs.writeFileSync(
		sessionFile,
		JSON.stringify({ kind: 1, v: { requests: [] } }) + '\n' +
		JSON.stringify({ kind: 2, k: ['requests'], v: null }) + '\n',
		'utf8',
	);
	let cacheLookups = 0;
	try {
		const svc = new SyncService(
			makeDeps({
				getGithubToken: () => 'github-token',
				getCopilotSessionFiles: async () => [sessionFile],
				statSessionFile: async () => ({ mtimeMs: Date.now(), size: 100 } as any),
				getSessionFileDataCached: async () => {
					cacheLookups++;
					return { tokens: 0, mtime: Date.now(), interactions: 0, modelUsage: {} };
				},
			}),
			{} as any,
			{} as any,
			undefined,
			BackendUtility,
			{ uploadRollups: async () => ({ success: true, entriesUploaded: 0, message: 'Uploaded' }) } as any,
		);

		await assert.rejects(
			() => (svc as any).syncToSharingServer(
				{ lookbackDays: 7, datasetId: 'default', sharingServerEndpointUrl: 'https://sharing.example.com' },
				{ allowCloudSync: true, includeUserDimension: false, includeNames: false },
			),
			/could not be read/,
			'A requests event with a non-array payload must fail the scan',
		);
		assert.ok(cacheLookups > 0, 'Guard: the cached path must actually have been exercised');
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test('syncToSharingServer does not treat a nested delta requests update as malformed', async () => {
	// Guard against over-correcting: `k: ['requests', 0, 'response']` legitimately
	// carries a non-array value, so only the whole-array path counts as unreadable.
	// Without this distinction, ordinary sessions would start failing their sync.
	const tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'delta-nested-test-'));
	const sessionFile = path.join(tmpDir, 'events.jsonl');
	fs.writeFileSync(
		sessionFile,
		JSON.stringify({ kind: 1, v: { requests: [] } }) + '\n' +
		JSON.stringify({ kind: 2, k: ['requests', 0, 'response'], v: 'some text' }) + '\n',
		'utf8',
	);
	try {
		const svc = new SyncService(
			makeDeps({
				getGithubToken: () => 'github-token',
				getCopilotSessionFiles: async () => [sessionFile],
				statSessionFile: async () => ({ mtimeMs: Date.now(), size: 100 } as any),
				getSessionFileDataCached: async () => ({ tokens: 0, mtime: Date.now(), interactions: 0, modelUsage: {} }),
			}),
			{} as any,
			{} as any,
			undefined,
			BackendUtility,
			{ uploadRollups: async () => ({ success: true, entriesUploaded: 0, message: 'Uploaded' }) } as any,
		);

		const result = await (svc as any).syncToSharingServer(
			{ lookbackDays: 7, datasetId: 'default', sharingServerEndpointUrl: 'https://sharing.example.com' },
			{ allowCloudSync: true, includeUserDimension: false, includeNames: false },
		);
		assert.equal(result, true, 'A nested requests update is readable and must not fail the scan');
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test('syncToSharingServer still treats a readable session with no billable activity as a successful sync', async () => {
	// The guard keys off parse failures, not the absence of rollups: a file that
	// reads cleanly and simply has no usage must not pin the user at "never".
	const tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'json-empty-test-'));
	const sessionFile = path.join(tmpDir, 'session.json');
	fs.writeFileSync(sessionFile, JSON.stringify({ requests: [] }), 'utf8');
	try {
		const svc = new SyncService(
			makeDeps({
				getGithubToken: () => 'github-token',
				getCopilotSessionFiles: async () => [sessionFile],
				statSessionFile: async () => ({ mtimeMs: Date.now(), size: 100 } as any),
				getSessionFileDataCached: undefined,
			}),
			{} as any,
			{} as any,
			undefined,
			BackendUtility,
			{ uploadRollups: async () => ({ success: true, entriesUploaded: 0, message: 'Uploaded' }) } as any,
		);

		const uploaded = await (svc as any).syncToSharingServer(
			{ lookbackDays: 7, datasetId: 'default', sharingServerEndpointUrl: 'https://sharing.example.com' },
			{ allowCloudSync: true, includeUserDimension: false, includeNames: false },
		);
		assert.equal(uploaded, true, 'A clean scan with no usage is a successful no-op');
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test('syncToSharingServer treats having nothing to upload as a successful sync', async () => {
	const svc = new SyncService(
		makeDeps({
			getGithubToken: () => 'github-token',
			getCopilotSessionFiles: async () => [],
		}),
		{} as any,
		{} as any,
		undefined,
		BackendUtility,
		{ uploadRollups: async () => ({ success: true, entriesUploaded: 0, message: 'Uploaded' }) } as any,
	);

	const uploaded = await (svc as any).syncToSharingServer(
		{ lookbackDays: 7, datasetId: 'default', sharingServerEndpointUrl: 'https://sharing.example.com' },
		{ allowCloudSync: true, includeUserDimension: false, includeNames: false },
	);
	assert.equal(uploaded, true, 'No local data is a no-op, not a failed sync');
});

test('syncToSharingServer reports failure when no GitHub token is available', async () => {
	const svc = new SyncService(
		makeDeps({ getGithubToken: () => undefined }),
		{} as any,
		{} as any,
		undefined,
		BackendUtility,
		{ uploadRollups: async () => ({ success: true, entriesUploaded: 1, message: 'Uploaded' }) } as any,
	);
	const uploaded = await (svc as any).syncToSharingServer(
		{
			sharingServerEnabled: true,
			sharingServerEndpointUrl: 'https://test-sharing-server/',
			lookbackDays: 7,
			datasetId: 'default',
		} as any,
		{ allowCloudSync: true, includeNames: false, includeUserDimension: false } as any,
	);
	assert.equal(uploaded, false, 'Skipping the upload for lack of a token is not a successful sync');
});

test('syncToBackendStore does NOT update the Team Server lastSync marker when a non-empty rollup upload fails', async () => {
	// End-to-end guard on the user-visible bug: driving the public sync path with
	// real rollup data and a failing upload must leave "Last Sync" untouched. The
	// unit tests above only cover syncToSharingServer's return value, so they
	// would still pass if the marker call site were made unconditional again.
	const dayKey = new Date().toISOString().slice(0, 10);
	const globalState = new Map<string, unknown>();
	const lockDir = fs.mkdtempSync(path.join(process.cwd(), 'sync-lock-fail-test-'));
	const mockContext = {
		globalState: {
			get: (key: string) => globalState.get(key),
			update: async (key: string, value: unknown) => { globalState.set(key, value); },
		},
		globalStorageUri: { fsPath: lockDir },
	} as unknown as vscode.ExtensionContext;
	let uploadAttempts = 0;
	const sharingServerSvc = {
		uploadRollups: async () => {
			uploadAttempts++;
			return { success: false, entriesUploaded: 0, message: 'Upload failed: fetch failed' };
		},
		uploadFluencyScore: async () => false,
	};
	const svc = new SyncService(
		makeDeps({
			context: mockContext,
			getGithubToken: () => 'fake-token',
			getCopilotSessionFiles: async () => ['/home/user/.copilot/session-state/s/events.jsonl'],
			statSessionFile: async () => ({ mtimeMs: Date.now(), size: 100 } as any),
			getSessionFileDataCached: async () => ({
				tokens: 300,
				mtime: Date.now(),
				interactions: 1,
				modelUsage: { 'gpt-4o': { inputTokens: 100, outputTokens: 200 } },
				dailyRollups: {
					[dayKey]: {
						tokens: 300,
						actualTokens: 300,
						thinkingTokens: 0,
						interactions: 1,
						modelUsage: { 'gpt-4o': { inputTokens: 100, outputTokens: 200 } },
					},
				},
			}),
		}),
		{
			getBackendDataPlaneCredentials: async () => ({
				tableCredential: {},
				blobCredential: {},
				secretsToRedact: [],
			}),
			getBackendSecretsToRedactForError: async () => [],
		} as any,
		{
			ensureTableExists: async () => {},
			validateAccess: async () => {},
			createTableClient: () => ({}),
			upsertEntitiesBatch: async () => ({ successCount: 0, errors: [] }),
		} as any,
		undefined,
		BackendUtility,
		sharingServerSvc as any,
	);
	try {
		await svc.syncToBackendStore(true, {
			enabled: true,
			backend: 'storageTables',
			sharingProfile: 'teamAnonymized',
			shareWorkspaceMachineNames: false,
			storageAccount: 'sa1',
			subscriptionId: 'sub1',
			resourceGroup: 'rg1',
			aggTable: 'usageAgg',
			eventsTable: 'usageEvents',
			lookbackDays: 7,
			sharingServerEnabled: true,
			sharingServerEndpointUrl: 'https://test-sharing-server/',
			shareWithTeam: false,
			userIdentityMode: 'pseudonymous',
			userId: '',
			userIdMode: 'alias',
			datasetId: 'default',
			shareConsentAt: '',
			includeMachineBreakdown: false,
			blobUploadEnabled: false,
			blobContainerName: '',
			blobUploadFrequencyHours: 24,
			blobCompressFiles: true,
			authMode: 'entraId',
		} as any, true);
		assert.ok(uploadAttempts > 0, 'The test must exercise a real upload attempt, not the no-data short circuit');
		assert.equal(
			globalState.get('backend.sharingServerRollupLastSyncAt'),
			undefined,
			'A failed rollup upload must leave "Last Sync" unset rather than reporting a healthy recent sync'
		);
	} finally {
		fs.rmSync(lockDir, { recursive: true, force: true });
	}
});

test('a successful fluency-score upload does not mask a failing rollup upload', async () => {
	// The two uploads shared one marker, so the score POST — which runs every couple
	// of minutes and is tiny — kept "Last Sync" green while rollup uploads had been
	// failing for hours. This is the exact scenario the split marker prevents.
	const globalState = new Map<string, unknown>();
	const mockContext = {
		globalState: {
			get: (key: string) => globalState.get(key),
			update: async (key: string, value: unknown) => { globalState.set(key, value); },
		},
	} as unknown as vscode.ExtensionContext;
	let rollupAttempts = 0;
	const sharingServerSvc = {
		uploadRollups: async () => {
			rollupAttempts++;
			return { success: false, entriesUploaded: 0, message: 'Upload failed: fetch failed' };
		},
		uploadFluencyScore: async () => true,
	};
	const svc = new SyncService(
		makeDeps({
			context: mockContext,
			getGithubToken: () => 'fake-token',
			getCopilotSessionFiles: async () => ['/home/user/.copilot/session-state/s/events.jsonl'],
			statSessionFile: async () => ({ mtimeMs: Date.now(), size: 100 } as any),
			getSessionFileDataCached: async () => ({
				tokens: 300,
				mtime: Date.now(),
				interactions: 1,
				modelUsage: { 'gpt-4o': { inputTokens: 100, outputTokens: 200 } },
				dailyRollups: {
					[new Date().toISOString().slice(0, 10)]: {
						tokens: 300,
						actualTokens: 300,
						thinkingTokens: 0,
						interactions: 1,
						modelUsage: { 'gpt-4o': { inputTokens: 100, outputTokens: 200 } },
					},
				},
			}),
		}),
		{} as any,
		{} as any,
		undefined,
		BackendUtility,
		sharingServerSvc as any,
	);
	const settings = {
		sharingServerEnabled: true,
		sharingServerEndpointUrl: 'https://test-sharing-server/',
	} as any;

	await svc.uploadFluencyScoreToSharingServer(settings, { overallStage: 'exploring' });
	await assert.rejects(
		() => (svc as any).syncToSharingServer(
			{ ...settings, lookbackDays: 7, datasetId: 'default' },
			{ allowCloudSync: true, includeUserDimension: false, includeNames: false },
		),
		'Guard: the rollup upload must have failed for this test to mean anything',
	);

	assert.ok(rollupAttempts > 0, 'Guard: a real rollup upload must have been attempted');
	assert.ok(
		globalState.get('backend.sharingServerFluencyLastSyncAt'),
		'The score upload succeeded, so its own marker should advance'
	);
	assert.equal(
		globalState.get('backend.sharingServerRollupLastSyncAt'),
		undefined,
		'The usage-sync marker must stay unset: no rollup data reached the server'
	);
});

// ── Sync lock management ─────────────────────────────────────────────────
test('acquireSyncLock succeeds when no context is provided', async () => {
	const svc = makeService({ context: undefined });
	// With no context, acquireSyncLock should return true (allow sync)
	const result = await (svc as any).acquireSyncLock();
	assert.equal(result, true);
});

test('acquireSyncLock creates lock file and releaseSyncLock removes it', async () => {
	const dir = fs.mkdtempSync(path.join(process.cwd(), 'lock-test-'));
	try {
		const mockContext = {
			globalStorageUri: { fsPath: dir },
		};
		const svc = makeService({ context: mockContext as any });

		const acquired = await (svc as any).acquireSyncLock();
		assert.equal(acquired, true);

		const lockPath = path.join(dir, 'backend_sync.lock');
		assert.ok(fs.existsSync(lockPath));

		await (svc as any).releaseSyncLock();
		assert.ok(!fs.existsSync(lockPath));
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('acquireSyncLock returns false when lock is held by another session', async () => {
	const dir = fs.mkdtempSync(path.join(process.cwd(), 'lock-test-'));
	try {
		const lockPath = path.join(dir, 'backend_sync.lock');
		// Write a lock file from a different session that is recent
		fs.writeFileSync(lockPath, JSON.stringify({
			sessionId: 'other-session',
			timestamp: Date.now()
		}));

		const mockContext = {
			globalStorageUri: { fsPath: dir },
		};
		const svc = makeService({ context: mockContext as any });

		const acquired = await (svc as any).acquireSyncLock();
		assert.equal(acquired, false);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('acquireSyncLock breaks stale lock', async () => {
	const dir = fs.mkdtempSync(path.join(process.cwd(), 'lock-test-'));
	try {
		const lockPath = path.join(dir, 'backend_sync.lock');
		// Write a lock file that is stale (older than SYNC_LOCK_STALE_MS)
		fs.writeFileSync(lockPath, JSON.stringify({
			sessionId: 'old-session',
			timestamp: Date.now() - (10 * 60 * 1000) // 10 minutes ago
		}));

		const mockContext = {
			globalStorageUri: { fsPath: dir },
		};
		const svc = makeService({ context: mockContext as any });

		const acquired = await (svc as any).acquireSyncLock();
		assert.equal(acquired, true);

		// Lock should be from our session now
		const content = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
		assert.equal(content.sessionId, vscode.env.sessionId);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('acquireSyncLock breaks corrupt (empty) lock file', async () => {
	const dir = fs.mkdtempSync(path.join(process.cwd(), 'lock-test-'));
	try {
		const lockPath = path.join(dir, 'backend_sync.lock');
		// A writer killed between atomic create and content write leaves a
		// 0-byte lock; unparseable content must be treated as stale or the
		// lock blocks every sync attempt forever.
		fs.writeFileSync(lockPath, '');

		const mockContext = {
			globalStorageUri: { fsPath: dir },
		};
		const svc = makeService({ context: mockContext as any });

		const acquired = await (svc as any).acquireSyncLock();
		assert.equal(acquired, true, 'empty lock must be treated as stale');

		const content = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
		assert.equal(content.sessionId, vscode.env.sessionId);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('acquireSyncLock returns false when same server URL is locked by another session', async () => {
	const dir = fs.mkdtempSync(path.join(process.cwd(), 'lock-test-'));
	try {
		const lockPath = path.join(dir, 'backend_sync.lock');
		fs.writeFileSync(lockPath, JSON.stringify({
			sessionId: 'other-session',
			timestamp: Date.now(),
			serverUrl: 'https://mystorage.table.core.windows.net',
		}));

		const mockContext = { globalStorageUri: { fsPath: dir } };
		const svc = makeService({ context: mockContext as any });

		const acquired = await (svc as any).acquireSyncLock(undefined, 'https://mystorage.table.core.windows.net');
		assert.equal(acquired, false, 'should be blocked when same server URL is locked');
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('acquireSyncLock returns true when lock is held for a different server URL', async () => {
	const dir = fs.mkdtempSync(path.join(process.cwd(), 'lock-test-'));
	try {
		const lockPath = path.join(dir, 'backend_sync.lock');
		// Simulate VS Code stable holding the lock for server A
		fs.writeFileSync(lockPath, JSON.stringify({
			sessionId: 'other-session',
			timestamp: Date.now(),
			serverUrl: 'https://server-a.table.core.windows.net',
		}));

		const mockContext = { globalStorageUri: { fsPath: dir } };
		const svc = makeService({ context: mockContext as any });

		// VS Code Insiders is configured for server B — should not be blocked
		const acquired = await (svc as any).acquireSyncLock(undefined, 'https://server-b.table.core.windows.net');
		assert.equal(acquired, true, 'should be allowed when lock is for a different server URL');
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('releaseSyncLock does nothing when no context', async () => {
	const svc = makeService({ context: undefined });
	// Should not throw
	await (svc as any).releaseSyncLock();
});

// -- Dual-backend sync (Azure + Sharing Server together) -------

test(`syncToBackendStore also syncs to sharing server when backend=storageTables and sharingServerEnabled=true`, async () => {
	const logs: string[] = [];
	const tmpFile = createTempFile(JSON.stringify({
		requests: [{
			timestamp: Date.now() - 60000,
			model: 'gpt-4o',
			type: 'conversational',
			result: { type: 'success' },
			response: [{ inputTokens: 10, outputTokens: 20 }]
		}]
	}));
	try {
		const deps = makeDeps({
			log: (m) => logs.push(m),
			getCopilotSessionFiles: async () => [tmpFile.filePath],
			getGithubToken: () => undefined,
		});
		const credSvc = {
			getBackendDataPlaneCredentials: async () => ({ tableCredential: {}, blobCredential: {} }),
			getBackendSecretsToRedactForError: async () => [],
		};
		const dataSvc = {
			ensureTableExists: async () => {},
			validateAccess: async () => {},
			createTableClient: () => ({}),
			upsertEntitiesBatch: async () => ({ successCount: 0, errors: [] }),
			deleteEntitiesForUserDataset: async () => ({ deletedCount: 0, errors: [] }),
		};
		const sharingServerSvc = { uploadRollups: async (_u: string, _t: string, entries: unknown[]) => ({ success: true, entriesUploaded: entries.length, message: 'ok' }), uploadFluencyScore: async () => true };
		const svc = new SyncService(deps, credSvc as any, dataSvc as any, undefined, BackendUtility, sharingServerSvc as any);
		await svc.syncToBackendStore(true, {
			enabled: true,
			backend: 'storageTables',
			sharingProfile: 'teamIdentified',
			shareWorkspaceMachineNames: false,
			storageAccount: 'sa1',
			subscriptionId: 'sub1',
			resourceGroup: 'rg1',
			aggTable: 'usageAgg',
			eventsTable: 'usageEvents',
			lookbackDays: 7,
			sharingServerEnabled: true,
			sharingServerEndpointUrl: 'https://test-sharing-server/',
			shareWithTeam: true,
			userIdentityMode: 'pseudonymous',
			userId: '',
			userIdMode: 'alias',
			datasetId: 'default',
			shareConsentAt: '',
			includeMachineBreakdown: false,
			blobUploadEnabled: false,
			blobContainerName: '',
			blobUploadFrequencyHours: 24,
			blobCompressFiles: true,
			authMode: 'entraId',
		} as any, true);
		assert.ok(
			logs.some(m => m.includes('Sharing server upload: skipping')),
			`Expected sharing server skip log. Got: ${logs.join('\n')}`
		);
	} finally {
		tmpFile.cleanup();
	}
});

test(`syncToBackendStore does NOT sync to sharing server when sharingServerEnabled=false`, async () => {
	const logs: string[] = [];
	const svc = makeServiceWithServices(
		{ log: (m) => logs.push(m) },
		{
			getBackendDataPlaneCredentials: async () => ({ tableCredential: {}, blobCredential: {} }),
			getBackendSecretsToRedactForError: async () => [],
		},
		{
			ensureTableExists: async () => {},
			validateAccess: async () => {},
			createTableClient: () => ({}),
			upsertEntitiesBatch: async () => ({ successCount: 0, errors: [] }),
			deleteEntitiesForUserDataset: async () => ({ deletedCount: 0, errors: [] }),
		}
	);
	await svc.syncToBackendStore(true, {
		enabled: true,
		backend: 'storageTables',
		sharingProfile: 'soloFull',
		shareWorkspaceMachineNames: false,
		storageAccount: 'sa1',
		subscriptionId: 'sub1',
		resourceGroup: 'rg1',
		aggTable: 'usageAgg',
		eventsTable: 'usageEvents',
		lookbackDays: 7,
		sharingServerEnabled: false,
		sharingServerEndpointUrl: '',
		authMode: 'entraId',
	} as any, true);
	assert.ok(
		!logs.some(m => m.includes('Sharing server')),
		`Expected no sharing server logs but got: ${logs.join('\n')}`
	);
});

// ── parseConsentTimestamp ─────────────────────────────────────────────────

test('parseConsentTimestamp returns Error for undefined', () => {
	const result = parseConsentTimestamp(undefined);
	assert.ok(result instanceof Error);
});

test('parseConsentTimestamp returns Error for null', () => {
	const result = parseConsentTimestamp(null);
	assert.ok(result instanceof Error);
});

test('parseConsentTimestamp returns Error for empty string', () => {
	const result = parseConsentTimestamp('');
	assert.ok(result instanceof Error);
});

test('parseConsentTimestamp returns Error for invalid date string', () => {
	const result = parseConsentTimestamp('not-a-date');
	assert.ok(result instanceof Error);
	assert.ok(result.message.includes('not a valid date'));
});

test('parseConsentTimestamp returns Error for future date', () => {
	const future = new Date(Date.now() + 86_400_000).toISOString();
	const result = parseConsentTimestamp(future);
	assert.ok(result instanceof Error);
	assert.ok(result.message.includes('future date'));
});

test('parseConsentTimestamp returns Date for valid past timestamp', () => {
	const past = new Date(Date.now() - 86_400_000).toISOString();
	const result = parseConsentTimestamp(past);
	assert.ok(result instanceof Date);
	assert.ok(!isNaN(result.getTime()));
});

test('parseConsentTimestamp coerces Date object to string before parsing', () => {
	// A Date object stringifies to a locale date string that new Date() can re-parse
	const pastDate = new Date(Date.now() - 86_400_000);
	const result = parseConsentTimestamp(pastDate);
	assert.ok(result instanceof Date);
});

test('parseConsentTimestamp returned Date matches input ISO string', () => {
	const isoString = '2023-01-15T10:30:00.000Z';
	const result = parseConsentTimestamp(isoString);
	assert.ok(result instanceof Date);
	assert.equal((result as Date).toISOString(), isoString);
});

// ── blob upload: editor type map integration ────────────────────────────

test('syncToBackendStore passes editor type map to blob upload service', async () => {
	const now = new Date();
	const timestamp = now.getTime() - 60000;
	const sessionContent = JSON.stringify({
		requests: [{
			timestamp,
			message: { parts: [{ text: 'hello world' }] },
			response: [{ value: 'response text' }]
		}]
	});
	const tmpFile = createTempFile(sessionContent);
	try {
		let capturedEditorMap: Map<string, string> | undefined;
		let uploadCalled = false;

		const mockBlobSvc = {
			shouldUpload: () => true,
			getUploadStatus: () => undefined,
			uploadSessionFiles: async (
				_account: string, _settings: any, _cred: any, _files: string[],
				_machineId: string, _datasetId: string, editorTypeByFile?: Map<string, string>
			) => {
				uploadCalled = true;
				capturedEditorMap = editorTypeByFile;
				return { success: true, filesUploaded: 1, message: 'ok' };
			},
		};

		const svc = makeServiceWithServices(
			{
				log: () => {},
				warn: () => {},
				getCopilotSessionFiles: async () => [tmpFile.filePath],
				estimateTokensFromText: (text: string) => text.length,
				getModelFromRequest: () => 'gpt-4o',
				statSessionFile: async () => ({ mtimeMs: Date.now(), size: 100 } as any),
				getEditorLabel: () => 'VS Code',
			},
			{
				getBackendDataPlaneCredentials: async () => ({
					tableCredential: { getToken: async () => ({ token: 'test', expiresOnTimestamp: Date.now() + 3600000 }) },
					blobCredential: {},
					secretsToRedact: [],
				}),
				getBackendSecretsToRedactForError: async () => [],
			},
			{
				ensureTableExists: async () => {},
				validateAccess: async () => {},
				createTableClient: () => ({
					async *listEntities() {},
					upsertEntity: async () => ({}),
					deleteEntity: async () => ({}),
				}),
				upsertEntitiesBatch: async () => ({ successCount: 1, errors: [] }),
			},
			mockBlobSvc
		);
		await svc.syncToBackendStore(true, {
			enabled: true,
			sharingProfile: 'soloFull',
			shareWorkspaceMachineNames: false,
			subscriptionId: 'sub1',
			resourceGroup: 'rg1',
			storageAccount: 'sa1',
			aggTable: 'usageAgg',
			datasetId: 'ds1',
			lookbackDays: 7,
			blobUploadEnabled: true,
			blobContainerName: 'copilot-session-logs',
			blobUploadFrequencyHours: 24,
			blobCompressFiles: true,
		} as any, true);

		assert.ok(uploadCalled, 'blob upload service was not called');
		assert.ok(capturedEditorMap, 'editorTypeByFile map was not passed');
		assert.equal(capturedEditorMap!.get(tmpFile.filePath), 'VS Code');
	} finally {
		tmpFile.cleanup();
	}
});

test('extractFluencyMetricsFromCache strips latency histograms from toolCallsJson/mcpToolsJson and keeps the payload bounded', () => {
	const svc = makeService();
	const histogram = { count: 3, sumMs: 120, buckets: new Array(23).fill(0) };
	// 400 distinct tools with histograms: ~10× a busy real day, each ~130 bytes serialized.
	const byTool: Record<string, number> = {};
	const completedByTool: Record<string, number> = {};
	const latencyByTool: Record<string, typeof histogram> = {};
	for (let i = 0; i < 400; i++) {
		byTool[`tool_${i}`] = 3;
		completedByTool[`tool_${i}`] = 3;
		latencyByTool[`tool_${i}`] = histogram;
	}
	const cached = { usageAnalysis: {
		toolCalls: { total: 1200, byTool, completedByTool, failuresByTool: { tool_1: 1 }, latencyByTool },
		mcpTools: { total: 3, byServer: { github: 3 }, byTool: { x: 3 }, completedByServer: { github: 3 }, failuresByServer: { github: 1 }, latencyByServer: { github: histogram } },
	} };
	const result = (svc as any).extractFluencyMetricsFromCache(cached, 1);
	const toolCalls = JSON.parse(result.toolCallsJson);
	const mcpTools = JSON.parse(result.mcpToolsJson);
	assert.equal(toolCalls.latencyByTool, undefined);
	assert.equal(mcpTools.latencyByServer, undefined);
	assert.deepEqual(toolCalls.failuresByTool, { tool_1: 1 });
	assert.equal(Object.keys(toolCalls.completedByTool).length, 400);
	assert.deepEqual(mcpTools.completedByServer, { github: 3 });
	assert.deepEqual(mcpTools.failuresByServer, { github: 1 });
	// Azure Table caps a string property at 64 KiB; the stripped payload stays well under it.
	assert.ok(result.toolCallsJson.length < 32 * 1024, `toolCallsJson is ${result.toolCallsJson.length} bytes`);
	// The original cache object is left intact for the local dashboard.
	assert.ok(cached.usageAnalysis.toolCalls.latencyByTool.tool_0);
});
