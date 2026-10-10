import test from 'node:test';
import * as assert from 'node:assert/strict';

import { startEventLoopMonitor, type EventLoopLagReport } from '../../src/utils/eventLoopMonitor';

/** Blocks the event loop synchronously for `ms` — the exact failure mode being monitored. */
function blockFor(ms: number): void {
	const until = Date.now() + ms;
	while (Date.now() < until) { /* spin */ }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits for `condition`, up to a generous deadline, so a loaded CI runner delaying the report timer cannot fail the test. */
async function waitFor(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition() && Date.now() < deadline) { await sleep(20); }
}

test('reports a stall when the event loop is blocked past the threshold', async () => {
	const stalls: EventLoopLagReport[] = [];
	const monitor = startEventLoopMonitor({
		resolutionMs: 10,
		reportIntervalMs: 100,
		stallThresholdMs: 150,
		onStall: (r) => stalls.push(r),
	});
	try {
		await sleep(30);
		blockFor(400);
		await waitFor(() => stalls.length >= 1);
		assert.ok(stalls.length >= 1, 'a 400ms synchronous block must be reported');
		assert.ok(stalls[0].maxMs >= 150, `reported worst tick ${stalls[0].maxMs}ms should reach the threshold`);
		assert.ok(monitor.lastStall && monitor.lastStall.maxMs >= 150);
		assert.ok(monitor.worstMs >= 150);
	} finally {
		monitor.dispose();
	}
});

test('stays quiet while the loop is healthy', async () => {
	const stalls: EventLoopLagReport[] = [];
	const monitor = startEventLoopMonitor({
		resolutionMs: 10,
		reportIntervalMs: 50,
		stallThresholdMs: 2_000,
		onStall: (r) => stalls.push(r),
	});
	try {
		await sleep(250);
		assert.equal(stalls.length, 0);
		assert.equal(monitor.lastStall, undefined);
	} finally {
		monitor.dispose();
	}
});

test('a throwing onStall callback never breaks monitoring, and dispose is idempotent', async () => {
	let calls = 0;
	const monitor = startEventLoopMonitor({
		resolutionMs: 10,
		reportIntervalMs: 50,
		stallThresholdMs: 100,
		onStall: () => { calls++; throw new Error('logger blew up'); },
	});
	await sleep(20);
	blockFor(250);
	await waitFor(() => calls >= 1);
	blockFor(250);
	await waitFor(() => calls >= 2);
	monitor.dispose();
	monitor.dispose();
	assert.ok(calls >= 2, `monitor must keep reporting after a callback throws (got ${calls})`);
	const after = calls;
	blockFor(250);
	await sleep(120);
	assert.equal(calls, after, 'no reports after dispose');
});
