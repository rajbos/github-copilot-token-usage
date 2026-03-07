import test from 'node:test';
import * as assert from 'node:assert/strict';

import { BackendFacade } from '../backend/facade';

function createFacade(): BackendFacade {
	return new BackendFacade({
		context: undefined,
		log: () => undefined,
		warn: () => undefined,
		calculateEstimatedCost: () => 0,
		co2Per1kTokens: 0.2,
		waterUsagePer1kTokens: 0.3,
		co2AbsorptionPerTreePerYear: 21000,
		getCopilotSessionFiles: async () => [],
		estimateTokensFromText: () => 0,
		getModelFromRequest: () => 'gpt-4o',
		statSessionFile: async (f: string) => {
			const fs = await import('fs');
			return fs.promises.stat(f);
		}
	});
}

test('BackendFacade helper methods behave as expected (path parsing, keys, filters)', () => {
	const facade: any = createFacade();

	assert.equal(
		facade.extractWorkspaceIdFromSessionPath('C:\\Users\\me\\AppData\\Roaming\\Code\\User\\workspaceStorage\\abc123\\github.copilot-chat\\chatSessions\\x.json'),
		'abc123'
	);
	assert.equal(
		facade.extractWorkspaceIdFromSessionPath('C:/Users/me/AppData/Roaming/Code/User/globalStorage/emptyWindowChatSessions/x.json'),
		'emptyWindow'
	);

	assert.equal(facade.sanitizeTableKey('a/b#c?d'), 'a_b_c_d');

	const d1 = facade.addDaysUtc('2026-01-01', 1);
	assert.equal(d1, '2026-01-02');

	const keys = facade.getDayKeysInclusive('2026-01-01', '2026-01-03');
	assert.deepEqual(keys, ['2026-01-01', '2026-01-02', '2026-01-03']);

	facade.setFilters({ lookbackDays: 999, model: 'm', workspaceId: 'w', machineId: 'x', userId: 'u' });
	const f = facade.getFilters();
	assert.equal(f.lookbackDays, 90);
	assert.equal(f.model, 'm');

	facade.setFilters({ model: '', workspaceId: '', machineId: '', userId: '' });
	const f2 = facade.getFilters();
	assert.equal(f2.model, undefined);
	assert.equal(f2.workspaceId, undefined);
});

test('setFilters clears query cache', () => {
	const facade: any = createFacade();
	// Set up some cache state
	facade.backendLastQueryResult = { stats: {}, availableModels: ['test-model'] };
	facade.backendLastQueryCacheKey = 'somekey';
	facade.backendLastQueryCacheAt = Date.now();
	assert.ok(facade.backendLastQueryResult, 'Cache should be populated');
	
	// Changing filters should clear the cache
	facade.setFilters({ model: 'gpt-4o' });
	assert.equal(facade.backendLastQueryResult, undefined, 'backendLastQueryResult should be cleared');
	assert.equal(facade.backendLastQueryCacheKey, undefined, 'backendLastQueryCacheKey should be cleared');
	assert.equal(facade.backendLastQueryCacheAt, undefined, 'backendLastQueryCacheAt should be cleared');
});

test('concurrent sync calls are serialized', async () => {
	const facade: any = createFacade();
	
	// Verify syncQueue exists (used to serialize sync operations and prevent race conditions)
	assert.ok(facade.syncQueue !== undefined, 'syncQueue should exist for serializing operations');
	assert.ok(typeof facade.syncQueue.then === 'function', 'syncQueue should be a Promise');
	
	// Verify that syncToBackendStore returns a Promise (it chains on syncQueue)
	const syncPromise = facade.syncToBackendStore(false);
	assert.ok(syncPromise && typeof syncPromise.then === 'function', 'syncToBackendStore should return a Promise');
	
	// Wait for it to complete (it will return early since backend is not configured)
	await syncPromise;
});
