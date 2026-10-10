import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
	aggregateActualUsageStats,
	aggregateModeStats,
	aggregateTokenStats,
	buildSummaryStats,
	getEffortDisplayName,
	getTopEntries,
	type SummaryStatsSource,
	type SummaryStatsTurn,
} from '../../src/webview/logviewer/summaryStats';

const noRefs = () => ({
	file: 0, selection: 0, implicitSelection: 0, symbol: 0, codebase: 0, workspace: 0, terminal: 0, vscode: 0,
	terminalLastCommand: 0, terminalSelection: 0, clipboard: 0, changes: 0, outputPanel: 0, problemsPanel: 0,
	pullRequest: 0, byKind: {}, copilotInstructions: 0, agentsMd: 0, byPath: {},
});

function turn(overrides: Partial<SummaryStatsTurn> = {}): SummaryStatsTurn {
	return {
		mode: 'agent', toolCalls: [], mcpTools: [],
		inputTokensEstimate: 0, outputTokensEstimate: 0, thinkingTokensEstimate: 0,
		...overrides,
	};
}

function session(turns: SummaryStatsTurn[], overrides: Partial<SummaryStatsSource> = {}): SummaryStatsSource {
	return { turns, contextReferences: noRefs(), ...overrides };
}

describe('getTopEntries / getEffortDisplayName', () => {
	test('sorts descending and truncates to the limit', () => {
		assert.deepEqual(getTopEntries({ a: 1, b: 5, c: 3, d: 4 }, 2), [{ key: 'b', value: 5 }, { key: 'd', value: 4 }]);
	});
	test('handles undefined map', () => {
		assert.deepEqual(getTopEntries(undefined), []);
	});
	test('maps xhigh to a friendly name and passes others through', () => {
		assert.equal(getEffortDisplayName('xhigh'), 'Extra High');
		assert.equal(getEffortDisplayName('medium'), 'medium');
	});
});

describe('aggregateTokenStats', () => {
	test('empty session yields zeros and an em-dash effort label', () => {
		const s = aggregateTokenStats(session([]));
		assert.equal(s.totalTokens, 0);
		assert.equal(s.totalSubAgentCalls, 0);
		assert.equal(s.turnsWithThinking, 0);
		assert.equal(s.usageToolTotal, 0);
		assert.deepEqual(s.usageTopTools, []);
		assert.equal(s.usageContextTotal, 0);
		assert.equal(s.effortDefaultLabel, '—');
		assert.equal(s.effortSummary, '');
		assert.equal(s.sessionEffort, undefined);
	});

	test('sums input+output+thinking and counts thinking turns and sub-agents', () => {
		const s = aggregateTokenStats(session([
			turn({ inputTokensEstimate: 10, outputTokensEstimate: 5, thinkingTokensEstimate: 3, toolCalls: [{}, { isSubAgent: true }] }),
			turn({ inputTokensEstimate: 1, outputTokensEstimate: 1, mcpTools: [{}, {}] }),
		]));
		assert.equal(s.totalTokens, 20);
		assert.equal(s.totalThinkingTokens, 3);
		assert.equal(s.turnsWithThinking, 1);
		assert.equal(s.totalSubAgentCalls, 1);
		// Without usageAnalysis, tool total excludes sub-agents and MCP falls back to per-turn counts.
		assert.equal(s.usageToolTotal, 1);
		assert.equal(s.usageMcpTotal, 2);
		assert.deepEqual(s.usageTopTools, []);
	});

	test('prefers usageAnalysis totals, limits top lists to 3, and uses its context refs', () => {
		const refs = { ...noRefs(), file: 2, symbol: 1, copilotInstructions: 4 };
		const s = aggregateTokenStats(session([turn()], {
			contextReferences: { ...noRefs(), file: 99 },
			usageAnalysis: {
				toolCalls: { total: 12, byTool: { a: 1, b: 2, c: 3, d: 4 } },
				mcpTools: { total: 7, byServer: {}, byTool: { x: 7 } },
				contextReferences: refs,
			},
		}));
		assert.equal(s.usageToolTotal, 12);
		assert.deepEqual(s.usageTopTools.map(t => t.key), ['d', 'c', 'b']);
		assert.equal(s.usageMcpTotal, 7);
		assert.deepEqual(s.usageTopMcpTools, [{ key: 'x', value: 7 }]);
		assert.equal(s.usageContextTotal, 7);
		assert.equal(s.usageContextImplicit, 4);
		assert.equal(s.usageContextExplicit, 3);
	});

	test('derives effort labels from thinkingEffort, falling back to the first key', () => {
		const base = {
			toolCalls: { total: 0, byTool: {} }, mcpTools: { total: 0, byServer: {}, byTool: {} }, contextReferences: noRefs(),
		};
		const withDefault = aggregateTokenStats(session([], { usageAnalysis: { ...base, thinkingEffort: { byEffort: { xhigh: 2, low: 1 }, switchCount: 1, defaultEffort: 'low' } } }));
		assert.equal(withDefault.effortDefaultLabel, 'low');
		assert.equal(withDefault.effortSummary, 'Extra High: 2, low: 1');
		const noDefault = aggregateTokenStats(session([], { usageAnalysis: { ...base, thinkingEffort: { byEffort: { xhigh: 2 }, switchCount: 0, defaultEffort: null } } }));
		assert.equal(noDefault.effortDefaultLabel, 'Extra High');
	});
});

describe('aggregateActualUsageStats', () => {
	test('session with no actual usage at all', () => {
		const s = aggregateActualUsageStats(session([turn(), turn()]));
		assert.equal(s.hasAnyActualUsage, false);
		assert.equal(s.hasSessionActualOnly, false);
		assert.equal(s.actualTotal, 0);
		assert.deepEqual(s.turnsWithActual, []);
		assert.deepEqual(s.aggregatedBreakdown, {});
	});

	test('session-level actual tokens only (no per-turn usage)', () => {
		const s = aggregateActualUsageStats(session([turn()], { actualTokens: 500 }));
		assert.equal(s.hasAnyActualUsage, false);
		assert.equal(s.hasSessionActualOnly, true);
		assert.equal(s.sessionActualTokens, 500);
		assert.equal(s.actualTotal, 0);
	});

	test('per-turn usage suppresses the session-only flag and sums prompt/completion', () => {
		const s = aggregateActualUsageStats(session([
			turn({ actualUsage: { promptTokens: 100, completionTokens: 20 } }),
			turn(),
			turn({ actualUsage: { promptTokens: 50, completionTokens: 5 } }),
		], { actualTokens: 999 }));
		assert.equal(s.hasAnyActualUsage, true);
		assert.equal(s.hasSessionActualOnly, false);
		assert.equal(s.turnsWithActual.length, 2);
		assert.equal(s.actualPromptTotal, 150);
		assert.equal(s.actualCompletionTotal, 25);
		assert.equal(s.actualTotal, 175);
		assert.equal(s.sessionActualTokens, 999);
	});

	test('aggregates prompt-token breakdown by category|label with rounded token deduction', () => {
		const s = aggregateActualUsageStats(session([
			turn({ actualUsage: { promptTokens: 101, completionTokens: 0, promptTokenDetails: [{ category: 'system', label: 'Instructions', percentageOfPrompt: 50 }] } }),
			turn({ actualUsage: { promptTokens: 200, completionTokens: 0, promptTokenDetails: [
				{ category: 'system', label: 'Instructions', percentageOfPrompt: 25 },
				{ category: 'user', label: 'Files', percentageOfPrompt: 10 },
			] } }),
		]));
		assert.deepEqual(Object.keys(s.aggregatedBreakdown).sort(), ['system|Instructions', 'user|Files']);
		assert.deepEqual(s.aggregatedBreakdown['system|Instructions'], {
			category: 'system', label: 'Instructions', totalTokens: Math.round(50.5) + 50, totalPct: 75, count: 2,
		});
		assert.equal(s.aggregatedBreakdown['user|Files'].totalTokens, 20);
	});
});

describe('aggregateModeStats', () => {
	test('empty session has no entries and an em-dash primary mode', () => {
		const s = aggregateModeStats(session([]));
		assert.deepEqual(s.modeEntries, []);
		assert.equal(s.totalModeTurns, 0);
		assert.equal(s.primaryModeLabel, '—');
		assert.equal(s.modeSubLabel, '0 turns');
	});

	test('single turn uses the singular label', () => {
		const s = aggregateModeStats(session([turn({ mode: 'ask' })]));
		assert.equal(s.primaryModeLabel, '💬 Ask');
		assert.equal(s.modeSubLabel, '1 turn');
	});

	test('single mode across several turns is not "mixed"', () => {
		const s = aggregateModeStats(session([turn({ mode: 'plan' }), turn({ mode: 'plan' })]));
		assert.equal(s.primaryModeLabel, '📋 Plan');
		assert.equal(s.modeSubLabel, '2 turns');
	});

	test('mixed modes are sorted by count descending with the top one as primary', () => {
		const s = aggregateModeStats(session([
			turn({ mode: 'edit' }), turn({ mode: 'customAgent' }), turn({ mode: 'customAgent' }), turn({ mode: 'ask' }),
		]));
		assert.deepEqual(s.modeEntries[0], ['customAgent', 2]);
		assert.equal(s.modeEntries.length, 3);
		assert.equal(s.totalModeTurns, 4);
		assert.equal(s.primaryModeLabel, '⚡ Custom Agent');
		assert.equal(s.modeSubLabel, 'mixed across 4 turns');
	});
});

describe('buildSummaryStats', () => {
	test('maps every field of the three aggregates onto SummaryStats', () => {
		const data = session([
			turn({ mode: 'agent', inputTokensEstimate: 10, outputTokensEstimate: 5, thinkingTokensEstimate: 2, toolCalls: [{ isSubAgent: true }],
				actualUsage: { promptTokens: 30, completionTokens: 4 } }),
			turn({ mode: 'ask' }),
		], { actualTokens: 77 });
		const tokenStats = aggregateTokenStats(data);
		const actualStats = aggregateActualUsageStats(data);
		const modeStats = aggregateModeStats(data);
		const stats = buildSummaryStats(tokenStats, actualStats, modeStats);

		assert.equal(stats.totalTokens, 17);
		assert.equal(stats.totalThinkingTokens, 2);
		assert.equal(stats.totalSubAgentCalls, 1);
		assert.equal(stats.turnsWithThinking, 1);
		assert.equal(stats.hasAnyActualUsage, true);
		assert.equal(stats.hasSessionActualOnly, false);
		assert.equal(stats.actualTotal, 34);
		assert.equal(stats.actualPromptTotal, 30);
		assert.equal(stats.actualCompletionTotal, 4);
		assert.equal(stats.sessionActualTokens, 77);
		assert.equal(stats.totalModeTurns, 2);
		assert.equal(stats.modeSubLabel, 'mixed across 2 turns');
		assert.equal(stats.effortDefaultLabel, '—');
		assert.equal(stats.usageToolTotal, tokenStats.usageToolTotal);
		assert.deepEqual(stats.modeEntries, modeStats.modeEntries);
		// Only the declared SummaryStats fields are carried over, not the heavier aggregate payloads.
		assert.equal('aggregatedBreakdown' in stats, false);
		assert.equal('turnsWithActual' in stats, false);
	});

	test('empty / no-actual-usage session produces a fully zeroed stats object', () => {
		const data = session([]);
		const stats = buildSummaryStats(aggregateTokenStats(data), aggregateActualUsageStats(data), aggregateModeStats(data));
		assert.equal(stats.totalTokens, 0);
		assert.equal(stats.hasAnyActualUsage, false);
		assert.equal(stats.hasSessionActualOnly, false);
		assert.equal(stats.actualTotal, 0);
		assert.deepEqual(stats.modeEntries, []);
		assert.equal(stats.primaryModeLabel, '—');
		assert.equal(stats.sessionEffort, undefined);
	});
});
