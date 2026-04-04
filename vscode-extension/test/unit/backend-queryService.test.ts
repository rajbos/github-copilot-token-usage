import './vscode-shim-register';
import { test, describe, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';

import { QueryService } from '../../src/backend/services/queryService';
import { BackendUtility } from '../../src/backend/services/utilityService';
import type { BackendSettings } from '../../src/backend/settings';

function makeDeps() {
	return {
		warn: () => {},
		calculateEstimatedCost: () => 0,
		co2Per1kTokens: 0.2,
		waterUsagePer1kTokens: 0.3,
		co2AbsorptionPerTreePerYear: 21000
	};
}

function makeCredService() {
	return {
		getBackendDataPlaneCredentialsOrThrow: async () => ({
			tableCredential: { type: 'mock' },
			blobCredential: undefined
		})
	} as any;
}

function makeDataPlaneService(entities: any[] = []) {
	return {
		createTableClient: () => ({ tableName: 'test' }),
		listEntitiesForRange: async () => entities
	} as any;
}

function makeSettings(overrides?: Partial<BackendSettings>): BackendSettings {
	return {
		enabled: true,
		backend: 'storageTables',
		authMode: 'entraId',
		datasetId: 'default',
		sharingProfile: 'soloFull',
		shareWithTeam: false,
		shareWorkspaceMachineNames: false,
		shareConsentAt: '',
		userIdentityMode: 'pseudonymous',
		userId: '',
		userIdMode: 'alias',
		subscriptionId: 'sub-1',
		resourceGroup: 'rg-1',
		storageAccount: 'testacc',
		aggTable: 'usageAggDaily',
		eventsTable: 'usageEvents',
		lookbackDays: 30,
		includeMachineBreakdown: false,
		blobUploadEnabled: false,
		blobContainerName: 'copilot-session-logs',
		blobUploadFrequencyHours: 24,
		blobCompressFiles: true,
		...overrides
	};
}

describe('QueryService direct tests', { concurrency: false }, () => {
	let svc: QueryService;

	beforeEach(() => {
		svc = new QueryService(makeDeps(), makeCredService(), makeDataPlaneService(), BackendUtility);
	});

	test('getLastQueryResult returns undefined initially', () => {
		assert.equal(svc.getLastQueryResult(), undefined);
	});

	test('getCacheKey returns undefined initially', () => {
		assert.equal(svc.getCacheKey(), undefined);
	});

	test('getCacheTimestamp returns undefined initially', () => {
		assert.equal(svc.getCacheTimestamp(), undefined);
	});

	test('setCacheState sets and retrieves cache state', () => {
		const mockResult = { stats: {}, availableModels: [], availableWorkspaces: [], availableMachines: [], availableUsers: [], workspaceTokenTotals: [], machineTokenTotals: [] } as any;
		svc.setCacheState(mockResult, 'test-key', 12345);
		assert.equal(svc.getCacheKey(), 'test-key');
		assert.equal(svc.getCacheTimestamp(), 12345);
		assert.equal(svc.getLastQueryResult(), mockResult);
	});

	test('clearQueryCache resets all cache fields', () => {
		svc.setCacheState({} as any, 'key', 100);
		svc.clearQueryCache();
		assert.equal(svc.getCacheKey(), undefined);
		assert.equal(svc.getCacheTimestamp(), undefined);
		assert.equal(svc.getLastQueryResult(), undefined);
	});

	test('queryBackendRollups returns aggregated result', async () => {
		const entities = [
			{ model: 'gpt-4o', workspaceId: 'w1', machineId: 'm1', userId: 'u1', inputTokens: 100, outputTokens: 50, interactions: 2 },
			{ model: 'gpt-4o', workspaceId: 'w1', machineId: 'm2', userId: '', inputTokens: 200, outputTokens: 100, interactions: 3 }
		];
		svc = new QueryService(makeDeps(), makeCredService(), makeDataPlaneService(entities), BackendUtility);
		const result = await svc.queryBackendRollups(makeSettings(), { lookbackDays: 7 }, '2025-01-01', '2025-01-07');

		assert.equal(result.stats.today.tokens, 450);
		assert.equal(result.stats.today.sessions, 5);
		assert.deepEqual(result.availableModels, ['gpt-4o']);
		assert.deepEqual(result.availableWorkspaces, ['w1']);
		assert.deepEqual(result.availableMachines.sort(), ['m1', 'm2']);
		assert.equal(result.workspaceTokenTotals.length, 1);
		assert.equal(result.machineTokenTotals.length, 2);
	});

	test('queryBackendRollups caches result for same key', async () => {
		let callCount = 0;
		const dpSvc = {
			createTableClient: () => ({ tableName: 'test' }),
			listEntitiesForRange: async () => { callCount++; return []; }
		} as any;
		svc = new QueryService(makeDeps(), makeCredService(), dpSvc, BackendUtility);
		const settings = makeSettings();

		await svc.queryBackendRollups(settings, { lookbackDays: 7 }, '2025-01-01', '2025-01-07');
		assert.equal(callCount, 1);
		await svc.queryBackendRollups(settings, { lookbackDays: 7 }, '2025-01-01', '2025-01-07');
		assert.equal(callCount, 1); // cache hit
	});

	test('queryBackendRollups stores workspace and machine names', async () => {
		const entities = [
			{ model: 'gpt-4o', workspaceId: 'w1', workspaceName: 'MyProject', machineId: 'm1', machineName: 'DevLaptop', userId: '', inputTokens: 50, outputTokens: 50, interactions: 1 }
		];
		svc = new QueryService(makeDeps(), makeCredService(), makeDataPlaneService(entities), BackendUtility);
		const result = await svc.queryBackendRollups(makeSettings(), { lookbackDays: 7 }, '2025-01-01', '2025-01-07');

		assert.deepEqual(result.workspaceNamesById, { w1: 'MyProject' });
		assert.deepEqual(result.machineNamesById, { m1: 'DevLaptop' });
	});

	test('queryBackendRollups skips entities missing required fields', async () => {
		const entities = [
			{ model: '', workspaceId: 'w1', machineId: 'm1', inputTokens: 100, outputTokens: 50, interactions: 1 },
			{ model: 'gpt-4o', workspaceId: '', machineId: 'm1', inputTokens: 100, outputTokens: 50, interactions: 1 },
			{ model: 'gpt-4o', workspaceId: 'w1', machineId: '', inputTokens: 100, outputTokens: 50, interactions: 1 },
			{ model: 'gpt-4o', workspaceId: 'w1', machineId: 'm1', inputTokens: 100, outputTokens: 50, interactions: 1 }
		];
		svc = new QueryService(makeDeps(), makeCredService(), makeDataPlaneService(entities), BackendUtility);
		const result = await svc.queryBackendRollups(makeSettings(), { lookbackDays: 7 }, '2025-01-01', '2025-01-07');
		assert.equal(result.stats.today.tokens, 150); // only last entity counted
	});

	test('tryGetBackendDetailedStatsForStatusBar returns undefined when not configured', async () => {
		const result = await svc.tryGetBackendDetailedStatsForStatusBar(makeSettings(), false, { allowCloudSync: true });
		assert.equal(result, undefined);
	});

	test('tryGetBackendDetailedStatsForStatusBar returns undefined when cloud sync disallowed', async () => {
		const result = await svc.tryGetBackendDetailedStatsForStatusBar(makeSettings(), true, { allowCloudSync: false });
		assert.equal(result, undefined);
	});

	test('tryGetBackendDetailedStatsForStatusBar returns stats when configured', async () => {
		const entities = [
			{ model: 'gpt-4o', workspaceId: 'w1', machineId: 'm1', userId: '', inputTokens: 100, outputTokens: 50, interactions: 1 }
		];
		svc = new QueryService(makeDeps(), makeCredService(), makeDataPlaneService(entities), BackendUtility);
		const result = await svc.tryGetBackendDetailedStatsForStatusBar(makeSettings(), true, { allowCloudSync: true });
		assert.ok(result);
		assert.ok(result.today);
		assert.ok(result.month);
		assert.ok(result.lastUpdated);
	});

	test('tryGetBackendDetailedStatsForStatusBar returns undefined on error', async () => {
		const badCreds = { getBackendDataPlaneCredentialsOrThrow: async () => { throw new Error('creds failed'); } } as any;
		svc = new QueryService(makeDeps(), badCreds, makeDataPlaneService(), BackendUtility);
		const result = await svc.tryGetBackendDetailedStatsForStatusBar(makeSettings(), true, { allowCloudSync: true });
		assert.equal(result, undefined);
	});

	test('getStatsForDetailsPanel returns undefined when not configured', async () => {
		const result = await svc.getStatsForDetailsPanel(makeSettings(), false, { allowCloudSync: true });
		assert.equal(result, undefined);
	});

	test('getStatsForDetailsPanel returns stats when configured', async () => {
		const entities = [
			{ model: 'gpt-4o', workspaceId: 'w1', machineId: 'm1', userId: '', inputTokens: 100, outputTokens: 50, interactions: 1 }
		];
		svc = new QueryService(makeDeps(), makeCredService(), makeDataPlaneService(entities), BackendUtility);
		const result = await svc.getStatsForDetailsPanel(makeSettings(), true, { allowCloudSync: true });
		assert.ok(result);
		assert.ok(result.today);
		assert.ok(result.month);
	});

	test('getStatsForDetailsPanel returns undefined on error', async () => {
		const badCreds = { getBackendDataPlaneCredentialsOrThrow: async () => { throw new Error('auth fail'); } } as any;
		svc = new QueryService(makeDeps(), badCreds, makeDataPlaneService(), BackendUtility);
		const result = await svc.getStatsForDetailsPanel(makeSettings(), true, { allowCloudSync: true });
		assert.equal(result, undefined);
	});
});
