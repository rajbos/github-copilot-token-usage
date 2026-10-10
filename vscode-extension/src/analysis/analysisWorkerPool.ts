/**
 * Host-side client for the session-analysis worker threads.
 *
 * The extension host's single event loop is also what delivers webview clicks, so parsing
 * must happen elsewhere. This pool owns that "elsewhere": it lazily spawns up to `size`
 * worker threads, spreads requests across them by load, and treats the workers as
 * disposable — a crash, hang or out-of-memory kill costs a respawn, never the host.
 *
 * Requests wait in a pool-side queue and only a small window of them is in flight per worker.
 * That matters for the hang watchdog: a worker parses on one thread, so a request that merely
 * waits behind twenty others must not be mistaken for a hung one. The timeout clock starts
 * when a request is handed to a worker, where its wait is bounded by that small window.
 *
 * Failure model, which the caller (`getSessionFileDataCached`) relies on:
 *  - `unavailable`: the worker could not be used (never started, restart budget exhausted,
 *    pool disposed). Nothing was learned about the *file*, so the caller may safely analyze it
 *    in-process instead.
 *  - `timeout` / `failed`: the worker ran the analysis and it hung, threw, or died under it
 *    twice. Retrying in-process would just move the same hang or crash onto the host, so
 *    these surface as ordinary rejections, exactly like the in-process analyzer throwing would.
 */
import { Worker } from 'worker_threads';

import type { CustomizationFileEntry, SessionFileCache, SessionFileDetails } from '../../../src/types';
import type { SessionDetailsResult } from './sessionDetailsAnalyzer';
import type { QuickSessionAnalysis } from './sessionFileAnalyzer';
import type { CopilotCliOtelSessionUsage } from '../../../src/copilotCliOtel';
import type { AnalysisHostMessage, AnalysisRequest, AnalysisWorkerData, AnalysisWorkerMessage, CopilotCliSessionKind } from './analysisProtocol';

export type AnalysisFailureKind = 'unavailable' | 'timeout' | 'failed';

export class AnalysisWorkerError extends Error {
	constructor(message: string, readonly kind: AnalysisFailureKind, readonly code?: string) {
		super(message);
		this.name = 'AnalysisWorkerError';
	}
}

/** The subset of `worker_threads.Worker` the pool uses — a seam for deterministic tests. */
export interface WorkerLike {
	on(event: 'message', listener: (message: AnalysisWorkerMessage) => void): unknown;
	on(event: 'error', listener: (error: Error) => void): unknown;
	on(event: 'exit', listener: (code: number) => void): unknown;
	postMessage(message: AnalysisHostMessage): void;
	terminate(): Promise<number>;
	unref?(): void;
}

export interface AnalysisWorkerPoolOptions {
	/** Absolute path of the bundled `analysisWorker.js`. */
	workerPath: string;
	extensionPath: string;
	/** Maximum number of worker threads; spawned lazily as load requires. */
	size: number;
	/** A request that has been with a worker longer than this is treated as hung and its worker is killed. */
	requestTimeoutMs?: number;
	/** Worker deaths tolerated inside `restartWindowMs` before the pool gives up for the session. */
	maxRestarts?: number;
	restartWindowMs?: number;
	log: (message: string) => void;
	warn: (message: string) => void;
	/**
	 * Answers a worker's "what does the OTel export say about this Copilot CLI session?" from the host's single
	 * index, so N workers do not each scan a multi-GB export. (The session-store database lookup, which comes first
	 * and is the common case, stays in the worker.) Without it a worker looks it up itself.
	 */
	resolveOtelUsage?: (sessionFile: string) => Promise<CopilotCliOtelSessionUsage | null>;
	/** Upper bound on one host lookup; see HOST_LOOKUP_TIMEOUT_MS. */
	hostLookupTimeoutMs?: number;
	/** How long, after a host lookup times out, further lookups fail at once; see HOST_LOOKUP_COOLDOWN_MS. */
	hostLookupCooldownMs?: number;
	/** How often to check for, and how long without a completed request counts as, a stall worth reporting. */
	stallReportMs?: number;
	/** Test seam. Defaults to a real `worker_threads.Worker`. */
	createWorker?: (workerPath: string, data: AnalysisWorkerData) => WorkerLike;
}

type AnalysisResult = SessionFileCache | SessionDetailsResult | CustomizationFileEntry[] | QuickSessionAnalysis | null;

/**
 * Identifies the thing a request asks to be analysed, including the version of the file, so that a file proven to
 * hang or kill a worker stays rejected until it actually changes. Undefined for requests that are not keyed on a file.
 */
function quarantineKey(request: AnalysisRequest): string | undefined {
	switch (request.op) {
		case 'analyze': return `${request.path}|${request.mtime}|${request.size}`;
		case 'details': return `${request.path}|${request.mtimeMs}|${request.size}`;
		case 'supplement': return `${request.path}|supplement|${request.cached.mtime}|${request.cached.size ?? ''}`;
		case 'quick': return `${request.path}|quick|${request.mtimeMs}|${request.size}`;
		case 'customization': return `workspace|${request.workspace}`;
	}
}

interface Pending {
	request: AnalysisRequest;
	resolve: (value: AnalysisResult) => void;
	reject: (error: Error) => void;
	/** Armed while the request is with a worker; undefined while it waits in the queue. */
	timer: NodeJS.Timeout | undefined;
	/** Times this request has already been re-sent after its worker died under it. */
	retries: number;
	timedOut: boolean;
	/** Host lookups this request is waiting on. While any are outstanding it is waiting on the host, not running. */
	hostLookups: number;
	/** When it was handed to a worker (for stall diagnostics). */
	postedAt: number;
}

interface Slot {
	worker: WorkerLike;
	pending: Map<number, Pending>;
	/** Set when the worker posts `ready`, i.e. its bundle loaded and initialised. */
	ready: boolean;
	/** Host lookups that have finished but whose requests cannot resume yet: the worker is already running its limit. */
	resumeQueue: Array<() => void>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 3 * 60 * 1000;
const DEFAULT_MAX_RESTARTS = 5;
const DEFAULT_RESTART_WINDOW_MS = 60 * 1000;
/** A request is re-sent at most once after its worker dies; a second death means it is likely the cause. */
const MAX_RETRIES_AFTER_WORKER_DEATH = 1;
/**
 * Requests *running* on one worker at a time (those waiting on a host lookup are not running, see below). A second
 * request lets one file's disk read overlap another's parse, while the backlog beyond that stays in the pool,
 * where it cannot be mistaken for a hang.
 */
const MAX_IN_FLIGHT_PER_WORKER = 2;
/**
 * A host-side OTel lookup (which may have to load a multi-GB index) is given this long. Past it the request fails
 * and is retried on the next refresh; the alternative, waiting on, can leave every file behind it unprocessed.
 */
const HOST_LOOKUP_TIMEOUT_MS = 20 * 1000;
/**
 * Requests parked on one worker, including those waiting on the host. Waiting requests do not count against
 * MAX_IN_FLIGHT_PER_WORKER (they are not using the worker), but each holds its file in memory, so they are bounded.
 */
const MAX_PENDING_PER_WORKER = 32;
const DEFAULT_STALL_REPORT_MS = 30 * 1000;
/**
 * After a host lookup times out the index is evidently still loading. For this long (or until that lookup finally
 * answers, whichever is first), further lookups fail at once instead of each waiting out its own limit (thousands of
 * sessions would otherwise queue up behind it, one limit after another); their files are simply tried again on the
 * next refresh.
 */
const HOST_LOOKUP_COOLDOWN_MS = 60 * 1000;
/** Generous: a multi-hundred-MB session file parses to a large object graph, but a runaway must not take the host with it. */
const WORKER_MAX_OLD_GENERATION_MB = 4096;

export class AnalysisWorkerPool {
	private readonly slots: Slot[] = [];
	private readonly queue: Pending[] = [];
	private nextRequestId = 1;
	private readonly deathTimestamps: number[] = [];
	private broken = false;
	private disposed = false;
	/** When a request last completed; with `stallWatch`, lets a silent pipeline say what it is waiting on. */
	private lastProgressAt = Date.now();
	private lastStallReportAt = 0;
	private hostLookupCooldownUntil = 0;
	/** Host lookups that timed out and have not answered yet; the cooldown ends early when the last one does. */
	private lateHostLookups = 0;
	/**
	 * Requests proven dangerous: they timed out a worker, or killed two. They are rejected as `failed` for the rest of
	 * the session — including after the pool is disabled, when every other request falls back to the host. Running
	 * them there would put the hang or the out-of-memory kill on the one thread that must stay responsive.
	 */
	private readonly quarantined = new Set<string>();
	private stallWatch: NodeJS.Timeout | undefined;

	constructor(private readonly options: AnalysisWorkerPoolOptions) {}

	/** False once disposed or after the restart budget is exhausted; callers should then go in-process. */
	isAvailable(): boolean {
		return !this.disposed && !this.broken;
	}

	analyze(path: string, mtime: number, size: number, existingRepository?: string, copilotCliKinds?: CopilotCliSessionKind[]): Promise<SessionFileCache> {
		return this.submit((id) => ({ id, op: 'analyze', path, mtime, size, ...(existingRepository !== undefined ? { existingRepository } : {}), ...(copilotCliKinds?.length ? { copilotCliKinds } : {}) }))
			.then((result) => {
				if (!result) { throw new AnalysisWorkerError(`Worker returned no entry for ${path}`, 'failed'); }
				return result as SessionFileCache;
			});
	}

	/** Resolves `null` when the session has no usable debug log (mirrors the in-process analyzer). */
	supplement(cached: SessionFileCache, path: string): Promise<SessionFileCache | null> {
		return this.submit((id) => ({ id, op: 'supplement', path, cached })) as Promise<SessionFileCache | null>;
	}

	/** Fills in the host-prepared `details` skeleton from the session file (see sessionDetailsAnalyzer.ts). */
	computeDetails(path: string, mtimeMs: number, size: number, details: SessionFileDetails, copilotCliKinds?: CopilotCliSessionKind[]): Promise<SessionDetailsResult> {
		return this.submit((id) => ({ id, op: 'details', path, mtimeMs, size, details, ...(copilotCliKinds?.length ? { copilotCliKinds } : {}) }))
			.then((result) => {
				if (!result) { throw new AnalysisWorkerError(`Worker returned no details for ${path}`, 'failed'); }
				return result as SessionDetailsResult;
			});
	}

	/** Interaction count and token estimate for already-read content (see quickAnalyzeSessionContent). */
	quickAnalyze(path: string, content: string, mtimeMs: number, size: number): Promise<QuickSessionAnalysis> {
		return this.submit((id) => ({ id, op: 'quick', path, content, mtimeMs, size }))
			.then((result) => {
				if (!result) { throw new AnalysisWorkerError(`Worker returned no analysis for ${path}`, 'failed'); }
				return result as QuickSessionAnalysis;
			});
	}

	/** Customization files for one workspace (see workspaceCustomizationScan.ts). */
	scanCustomizationFiles(workspace: string): Promise<CustomizationFileEntry[]> {
		return this.submit((id) => ({ id, op: 'customization', workspace }))
			.then((result) => {
				if (!result) { throw new AnalysisWorkerError(`Worker returned no scan for ${workspace}`, 'failed'); }
				return result as CustomizationFileEntry[];
			});
	}

	async dispose(): Promise<void> {
		if (this.disposed) { return; }
		this.disposed = true;
		if (this.stallWatch) { clearInterval(this.stallWatch); this.stallWatch = undefined; }
		const stopped = new AnalysisWorkerError('Analysis worker pool disposed', 'unavailable');
		this.rejectQueued(stopped);
		const slots = this.slots.splice(0);
		await Promise.all(slots.map((slot) => this.retire(slot, stopped)));
	}

	// ── Submission ──────────────────────────────────────────────────────────

	private submit(build: (id: number) => AnalysisRequest): Promise<AnalysisResult> {
		const request = build(this.nextRequestId++);
		const key = quarantineKey(request);
		// Checked before availability: a dangerous file must stay rejected even once the pool is broken.
		if (key !== undefined && this.quarantined.has(key)) {
			return Promise.reject(new AnalysisWorkerError('This file hung or crashed an analysis worker earlier in this session and is skipped until it changes', 'failed'));
		}
		if (!this.isAvailable()) {
			return Promise.reject(new AnalysisWorkerError('Analysis worker pool is not available', 'unavailable'));
		}
		return new Promise<AnalysisResult>((resolve, reject) => {
			this.queue.push({ request, resolve, reject, timer: undefined, retries: 0, timedOut: false, hostLookups: 0, postedAt: 0 });
			this.startStallWatch();
			this.pump();
		});
	}

	/** Hands queued requests to workers with spare capacity, growing the pool (up to `size`) when needed. */
	private pump(): void {
		for (const slot of this.slots) { this.drainResumes(slot); }
		while (this.queue.length > 0) {
			if (!this.isAvailable()) {
				this.rejectQueued(new AnalysisWorkerError('Analysis worker pool is not available', 'unavailable'));
				return;
			}
			let slot: Slot | undefined;
			try {
				slot = this.acquireSlot();
			} catch (error) {
				this.noteDeath();
				this.rejectQueued(new AnalysisWorkerError(`Could not start analysis worker: ${error instanceof Error ? error.message : String(error)}`, 'unavailable'));
				return;
			}
			if (!slot) { return; } // every worker is at capacity; a completion will pump again
			this.post(slot, this.queue.shift()!);
		}
	}

	private rejectQueued(error: Error): void {
		for (const pending of this.queue.splice(0)) { pending.reject(error); }
	}

	/**
	 * Lets requests whose host lookup has finished carry on, as many as the worker has running capacity for. Without this
	 * a cold index that answers many parked lookups at once would put all of them back on one serial worker together,
	 * though `pump` had meanwhile handed their slots to other files.
	 */
	private drainResumes(slot: Slot): void {
		while (slot.resumeQueue.length > 0 && this.runningCount(slot) < MAX_IN_FLIGHT_PER_WORKER) {
			slot.resumeQueue.shift()!();
		}
	}

	/** Requests on this worker that are actually running there, i.e. not parked waiting on the host. */
	private runningCount(slot: Slot): number {
		let running = 0;
		for (const pending of slot.pending.values()) { if (pending.hostLookups === 0) { running++; } }
		return running;
	}

	/** Least-loaded worker with spare capacity; a fresh one when all live workers are busy and there is room. */
	private acquireSlot(): Slot | undefined {
		let best: Slot | undefined;
		let bestRunning = Number.POSITIVE_INFINITY;
		for (const slot of this.slots) {
			const running = this.runningCount(slot);
			if (running < MAX_IN_FLIGHT_PER_WORKER && slot.pending.size < MAX_PENDING_PER_WORKER && running < bestRunning) { best = slot; bestRunning = running; }
		}
		if (best && bestRunning === 0) { return best; }
		if (this.slots.length < Math.max(1, this.options.size)) { return this.spawn(); }
		return best;
	}

	/** Starts (or restarts) a request's hang clock, unless it is waiting on the host, which is not a hang. */
	private armClock(slot: Slot, pending: Pending): void {
		if (pending.timer) { clearTimeout(pending.timer); pending.timer = undefined; }
		if (pending.hostLookups > 0) { return; }
		pending.timer = setTimeout(() => this.onTimeout(slot, pending), this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
		pending.timer.unref?.();
	}

	private post(slot: Slot, pending: Pending): void {
		pending.postedAt = Date.now();
		slot.pending.set(pending.request.id, pending);
		this.armClock(slot, pending);
		try {
			slot.worker.postMessage(pending.request);
		} catch (error) {
			slot.pending.delete(pending.request.id);
			clearTimeout(pending.timer);
			pending.timer = undefined;
			pending.reject(new AnalysisWorkerError(`Could not message analysis worker: ${error instanceof Error ? error.message : String(error)}`, 'unavailable'));
		}
	}

	// ── Worker lifecycle ────────────────────────────────────────────────────

	private spawn(): Slot {
		const data: AnalysisWorkerData = { extensionPath: this.options.extensionPath };
		const worker = this.options.createWorker
			? this.options.createWorker(this.options.workerPath, data)
			: new Worker(this.options.workerPath, {
				workerData: data,
				// Workers inherit the parent's node flags by default; the extension host's (--inspect, --require hooks, ...) are meant for that process, not for this one.
				execArgv: [],
				resourceLimits: { maxOldGenerationSizeMb: WORKER_MAX_OLD_GENERATION_MB },
			}) as unknown as WorkerLike;
		// A worker alone must never keep the host process alive.
		worker.unref?.();
		const slot: Slot = { worker, pending: new Map(), ready: false, resumeQueue: [] };
		this.slots.push(slot);
		worker.on('message', (message) => this.onMessage(slot, message));
		worker.on('error', (error) => this.onWorkerGone(slot, `worker error: ${error.message}`));
		worker.on('exit', (code) => this.onWorkerGone(slot, `worker exited with code ${code}`));
		this.options.log(`Analysis worker started (${this.slots.length}/${Math.max(1, this.options.size)})`);
		return slot;
	}

	private onMessage(slot: Slot, message: AnalysisWorkerMessage): void {
		if (message.type === 'warn') { this.options.warn(message.message); return; }
		if (message.type === 'ready') { slot.ready = true; return; }
		if (message.type === 'otelUsage') { this.answerOtelUsage(slot, message.rpcId, message.requestId, message.sessionFile); return; }
		if (message.type !== 'result') { return; }
		const pending = slot.pending.get(message.id);
		if (!pending) { return; }
		this.lastProgressAt = Date.now();
		slot.pending.delete(message.id);
		if (pending.timer) { clearTimeout(pending.timer); }
		pending.timer = undefined;
		if (message.ok) { pending.resolve(message.result); }
		else { pending.reject(new AnalysisWorkerError(message.error, 'failed', message.code)); }
		this.pump();
	}

	/**
	 * Answers a worker's OTel question from the host. The first lookup loads a multi-GB index (about a minute on a fast
	 * disk, far longer on a busy one). While a request is waiting on that it is the host that is working, not the
	 * worker, so: its hang clock is paused, and it stops counting against the worker's running window — otherwise a few
	 * such requests would occupy every slot and hold up all the files that do not need the index at all. The wait is
	 * bounded by HOST_LOOKUP_TIMEOUT_MS; past it the request fails (and is retried next refresh) rather than waiting on.
	 */
	private answerOtelUsage(slot: Slot, rpcId: number, requestId: number, sessionFile: string): void {
		if (Date.now() < this.hostLookupCooldownUntil) {
			try { slot.worker.postMessage({ type: 'otelUsageReply', rpcId, usage: null, error: 'the OTel index is still loading (an earlier lookup timed out); will retry on the next refresh' }); } catch { /* worker gone */ }
			return;
		}
		const pending = slot.pending.get(requestId);
		if (pending) {
			pending.hostLookups++;
			if (pending.timer) { clearTimeout(pending.timer); pending.timer = undefined; }
			this.pump(); // this request no longer occupies a running slot
		}
		const startedAt = Date.now();
		let settled = false;
		const reply = (): void => {
			// The worker may have died while the host was looking this up; there is no one to tell then.
			try { slot.worker.postMessage({ type: 'otelUsageReply', rpcId, usage: lastUsage, ...(lastError !== undefined ? { error: lastError } : {}) }); } catch { /* worker gone */ }
		};
		let lastUsage: CopilotCliOtelSessionUsage | null = null;
		let lastError: string | undefined;
		let timedOutLate = false;
		const finish = (usage: CopilotCliOtelSessionUsage | null, error?: string): void => {
			if (settled) { return; }
			settled = true;
			lastUsage = usage;
			lastError = error;
			clearTimeout(bound);
			const tookMs = Date.now() - startedAt;
			if (tookMs >= 5_000) { this.options.log(`OTel usage lookup for ${sessionFile} took ${(tookMs / 1000).toFixed(1)}s${error !== undefined ? ` and failed: ${error}` : ''}`); }
			if (pending && slot.pending.get(requestId) === pending) {
				// Hand the answer over once the worker has room to run this request again.
				slot.resumeQueue.push(() => {
					if (slot.pending.get(requestId) !== pending) { return; } // displaced from a dead worker meanwhile
					pending.hostLookups--;
					if (pending.hostLookups === 0) { this.armClock(slot, pending); }
					reply();
				});
				this.drainResumes(slot);
				return;
			}
			reply();
		};
		const limitMs = this.options.hostLookupTimeoutMs ?? HOST_LOOKUP_TIMEOUT_MS;
		const bound = setTimeout(() => {
			timedOutLate = true;
			this.lateHostLookups++;
			this.hostLookupCooldownUntil = Date.now() + (this.options.hostLookupCooldownMs ?? HOST_LOOKUP_COOLDOWN_MS);
			finish(null, `the host did not answer within ${limitMs / 1000}s`);
		}, limitMs);
		bound.unref?.();
		const resolve = this.options.resolveOtelUsage;
		if (!resolve) { finish(null); return; }
		const answered = (): void => {
			// The index the cooldown was waiting for has loaded: lookups can succeed again.
			if (timedOutLate && --this.lateHostLookups === 0) { this.hostLookupCooldownUntil = 0; }
		};
		resolve(sessionFile).then(
			(usage) => { answered(); finish(usage); },
			(error: unknown) => { answered(); finish(null, error instanceof Error ? error.message : String(error)); },
		);
	}

	/**
	 * Starts the watch that says, when nothing has completed for a while, what the pool is waiting on — queued and
	 * running requests, how many are parked on the host, and the longest-running one. A refresh that sits at a few
	 * percent otherwise leaves no trace of why.
	 */
	private startStallWatch(): void {
		if (this.stallWatch || this.disposed) { return; }
		const limitMs = this.options.stallReportMs ?? DEFAULT_STALL_REPORT_MS;
		this.stallWatch = setInterval(() => this.reportStall(limitMs), Math.max(10, Math.min(limitMs, 10_000)));
		this.stallWatch.unref?.();
	}

	private reportStall(limitMs: number): void {
		let inFlight = 0;
		let onHost = 0;
		let oldest: Pending | undefined;
		for (const slot of this.slots) {
			for (const pending of slot.pending.values()) {
				inFlight++;
				if (pending.hostLookups > 0) { onHost++; }
				if (!oldest || pending.postedAt < oldest.postedAt) { oldest = pending; }
			}
		}
		if (inFlight === 0 && this.queue.length === 0) { this.lastProgressAt = Date.now(); return; }
		const now = Date.now();
		if (now - this.lastProgressAt < limitMs || now - this.lastStallReportAt < limitMs) { return; }
		this.lastStallReportAt = now;
		const what = oldest ? ('path' in oldest.request ? oldest.request.path : 'workspace' in oldest.request ? oldest.request.workspace : 'a request') : 'none';
		this.options.warn(`Analysis pool: no request has completed for ${Math.round((now - this.lastProgressAt) / 1000)}s — ${this.queue.length} queued, ${inFlight} on workers (${onHost} waiting on the host), longest-running: ${what}${oldest ? ` for ${Math.round((now - oldest.postedAt) / 1000)}s${oldest.hostLookups > 0 ? ' (waiting on the host)' : ''}` : ''}`);
	}

	private onTimeout(slot: Slot, pending: Pending): void {
		if (!slot.pending.has(pending.request.id)) { return; }
		// Only one request per worker is ever the culprit. The other clocks are disarmed below, but if one still
		// fires while the termination is pending, it is a neighbour, not a second culprit.
		for (const other of slot.pending.values()) { if (other.timedOut) { return; } }
		pending.timedOut = true;
		// Termination is asynchronous. Neighbours submitted alongside this request carry a near-identical clock that
		// could fire before the worker's exit is observed, make them culprits too, and get them rejected instead of
		// re-sent. This request is the culprit; stop every other clock on the worker now.
		for (const other of slot.pending.values()) {
			if (other !== pending && other.timer) { clearTimeout(other.timer); other.timer = undefined; }
		}
		const target = 'path' in pending.request ? pending.request.path : 'workspace' in pending.request ? pending.request.workspace : 'a session';
		this.options.warn(`Analysis of ${target} exceeded ${(this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS) / 1000}s; restarting its worker`);
		// Killing the worker is the only way to stop a hung synchronous parse. The exit handler
		// rejects this request as a timeout and re-sends the innocent ones sharing the worker.
		void slot.worker.terminate().catch(() => undefined);
	}

	/** Shared by 'error' and 'exit': both mean this worker can no longer answer. */
	private onWorkerGone(slot: Slot, reason: string): void {
		const index = this.slots.indexOf(slot);
		if (index === -1) { return; } // already handled (error is normally followed by exit)
		this.slots.splice(index, 1);
		const displaced = [...slot.pending.values()];
		slot.pending.clear();
		this.options.warn(`Analysis ${reason}`);
		this.noteDeath();
		void slot.worker.terminate().catch(() => undefined);
		const retry: Pending[] = [];
		// A request that timed out is why this worker was killed. Its neighbours are innocent, however many
		// earlier deaths they have been through, so they are re-sent without spending their own retry.
		const culpritKnown = displaced.some((p) => p.timedOut);
		for (const pending of displaced) {
			if (pending.timer) { clearTimeout(pending.timer); }
			pending.timer = undefined;
			// Any host lookup it was waiting on belonged to the worker that just died; its completion can no longer
			// reach this request (the slot's bookkeeping is gone), so the count would stay raised for good and a
			// re-sent request would never get a hang clock or count as running.
			pending.hostLookups = 0;
			if (this.disposed || !slot.ready) {
				// Disposed, or the worker never got as far as `ready` (its bundle failed to load, or hung while
				// initialising — requests are clocked from the moment they are posted, so that can surface as a timeout):
				// nothing was learned about this file, so it is neither blamed nor quarantined, and the caller may
				// analyze it in-process. Checked before the timeout verdict for exactly that reason.
				pending.reject(new AnalysisWorkerError(`Analysis worker stopped (${reason})`, 'unavailable'));
			} else if (pending.timedOut) {
				this.quarantine(pending);
				pending.reject(new AnalysisWorkerError(`Analysis timed out (${reason})`, 'timeout'));
			} else if (culpritKnown) {
				if (this.isAvailable()) { retry.push(pending); }
				else { pending.reject(new AnalysisWorkerError(`Analysis workers keep dying (${reason})`, 'unavailable')); }
			} else if (pending.retries >= MAX_RETRIES_AFTER_WORKER_DEATH) {
				// Two workers died under this request: it is the likely cause (OOM, native crash). Falling back
				// to in-process analysis would repeat that failure on the host, so this is a file failure.
				this.quarantine(pending);
				pending.reject(new AnalysisWorkerError(`Analysis worker died repeatedly (${reason})`, 'failed'));
			} else if (!this.isAvailable()) {
				// Only the pool-wide restart budget ran out; this request is not shown to be the culprit.
				pending.reject(new AnalysisWorkerError(`Analysis workers keep dying (${reason})`, 'unavailable'));
			} else {
				pending.retries++;
				retry.push(pending);
			}
		}
		// Re-sent work goes to the front: it has already waited its turn once.
		this.queue.unshift(...retry);
		this.pump();
	}

	private quarantine(pending: Pending): void {
		const key = quarantineKey(pending.request);
		if (key !== undefined) { this.quarantined.add(key); }
	}

	private noteDeath(): void {
		const now = Date.now();
		const windowMs = this.options.restartWindowMs ?? DEFAULT_RESTART_WINDOW_MS;
		this.deathTimestamps.push(now);
		while (this.deathTimestamps.length > 0 && now - this.deathTimestamps[0] > windowMs) { this.deathTimestamps.shift(); }
		if (this.deathTimestamps.length > (this.options.maxRestarts ?? DEFAULT_MAX_RESTARTS) && !this.broken) {
			this.broken = true;
			this.options.warn('Analysis workers keep dying; falling back to in-process analysis for the rest of this session.');
			this.retireAllWorkers();
		}
	}

	/**
	 * The pool will never hand out work again, so the workers that are still alive would only sit on their
	 * per-thread SQLite/WASM caches while the in-process fallback builds another set on the host — the worst time
	 * to hold memory, since repeated deaths are often memory pressure. Their in-flight and queued requests are
	 * settled as `unavailable`, so each falls back in-process.
	 */
	private retireAllWorkers(): void {
		const stopped = new AnalysisWorkerError('Analysis workers keep dying; using in-process analysis', 'unavailable');
		this.rejectQueued(stopped);
		for (const slot of this.slots.splice(0)) { void this.retire(slot, stopped); }
	}

	/** Tears a worker down on purpose. The slot is already out of `slots`, so its exit event is ignored. */
	private async retire(slot: Slot, reason: Error): Promise<void> {
		for (const pending of slot.pending.values()) {
			if (pending.timer) { clearTimeout(pending.timer); }
			if (pending.timedOut) {
				// Its worker is already being killed for hanging on it, and the exit that would have said so is now ignored
				// (the slot is out of `slots`). Keep the verdict: `unavailable` would have the host run the file itself.
				this.quarantine(pending);
				pending.reject(new AnalysisWorkerError('Analysis timed out (its worker was retired while being restarted)', 'timeout'));
			} else {
				pending.reject(reason);
			}
		}
		slot.pending.clear();
		try { await slot.worker.terminate(); } catch { /* already gone */ }
	}
}
