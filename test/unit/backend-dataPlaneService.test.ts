import './vscode-shim-register';
import test from 'node:test';
import * as assert from 'node:assert/strict';

import { DataPlaneService } from '../../src/backend/services/dataPlaneService';
import { BackendUtility } from '../../src/backend/services/utilityService';

function makeService(): DataPlaneService {
	return new DataPlaneService(
		BackendUtility,
		() => {},
		async () => []
	);
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
