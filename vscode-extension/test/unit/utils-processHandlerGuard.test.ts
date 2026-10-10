import { test } from 'node:test';
import * as assert from 'node:assert';
import {
	isBareRethrowListener,
	snapshotFatalHandlers,
	removeFatalHandlersAddedSince,
	withoutLeakedFatalHandlers,
} from '../../src/utils/processHandlerGuard';

/**
 * Regression cover for issue #2137: a bundled dependency (the Azure SDK's Emscripten
 * CRC64 module) registers rethrowing `uncaughtException` / `unhandledRejection`
 * listeners on the shared extension host process.
 */

/** The exact shape `@azure/storage-common`'s crc64.js installs for unhandledRejection. */
const emscriptenRethrow = function (reason: unknown): never { throw reason; };

/** The exact shape it installs for uncaughtException (ExitStatus guard). */
class ExitStatus { }
const emscriptenGuardedRethrow = function (ex: unknown): void {
	if (!(ex instanceof ExitStatus)) {
		throw ex;
	}
};

// ---------------------------------------------------------------------------
// isBareRethrowListener() — the shape filter
// ---------------------------------------------------------------------------

test('isBareRethrowListener: matches the Emscripten bare rethrow', () => {
	assert.ok(isBareRethrowListener(emscriptenRethrow));
});

test('isBareRethrowListener: matches the Emscripten instanceof-guarded rethrow', () => {
	assert.ok(isBareRethrowListener(emscriptenGuardedRethrow));
});

test('isBareRethrowListener: matches minified and arrow forms of the same shape', () => {
	assert.ok(isBareRethrowListener(function (re: unknown) { throw re; }));
	assert.ok(isBareRethrowListener((r: unknown) => { throw r; }));
	// eslint-disable-next-line no-eval
	assert.ok(isBareRethrowListener(eval('(function(xe){if(!(xe instanceof Error)){throw xe}})')));
});

test('isBareRethrowListener: matches the shapes in the shipped minified bundle', () => {
	// Verbatim from the v0.17.2 bundle quoted in issue #2137 — note the brace-less
	// `if (…) throw re` form the minifier produces.
	/* eslint-disable no-eval */
	assert.ok(isBareRethrowListener(eval('(function (re) { if (!(re instanceof Ia)) throw re })')));
	assert.ok(isBareRethrowListener(eval('(function (re) { throw re })')));
	/* eslint-enable no-eval */
});

test('isBareRethrowListener: rejects a handler that does real work', () => {
	// A genuine safety net logs or reports — it must survive the cleanup.
	assert.ok(!isBareRethrowListener((err: unknown) => { console.error('crash', err); }));
	assert.ok(!isBareRethrowListener(function (err: unknown) { void err; return; }));
	assert.ok(!isBareRethrowListener((err: unknown) => { report(err); throw err; }));
});

function report(_err: unknown): void { /* stand-in for a real reporter */ }

// ---------------------------------------------------------------------------
// removeFatalHandlersAddedSince() / withoutLeakedFatalHandlers()
// ---------------------------------------------------------------------------

test('removeFatalHandlersAddedSince: removes rethrowing listeners added after the snapshot', () => {
	const snapshot = snapshotFatalHandlers();
	process.on('unhandledRejection', emscriptenRethrow);
	process.on('uncaughtException', emscriptenGuardedRethrow);

	const { removed, kept } = removeFatalHandlersAddedSince(snapshot);

	assert.equal(removed, 2);
	assert.equal(kept, 0);
	assert.ok(!process.listeners('unhandledRejection').includes(emscriptenRethrow));
	assert.ok(!process.listeners('uncaughtException').includes(emscriptenGuardedRethrow));
});

test('removeFatalHandlersAddedSince: leaves pre-existing listeners alone', () => {
	process.on('unhandledRejection', emscriptenRethrow);
	try {
		// Registered *before* the snapshot, so it is not ours to remove — even though
		// it has the rethrow shape.
		const snapshot = snapshotFatalHandlers();
		const { removed, kept } = removeFatalHandlersAddedSince(snapshot);

		assert.equal(removed, 0);
		assert.equal(kept, 0);
		assert.ok(process.listeners('unhandledRejection').includes(emscriptenRethrow));
	} finally {
		process.removeListener('unhandledRejection', emscriptenRethrow);
	}
});

test('removeFatalHandlersAddedSince: keeps a concurrently-added handler that does real work', () => {
	const legitimate = (err: unknown): void => { console.error('some other extension', err); };
	const snapshot = snapshotFatalHandlers();
	process.on('unhandledRejection', legitimate);
	process.on('unhandledRejection', emscriptenRethrow);

	try {
		const { removed, kept } = removeFatalHandlersAddedSince(snapshot);

		assert.equal(removed, 1, 'only the rethrowing listener is removed');
		assert.equal(kept, 1, 'the real handler is reported as kept');
		assert.ok(process.listeners('unhandledRejection').includes(legitimate));
		assert.ok(!process.listeners('unhandledRejection').includes(emscriptenRethrow));
	} finally {
		process.removeListener('unhandledRejection', legitimate);
	}
});

test('withoutLeakedFatalHandlers: strips handlers installed by the wrapped work', async () => {
	let reported = { removed: 0, kept: 0 };
	const value = await withoutLeakedFatalHandlers(async () => {
		process.on('unhandledRejection', emscriptenRethrow);
		return 'done';
	}, cleanup => { reported = cleanup; });

	assert.equal(value, 'done');
	assert.deepEqual(reported, { removed: 1, kept: 0 });
	assert.ok(!process.listeners('unhandledRejection').includes(emscriptenRethrow));
});

test('withoutLeakedFatalHandlers: strips handlers even when the wrapped work throws', async () => {
	await assert.rejects(
		withoutLeakedFatalHandlers(async () => {
			process.on('uncaughtException', emscriptenGuardedRethrow);
			throw new Error('upload failed');
		}),
		/upload failed/
	);

	assert.ok(!process.listeners('uncaughtException').includes(emscriptenGuardedRethrow));
});

test('withoutLeakedFatalHandlers: stays silent when nothing was installed', async () => {
	let called = false;
	await withoutLeakedFatalHandlers(async () => undefined, () => { called = true; });
	assert.equal(called, false);
});
