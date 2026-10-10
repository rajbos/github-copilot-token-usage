import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';

// The render and interaction loops run their targets through this pool. Its
// output order decides screenshot report order, and its failure handling
// decides whether a browser is closed while pages are still using it, so both
// are pinned down here. Loaded by path like the other visual-view-diff helpers.
const requireFromHere = createRequire(__filename);

function findSkillLib(): string {
	let dir = __dirname;
	for (let i = 0; i < 10; i++) {
		const candidate = path.join(dir, '.github', 'skills', 'visual-view-diff', 'lib', 'pool.js');
		if (fs.existsSync(candidate)) {
			return candidate;
		}
		dir = path.dirname(dir);
	}
	throw new Error(`Could not locate visual-view-diff/lib/pool.js from ${__dirname}`);
}

const pool = requireFromHere(findSkillLib()) as {
	DEFAULT_CONCURRENCY: number;
	parseConcurrency: (value: unknown, fallback?: number) => number;
	runPool: <T, R>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<R>) => Promise<R[]>;
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('runPool returns results in input order, not completion order', async () => {
	// Later items finish first.
	const results = await pool.runPool([30, 20, 10, 0], 4, async (ms, index) => {
		await delay(ms);
		return `${index}:${ms}`;
	});
	assert.deepEqual(results, ['0:30', '1:20', '2:10', '3:0']);
});

test('runPool never has more than `concurrency` workers in flight', async () => {
	let inFlight = 0;
	let peak = 0;
	await pool.runPool(Array.from({ length: 10 }, (_, i) => i), 3, async () => {
		inFlight++;
		peak = Math.max(peak, inFlight);
		await delay(5);
		inFlight--;
	});
	assert.equal(peak, 3);
});

test('runPool handles an empty list and a concurrency larger than the list', async () => {
	assert.deepEqual(await pool.runPool([], 4, async () => 1), []);
	assert.deepEqual(await pool.runPool([1, 2], 8, async (n) => n * 2), [2, 4]);
});

test('runPool stops starting work after a failure, lets in-flight work finish, then rethrows', async () => {
	const started: number[] = [];
	const finished: number[] = [];
	await assert.rejects(
		pool.runPool([0, 1, 2, 3, 4, 5], 2, async (n) => {
			started.push(n);
			if (n === 0) {
				throw new Error('boom');
			}
			await delay(20);
			finished.push(n);
		}),
		/boom/,
	);
	// Item 1 was already running when item 0 failed; it must be allowed to
	// complete before runPool settles, and nothing after it may start.
	assert.deepEqual(started, [0, 1]);
	assert.deepEqual(finished, [1]);
});

test('parseConcurrency accepts positive integers and rejects everything else', () => {
	assert.equal(pool.parseConcurrency(undefined), pool.DEFAULT_CONCURRENCY);
	assert.equal(pool.parseConcurrency(undefined, 2), 2);
	assert.equal(pool.parseConcurrency('6'), 6);
	assert.equal(pool.parseConcurrency('1'), 1);
	for (const bad of ['0', '-1', '2.5', 'abc', true]) {
		assert.throws(() => pool.parseConcurrency(bad), /positive integer/);
	}
});
