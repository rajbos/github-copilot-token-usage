import test from 'node:test';
import * as assert from 'node:assert/strict';
import { createEmptyUsageAnalysisPayload, createEmptyUsageAnalysisStats, createUsageAnalysisPayload } from '../commands/payloads';
import { withUsageAnalysisViewStats } from '../usageAnalysisView';
import * as fs from 'fs';
import * as path from 'path';
import { createEmptyUsageAnalysisPeriod } from '../analysis';
import { USAGE_ANALYSIS_VIEW_KEYS } from '../../../src/usageAnalysisViewBuilder';
import type { UsageAnalysisStats } from '../../../src/types';

function stats(over: Partial<UsageAnalysisStats> = {}): UsageAnalysisStats {
	return {
		today: createEmptyUsageAnalysisPeriod(),
		last30Days: createEmptyUsageAnalysisPeriod(),
		month: createEmptyUsageAnalysisPeriod(),
		lastMonth: createEmptyUsageAnalysisPeriod(),
		lastUpdated: new Date('2026-10-01T00:00:00Z'),
		...over,
	};
}

test('usage-analysis payload passes the optional autonomyUsage field through unchanged', () => {
	const autonomyUsage = { autonomous: 3, supervised: 2, plan: 1, other: 0 };
	const s = stats();
	s.today.autonomyUsage = autonomyUsage;
	const payload = createUsageAnalysisPayload(s, new Date('2026-10-07T00:00:00Z'));
	assert.deepEqual(payload.today.autonomyUsage, autonomyUsage);
	assert.equal(payload.last30Days.autonomyUsage, undefined);
});

test('usage-analysis payload carries every field of the shared Usage Analysis view payload', () => {
	const payload = createUsageAnalysisPayload(stats(), new Date('2026-10-07T00:00:00Z')) as Record<string, unknown>;
	for (const key of USAGE_ANALYSIS_VIEW_KEYS) {
		assert.ok(key in payload, `missing ${key}`);
	}
	assert.equal(payload.lastUpdated, '2026-10-07T00:00:00.000Z');
	assert.equal(payload.backendConfigured, false);
	assert.equal(payload.readinessAvailable, false);
	assert.equal(payload.hideAutomaticToolCalls, true);
});

test('usage-analysis payload: customization and curation the CLI gathered reach the view', () => {
	const missedPotential = [{ workspaceName: 'alpha', workspacePath: '/a', sessionCount: 1, interactionCount: 1, nonCopilotFiles: [] }];
	const customizationMatrix = { customizationTypes: [], workspaces: [], totalWorkspaces: 0, workspacesWithIssues: 0 };
	const payload = createUsageAnalysisPayload(stats({ missedPotential, customizationMatrix }), new Date());
	assert.equal(payload.customizationMatrix, customizationMatrix);
	assert.equal(payload.missedPotential, missedPotential);
	// The shared insight evaluation ran over them, with no persisted state.
	const insight = payload.insights.find(i => i.id === 'missing-instructions');
	assert.equal(insight?.status, 'new');
	assert.ok(insight && !insight.title.startsWith('insight.'), 'insight text is translated');
});

test('usage-analysis payload keeps CLI-only stats fields such as recentSessions', () => {
	const recentSessions = { last7: [], last30: [], currentMonth: [] };
	const payload = createUsageAnalysisPayload(stats({ recentSessions }), new Date()) as Record<string, unknown>;
	assert.equal(payload.recentSessions, recentSessions);
});

test('the serialized empty usage-analysis payload carries empty recent-session buckets', () => {
	// Hosts without a loadRecentSessions handler (Visual Studio, JetBrains) rely on them.
	const serialized = JSON.parse(JSON.stringify(createEmptyUsageAnalysisPayload(new Date())));
	assert.deepEqual(serialized.recentSessions, { last7: [], last30: [], currentMonth: [] });
});

test('the empty (no sessions) usage-analysis payload comes from the same shared builder', () => {
	// usage-analysis --json and all --json return this when no session files exist; it used to be
	// a hand-written subset missing insights, curationAnalysis, settings and the arrays.
	const payload = createEmptyUsageAnalysisPayload(new Date('2026-10-07T00:00:00Z')) as Record<string, unknown>;
	for (const key of USAGE_ANALYSIS_VIEW_KEYS) {
		assert.ok(key in payload, `missing ${key}`);
	}
	assert.equal(payload.lastUpdated, '2026-10-07T00:00:00.000Z');
	assert.deepEqual(Object.keys(payload).sort(), Object.keys(createUsageAnalysisPayload(stats(), new Date('2026-10-07T00:00:00Z'))).sort());
});

test('no session files: the workspace\'s MCP servers still reach the usage-analysis curation analysis', async t => {
	// usage-analysis --json and all --json used to return before the shared view enrichment when
	// no session files existed, so curationAnalysis was null even with an mcp.json in the workspace.
	const workspace = fs.mkdtempSync(path.join(__dirname, 'curation-ws-'));
	t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
	fs.mkdirSync(path.join(workspace, '.vscode'), { recursive: true });
	fs.writeFileSync(path.join(workspace, '.vscode', 'mcp.json'), JSON.stringify({ servers: { 'fixture-server-2371': { command: 'node' } } }));
	const now = new Date('2026-10-07T00:00:00Z');
	const viewStats = await withUsageAnalysisViewStats([], createEmptyUsageAnalysisStats(now), { workspaceFolderPaths: [workspace] });
	assert.ok(viewStats.curationAnalysis, 'curation analysis is computed without session data');
	assert.ok(JSON.stringify(viewStats.curationAnalysis).includes('fixture-server-2371'), 'the workspace MCP server is listed');
	const payload = createUsageAnalysisPayload(viewStats, now) as Record<string, unknown>;
	for (const key of USAGE_ANALYSIS_VIEW_KEYS) { assert.ok(key in payload, `missing ${key}`); }
	assert.ok(payload.curationAnalysis);
});
