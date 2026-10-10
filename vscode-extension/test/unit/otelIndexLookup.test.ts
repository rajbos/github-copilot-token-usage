import test from 'node:test';
import * as assert from 'node:assert/strict';
import { createWorkerOtelLookup, type WorkerOtelLookupDeps } from '../../src/otelIndexLookup';

function fakeDeps() {
	let ready = false;
	const listeners = new Set<() => void>();
	const deps: WorkerOtelLookupDeps = {
		whenReady: async () => ready,
		onReady: (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
		getUsage: async () => ({ modelUsage: {}, actualTokens: 7, cacheReadTokens: 0, nanoAiu: 0 }),
	};
	return { deps, becomeReady: () => { ready = true; for (const l of [...listeners]) { l(); } }, listeners };
}

test('a question asked while the index is still being built fails at once, and the owner is told when it is ready', async () => {
	const { deps, becomeReady } = fakeDeps();
	let told = 0;
	const lookup = createWorkerOtelLookup(10, () => { told++; }, deps);
	await assert.rejects(lookup.resolve('a'), /still being built/);
	await assert.rejects(lookup.resolve('b'), /still being built/);
	becomeReady();
	assert.equal(told, 1, 'told once, however many questions failed');
	assert.equal((await lookup.resolve('a'))?.actualTokens, 7, 'answers from the index once it is ready');
	lookup.dispose();
});

test('the owner is not told about an index that became ready without any question having failed', () => {
	const { deps, becomeReady } = fakeDeps();
	let told = 0;
	createWorkerOtelLookup(10, () => { told++; }, deps);
	becomeReady();
	assert.equal(told, 0);
});

test('disposing stops the notification', async () => {
	const { deps, becomeReady, listeners } = fakeDeps();
	let told = 0;
	const lookup = createWorkerOtelLookup(10, () => { told++; }, deps);
	await assert.rejects(lookup.resolve('a'));
	lookup.dispose();
	assert.equal(listeners.size, 0);
	becomeReady();
	assert.equal(told, 0);
});
