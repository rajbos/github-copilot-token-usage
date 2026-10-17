import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';
import {
	buildCacheInfo,
	buildDiagnosticsViewData,
	buildSessionFolderData,
	diagnosticsToolCallStats,
	DIAGNOSTICS_VIEW_KEYS,
	skillDescriptionsFromStats,
	type DiagnosticsViewInputs,
} from '../diagnosticsViewBuilder';
import type { IEcosystemAdapter } from '../ecosystemAdapter';
import type { UsageAnalysisStats } from '../types';

const toolCalls = { total: 3, byTool: { a: 2, b: 1 } };
const stats = {
	last30Days: { toolCalls, skillCalls: { total: 1, byName: { s: 1 } } },
	curationAnalysis: { availableTools: [
		{ source: 'skill', name: 's', description: 'does s' },
		{ source: 'mcp', name: 'm', description: 'ignored' },
		{ source: 'skill', name: 'nodesc' },
	] },
} as unknown as UsageAnalysisStats;

const inputs = (over: Partial<DiagnosticsViewInputs> = {}): DiagnosticsViewInputs => ({
	report: 'r', sessionFiles: [], detailedSessionFiles: [], sessionFolders: [],
	cacheInfo: buildCacheInfo(0, 0, 'loc', null), backendStorageInfo: null, backendConfigured: false,
	isDebugMode: false,
	globalStateCounters: { openCount: 0, unknownMcpOpenCount: 0, fluencyBannerDismissed: false, unknownMcpDismissedVersion: '' },
	displaySettings: { showTokens: true, showCost: true, monthlyBudget: 0 },
	quotaEntitlements: null, accountBudgets: [], usageStats: null, skillCallsByEditor: null, toolFamilies: [],
	...over,
});

test('buildDiagnosticsViewData emits exactly the pinned keys', () => {
	assert.deepEqual(Object.keys(buildDiagnosticsViewData(inputs())).sort(), [...DIAGNOSTICS_VIEW_KEYS].sort());
});

test('without usage stats the tool, skill and description fields take their empty values', () => {
	const d = buildDiagnosticsViewData(inputs());
	assert.equal(d.toolCallStats, null);
	assert.equal(d.skillCallStats, null);
	assert.deepEqual(d.skillDescriptions, {});
	assert.deepEqual(d.accountBudgets, []);
});

test('tool and skill stats come from the last-30-days period', () => {
	const d = buildDiagnosticsViewData(inputs({ usageStats: stats }));
	assert.equal(d.toolCallStats, toolCalls);
	assert.deepEqual(d.skillCallStats, { total: 1, byName: { s: 1 } });
	assert.equal(diagnosticsToolCallStats(undefined), null);
});

test('skill descriptions: skills with a description only; host extras win', () => {
	assert.deepEqual(skillDescriptionsFromStats(stats), { s: 'does s' });
	const d = buildDiagnosticsViewData(inputs({ usageStats: stats, extraSkillDescriptions: { s: 'override', x: 'extra' } }));
	assert.deepEqual(d.skillDescriptions, { s: 'override', x: 'extra' });
});

test('buildCacheInfo reports lastUpdated only for a non-empty cache', () => {
	const now = new Date('2026-10-16T00:00:00.000Z');
	assert.deepEqual(buildCacheInfo(0, 0, 'l', null, now), { size: 0, sizeInMB: 0, lastUpdated: null, location: 'l', storagePath: null });
	assert.equal(buildCacheInfo(2, 1.5, 'l', '/p', now).lastUpdated, now.toISOString());
});

test('buildSessionFolderData groups by editor root and names the editor', () => {
	const eco = {
		handles: (f: string) => f.startsWith('/eco/'),
		getEditorRoot: () => '/eco',
		displayName: 'Eco',
	} as unknown as IEcosystemAdapter;
	const deps = { findEcosystem: (f: string) => (f.startsWith('/eco/') ? eco : null), homeDir: path.join('/home', 'u') };
	const sep = path.sep;
	const vscodeDir = ['', 'x', 'Code', 'User', 'workspaceStorage', 'w', 'chatSessions'].join(sep);
	const folders = buildSessionFolderData(['/eco/1', '/eco/2', `${vscodeDir}${sep}a.json`, `${vscodeDir}${sep}b.json`], deps);
	assert.equal(folders.length, 2);
	assert.deepEqual(folders.find(f => f.dir === '/eco'), { dir: '/eco', count: 2, editorName: 'Eco' });
	const code = folders.find(f => f.dir !== '/eco')!;
	assert.equal(code.count, 2);
	assert.equal(code.editorName, 'VS Code');
});

test('Copilot CLI session-state folders collapse into one row', () => {
	const home = path.join('/home', 'u');
	const state = path.join(home, '.copilot', 'session-state');
	const folders = buildSessionFolderData(
		[path.join(state, 'a', 'events.jsonl'), path.join(state, 'b', 'events.jsonl')],
		{ findEcosystem: () => null, homeDir: home },
	);
	assert.equal(folders.length, 1);
	assert.equal(folders[0].dir, state);
	assert.equal(folders[0].count, 2);
});
