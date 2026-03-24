import './vscode-shim-register';
import test from 'node:test';
import * as assert from 'node:assert/strict';

import {
	sanitizeTableKey,
	buildAggPartitionKey,
	stableDailyRollupRowKey,
	buildOdataEqFilter,
	listAggDailyEntitiesFromTableClient,
	createDailyAggEntity,
	type TableClientLike,
} from '../../src/backend/storageTables';

// ── sanitizeTableKey ─────────────────────────────────────────────────────

test('sanitizeTableKey returns falsy value unchanged', () => {
	assert.equal(sanitizeTableKey(''), '');
});

test('sanitizeTableKey replaces forbidden characters', () => {
	assert.equal(sanitizeTableKey('a/b\\c#d?e'), 'a_b_c_d_e');
});

test('sanitizeTableKey replaces control characters', () => {
	assert.equal(sanitizeTableKey('abc\x00def\x1Fghi'), 'abc_def_ghi');
});

test('sanitizeTableKey leaves clean strings unchanged', () => {
	assert.equal(sanitizeTableKey('hello-world_123'), 'hello-world_123');
});

// ── buildAggPartitionKey ─────────────────────────────────────────────────

test('buildAggPartitionKey builds and sanitizes key', () => {
	const key = buildAggPartitionKey('myds', '2024-06-15');
	assert.equal(key, 'ds:myds|d:2024-06-15');
});

test('buildAggPartitionKey sanitizes forbidden chars in datasetId', () => {
	const key = buildAggPartitionKey('my/ds', '2024-06-15');
	assert.equal(key, 'ds:my_ds|d:2024-06-15');
});

// ── stableDailyRollupRowKey ──────────────────────────────────────────────

test('stableDailyRollupRowKey without userId', () => {
	const rk = stableDailyRollupRowKey({
		day: '2024-06-15',
		model: 'gpt-4o',
		workspaceId: 'ws1',
		machineId: 'm1',
	});
	assert.equal(rk, 'm:gpt-4o|w:ws1|mc:m1');
});

test('stableDailyRollupRowKey with userId', () => {
	const rk = stableDailyRollupRowKey({
		day: '2024-06-15',
		model: 'gpt-4o',
		workspaceId: 'ws1',
		machineId: 'm1',
		userId: 'alice',
	});
	assert.equal(rk, 'm:gpt-4o|w:ws1|mc:m1|u:alice');
});

test('stableDailyRollupRowKey trims whitespace-only userId', () => {
	const rk = stableDailyRollupRowKey({
		day: '2024-06-15',
		model: 'gpt-4o',
		workspaceId: 'ws1',
		machineId: 'm1',
		userId: '  ',
	});
	// Whitespace-only userId should be treated as no userId
	assert.ok(!rk.includes('u:'));
});

// ── buildOdataEqFilter ───────────────────────────────────────────────────

test('buildOdataEqFilter builds valid filter for allowed fields', () => {
	assert.equal(buildOdataEqFilter('PartitionKey', 'pk1'), "PartitionKey eq 'pk1'");
	assert.equal(buildOdataEqFilter('model', 'gpt-4o'), "model eq 'gpt-4o'");
	assert.equal(buildOdataEqFilter('userId', 'alice'), "userId eq 'alice'");
});

test('buildOdataEqFilter escapes single quotes in value', () => {
	assert.equal(buildOdataEqFilter('model', "o'reilly"), "model eq 'o''reilly'");
});

test('buildOdataEqFilter rejects disallowed fields', () => {
	assert.throws(() => buildOdataEqFilter('evil', 'val'), /Invalid filter field/);
});

// ── listAggDailyEntitiesFromTableClient ──────────────────────────────────

test('listAggDailyEntitiesFromTableClient returns normalized entities', async () => {
	const mockClient: TableClientLike = {
		async *listEntities() {
			yield {
				partitionKey: 'pk1', rowKey: 'rk1',
				model: 'gpt-4o', workspaceId: 'ws1', machineId: 'm1',
				inputTokens: 100, outputTokens: 200, interactions: 5,
				schemaVersion: 2, datasetId: 'ds1',
				workspaceName: '  My Workspace  ',
				machineName: '',
				userId: ' alice ',
				userKeyType: 'alias',
				shareWithTeam: true,
				consentAt: '2024-01-01',
				updatedAt: '2024-06-15T00:00:00Z',
			};
		},
		upsertEntity: async () => ({}),
		deleteEntity: async () => ({}),
	};

	const results = await listAggDailyEntitiesFromTableClient({
		tableClient: mockClient,
		partitionKey: 'pk1',
		defaultDayKey: '2024-06-15',
	});

	assert.equal(results.length, 1);
	const e = results[0];
	assert.equal(e.model, 'gpt-4o');
	assert.equal(e.workspaceName, 'My Workspace');
	assert.equal(e.machineName, undefined);
	assert.equal(e.userId, 'alice');
	assert.equal(e.userKeyType, 'alias');
	assert.equal(e.shareWithTeam, true);
	assert.equal(e.consentAt, '2024-01-01');
	assert.equal(e.schemaVersion, 2);
});

test('listAggDailyEntitiesFromTableClient skips entities missing required fields', async () => {
	const errors: string[] = [];
	const mockClient: TableClientLike = {
		async *listEntities() {
			yield { partitionKey: 'pk', rowKey: 'rk1', model: 'gpt-4o', workspaceId: 'ws1' };
			yield { partitionKey: 'pk', rowKey: 'rk2', model: 'gpt-4o', workspaceId: 'ws1', machineId: 'm1', inputTokens: 10, outputTokens: 20, interactions: 1 };
		},
		upsertEntity: async () => ({}),
		deleteEntity: async () => ({}),
	};

	const results = await listAggDailyEntitiesFromTableClient({
		tableClient: mockClient,
		partitionKey: 'pk',
		defaultDayKey: '2024-06-15',
		logger: { error: (msg: string) => errors.push(msg) },
	});

	assert.equal(results.length, 1);
	assert.equal(results[0].rowKey, 'rk2');
	assert.ok(errors.some(e => e.includes('rk1')));
});

test('listAggDailyEntitiesFromTableClient uses defaults for missing optional fields', async () => {
	const mockClient: TableClientLike = {
		async *listEntities() {
			yield {
				partitionKey: undefined, rowKey: undefined,
				model: 'gpt-4o', workspaceId: 'ws1', machineId: 'm1',
				inputTokens: 'not-a-number', outputTokens: -5, interactions: undefined,
				schemaVersion: 'not-a-number',
			};
		},
		upsertEntity: async () => ({}),
		deleteEntity: async () => ({}),
	};

	const results = await listAggDailyEntitiesFromTableClient({
		tableClient: mockClient,
		partitionKey: 'pk',
		defaultDayKey: '2024-06-15',
	});

	assert.equal(results.length, 1);
	const e = results[0];
	assert.equal(e.partitionKey, 'pk');
	assert.equal(e.rowKey, '');
	assert.equal(e.inputTokens, 0);
	assert.equal(e.outputTokens, 0);
	assert.equal(e.interactions, 0);
	assert.equal(e.schemaVersion, undefined);
	assert.equal(e.day, '2024-06-15');
});

test('listAggDailyEntitiesFromTableClient includes fluency metrics when present', async () => {
	const mockClient: TableClientLike = {
		async *listEntities() {
			yield {
				model: 'gpt-4o', workspaceId: 'ws1', machineId: 'm1',
				inputTokens: 10, outputTokens: 20, interactions: 1,
				askModeCount: 3, editModeCount: 2, agentModeCount: 1,
				planModeCount: 0, customAgentModeCount: 5,
				toolCallsJson: '{"total":10}',
				contextRefsJson: '{"file":2}',
				mcpToolsJson: '{"total":1}',
				modelSwitchingJson: '{"switches":3}',
				editScopeJson: '{"multi":1}',
				agentTypesJson: '{"workspace":2}',
				repositoriesJson: '["repo1"]',
				applyUsageJson: '{"rate":0.5}',
				sessionDurationJson: '{"avg":300}',
				repoCustomizationRate: 0.75,
				multiTurnSessions: 4,
				avgTurnsPerSession: 3.5,
				multiFileEdits: 2,
				avgFilesPerEdit: 1.5,
				codeBlockApplyRate: 0.8,
				sessionCount: 10,
			};
		},
		upsertEntity: async () => ({}),
		deleteEntity: async () => ({}),
	};

	const results = await listAggDailyEntitiesFromTableClient({
		tableClient: mockClient,
		partitionKey: 'pk',
		defaultDayKey: '2024-06-15',
	});

	const e = results[0];
	assert.equal(e.askModeCount, 3);
	assert.equal(e.editModeCount, 2);
	assert.equal(e.agentModeCount, 1);
	assert.equal(e.planModeCount, 0);
	assert.equal(e.customAgentModeCount, 5);
	assert.equal(e.toolCallsJson, '{"total":10}');
	assert.equal(e.contextRefsJson, '{"file":2}');
	assert.equal(e.mcpToolsJson, '{"total":1}');
	assert.equal(e.modelSwitchingJson, '{"switches":3}');
	assert.equal(e.editScopeJson, '{"multi":1}');
	assert.equal(e.agentTypesJson, '{"workspace":2}');
	assert.equal(e.repositoriesJson, '["repo1"]');
	assert.equal(e.applyUsageJson, '{"rate":0.5}');
	assert.equal(e.sessionDurationJson, '{"avg":300}');
	assert.equal(e.repoCustomizationRate, 0.75);
	assert.equal(e.multiTurnSessions, 4);
	assert.equal(e.avgTurnsPerSession, 3.5);
	assert.equal(e.multiFileEdits, 2);
	assert.equal(e.avgFilesPerEdit, 1.5);
	assert.equal(e.codeBlockApplyRate, 0.8);
	assert.equal(e.sessionCount, 10);
});

test('listAggDailyEntitiesFromTableClient omits fluency metrics when absent', async () => {
	const mockClient: TableClientLike = {
		async *listEntities() {
			yield {
				model: 'gpt-4o', workspaceId: 'ws1', machineId: 'm1',
				inputTokens: 10, outputTokens: 20, interactions: 1,
			};
		},
		upsertEntity: async () => ({}),
		deleteEntity: async () => ({}),
	};

	const results = await listAggDailyEntitiesFromTableClient({
		tableClient: mockClient,
		partitionKey: 'pk',
		defaultDayKey: '2024-06-15',
	});

	const e = results[0];
	assert.equal(e.askModeCount, undefined);
	assert.equal(e.toolCallsJson, undefined);
	assert.equal(e.repoCustomizationRate, undefined);
	assert.equal(e.sessionCount, undefined);
});

test('listAggDailyEntitiesFromTableClient returns empty on error', async () => {
	const errors: string[] = [];
	const mockClient: TableClientLike = {
		async *listEntities() { throw new Error('connection failed'); },
		upsertEntity: async () => ({}),
		deleteEntity: async () => ({}),
	};

	const results = await listAggDailyEntitiesFromTableClient({
		tableClient: mockClient,
		partitionKey: 'pk',
		defaultDayKey: '2024-06-15',
		logger: { error: (...args: any[]) => errors.push(String(args[0])) },
	});

	assert.equal(results.length, 0);
	assert.ok(errors.some(e => e.includes('Failed to list entities')));
});

// ── createDailyAggEntity ─────────────────────────────────────────────────

test('createDailyAggEntity schema version 1: no userId', () => {
	const entity = createDailyAggEntity({
		datasetId: 'ds1', day: '2024-06-15', model: 'gpt-4o',
		workspaceId: 'ws1', machineId: 'm1',
		inputTokens: 100, outputTokens: 200, interactions: 5,
	});

	assert.equal(entity.schemaVersion, 1);
	assert.equal(entity.userId, undefined);
	assert.equal(entity.shareWithTeam, undefined);
	assert.equal(entity.workspaceName, undefined);
	assert.equal(entity.machineName, undefined);
});

test('createDailyAggEntity schema version 2: with userId, no shareWithTeam', () => {
	const entity = createDailyAggEntity({
		datasetId: 'ds1', day: '2024-06-15', model: 'gpt-4o',
		workspaceId: 'ws1', machineId: 'm1',
		userId: 'alice',
		inputTokens: 100, outputTokens: 200, interactions: 5,
	});

	assert.equal(entity.schemaVersion, 2);
	assert.equal(entity.userId, 'alice');
	assert.equal(entity.shareWithTeam, undefined);
});

test('createDailyAggEntity schema version 3: with userId and shareWithTeam', () => {
	const entity = createDailyAggEntity({
		datasetId: 'ds1', day: '2024-06-15', model: 'gpt-4o',
		workspaceId: 'ws1', machineId: 'm1',
		userId: 'alice', userKeyType: 'teamAlias',
		shareWithTeam: true, consentAt: '2024-01-01',
		inputTokens: 100, outputTokens: 200, interactions: 5,
	});

	assert.equal(entity.schemaVersion, 3);
	assert.equal(entity.userId, 'alice');
	assert.equal(entity.shareWithTeam, true);
	assert.equal(entity.userKeyType, 'teamAlias');
	assert.equal(entity.consentAt, '2024-01-01');
});

test('createDailyAggEntity schema version 4: with fluency metrics', () => {
	const entity = createDailyAggEntity({
		datasetId: 'ds1', day: '2024-06-15', model: 'gpt-4o',
		workspaceId: 'ws1', machineId: 'm1',
		inputTokens: 100, outputTokens: 200, interactions: 5,
		fluencyMetrics: {
			askModeCount: 3,
			editModeCount: 2,
			toolCallsJson: '{"total":10}',
			sessionCount: 5,
		},
	});

	assert.equal(entity.schemaVersion, 4);
	assert.equal(entity.askModeCount, 3);
	assert.equal(entity.editModeCount, 2);
	assert.equal(entity.toolCallsJson, '{"total":10}');
	assert.equal(entity.sessionCount, 5);
	// Absent fluency metrics should not be present
	assert.equal(entity.agentModeCount, undefined);
	assert.equal(entity.mcpToolsJson, undefined);
});

test('createDailyAggEntity includes optional workspaceName and machineName', () => {
	const entity = createDailyAggEntity({
		datasetId: 'ds1', day: '2024-06-15', model: 'gpt-4o',
		workspaceId: 'ws1', workspaceName: 'My Project',
		machineId: 'm1', machineName: 'dev-laptop',
		inputTokens: 100, outputTokens: 200, interactions: 5,
	});

	assert.equal(entity.workspaceName, 'My Project');
	assert.equal(entity.machineName, 'dev-laptop');
});

test('createDailyAggEntity treats whitespace-only userId as empty', () => {
	const entity = createDailyAggEntity({
		datasetId: 'ds1', day: '2024-06-15', model: 'gpt-4o',
		workspaceId: 'ws1', machineId: 'm1',
		userId: '   ',
		inputTokens: 100, outputTokens: 200, interactions: 5,
	});

	assert.equal(entity.schemaVersion, 1);
	assert.equal(entity.userId, undefined);
});

test('createDailyAggEntity fluency metrics with all fields', () => {
	const entity = createDailyAggEntity({
		datasetId: 'ds1', day: '2024-06-15', model: 'gpt-4o',
		workspaceId: 'ws1', machineId: 'm1',
		inputTokens: 100, outputTokens: 200, interactions: 5,
		fluencyMetrics: {
			askModeCount: 1, editModeCount: 2, agentModeCount: 3,
			planModeCount: 4, customAgentModeCount: 5,
			toolCallsJson: '{}', contextRefsJson: '{}', mcpToolsJson: '{}',
			modelSwitchingJson: '{}', editScopeJson: '{}', agentTypesJson: '{}',
			repositoriesJson: '[]', applyUsageJson: '{}', sessionDurationJson: '{}',
			repoCustomizationRate: 0.5, multiTurnSessions: 10, avgTurnsPerSession: 2.5,
			multiFileEdits: 3, avgFilesPerEdit: 1.2, codeBlockApplyRate: 0.9,
			sessionCount: 20,
		},
	});

	assert.equal(entity.schemaVersion, 4);
	assert.equal(entity.askModeCount, 1);
	assert.equal(entity.editModeCount, 2);
	assert.equal(entity.agentModeCount, 3);
	assert.equal(entity.planModeCount, 4);
	assert.equal(entity.customAgentModeCount, 5);
	assert.equal(entity.toolCallsJson, '{}');
	assert.equal(entity.contextRefsJson, '{}');
	assert.equal(entity.mcpToolsJson, '{}');
	assert.equal(entity.modelSwitchingJson, '{}');
	assert.equal(entity.editScopeJson, '{}');
	assert.equal(entity.agentTypesJson, '{}');
	assert.equal(entity.repositoriesJson, '[]');
	assert.equal(entity.applyUsageJson, '{}');
	assert.equal(entity.sessionDurationJson, '{}');
	assert.equal(entity.repoCustomizationRate, 0.5);
	assert.equal(entity.multiTurnSessions, 10);
	assert.equal(entity.avgTurnsPerSession, 2.5);
	assert.equal(entity.multiFileEdits, 3);
	assert.equal(entity.avgFilesPerEdit, 1.2);
	assert.equal(entity.codeBlockApplyRate, 0.9);
	assert.equal(entity.sessionCount, 20);
});

test('createDailyAggEntity empty fluencyMetrics object → schema version 1', () => {
	const entity = createDailyAggEntity({
		datasetId: 'ds1', day: '2024-06-15', model: 'gpt-4o',
		workspaceId: 'ws1', machineId: 'm1',
		inputTokens: 100, outputTokens: 200, interactions: 5,
		fluencyMetrics: {},
	});

	assert.equal(entity.schemaVersion, 1);
});
