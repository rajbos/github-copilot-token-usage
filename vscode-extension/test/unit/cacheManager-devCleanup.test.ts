import './vscode-shim-register';
import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { makeTmpFixtureDir, reserveTmpFixturePath } from './tmpFixtureDirs';
import * as path from 'node:path';

import { CacheManager } from '../../src/cacheManager';
import { createMockMemento } from './vscode-test-helpers';

function makeDevManager(dir: string, logs: string[] = []): CacheManager {
	const context: any = {
		extensionMode: 2, // Development
		globalStorageUri: { fsPath: dir },
		globalState: createMockMemento()
	};
	const deps = { log: (m: string) => logs.push(m), warn: () => {}, error: () => {} };
	return new CacheManager(context, deps, 1);
}

function makeProdManager(dir: string): CacheManager {
	const context: any = {
		extensionMode: 1, // Production
		globalStorageUri: { fsPath: dir },
		globalState: createMockMemento()
	};
	const deps = { log: () => {}, warn: () => {}, error: () => {} };
	return new CacheManager(context, deps, 1);
}

function writeAged(dir: string, name: string, ageMs: number): void {
	const filePath = path.join(dir, name);
	fs.writeFileSync(filePath, '{}');
	const past = new Date(Date.now() - ageMs);
	fs.utimesSync(filePath, past, past);
}

test('getCacheIdentifier: returns a stable "dev" id in Development mode, independent of vscode.env.sessionId', () => {
	const dir = makeTmpFixtureDir('ctt-dev-cleanup-');
	const manager = makeDevManager(dir);
	assert.equal(manager.getCacheIdentifier(), 'dev');
	// Calling it again (simulating a later debug relaunch with a different session) must
	// still return the same identifier so the on-disk snapshot is reused, not orphaned.
	assert.equal(manager.getCacheIdentifier(), 'dev');
});

test('getCacheIdentifier: returns "prod" in production mode', () => {
	const dir = makeTmpFixtureDir('ctt-dev-cleanup-');
	const manager = makeProdManager(dir);
	assert.equal(manager.getCacheIdentifier(), 'prod');
});

test('cleanupStaleDevCacheFiles: removes dev cache/lock files older than 24h', async () => {
	const dir = makeTmpFixtureDir('ctt-dev-cleanup-');
	writeAged(dir, 'cache_dev-aaaaaaaa.snapshot.json', 25 * 60 * 60 * 1000);
	writeAged(dir, 'refresh_dev-bbbbbbbb.lock', 48 * 60 * 60 * 1000);

	const manager = makeDevManager(dir);
	await manager.cleanupStaleDevCacheFiles();

	assert.deepEqual(fs.readdirSync(dir), []);
});

test('cleanupStaleDevCacheFiles: leaves recent dev cache/lock files untouched', async () => {
	const dir = makeTmpFixtureDir('ctt-dev-cleanup-');
	writeAged(dir, 'cache_dev-cccccccc.snapshot.json', 60 * 1000); // 1 minute old

	const manager = makeDevManager(dir);
	await manager.cleanupStaleDevCacheFiles();

	assert.deepEqual(fs.readdirSync(dir), ['cache_dev-cccccccc.snapshot.json']);
});

test('cleanupStaleDevCacheFiles: leaves non-dev files (e.g. prod snapshot) untouched', async () => {
	const dir = makeTmpFixtureDir('ctt-dev-cleanup-');
	writeAged(dir, 'cache_prod.snapshot.json', 48 * 60 * 60 * 1000);
	writeAged(dir, 'cache_dev-dddddddd.snapshot.json', 48 * 60 * 60 * 1000);

	const manager = makeDevManager(dir);
	await manager.cleanupStaleDevCacheFiles();

	assert.deepEqual(fs.readdirSync(dir), ['cache_prod.snapshot.json']);
});

test('cleanupStaleDevCacheFiles: no-op in production mode', async () => {
	const dir = makeTmpFixtureDir('ctt-dev-cleanup-');
	writeAged(dir, 'cache_dev-eeeeeeee.snapshot.json', 48 * 60 * 60 * 1000);

	const manager = makeProdManager(dir);
	await manager.cleanupStaleDevCacheFiles();

	assert.deepEqual(fs.readdirSync(dir), ['cache_dev-eeeeeeee.snapshot.json']);
});

test('cleanupStaleDevCacheFiles: no-op when globalStorage directory does not exist', async () => {
	const dir = reserveTmpFixturePath('ctt-dev-cleanup-missing-');
	const manager = makeDevManager(dir);
	await assert.doesNotReject(manager.cleanupStaleDevCacheFiles());
});
