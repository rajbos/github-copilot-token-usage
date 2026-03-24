/**
 * Tests for display names storage and management.
 */

import './vscode-shim-register';
import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { DisplayNameStore } from '../../src/backend/displayNames';

function makeGlobalState(): vscode.Memento & { storage: Map<string, any> } {
	const storage = new Map<string, any>();
	return {
		storage,
		get: (key: string, defaultValue?: any) => storage.get(key) ?? defaultValue,
		update: async (key: string, value: any) => { storage.set(key, value); },
		keys: () => Array.from(storage.keys())
	};
}

// ── getWorkspaceName / getMachineName ─────────────────────────────────────

test('getWorkspaceName returns truncated ID when no name set', () => {
	const gs = makeGlobalState();
	const store = new DisplayNameStore(gs);
	assert.equal(store.getWorkspaceName('abc123def456ghi789'), 'abc123...');
});

test('getWorkspaceName returns display name when set', async () => {
	const gs = makeGlobalState();
	const store = new DisplayNameStore(gs);
	await store.setWorkspaceName('ws-1', 'My Project');
	assert.equal(store.getWorkspaceName('ws-1'), 'My Project');
});

test('getWorkspaceName returns short ID as-is', () => {
	const gs = makeGlobalState();
	const store = new DisplayNameStore(gs);
	assert.equal(store.getWorkspaceName('abc'), 'abc');
});

test('getWorkspaceName returns unknown for empty ID', () => {
	const gs = makeGlobalState();
	const store = new DisplayNameStore(gs);
	assert.equal(store.getWorkspaceName(''), 'unknown');
});

test('getMachineName returns truncated ID and display name', async () => {
	const gs = makeGlobalState();
	const store = new DisplayNameStore(gs);
	assert.equal(store.getMachineName('machine-abc123def456'), 'machin...');
	await store.setMachineName('m-1', 'Main Laptop');
	assert.equal(store.getMachineName('m-1'), 'Main Laptop');
});

// ── Raw name access ──────────────────────────────────────────────────────

test('getWorkspaceNameRaw returns undefined when no name set', () => {
	const gs = makeGlobalState();
	const store = new DisplayNameStore(gs);
	assert.equal(store.getWorkspaceNameRaw('ws-1'), undefined);
});

test('getWorkspaceNameRaw returns name when set', async () => {
	const gs = makeGlobalState();
	const store = new DisplayNameStore(gs);
	await store.setWorkspaceName('ws-1', 'Test');
	assert.equal(store.getWorkspaceNameRaw('ws-1'), 'Test');
});

test('getWorkspaceNameRaw returns undefined for whitespace-only name', async () => {
	const gs = makeGlobalState();
	const store = new DisplayNameStore(gs);
	await store.setWorkspaceName('ws-1', '   ');
	assert.equal(store.getWorkspaceNameRaw('ws-1'), undefined);
});

test('getMachineNameRaw returns undefined when no name set', () => {
	const gs = makeGlobalState();
	const store = new DisplayNameStore(gs);
	assert.equal(store.getMachineNameRaw('m-1'), undefined);
});

test('getMachineNameRaw returns name when set', async () => {
	const gs = makeGlobalState();
	const store = new DisplayNameStore(gs);
	await store.setMachineName('m-1', 'Laptop');
	assert.equal(store.getMachineNameRaw('m-1'), 'Laptop');
});

// ── setWorkspaceName / setMachineName ────────────────────────────────────

test('setWorkspaceName trims whitespace', async () => {
	const gs = makeGlobalState();
	const store = new DisplayNameStore(gs);
	await store.setWorkspaceName('ws-1', '  Project Beta  ');
	assert.equal(store.getWorkspaceName('ws-1'), 'Project Beta');
});

test('setWorkspaceName removes name on empty or undefined', async () => {
	const gs = makeGlobalState();
	const store = new DisplayNameStore(gs);
	await store.setWorkspaceName('ws-1', 'Test');
	await store.setWorkspaceName('ws-1', '');
	assert.equal(store.getWorkspaceNameRaw('ws-1'), undefined);

	await store.setWorkspaceName('ws-2', 'Test2');
	await store.setWorkspaceName('ws-2', undefined);
	assert.equal(store.getWorkspaceNameRaw('ws-2'), undefined);
});

test('setWorkspaceName rejects names longer than 64 characters', async () => {
	const gs = makeGlobalState();
	const store = new DisplayNameStore(gs);
	await assert.rejects(() => store.setWorkspaceName('ws-1', 'A'.repeat(65)), /64 characters/);
});

test('setWorkspaceName accepts name exactly 64 characters', async () => {
	const gs = makeGlobalState();
	const store = new DisplayNameStore(gs);
	const name = 'A'.repeat(64);
	await store.setWorkspaceName('ws-1', name);
	assert.equal(store.getWorkspaceName('ws-1'), name);
});

test('setMachineName sets and trims', async () => {
	const gs = makeGlobalState();
	const store = new DisplayNameStore(gs);
	await store.setMachineName('m-1', '  Work Laptop  ');
	assert.equal(store.getMachineName('m-1'), 'Work Laptop');
});

test('setMachineName removes on empty', async () => {
	const gs = makeGlobalState();
	const store = new DisplayNameStore(gs);
	await store.setMachineName('m-1', 'Test');
	await store.setMachineName('m-1', '');
	assert.equal(store.getMachineNameRaw('m-1'), undefined);
});

test('setMachineName rejects names longer than 64 characters', async () => {
	const gs = makeGlobalState();
	const store = new DisplayNameStore(gs);
	await assert.rejects(() => store.setMachineName('m-1', 'M'.repeat(65)), /64 characters/);
});

// ── Bulk getters and clearers ────────────────────────────────────────────

test('getAllWorkspaceNames returns copy of all names', async () => {
	const gs = makeGlobalState();
	const store = new DisplayNameStore(gs);
	assert.deepEqual(store.getAllWorkspaceNames(), {});
	await store.setWorkspaceName('ws-1', 'A');
	await store.setWorkspaceName('ws-2', 'B');
	assert.deepEqual(store.getAllWorkspaceNames(), { 'ws-1': 'A', 'ws-2': 'B' });
	// Mutation of returned object shouldn't affect store
	const copy = store.getAllWorkspaceNames();
	copy['ws-3'] = 'C';
	assert.equal(store.getAllWorkspaceNames()['ws-3'], undefined);
});

test('getAllMachineNames returns all names', async () => {
	const gs = makeGlobalState();
	const store = new DisplayNameStore(gs);
	assert.deepEqual(store.getAllMachineNames(), {});
	await store.setMachineName('m-1', 'Laptop');
	assert.deepEqual(store.getAllMachineNames(), { 'm-1': 'Laptop' });
});

test('clearAllWorkspaceNames clears workspace names only', async () => {
	const gs = makeGlobalState();
	const store = new DisplayNameStore(gs);
	await store.setWorkspaceName('ws-1', 'Project');
	await store.setMachineName('m-1', 'Laptop');
	await store.clearAllWorkspaceNames();
	assert.deepEqual(store.getAllWorkspaceNames(), {});
	assert.equal(store.getMachineName('m-1'), 'Laptop');
});

test('clearAllMachineNames clears machine names only', async () => {
	const gs = makeGlobalState();
	const store = new DisplayNameStore(gs);
	await store.setWorkspaceName('ws-1', 'Project');
	await store.setMachineName('m-1', 'Laptop');
	await store.clearAllMachineNames();
	assert.deepEqual(store.getAllMachineNames(), {});
	assert.equal(store.getWorkspaceName('ws-1'), 'Project');
});

test('clearAll clears everything', async () => {
	const gs = makeGlobalState();
	const store = new DisplayNameStore(gs);
	await store.setWorkspaceName('ws-1', 'P');
	await store.setMachineName('m-1', 'M');
	await store.clearAll();
	assert.deepEqual(store.getAllWorkspaceNames(), {});
	assert.deepEqual(store.getAllMachineNames(), {});
});

// ── hasWorkspaceName / hasMachineName ────────────────────────────────────

test('hasWorkspaceName and hasMachineName track set/unset', async () => {
	const gs = makeGlobalState();
	const store = new DisplayNameStore(gs);
	assert.equal(store.hasWorkspaceName('ws-1'), false);
	await store.setWorkspaceName('ws-1', 'Test');
	assert.equal(store.hasWorkspaceName('ws-1'), true);
	await store.setWorkspaceName('ws-1', '');
	assert.equal(store.hasWorkspaceName('ws-1'), false);

	assert.equal(store.hasMachineName('m-1'), false);
	await store.setMachineName('m-1', 'Laptop');
	assert.equal(store.hasMachineName('m-1'), true);
});

// ── Persistence ──────────────────────────────────────────────────────────

test('names persist across store instances', async () => {
	const gs = makeGlobalState();
	const store1 = new DisplayNameStore(gs);
	await store1.setWorkspaceName('ws-1', 'Persistent');
	await store1.setMachineName('m-1', 'Machine');

	const store2 = new DisplayNameStore(gs);
	assert.equal(store2.getWorkspaceName('ws-1'), 'Persistent');
	assert.equal(store2.getMachineName('m-1'), 'Machine');
});
