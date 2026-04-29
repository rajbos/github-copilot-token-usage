import './vscode-shim-register';
import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import * as vscode from 'vscode';

// We can test timer management and the syncQueue serialization.
// Most sync methods require heavy I/O mocking.
import { SyncService, type SyncServiceDeps } from '../../src/backend/services/syncService';
import { CredentialService } from '../../src/backend/services/credentialService';
import { DataPlaneService } from '../../src/backend/services/dataPlaneService';
import { BackendUtility } from '../../src/backend/services/utilityService';

function makeDeps(overrides?: Partial<SyncServiceDeps>): SyncServiceDeps {
	return {
		context: undefined,
		log: () => {},
		warn: () => {},
		getCopilotSessionFiles: async () => [],
		estimateTokensFromText: () => 0,
		getModelFromRequest: () => 'gpt-4o',
		statSessionFile: async () => ({ mtimeMs: Date.now(), size: 100 } as any),
		...overrides
	};
}

function makeService(depsOverrides?: Partial<SyncServiceDeps>): SyncService {
	const deps = makeDeps(depsOverrides);
	const credSvc = new CredentialService(undefined as any);
	const dataSvc = new DataPlaneService(BackendUtility, () => {}, async () => []);
	return new SyncService(deps, credSvc, dataSvc, undefined, BackendUtility, undefined);
}

/**
 * Create a SyncService with custom credential/data-plane/blob services for integration-level tests.
 */
function makeServiceWithServices(
	depsOverrides?: Partial<SyncServiceDeps>,
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
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-test-'));
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
				getStorageBlobEndpoint: () => 'https://sa1.blob.core.windows.net',
			}
		);
		await svc.syncToBackendStore(true, {
			enabled: true,
			sharingProfile: 'soloFull',
			shareWorkspaceMachineNames: false,
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
				getStorageBlobEndpoint: () => 'https://sa.blob.core.windows.net',
			}
		);
		await svc.syncToBackendStore(true, {
			enabled: true,
			sharingProfile: 'soloFull',
			shareWorkspaceMachineNames: false,
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
			getStorageBlobEndpoint: () => 'https://sa.blob.core.windows.net',
		}
	);
	await svc.syncToBackendStore(true, {
		enabled: true,
		sharingProfile: 'soloFull',
		shareWorkspaceMachineNames: false,
		storageAccount: 'sa1',
		aggTable: 'usageAgg',
		datasetId: 'ds1',
		lookbackDays: 7,
		blobUploadEnabled: false,
	} as any, true);
	assert.ok(warns.some(m => m.includes('network error')));
});

// ── Sync lock management ─────────────────────────────────────────────────

test('acquireSyncLock succeeds when no context is provided', async () => {
	const svc = makeService({ context: undefined });
	// With no context, acquireSyncLock should return true (allow sync)
	const result = await (svc as any).acquireSyncLock();
	assert.equal(result, true);
});

test('acquireSyncLock creates lock file and releaseSyncLock removes it', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-test-'));
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
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-test-'));
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
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-test-'));
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

test('releaseSyncLock does nothing when no context', async () => {
	const svc = makeService({ context: undefined });
	// Should not throw
	await (svc as any).releaseSyncLock();
});
