import test from 'node:test';
import * as assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
	AnalysisWorkerPool,
	AnalysisWorkerError,
	type WorkerLike,
	type AnalysisWorkerPoolOptions,
} from '../../src/analysis/analysisWorkerPool';
import type { AnalysisHostMessage, AnalysisRequest, AnalysisWorkerMessage, OtelUsageReply } from '../../src/analysis/analysisProtocol';
import type { SessionFileCache } from '../../../src/types';

/** A worker whose behaviour the test drives by hand: no threads, no timing. */
class FakeWorker extends EventEmitter implements WorkerLike {
	readonly received: AnalysisRequest[] = [];
	/** What the host answered to this worker's exact-usage questions. */
	readonly replies: OtelUsageReply[] = [];
	terminated = false;
	/** How long after terminate() the exit event is delivered; real termination is asynchronous. */
	exitDelayMs = 0;
	postMessage(message: AnalysisHostMessage): void {
		if ('type' in message && message.type === 'otelUsageReply') { this.replies.push(message); }
		else { this.received.push(message as AnalysisRequest); }
	}
	terminate(): Promise<number> {
		this.terminated = true;
		// Like a real worker, termination is observable as an exit event.
		if (this.exitDelayMs > 0) { setTimeout(() => this.emit('exit', 1), this.exitDelayMs); }
		else { queueMicrotask(() => this.emit('exit', 1)); }
		return Promise.resolve(1);
	}
	private readySent = false;
	/** A real worker announces `ready` once its bundle has initialised; tests that care about startup control it. */
	announceReady(): void {
		if (this.readySent) { return; }
		this.readySent = true;
		this.emit('message', { type: 'ready' });
	}
	reply(message: AnalysisWorkerMessage): void { this.announceReady(); this.emit('message', message); }
	crash(message = 'boom'): void { this.announceReady(); this.emit('error', new Error(message)); this.emit('exit', 1); }
	/** The bundle failed while loading: the worker dies without ever saying `ready`. */
	crashBeforeReady(message = 'failed to load'): void { this.readySent = true; this.emit('error', new Error(message)); this.emit('exit', 1); }
	// `on` is inherited from EventEmitter; the overloads in WorkerLike are structurally satisfied.
}

const entry = (tokens: number): SessionFileCache => ({ tokens, interactions: 1, modelUsage: {}, mtime: 1, size: 1 });
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function makePool(overrides: Partial<AnalysisWorkerPoolOptions> = {}, fake: { exitDelayMs?: number } = {}) {
	const workers: FakeWorker[] = [];
	const warnings: string[] = [];
	const pool = new AnalysisWorkerPool({
		workerPath: 'unused',
		extensionPath: 'unused',
		size: 2,
		log: () => undefined,
		warn: (m) => warnings.push(m),
		createWorker: () => { const w = new FakeWorker(); w.exitDelayMs = fake.exitDelayMs ?? 0; workers.push(w); return w; },
		...overrides,
	});
	return { pool, workers, warnings };
}

test('resolves an analyze request with the worker result', async () => {
	const { pool, workers } = makePool();
	const promise = pool.analyze('a.json', 10, 20, 'owner/repo');
	assert.equal(workers.length, 1);
	assert.deepEqual(workers[0].received[0], { id: 1, op: 'analyze', path: 'a.json', mtime: 10, size: 20, existingRepository: 'owner/repo' });
	workers[0].reply({ type: 'result', id: 1, ok: true, result: entry(42) });
	assert.equal((await promise).tokens, 42);
	await pool.dispose();
});

test('a worker-reported error rejects as failed and keeps the Node error code', async () => {
	const { pool, workers } = makePool();
	const promise = pool.analyze('gone.json', 1, 1);
	workers[0].reply({ type: 'result', id: 1, ok: false, error: 'Error: ENOENT', code: 'ENOENT' });
	await assert.rejects(promise, (e: unknown) => e instanceof AnalysisWorkerError && e.kind === 'failed' && e.code === 'ENOENT');
	assert.equal(pool.isAvailable(), true, 'an analysis error says nothing about worker health');
	await pool.dispose();
});

test('supplement resolves null when the session has no usable debug log', async () => {
	const { pool, workers } = makePool();
	const promise = pool.supplement(entry(1), 'a.json');
	workers[0].reply({ type: 'result', id: 1, ok: true, result: null });
	assert.equal(await promise, null);
	await pool.dispose();
});

test('spreads concurrent requests across workers up to the pool size, then reuses the least loaded', async () => {
	const { pool, workers } = makePool({ size: 2 });
	const a = pool.analyze('a', 1, 1);
	const b = pool.analyze('b', 1, 1);
	const c = pool.analyze('c', 1, 1);
	assert.equal(workers.length, 2, 'a second worker is started when the first is busy');
	assert.equal(workers[0].received.length + workers[1].received.length, 3);
	for (const w of workers) { for (const r of w.received) { w.reply({ type: 'result', id: r.id, ok: true, result: entry(r.id) }); } }
	await Promise.all([a, b, c]);
	assert.equal(workers.length, 2, 'never grows past size');
	await pool.dispose();
});

test('when a worker dies mid-request the request is retried once on a fresh worker', async () => {
	const { pool, workers } = makePool({ size: 1 });
	const promise = pool.analyze('a.json', 1, 1);
	workers[0].crash();
	await tick();
	assert.equal(workers.length, 2, 'replacement worker spawned');
	assert.equal(workers[1].received.length, 1);
	workers[1].reply({ type: 'result', id: workers[1].received[0].id, ok: true, result: entry(7) });
	assert.equal((await promise).tokens, 7);
	await pool.dispose();
});

test('a request that kills two workers is rejected as failed, not unavailable, so it is never retried on the host', async () => {
	const { pool, workers } = makePool({ size: 1, maxRestarts: 50 });
	const promise = pool.analyze('a.json', 1, 1);
	workers[0].crash();
	await tick();
	workers[1].crash();
	await assert.rejects(promise, (e: unknown) => e instanceof AnalysisWorkerError && e.kind === 'failed');
	await pool.dispose();
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test('a hung analysis times out, its worker is killed, and innocent neighbours are retried', async () => {
	const { pool, workers } = makePool({ size: 1, requestTimeoutMs: 400 });
	const hung = pool.analyze('hung.json', 1, 1);
	workers[0].announceReady(); // a genuinely hung worker got past startup
	const hungOutcome = hung.then(() => 'resolved', (e: unknown) => (e instanceof AnalysisWorkerError ? e.kind : 'other'));
	// A second request joins the same worker later, so its own clock has not run out when the
	// first one's does — it must survive the kill of its neighbour.
	await sleep(200);
	const neighbour = pool.analyze('ok.json', 1, 1);
	assert.equal(await hungOutcome, 'timeout');
	assert.equal(workers[0].terminated, true);
	await tick();
	const retried = workers[workers.length - 1];
	const retriedRequest = retried.received.find((r) => 'path' in r && r.path === 'ok.json');
	assert.ok(retriedRequest, 'the neighbouring request is re-sent to a fresh worker');
	retried.reply({ type: 'result', id: retriedRequest.id, ok: true, result: entry(5) });
	assert.equal((await neighbour).tokens, 5);
	await pool.dispose();
});

test('a worker that dies before it is ready (broken bundle) sends the request to the in-process path, not to a retry', async () => {
	const { pool, workers } = makePool({ size: 1 });
	const promise = pool.analyze('a.json', 1, 1);
	workers[0].crashBeforeReady();
	await assert.rejects(promise, (e: unknown) => e instanceof AnalysisWorkerError && e.kind === 'unavailable');
	assert.equal(workers.length, 1, 'a worker that cannot load is not respawned for the same request');
	await pool.dispose();
});

test('when only the pool-wide restart budget runs out, the request that happened to be there is unavailable, not failed', async () => {
	const { pool, workers } = makePool({ size: 1, maxRestarts: 0 });
	const promise = pool.analyze('a.json', 1, 1);
	workers[0].crash();
	await assert.rejects(promise, (e: unknown) => e instanceof AnalysisWorkerError && e.kind === 'unavailable');
	assert.equal(pool.isAvailable(), false);
	await pool.dispose();
});

test('only a small window of requests is in flight per worker; the rest wait in the pool', async () => {
	const { pool, workers } = makePool({ size: 1 });
	const results = [1, 2, 3, 4, 5].map((n) => pool.analyze(`f${n}`, 1, 1));
	assert.equal(workers.length, 1);
	assert.equal(workers[0].received.length, 2, 'a thread that can only parse serially is not handed the whole backlog');
	workers[0].reply({ type: 'result', id: workers[0].received[0].id, ok: true, result: entry(1) });
	assert.equal(workers[0].received.length, 3, 'a completion immediately admits the next request');
	for (let i = 1; i < 5; i++) {
		workers[0].reply({ type: 'result', id: workers[0].received[i].id, ok: true, result: entry(i + 1) });
	}
	assert.deepEqual((await Promise.all(results)).map((r) => r.tokens), [1, 2, 3, 4, 5]);
	await pool.dispose();
});

test('a request that waits in the queue is not timed out for waiting', async () => {
	// Timeout is 600ms and the queued request is answered ~750ms after submission — but it only reached
	// the worker at ~300ms, so it has been "in flight" for ~450ms and must still succeed.
	const { pool, workers } = makePool({ size: 1, requestTimeoutMs: 600 });
	const a = pool.analyze('a', 1, 1);
	const b = pool.analyze('b', 1, 1);
	const queued = pool.analyze('c', 1, 1);
	await sleep(300);
	workers[0].reply({ type: 'result', id: workers[0].received[0].id, ok: true, result: entry(1) });
	workers[0].reply({ type: 'result', id: workers[0].received[1].id, ok: true, result: entry(2) });
	assert.equal(workers[0].received.length, 3, 'the queued request is dispatched once capacity frees');
	await sleep(450);
	workers[0].reply({ type: 'result', id: workers[0].received[2].id, ok: true, result: entry(3) });
	assert.equal((await queued).tokens, 3);
	await Promise.all([a, b]);
	assert.equal(workers[0].terminated, false, 'a healthy, merely busy worker is never killed');
	await pool.dispose();
});

test('gives up for the session once workers keep dying, and says so', async () => {
	const { pool, workers, warnings } = makePool({ size: 1, maxRestarts: 2 });
	const outcomes: string[] = [];
	for (let i = 0; i < 4 && pool.isAvailable(); i++) {
		const p = pool.analyze(`f${i}`, 1, 1).catch((e: unknown) => { outcomes.push(e instanceof AnalysisWorkerError ? e.kind : 'other'); });
		workers[workers.length - 1].crash();
		await tick();
		if (workers.length > 0 && pool.isAvailable()) { workers[workers.length - 1].crash(); }
		await p;
	}
	assert.equal(pool.isAvailable(), false);
	assert.ok(warnings.some((w) => /falling back to in-process/i.test(w)));
	await assert.rejects(pool.analyze('late', 1, 1), (e: unknown) => e instanceof AnalysisWorkerError && e.kind === 'unavailable');
	await pool.dispose();
});

test('a worker that cannot be started surfaces as unavailable, not as a thrown host error', async () => {
	const { pool } = makePool({ createWorker: () => { throw new Error('spawn failed'); } });
	await assert.rejects(pool.analyze('a', 1, 1), (e: unknown) => e instanceof AnalysisWorkerError && e.kind === 'unavailable' && /spawn failed/.test(e.message));
	await pool.dispose();
});

test('dispose rejects in-flight work, terminates workers, and refuses new requests', async () => {
	const { pool, workers } = makePool();
	const inFlight = pool.analyze('a', 1, 1);
	const outcome = inFlight.then(() => 'resolved', (e: unknown) => (e instanceof AnalysisWorkerError ? e.kind : 'other'));
	await pool.dispose();
	assert.equal(await outcome, 'unavailable');
	assert.ok(workers.every((w) => w.terminated));
	assert.equal(pool.isAvailable(), false);
	await assert.rejects(pool.analyze('b', 1, 1), (e: unknown) => e instanceof AnalysisWorkerError && e.kind === 'unavailable');
	await pool.dispose(); // idempotent
});

test('worker warnings are forwarded to the host log', async () => {
	const { pool, workers, warnings } = makePool();
	const p = pool.analyze('a', 1, 1);
	workers[0].reply({ type: 'warn', message: 'adapter hiccup' });
	workers[0].reply({ type: 'result', id: 1, ok: true, result: entry(1) });
	await p;
	assert.ok(warnings.includes('adapter hiccup'));
	await pool.dispose();
});

test('the hang clock is paused while the worker waits on the host, and restarts with a full window afterwards', async () => {
	// The first host lookup that needs the OTel export can take minutes; that is the host working, not a hung
	// worker, and must not get the worker killed (which in practice made a refresh restart workers forever).
	let finishLookup: () => void = () => undefined;
	const lookup = new Promise<null>((resolve) => { finishLookup = () => resolve(null); });
	const { pool, workers } = makePool({ size: 1, requestTimeoutMs: 200, resolveOtelUsage: () => lookup });
	const request = pool.analyze('a.json', 1, 1);
	const outcome = request.then(() => 'resolved', (e: unknown) => (e instanceof AnalysisWorkerError ? e.kind : 'other'));
	workers[0].announceReady();
	workers[0].emit('message', { type: 'otelUsage', rpcId: 7, requestId: workers[0].received[0].id, sessionFile: 'a.json' });
	await sleep(500); // well past the 200ms clock
	assert.equal(workers[0].terminated, false, 'waiting on the host is not a hang');
	finishLookup();
	await tick();
	assert.equal(workers[0].replies.length, 1, 'the worker gets its answer');
	assert.equal(workers[0].replies[0].rpcId, 7);
	await sleep(120); // inside the fresh 200ms window that started when the lookup returned
	assert.equal(workers[0].terminated, false);
	await sleep(250); // now genuinely silent for longer than a full window
	assert.equal(workers[0].terminated, true, 'the clock is running again once the host has answered');
	assert.equal(await outcome, 'timeout');
	await pool.dispose();
});

test('a host lookup that never returns is cut off and reported as an error, so the request cannot wait forever', async () => {
	const { pool, workers } = makePool({ size: 1, requestTimeoutMs: 5_000, hostLookupTimeoutMs: 100, resolveOtelUsage: () => new Promise(() => undefined) });
	const request = pool.analyze('a.json', 1, 1);
	void request.catch(() => undefined);
	workers[0].announceReady();
	workers[0].emit('message', { type: 'otelUsage', rpcId: 1, requestId: workers[0].received[0].id, sessionFile: 'a.json' });
	await sleep(250);
	assert.equal(workers[0].replies.length, 1);
	assert.match(workers[0].replies[0].error ?? "", /did not answer/);
	await pool.dispose();
});

test('a failing host lookup is relayed to the worker as an error', async () => {
	const { pool, workers } = makePool({ size: 1, resolveOtelUsage: async () => { throw new Error('index unavailable'); } });
	void pool.analyze('a.json', 1, 1).catch(() => undefined);
	workers[0].announceReady();
	workers[0].emit('message', { type: 'otelUsage', rpcId: 3, requestId: workers[0].received[0].id, sessionFile: 'a.json' });
	await tick(); await tick();
	assert.equal(workers[0].replies[0]?.error, 'index unavailable');
	await pool.dispose();
});

test('when one request times out, its neighbours are re-sent, not timed out by their own near-identical clocks', async () => {
	// Two requests are posted in the same pump, so their clocks expire together. Termination is asynchronous: the
	// worker's exit arrives after both callbacks. Only the first is the culprit; the second must be retried.
	const { pool, workers } = makePool({ size: 1, requestTimeoutMs: 60 }, { exitDelayMs: 40 });
	const a = pool.analyze('a.json', 1, 1);
	const b = pool.analyze('b.json', 1, 1);
	const aOutcome = a.then(() => 'resolved', (e: unknown) => (e instanceof AnalysisWorkerError ? e.kind : 'other'));
	workers[0].announceReady();
	assert.equal(await aOutcome, 'timeout');
	await sleep(20);
	assert.equal(workers.length, 2, 'the innocent neighbour was re-sent to a replacement worker');
	const reSent = workers[1].received.find((r) => 'path' in r && r.path === 'b.json');
	assert.ok(reSent, 'b.json reached the replacement worker');
	workers[1].reply({ type: 'result', id: reSent.id, ok: true, result: entry(4) });
	assert.equal((await b).tokens, 4);
	await pool.dispose();
});

test('when the restart budget trips, the workers that are still alive are retired and their requests fall back', async () => {
	// Two live workers; one dies and exhausts the budget. The other can never receive work again, so it must not be
	// left holding its caches, and the request it was running must be sent to the in-process path.
	const { pool, workers } = makePool({ size: 2, maxRestarts: 0 });
	const onFirst = pool.analyze('a.json', 1, 1);
	const onSecond = pool.analyze('b.json', 1, 1);
	const outcomes = Promise.all([onFirst, onSecond].map((p) => p.then(() => 'resolved', (e: unknown) => (e instanceof AnalysisWorkerError ? e.kind : 'other'))));
	assert.equal(workers.length, 2);
	workers[0].crash();
	// Without the retirement the surviving worker's request is never settled; fail fast instead of hanging.
	const settled = await Promise.race([outcomes, sleep(1_000).then(() => 'a request was left unsettled on the surviving worker')]);
	assert.deepEqual(settled, ['unavailable', 'unavailable']);
	assert.equal(pool.isAvailable(), false);
	assert.equal(workers[1].terminated, true, 'the surviving worker is retired, not left running');
	await pool.dispose();
});

test('requests waiting on the host do not occupy the worker, so files that need no lookup keep flowing', async () => {
	// A few Copilot CLI sessions waiting on the OTel index used to take every running slot and hold up everything
	// else, which on a real history left a refresh sitting at a few percent.
	const { pool, workers } = makePool({ size: 1, requestTimeoutMs: 60_000, resolveOtelUsage: () => new Promise(() => undefined) });
	const requests = ['a', 'b', 'c', 'd', 'e'].map((n) => pool.analyze(`${n}.json`, 1, 1));
	requests.forEach((r) => void r.catch(() => undefined));
	assert.equal(workers[0].received.length, 2, 'two run at a time to begin with');
	workers[0].announceReady();
	for (const request of workers[0].received.slice(0, 2)) {
		workers[0].emit('message', { type: 'otelUsage', rpcId: request.id, requestId: request.id, sessionFile: 'x' });
	}
	assert.equal(workers[0].received.length, 4, 'with both parked on the host, the next two are admitted');
	const third = workers[0].received[2];
	workers[0].reply({ type: 'result', id: third.id, ok: true, result: entry(3) });
	assert.equal(workers[0].received.length, 5, 'and a completion admits the one after');
	await pool.dispose();
});

test('a worker with a request waiting on the host is not killed for it, but another request still has its own clock', async () => {
	const { pool, workers } = makePool({ size: 1, requestTimeoutMs: 150, resolveOtelUsage: () => new Promise(() => undefined) });
	const waiting = pool.analyze('waiting.json', 1, 1);
	const busy = pool.analyze('busy.json', 1, 1);
	void waiting.catch(() => undefined);
	const busyOutcome = busy.then(() => 'resolved', (e: unknown) => (e instanceof AnalysisWorkerError ? e.kind : 'other'));
	workers[0].announceReady();
	workers[0].emit('message', { type: 'otelUsage', rpcId: 1, requestId: workers[0].received[0].id, sessionFile: 'x' });
	await sleep(400);
	assert.equal(await busyOutcome, 'timeout', 'the request that is not waiting on the host is still subject to the hang clock');
	await pool.dispose();
});

test('a silent pipeline reports what it is waiting on', async () => {
	const { pool, workers, warnings } = makePool({ size: 1, requestTimeoutMs: 60_000, stallReportMs: 40, resolveOtelUsage: () => new Promise(() => undefined) });
	const request = pool.analyze('slow-session.jsonl', 1, 1);
	void request.catch(() => undefined);
	workers[0].announceReady();
	workers[0].emit('message', { type: 'otelUsage', rpcId: 1, requestId: workers[0].received[0].id, sessionFile: 'slow-session.jsonl' });
	await sleep(200);
	const report = warnings.find((w) => /no request has completed/.test(w));
	assert.ok(report, 'a stall report is logged');
	assert.match(report, /1 on workers \(1 waiting on the host\)/);
	assert.match(report, /slow-session\.jsonl/);
	await pool.dispose();
});

test('after one host lookup times out, further lookups fail at once instead of each waiting out its own limit', async () => {
	const { pool, workers } = makePool({ size: 1, requestTimeoutMs: 60_000, hostLookupTimeoutMs: 60, hostLookupCooldownMs: 5_000, resolveOtelUsage: () => new Promise(() => undefined) });
	void pool.analyze('a.json', 1, 1).catch(() => undefined);
	void pool.analyze('b.json', 1, 1).catch(() => undefined);
	workers[0].announceReady();
	workers[0].emit('message', { type: 'otelUsage', rpcId: 1, requestId: workers[0].received[0].id, sessionFile: 'a.json' });
	await sleep(150); // the first lookup has timed out
	assert.match(workers[0].replies[0].error ?? '', /did not answer/);
	const before = Date.now();
	workers[0].emit('message', { type: 'otelUsage', rpcId: 2, requestId: workers[0].received[1].id, sessionFile: 'b.json' });
	assert.equal(workers[0].replies.length, 2, 'answered immediately, not after another 60ms');
	assert.match(workers[0].replies[1].error ?? '', /still loading/);
	assert.ok(Date.now() - before < 50);
	await pool.dispose();
});

test('a request re-sent after its worker died while it waited on the host is a normal running request again', async () => {
	// Its host lookup belonged to the dead worker. If the "waiting on the host" count survived the re-send, the
	// request would never get a hang clock and never count against the running window.
	const { pool, workers } = makePool({ size: 1, requestTimeoutMs: 120, maxRestarts: 50, resolveOtelUsage: () => new Promise(() => undefined) });
	const request = pool.analyze('a.json', 1, 1);
	const outcome = request.then(() => 'resolved', (e: unknown) => (e instanceof AnalysisWorkerError ? e.kind : 'other'));
	workers[0].announceReady();
	workers[0].emit('message', { type: 'otelUsage', rpcId: 1, requestId: workers[0].received[0].id, sessionFile: 'a.json' });
	workers[0].crash(); // dies while the request is parked on the host
	await sleep(10);
	assert.equal(workers.length, 2, 'the request was re-sent to a replacement worker');
	workers[1].announceReady();
	// The replacement never answers: the request must now be subject to the hang clock again.
	await sleep(400);
	assert.equal(workers[1].terminated, true, 'the re-sent request has a running hang clock');
	assert.equal(await outcome, 'timeout');
	await pool.dispose();
});

test('a file that timed out a worker is rejected immediately next time, until the file changes', async () => {
	const { pool, workers } = makePool({ size: 1, requestTimeoutMs: 60, maxRestarts: 50 });
	const first = pool.analyze('hang.json', 100, 10);
	workers[0].announceReady();
	await assert.rejects(first, (e: unknown) => e instanceof AnalysisWorkerError && e.kind === 'timeout');
	await sleep(10);
	const workersBefore = workers.length;
	await assert.rejects(pool.analyze('hang.json', 100, 10), (e: unknown) => e instanceof AnalysisWorkerError && e.kind === 'failed', 'same version of the file: skipped');
	assert.equal(workers.length, workersBefore, 'and no worker was spent on it');
	void pool.analyze('hang.json', 200, 10).catch(() => undefined); // modified file: another chance
	assert.ok(workers.some((w) => w.received.some((r) => 'mtime' in r && r.mtime === 200)), 'a changed file is tried again');
	await pool.dispose();
});

test('a file that proved dangerous stays rejected after the pool has given up, while other files fall back', async () => {
	// The safety rule is that a hang or crash is never re-run on the host. Once the restart budget is spent every
	// request bypasses the workers, which must not turn the proven-bad file into an in-process parse.
	const { pool, workers } = makePool({ size: 1, requestTimeoutMs: 60, maxRestarts: 0 });
	const bad = pool.analyze('bad.json', 1, 1);
	workers[0].announceReady();
	await assert.rejects(bad, (e: unknown) => e instanceof AnalysisWorkerError && e.kind === 'timeout');
	assert.equal(pool.isAvailable(), false, 'the single death spent the budget');
	await assert.rejects(pool.analyze('bad.json', 1, 1), (e: unknown) => e instanceof AnalysisWorkerError && e.kind === 'failed', 'the proven-bad file is still skipped');
	await assert.rejects(pool.analyze('other.json', 1, 1), (e: unknown) => e instanceof AnalysisWorkerError && e.kind === 'unavailable', 'any other file may use the fallback');
	await pool.dispose();
});

test('a file that killed two workers is quarantined too', async () => {
	const { pool, workers } = makePool({ size: 1, maxRestarts: 50 });
	const request = pool.analyze('crashy.json', 1, 1);
	workers[0].crash();
	await tick();
	workers[1].crash();
	await assert.rejects(request, (e: unknown) => e instanceof AnalysisWorkerError && e.kind === 'failed');
	const before = workers.length;
	await assert.rejects(pool.analyze('crashy.json', 1, 1), (e: unknown) => e instanceof AnalysisWorkerError && e.kind === 'failed');
	assert.equal(workers.length, before, 'it does not cost another worker');
	await pool.dispose();
});

test('a worker that hangs while starting up is unavailable, not a dangerous file: nothing is blamed or quarantined', async () => {
	// Requests are clocked from the moment they are posted, which is before the worker says `ready`. A broken or hung
	// bundle therefore shows up as a timeout, and must not be mistaken for the request having hung the worker.
	const { pool, workers } = makePool({ size: 1, requestTimeoutMs: 60, maxRestarts: 50 });
	const request = pool.analyze('innocent.json', 1, 1); // the fake worker never announces ready
	await assert.rejects(request, (e: unknown) => e instanceof AnalysisWorkerError && e.kind === 'unavailable');
	await sleep(10);
	const again = pool.analyze('innocent.json', 1, 1);
	void again.catch(() => undefined);
	assert.ok(workers.some((w) => w.received.some((r) => 'path' in r && r.path === 'innocent.json')), 'not quarantined: the same file is simply tried again');
	await pool.dispose();
});

test('quarantine for the folder-scan operation tells file versions apart even when their content has the same length', async () => {
	const { pool, workers } = makePool({ size: 1, requestTimeoutMs: 60, maxRestarts: 50 });
	const content = 'x'.repeat(100);
	const first = pool.quickAnalyze('scan.json', content, 1_000, 100);
	workers[0].announceReady();
	await assert.rejects(first, (e: unknown) => e instanceof AnalysisWorkerError && e.kind === 'timeout');
	await sleep(10);
	await assert.rejects(pool.quickAnalyze('scan.json', content, 1_000, 100), (e: unknown) => e instanceof AnalysisWorkerError && e.kind === 'failed', 'same version: skipped');
	void pool.quickAnalyze('scan.json', 'y'.repeat(100), 2_000, 100).catch(() => undefined); // edited, same length
	assert.ok(workers.some((w) => w.received.some((r) => r.op === 'quick' && r.mtimeMs === 2_000)), 'an edited file of equal length is tried again');
	await pool.dispose();
});

test('the cooldown after a timed-out host lookup ends as soon as that lookup finally answers', async () => {
	let releaseFirst: () => void = () => undefined;
	let calls = 0;
	const resolveOtelUsage = (): Promise<null> => {
		calls++;
		return calls === 1 ? new Promise((resolve) => { releaseFirst = () => resolve(null); }) : Promise.resolve(null);
	};
	const { pool, workers } = makePool({ size: 1, requestTimeoutMs: 60_000, hostLookupTimeoutMs: 40, hostLookupCooldownMs: 60_000, resolveOtelUsage });
	void pool.analyze('a.json', 1, 1).catch(() => undefined);
	void pool.analyze('b.json', 1, 1).catch(() => undefined);
	workers[0].announceReady();
	workers[0].emit('message', { type: 'otelUsage', rpcId: 1, requestId: workers[0].received[0].id, sessionFile: 'a.json' });
	await sleep(120);
	assert.match(workers[0].replies[0].error ?? '', /did not answer/);
	releaseFirst(); // the index finished loading, late
	await tick();
	workers[0].emit('message', { type: 'otelUsage', rpcId: 2, requestId: workers[0].received[1].id, sessionFile: 'b.json' });
	await tick(); await tick();
	assert.equal(calls, 2, 'the second lookup reached the host instead of failing on the cooldown');
	assert.equal(workers[0].replies[1]?.error, undefined);
	await pool.dispose();
});

test('requests whose host lookups finish together resume only as the worker has running capacity', async () => {
	const releases: Array<() => void> = [];
	const resolveOtelUsage = (): Promise<null> => new Promise((resolve) => { releases.push(() => resolve(null)); });
	const { pool, workers } = makePool({ size: 1, requestTimeoutMs: 60_000, resolveOtelUsage });
	for (const name of ['a', 'b', 'c', 'd']) { void pool.analyze(`${name}.json`, 1, 1).catch(() => undefined); }
	workers[0].announceReady();
	const idOf = (name: string): number => workers[0].received.find((r) => 'path' in r && r.path === `${name}.json`)!.id;
	// a and b park on the host, which lets c and d start: the worker is running its two.
	workers[0].emit('message', { type: 'otelUsage', rpcId: 1, requestId: idOf('a'), sessionFile: 'a.json' });
	workers[0].emit('message', { type: 'otelUsage', rpcId: 2, requestId: idOf('b'), sessionFile: 'b.json' });
	assert.equal(workers[0].received.length, 4, 'c and d took the freed slots');
	releases.forEach((release) => release());
	await tick(); await tick();
	assert.equal(workers[0].replies.length, 0, 'a and b stay parked: resuming them now would run four at once');
	workers[0].emit('message', { type: 'result', id: idOf('c'), ok: true, result: { tokens: 0 } });
	await tick();
	assert.equal(workers[0].replies.length, 1, 'one slot freed, one request resumed');
	workers[0].emit('message', { type: 'result', id: idOf('d'), ok: true, result: { tokens: 0 } });
	await tick();
	assert.equal(workers[0].replies.length, 2);
	await pool.dispose();
});

test('a timed-out request keeps its timeout verdict when another worker exhausts the restart budget before its exit arrives', async () => {
	// Its slot is retired with the rest, so the exit event that would have reported the timeout is ignored. Rejecting it
	// as `unavailable` would have the caller parse the known-hanging file on the extension host.
	const { pool, workers } = makePool({ size: 2, requestTimeoutMs: 60, maxRestarts: 0, resolveOtelUsage: () => new Promise(() => undefined) }, { exitDelayMs: 300 });
	const hung = pool.analyze('hang.json', 1, 1);
	const other = pool.analyze('other.json', 1, 1);
	void other.catch(() => undefined);
	const outcome = hung.then(() => 'resolved', (e: unknown) => (e instanceof AnalysisWorkerError ? e.kind : 'other'));
	workers[0].announceReady();
	workers[1].announceReady();
	// The neighbour waits on the host, so only the first worker's clock runs out.
	workers[1].emit('message', { type: 'otelUsage', rpcId: 1, requestId: workers[1].received[0].id, sessionFile: 'other.json' });
	await sleep(120); // hang.json timed out; its worker's exit is still pending
	workers[1].crash(); // the second worker dies: the restart budget is gone and every slot is retired
	assert.equal(await outcome, 'timeout');
	await assert.rejects(pool.analyze('hang.json', 1, 1), (e: unknown) => e instanceof AnalysisWorkerError && e.kind === 'failed', 'and it is quarantined');
	await pool.dispose();
});
