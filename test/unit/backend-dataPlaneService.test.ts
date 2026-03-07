import './vscode-shim-register';
import test from 'node:test';
import * as assert from 'node:assert/strict';

import { DataPlaneService } from '../../src/backend/services/dataPlaneService';
import { BackendUtility } from '../../src/backend/services/utilityService';
import type { TableClientLike } from '../../src/backend/storageTables';

function makeService(log?: (msg: string) => void): DataPlaneService {
	return new DataPlaneService(
		BackendUtility,
		log ?? (() => {}),
		async () => []
	);
}

/**
 * Create a mock TableClientLike with configurable behavior.
 */
function makeMockTableClient(overrides?: {
	entities?: any[];
	upsertFn?: (entity: any, mode?: string) => Promise<any>;
	deleteFn?: (pk: string, rk: string) => Promise<any>;
}): TableClientLike {
	const entities = overrides?.entities ?? [];
	return {
		async *listEntities() {
			for (const e of entities) { yield e; }
		},
		upsertEntity: overrides?.upsertFn ?? (async () => ({})),
		deleteEntity: overrides?.deleteFn ?? (async () => ({})),
	};
}

// ── getStorageBlobEndpoint ───────────────────────────────────────────────

test('getStorageBlobEndpoint returns correct URL', () => {
	const svc = makeService();
	assert.equal(svc.getStorageBlobEndpoint('mystorageacct'), 'https://mystorageacct.blob.core.windows.net');
});

test('getStorageBlobEndpoint handles various account names', () => {
	const svc = makeService();
	assert.equal(svc.getStorageBlobEndpoint('a'), 'https://a.blob.core.windows.net');
	assert.equal(svc.getStorageBlobEndpoint('longstorageaccountname12345'), 'https://longstorageaccountname12345.blob.core.windows.net');
});

// ── createTableClient ────────────────────────────────────────────────────

test('createTableClient returns a TableClient instance', () => {
	const svc = makeService();
	const settings = { storageAccount: 'testacct', aggTable: 'usageAggDaily' } as any;
	// Use a mock credential (DefaultAzureCredential)
	const mockCredential = { getToken: async () => ({ token: 'test', expiresOnTimestamp: Date.now() + 3600000 }) };
	const client = svc.createTableClient(settings, mockCredential as any);
	assert.ok(client);
	// TableClient should have tableName property
	assert.equal(client.tableName, 'usageAggDaily');
});

// ── listEntitiesForRange ─────────────────────────────────────────────────

test('listEntitiesForRange returns entities for a single-day range', async () => {
	const svc = makeService();
	const mockClient = {
		async *listEntities() {
			yield { partitionKey: 'pk', rowKey: 'rk', model: 'gpt-4o', workspaceId: 'ws1', machineId: 'm1', inputTokens: 100, outputTokens: 200, interactions: 5 };
		},
		upsertEntity: async () => ({}),
		deleteEntity: async () => ({}),
	} satisfies TableClientLike;

	const result = await svc.listEntitiesForRange({
		tableClient: mockClient,
		datasetId: 'ds1',
		startDayKey: '2024-06-15',
		endDayKey: '2024-06-15',
	});
	assert.ok(result.length > 0);
	assert.equal(result[0].model, 'gpt-4o');
});

test('listEntitiesForRange iterates over multiple days', async () => {
	const svc = makeService();
	let queriedPartitions: string[] = [];
	const mockClient: TableClientLike = {
		async *listEntities(options: any) {
			const filter = options?.queryOptions?.filter ?? '';
			queriedPartitions.push(filter);
			yield { partitionKey: 'pk', rowKey: 'rk', model: 'gpt-4o', workspaceId: 'ws1', machineId: 'm1', inputTokens: 10, outputTokens: 20, interactions: 1 };
		},
		upsertEntity: async () => ({}),
		deleteEntity: async () => ({}),
	};

	const result = await svc.listEntitiesForRange({
		tableClient: mockClient,
		datasetId: 'ds1',
		startDayKey: '2024-06-14',
		endDayKey: '2024-06-16',
	});
	// 3 days → 3 queries → 3 entities
	assert.equal(result.length, 3);
	assert.equal(queriedPartitions.length, 3);
});

test('listEntitiesForRange returns empty array when no entities exist', async () => {
	const svc = makeService();
	const mockClient = makeMockTableClient({ entities: [] });
	// Override the listEntities to return empty for the partition-filtered query
	(mockClient as any).listEntities = async function*() { /* empty */ };

	const result = await svc.listEntitiesForRange({
		tableClient: mockClient,
		datasetId: 'ds1',
		startDayKey: '2024-06-15',
		endDayKey: '2024-06-15',
	});
	assert.equal(result.length, 0);
});

// ── listAllEntitiesForRange ──────────────────────────────────────────────

test('listAllEntitiesForRange parses partition and row keys correctly', async () => {
	const svc = makeService();
	const mockClient = makeMockTableClient({
		entities: [{
			partitionKey: 'myDataset|2024-06-15',
			rowKey: 'gpt-4o|ws1|m1|user1',
			inputTokens: 500,
			outputTokens: 1000,
			interactions: 10,
		}],
	});

	const result = await svc.listAllEntitiesForRange({
		tableClient: mockClient,
		startDayKey: '2024-06-15',
		endDayKey: '2024-06-15',
	});
	assert.equal(result.length, 1);
	assert.equal(result[0].datasetId, 'myDataset');
	assert.equal(result[0].day, '2024-06-15');
	assert.equal(result[0].model, 'gpt-4o');
	assert.equal(result[0].workspaceId, 'ws1');
	assert.equal(result[0].machineId, 'm1');
	assert.equal(result[0].userId, 'user1');
});

test('listAllEntitiesForRange includes fluency metrics when present', async () => {
	const svc = makeService();
	const mockClient = makeMockTableClient({
		entities: [{
			partitionKey: 'ds1|2024-06-15',
			rowKey: 'gpt-4o|ws1|m1|',
			inputTokens: 100,
			outputTokens: 200,
			interactions: 5,
			askModeCount: 3,
			editModeCount: 2,
			toolCallsJson: '{"search":1}',
			schemaVersion: 4,
		}],
	});

	const result = await svc.listAllEntitiesForRange({
		tableClient: mockClient,
		startDayKey: '2024-06-15',
		endDayKey: '2024-06-15',
	});
	assert.equal(result.length, 1);
	assert.equal(result[0].askModeCount, 3);
	assert.equal(result[0].editModeCount, 2);
	assert.equal(result[0].toolCallsJson, '{"search":1}');
	assert.equal(result[0].schemaVersion, 4);
});

test('listAllEntitiesForRange returns empty array for empty table', async () => {
	const svc = makeService();
	const mockClient = makeMockTableClient({ entities: [] });

	const result = await svc.listAllEntitiesForRange({
		tableClient: mockClient,
		startDayKey: '2024-06-15',
		endDayKey: '2024-06-15',
	});
	assert.equal(result.length, 0);
});

// ── deleteEntitiesForUserDataset ─────────────────────────────────────────

test('deleteEntitiesForUserDataset deletes matching entities', async () => {
	const svc = makeService();
	const deletedKeys: string[] = [];
	const mockClient: TableClientLike = {
		async *listEntities() {
			yield { partitionKey: 'ds:myds|d:2024-06-15', rowKey: 'm:gpt-4o|u:alice' };
			yield { partitionKey: 'ds:myds|d:2024-06-15', rowKey: 'm:gpt-4o|u:bob' };
			yield { partitionKey: 'ds:other|d:2024-06-15', rowKey: 'm:gpt-4o|u:alice' };
		},
		upsertEntity: async () => ({}),
		deleteEntity: async (pk, rk) => { deletedKeys.push(`${pk}/${rk}`); },
	};

	const result = await svc.deleteEntitiesForUserDataset({
		tableClient: mockClient,
		userId: 'alice',
		datasetId: 'myds',
		startDayKey: '2024-06-15',
		endDayKey: '2024-06-15',
	});
	// Only 1 entity matches both ds:myds AND u:alice
	assert.equal(result.deletedCount, 1);
	assert.equal(result.errors.length, 0);
	assert.equal(deletedKeys.length, 1);
	assert.ok(deletedKeys[0].includes('u:alice'));
});

test('deleteEntitiesForUserDataset reports errors for failed deletes', async () => {
	const logs: string[] = [];
	const svc = makeService((m) => logs.push(m));
	const mockClient: TableClientLike = {
		async *listEntities() {
			yield { partitionKey: 'ds:myds|d:2024-06-15', rowKey: 'm:gpt-4o|u:alice' };
		},
		upsertEntity: async () => ({}),
		deleteEntity: async () => { throw new Error('delete failed'); },
	};

	const result = await svc.deleteEntitiesForUserDataset({
		tableClient: mockClient,
		userId: 'alice',
		datasetId: 'myds',
		startDayKey: '2024-06-15',
		endDayKey: '2024-06-15',
	});
	assert.equal(result.deletedCount, 0);
	assert.equal(result.errors.length, 1);
	assert.equal(result.errors[0].error.message, 'delete failed');
});

test('deleteEntitiesForUserDataset returns zero when no entities match', async () => {
	const svc = makeService();
	const mockClient = makeMockTableClient({
		entities: [
			{ partitionKey: 'ds:other|d:2024-06-15', rowKey: 'm:gpt-4o|u:bob' },
		],
	});

	const result = await svc.deleteEntitiesForUserDataset({
		tableClient: mockClient,
		userId: 'alice',
		datasetId: 'myds',
		startDayKey: '2024-06-15',
		endDayKey: '2024-06-15',
	});
	assert.equal(result.deletedCount, 0);
	assert.equal(result.errors.length, 0);
});

// ── upsertEntitiesBatch ──────────────────────────────────────────────────

test('upsertEntitiesBatch upserts all entities successfully', async () => {
	const svc = makeService();
	let upsertCount = 0;
	const mockClient = makeMockTableClient({
		upsertFn: async () => { upsertCount++; },
	});

	const entities = [
		{ partitionKey: 'pk1', rowKey: 'rk1', data: 1 },
		{ partitionKey: 'pk1', rowKey: 'rk2', data: 2 },
		{ partitionKey: 'pk2', rowKey: 'rk3', data: 3 },
	];

	const result = await svc.upsertEntitiesBatch(mockClient, entities);
	assert.equal(result.successCount, 3);
	assert.equal(result.errors.length, 0);
	assert.equal(upsertCount, 3);
});

test('upsertEntitiesBatch reports errors for failed entities', async () => {
	const logs: string[] = [];
	const svc = makeService((m) => logs.push(m));
	let callCount = 0;
	const mockClient = makeMockTableClient({
		upsertFn: async () => {
			callCount++;
			if (callCount === 2) { throw new Error('upsert failed'); }
		},
	});

	const entities = [
		{ partitionKey: 'pk1', rowKey: 'rk1' },
		{ partitionKey: 'pk1', rowKey: 'rk2' },
		{ partitionKey: 'pk1', rowKey: 'rk3' },
	];

	const result = await svc.upsertEntitiesBatch(mockClient, entities);
	assert.equal(result.successCount, 2);
	assert.equal(result.errors.length, 1);
	assert.equal(result.errors[0].error.message, 'upsert failed');
});

test('upsertEntitiesBatch handles empty entity list', async () => {
	const svc = makeService();
	const mockClient = makeMockTableClient();

	const result = await svc.upsertEntitiesBatch(mockClient, []);
	assert.equal(result.successCount, 0);
	assert.equal(result.errors.length, 0);
});

test('upsertEntitiesBatch groups entities by partition key', async () => {
	const svc = makeService();
	const upserted: string[] = [];
	const mockClient = makeMockTableClient({
		upsertFn: async (entity) => { upserted.push(entity.partitionKey); },
	});

	const entities = [
		{ partitionKey: 'pk-a', rowKey: 'rk1' },
		{ partitionKey: 'pk-b', rowKey: 'rk2' },
		{ partitionKey: 'pk-a', rowKey: 'rk3' },
	];

	const result = await svc.upsertEntitiesBatch(mockClient, entities);
	assert.equal(result.successCount, 3);
	// All three were upserted
	assert.equal(upserted.length, 3);
});

// ── upsertEntitiesBatch: retry behavior ──────────────────────────────────

test('upsertEntitiesBatch throws immediately for non-retryable errors (e.g. 400)', async () => {
	const svc = makeService();
	const mockClient = makeMockTableClient({
		upsertFn: async () => {
			const err: any = new Error('Bad request');
			err.statusCode = 400;
			throw err;
		},
	});

	const result = await svc.upsertEntitiesBatch(mockClient, [
		{ partitionKey: 'pk1', rowKey: 'rk1' },
	]);
	assert.equal(result.successCount, 0);
	assert.equal(result.errors.length, 1);
	assert.equal(result.errors[0].error.message, 'Bad request');
});

test('upsertEntitiesBatch wraps non-Error throwables', async () => {
	const svc = makeService();
	const mockClient = makeMockTableClient({
		upsertFn: async () => { throw 'string error'; },
	});

	const result = await svc.upsertEntitiesBatch(mockClient, [
		{ partitionKey: 'pk1', rowKey: 'rk1' },
	]);
	assert.equal(result.errors.length, 1);
	assert.ok(result.errors[0].error instanceof Error);
	assert.ok(result.errors[0].error.message.includes('string error'));
});

// ── listAllEntitiesForRange: edge cases ──────────────────────────────────

test('listAllEntitiesForRange handles entity with single-segment partitionKey', async () => {
	const svc = makeService();
	const mockClient = makeMockTableClient({
		entities: [{
			partitionKey: 'noPipe',
			rowKey: 'gpt-4o|ws1|m1|',
			inputTokens: 10,
			outputTokens: 20,
			interactions: 1,
		}],
	});

	const result = await svc.listAllEntitiesForRange({
		tableClient: mockClient,
		startDayKey: '2024-06-15',
		endDayKey: '2024-06-15',
	});

	assert.equal(result.length, 1);
	assert.equal(result[0].datasetId, 'noPipe');
	assert.equal(result[0].day, '');
});

test('listAllEntitiesForRange handles missing partitionKey and rowKey', async () => {
	const svc = makeService();
	const mockClient = makeMockTableClient({
		entities: [{
			partitionKey: undefined,
			rowKey: undefined,
			inputTokens: 10,
			outputTokens: 20,
			interactions: 1,
		}],
	});

	const result = await svc.listAllEntitiesForRange({
		tableClient: mockClient,
		startDayKey: '2024-06-15',
		endDayKey: '2024-06-15',
	});

	assert.equal(result.length, 1);
	assert.equal(result[0].partitionKey, '');
	assert.equal(result[0].rowKey, '');
});
