/**
 * Guard against bundled dependencies installing process-global crash handlers.
 *
 * `@azure/storage-common` ships an Emscripten-compiled CRC64 module
 * (`crc64.js`, pulled in by `@azure/storage-blob`). When that module is
 * instantiated on first blob upload, its Node shell registers:
 *
 *   process.on('uncaughtException', ex => { if (!(ex instanceof ExitStatus)) throw ex; })
 *   process.on('unhandledRejection', reason => { throw reason; })
 *
 * In a standalone CLI that is harmless. Inside the VS Code extension host it is
 * not: the host is shared by every extension in the window, so a rethrowing
 * `unhandledRejection` handler turns *any* extension's stray rejection into a
 * fatal uncaught exception. The same shell also calls `process.exit()` from its
 * `quit_` path (VS Code intercepts that one, but the listeners it cannot).
 *
 * See issue #2137. We cannot patch the dependency, so we remove the two
 * listeners again after the code that installs them has run.
 *
 * Two independent conditions must both hold before a listener is removed:
 *   1. it was not registered before the guarded call started, and
 *   2. its body is a bare rethrow — nothing but `throw <arg>`, optionally behind
 *      an `instanceof` guard, which is exactly the Emscripten shape.
 *
 * Condition (2) is what keeps a legitimate handler that some other extension
 * happens to install during the same upload window from being stripped: a real
 * safety net logs, reports or recovers, it does not merely rethrow. If the
 * dependency ever changes shape we fail closed — the listener stays, which is
 * today's behaviour, rather than silently disabling somebody else's handler.
 */

type FatalEvent = 'uncaughtException' | 'unhandledRejection';

const FATAL_EVENTS: readonly FatalEvent[] = ['uncaughtException', 'unhandledRejection'];

/** Strip comments and collapse whitespace so minified and readable sources compare alike. */
function normalizeSource(fn: Function): string {
	let source: string;
	try {
		source = Function.prototype.toString.call(fn);
	} catch {
		return '';
	}
	return source
		.replace(/\/\*[\s\S]*?\*\//g, ' ')
		.replace(/\/\/[^\n]*/g, ' ')
		.replace(/\s+/g, ' ')
		// Drop whitespace around punctuation so `if (!(e instanceof X)) {` and the
		// minified `if(!(e instanceof X)){` canonicalise to the same string. Spaces
		// that carry meaning (after `throw`, around `instanceof`) are between word
		// characters and so are preserved.
		.replace(/ *([(){}!;=>]) */g, '$1')
		.trim();
}

/**
 * True when the listener does nothing but rethrow its argument, optionally behind an
 * `if (!(arg instanceof X))` guard — the two shapes Emscripten's Node shell installs.
 * Matches both `function (e) { … }` and `e => { … }`, before or after minification.
 */
export function isBareRethrowListener(fn: Function): boolean {
	const source = normalizeSource(fn);
	if (!source) { return false; }

	// After canonicalisation both `function (e) {…}` and `e=>{…}` look like `…(e){…}`.
	const head = /^(?:function[\w$]*)?\(?([\w$]+)\)?(?:=>)?\{(.*)\}$/.exec(source);
	if (!head) { return false; }

	const [, arg, body] = head;
	const bare = new RegExp(`^throw ${arg};?$`);
	const guarded = new RegExp(`^if\\(!\\(${arg} instanceof [\\w$.]+\\)\\)\\{?throw ${arg};?\\}?$`);
	return bare.test(body) || guarded.test(body);
}

/**
 * Snapshot the listeners currently registered for the two process-global crash events.
 * Take this *before* calling into a dependency that may register its own.
 */
export function snapshotFatalHandlers(): Map<FatalEvent, Function[]> {
	const snapshot = new Map<FatalEvent, Function[]>();
	for (const event of FATAL_EVENTS) {
		snapshot.set(event, [...process.listeners(event)]);
	}
	return snapshot;
}

/** What `removeFatalHandlersAddedSince` did, so callers can log the unexpected cases. */
export interface FatalHandlerCleanup {
	/** Bare-rethrow listeners added since the snapshot and removed. */
	removed: number;
	/** Listeners added since the snapshot but left in place because they do more than rethrow. */
	kept: number;
}

/**
 * Remove every bare-rethrow `uncaughtException` / `unhandledRejection` listener that was
 * added since `snapshot` was taken. Listeners present beforehand, and newly added ones
 * that do anything other than rethrow, are left untouched.
 */
export function removeFatalHandlersAddedSince(snapshot: Map<FatalEvent, Function[]>): FatalHandlerCleanup {
	let removed = 0;
	let kept = 0;
	for (const event of FATAL_EVENTS) {
		const before = new Set(snapshot.get(event) ?? []);
		for (const listener of process.listeners(event)) {
			if (before.has(listener)) { continue; }
			if (!isBareRethrowListener(listener)) { kept++; continue; }
			process.removeListener(event, listener as (...args: unknown[]) => void);
			removed++;
		}
	}
	return { removed, kept };
}

/**
 * Run `fn`, then strip any bare-rethrow process-global crash handlers it installed along
 * the way. The cleanup runs whether `fn` resolves or rejects. `onCleanup` is called only
 * when something was added during the window, so the normal path stays silent.
 */
export async function withoutLeakedFatalHandlers<T>(
	fn: () => Promise<T>,
	onCleanup?: (cleanup: FatalHandlerCleanup) => void
): Promise<T> {
	const snapshot = snapshotFatalHandlers();
	try {
		return await fn();
	} finally {
		const cleanup = removeFatalHandlersAddedSince(snapshot);
		if (cleanup.removed > 0 || cleanup.kept > 0) { onCleanup?.(cleanup); }
	}
}
