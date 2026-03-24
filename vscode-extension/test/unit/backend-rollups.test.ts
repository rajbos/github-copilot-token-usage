import test from 'node:test';
import * as assert from 'node:assert/strict';

import {
	dailyRollupMapKey,
	upsertDailyRollup,
	type DailyRollupKey
} from '../../src/backend/rollups';

// ── dailyRollupMapKey ────────────────────────────────────────────────────

test('dailyRollupMapKey produces stable key from dimensions', () => {
	const key: DailyRollupKey = {
		day: '2024-06-01',
		model: 'gpt-4o',
		workspaceId: 'ws1',
		machineId: 'm1',
		userId: 'user1'
	};
	const k1 = dailyRollupMapKey(key);
	const k2 = dailyRollupMapKey(key);
	assert.equal(k1, k2);
});

test('dailyRollupMapKey normalizes empty userId to undefined', () => {
	const key1 = dailyRollupMapKey({ day: '2024-06-01', model: 'gpt-4o', workspaceId: 'ws1', machineId: 'm1', userId: '' });
	const key2 = dailyRollupMapKey({ day: '2024-06-01', model: 'gpt-4o', workspaceId: 'ws1', machineId: 'm1', userId: '   ' });
	const key3 = dailyRollupMapKey({ day: '2024-06-01', model: 'gpt-4o', workspaceId: 'ws1', machineId: 'm1' });
	assert.equal(key1, key2);
	assert.equal(key1, key3);
});

test('dailyRollupMapKey differentiates by dimensions', () => {
	const k1 = dailyRollupMapKey({ day: '2024-06-01', model: 'gpt-4o', workspaceId: 'ws1', machineId: 'm1' });
	const k2 = dailyRollupMapKey({ day: '2024-06-02', model: 'gpt-4o', workspaceId: 'ws1', machineId: 'm1' });
	const k3 = dailyRollupMapKey({ day: '2024-06-01', model: 'claude', workspaceId: 'ws1', machineId: 'm1' });
	assert.notEqual(k1, k2);
	assert.notEqual(k1, k3);
});

// ── upsertDailyRollup ────────────────────────────────────────────────────

test('upsertDailyRollup inserts new entry when map is empty', () => {
	const map = new Map();
	const key: DailyRollupKey = { day: '2024-06-01', model: 'gpt-4o', workspaceId: 'ws1', machineId: 'm1' };
	upsertDailyRollup(map, key, { inputTokens: 100, outputTokens: 50, interactions: 2 });

	assert.equal(map.size, 1);
	const entry = [...map.values()][0];
	assert.equal(entry.value.inputTokens, 100);
	assert.equal(entry.value.outputTokens, 50);
	assert.equal(entry.value.interactions, 2);
});

test('upsertDailyRollup merges into existing entry', () => {
	const map = new Map();
	const key: DailyRollupKey = { day: '2024-06-01', model: 'gpt-4o', workspaceId: 'ws1', machineId: 'm1' };
	upsertDailyRollup(map, key, { inputTokens: 100, outputTokens: 50, interactions: 2 });
	upsertDailyRollup(map, key, { inputTokens: 200, outputTokens: 100, interactions: 3 });

	assert.equal(map.size, 1);
	const entry = [...map.values()][0];
	assert.equal(entry.value.inputTokens, 300);
	assert.equal(entry.value.outputTokens, 150);
	assert.equal(entry.value.interactions, 5);
});

test('upsertDailyRollup keeps separate entries for different keys', () => {
	const map = new Map();
	upsertDailyRollup(map, { day: '2024-06-01', model: 'gpt-4o', workspaceId: 'ws1', machineId: 'm1' },
		{ inputTokens: 100, outputTokens: 50, interactions: 1 });
	upsertDailyRollup(map, { day: '2024-06-01', model: 'claude', workspaceId: 'ws1', machineId: 'm1' },
		{ inputTokens: 200, outputTokens: 100, interactions: 2 });

	assert.equal(map.size, 2);
});

test('upsertDailyRollup merges fluency metrics numeric counts', () => {
	const map = new Map();
	const key: DailyRollupKey = { day: '2024-06-01', model: 'gpt-4o', workspaceId: 'ws1', machineId: 'm1' };

	upsertDailyRollup(map, key, {
		inputTokens: 100, outputTokens: 50, interactions: 1,
		fluencyMetrics: { askModeCount: 5, editModeCount: 3, sessionCount: 1 }
	});
	upsertDailyRollup(map, key, {
		inputTokens: 200, outputTokens: 100, interactions: 2,
		fluencyMetrics: { askModeCount: 10, agentModeCount: 2, sessionCount: 2 }
	});

	const entry = [...map.values()][0];
	assert.equal(entry.value.fluencyMetrics?.askModeCount, 15);
	assert.equal(entry.value.fluencyMetrics?.editModeCount, 3);
	assert.equal(entry.value.fluencyMetrics?.agentModeCount, 2);
	assert.equal(entry.value.fluencyMetrics?.sessionCount, 3);
});

test('upsertDailyRollup merges fluency JSON metrics by summing counts', () => {
	const map = new Map();
	const key: DailyRollupKey = { day: '2024-06-01', model: 'gpt-4o', workspaceId: 'ws1', machineId: 'm1' };

	upsertDailyRollup(map, key, {
		inputTokens: 100, outputTokens: 50, interactions: 1,
		fluencyMetrics: { toolCallsJson: '{"readFile":3,"writeFile":1}' }
	});
	upsertDailyRollup(map, key, {
		inputTokens: 100, outputTokens: 50, interactions: 1,
		fluencyMetrics: { toolCallsJson: '{"readFile":2,"grep":5}' }
	});

	const entry = [...map.values()][0];
	const toolCalls = JSON.parse(entry.value.fluencyMetrics!.toolCallsJson!);
	assert.equal(toolCalls.readFile, 5);
	assert.equal(toolCalls.writeFile, 1);
	assert.equal(toolCalls.grep, 5);
});

test('upsertDailyRollup merges repository JSON by deduplication', () => {
	const map = new Map();
	const key: DailyRollupKey = { day: '2024-06-01', model: 'gpt-4o', workspaceId: 'ws1', machineId: 'm1' };

	upsertDailyRollup(map, key, {
		inputTokens: 100, outputTokens: 50, interactions: 1,
		fluencyMetrics: { repositoriesJson: '{"repositories":["repo-a","repo-b"],"repositoriesWithCustomization":["repo-a"]}' }
	});
	upsertDailyRollup(map, key, {
		inputTokens: 100, outputTokens: 50, interactions: 1,
		fluencyMetrics: { repositoriesJson: '{"repositories":["repo-b","repo-c"],"repositoriesWithCustomization":["repo-c"]}' }
	});

	const entry = [...map.values()][0];
	const repos = JSON.parse(entry.value.fluencyMetrics!.repositoriesJson!);
	assert.deepEqual(repos.repositories.sort(), ['repo-a', 'repo-b', 'repo-c']);
	assert.deepEqual(repos.repositoriesWithCustomization.sort(), ['repo-a', 'repo-c']);
});

test('upsertDailyRollup creates fluency metrics on existing entry without them', () => {
	const map = new Map();
	const key: DailyRollupKey = { day: '2024-06-01', model: 'gpt-4o', workspaceId: 'ws1', machineId: 'm1' };

	upsertDailyRollup(map, key, { inputTokens: 100, outputTokens: 50, interactions: 1 });
	upsertDailyRollup(map, key, {
		inputTokens: 100, outputTokens: 50, interactions: 1,
		fluencyMetrics: { askModeCount: 5 }
	});

	const entry = [...map.values()][0];
	assert.equal(entry.value.fluencyMetrics?.askModeCount, 5);
});

test('upsertDailyRollup merges all JSON metric types', () => {
	const map = new Map();
	const key: DailyRollupKey = { day: '2024-06-01', model: 'gpt-4o', workspaceId: 'ws1', machineId: 'm1' };

	upsertDailyRollup(map, key, {
		inputTokens: 0, outputTokens: 0, interactions: 0,
		fluencyMetrics: {
			contextRefsJson: '{"file":2}',
			mcpToolsJson: '{"tool1":1}',
			modelSwitchingJson: '{"gpt-4o":1}',
			editScopeJson: '{"singleFile":3}',
			agentTypesJson: '{"code":2}',
			applyUsageJson: '{"applied":1}',
			sessionDurationJson: '{"short":2}',
			planModeCount: 1,
			customAgentModeCount: 3,
			multiTurnSessions: 2,
			multiFileEdits: 1
		}
	});
	upsertDailyRollup(map, key, {
		inputTokens: 0, outputTokens: 0, interactions: 0,
		fluencyMetrics: {
			contextRefsJson: '{"file":1,"folder":1}',
			mcpToolsJson: '{"tool1":2,"tool2":1}',
			modelSwitchingJson: '{"gpt-4o":2}',
			editScopeJson: '{"singleFile":1}',
			agentTypesJson: '{"code":1}',
			applyUsageJson: '{"applied":2}',
			sessionDurationJson: '{"short":1}',
			planModeCount: 2,
			customAgentModeCount: 1,
			multiTurnSessions: 3,
			multiFileEdits: 4
		}
	});

	const fm = [...map.values()][0].value.fluencyMetrics!;
	assert.equal(fm.planModeCount, 3);
	assert.equal(fm.customAgentModeCount, 4);
	assert.equal(fm.multiTurnSessions, 5);
	assert.equal(fm.multiFileEdits, 5);
	assert.equal(JSON.parse(fm.contextRefsJson!).file, 3);
	assert.equal(JSON.parse(fm.mcpToolsJson!).tool1, 3);
	assert.equal(JSON.parse(fm.modelSwitchingJson!)['gpt-4o'], 3);
	assert.equal(JSON.parse(fm.editScopeJson!).singleFile, 4);
	assert.equal(JSON.parse(fm.agentTypesJson!).code, 3);
	assert.equal(JSON.parse(fm.applyUsageJson!).applied, 3);
	assert.equal(JSON.parse(fm.sessionDurationJson!).short, 3);
});

test('upsertDailyRollup handles malformed JSON gracefully (falls back to incoming)', () => {
	const map = new Map();
	const key: DailyRollupKey = { day: '2024-06-01', model: 'gpt-4o', workspaceId: 'ws1', machineId: 'm1' };

	upsertDailyRollup(map, key, {
		inputTokens: 0, outputTokens: 0, interactions: 0,
		fluencyMetrics: { toolCallsJson: 'not-valid-json' }
	});
	upsertDailyRollup(map, key, {
		inputTokens: 0, outputTokens: 0, interactions: 0,
		fluencyMetrics: { toolCallsJson: '{"valid":1}' }
	});

	// Should not throw, and the valid incoming value should be present
	const fm = [...map.values()][0].value.fluencyMetrics!;
	assert.ok(fm.toolCallsJson);
});

test('upsertDailyRollup merges nested objects in JSON metrics', () => {
	const map = new Map();
	const key: DailyRollupKey = { day: '2024-06-01', model: 'gpt-4o', workspaceId: 'ws1', machineId: 'm1' };

	upsertDailyRollup(map, key, {
		inputTokens: 0, outputTokens: 0, interactions: 0,
		fluencyMetrics: { contextRefsJson: '{"details":{"a":1,"b":2}}' }
	});
	upsertDailyRollup(map, key, {
		inputTokens: 0, outputTokens: 0, interactions: 0,
		fluencyMetrics: { contextRefsJson: '{"details":{"a":3,"c":5},"topLevel":10}' }
	});

	const parsed = JSON.parse([...map.values()][0].value.fluencyMetrics!.contextRefsJson!);
	assert.equal(parsed.details.a, 4);
	assert.equal(parsed.details.b, 2);
	assert.equal(parsed.details.c, 5);
	assert.equal(parsed.topLevel, 10);
});
