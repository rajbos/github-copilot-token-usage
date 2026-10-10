/**
 * Session file cache management.
 * Handles persistent caching of parsed session data to avoid re-reading files.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import type { SessionFileCache } from '../../src/types';
import { mergePlaceholderDetails } from './detailsOnlyCache';
import { type CachePolicy, VsCodeCachePolicy } from '../../src/cachePolicy';

export interface CacheManagerDeps {
	log: (msg: string) => void;
	warn: (msg: string) => void;
	error: (msg: string) => void;
	// Called synchronously whenever checkClearEpoch() detects and drops a peer's clear. This
	// class's own session cache is dropped either way; this hook exists so a caller with its own,
	// separate derived/computed caches gated by their own generation stamp (e.g. the extension's
	// per-view stats caches) can invalidate those too — see checkClearEpoch()'s own doc comment for
	// why a peer-detected clear would otherwise leave them silently stale. Optional so existing
	// callers with no such caches (and every test's makeManager()) need not supply it.
	onPeerClearDetected?: () => void;
}

export class CacheManager {
	private static readonly SNAPSHOT_SCHEMA_VERSION = 1;
	private static readonly SNAPSHOT_MAX_ENTRIES = 20_000;

	// Checkpoint constants: save every N new entries or every M milliseconds, whichever comes first.
	// Each checkpoint serializes the ENTIRE merged cache (buildMergedSnapshotEntries() reads the
	// full sessionFileCache Map, not just the dirty entries), so its cost scales with total cache
	// size, not with how much actually changed. On a large, long-lived cache (thousands of session
	// files) that full JSON.parse/merge/JSON.stringify/write round trip can itself take several
	// seconds, and it blocks the event loop for that entire window — during a big cold-start scan
	// with many dirty entries, checkpointing too eagerly compounds into a real chunk of the scan's
	// wall-clock time. These were tuned up from 100/20_000 accordingly; still frequent enough to
	// bound crash-loss to well under a minute of unsaved parses.
	private static readonly CHECKPOINT_NEW_ENTRIES_THRESHOLD = 300;
	private static readonly CHECKPOINT_INTERVAL_MS = 45_000;

	private sessionFileCache: Map<string, SessionFileCache> = new Map();
	// Paths explicitly removed via deleteCachedSessionData(), for the lifetime of this
	// CacheManager instance, mapped to the mtime of the entry that was removed (0 if none was
	// cached). writeSharedSnapshot()'s merge starts from whatever is already on disk (so a window
	// with a partial in-memory cache can never regress a richer published snapshot — see its own
	// doc comment) — without tracking deletions separately, that same merge would silently
	// resurrect a path removed from `sessionFileCache` the moment it's no longer present in memory
	// to overwrite the stale on-disk copy. Tombstones let the merge tell "never seen this session"
	// (leave the disk copy alone) apart from "seen and removed" (must not survive the merge).
	//
	// The recorded mtime is this tombstone's generation baseline, not just a boolean flag: another
	// window can legitimately republish the same path (rediscover it, or simply save after this
	// one decided to delete it) with a newer entry than what this window last saw. Blindly
	// stripping every tombstoned path from the freshly-read on-disk snapshot — regardless of how
	// new that disk entry is — would destroy that other window's valid, newer publish. Comparing
	// against the baseline lets a same-or-older disk entry (what this window actually intended to
	// delete) be stripped while a strictly newer one survives.
	private deletedFilePaths: Map<string, number> = new Map();
	private readonly context: vscode.ExtensionContext;
	private readonly deps: CacheManagerDeps;
	private readonly cacheVersion: number;
	private readonly policy: CachePolicy<SessionFileCache>;
	private lastLoadedSnapshotMtime = 0;
	// The durable clear epoch (see getClearEpochPath()) this window's in-memory cache is known
	// consistent with. Starts at 0 (nothing loaded yet) and is seeded from disk by
	// loadCacheFromStorage(), advanced locally by deleteSharedSnapshot() (this window clearing),
	// and advanced from disk by checkClearEpoch() (another window clearing).
	private clearEpoch = 0;
	// Checkpoint tracking
	private lastCheckpointTime = 0;
	private entriesSinceLastCheckpoint = 0;
	private checkpointInProgress = false;
	// Bumped by resetCheckpointCounters(). Lets a still-in-flight checkpoint (see
	// checkpointCacheInternal()) tell whether a new refresh cycle reset the counters out from
	// under it while its own save was awaiting, so it doesn't subtract its now-stale captured
	// count against a counter that has since started fresh.
	private checkpointCounterGeneration = 0;
	// The currently in-flight checkpoint's own settle promise (set by maybeCheckpointCache()/
	// forceCheckpointCache(), resolved once checkpointCacheInternal() and its `.finally()` have
	// both run). Lets a caller that must not race a checkpoint's write — clearCache() deleting
	// the snapshot, or a new refresh cycle about to reset the counters that write depends on —
	// await its completion instead of merely polling checkpointInProgress.
	private checkpointSettlePromise: Promise<void> | undefined;
	// Bumped by clearAllCachedData(). writeSharedSnapshot() captures this before it reads the
	// (possibly about-to-be-cleared) on-disk snapshot and re-checks it right before the atomic
	// rename — if a clear landed in between, that write is built from stale, pre-clear data and
	// would resurrect exactly what the clear just removed, so it aborts instead of persisting.
	private cacheClearGeneration = 0;
	// Counts clearAllCachedData() calls not yet matched by a finished deleteSharedSnapshot() — the two
	// calls clearCache() always makes back to back. In between, the in-memory cache has already been
	// emptied, but the on-disk snapshot and the durable epoch have not caught up yet:
	// deleteSharedSnapshot() can be stuck retrying for the cache lock for its whole retry budget (up
	// to 10s in production) if a peer holds it. A loader (loadSharedSnapshotIfChanged(),
	// loadCacheFromStorage()) that starts in that exact window captures a clear-generation baseline
	// that already reflects the clearAllCachedData() bump — so its own generation check alone sees no
	// *further* change — while the epoch, not yet advanced, also reports nothing new. Neither of
	// those two checks can see this specific gap; checking this counter is a third, independent
	// signal that closes it regardless of which of the other two would otherwise have caught (or
	// missed) the same interleaving.
	//
	// A counter, not a boolean: two clearCache() calls can overlap (nothing today serializes them —
	// e.g. a double-invoked command), and a plain boolean set false by whichever deleteSharedSnapshot()
	// finishes first would wrongly report "no clear in progress" while the other one is still mid-flight,
	// stuck on the lock with the epoch not yet advanced. Only once every outstanding clearAllCachedData()
	// has been matched by its own finished deleteSharedSnapshot() does the count return to zero.
	private clearInProgressCount = 0;
	private get clearInProgress(): boolean {
		return this.clearInProgressCount > 0;
	}

	constructor(
		context: vscode.ExtensionContext,
		deps: CacheManagerDeps,
		cacheVersion: number,
		policy?: CachePolicy<SessionFileCache>,
	) {
		this.context = context;
		this.deps = deps;
		this.cacheVersion = cacheVersion;
		this.policy = policy ?? new VsCodeCachePolicy(deps.log);
	}

	get cache(): Map<string, SessionFileCache> {
		return this.sessionFileCache;
	}

	/**
	 * Clears every in-memory cache entry and tombstone, and bumps cacheClearGeneration so a
	 * checkpoint already mid-flight (built from pre-clear data) discards its write instead of
	 * resurrecting it — see writeSharedSnapshot()'s doc comment. Callers that must not race that
	 * in-flight checkpoint's own write to the shared snapshot file (e.g. clearCache() deleting it
	 * right after) should also await awaitInFlightCheckpoint() before doing so.
	 *
	 * Also clears deletedFilePaths: a pre-clear tombstone left behind would otherwise still be
	 * applied by buildMergedSnapshotEntries() on a later save, stripping an entry that a window
	 * legitimately republishes at or below that stale baseline mtime — a "Clear Cache" is meant to
	 * reset all cache state, deletion decisions included, not just the live entries.
	 *
	 * Also resets the checkpoint dirty-count accounting (same fields resetCheckpointCounters()
	 * touches). Without this, dirty work left over from before the clear stayed counted as dirty
	 * against a now-empty cache: the next leader refresh's flushPendingCheckpointBeforeReset()
	 * would see that stale count and perform a full checkpoint save of the just-cleared (empty)
	 * cache before parsing anything of its own — harmless in effect, since there is genuinely
	 * nothing to lose, but a wasted disk round trip that defeats the "skip when nothing changed"
	 * optimization on the very next cycle after every clear.
	 *
	 * Also increments clearInProgressCount, decremented again once deleteSharedSnapshot() (which
	 * every real caller — clearCache() — invokes right after this) finishes advancing the durable
	 * epoch marker. See that field's own doc comment for the same-process race this closes that
	 * neither the generation counter nor the epoch alone can catch, and for why it is a counter
	 * rather than a boolean.
	 *
	 * MUST be followed by a matching deleteSharedSnapshot() call. Nothing else decrements
	 * clearInProgressCount, so calling this standalone leaves every later writeSharedSnapshot() call
	 * aborting and every later loadSharedSnapshotIfChanged()/loadCacheFromStorage() call discarding
	 * what it just merged, permanently, for the life of this instance — see the dedicated regression
	 * test documenting this in cacheManager-snapshot.test.ts for the exact failure shape.
	 */
	clearAllCachedData(): void {
		this.sessionFileCache.clear();
		this.deletedFilePaths.clear();
		this.cacheClearGeneration++;
		this.resetCheckpointCounters();
		this.clearInProgressCount++;
	}

	// Cache management methods
	/**
	 * Checks if the cache is valid for a file by comparing mtime and size.
	 * If the cache entry is missing size (old format), treat as invalid so it will be upgraded.
	 */
	isCacheValid(filePath: string, currentMtime: number, currentSize: number): boolean {
		const cached = this.sessionFileCache.get(filePath);
		if (!cached) {
			return false;
		}
		return this.policy.isValid(cached, currentMtime, currentSize);
	}

	getCachedSessionData(filePath: string): SessionFileCache | undefined {
		return this.sessionFileCache.get(filePath);
	}

	/**
	 * Sets the cache entry for a session file, including file size. Every call is a real write —
	 * a fresh parse, or an existing entry enriched in place with the same mtime/size (e.g. the
	 * debug-log supplement path marking `debugLogChecked`/reconciling exact tokens) — so every
	 * call marks the cache dirty for checkpointing purposes. An earlier version gated this on an
	 * mtime/size-based "isNewEntry" flag the caller computed; that missed exactly the in-place
	 * enrichment case, so a checkpoint could skip persisting it and lose it to a crash before the
	 * next full save.
	 */
	setCachedSessionData(filePath: string, data: SessionFileCache, fileSize?: number): void {
		if (typeof fileSize === 'number') {
			data.size = fileSize;
		}
		this.sessionFileCache.set(filePath, data);
		// A path can be legitimately rediscovered after being deleted (see deleteCachedSessionData);
		// a stale tombstone must not keep blocking it from ever being persisted again.
		this.deletedFilePaths.delete(filePath);
		this.policy.evict(this.sessionFileCache);
		this.entriesSinceLastCheckpoint++;
	}

	/**
	 * Removes a cache entry and records a tombstone so it does not get silently resurrected by
	 * writeSharedSnapshot()'s merge (which starts from whatever is already on disk) the next time
	 * the cache is saved. Prefer this over `cache.delete(path)` directly for any deletion whose
	 * effect must actually survive a save — an in-memory-only delete is undone by the very next
	 * trySaveCacheToStorage()/checkpoint.
	 */
	deleteCachedSessionData(filePath: string): void {
		const existing = this.sessionFileCache.get(filePath);
		const previousTombstoneMtime = this.deletedFilePaths.get(filePath);
		this.sessionFileCache.delete(filePath);
		// A second, independent deletion of an already-tombstoned path (e.g. clearExpiredCache()'s
		// fire-and-forget sweep racing with reconcilePreloadedAgainstDiscovery()'s synchronous one)
		// finds no `existing` entry — the first deletion already removed it from sessionFileCache —
		// so `existing?.mtime ?? 0` alone would silently weaken an already-recorded, stronger
		// baseline down to 0, letting any stale disk entry with a positive mtime pass the
		// newer-than-tombstone check and be resurrected. Keep the strongest (highest) baseline seen.
		const newTombstoneMtime = Math.max(previousTombstoneMtime ?? 0, existing?.mtime ?? 0);
		this.deletedFilePaths.set(filePath, newTombstoneMtime);
		// A tombstone is dirty state too — it must reach the next snapshot save just like a new or
		// changed entry, or a deleted path can sit unpersisted until an unrelated write happens to
		// trigger a checkpoint. But only when something actually changed: an in-memory entry was
		// really removed, or the tombstone's baseline mtime actually advanced. The repeated,
		// independent-deletion race described above is expected and can fire often on the very
		// same already-gone path — counting every one of those no-op calls as dirty would keep
		// nudging the checkpoint threshold with nothing new to save, reproducing the wasted-write
		// problem this dirty-tracking rework exists to fix.
		if (existing !== undefined || newTombstoneMtime !== (previousTombstoneMtime ?? 0)) {
			this.entriesSinceLastCheckpoint++;
		}
	}

	async clearExpiredCache(): Promise<void> {
		// Remove cache entries for files that no longer exist (async to avoid blocking the event loop)
		const filesToCheck = Array.from(this.sessionFileCache.keys());
		const BATCH_SIZE = 50;
		for (let i = 0; i < filesToCheck.length; i += BATCH_SIZE) {
			await Promise.all(
				filesToCheck.slice(i, i + BATCH_SIZE).map(async (filePath) => {
					// Several ecosystems (Copilot CLI, Crush, Kilo, OpenCode, Cursor's state.vscdb#,
					// Codex's state_<n>.sqlite#) reference sessions through a virtual
					// "<db-file>#<session-id>" path, and Windsurf/Devin use a "windsurf://"/"devin://"
					// URI scheme — none of these are real filesystem paths
					// a raw fs.access() can validate; the actual session lives inside the DB (or is
					// resolved by that adapter), not at this literal path. Since deleteCachedSessionData()
					// now tombstones (excluding the path from every future snapshot merge, not just this
					// process's memory — see its own doc comment), wrongly treating one of these as
					// "missing" here would permanently discard a still-valid, expensive-to-rebuild
					// session instead of just transiently dropping it from memory. Leaving them
					// unvalidated here (neither expired nor confirmed) is the safe default; a real fix
					// needs adapter-aware stat resolution, which CacheManager doesn't have.
					if (CacheManager.isVirtualSessionPath(filePath)) { return; }
					try {
						await fs.promises.access(filePath);
					} catch (err) {
						// fs.access() also rejects for reasons that don't mean "this file is gone" —
						// EACCES/EPERM (a permissions hiccup), EBUSY, a transiently unmounted network
						// drive, etc. Given deleteCachedSessionData()'s tombstone now excludes the path
						// from every future snapshot save (not just this process's memory), treating any
						// of those as a confirmed deletion would permanently discard a still-valid,
						// expensive-to-rebuild session over what may be a passing I/O error. Only a
						// "this path definitely doesn't exist" error is trustworthy enough to tombstone.
						const code = (err as NodeJS.ErrnoException)?.code;
						if (code === 'ENOENT' || code === 'ENOTDIR') {
							this.deleteCachedSessionData(filePath);
						}
					}
				})
			);
		}
	}

	private static isVirtualSessionPath(filePath: string): boolean {
		// Every "<db-file>#<session-id>" composite scheme observed across adapters — OpenCode/Crush/
		// Kilo/Copilot CLI's session-store.db, but also Cursor's state.vscdb# and Codex's
		// state_<n>.sqlite# — shares the same shape: a file-extension-like segment right before the
		// '#'. Matching that shape generically (rather than hardcoding '.db#' alone) avoids silently
		// missing the next adapter that reuses this pattern with a different backing-file extension.
		return filePath.includes('://') || /\.[a-zA-Z0-9]+#/.test(filePath);
	}

	/**
	 * Check if a checkpoint save should be triggered based on time or entry count thresholds.
	 * Returns true if checkpoint was triggered.
	 */
	maybeCheckpointCache(): boolean {
		// Nothing to save: a time-threshold-only trigger with zero dirty entries used to still
		// take the full read-merge-stringify-write round trip (see checkpointCacheInternal) for
		// no effect — a wasted, blocking write every CHECKPOINT_INTERVAL_MS while a run is 100%
		// cache hits. Bail out before that work even if the time threshold has elapsed.
		if (this.entriesSinceLastCheckpoint <= 0) {
			return false;
		}
		const now = Date.now();
		const timeElapsed = now - this.lastCheckpointTime;
		const entriesThresholdReached = this.entriesSinceLastCheckpoint >= CacheManager.CHECKPOINT_NEW_ENTRIES_THRESHOLD;
		const timeThresholdReached = timeElapsed >= CacheManager.CHECKPOINT_INTERVAL_MS;

		if ((entriesThresholdReached || timeThresholdReached) && !this.checkpointInProgress) {
			this.startCheckpoint();
			return true;
		}
		return false;
	}

	/** Marks a checkpoint in progress and kicks off checkpointCacheInternal(), tracking its
	 * settle promise so awaitInFlightCheckpoint() can observe completion. Shared by
	 * maybeCheckpointCache() (fire-and-forget) and forceCheckpointCache() (awaited). */
	private startCheckpoint(): void {
		this.checkpointInProgress = true;
		const settling = this.checkpointCacheInternal().finally(() => {
			this.checkpointInProgress = false;
			// Only clear the field if it's still pointing at *this* checkpoint's promise — a new
			// checkpoint could already have started and reassigned it by the time this settles.
			if (this.checkpointSettlePromise === settling) {
				this.checkpointSettlePromise = undefined;
			}
		});
		this.checkpointSettlePromise = settling;
	}

	/**
	 * Whether there is parsed/changed/deleted cache state that has not yet reached disk. Exposed
	 * for callers like _runRefreshCore() that need to know whether resetCheckpointCounters()
	 * would clobber real, unpersisted dirty state before calling it.
	 */
	hasUnflushedCheckpointWork(): boolean {
		return this.entriesSinceLastCheckpoint > 0;
	}

	/**
	 * Resolves once a checkpoint already mid-flight (started by maybeCheckpointCache() or this
	 * method) has fully settled. A no-op if none is in progress. Used wherever a caller's own
	 * write must not race a checkpoint's — see checkpointSettlePromise's doc comment.
	 */
	async awaitInFlightCheckpoint(): Promise<void> {
		if (this.checkpointSettlePromise) {
			await this.checkpointSettlePromise;
		}
	}

	/**
	 * Force an immediate checkpoint save, bypassing maybeCheckpointCache()'s time/entry
	 * thresholds, and await its completion. A no-op if one is already in progress (callers that
	 * care should await awaitInFlightCheckpoint() first) or if nothing is dirty. Used by
	 * _runRefreshCore() to flush a previous cycle's unpersisted work before resetting the
	 * counters that are its only record of being dirty.
	 */
	async forceCheckpointCache(): Promise<void> {
		if (this.entriesSinceLastCheckpoint <= 0 || this.checkpointInProgress) {
			return;
		}
		this.startCheckpoint();
		await this.checkpointSettlePromise;
	}

	/**
	 * Internal method to perform the checkpoint save.
	 *
	 * Only clears the dirty count on an actual persisted write, and only the portion of it this
	 * save actually captured. trySaveCacheToStorage() never throws — it resolves `false` on a
	 * skipped (lock held by another window) or failed save — so resetting unconditionally here
	 * would let a lock-contended tick (an expected, routine occurrence, not a rare error)
	 * silently drop its dirty count. Combined with maybeCheckpointCache()'s "skip when nothing is
	 * dirty" guard, that would leave the change unpersisted with no future tick ever retrying it.
	 *
	 * Subtracting rather than zeroing on success matters too: workers keep calling
	 * setCachedSessionData()/deleteCachedSessionData() while trySaveCacheToStorage() is in flight,
	 * and buildMergedSnapshotEntries() (inside writeSharedSnapshot()) reads the live cache Map at
	 * the start of that write — an entry added after that read is not necessarily reflected in
	 * what actually reached disk. Zeroing the whole counter here would wrongly mark that
	 * in-flight write as checkpointed too, the same "lost on a crash before the next save" risk
	 * this whole checkpoint-dirty-tracking rework exists to close.
	 *
	 * That subtraction is itself only valid against the counter it was captured from. If
	 * resetCheckpointCounters() runs while this save is still in flight — a new leader refresh
	 * cycle starting — it zeros the counter for that new cycle; subtracting this stale, unrelated
	 * count against it afterwards could wrongly erase dirty entries the new cycle has genuinely
	 * accumulated since. checkpointCounterGeneration detects that and skips the update entirely
	 * in that case, leaving the new cycle's own counter (and its own future checkpoint) untouched.
	 *
	 * trySaveCacheToStorage() is documented never to throw, but this awaits it inside a try/catch
	 * anyway: forceCheckpointCache()/awaitInFlightCheckpoint() now await this method's settle
	 * promise directly (unlike the original fire-and-forget-only caller, maybeCheckpointCache()),
	 * so a rejection here would no longer just be an unhandled-rejection warning — it would
	 * propagate into a caller like _runRefreshCore()'s flushPendingCheckpointBeforeReset() and can
	 * fail an otherwise-healthy refresh outright. Treating a thrown error the same as `saved =
	 * false` keeps that contract true in practice, not just by convention.
	 */
	private async checkpointCacheInternal(): Promise<void> {
		const entriesCountAtStart = this.entriesSinceLastCheckpoint;
		this.deps.log(`Checkpointing cache: ${entriesCountAtStart} dirty entries (new, changed, or deleted) since last checkpoint (${((Date.now() - this.lastCheckpointTime) / 1000).toFixed(1)}s elapsed)`);
		await this.saveAndAccount();
	}

	/**
	 * Shared save+accounting core for every full-snapshot persist — a periodic mid-parse
	 * checkpoint and the unconditional end-of-refresh save alike (see saveAndAccountForRefresh()).
	 * Captures the dirty count/generation before saving and only subtracts/updates
	 * lastCheckpointTime once the save actually succeeded and no reset landed mid-save (see
	 * checkpointCounterGeneration's doc comment). Never throws.
	 */
	private async saveAndAccount(): Promise<boolean> {
		const now = Date.now();
		const entriesCountAtStart = this.entriesSinceLastCheckpoint;
		const generationAtStart = this.checkpointCounterGeneration;

		let saved: boolean;
		try {
			saved = await this.trySaveCacheToStorage();
		} catch (error) {
			this.deps.error(`Cache save threw unexpectedly: ${error}`);
			saved = false;
		}
		if (saved && this.checkpointCounterGeneration === generationAtStart) {
			this.lastCheckpointTime = now;
			this.entriesSinceLastCheckpoint = Math.max(0, this.entriesSinceLastCheckpoint - entriesCountAtStart);
		} else if (!saved) {
			this.deps.log('Cache save was skipped or failed; leaving the dirty count intact so the next checkpoint retries it');
		}
		return saved;
	}

	/**
	 * Save the cache to disk and account for it exactly like a checkpoint, unconditionally
	 * (regardless of dirty-count/time thresholds, and regardless of whether a periodic checkpoint
	 * happens to be mid-flight — that concurrent attempt simply loses the cache-file lock race and
	 * reports `false`, the same outcome as any other lock-contended save, never a correctness
	 * problem). Used by persistRefreshResult() at the end of every leader refresh.
	 *
	 * persistRefreshResult()'s save used to call trySaveCacheToStorage() directly, bypassing
	 * checkpoint accounting entirely: entriesSinceLastCheckpoint stayed exactly as dirty as it was
	 * before that fully successful save. The *next* leader cycle's flushPendingCheckpointBeforeReset()
	 * then saw that stale dirty count and performed a redundant extra checkpoint read/merge/write
	 * before it had done anything of its own — for any refresh under the 100-entry threshold, on
	 * every single cycle — defeating the "skip when nothing changed" optimization this whole
	 * checkpoint rework exists for. Routing this save through the same accounting as a checkpoint
	 * closes that gap: a successful end-of-refresh save now leaves nothing dirty behind it.
	 */
	async saveAndAccountForRefresh(): Promise<boolean> {
		return this.saveAndAccount();
	}

	/**
	 * Reset checkpoint counters (call this at the start of a new refresh cycle).
	 *
	 * Deliberately does not touch checkpointInProgress. A checkpoint from the previous cycle can
	 * still be mid-flight (its own trySaveCacheToStorage() awaiting) when this runs — forcing the
	 * flag false here would let maybeCheckpointCache() start a second, overlapping checkpoint
	 * before the first one's own `.finally()` gets a chance to clear it, defeating the "at most
	 * one checkpoint at a time" invariant this flag exists for. checkpointCacheInternal()'s
	 * `.finally()` always clears it once that save actually settles, so there is nothing for this
	 * method to do here.
	 */
	resetCheckpointCounters(): void {
		this.lastCheckpointTime = Date.now();
		this.entriesSinceLastCheckpoint = 0;
		this.checkpointCounterGeneration++;
	}

	/**
	 * Generate a cache identifier based on VS Code extension mode.
	 * VS Code editions (stable vs insiders) already have separate globalState storage,
	 * so we only need to distinguish between production and development (debug) mode.
	 * The identifier is stable across Extension Development Host launches (it is not
	 * derived from vscode.env.sessionId, which changes every F5/debug run and every
	 * fresh worktree). This lets consecutive debug sessions reuse the same on-disk
	 * snapshot instead of re-parsing all session files from scratch every time, while
	 * still keeping debug-mode data isolated from the 'prod' snapshot used by real
	 * installs. Cache invalidation across debug runs is driven by content, not
	 * identity: a schemaVersion/cacheVersion mismatch (see loadCacheFromStorage) still
	 * clears the cache whenever the on-disk shape or parsing logic actually changes.
	 * Concurrent debug windows (e.g. multiple worktrees debugged at once) share this
	 * identifier safely via the same leader-election/lock coordination used for
	 * multiple production windows — see acquireRefreshLock().
	 */
	getCacheIdentifier(): string {
		if (this.context.extensionMode === vscode.ExtensionMode.Development) {
			return 'dev';
		}
		return 'prod';
	}

	/**
	 * Deletes legacy per-session dev-mode cache/lock files (e.g. `cache_dev-<hash>.snapshot.json`)
	 * left behind by older versions of the extension, which used to mint a new dev-<hash>
	 * identifier per Extension Development Host launch — orphaning every past debug session's
	 * snapshot once that window closed. getCacheIdentifier() now returns a stable 'dev'
	 * identifier, so no new files matching this legacy pattern are created; this cleanup only
	 * reclaims leftovers from before that change. Only touches files older than
	 * STALE_DEV_CACHE_AGE_MS, so the current and any still-running sessions' files are never at
	 * risk. Best-effort: failures (e.g. a file locked by another window) are swallowed, not surfaced.
	 */
	async cleanupStaleDevCacheFiles(): Promise<void> {
		if (this.context.extensionMode !== vscode.ExtensionMode.Development) { return; }
		const STALE_DEV_CACHE_AGE_MS = 24 * 60 * 60 * 1000;
		const dir = this.context.globalStorageUri.fsPath;
		try {
			const entries = await fs.promises.readdir(dir);
			const now = Date.now();
			let removedCount = 0;
			for (const name of entries) {
				if (!/^(cache|refresh|agenttasks|repoprs)_dev-[0-9a-f]+\.(snapshot\.json|lock)$/.test(name)) { continue; }
				const filePath = path.join(dir, name);
				try {
					const stat = await fs.promises.stat(filePath);
					if (now - stat.mtimeMs > STALE_DEV_CACHE_AGE_MS) {
						await fs.promises.unlink(filePath);
						removedCount++;
					}
				} catch { /* file removed/locked concurrently — skip */ }
			}
			if (removedCount > 0) {
				this.deps.log(`Cleaned up ${removedCount} stale dev cache file(s) from previous debug sessions`);
			}
		} catch { /* globalStorage dir missing or unreadable — nothing to clean up */ }
	}

	/**
	 * Get the path for the cache lock file.
	 * Uses globalStorageUri which is already scoped per VS Code edition.
	 */
	getCacheLockPath(): string {
		const cacheId = this.getCacheIdentifier();
		return path.join(this.context.globalStorageUri.fsPath, `cache_${cacheId}.lock`);
	}

	/**
	 * Get the path for the refresh leader lock file.
	 * Held by the single window ("leader") that performs the heavy discover+parse
	 * pass, so that other windows ("followers") can skip parsing and reload the
	 * shared snapshot instead. Shared per VS Code edition via globalStorageUri.
	 */
	getRefreshLockPath(): string {
		const cacheId = this.getCacheIdentifier();
		return path.join(this.context.globalStorageUri.fsPath, `refresh_${cacheId}.lock`);
	}

	/**
	 * Get the path for the agent-tasks refresh lock file.
	 * Held by the single window that refreshes the hourly Copilot cloud-agent snapshot from the
	 * GitHub API, so the other windows never duplicate those API calls. Kept separate from the
	 * cache-refresh leader lock because the two run on different schedules.
	 */
	getAgentTasksLockPath(): string {
		const cacheId = this.getCacheIdentifier();
		return path.join(this.context.globalStorageUri.fsPath, `agenttasks_${cacheId}.lock`);
	}

	/**
	 * Get the path for the repository-PRs refresh lock file.
	 * Held by the single window that refreshes the hourly Repository PRs snapshot from the
	 * GitHub API, so the other windows never duplicate those API calls. Kept separate from the
	 * cache-refresh leader lock and the agent-tasks lock because all three run on independent
	 * schedules and cost independent sets of GitHub API calls.
	 */
	getRepoPrLockPath(): string {
		const cacheId = this.getCacheIdentifier();
		return path.join(this.context.globalStorageUri.fsPath, `repoprs_${cacheId}.lock`);
	}

	/**
	 * Acquire an exclusive file lock for cache writes.
	 * Uses atomic file creation (O_EXCL / CREATE_NEW) to prevent concurrent writes
	 * across multiple VS Code windows of the same edition.
	 * Returns true if lock acquired, false if another instance holds it.
	 */
	async acquireCacheLock(): Promise<boolean> {
		return this.acquireLock(this.getCacheLockPath());
	}

	/**
	 * Try to become the window that refreshes the agent-tasks snapshot. Returns false when another
	 * window is already refreshing it, in which case this window serves the shared snapshot.
	 */
	async acquireAgentTasksLock(): Promise<boolean> {
		return this.acquireLock(this.getAgentTasksLockPath());
	}

	/** Release the agent-tasks refresh lock, but only if we own it. */
	async releaseAgentTasksLock(): Promise<void> {
		return this.releaseLock(this.getAgentTasksLockPath());
	}

	/**
	 * Try to become the window that refreshes the repository-PRs snapshot. Returns false when
	 * another window is already refreshing it, in which case this window serves the shared snapshot.
	 */
	async acquireRepoPrLock(): Promise<boolean> {
		return this.acquireLock(this.getRepoPrLockPath());
	}

	/** Release the repository-PRs refresh lock, but only if we own it. */
	async releaseRepoPrLock(): Promise<void> {
		return this.releaseLock(this.getRepoPrLockPath());
	}

	/**
	 * Renew (heartbeat) the repository-PRs lock so a slow GitHub API pass is not mistaken for a
	 * stale lock by another window, which would let it duplicate the same API calls.
	 */
	async renewRepoPrLock(): Promise<boolean> {
		return this.renewLock(this.getRepoPrLockPath());
	}

	/**
	 * Try to become the refresh leader. Returns true if this window acquired the
	 * leader lock (and must therefore perform the heavy parse + publish a snapshot),
	 * false if another window already holds it (this window should follow).
	 */
	async acquireRefreshLock(): Promise<boolean> {
		return this.acquireLock(this.getRefreshLockPath());
	}

	/**
	 * Renew (heartbeat) the refresh leader lock so a legitimately long-running parse
	 * is not mistaken for a stale lock by another window. Only renews a lock we own.
	 * Returns true if the lock is still owned by us after the renew attempt.
	 */
	async renewRefreshLock(): Promise<boolean> {
		return this.renewLock(this.getRefreshLockPath());
	}

	/**
	 * Renew (heartbeat) the agent-tasks lock so a slow GitHub API pass is not mistaken for a stale
	 * lock by another window, which would let it duplicate the same API calls.
	 */
	async renewAgentTasksLock(): Promise<boolean> {
		return this.renewLock(this.getAgentTasksLockPath());
	}

	/** Refresh a lock file's timestamp, but only while this window still owns it. */
	private async renewLock(lockPath: string): Promise<boolean> {
		try {
			const content = await fs.promises.readFile(lockPath, 'utf-8');
			const lock = JSON.parse(content);
			if (lock.sessionId !== vscode.env.sessionId) {
				return false;
			}
			await fs.promises.writeFile(
				lockPath,
				JSON.stringify({ sessionId: vscode.env.sessionId, pid: process.pid, timestamp: Date.now() }),
			);
			return true;
		} catch {
			return false;
		}
	}

	/** Release the refresh leader lock, but only if we own it. */
	async releaseRefreshLock(): Promise<void> {
		return this.releaseLock(this.getRefreshLockPath());
	}

	/**
	 * Generic atomic lock acquisition shared by the cache-save lock and the
	 * refresh leader lock.
	 */
	private async acquireLock(lockPath: string): Promise<boolean> {
		try {
			await fs.promises.mkdir(path.dirname(lockPath), { recursive: true });
			return await this.writeLockFile(lockPath);
		} catch (err: unknown) {
			const errCode = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
			if (errCode !== 'EEXIST') {
				const message = err instanceof Error ? err.message : String(err);
				this.deps.warn(`Unexpected error acquiring cache lock: ${message}`);
				return false;
			}
			return this.handleExistingLock(lockPath);
		}
	}

	private async writeLockFile(lockPath: string): Promise<boolean> {
		try {
			await fs.promises.writeFile(
				lockPath,
				JSON.stringify({ sessionId: vscode.env.sessionId, pid: process.pid, timestamp: Date.now() }),
				{ flag: 'wx' },
			);
			return true;
		} catch (err: unknown) {
			if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'EEXIST') { throw err; }
			return false;
		}
	}

	private checkOwnerAlive(pid: unknown): boolean {
		if (typeof pid !== 'number') { return true; }
		try {
			process.kill(pid, 0);
		} catch (killErr: unknown) {
			if (killErr instanceof Error && (killErr as NodeJS.ErrnoException).code === 'ESRCH') {
				return false; // Process no longer exists
			}
			return true; // EPERM means process exists but is owned by another user
		}
		// A PID being alive is not enough on its own: Windows reuses PIDs
		// aggressively, so after a reboot or crash a stale lock can appear "owned" by
		// an unrelated new process, forcing every window into follower mode. On
		// Windows, only treat the lock as live when the PID's image is an
		// Electron-family host OR the current process itself (tests / same-process
		// re-acquire). A live but clearly-foreign image (e.g. cmd.exe) means the
		// PID was recycled and the lock is stale.
		if (process.platform === 'win32') {
			return pid === process.pid || this.isWindowsHostProcess(pid);
		}
		return true;
	}

	/**
	 * Windows-only check that a PID belongs to a VS Code/Electron host process.
	 * Uses tasklist's CSV output; on any failure we assume the owner is alive so
	 * we never break a lock that is genuinely in use.
	 */
	private isWindowsHostProcess(pid: number): boolean {
		try {
			const out = execFileSync(
				'tasklist',
				['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
				{ encoding: 'utf-8', timeout: 5000, windowsHide: true },
			);
			// No match → "INFO: No tasks are running which match the specified criteria."
			if (!out.startsWith('"')) { return false; }
			const image = (out.split('","')[0] ?? '').replace(/^"/, '').toLowerCase();
			return /code|codium|electron|windsurf|cursor|kiro|antigravity|vibe|tray/.test(image);
		} catch {
			return true; // Can't verify — err on the side of not breaking the lock
		}
	}

	private async handleExistingLock(lockPath: string): Promise<boolean> {
		try {
			const content = await fs.promises.readFile(lockPath, 'utf-8');
			const lock = this.parseLockContent(content);
			if (!lock) {
				// Corrupt/empty lock (e.g. owner killed between atomic create and
				// write). The staleness checks below can never run on unparseable
				// content, so without this branch the file would block every
				// acquire attempt forever, forcing all windows into follower mode.
				this.deps.log('Breaking corrupt cache lock (unparseable content)');
				await fs.promises.unlink(lockPath);
				return this.writeLockFile(lockPath);
			}
			const staleThreshold = 5 * 60 * 1000;
			const ownerAlive = this.checkOwnerAlive(lock.pid);
			const isTimestampStale = Date.now() - lock.timestamp > staleThreshold;
			if (!ownerAlive || isTimestampStale) {
				this.deps.log(ownerAlive ? 'Breaking stale cache lock' : 'Breaking stale cache lock (owner process no longer running)');
				await fs.promises.unlink(lockPath);
				return this.writeLockFile(lockPath);
			}
		} catch {
			// Can't read lock file — might have been deleted by the owner already
		}
		return false;
	}

	private parseLockContent(content: string): { sessionId?: unknown; pid?: unknown; timestamp: number } | undefined {
		try {
			const lock = JSON.parse(content);
			if (!lock || typeof lock !== 'object' || typeof lock.timestamp !== 'number') { return undefined; }
			return lock;
		} catch {
			return undefined;
		}
	}

	/**
	 * Release the cache lock file, but only if we own it.
	 */
	async releaseCacheLock(): Promise<void> {
		return this.releaseLock(this.getCacheLockPath());
	}

	/** Generic lock release shared by the cache-save and refresh leader locks. */
	private async releaseLock(lockPath: string): Promise<void> {
		try {
			const content = await fs.promises.readFile(lockPath, 'utf-8');
			const lock = JSON.parse(content);
			if (lock.sessionId === vscode.env.sessionId) {
				await fs.promises.unlink(lockPath);
			}
		} catch {
			// Lock file already gone or unreadable — nothing to do
		}
	}

	// Persistent cache storage methods

	/**
	 * Load the session file cache from the shared on-disk snapshot.
	 * The cache is now stored exclusively on disk (globalStorageUri) to avoid
	 * hitting VS Code's globalState size limit (~2-3 MB warning threshold).
	 * Also removes any legacy cache data from globalState as a one-time migration.
	 */
	async loadCacheFromStorage(): Promise<void> {
		const loadStartedAt = Date.now();
		// Captured before any await in this method, not after the epoch seed below: this call only
		// ever runs once, from the constructor, before clearCache() could plausibly be invoked — but
		// its promise is not awaited there, so a clearCache() reachable the instant activation
		// finishes can land while the very first read (readClearEpoch(), immediately below) is still
		// in flight. Capturing the baseline after that await would already include such a clear,
		// leaving the comparison in the `finally` block below blind to it. checkClearEpoch() alone
		// cannot be trusted to notice this race either way: it only reports a clear this window has
		// not yet accounted for, and this window's own clearAllCachedData() already means it has.
		const clearGenerationAtStart = this.cacheClearGeneration;
		// Seed the local clear-epoch baseline from disk before loading anything, so a clear that
		// happened before this window even started does not immediately look like a *new* clear to
		// checkClearEpoch() and wrongly discard the (already post-clear) data this call is about to
		// load. See getClearEpochPath()'s doc comment for the full cross-window contract.
		this.clearEpoch = await this.readClearEpoch();
		try {
			const cacheId = this.getCacheIdentifier();

			// One-time migration: remove all cache entries from globalState now that
			// the disk snapshot is the sole source of truth.
			this.migrateOldCacheKeys(cacheId);

			// Load from the shared on-disk snapshot (globalStorageUri).
			await this._loadEntriesFromSharedSnapshot(cacheId, loadStartedAt);
		} catch (error) {
			this.deps.error(`Error loading cache from storage: ${error}`);
			this.sessionFileCache = new Map();
		} finally {
			await this._discardLoadIfClearedDuringLoad(clearGenerationAtStart);
		}
	}

	/**
	 * Reads the shared on-disk snapshot and, when its envelope is usable, replaces
	 * sessionFileCache with its entries and bookmarks the file's mtime.
	 *
	 * Returns without touching the cache when no snapshot exists yet or the envelope is
	 * unusable; a cache-version mismatch empties the cache instead. A non-ENOENT read error
	 * is rethrown so loadCacheFromStorage()'s own handler applies its empty-cache fallback.
	 */
	private async _loadEntriesFromSharedSnapshot(cacheId: string, loadStartedAt: number): Promise<void> {
		const snapshotPath = this.getSharedSnapshotPath();
		try {
			const content = await fs.promises.readFile(snapshotPath, 'utf-8');
			const envelope = JSON.parse(content);

			if (!envelope || typeof envelope !== 'object') {
				this.deps.log(`No valid snapshot found for ${cacheId}, starting with empty cache`);
				return;
			}

			// Cache version mismatch: reset stale-entity cleanup flag so the next
			// sync will re-verify and delete obsolete Azure entities.
			if (envelope.cacheVersion !== this.cacheVersion) {
				this.deps.log(`Cache version mismatch (stored: ${envelope.cacheVersion}, current: ${this.cacheVersion}) for ${cacheId}. Clearing cache.`);
				this.sessionFileCache = new Map();
				try { this.context.globalState.update('backend.lastCleanSyncVersion', undefined); } catch { /* best-effort */ }
				return;
			}

			if (
				envelope.schemaVersion !== CacheManager.SNAPSHOT_SCHEMA_VERSION ||
				typeof envelope.entries !== 'object'
			) {
				this.deps.log(`Snapshot schema mismatch or missing entries for ${cacheId}, starting with empty cache`);
				return;
			}

			this.sessionFileCache = new Map(
				Object.entries(envelope.entries as Record<string, SessionFileCache>),
			);
			this.deps.log(`Loaded ${this.sessionFileCache.size} cached session files from disk snapshot (${cacheId}) in ${Date.now() - loadStartedAt}ms`);

			// Record the snapshot mtime so loadSharedSnapshotIfChanged won't reload it redundantly.
			try {
				const stat = await fs.promises.stat(snapshotPath);
				this.lastLoadedSnapshotMtime = stat.mtimeMs;
			} catch { /* best-effort */ }

		} catch (readErr: unknown) {
			if ((readErr as NodeJS.ErrnoException).code === 'ENOENT') {
				this.deps.log(`No snapshot found for ${cacheId}, starting with empty cache`);
			} else {
				throw readErr;
			}
		}
	}

	/**
	 * Clear guard run on every exit path of loadCacheFromStorage(), including its early returns.
	 */
	private async _discardLoadIfClearedDuringLoad(clearGenerationAtStart: number): Promise<void> {
		// Re-check after the load completes, not just before it started: a clear that lands on
		// another window WHILE this call was reading the snapshot would otherwise go unnoticed
		// until the next refresh cycle, letting this window's first paint show the pre-clear
		// entries it just finished loading. Runs on every path above (including the early
		// returns), and is a safe no-op when nothing changed since the seed above.
		await this.checkClearEpoch();
		if (this.cacheClearGeneration !== clearGenerationAtStart || this.clearInProgress) {
			// This window's own clearCache() landed while the load above was in flight.
			// checkClearEpoch() does not catch this (see the comment where clearGenerationAtStart
			// is captured) — whatever this load just assigned to sessionFileCache above needs to
			// be wiped explicitly, the same way loadSharedSnapshotIfChanged() guards this race.
			// The clearInProgress check additionally covers the case where clearAllCachedData()
			// (and this method's baseline capture) both happened entirely *before* this call even
			// started, but deleteSharedSnapshot() has not yet advanced the epoch by the time this
			// load finishes — the generation comparison alone sees nothing further change in that
			// case, since the baseline already reflects the earlier bump.
			this.sessionFileCache = new Map();
			// Also reset the mtime bookmark: the stat() above (if it ran) recorded the pre-clear
			// snapshot's mtime, possibly *after* the concurrent deleteSharedSnapshot() already
			// reset it to 0, silently restoring the stale value. Left in place, a post-clear
			// snapshot recreated with an equal-or-lower mtime (a coarse or backward-moving
			// filesystem clock) would then be wrongly skipped by loadSharedSnapshotIfChanged()'s
			// own mtime shortcut — the same failure mode checkClearEpoch() already guards against
			// for a peer's clear.
			this.lastLoadedSnapshotMtime = 0;
		}
	}

	/**
	 * Remove all session file cache entries from globalState.
	 * The cache now lives exclusively on disk (globalStorageUri snapshot).
	 * Clears both legacy keys from old extension versions AND the current scoped keys
	 * so that existing installations shed the large payload on their next startup.
	 * Idempotent: calling on an already-migrated store is a no-op.
	 */
	migrateOldCacheKeys(_currentCacheId: string): void {
		try {
			const allKeys = this.context.globalState.keys();
			let removedCount = 0;
			for (const key of allKeys) {
				if (this.isCacheGlobalStateKey(key)) {
					this.context.globalState.update(key, undefined);
					removedCount++;
				}
			}
			if (removedCount > 0) {
				this.deps.log(`Migrated: removed ${removedCount} cache keys from globalState (cache now on disk)`);
			}
		} catch (error) {
			this.deps.error(`Error migrating old cache keys: ${error}`);
		}
	}

	/** Returns true for any globalState key that holds session-file cache payload. */
	private isCacheGlobalStateKey(key: string): boolean {
		return (
			key === 'sessionFileCache' ||
			key === 'sessionFileCacheVersion' ||
			key.startsWith('sessionFileCache_') ||
			key.startsWith('sessionFileCacheVersion_') ||
			key.startsWith('sessionFileCacheTimestamp_')
		);
	}

	/**
	 * Returns whether the cache was actually written to disk — `false` on a skipped (lock held by
	 * another window) or failed save, distinct from "resolved without throwing" (this never
	 * throws either way). checkpointCacheInternal() needs this distinction: it must not reset
	 * entriesSinceLastCheckpoint on a save that didn't happen, or a dirty checkpoint that lost a
	 * lock race can be mistaken for a persisted one and never retried.
	 */
	async trySaveCacheToStorage(): Promise<boolean> {
		const acquired = await this.acquireCacheLock();
		if (!acquired) {
			this.deps.log('Cache lock held by another VS Code window, skipping save');
			return false;
		}
		try {
			const cacheId = this.getCacheIdentifier();

			// Persist to the shared on-disk snapshot only (no globalState write to
			// avoid VS Code's large-extension-state warning).
			this.deps.log(`Saving ${this.sessionFileCache.size} cached session files to disk snapshot (version ${this.cacheVersion}, ${cacheId})`);
			return await this.writeSharedSnapshot();
		} catch (error) {
			this.deps.error(`Error saving cache to storage: ${error}`);
			return false;
		} finally {
			await this.releaseCacheLock();
		}
	}

	// ---------------------------------------------------------------------------
	// Shared on-disk snapshot (cross-window cache sharing)
	//
	// VS Code globalState is loaded into memory once at activation and is NOT
	// propagated live between windows. To let a single "leader" window publish
	// parsed results that other "follower" windows can reload, we mirror the cache
	// to a JSON file in globalStorageUri (a path shared by all windows of the same
	// edition). Writes are atomic (temp file + rename) so readers never observe a
	// partially written file.
	// ---------------------------------------------------------------------------

	getSharedSnapshotPath(): string {
		const cacheId = this.getCacheIdentifier();
		return path.join(this.context.globalStorageUri.fsPath, `cache_${cacheId}.snapshot.json`);
	}

	/**
	 * Get the path for the durable cross-window clear-epoch marker.
	 *
	 * Deleting the shared snapshot only stops THIS window's own data from being reloaded after a
	 * restart. It does nothing about a PEER window: that window's in-memory cache and its own
	 * checkpoint/save bookkeeping are entirely its own process's state, so a save it later builds
	 * from data assembled before this clear — from its own untouched cache — can still republish
	 * stale data to the (now-supposedly-empty) shared snapshot. Worse, that peer can keep *serving*
	 * its stale in-memory cache to its own UI even before it ever saves anything, which a write-side
	 * fix alone cannot touch.
	 *
	 * This marker is the durable, cross-window fence for both halves: `deleteSharedSnapshot()`
	 * advances it whenever a clear happens (in this window), `writeSharedSnapshot()` checks it
	 * immediately before publishing (the writer half), and `loadSharedSnapshotIfChanged()` checks
	 * it once per refresh cycle (the loader half, so a peer window stops serving pre-clear data
	 * from memory, not just stops persisting it). See `checkClearEpoch()` for the shared check.
	 */
	getClearEpochPath(): string {
		const cacheId = this.getCacheIdentifier();
		return path.join(this.context.globalStorageUri.fsPath, `cache_${cacheId}.epoch.json`);
	}

	/**
	 * Read the persisted clear epoch. Missing, corrupt, or unparseable content fails open as epoch
	 * 0 (i.e. "no clear known") rather than blocking cache loading or saving — consistent with this
	 * file's general lock-staleness handling (see `handleExistingLock()`).
	 */
	private async readClearEpoch(): Promise<number> {
		try {
			const content = await fs.promises.readFile(this.getClearEpochPath(), 'utf-8');
			const parsed = JSON.parse(content);
			// Number.isFinite() alone is not enough: a corrupt marker like 1e100 is finite but not a
			// safe integer, and `persisted + 1` on a value that large rounds back to the same float —
			// bumpClearEpochLocked()'s new-epoch computation would then fail to strictly advance,
			// letting a real clear go undetected despite the documented monotonicity guarantee.
			return typeof parsed?.epoch === 'number' && Number.isSafeInteger(parsed.epoch) && parsed.epoch >= 0
				? parsed.epoch
				: 0;
		} catch {
			return 0;
		}
	}

	/**
	 * Advance the durable clear epoch past whatever any window (including this one) has seen so
	 * far, and adopt it locally once the write actually lands on disk. On a write failure,
	 * `this.clearEpoch` is deliberately left unchanged rather than adopting `newEpoch` anyway: this
	 * window's own same-process protection against republishing or serving what it just cleared
	 * already comes entirely from `cacheClearGeneration`/`clearInProgress` (bumped independently of
	 * this method), so adopting a value the disk never actually received would add no protection for
	 * this window while creating one for a peer — a later peer clear that computes that exact same
	 * `persisted + 1` value (routine whenever two clears land in the same millisecond, which is why
	 * the floor exists at all) would successfully persist it, and this window's `checkClearEpoch()`
	 * would then see `persisted <= this.clearEpoch` and silently miss that real, successful clear.
	 *
	 * Returns whether the marker was actually written: `false` means no peer (or this window, after
	 * a restart) can learn about this clear through the epoch file at all, so `deleteSharedSnapshot()`
	 * propagates this instead of reporting an unqualified success — see its own doc comment.
	 *
	 * The new epoch is `max(Date.now(), persisted + 1, this.clearEpoch + 1)`, not a bare timestamp:
	 * two clears close together (this window twice, or racing a peer's own clear) must never
	 * produce the same or a lower value — checkClearEpoch()'s `persisted <= this.clearEpoch`
	 * comparison would silently treat a non-advancing epoch as "no clear happened". A bare
	 * `Date.now()` can fail to advance across two back-to-back calls (millisecond-granularity
	 * clock, or a backward NTP/VM time step), so the floor is always one past whatever is already
	 * on disk — and also one past whatever THIS window already knows (`this.clearEpoch`), not just
	 * the freshly-read `persisted` value: if the marker is missing/corrupt at the moment of this
	 * read (readClearEpoch() fails open to 0) while this window has already observed a real,
	 * higher epoch from an earlier bump or a peer's, flooring on `persisted` alone could write a
	 * regressing epoch that a peer already past that higher value would fail to recognize as new.
	 *
	 * The read-then-write is itself a race across windows (two peers could both read the same
	 * persisted value before either writes), so this expects the caller to already hold the cache
	 * lock — the same lock every writer holds around its own read-modify-write of the shared
	 * snapshot — for the duration of this call, and is serialized against other writers only when
	 * that holds. `deleteSharedSnapshot()` is the only caller, and does the unlink and this bump
	 * under one held lock (see its own doc comment) whenever it actually acquired one; when its own
	 * retry budget was spent first, it calls this anyway, unlocked, on the same best-effort
	 * reasoning as the write failure case above — the fence must still advance rather than silently
	 * staying behind, even though this specific call can no longer be serialized against a
	 * concurrent writer. See `deleteSharedSnapshot()`'s doc comment for that fallback's own tradeoff.
	 */
	private async bumpClearEpochLocked(): Promise<boolean> {
		const epochPath = this.getClearEpochPath();
		const persisted = await this.readClearEpoch();
		// A value at or beyond Number.MAX_SAFE_INTEGER cannot be safely incremented: float64 rounds
		// `n + 1` back down to `n` at that magnitude, so flooring on it directly could produce the
		// exact same "new" epoch as last time, breaking the strict-advance guarantee this method
		// exists to provide. readClearEpoch() already validates on read, but `this.clearEpoch` is
		// assigned the raw computed value below, bypassing that check — so a marker that reaches
		// this boundary (corrupt, or genuinely exhausted after an astronomical number of clears)
		// stays reachable through this window's own in-memory value too.
		//
		// An earlier version of this fix fell back to `Date.now()` once exhausted — but that can
		// *regress* the epoch below a value some peer has already adopted into its own in-memory
		// `clearEpoch` (any Date.now()-based value is many orders of magnitude smaller than
		// Number.MAX_SAFE_INTEGER), and a regressing epoch is worse than a stalled one: that peer's
		// own `persisted <= this.clearEpoch` check would then treat every subsequent real clear as
		// old and keep serving/republishing stale data indefinitely, not just miss the one clear that
		// hit this boundary. There is no larger *safe* float64 integer to advance to once genuinely
		// exhausted — that is what "exhausted" means here — so this holds at the ceiling instead of
		// picking a smaller replacement value: a write that fails to advance is the same narrow,
		// already-documented failure mode a corrupt-but-unsafe marker (e.g. `1e100`) has always had,
		// not a new one. Properly resolving exhaustion needs a wider representation (BigInt or a
		// decimal string) that can keep counting past this ceiling — tracked as a documented
		// follow-up, not attempted here.
		const exhausted = persisted >= Number.MAX_SAFE_INTEGER || this.clearEpoch >= Number.MAX_SAFE_INTEGER;
		const newEpoch = exhausted
			? Number.MAX_SAFE_INTEGER
			: Math.max(Date.now(), persisted + 1, this.clearEpoch + 1);
		const tmpPath = `${epochPath}.${process.pid}.${newEpoch}.tmp`;
		try {
			await fs.promises.mkdir(path.dirname(epochPath), { recursive: true });
			await fs.promises.writeFile(tmpPath, JSON.stringify({ epoch: newEpoch }));
			await fs.promises.rename(tmpPath, epochPath);
			this.clearEpoch = newEpoch;
			return true;
		} catch (error) {
			this.deps.warn(`Failed to persist clear epoch: ${error}`);
			try { await fs.promises.unlink(tmpPath); } catch { /* best-effort cleanup */ }
			return false;
		}
	}

	/**
	 * Check whether a clear has happened (in this window or a peer's) since this window's
	 * in-memory cache was last known consistent, and if so, drop the now-possibly-stale in-memory
	 * state so this window stops *serving* pre-clear data, not just stops persisting it.
	 *
	 * Cheap — one small file read — and meant to be called once per publish/refresh cycle (see
	 * `writeSharedSnapshot()` and `loadSharedSnapshotIfChanged()`), never per parsed file.
	 *
	 * Also bumps `cacheClearGeneration`, the same in-memory counter clearAllCachedData() bumps: a
	 * detected clear here can land WHILE a same-process writeSharedSnapshot() is still mid-flight —
	 * already past its own first checkClearEpoch() check, and off building `entries` from the
	 * sessionFileCache Map this call is about to replace. That writer's own generation check would
	 * otherwise see nothing wrong (this call's epoch update alone doesn't touch the generation it
	 * compares against), pass, and rename pre-clear entries built from the map this call just
	 * abandoned. Bumping the generation here forces that in-flight write to abort like any other
	 * clear does, regardless of which of the two signals (generation or epoch) it happens to be
	 * mid-checking.
	 *
	 * Also resets the checkpoint dirty-count accounting via resetCheckpointCounters(), the same
	 * call clearAllCachedData() makes: entriesSinceLastCheckpoint otherwise keeps describing the
	 * pre-clear cache this call just emptied, so the next leader cycle's
	 * flushPendingCheckpointBeforeReset() would see a stale positive count and force a redundant
	 * checkpoint write of the (now-empty) cache before parsing anything of its own — reintroducing
	 * the exact no-op-write case the checkpoint dirty-tracking rework exists to skip. Safe to call
	 * with a checkpoint already mid-flight (see that method's own doc comment).
	 *
	 * Public (not just used internally by writeSharedSnapshot()/loadSharedSnapshotIfChanged()/
	 * loadCacheFromStorage()) so a caller that reads `cache` directly outside those methods — e.g. a
	 * provisional/instant paint built straight from the in-memory cache after awaiting an earlier
	 * load — has a way to re-synchronize with a peer's clear immediately before that read, rather
	 * than only picking one up whenever the next load/write cycle happens to run.
	 *
	 * Returns true if a newer epoch was found and the in-memory cache was dropped.
	 */
	async checkClearEpoch(): Promise<boolean> {
		const persisted = await this.readClearEpoch();
		if (persisted <= this.clearEpoch) {
			return false;
		}
		this.deps.log(`Detected cache clear from another window (epoch ${this.clearEpoch} -> ${persisted}); dropping in-memory cache`);
		this.sessionFileCache = new Map();
		this.deletedFilePaths = new Map();
		this.clearEpoch = persisted;
		this.cacheClearGeneration++;
		this.resetCheckpointCounters();
		// Without this, a post-clear snapshot recreated with an mtime at or below this bookmark
		// (coarse or backward-moving filesystem clocks — the same clocks the cross-window tests
		// above already account for) would make loadSharedSnapshotIfChanged()'s own mtime check
		// wrongly believe it already has the latest snapshot and skip loading the new one.
		this.lastLoadedSnapshotMtime = 0;
		// See CacheManagerDeps.onPeerClearDetected's own doc comment: this class's cache is dropped
		// above either way, but a caller with its own separate derived caches needs this signal too.
		this.deps.onPeerClearDetected?.();
		return true;
	}

	/**
	 * Atomically write the in-memory cache to the shared snapshot file.
	 *
	 * The write MERGES with whatever is already on disk (keeping the newer entry by
	 * mtime) so that a window with a partial/stale cache can never regress a richer
	 * snapshot published by another window. Must be called while holding the cache
	 * lock to keep the read-modify-write atomic across windows.
	 *
	 * Never throws — a write failure is logged and reported via the `false` return instead,
	 * so a caller like checkpointCacheInternal() can distinguish "actually persisted" from
	 * "swallowed an error" without needing its own try/catch around this.
	 *
	 * Two independent staleness checks guard against publishing pre-clear data, one per clear
	 * signal this file tracks: `cacheClearGeneration` (bumped by clearAllCachedData(), in-memory
	 * and same-process only) aborts if a clear landed in THIS window while `entries` above was
	 * being built from a disk read and in-memory state captured before it; `checkClearEpoch()`
	 * (the durable, cross-window marker — see `getClearEpochPath()`) aborts if a clear landed in
	 * ANY window, including a peer's, that this window has not yet heard about. Both are checked
	 * up front before doing any work, and both are checked again right before the rename, since a
	 * clear landing in either window at any point up to that instant makes the captured data
	 * equally stale.
	 */
	async writeSharedSnapshot(): Promise<boolean> {
		// Captured before the checkClearEpoch() await just below, not after: a same-process
		// clearAllCachedData() landing while that marker read is pending would otherwise already be
		// reflected in this baseline, leaving the mid-build comparison below blind to it — entries
		// could then be assembled from state captured before the clear (including a pre-clear
		// on-disk snapshot read by buildMergedSnapshotEntries()) and pass every later check that only
		// looks for a generation change *after* this point.
		const clearGenerationAtStart = this.cacheClearGeneration;
		if (await this.checkClearEpoch()) {
			this.deps.log('Skipping shared snapshot publish: in-memory cache predates a detected clear');
			return false;
		}
		const snapshotPath = this.getSharedSnapshotPath();
		const tmpPath = `${snapshotPath}.${process.pid}.${Date.now()}.tmp`;
		try {
			const entries = await this.buildMergedSnapshotEntries();
			if (this.cacheClearGeneration !== clearGenerationAtStart || this.clearInProgress) {
				// clearInProgress catches the same gap here as in the two loaders: this call's baseline
				// can have been captured *after* an external clearAllCachedData() already landed (not
				// during buildMergedSnapshotEntries()'s own await), with deleteSharedSnapshot() still
				// stuck on the cache lock and the epoch not yet advanced — neither the generation
				// comparison nor an epoch check would catch that on their own.
				this.deps.log('Skipping shared-snapshot write: cache was cleared while this checkpoint was building it');
				return false;
			}
			const envelope = {
				schemaVersion: CacheManager.SNAPSHOT_SCHEMA_VERSION,
				cacheVersion: this.cacheVersion,
				cacheId: this.getCacheIdentifier(),
				generatedAt: Date.now(),
				entryCount: Object.keys(entries).length,
				entries,
			};
			await fs.promises.mkdir(path.dirname(snapshotPath), { recursive: true });
			await fs.promises.writeFile(tmpPath, JSON.stringify(envelope));
			// checkClearEpoch() is awaited first, unconditionally, rather than combined into one `||`
			// with the generation comparison short-circuiting it: `a || await b()` only evaluates `b`
			// when `a` is already false, checked synchronously before that await even starts — a clear
			// landing in THIS window during the await (bumping the generation) would then be invisible,
			// since the generation was already compared as unchanged before the clear happened. Awaiting
			// checkClearEpoch() first and comparing the generation synchronously right after leaves no
			// such gap.
			const epochDetectedBeforeRename = await this.checkClearEpoch();
			if (this.cacheClearGeneration !== clearGenerationAtStart || epochDetectedBeforeRename || this.clearInProgress) {
				this.deps.log('Skipping shared-snapshot write: cache was cleared while this checkpoint was about to persist');
				try { await fs.promises.unlink(tmpPath); } catch { /* best-effort cleanup */ }
				return false;
			}
			await fs.promises.rename(tmpPath, snapshotPath);
			// Record our own write so we don't redundantly reload it later.
			try {
				const stat = await fs.promises.stat(snapshotPath);
				this.lastLoadedSnapshotMtime = stat.mtimeMs;
			} catch { /* best-effort */ }
			return true;
		} catch (error) {
			this.deps.warn(`Failed to write shared cache snapshot: ${error}`);
			try { await fs.promises.unlink(tmpPath); } catch { /* best-effort cleanup */ }
			return false;
		}
	}

	/**
	 * Delete the shared on-disk snapshot, reset the loaded-mtime bookmark, and advance the durable
	 * clear epoch (see `getClearEpochPath()`). Called by clearCache() so that restarting VS Code
	 * does not restore cleared data, no peer window's later save (built from data it assembled
	 * before this clear) can republish stale data, and no peer window keeps serving that stale data
	 * from its own memory past its next check. The epoch is advanced even when there was no snapshot
	 * file to delete (or it was already gone), since the fence must hold regardless of what was on
	 * disk at the time — but NOT when the delete genuinely fails and the snapshot is still there; see
	 * _bookmarkUnchangedSnapshotMtime() and this method's "Returns" note.
	 *
	 * Acquires the same cache save lock writeSharedSnapshot() holds while it builds and renames a
	 * snapshot — retrying briefly rather than the usual single-shot acquire, since this specific
	 * caller must not proceed while any writer (this window's own periodic checkpoint or
	 * persistRefreshResult() save, or another window's) could still be mid-write. cacheClearGeneration
	 * (bumped by clearAllCachedData(), checked inside writeSharedSnapshot()) only lives in this
	 * process's memory, so it can abort a same-process write that hasn't reached its rename yet, but
	 * it cannot reach into another window's process at all, and can't undo a same-process write
	 * whose generation check already passed before the bump landed. Serializing on the shared lock
	 * file instead closes both gaps: any writer, in this window or a peer's, holds this exact lock
	 * for the small window between its own read and its rename, so acquiring it first guarantees no
	 * writer's rename can land after this delete. Proceeds anyway once the retry budget is spent
	 * (see acquireCacheLockWithRetry()) rather than blocking "Clear Cache" forever on a peer
	 * holding a stuck lock — that residual gap only matters against a writer that neither finishes
	 * nor gets its stale lock broken within that budget, an accepted trade-off documented there.
	 *
	 * When the lock above was actually acquired, the epoch bump happens inside that SAME held lock,
	 * not after releasing it: a writer blocked on it is only let through once both the delete and
	 * the bump have landed, so it always sees the fresh epoch via checkClearEpoch() before it can
	 * publish anything. Bumping after releasing the lock would reopen a gap of its own — a writer
	 * could acquire the lock in between, find the pre-bump epoch, and publish before the bump ever
	 * catches it. When the retry budget above was spent instead (lock never acquired), the bump
	 * still runs — unlocked, best-effort — because the fence must advance regardless; that call is
	 * not serialized against a concurrent writer the way the held-lock case is. See
	 * `bumpClearEpochLocked()`'s own doc comment for that narrower, already-accepted fallback gap.
	 *
	 * Returns whether this window's clear is now durably visible to peers: the on-disk snapshot was
	 * actually removed, replaced with an empty one, or already gone, AND the epoch marker was
	 * actually persisted. `false` means neither the delete nor its empty-snapshot fallback could land
	 * — a peer must not be told a clear happened at all in that case, so the epoch bump is skipped
	 * too; see _bookmarkUnchangedSnapshotMtime() for why. The caller must not treat this method as
	 * having unconditionally succeeded.
	 */
	async deleteSharedSnapshot(retryOptions?: { attempts: number; delayMs: number }): Promise<boolean> {
		const lockAcquired = await this.acquireCacheLockWithRetry(retryOptions);
		try {
			const cleared = await this._removeSharedSnapshotFile(this.getSharedSnapshotPath());
			if (!cleared) { return false; }
			return await this.bumpClearEpochLocked();
		} finally {
			if (lockAcquired) { await this.releaseCacheLock(); }
			this._finishSharedSnapshotClear();
		}
	}

	/**
	 * Unlinks the shared snapshot, falling back to replacing it with an empty one when the unlink
	 * fails for a reason other than the file already being gone. Returns `false` only when neither
	 * the delete nor the empty-snapshot fallback could land.
	 */
	private async _removeSharedSnapshotFile(snapshotPath: string): Promise<boolean> {
		try {
			await fs.promises.unlink(snapshotPath);
			this.lastLoadedSnapshotMtime = 0;
			this.deps.log(`Deleted shared cache snapshot (${this.getCacheIdentifier()})`);
			return true;
		} catch (err: unknown) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
				// Another window (or an earlier call here) already deleted it — same postcondition
				// this method promises (no snapshot left) even though this call didn't do the
				// deleting. loadSharedSnapshotIfChanged() only reloads once a snapshot's mtime
				// exceeds this bookmark, so leaving it at its pre-delete value here could make a
				// newly published snapshot with an equal-or-lower mtime (coarse filesystem
				// timestamp resolution, or clock rollback) look already-loaded, leaving this
				// instance on stale/empty in-memory state until some later mtime change finally
				// exceeds it.
				this.lastLoadedSnapshotMtime = 0;
				return true;
			}
			// A genuine failure (e.g. permissions): the file is presumably still there,
			// unchanged.
			this.deps.warn(`Failed to delete shared cache snapshot: ${err}`);
			return await this._replaceSharedSnapshotWithEmpty(snapshotPath);
		}
	}

	/**
	 * A failed unlink is often a transient file lock (e.g. Windows holding a read
	 * handle open on the file — the exact scenario a concurrent loadSharedSnapshotIfChanged()
	 * read can cause) rather than a genuine permissions failure. The same tmp-file +
	 * rename pattern writeSharedSnapshot() already uses to publish can still succeed
	 * here: renaming a fresh, unlocked temp file over the path only replaces the
	 * directory entry, it doesn't need to touch whatever is holding the original file's
	 * data open. Falling back to "replace with an empty snapshot" gives this clear a
	 * real chance to still land durably — with an empty on-disk snapshot, a later write's
	 * buildMergedSnapshotEntries() has nothing pre-clear left to merge back in — instead
	 * of immediately downgrading to the non-durable fallback in
	 * _bookmarkUnchangedSnapshotMtime().
	 */
	private async _replaceSharedSnapshotWithEmpty(snapshotPath: string): Promise<boolean> {
		const replaceTmpPath = `${snapshotPath}.${process.pid}.${Date.now()}.tmp`;
		try {
			const emptyEnvelope = {
				schemaVersion: CacheManager.SNAPSHOT_SCHEMA_VERSION,
				cacheVersion: this.cacheVersion,
				cacheId: this.getCacheIdentifier(),
				generatedAt: Date.now(),
				entryCount: 0,
				entries: {},
			};
			await fs.promises.writeFile(replaceTmpPath, JSON.stringify(emptyEnvelope));
			await fs.promises.rename(replaceTmpPath, snapshotPath);
			this.lastLoadedSnapshotMtime = 0;
			this.deps.log(`Replaced shared cache snapshot with an empty one after a failed delete (${this.getCacheIdentifier()})`);
			return true;
		} catch (replaceErr) {
			this.deps.warn(`Could not replace the shared cache snapshot with an empty one either: ${replaceErr}`);
			// A partial failure here (writeFile succeeded but rename didn't) would otherwise
			// leave an orphaned temp file behind on every such failure, accumulating in
			// globalStorage across repeated Clear Cache attempts — best-effort cleanup, same
			// as every other tmp-file-plus-rename write in this file already does.
			try { await fs.promises.unlink(replaceTmpPath); } catch { /* best-effort cleanup */ }
			await this._bookmarkUnchangedSnapshotMtime(snapshotPath);
			return false;
		}
	}

	/**
	 * Called when a clear could not land on disk at all; the caller then skips the epoch bump.
	 * Advancing the epoch here would tell every peer "a clear happened" while the pre-clear
	 * snapshot is still fully present on disk — a peer's checkClearEpoch() would detect it, reset
	 * its own mtime bookmark to 0, and its very next loadSharedSnapshotIfChanged() would
	 * immediately reload that still-present stale snapshot, resurrecting exactly the data this
	 * clear was meant to remove. Skipping the bump leaves this clear attempt unrecorded to peers
	 * instead — the same "not yet propagated" state as before this call ran, rather than a
	 * durable, misleading claim that the fence held.
	 *
	 * Bookmarking the bookmark to the file's current (unchanged) mtime — rather than leaving it
	 * alone — matters for THIS window's own next load, not just peers': the caller here is
	 * clearCache(), whose very next step (after this returns) is a refresh that calls
	 * loadSharedSnapshotIfChanged(). If this window had never loaded this snapshot itself
	 * (bookmark still at its initial value), that load would see the still-present file's mtime
	 * as new and merge the exact pre-clear content clearAllCachedData() just emptied straight back
	 * into this window's own cache — a self-inflicted resurrection that needs no peer at all. The
	 * file didn't change, so bookmarking its current mtime now is accurate, not merely a workaround.
	 */
	private async _bookmarkUnchangedSnapshotMtime(snapshotPath: string): Promise<void> {
		try {
			const stat = await fs.promises.stat(snapshotPath);
			this.lastLoadedSnapshotMtime = stat.mtimeMs;
		} catch { /* best-effort; if even stat fails the file is presumably gone some other way */ }
	}

	/**
	 * Runs in deleteSharedSnapshot()'s `finally`. The durable epoch has now been advanced (or, on
	 * a write failure inside bumpClearEpochLocked(), left unchanged rather than adopted — see that
	 * method's own doc comment) — this call's own contribution to the race window clearInProgress
	 * guards is over regardless of which outcome landed. Decremented, not reset to zero: an
	 * overlapping clearCache() (nothing serializes them today) can still have its own
	 * clearAllCachedData()-to-deleteSharedSnapshot() pair in flight, and the counter must stay
	 * positive until that one finishes too — see clearInProgressCount's own doc comment.
	 *
	 * Also bumps cacheClearGeneration, a second time independent of clearAllCachedData()'s own
	 * bump: clearInProgress is a *live* signal (true only while this call has not yet finished), so
	 * it cannot catch a load or save whose stat/read/build sequence straddles the exact moment this
	 * call completes — started while a clear was genuinely in flight, but by the time that caller's
	 * own final check runs, this call has already finished and the counter is back to zero. That
	 * caller's generation baseline, captured before this completion, still differs from the
	 * now-bumped value, so the existing `cacheClearGeneration !== clearGenerationAtStart` check
	 * every loader and writeSharedSnapshot() already runs catches it without any further
	 * special-casing.
	 */
	private _finishSharedSnapshotClear(): void {
		this.clearInProgressCount = Math.max(0, this.clearInProgressCount - 1);
		this.cacheClearGeneration++;
	}

	/**
	 * Retries acquireCacheLock() instead of giving up on the first miss.
	 *
	 * A legitimate writer holds this lock for its full read+merge+serialize+write+rename
	 * sequence — normally milliseconds, but a large snapshot (SNAPSHOT_MAX_ENTRIES caps it at
	 * 20,000 entries) on a slow disk can meaningfully exceed that. The retry budget here (10s) is
	 * sized for that realistic case, not just the fast common one, so deleteSharedSnapshot() does
	 * not race a legitimate large-cache write nearly as often as a short retry would.
	 *
	 * It remains a bounded retry, not an indefinite wait, for a genuinely stuck peer (e.g. a lock
	 * orphaned by a crashed window): acquireCacheLock() already breaks a lock whose owner process
	 * is dead, and handleExistingLock()'s own 5-minute staleness threshold breaks one whose owner
	 * is merely idle-but-alive, so this retry only ever waits out a lock actively being renewed by
	 * a live, legitimately-working writer or a fixed worst case. Proceeding once this budget is
	 * spent, rather than blocking "Clear Cache" indefinitely, is an accepted trade-off — the same
	 * shape as the unbounded-reserve-wait trade-off already accepted elsewhere in this PR for the
	 * deferred-parse semaphore.
	 */
	private async acquireCacheLockWithRetry(retryOptions?: { attempts: number; delayMs: number }): Promise<boolean> {
		// Overridable only for tests, to exercise the retry/give-up behavior without a real test
		// waiting out the full production budget above.
		const RETRY_ATTEMPTS = retryOptions?.attempts ?? 100;
		const RETRY_DELAY_MS = retryOptions?.delayMs ?? 100;
		for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
			if (await this.acquireCacheLock()) { return true; }
			await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
		}
		this.deps.warn('Could not acquire cache lock before deleting shared snapshot after retrying; proceeding without it');
		return false;
	}

	/**
	 * newer entry by mtime, and cap the result to the newest SNAPSHOT_MAX_ENTRIES.
	 */
	private async buildMergedSnapshotEntries(): Promise<Record<string, SessionFileCache>> {
		const existing = await this.readSharedSnapshot();
		const merged: Record<string, SessionFileCache> = existing ? { ...existing } : {};
		// A path removed via deleteCachedSessionData() must not be resurrected from whatever
		// another (or this) window already published to disk — see deletedFilePaths' doc comment.
		// Only strip a disk entry that is no newer than this tombstone's baseline mtime: a strictly
		// newer disk entry means another window republished this path after this deletion decision
		// was made, and that newer publish must survive, not be silently destroyed.
		for (const [deletedPath, tombstoneMtime] of this.deletedFilePaths) {
			const diskEntry = merged[deletedPath];
			if (diskEntry && typeof diskEntry.mtime === 'number' && diskEntry.mtime > tombstoneMtime) {
				continue;
			}
			delete merged[deletedPath];
		}
		for (const [filePath, entry] of this.sessionFileCache) {
			const prev = merged[filePath];
			// A details-only placeholder must not overwrite a full on-disk entry at the same mtime.
			const placeholderOverFull = entry.detailsOnly === true && prev && !prev.detailsOnly && entry.mtime === prev.mtime && entry.size === prev.size;
			if (!prev || (typeof entry.mtime === 'number' && entry.mtime >= prev.mtime && !placeholderOverFull)) {
				// A full entry replacing a same-version placeholder keeps the placeholder's detail metadata.
				merged[filePath] = prev?.detailsOnly === true && !entry.detailsOnly && entry.mtime === prev.mtime && entry.size === prev.size ? mergePlaceholderDetails(entry, prev) : entry;
			}
		}
		const keys = Object.keys(merged);
		if (keys.length <= CacheManager.SNAPSHOT_MAX_ENTRIES) {
			return merged;
		}
		const capped: Record<string, SessionFileCache> = {};
		const newestFirst = keys.sort((a, b) => (merged[b].mtime ?? 0) - (merged[a].mtime ?? 0));
		for (const key of newestFirst.slice(0, CacheManager.SNAPSHOT_MAX_ENTRIES)) {
			capped[key] = merged[key];
		}
		return capped;
	}

	/**
	 * Read and validate the shared snapshot. Returns its entries, or undefined when
	 * the file is missing, unreadable, malformed, or written by an incompatible
	 * schema/cache version.
	 */
	async readSharedSnapshot(): Promise<Record<string, SessionFileCache> | undefined> {
		const snapshotPath = this.getSharedSnapshotPath();
		try {
			const content = await fs.promises.readFile(snapshotPath, 'utf-8');
			const envelope = JSON.parse(content);
			if (
				!envelope ||
				envelope.schemaVersion !== CacheManager.SNAPSHOT_SCHEMA_VERSION ||
				envelope.cacheVersion !== this.cacheVersion ||
				typeof envelope.entries !== 'object'
			) {
				return undefined;
			}
			return envelope.entries as Record<string, SessionFileCache>;
		} catch {
			// Missing or partial/corrupt snapshot — caller falls back to its own data.
			return undefined;
		}
	}

	/**
	 * Warm the in-memory cache from the shared snapshot if another window has
	 * published a newer one since we last loaded it. Only entries that are fresher
	 * than (or absent from) our current cache are merged, so locally parsed data is
	 * never overwritten with older snapshot data.
	 *
	 * Returns the number of entries merged.
	 */
	async loadSharedSnapshotIfChanged(): Promise<number> {
		const loadStartedAt = Date.now();
		// The loader half of the clear-epoch fence: a clear published from another window must stop
		// THIS window from continuing to serve its own pre-clear in-memory cache, not merely stop it
		// from publishing. Called once per refresh cycle (this function's own call sites), not per
		// file, matching writeSharedSnapshot()'s check on the write side. See getClearEpochPath().
		// Captured before the checkClearEpoch() call just below, not simply after it: an *external*
		// clearAllCachedData() (e.g. this window's own clearCache(), a different call chain entirely)
		// can land while that call's internal marker read is pending, without necessarily also being
		// visible through the epoch it checks — so capturing the baseline only after it returns could
		// already include such a bump, leaving the comparison below blind to it for the rest of this
		// call's own stat/read/merge sequence.
		//
		// But checkClearEpoch() can *also* bump the same counter itself, as an expected, already-
		// handled side effect of detecting a genuine peer clear right here — it resets sessionFileCache
		// to a fresh empty map before returning, and the stat/read/merge sequence below is then
		// legitimately repopulating that map from the post-clear snapshot, not racing anything. Treating
		// that self-bump as "something else raced this call" would wipe the very entries this method
		// exists to load. So: if this call's own checkClearEpoch() detected and handled a clear, the
		// baseline moves forward to the generation it just produced; only a bump happening *outside*
		// this line (before or after) still needs the original, pre-call baseline to be caught.
		const clearGenerationBeforeCheck = this.cacheClearGeneration;
		const clearDetectedAtStart = await this.checkClearEpoch();
		const clearGenerationAtStart = clearDetectedAtStart ? this.cacheClearGeneration : clearGenerationBeforeCheck;
		const snapshotPath = this.getSharedSnapshotPath();
		let mtimeMs: number | undefined;
		try {
			const stat = await fs.promises.stat(snapshotPath);
			mtimeMs = stat.mtimeMs;
		} catch {
			mtimeMs = undefined; // No snapshot yet (or a peer's clear just deleted it).
		}
		let merged = 0;
		if (mtimeMs !== undefined && mtimeMs > this.lastLoadedSnapshotMtime) {
			const entries = await this.readSharedSnapshot();
			if (entries) {
				merged = this.mergeSnapshotEntries(entries);
			}
			// Remember the mtime either way, so a corrupt/incompatible snapshot isn't retried every cycle.
			this.lastLoadedSnapshotMtime = mtimeMs;
		}
		// Re-check after the stat/read/merge sequence above, not just before starting — on every path,
		// not only the one that merged something. A peer's clear can land anywhere in that sequence:
		// mid-stat (the snapshot vanishes, or its mtime no longer looks newer), mid-read (the entries
		// just merged in predate the clear), or between the two. Without a check on every exit, this
		// window would keep serving (and could later republish) pre-clear in-memory data until its next
		// unrelated refresh cycle happened to call checkClearEpoch() again. A detected clear here means
		// anything just merged is already stale, so it is dropped along with the rest of the cache —
		// report 0, not `merged`. checkClearEpoch() is awaited unconditionally, before the generation
		// comparison below, not combined into one `||` — awaiting it first and comparing the generation
		// synchronously right after leaves no gap for a same-process clear landing during that await to
		// slip past a comparison that ran before it happened.
		const epochDetected = await this.checkClearEpoch();
		if (this.cacheClearGeneration !== clearGenerationAtStart || this.clearInProgress) {
			// This window's own clearCache() (clearAllCachedData(), synchronous) already replaced
			// sessionFileCache with a fresh, empty Map before the merge above ran — mergeSnapshotEntries()
			// reads `this.sessionFileCache` at call time, so what was merged went straight into that new
			// map, silently reinserting pre-clear entries into an otherwise-just-cleared cache.
			// checkClearEpoch() does not catch this (see above), so it is not enough on its own to have
			// wiped it — wipe explicitly. The clearInProgress check additionally covers the narrower gap
			// where this whole method's own baseline was captured *after* clearAllCachedData() already
			// landed (i.e. entirely before this call started, not during it) but deleteSharedSnapshot()
			// has not yet advanced the epoch: the generation comparison above sees nothing further
			// change, and the epoch hasn't moved either, so neither of those two checks alone catches it.
			this.sessionFileCache = new Map();
			// Also reset the mtime bookmark: the assignment above (if it ran) recorded the pre-clear
			// snapshot's mtime, possibly *after* the concurrent deleteSharedSnapshot() already reset it
			// to 0, silently restoring the stale value — the same failure mode
			// loadCacheFromStorage() guards against for the equivalent race on its own load path.
			this.lastLoadedSnapshotMtime = 0;
			return 0;
		}
		if (epochDetected) {
			return 0;
		}
		if (merged > 0) {
			this.deps.log(`Warmed cache from shared snapshot: merged ${merged} entr${merged === 1 ? 'y' : 'ies'} in ${Date.now() - loadStartedAt}ms`);
		}
		return merged;
	}

	/**
	 * Merge snapshot entries into the in-memory cache, keeping whichever entry has
	 * the newer mtime. An entry missing locally is always taken from the snapshot.
	 */
	private mergeSnapshotEntries(entries: Record<string, SessionFileCache>): number {
		let merged = 0;
		for (const [filePath, entry] of Object.entries(entries)) {
			if (!entry || typeof entry.mtime !== 'number') { continue; }
			// A tombstoned path has no `existing` in-memory entry to compare against (deleteCachedSessionData()
			// removed it from sessionFileCache), so `!existing` would otherwise always be true and accept ANY
			// snapshot entry unconditionally — including one no newer than what was actually deleted, e.g. a
			// stale snapshot a concurrent window is still rewriting. Guard with the same tombstone-baseline
			// comparison buildMergedSnapshotEntries() already applies on the write side: only a snapshot entry
			// strictly newer than the tombstone survives.
			const existing = this.sessionFileCache.get(filePath);
			const tombstoneMtime = this.deletedFilePaths.get(filePath);
			const isNewerThanTombstone = tombstoneMtime === undefined || entry.mtime > tombstoneMtime;
			// At an equal mtime a full entry must still replace a details-only placeholder,
			// otherwise the placeholder keeps forcing a re-analysis it no longer needs.
			const upgradesPlaceholder = existing?.detailsOnly === true && !entry.detailsOnly && entry.mtime === existing.mtime && entry.size === existing.size;
			if ((!existing || entry.mtime > existing.mtime || upgradesPlaceholder) && isNewerThanTombstone) {
				this.sessionFileCache.set(filePath, upgradesPlaceholder && existing ? mergePlaceholderDetails(entry, existing) : entry);
				// Must clear any tombstone this window recorded for this path, same as
				// setCachedSessionData() does — buildMergedSnapshotEntries()'s mtime comparison
				// already protects a newer disk entry on its own, but clearing here keeps this
				// window's own next save from re-deciding "still gone" the moment it merges in
				// proof that it plainly isn't.
				this.deletedFilePaths.delete(filePath);
				merged++;
			}
		}
		if (merged > 0) {
			this.policy.evict(this.sessionFileCache);
		}
		return merged;
	}
}
