import './vscode-shim-register';
import test from 'node:test';
import * as assert from 'node:assert/strict';

import * as vscode from 'vscode';
import { BlobUploadService, type BlobUploadSettings } from '../../src/backend/services/blobUploadService';

function makeGlobalState(): vscode.Memento & { setKeysForSync?(keys: readonly string[]): void } {
	const state = new Map<string, unknown>();
	return {
		keys: () => [...state.keys()],
		get<T>(key: string, fallback?: T): T {
			return (state.has(key) ? state.get(key) : fallback) as T;
		},
		async update(key: string, value: unknown) {
			state.set(key, value);
		}
	};
}

function makeContext(): vscode.ExtensionContext {
	return {
		globalState: makeGlobalState()
	} as unknown as vscode.ExtensionContext;
}

const enabledSettings: BlobUploadSettings = {
	enabled: true,
	containerName: 'logs',
	uploadFrequencyHours: 24,
	compressFiles: true
};

// ── shouldUpload ─────────────────────────────────────────────────────────

test('shouldUpload returns false when disabled', () => {
	const svc = new BlobUploadService(() => {}, () => {}, makeContext());
	assert.equal(svc.shouldUpload('m1', { ...enabledSettings, enabled: false }), false);
});

test('shouldUpload returns true on first upload (no status)', () => {
	const svc = new BlobUploadService(() => {}, () => {}, makeContext());
	assert.equal(svc.shouldUpload('m1', enabledSettings), true);
});

test('shouldUpload returns false when within frequency window', () => {
	const svc = new BlobUploadService(() => {}, () => {}, makeContext());
	// Simulate a recent upload by directly accessing the internal status
	(svc as any).uploadStatus.set('m1', {
		lastUploadTime: Date.now() - (1000 * 60 * 30), // 30 minutes ago
		filesUploaded: 5
	});
	assert.equal(svc.shouldUpload('m1', enabledSettings), false);
});

test('shouldUpload returns true when past frequency window', () => {
	const svc = new BlobUploadService(() => {}, () => {}, makeContext());
	(svc as any).uploadStatus.set('m1', {
		lastUploadTime: Date.now() - (1000 * 60 * 60 * 25), // 25 hours ago
		filesUploaded: 5
	});
	assert.equal(svc.shouldUpload('m1', enabledSettings), true);
});

test('shouldUpload uses custom frequency from settings', () => {
	const svc = new BlobUploadService(() => {}, () => {}, makeContext());
	(svc as any).uploadStatus.set('m1', {
		lastUploadTime: Date.now() - (1000 * 60 * 60 * 2), // 2 hours ago
		filesUploaded: 5
	});
	assert.equal(svc.shouldUpload('m1', { ...enabledSettings, uploadFrequencyHours: 1 }), true);
	assert.equal(svc.shouldUpload('m1', { ...enabledSettings, uploadFrequencyHours: 4 }), false);
});

// ── getUploadStatus / clearUploadStatus ──────────────────────────────────

test('getUploadStatus returns undefined for unknown machineId', () => {
	const svc = new BlobUploadService(() => {}, () => {}, makeContext());
	assert.equal(svc.getUploadStatus('unknown'), undefined);
});

test('clearUploadStatus removes all status entries', () => {
	const svc = new BlobUploadService(() => {}, () => {}, makeContext());
	(svc as any).uploadStatus.set('m1', { lastUploadTime: Date.now(), filesUploaded: 1 });
	svc.clearUploadStatus();
	assert.equal(svc.getUploadStatus('m1'), undefined);
});

// ── constructor: loadUploadStatus ────────────────────────────────────────

test('constructor loads upload status from globalState', () => {
	const ctx = makeContext();
	const storedStatus = {
		'm1': { lastUploadTime: 1000000, filesUploaded: 10 },
		'm2': { lastUploadTime: 2000000, filesUploaded: 5 }
	};
	(ctx.globalState as any).update('blobUploadStatus', storedStatus);

	const svc = new BlobUploadService(() => {}, () => {}, ctx);
	const status = svc.getUploadStatus('m1');
	assert.ok(status);
	assert.equal(status!.filesUploaded, 10);
});

test('constructor filters out entries with zero filesUploaded', () => {
	const ctx = makeContext();
	const storedStatus = {
		'm1': { lastUploadTime: 1000000, filesUploaded: 0 },
		'm2': { lastUploadTime: 2000000, filesUploaded: 5 }
	};
	(ctx.globalState as any).update('blobUploadStatus', storedStatus);

	const svc = new BlobUploadService(() => {}, () => {}, ctx);
	assert.equal(svc.getUploadStatus('m1'), undefined);
	assert.ok(svc.getUploadStatus('m2'));
});

test('constructor handles missing context gracefully', () => {
	const svc = new BlobUploadService(() => {}, () => {}, undefined as any);
	assert.equal(svc.getUploadStatus('m1'), undefined);
});

// ── uploadSessionFiles ───────────────────────────────────────────────────

test('uploadSessionFiles returns disabled message when not enabled', async () => {
	const svc = new BlobUploadService(() => {}, () => {}, makeContext());
	const result = await svc.uploadSessionFiles(
		'teststorage',
		{ ...enabledSettings, enabled: false },
		{} as any,
		['/fake/session.json'],
		'm1',
		'ds1'
	);
	assert.equal(result.success, false);
	assert.equal(result.filesUploaded, 0);
	assert.ok(result.message.includes('disabled'));
});

test('uploadSessionFiles skips upload when within frequency window', async () => {
	const svc = new BlobUploadService(() => {}, () => {}, makeContext());
	// Set a recent upload so shouldUpload returns false
	(svc as any).uploadStatus.set('m1', {
		lastUploadTime: Date.now() - (1000 * 60 * 30), // 30 min ago
		filesUploaded: 5
	});
	const result = await svc.uploadSessionFiles(
		'teststorage',
		enabledSettings,
		{} as any,
		['/fake/session.json'],
		'm1',
		'ds1'
	);
	assert.equal(result.success, true);
	assert.equal(result.filesUploaded, 0);
	assert.ok(result.message.includes('skipped'));
});

test('uploadSessionFiles returns failure when getContainerClient throws', async () => {
	const warnings: string[] = [];
	const svc = new BlobUploadService(() => {}, (m) => warnings.push(m), makeContext());
	// Force the containerClient creation to fail
	const badCredential = {} as any; // Will fail when BlobServiceClient tries to use it
	const result = await svc.uploadSessionFiles(
		'teststorage',
		enabledSettings,
		badCredential,
		['/fake/session.json'],
		'm1',
		'ds1'
	);
	assert.equal(result.success, false);
	assert.equal(result.filesUploaded, 0);
	assert.ok(result.message.includes('failed'));
});

// ── uploadSessionFiles: authorization error handling ─────────────────────

test('uploadSessionFiles stops on 403 auth error with Entra ID credential', async () => {
	const warnings: string[] = [];
	const logs: string[] = [];
	const svc = new BlobUploadService((m) => logs.push(m), (m) => warnings.push(m), makeContext());

	// Mock getContainerClient and uploadFile to throw 403
	(svc as any).getContainerClient = async () => ({});
	(svc as any).uploadFile = async () => {
		const err: any = new Error('Forbidden');
		err.statusCode = 403;
		throw err;
	};

	// Entra ID credential (no accountName property)
	const entraCredential = { getToken: async () => ({ token: 'test', expiresOnTimestamp: Date.now() + 3600000 }) };

	const result = await svc.uploadSessionFiles(
		'teststorage',
		enabledSettings,
		entraCredential as any,
		['/fake/session1.json', '/fake/session2.json'],
		'm1',
		'ds1'
	);

	assert.equal(result.success, false);
	assert.ok(result.message.includes('Storage Blob Data Contributor'));
});

test('uploadSessionFiles stops on AuthorizationPermissionMismatch with shared key', async () => {
	const warnings: string[] = [];
	const svc = new BlobUploadService(() => {}, (m) => warnings.push(m), makeContext());

	(svc as any).getContainerClient = async () => ({});
	(svc as any).uploadFile = async () => {
		const err: any = new Error('AuthorizationPermissionMismatch');
		err.code = 'AuthorizationPermissionMismatch';
		throw err;
	};

	// Shared key credential (has accountName property)
	const sharedKeyCredential = { accountName: 'teststorage' };

	const result = await svc.uploadSessionFiles(
		'teststorage',
		enabledSettings,
		sharedKeyCredential as any,
		['/fake/session1.json'],
		'm1',
		'ds1'
	);

	assert.equal(result.success, false);
	assert.ok(result.message.includes('shared key'));
});

test('uploadSessionFiles handles partial upload with some file errors', async () => {
	const logs: string[] = [];
	const svc = new BlobUploadService((m) => logs.push(m), () => {}, makeContext());

	let callCount = 0;
	const mockContainerClient = {
		getBlockBlobClient: () => ({
			upload: async () => {
				callCount++;
				if (callCount === 2) {
					throw new Error('upload failed for file 2');
				}
			}
		})
	};
	(svc as any).getContainerClient = async () => mockContainerClient;

	// We need real files for fs.statSync and fs.promises.readFile inside uploadFile
	// Instead, mock the private uploadFile method
	let uploadCalls = 0;
	(svc as any).uploadFile = async (_cc: any, _path: string) => {
		uploadCalls++;
		if (uploadCalls === 2) {
			throw new Error('upload error on file 2');
		}
	};

	const result = await svc.uploadSessionFiles(
		'teststorage',
		enabledSettings,
		{ getToken: async () => ({ token: 'test', expiresOnTimestamp: 0 }) } as any,
		['/fake/a.json', '/fake/b.json', '/fake/c.json'],
		'm1',
		'ds1'
	);

	assert.equal(result.filesUploaded, 2);
	assert.equal(result.success, false);
	assert.ok(result.message.includes('2/3'));
	// Upload status should have been saved since filesUploaded > 0
	const status = svc.getUploadStatus('m1');
	assert.ok(status);
	assert.equal(status!.filesUploaded, 2);
});

test('uploadSessionFiles updates status on successful upload', async () => {
	const svc = new BlobUploadService(() => {}, () => {}, makeContext());

	(svc as any).getContainerClient = async () => ({});
	(svc as any).uploadFile = async () => {};

	const result = await svc.uploadSessionFiles(
		'teststorage',
		enabledSettings,
		{ getToken: async () => ({ token: 't', expiresOnTimestamp: 0 }) } as any,
		['/fake/a.json', '/fake/b.json'],
		'm1',
		'ds1'
	);

	assert.equal(result.success, true);
	assert.equal(result.filesUploaded, 2);
	assert.ok(result.message.includes('Successfully uploaded 2'));
	const status = svc.getUploadStatus('m1');
	assert.ok(status);
	assert.equal(status!.filesUploaded, 2);
});

test('uploadSessionFiles does not update status when all uploads fail', async () => {
	const svc = new BlobUploadService(() => {}, () => {}, makeContext());

	(svc as any).getContainerClient = async () => ({});
	(svc as any).uploadFile = async () => { throw new Error('fail'); };

	const result = await svc.uploadSessionFiles(
		'teststorage',
		enabledSettings,
		{ getToken: async () => ({ token: 't', expiresOnTimestamp: 0 }) } as any,
		['/fake/a.json'],
		'm1',
		'ds1'
	);

	assert.equal(result.filesUploaded, 0);
	assert.equal(result.success, false);
	// Status should not be set since no files were uploaded
	assert.equal(svc.getUploadStatus('m1'), undefined);
});
