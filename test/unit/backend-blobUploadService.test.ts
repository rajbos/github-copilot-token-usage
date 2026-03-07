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
