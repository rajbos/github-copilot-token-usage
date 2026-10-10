import './vscode-shim-register';
import test from 'node:test';
import * as assert from 'node:assert/strict';

import { SessionDiscovery } from '../../../src/sessionDiscovery';
import type { IEcosystemAdapter, DiscoveryResult } from '../../../src/ecosystemAdapter';

/**
 * Regression test for the "slow Cursor discovery blocks everyone else" bug:
 * SessionDiscovery.getCopilotSessionFilesStreaming() must invoke `onBatch` for
 * each adapter's files as soon as *that adapter* resolves, not only after
 * every adapter (including a slow one) has settled. Previously discovery
 * collected all Promise.allSettled results before calling onBatch even once,
 * so a slow adapter (e.g. Cursor's first-run sql.js/WASM init) delayed the
 * streaming worker pool in _preloadSessionFiles from starting on any file,
 * even ones already found by fast adapters.
 */
function makeFakeAdapter(id: string, files: string[], delayMs: number): IEcosystemAdapter {
	return {
		id,
		displayName: id,
		handles: () => false,
		getBackingPath: (f: string) => f,
		stat: async () => ({} as any),
		getTokens: async () => ({ tokens: 0, thinkingTokens: 0, actualTokens: 0 }),
		countInteractions: async () => 0,
		getModelUsage: async () => ({}),
		getMeta: async () => ({ title: undefined, firstInteraction: null, lastInteraction: null }),
		getEditorRoot: (f: string) => f,
		discover: async (): Promise<DiscoveryResult> => {
			await new Promise(resolve => setTimeout(resolve, delayMs));
			return { sessionFiles: files, candidatePaths: [] };
		},
		getCandidatePaths: () => [],
	} as unknown as IEcosystemAdapter;
}

test('SessionDiscovery streams fast adapter batches before a slow adapter resolves', async () => {
	const batchTimestamps: { source: string; atMs: number }[] = [];
	const start = Date.now();

	const fastAdapter = makeFakeAdapter('fast', ['/fake/fast/session1.json'], 5);
	const slowAdapter = makeFakeAdapter('slow-cursor', ['/fake/cursor/session2.json'], 150);

	const discovery = new SessionDiscovery({
		log: () => {},
		warn: () => {},
		error: () => {},
		ecosystems: [fastAdapter, slowAdapter],
	});

	let sawFastBatchBeforeSlowResolved = false;
	const files = await discovery.getCopilotSessionFilesStreaming((batch) => {
		const atMs = Date.now() - start;
		batchTimestamps.push({ source: batch[0], atMs });
		if (batch[0].includes('fast') && atMs < 100) {
			sawFastBatchBeforeSlowResolved = true;
		}
	});

	assert.equal(files.length, 2);
	assert.ok(sawFastBatchBeforeSlowResolved,
		'fast adapter batch should stream in well before the slow adapter\'s 150ms delay elapses');
	// The fast batch must be observed strictly before the slow one.
	const fastEntry = batchTimestamps.find(b => b.source.includes('fast'));
	const slowEntry = batchTimestamps.find(b => b.source.includes('cursor'));
	assert.ok(fastEntry && slowEntry && fastEntry.atMs < slowEntry.atMs,
		'fast adapter batch must arrive before slow adapter batch');
});

test('SessionDiscovery still reports adapter errors without blocking other batches', async () => {
	const fastAdapter = makeFakeAdapter('fast', ['/fake/fast/session1.json'], 5);
	const failingAdapter: IEcosystemAdapter = {
		...makeFakeAdapter('broken', [], 0),
		discover: async () => { throw new Error('boom'); },
	} as IEcosystemAdapter;

	const warnings: string[] = [];
	const discovery = new SessionDiscovery({
		log: () => {},
		warn: (msg: string) => warnings.push(msg),
		error: () => {},
		ecosystems: [fastAdapter, failingAdapter],
	});

	const files = await discovery.getCopilotSessionFilesStreaming();
	assert.deepEqual(files, ['/fake/fast/session1.json']);
	assert.ok(warnings.some(w => w.includes('broken')));
	assert.equal(discovery.lastDiscoveryHadError, true);
});

test('concurrent callers share one discovery pass instead of each scanning every adapter', async () => {
	// Each view that opens used to start its own full pass (25-95 s on a large history), all on one thread.
	let passes = 0;
	const adapter = makeFakeAdapter('slow', ['/fake/a.json', '/fake/b.json'], 60);
	const discoverOnce = (adapter as any).discover.bind(adapter) as (log: (m: string) => void) => Promise<unknown>;
	(adapter as any).discover = async (log: (m: string) => void) => { passes++; return discoverOnce(log); };

	const discovery = new SessionDiscovery({ log: () => {}, warn: () => {}, error: () => {}, ecosystems: [adapter] });
	const lateBatches: string[][] = [];
	const first = discovery.getCopilotSessionFilesStreaming();
	await new Promise(resolve => setTimeout(resolve, 20)); // mid-pass
	const second = discovery.getCopilotSessionFiles();
	const third = discovery.getCopilotSessionFilesStreaming((batch) => lateBatches.push(batch));
	const [a, b, c] = await Promise.all([first, second, third]);

	assert.equal(passes, 1, 'one pass for all three callers');
	assert.deepEqual(b, a);
	assert.deepEqual(c, a);
	assert.deepEqual(lateBatches.flat().sort(), ['/fake/a.json', '/fake/b.json'], 'a joining streaming caller still receives every batch');
});

test('a caller that joins after some batches were already emitted gets them replayed', async () => {
	const fast = makeFakeAdapter('fast', ['/fake/fast.json'], 5);
	const slow = makeFakeAdapter('slow', ['/fake/slow.json'], 120);
	const discovery = new SessionDiscovery({ log: () => {}, warn: () => {}, error: () => {}, ecosystems: [fast, slow] });
	const first = discovery.getCopilotSessionFiles();
	await new Promise(resolve => setTimeout(resolve, 50)); // fast adapter done, slow one still running
	const seen: string[] = [];
	const joined = discovery.getCopilotSessionFilesStreaming((batch) => seen.push(...batch));
	assert.ok(seen.includes('/fake/fast.json'), 'batches emitted before joining are replayed immediately');
	await Promise.all([first, joined]);
	assert.deepEqual(seen.sort(), ['/fake/fast.json', '/fake/slow.json']);
});

test('clearCache() makes the next caller start a fresh pass, and a stale pass does not repopulate the cache', async () => {
	let passes = 0;
	const adapter = makeFakeAdapter('a', ['/fake/a.json'], 40);
	const discoverOnce = (adapter as any).discover.bind(adapter) as (log: (m: string) => void) => Promise<unknown>;
	(adapter as any).discover = async (log: (m: string) => void) => { passes++; return discoverOnce(log); };
	const discovery = new SessionDiscovery({ log: () => {}, warn: () => {}, error: () => {}, ecosystems: [adapter] });

	const stale = discovery.getCopilotSessionFiles();
	await new Promise(resolve => setTimeout(resolve, 10));
	discovery.clearCache();
	const fresh = discovery.getCopilotSessionFiles();
	await Promise.all([stale, fresh]);
	assert.equal(passes, 2, 'the post-clear caller did not join the pre-clear pass');

	// The stale pass finished before the fresh one populated the cache; a third call is served from the fresh cache.
	await discovery.getCopilotSessionFiles();
	assert.equal(passes, 2);
});

test('a subscriber that throws does not abort discovery', async () => {
	const warnings: string[] = [];
	const discovery = new SessionDiscovery({ log: () => {}, warn: (m) => warnings.push(m), error: () => {}, ecosystems: [makeFakeAdapter('a', ['/fake/a.json'], 5)] });
	const files = await discovery.getCopilotSessionFilesStreaming(() => { throw new Error('consumer bug'); });
	assert.deepEqual(files, ['/fake/a.json']);
	assert.ok(warnings.some(w => /consumer bug/.test(w)));
});

test('sample-data mode honours clearCache(): a read that was pending across it does not restore the old directory', async () => {
	const fs = await import('node:fs');
	const os = await import('node:os');
	const path = await import('node:path');
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sample-discovery-'));
	const dirA = path.join(root, 'a'); const dirB = path.join(root, 'b');
	fs.mkdirSync(dirA); fs.mkdirSync(dirB);
	fs.writeFileSync(path.join(dirA, 'old.json'), '{}');
	fs.writeFileSync(path.join(dirB, 'new.json'), '{}');
	let current = dirA;
	try {
		const discovery = new SessionDiscovery({
			log: () => {}, warn: () => {}, error: () => {}, ecosystems: [],
			sampleDataDirectoryOverride: () => current,
		});
		const stale = discovery.getCopilotSessionFiles(); // reading dirA...
		discovery.clearCache();                           // ...cleared while it is pending
		current = dirB;
		await stale;
		const next = await discovery.getCopilotSessionFiles();
		assert.deepEqual(next.map((f) => path.basename(f)), ['new.json'], 'the cleared cache must not be repopulated by the stale read');
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('a late subscriber that throws while earlier batches are replayed does not break the join', async () => {
	const warnings: string[] = [];
	const fast = makeFakeAdapter('fast', ['/fake/fast.json'], 5);
	const slow = makeFakeAdapter('slow', ['/fake/slow.json'], 100);
	const discovery = new SessionDiscovery({ log: () => {}, warn: (m) => warnings.push(m), error: () => {}, ecosystems: [fast, slow] });
	const first = discovery.getCopilotSessionFiles();
	await new Promise(resolve => setTimeout(resolve, 40)); // the fast adapter's batch already exists
	const seen: string[] = [];
	let calls = 0;
	const joined = await discovery.getCopilotSessionFilesStreaming((batch) => {
		calls++;
		if (calls === 1) { throw new Error('late consumer bug'); } // throws on the replayed batch
		seen.push(...batch);
	});
	await first;
	assert.deepEqual(joined.sort(), ['/fake/fast.json', '/fake/slow.json'], 'the joined caller still gets the full result');
	assert.deepEqual(seen, ['/fake/slow.json'], 'and still receives the batches that arrive after the failed replay');
	assert.ok(warnings.some(w => /late consumer bug/.test(w)));
});

test('a pass detached by clearCache() does not leave its failure on the status of the fresh pass', async () => {
	// The old pass's adapter fails after clearCache(); the fresh pass succeeds. The fresh result must not look untrustworthy.
	let calls = 0;
	const flaky = makeFakeAdapter('flaky', ['/fake/a.json'], 60);
	(flaky as any).discover = async () => {
		calls++;
		if (calls === 1) { await new Promise(resolve => setTimeout(resolve, 80)); throw new Error('first pass adapter failed'); }
		await new Promise(resolve => setTimeout(resolve, 10));
		return { sessionFiles: ['/fake/a.json'], candidatePaths: [] };
	};
	const discovery = new SessionDiscovery({ log: () => {}, warn: () => {}, error: () => {}, ecosystems: [flaky] });
	const stale = discovery.getCopilotSessionFiles();
	await new Promise(resolve => setTimeout(resolve, 10));
	discovery.clearCache();
	const fresh = discovery.getCopilotSessionFiles();
	await Promise.all([fresh, stale]); // the stale pass fails last
	assert.equal(discovery.lastDiscoveryHadError, false, 'the stale pass failure must not mark the fresh result as errored');
	assert.equal(discovery.lastDiscoveryFilesCount, 1);
});

test('a discovery pass that fails is still reported as errored when it is the current one', async () => {
	const broken = makeFakeAdapter('broken', [], 5);
	(broken as any).discover = async () => { throw new Error('adapter failed'); };
	const discovery = new SessionDiscovery({ log: () => {}, warn: () => {}, error: () => {}, ecosystems: [broken, makeFakeAdapter('ok', ['/fake/ok.json'], 5)] });
	const files = await discovery.getCopilotSessionFiles();
	assert.deepEqual(files, ['/fake/ok.json']);
	assert.equal(discovery.lastDiscoveryHadError, true);
	assert.equal(discovery.lastDiscoveryFilesCount, 1);
});
