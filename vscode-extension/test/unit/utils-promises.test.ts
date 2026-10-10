import test from 'node:test';
import * as assert from 'node:assert/strict';

import { createSemaphore, createWakeupGate, TimeoutError, withTimeout, yieldToEventLoop } from '../../src/utils/promises';

/**
 * Deterministic event-loop yield for "confirm nothing resolved yet"/"let a pending .then() run"
 * assertions below — unlike a wall-clock `setTimeout(..., N)`, this has no timing window that can
 * flake under CI load and doesn't slow the suite down waiting out an arbitrary delay.
 */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test('yieldToEventLoop lets queued host work run before a file scan continues', async () => {
	const order: string[] = [];
	setImmediate(() => { order.push('button command'); });
	await yieldToEventLoop();
	order.push('next file');
	assert.deepEqual(order, ['button command', 'next file']);
});

test('createWakeupGate: signal resolves all currently parked waiters', async () => {
	const gate = createWakeupGate();
	const order: number[] = [];
	const a = gate.wait().then(() => order.push(1));
	const b = gate.wait().then(() => order.push(2));
	gate.signal();
	await Promise.all([a, b]);
	assert.deepEqual(order.sort(), [1, 2]);
});

test('createWakeupGate: signal with no waiters is a no-op and does not affect later waits', async () => {
	const gate = createWakeupGate();
	gate.signal(); // nobody waiting yet
	let resolved = false;
	const p = gate.wait().then(() => { resolved = true; });
	// The earlier signal must NOT satisfy this later wait.
	await tick();
	assert.equal(resolved, false);
	gate.signal();
	await p;
	assert.equal(resolved, true);
});

test('createWakeupGate: a fresh wait after signal stays parked until the next signal', async () => {
	const gate = createWakeupGate();
	const first = gate.wait();
	gate.signal();
	await first;

	let secondResolved = false;
	const second = gate.wait().then(() => { secondResolved = true; });
	await tick();
	assert.equal(secondResolved, false);
	gate.signal();
	await second;
	assert.equal(secondResolved, true);
});

test('createWakeupGate: producer/consumer drains all items without polling', async () => {
	const gate = createWakeupGate();
	const queue: number[] = [];
	let readIndex = 0;
	let done = false;
	const consumed: number[] = [];

	const consumer = (async () => {
		while (true) {
			if (readIndex >= queue.length) {
				if (done) { break; }
				await gate.wait();
				continue;
			}
			consumed.push(queue[readIndex++]);
		}
	})();

	const producer = (async () => {
		for (let i = 0; i < 5; i++) {
			await tick();
			queue.push(i);
			gate.signal();
		}
		done = true;
		gate.signal();
	})();

	await Promise.all([consumer, producer]);
	assert.deepEqual(consumed, [0, 1, 2, 3, 4]);
});

test('withTimeout: resolves when the promise settles in time', async () => {
	const result = await withTimeout(Promise.resolve('ok'), 1000, 'op');
	assert.equal(result, 'ok');
});

test('withTimeout: rejects with a descriptive error when it times out', async () => {
	await assert.rejects(
		withTimeout(new Promise(() => { /* never settles */ }), 10, 'slow op'),
		(error: Error) => error instanceof TimeoutError && error.message === 'slow op timed out after 10ms',
	);
});

test('withTimeout: does not cancel work that can be deferred after a timeout', async () => {
	let resolveWork: ((value: string) => void) | undefined;
	const work = new Promise<string>((resolve) => { resolveWork = resolve; });

	await assert.rejects(
		withTimeout(work, 10, 'deferred session'),
		/deferred session timed out after 10ms/,
	);

	resolveWork?.('cached');
	assert.equal(await work, 'cached');
});

test('createSemaphore: acquire() resolves immediately while permits remain', async () => {
	const sem = createSemaphore(2);
	assert.equal(await sem.acquire(), true);
	assert.equal(await sem.acquire(), true);
});

test('createSemaphore: acquire() blocks once permits are exhausted, until a release()', async () => {
	const sem = createSemaphore(1);
	assert.equal(await sem.acquire(), true);

	let acquired = false;
	const pending = sem.acquire().then((ok) => { acquired = ok; });
	await tick();
	assert.equal(acquired, false, 'must not acquire while the sole permit is still held');

	sem.release();
	await pending;
	assert.equal(acquired, true);
});

test('createSemaphore: release() admits exactly one waiter, not every parked caller', async () => {
	// The bug this guards against: a WakeupGate-style "wake everyone" release would let every
	// parked acquire() past a single release(), so the count of concurrent holders could grow
	// unbounded instead of by exactly one per release — see createSemaphore's own doc comment.
	const sem = createSemaphore(1);
	assert.equal(await sem.acquire(), true); // the only permit is now held

	const results: boolean[] = [];
	const waiterA = sem.acquire().then((ok) => { results.push(ok); return ok; });
	const waiterB = sem.acquire().then((ok) => { results.push(ok); return ok; });
	await tick();
	assert.deepEqual(results, [], 'neither waiter may acquire before a release()');

	sem.release();
	// Give the event loop a turn to settle whichever waiter the release granted.
	await tick();
	assert.equal(results.length, 1, 'exactly one waiter must be admitted per release()');

	sem.release();
	await Promise.all([waiterA, waiterB]);
	assert.deepEqual(results.sort(), [true, true], 'the second release() admits the remaining waiter');
});

test('createSemaphore: a timed-out acquire() resolves false and does not consume a later release()', async () => {
	const sem = createSemaphore(1);
	assert.equal(await sem.acquire(), true); // hold the only permit

	const timedOut = await sem.acquire(5);
	assert.equal(timedOut, false, 'must resolve false once the timeout elapses without a release()');

	// The timed-out waiter must have unregistered itself: a later release() should return the
	// permit to the pool (available for a fresh acquire()), not resolve the already-settled,
	// abandoned waiter a second time.
	sem.release();
	assert.equal(await sem.acquire(), true, 'the released permit must be available to a brand-new acquire()');
});

test('createSemaphore: acquire() rejects an invalid timeoutMs instead of letting it reach setTimeout() uncoerced', async () => {
	const sem = createSemaphore(1);
	await sem.acquire(); // hold the only permit so the next acquire() would actually need timeoutMs

	// Node coerces an invalid setTimeout delay (NaN, negative, Infinity) rather than throwing, which
	// would otherwise surface as a confusing immediate false timeout instead of a clear failure at
	// the call site that got it wrong.
	await assert.rejects(async () => sem.acquire(NaN), RangeError);
	await assert.rejects(async () => sem.acquire(-1), RangeError);
	await assert.rejects(async () => sem.acquire(Infinity), RangeError);
});

test('createSemaphore: rejects a zero-capacity request instead of silently accepting a permit count release() cannot actually enforce', () => {
	// release() hands a freed permit straight to the longest-waiting acquire() without re-checking
	// the cap, so a semaphore constructed with 0 permits would still admit a waiter on any
	// release() call, defeating the "zero concurrent holders" invariant such a caller would want.
	assert.throws(() => createSemaphore(0), RangeError);
});

test('createSemaphore: rejects negative and non-integer permit counts', () => {
	assert.throws(() => createSemaphore(-1), RangeError);
	assert.throws(() => createSemaphore(1.5), RangeError);
	assert.throws(() => createSemaphore(Infinity), RangeError);
});

test('createSemaphore: an over-release with no waiter parked does not widen the permit count', async () => {
	// Scoped to the no-waiter case deliberately: release() cannot in general tell a legitimate
	// release apart from a spurious/duplicate one (it takes no token identifying which acquire()
	// it corresponds to), so an over-release racing a *parked* waiter can still admit an extra
	// holder — see release()'s own "KNOWN LIMITATION" comment. This test covers what the clamp
	// below actually closes: a caller bug that releases extra times with nothing waiting.
	const sem = createSemaphore(1);
	assert.equal(await sem.acquire(), true); // the only permit is now held

	// A caller bug — releasing twice for one acquire — must not let two concurrent holders in.
	sem.release();
	sem.release();
	sem.release();

	assert.equal(await sem.acquire(), true, 'a fresh acquire() must still succeed after the (clamped) over-releases');

	let secondAcquired = false;
	const pending = sem.acquire().then((ok) => { secondAcquired = ok; });
	await tick();
	assert.equal(secondAcquired, false,
		'a second concurrent acquire() must still block — the over-releases above must not have widened the cap past its original 1 permit');

	sem.release();
	await pending;
	assert.equal(secondAcquired, true);
});
