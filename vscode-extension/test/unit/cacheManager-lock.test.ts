import './vscode-shim-register';
import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { CacheManager } from '../../src/cacheManager';

function makeManager(dir: string): CacheManager {
	const context: any = {
		extensionMode: 1, // Production
		globalStorageUri: { fsPath: dir },
		globalState: {
			get: () => undefined,
			update: async () => {}
		}
	};
	const deps = { log: () => {}, warn: () => {}, error: () => {} };
	return new CacheManager(context, deps, 1);
}

function makeDirAndManager(): { dir: string; manager: CacheManager; logs: string[] } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctt-lock-test-'));
	const logs: string[] = [];
	const context: any = {
		extensionMode: 1,
		globalStorageUri: { fsPath: dir },
		globalState: { get: () => undefined, update: async () => {} }
	};
	const deps = { log: (m: string) => logs.push(m), warn: () => {}, error: () => {} };
	const manager = new CacheManager(context, deps, 1);
	return { dir, manager, logs };
}

test('acquireCacheLock: succeeds when no lock file exists', async () => {
	const { manager } = makeDirAndManager();
	const acquired = await manager.acquireCacheLock();
	assert.equal(acquired, true);
	await manager.releaseCacheLock();
});

test('acquireCacheLock: lock file contains pid field', async () => {
	const { dir, manager } = makeDirAndManager();
	await manager.acquireCacheLock();
	const lockPath = manager.getCacheLockPath();
	const content = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
	assert.equal(typeof content.pid, 'number', 'Lock file should contain a numeric pid');
	assert.equal(content.pid, process.pid, 'Lock file pid should match current process pid');
	await manager.releaseCacheLock();
});

test('acquireCacheLock: returns false when active lock held by live process', async () => {
	const { dir, manager } = makeDirAndManager();
	// Write a lock file owned by the current (live) process with a fresh timestamp
	const lockPath = manager.getCacheLockPath();
	fs.mkdirSync(path.dirname(lockPath), { recursive: true });
	fs.writeFileSync(lockPath, JSON.stringify({
		sessionId: 'other-session',
		pid: process.pid, // still alive
		timestamp: Date.now()
	}));

	const manager2 = makeManager(dir);
	const acquired = await manager2.acquireCacheLock();
	assert.equal(acquired, false, 'Should not acquire lock held by a live process');

	// Clean up
	fs.unlinkSync(lockPath);
});

test('acquireCacheLock: breaks lock whose owner PID is dead', async () => {
	const { dir, manager, logs } = makeDirAndManager();
	const lockPath = manager.getCacheLockPath();
	fs.mkdirSync(path.dirname(lockPath), { recursive: true });

	// Use a PID that cannot exist on any OS (> 4 million is always invalid)
	const deadPid = 4_000_001;
	fs.writeFileSync(lockPath, JSON.stringify({
		sessionId: 'dead-session',
		pid: deadPid,
		timestamp: Date.now() // fresh timestamp — would NOT be broken by time-based check alone
	}));

	const acquired = await manager.acquireCacheLock();
	assert.equal(acquired, true, 'Should acquire lock when owner PID is dead');
	assert.ok(
		logs.some(l => l.includes('no longer running')),
		'Should log that the owner process is no longer running'
	);
	await manager.releaseCacheLock();
});

test('acquireCacheLock: breaks stale lock even without pid field (backward compat)', async () => {
	const { dir, manager, logs } = makeDirAndManager();
	const lockPath = manager.getCacheLockPath();
	fs.mkdirSync(path.dirname(lockPath), { recursive: true });

	// Old-format lock (no pid), with stale timestamp
	fs.writeFileSync(lockPath, JSON.stringify({
		sessionId: 'old-session',
		timestamp: Date.now() - (10 * 60 * 1000) // 10 minutes ago
	}));

	const acquired = await manager.acquireCacheLock();
	assert.equal(acquired, true, 'Should acquire a stale lock with no pid field');
	assert.ok(
		logs.some(l => l.includes('Breaking stale cache lock')),
		'Should log stale lock break'
	);
	await manager.releaseCacheLock();
});

test('releaseCacheLock: only releases own lock', async () => {
	const { dir, manager } = makeDirAndManager();
	const lockPath = manager.getCacheLockPath();
	fs.mkdirSync(path.dirname(lockPath), { recursive: true });

	// Write a lock belonging to a different session
	fs.writeFileSync(lockPath, JSON.stringify({
		sessionId: 'foreign-session',
		pid: process.pid,
		timestamp: Date.now()
	}));

	// The manager (with a different sessionId from the shim) should NOT delete the foreign lock
	await manager.releaseCacheLock();
	assert.ok(fs.existsSync(lockPath), 'Foreign lock should not be deleted');

	// Clean up
	fs.unlinkSync(lockPath);
});
