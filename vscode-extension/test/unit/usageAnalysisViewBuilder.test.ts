import test from 'node:test';
import * as assert from 'node:assert/strict';

import {
	buildUsageAnalysisViewData,
	USAGE_ANALYSIS_VIEW_KEYS,
	type UsageAnalysisViewInputs,
} from '../../../src/usageAnalysisViewBuilder';
import { buildInsightContext } from '../../../src/insightsEngine';
import { buildWorkspaceCustomization, copilotCustomizationTypes } from '../../../src/customizationMatrix';
import { buildCurationAnalysis, mergeAvailableToolEntries } from '../../../src/toolCuration';
import type { AvailableToolEntry, CustomizationFileEntry, MissedPotentialWorkspace, UsageAnalysisStats } from '../../../src/types';
import type { WorkspaceGroup } from '../../../src/workspaceGrouping';
import { createTranslator } from '../../src/l10nCore';
import { emptyPeriod } from './fixtures/insightContexts';

const translate = createTranslator('en');

function stats(over: Partial<UsageAnalysisStats> = {}): UsageAnalysisStats {
	return {
		today: emptyPeriod(), last30Days: emptyPeriod(), month: emptyPeriod(), lastMonth: emptyPeriod(),
		lastUpdated: new Date('2026-10-11T08:00:00.000Z'),
		...over,
	};
}

const inputs = (over: Partial<UsageAnalysisViewInputs> = {}): UsageAnalysisViewInputs => ({
	locale: 'nl-NL', backendConfigured: false, readinessAvailable: false, currentWorkspacePaths: [],
	hideAutomaticToolCalls: true, use24HourTime: false, suppressedUnknownTools: [],
	insights: { translate },
	...over,
});

const missed: MissedPotentialWorkspace[] = [
	{ workspaceName: 'alpha', workspacePath: '/a', sessionCount: 5, interactionCount: 5, nonCopilotFiles: [] },
];

// ── Payload shape ─────────────────────────────────────────────────────────

test('buildUsageAnalysisViewData emits exactly the pinned keys', () => {
	const data = buildUsageAnalysisViewData(stats(), inputs());
	assert.deepEqual(Object.keys(data).sort(), [...USAGE_ANALYSIS_VIEW_KEYS].sort());
});

test('buildUsageAnalysisViewData: absent stats fields become the empty values the view expects', () => {
	const data = buildUsageAnalysisViewData(stats(), inputs());
	assert.equal(data.customizationMatrix, null);
	assert.deepEqual(data.missedPotential, []);
	assert.deepEqual(data.toolCallsByEditor, {});
	assert.deepEqual(data.todaySessions, []);
	assert.equal(data.claudeDesktopCoverage, null);
	assert.equal(data.correctionReport, null);
	assert.equal(data.repeatedTasks, null);
	assert.equal(data.curationAnalysis, null);
	assert.equal(data.memoryFilesAnalysis, null);
	assert.equal(data.lastUpdated, '2026-10-11T08:00:00.000Z');
});

test('buildUsageAnalysisViewData passes host settings through unchanged', () => {
	const data = buildUsageAnalysisViewData(stats(), inputs({
		locale: 'de-DE', backendConfigured: true, readinessAvailable: true, currentWorkspacePaths: ['/ws'],
		hideAutomaticToolCalls: false, use24HourTime: true, suppressedUnknownTools: ['foo'],
	}));
	assert.equal(data.locale, 'de-DE');
	assert.equal(data.backendConfigured, true);
	assert.equal(data.readinessAvailable, true);
	assert.deepEqual(data.currentWorkspacePaths, ['/ws']);
	assert.equal(data.hideAutomaticToolCalls, false);
	assert.equal(data.use24HourTime, true);
	assert.deepEqual(data.suppressedUnknownTools, ['foo']);
});

test('buildUsageAnalysisViewData evaluates insights from the stats; a stateless host sees them as new', () => {
	const s = stats({ missedPotential: missed });
	s.last30Days.sessions = 20;
	const data = buildUsageAnalysisViewData(s, inputs());
	const insight = data.insights.find(i => i.id === 'missing-instructions');
	assert.ok(insight, 'missing-instructions should fire for a workspace with missed potential');
	assert.equal(insight.status, 'new');
	assert.ok(!insight.title.startsWith('insight.'), 'titles are translated, not raw keys');
});

test('buildUsageAnalysisViewData honours the host\'s persisted insight state', () => {
	const s = stats({ missedPotential: missed });
	s.last30Days.sessions = 20;
	const at = '2026-10-01T00:00:00.000Z';
	const data = buildUsageAnalysisViewData(s, inputs({
		insights: { translate, stateBag: { 'missing-instructions': { status: 'dismissed', firstSurfacedAt: at, lastSurfacedAt: at } } },
	}));
	assert.equal(data.insights.some(i => i.id === 'missing-instructions'), false);
});

test('buildInsightContext carries every stats field the insight catalog reads', () => {
	const curationAnalysis = buildCurationAnalysis({ skills: [{ name: 'pdf', source: 'skill', description: 'skill' }] }, emptyPeriod(), 30);
	const s = stats({ missedPotential: missed, todaySessions: [], curationAnalysis });
	const ctx = buildInsightContext(s, translate);
	assert.equal(ctx.translate, translate);
	assert.equal(ctx.missedPotential, missed);
	assert.deepEqual(ctx.todaySessions, []);
	assert.equal(ctx.curationAnalysis, curationAnalysis);
	assert.equal(ctx.repeatedTasks, null);
	assert.equal(ctx.memoryFilesAnalysis, null);
	assert.equal(ctx.month, s.month);
	assert.equal(ctx.lastMonth, s.lastMonth);
});

// ── Customization matrix ──────────────────────────────────────────────────

function file(type: string, over: Partial<CustomizationFileEntry> = {}): CustomizationFileEntry {
	return { path: `/x/${type}`, relativePath: type, type, icon: '', label: type, name: type, lastModified: null, isStale: false, category: 'copilot', ...over };
}

const types = [{ id: 'instructions', icon: '📋', label: 'Instructions' }, { id: 'agent', icon: '🤖', label: 'Agents' }];

test('buildWorkspaceCustomization: one status per type, issues, busiest workspace first', () => {
	const files: Record<string, CustomizationFileEntry[]> = {
		'/repo/full': [file('instructions'), file('agent', { isStale: true })],
		'/repo/none': [],
	};
	const { customizationMatrix } = buildWorkspaceCustomization({
		customizationTypes: types,
		workspaces: [
			{ path: '/repo/none', sessionCount: 1, interactionCount: 2 },
			{ path: '/repo/full', sessionCount: 3, interactionCount: 9 },
		],
		filesFor: p => files[p],
		unresolvedWorkspaces: new Map([['0123456789abcdef', 4]]),
	});
	assert.deepEqual(customizationMatrix.workspaces.map(r => r.workspaceName), ['full', 'Unresolved (01234567...)', 'none']);
	assert.deepEqual(customizationMatrix.workspaces[0].typeStatuses, { instructions: '✅', agent: '⚠️' });
	assert.deepEqual(customizationMatrix.workspaces[1], {
		workspacePath: '<unresolved:0123456789abcdef>', workspaceName: 'Unresolved (01234567...)',
		sessionCount: 0, interactionCount: 4, typeStatuses: { instructions: '❌', agent: '❌' },
	});
	assert.equal(customizationMatrix.totalWorkspaces, 3);
	assert.equal(customizationMatrix.workspacesWithIssues, 2);
	assert.equal(customizationMatrix.ungroupedWorkspaceNames, undefined);
});

test('buildWorkspaceCustomization: a grouped workspace uses the group name and lists its member folders', () => {
	const group: WorkspaceGroup = {
		canonicalPath: '/src/app', displayName: 'owner/app', memberPaths: ['/src/app', '/src/app-wt'], sessionCount: 2, interactionCount: 5,
	};
	const { customizationMatrix } = buildWorkspaceCustomization({
		customizationTypes: types,
		workspaces: [{ path: '/src/app', sessionCount: 2, interactionCount: 5, group }],
		filesFor: () => [file('instructions')],
	});
	assert.equal(customizationMatrix.workspaces[0].workspaceName, 'owner/app');
	assert.deepEqual(customizationMatrix.workspaces[0].memberPaths, ['/src/app', '/src/app-wt']);
});

test('buildWorkspaceCustomization: missed potential is non-Copilot files without Copilot ones, most active first', () => {
	const cursor = file('non-copilot-instructions', { category: 'non-copilot' });
	const files: Record<string, CustomizationFileEntry[]> = {
		'/quiet': [cursor],
		'/busy': [cursor],
		'/mixed': [cursor, file('instructions')],
		'/legacy': [cursor, file('instructions', { category: undefined })],
	};
	const { missedPotential } = buildWorkspaceCustomization({
		customizationTypes: types,
		workspaces: ['/quiet', '/busy', '/mixed', '/legacy'].map((p, i) => ({ path: p, sessionCount: 1, interactionCount: p === '/busy' ? 10 : i })),
		filesFor: p => files[p],
	});
	assert.deepEqual(missedPotential.map(m => m.workspacePath), ['/busy', '/quiet']);
	assert.deepEqual(missedPotential[0].nonCopilotFiles, [cursor]);
});

test('copilotCustomizationTypes: one column per Copilot type in customizationPatterns.json', () => {
	const ids = copilotCustomizationTypes().map(t => t.id);
	assert.equal(new Set(ids).size, ids.length);
	assert.ok(ids.includes('instructions'));
	assert.ok(!ids.some(id => id.startsWith('non-copilot')));
});

// ── Tool curation ─────────────────────────────────────────────────────────

const mcp = (server: string, from: string): AvailableToolEntry => ({ name: `mcp__${server}`, source: 'mcp', server, description: from });

test('mergeAvailableToolEntries lists each MCP server once, from the most authoritative source', () => {
	const merged = mergeAvailableToolEntries({
		runtime: [mcp('github', 'runtime')],
		mcpJson: [mcp('github', 'json'), mcp('files', 'json')],
		extensionMcp: [mcp('files', 'ext'), mcp('db', 'ext')],
		settingsMcp: [mcp('db', 'settings'), mcp('web', 'settings')],
		skills: [{ name: 'pdf', source: 'skill', description: 'skill' }],
	});
	assert.deepEqual(merged.map(e => `${e.name}:${e.description}`), [
		'mcp__github:runtime', 'mcp__files:json', 'mcp__db:ext', 'mcp__web:settings', 'pdf:skill',
	]);
});

test('buildCurationAnalysis is null when a host found no tools', () => {
	assert.equal(buildCurationAnalysis({}, emptyPeriod(), 30), null);
	const analysis = buildCurationAnalysis({ mcpJson: [mcp('files', 'json')] }, emptyPeriod(), 14);
	assert.equal(analysis?.windowDays, 14);
	assert.equal(analysis?.availableTools.length, 1);
});

test('mergeAvailableToolEntries lists a server once even when one source repeats it', () => {
	// enumerateExtensionMcpServers() emits a server once per extension that contributes it;
	// claiming per source kept every copy and inflated the available / unused tool counts.
	const merged = mergeAvailableToolEntries({
		extensionMcp: [mcp('db', 'ext-a'), mcp('db', 'ext-b'), mcp('files', 'ext-a')],
		settingsMcp: [mcp('db', 'settings')],
	});
	assert.deepEqual(merged.map(e => `${e.name}:${e.description}`), ['mcp__db:ext-a', 'mcp__files:ext-a']);
});

test('buildUsageAnalysisViewData carries the recent-session buckets for every host', () => {
	// The desktop app calls the builder directly and has no recentSessionsLoaded round-trip, so
	// without the buckets its Last 7 / 30 days and Current Month tabs stayed on "Loading…".
	const recentSessions = { last7: [], last30: [], currentMonth: [] };
	assert.deepEqual(buildUsageAnalysisViewData(stats({ recentSessions }), inputs()).recentSessions, recentSessions);
	assert.equal(buildUsageAnalysisViewData(stats(), inputs()).recentSessions, undefined, 'absent when the host has none');
});
