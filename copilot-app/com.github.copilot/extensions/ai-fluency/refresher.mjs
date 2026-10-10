import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { unwatchFile, watchFile } from "node:fs";
import { link, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runFluencyCli, DEFAULT_TIMEOUT_MS, KILL_GRACE_MS, killTree } from "./cli.mjs";
import { artifactsDir, buildSnapshot, ensurePrivateDir, PRIVATE_FILE_MODE, readPrivateSnapshotFile, snapshotPath, writeSnapshot } from "./store.mjs";

export const AUTO_REFRESH_MS = 30 * 60 * 1000;
export const OPEN_REFRESH_MIN_AGE_MS = 5 * 60 * 1000;
const TICK_MS = 60 * 1000;
/** A live session's lock goes stale this long after the CLI timeout (covers CLI resolution and the kill grace). */
const LOCK_STALE_GRACE_MS = 2 * 60 * 1000;
/** A lock file that cannot be parsed yet may still be being written (no-hard-link fallback); treat it as held this long. */
const PARTIAL_LOCK_GRACE_MS = 10 * 1000;
/** Temp files live for milliseconds while a lock is published; one older than this was left by a crashed session. */
const TEMP_TTL_MS = 30 * 1000;
const DISPOSE_WAIT_MS = KILL_GRACE_MS * 2 + 1000;
/**
 * Lock written by versions before generation numbers (`refresh.lock`); respected while live, never removed. Best effort
 * only: an old version doesn't know about generations, so the two can still overlap if both run at once (the docs
 * tell users to remove a manual copy when installing the plugin).
 */
const LEGACY_LOCK = "refresh.lock";
const GENERATION = /^refresh\.lock\.(\d+)(\.done)?$/;
const LOCK_TEMP = /^refresh\.lock\..+\.tmp$/;
const OTHER_SESSION_FAILED = "Another Copilot session's refresh ended without new stats (it failed or was stopped). Try Refresh again.";
const RUN_STILL_STOPPING = "The last CLI run timed out and may still be stopping. Try again in a few minutes.";
const LOCK_NOT_RELEASED =
    "The refresh lock could not be released, so no Copilot session can refresh until it expires (within about 20 minutes). Check that the stats folder is writable.";

function pidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error.code === "EPERM";
    }
}

/** True when `candidate` is a newer snapshot than `current`. */
function isNewer(candidate, current) {
    if (!candidate) return false;
    if (!current) return true;
    return !(Date.parse(current.fetchedAt) >= Date.parse(candidate.fetchedAt));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Owns the on-disk snapshot and makes sure only one CLI run happens at a time,
 * across every Copilot session on this machine (each session runs its own
 * extension process, so lock files coordinate them).
 *
 * Locking: every run gets the next lock *generation*, `refresh.lock.<n>`, and the highest generation on disk is the
 * current lock. A session may only start a run by creating generation n+1 after finding generation n finished (a
 * `.done` marker), stale, or absent. Creating a file is exclusive, so exactly one session wins each generation, and a
 * lock file is never deleted while it could still be the current one, so there is no check-then-delete race to lose.
 */
export class Refresher extends EventEmitter {
    constructor({
        dir = artifactsDir(),
        runCli = runFluencyCli,
        kill = killTree,
        now = () => Date.now(),
        timeoutMs = DEFAULT_TIMEOUT_MS,
        pollMs = 5000,
        disposeWaitMs = DISPOSE_WAIT_MS,
        readSnapshot = readPrivateSnapshotFile,
    } = {}) {
        super();
        this.dir = dir;
        this.runCli = runCli;
        this.kill = kill;
        this.now = now;
        this.timeoutMs = timeoutMs;
        this.pollMs = pollMs;
        this.disposeWaitMs = disposeWaitMs;
        this.readSnapshot = readSnapshot;
        this.lockGeneration = null;
        this.lockToken = null;
        this.kept = null; // { token, reason }: this session's lock, left to expire, so it isn't mistaken for another session's
        this.follow = 0;
        this.followBaseline = null;
        this.snapshot = null;
        this.unsafe = null;
        this.loading = null;
        this.loaded = false;
        this.reads = 0;
        this.latestRead = null;
        this.status = { state: "idle", startedAt: null, finishedAt: null, error: null, byOtherSession: false };
        this.inflight = null;
        this.child = null;
        this.users = 0;
        this.timer = null;
        this.watching = false;
        this.disposed = false;
    }

    /**
     * Reads the snapshot from disk; concurrent callers share one read. While a panel is open the file watcher keeps the
     * snapshot current, so the read is reused; with no panel open nothing watches the file, so every call reads it again.
     * A folder that was not private is checked again on every call, so fixing its permissions takes effect right away.
     */
    load() {
        if (!this.loading || (this.loaded && (!this.watching || this.unsafe))) {
            this.loaded = false;
            const loading = this.readFromDisk();
            this.loading = loading;
            loading
                .finally(() => {
                    if (this.loading === loading) this.loaded = true;
                })
                .catch(() => {});
        }
        return this.loading.then(() => this.snapshot);
    }

    /**
     * Applies the file on disk: a newer snapshot replaces the one in memory (never an older one, even if file events
     * arrive out of order), and a deleted file clears it (unless a refresh replaced it while reading). An unreadable
     * file keeps the last good copy. When reads overlap, only the latest one is applied, so a slow read that started
     * before the file was deleted cannot bring it back. Every read first makes sure the folder is private and fails
     * closed when it cannot be. Returns true when the in-memory snapshot changed.
     */
    readFromDisk() {
        const read = this.applyDiskRead(++this.reads);
        this.latestRead = read;
        return read;
    }

    async applyDiskRead(read) {
        const before = this.snapshot;
        const { snapshot, missing, unsafe } = await this.readSnapshot(this.dir);
        // Superseded: wait for the latest read so callers still see the current state once this resolves.
        if (read !== this.reads) return this.latestRead.then(() => false, () => false);
        if (unsafe) return this.refuseSnapshot(unsafe);
        if (this.unsafe) this.privacyRestored();
        if (missing) {
            if (!before || this.snapshot !== before) return false;
            this.snapshot = null;
            return true;
        }
        if (!isNewer(snapshot, this.snapshot)) return false;
        this.snapshot = snapshot;
        return true;
    }

    /** Fail closed: a snapshot that other users may be able to read is neither shown nor summarized. */
    refuseSnapshot(reason) {
        const known = this.unsafe === reason && !this.snapshot && this.status.state === "error" && this.status.error === reason;
        this.unsafe = reason;
        this.snapshot = null;
        if (!known) this.fail(reason);
        return false; // fail() already announced the change
    }

    /** The folder is private again: clear the error it caused, so the snapshot is used (and refreshed) as normal. */
    privacyRestored() {
        const reason = this.unsafe;
        this.unsafe = null;
        if (this.status.state === "error" && this.status.error === reason) this.setStatus({ state: "idle", error: null });
    }

    state() {
        return { snapshot: this.snapshot, status: { ...this.status } };
    }

    snapshotAgeMs() {
        const fetched = Date.parse(this.snapshot?.fetchedAt ?? "");
        return Number.isFinite(fetched) ? this.now() - fetched : Infinity;
    }

    setStatus(patch) {
        this.status = { ...this.status, ...patch };
        this.emit("change", this.state());
    }

    fail(error) {
        this.setStatus({ state: "error", finishedAt: new Date(this.now()).toISOString(), error, byOtherSession: false });
    }

    /** Fire-and-forget work (file watcher, timer, canvas open): a failure becomes the error status, never an unhandled rejection. */
    background(task) {
        void Promise.resolve()
            .then(task)
            .catch((error) => {
                if (!this.disposed) this.fail(error?.message ?? String(error));
            });
    }

    staleAfterMs() {
        return this.timeoutMs + LOCK_STALE_GRACE_MS;
    }

    lockFile(generation) {
        return join(this.dir, `${LEGACY_LOCK}.${generation}`);
    }

    /** The parsed lock, `null` when there is none, or `{ unreadable, startedAt: <mtime> }` when it cannot be parsed. */
    async readLock(path) {
        let text;
        try {
            text = await readFile(path, "utf8");
        } catch (error) {
            if (error.code === "ENOENT") return null;
            text = "";
        }
        try {
            const lock = JSON.parse(text);
            if (lock && typeof lock === "object") return lock;
        } catch {
            // partially written or corrupt: fail closed below
        }
        const { mtimeMs } = await stat(path).catch(() => ({ mtimeMs: Date.now() }));
        return { unreadable: true, startedAt: new Date(mtimeMs).toISOString() };
    }

    /** Highest lock generation on disk (0 when there is none), whether it is finished, and every file name. */
    async listLocks() {
        const names = await readdir(this.dir).catch((error) => {
            if (error.code === "ENOENT") return [];
            throw error;
        });
        let generation = 0;
        const done = new Set();
        for (const name of names) {
            const match = GENERATION.exec(name);
            if (!match) continue;
            const value = Number(match[1]);
            if (match[2]) done.add(value);
            else generation = Math.max(generation, value);
        }
        return { generation, done: done.has(generation), names };
    }

    /** The current lock: the highest generation, with `lock: null` once its owner marked it done (or when there is none). */
    async currentLock() {
        for (let attempt = 0; attempt < 3; attempt++) {
            const { generation, done } = await this.listLocks();
            if (generation === 0) return { generation, lock: null };
            const path = this.lockFile(generation);
            const lock = await this.readLock(path);
            if (!lock) continue; // gone between listing and reading: a session that lost the race removed its own file
            // The marker must name this lock's token: a leftover marker from an older holder of the same number doesn't count.
            if (done && lock.token && (await this.readLock(`${path}.done`))?.token === lock.token) return { generation, lock: null };
            return { generation, lock };
        }
        return { generation: (await this.listLocks()).generation, lock: null };
    }

    /** A lock that must be respected: another run within its time budget, or a lock file that is still being written. */
    isOtherSessionLock(lock) {
        if (!lock) return false;
        if (lock.token && lock.token === this.lockToken) return false;
        const age = this.now() - Date.parse(lock.startedAt);
        if (lock.unreadable) return age < PARTIAL_LOCK_GRACE_MS;
        return age < this.staleAfterMs() && pidAlive(lock.pid);
    }

    async otherSessionLock() {
        const legacy = await this.readLock(join(this.dir, LEGACY_LOCK));
        if (this.isOtherSessionLock(legacy)) return legacy;
        const { lock } = await this.currentLock();
        return this.isOtherSessionLock(lock) ? lock : null;
    }

    /**
     * Publishes a complete lock file atomically: `link` never overwrites, so exactly one session can create it, and
     * nobody can read it half-written. File systems without hard links fall back to an exclusive create; readers
     * treat the brief unparseable state as held (PARTIAL_LOCK_GRACE_MS) rather than stale.
     */
    async createLock(path, body, token) {
        const temp = `${path}.${token}.tmp`;
        await writeFile(temp, body, { flag: "wx", mode: PRIVATE_FILE_MODE });
        try {
            await link(temp, path);
            return true;
        } catch (error) {
            if (error.code === "EEXIST") return false;
            try {
                await writeFile(path, body, { flag: "wx", mode: PRIVATE_FILE_MODE });
                return true;
            } catch (fallbackError) {
                if (fallbackError.code === "EEXIST") return false;
                throw fallbackError;
            }
        } finally {
            await unlink(temp).catch(() => {});
        }
    }

    async acquireLock() {
        await ensurePrivateDir(this.dir);
        if (this.isOtherSessionLock(await this.readLock(join(this.dir, LEGACY_LOCK)))) return false;
        const { generation, lock } = await this.currentLock();
        if (this.isOtherSessionLock(lock)) return false;
        const next = generation + 1;
        const token = randomUUID();
        const body = JSON.stringify({ pid: process.pid, token, startedAt: new Date(this.now()).toISOString() });
        if (!(await this.createLock(this.lockFile(next), body, token))) return false; // another session won `next`
        // A session that listed the folder long ago can recreate a generation that was already cleaned up. The highest
        // generation is the lock, so such a late file loses and is removed again (it was never the current lock).
        const { generation: highest, names } = await this.listLocks();
        if (highest !== next) {
            await unlink(this.lockFile(next)).catch(() => {});
            return false;
        }
        this.lockGeneration = next;
        this.lockToken = token;
        await this.removeOldLocks(next, names);
        return true;
    }

    /** Removes lower generations and temp files left by crashed sessions. Never touches the current (highest) lock. */
    async removeOldLocks(current, names) {
        for (const name of names) {
            const match = GENERATION.exec(name);
            const path = join(this.dir, name);
            if (match) {
                if (Number(match[1]) < current) await unlink(path).catch(() => {});
            } else if (LOCK_TEMP.test(name)) {
                const { mtimeMs } = await stat(path).catch(() => ({ mtimeMs: Date.now() }));
                if (Date.now() - mtimeMs > TEMP_TTL_MS) await unlink(path).catch(() => {});
            }
        }
    }

    /**
     * Marks this session's generation finished (a `.done` marker carrying its token), which frees the lock for the next
     * generation. Nothing is removed, so this cannot affect a newer lock even when it runs late. With `keep`, the lock
     * is left to expire instead: a run that timed out may still have processes alive, which must not overlap the next run.
     * Throws when the marker can't be written: the lock then stays live until it expires, which the caller must report.
     */
    async releaseLock({ keep = false } = {}) {
        const generation = this.lockGeneration;
        const token = this.lockToken;
        this.lockGeneration = null;
        this.lockToken = null;
        if (!generation || keep) return;
        try {
            await writeFile(`${this.lockFile(generation)}.done`, JSON.stringify({ token }), { mode: PRIVATE_FILE_MODE });
        } catch (error) {
            this.kept = { token, reason: LOCK_NOT_RELEASED };
            throw new Error(`${LOCK_NOT_RELEASED} (${error.message})`);
        }
    }

    /** Start a refresh (or join the one already running). Resolves with the state when done. */
    refresh() {
        if (this.disposed) return Promise.resolve(this.state());
        if (this.inflight) return this.inflight;
        this.inflight = this.doRefresh()
            .catch((error) => {
                this.fail(error.message);
                return this.state();
            })
            .finally(() => {
                this.inflight = null;
            });
        return this.inflight;
    }

    /**
     * Starts a refresh (or joins the one in flight) and resolves as soon as it is known how it began, without waiting
     * for the CLI: `running` here, `running` with `byOtherSession` when it follows another session's run, or the final
     * state when it ended before either — refused or failed (`error`).
     */
    startRefresh() {
        if (this.inflight && this.status.state === "running") return Promise.resolve(this.state());
        let onBegin;
        const began = new Promise((resolve) => this.once("begin", (onBegin = resolve)));
        return Promise.race([began, this.refresh()]).finally(() => this.off("begin", onBegin));
    }

    async doRefresh() {
        await this.load();
        // Never write session data into a folder that isn't private. load() has reported it; only report it once.
        if (this.unsafe) {
            if (this.status.state !== "error" || this.status.error !== this.unsafe) this.fail(this.unsafe);
            return this.state();
        }
        const other = await this.otherSessionLock();
        if (other && other.token && other.token === this.kept?.token) {
            this.fail(this.kept.reason);
            return this.state();
        }
        if (other) return this.followOtherSession(other.startedAt);
        if (!(await this.acquireLock())) return this.followOtherSession(new Date(this.now()).toISOString());
        const startedAt = this.now();
        this.setStatus({ state: "running", startedAt: new Date(startedAt).toISOString(), error: null, byOtherSession: false });
        this.emit("begin", this.state());
        let keep = false;
        try {
            const onSpawn = (child) => {
                this.child = child;
                if (this.disposed) this.kill(child);
            };
            const { payload, cli } = await this.runCli({ timeoutMs: this.timeoutMs, onSpawn });
            if (this.disposed) return this.state(); // shutting down: don't publish a snapshot after disposal began
            const snapshot = buildSnapshot(payload, { fetchedAt: new Date(this.now()).toISOString(), durationMs: this.now() - startedAt, cli });
            await writeSnapshot(snapshot, this.dir);
            this.snapshot = snapshot;
            this.setStatus({ state: "idle", finishedAt: snapshot.fetchedAt, error: null });
        } catch (error) {
            // A timed-out run's processes may outlive the kill: let its lock expire rather than free it right away.
            keep = error?.timedOut === true;
            if (keep) this.kept = { token: this.lockToken, reason: RUN_STILL_STOPPING };
            this.fail(error.message);
        } finally {
            this.child = null;
            await this.releaseLock({ keep });
        }
        return this.state();
    }

    /**
     * Waits for another session's refresh to finish: a new snapshot appears (`idle`), or its lock goes away or expires
     * without one (`error`). Returns the state as soon as that happens, or after `maxWaitMs` with the status still `running`.
     */
    async waitForOtherSession({ maxWaitMs = this.staleAfterMs() } = {}) {
        const deadline = Date.now() + maxWaitMs;
        while (!this.disposed && this.followingOtherSession() && Date.now() < deadline) {
            await sleep(this.pollMs);
            await this.onSnapshotFileChanged();
            await this.checkOtherSession();
        }
        return this.state();
    }

    /** Refresh only when the snapshot is older than `maxAgeMs` (or missing). */
    async maybeRefresh(maxAgeMs) {
        await this.load();
        if (this.inflight || this.status.state === "running" || this.snapshotAgeMs() < maxAgeMs) return this.state();
        const failedRecently = this.status.state === "error" && this.now() - Date.parse(this.status.finishedAt) < maxAgeMs;
        if (failedRecently) return this.state();
        return this.refresh();
    }

    /** Picks up changes to the snapshot file: another session's refresh, or the file being deleted. */
    async onSnapshotFileChanged() {
        if (!(await this.readFromDisk())) return;
        if (this.followingOtherSession() && this.otherSessionDelivered()) this.settleOtherSession();
        else this.emit("change", this.state());
    }

    /** Once the other session's lock is gone: its new snapshot means success, no new snapshot means its run failed. */
    async checkOtherSession() {
        const follow = this.follow;
        if (!this.followingOtherSession() || (await this.otherSessionLock())) return;
        await this.readFromDisk();
        // Settled meanwhile: the file watcher saw the snapshot, or a newer refresh started.
        if (follow !== this.follow || !this.followingOtherSession()) return;
        this.settleOtherSession();
    }

    /** Another session is refreshing: remember what was on hand, so the end of its run can be told apart from a failure. */
    followOtherSession(startedAt) {
        this.follow++;
        this.followBaseline = this.snapshot;
        this.setStatus({ state: "running", startedAt, error: null, byOtherSession: true });
        this.emit("begin", this.state());
        return this.state();
    }

    followingOtherSession() {
        return this.status.state === "running" && this.status.byOtherSession;
    }

    /** A snapshot newer than the one on hand when the wait began, or written after the other run started. */
    otherSessionDelivered() {
        if (!this.snapshot) return false;
        return isNewer(this.snapshot, this.followBaseline) || Date.parse(this.snapshot.fetchedAt) >= Date.parse(this.status.startedAt);
    }

    settleOtherSession() {
        if (this.otherSessionDelivered()) {
            this.setStatus({ state: "idle", finishedAt: this.snapshot.fetchedAt, error: null, byOtherSession: false });
        } else {
            this.fail(OTHER_SESSION_FAILED);
        }
    }

    /** Called when a canvas instance opens; starts watching + the 30-minute auto refresh. */
    acquire() {
        this.users++;
        if (this.users > 1) return;
        // Nothing watched the file while no panel was open, so the next load() reads it again.
        this.loading = null;
        watchFile(snapshotPath(this.dir), { interval: this.pollMs }, () => this.background(() => this.onSnapshotFileChanged()));
        this.watching = true;
        this.timer = setInterval(() => this.tick(), TICK_MS);
        this.timer.unref?.();
    }

    /** The periodic check while a panel is open: settle a wait for another session, then auto-refresh when due. */
    tick() {
        this.background(async () => {
            await this.checkOtherSession();
            await this.maybeRefresh(AUTO_REFRESH_MS);
        });
    }

    release() {
        this.users = Math.max(0, this.users - 1);
        if (this.users > 0) return;
        clearInterval(this.timer);
        this.timer = null;
        if (this.watching) unwatchFile(snapshotPath(this.dir));
        this.watching = false;
    }

    /**
     * Stop everything (extension shutdown): no new refreshes, stop the running CLI process tree and wait for that run to
     * end before giving up the lock, so another session cannot start a second CLI while this one is still exiting. If
     * the run has not ended when the wait gives up, the lock is left to expire instead.
     */
    async dispose(kill = this.kill) {
        this.disposed = true;
        this.users = 1;
        this.release();
        if (this.child) kill(this.child);
        let ended = true;
        if (this.inflight) {
            // Unref'd: a run that is already gone must not keep the exiting process alive for the full wait.
            const giveUp = new Promise((resolve) => setTimeout(() => resolve(false), this.disposeWaitMs).unref?.());
            ended = await Promise.race([this.inflight.then(() => true), giveUp]);
        }
        // Shutting down: a lock that can't be released just expires, and there is nobody left to report it to.
        await this.releaseLock({ keep: !ended }).catch(() => {});
    }
}
