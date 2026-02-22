import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';

import { BackendFacade } from '../backend/facade';

test('BackendFacade queryBackendRollups aggregates, filters, and caches results', async () => {
	const facade: any = new BackendFacade({
		context: undefined,
		log: () => undefined,
		warn: () => undefined,
		calculateEstimatedCost: (mu: any) => {
			const models = Object.keys(mu ?? {});
			return models.length;
		},
		co2Per1kTokens: 0.2,
		waterUsagePer1kTokens: 0.3,
		co2AbsorptionPerTreePerYear: 21000,
		getCopilotSessionFiles: async () => [],
		estimateTokensFromText: () => 0,
		getModelFromRequest: () => 'gpt-4o',
	statSessionFile: async (f: string) => fs.promises.stat(f)
	});

	let listCalls = 0;
	// Mock the credentialService that the queryService uses
	// The queryService is private but we can access it for testing
	const mockCredService = {
		getBackendDataPlaneCredentialsOrThrow: async () => ({
			tableCredential: { type: 'mock-credential' },
			blobCredential: { type: 'mock-credential' },
			secretsToRedact: []
		}),
		getBackendSecretsToRedactForError: () => []
	};
	facade['queryService']['credentialService'] = mockCredService;
	
	// Mock the dataPlaneService.listEntitiesForRange method that queryBackendRollups calls
	facade['queryService']['dataPlaneService'] = {
		createTableClient: () => ({}) as any,
		listEntitiesForRange: async () => {
			listCalls++;
			return [
				// Valid entities
				{ model: 'gpt-4o', workspaceId: 'w1', workspaceName: 'Project One', machineId: 'm1', machineName: 'DevBox', userId: 'u1', inputTokens: 10, outputTokens: 5, interactions: 1 },
				{ model: 'gpt-4o', workspaceId: 'w2', machineId: 'm1', userId: 'u2', inputTokens: 2, outputTokens: 3, interactions: 1 },
				{ model: 'gpt-4.1', workspaceId: 'w1', machineId: 'm2', machineName: 'BuildAgent', userId: '', inputTokens: 7, outputTokens: 0, interactions: 2 },
				// Invalid (missing required dims) should be skipped
				{ model: '', workspaceId: 'w1', machineId: 'm1', inputTokens: 999, outputTokens: 999, interactions: 999 }
			];
		}
	} as any;

	const settings = { storageAccount: 'acct', aggTable: 't', datasetId: 'd' } as any;
	const filters = { lookbackDays: 30 } as any;

	const res1 = await facade.queryBackendRollups(settings, filters, '2026-01-01', '2026-01-02');
	assert.equal(listCalls, 1);
	assert.equal(res1.stats.today.tokens, (10 + 5) + (2 + 3) + (7 + 0));
	assert.ok(res1.availableModels.includes('gpt-4o'));
	assert.ok(res1.availableModels.includes('gpt-4.1'));
	assert.ok(res1.availableWorkspaces.includes('w1'));
	assert.ok(res1.availableWorkspaces.includes('w2'));
	assert.ok(res1.availableMachines.includes('m1'));
	assert.ok(res1.availableMachines.includes('m2'));
	assert.ok(res1.availableUsers.includes('u1'));
	assert.ok(res1.availableUsers.includes('u2'));
	assert.deepEqual(res1.workspaceNamesById, { w1: 'Project One' });
	assert.deepEqual(res1.machineNamesById, { m1: 'DevBox', m2: 'BuildAgent' });

	// Filter by model
	const res2 = await facade.queryBackendRollups(settings, { lookbackDays: 30, model: 'gpt-4o' }, '2026-01-01', '2026-01-02');
	assert.equal(listCalls, 2);
	assert.equal(res2.stats.today.tokens, (10 + 5) + (2 + 3));

	// Cache is for the most recent query key only; re-using the first key after a different query
	// will fetch again (but should still return the same result for identical inputs).
	const res3 = await facade.queryBackendRollups(settings, filters, '2026-01-01', '2026-01-02');
	assert.equal(listCalls, 3);
	assert.ok(res1.stats.lastUpdated instanceof Date);
	assert.ok(res3.stats.lastUpdated instanceof Date);
	const { lastUpdated: _ignore1, ...stats1 } = res1.stats;
	const { lastUpdated: _ignore3, ...stats3 } = res3.stats;
	assert.deepEqual({ ...res3, stats: stats3 }, { ...res1, stats: stats1 });
});
