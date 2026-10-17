import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Refresher } from "../refresher.mjs";
import { buildSnapshot, readSnapshot, readSnapshotFile, writeSnapshot } from "../store.mjs";
import { samplePayload } from "./fixtures.mjs";

async function tempDir(t) {
    const dir = await mkdtemp(join(tmpdir(), "ai-fluency-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    return dir;
}

const noDescribe = () => ({ label: null, project: null });
const sampleAt = (fetchedAt) => buildSnapshot(samplePayload(), { fetchedAt, describe: noDescribe });
const cliResult = () => ({ payload: samplePayload(), cli: null });
/** Above every platform's pid range, so never alive. */
const DEAD_PID = 2 ** 22 + 12345;
const lockBody = (fields) => JSON.stringify({ startedAt: new Date().toISOString(), ...fields });
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const listDir = async (dir) => (await readdir(dir)).sort();

/** A runCli that blocks until `finish()` is called; `started` resolves once it runs. */
function gatedCli() {
    let finish;
    let markStarted;
    const started = new Promise((resolve) => (markStarted = resolve));
    const gate = new Promise((resolve) => (finish = resolve));
    const control = {
        runs: 0,
        started,
        finish: () => finish(),
        runCli: async ({ onSpawn } = {}) => {
            control.runs++;
            onSpawn?.({ pid: 4242 });
            markStarted();
            await gate;
            return { payload: samplePayload(), cli: { version: "1.2.3", source: "global" } };
        },
    };
    return control;
}

test("refresh runs the CLI once under a new lock generation and marks it done", async (t) => {
    const dir = await tempDir(t);
    const cli = gatedCli();
    const refresher = new Refresher({ dir, runCli: cli.runCli });
    const states = [];
    refresher.on("change", (s) => states.push(s.status.state));

    const first = refresher.refresh();
    const second = refresher.refresh();
    assert.equal(first, second, "concurrent refreshes share one run");
    await cli.started;
    const lock = await readJson(join(dir, "refresh.lock.1"));
    assert.equal(lock.pid, process.pid);
    assert.ok(lock.token);
    cli.finish();
    const { snapshot, status } = await first;

    assert.equal(cli.runs, 1);
    assert.equal(status.state, "idle");
    assert.equal(snapshot.cliVersion, "1.2.3");
    assert.deepEqual(await readSnapshot(dir), snapshot);
    assert.deepEqual(await readJson(join(dir, "refresh.lock.1.done")), { token: lock.token });
    assert.deepEqual(await listDir(dir), ["refresh.lock.1", "refresh.lock.1.done", "snapshot.json"]);
    assert.deepEqual(states, ["running", "idle"]);

    await refresher.refresh();
    assert.equal(cli.runs, 2, "a finished generation frees the lock");
    assert.deepEqual(await listDir(dir), ["refresh.lock.2", "refresh.lock.2.done", "snapshot.json"], "older generations are cleaned up");
});

test("a failed refresh surfaces the error and keeps the previous snapshot", async (t) => {
    const dir = await tempDir(t);
    const previous = sampleAt("2026-01-01T00:00:00.000Z");
    await writeSnapshot(previous, dir);
    const refresher = new Refresher({ dir, runCli: async () => { throw new Error("boom"); } });
    const { snapshot, status } = await refresher.refresh();
    assert.equal(status.state, "error");
    assert.equal(status.error, "boom");
    assert.equal(snapshot.fetchedAt, previous.fetchedAt);
    assert.ok((await readdir(dir)).includes("refresh.lock.1.done"), "an ordinary failure frees the lock");
});

test("maybeRefresh skips fresh snapshots and recent failures", async (t) => {
    const dir = await tempDir(t);
    let now = Date.parse("2026-01-01T01:00:00.000Z");
    await writeSnapshot(sampleAt("2026-01-01T00:50:00.000Z"), dir);
    let runs = 0;
    let fail = true;
    const refresher = new Refresher({
        dir,
        now: () => now,
        runCli: async () => {
            runs++;
            if (fail) throw new Error("nope");
            return cliResult();
        },
    });
    await refresher.maybeRefresh(30 * 60 * 1000);
    assert.equal(runs, 0, "10-minute-old snapshot is fresh enough");
    await refresher.maybeRefresh(5 * 60 * 1000);
    assert.equal(runs, 1, "older than 5 minutes triggers a refresh");
    await refresher.maybeRefresh(5 * 60 * 1000);
    assert.equal(runs, 1, "a failure within the window is not retried");
    now += 6 * 60 * 1000;
    fail = false;
    await refresher.maybeRefresh(5 * 60 * 1000);
    assert.equal(runs, 2, "retried after the window");
});

test("defers to a refresh already running in another session", async (t) => {
    const dir = await tempDir(t);
    // The parent process is alive and is not us, so its lock counts as "another session".
    await writeFile(join(dir, "refresh.lock.1"), lockBody({ pid: process.ppid, token: "other" }));
    let runs = 0;
    const refresher = new Refresher({ dir, runCli: async () => (runs++, cliResult()) });
    const { status } = await refresher.refresh();
    assert.equal(runs, 0);
    assert.equal(status.state, "running");
    assert.equal(status.byOtherSession, true);
    assert.deepEqual(await listDir(dir), ["refresh.lock.1"], "the other session's lock is left alone");

    await writeSnapshot(sampleAt("2026-02-02T00:00:00.000Z"), dir);
    await refresher.onSnapshotFileChanged();
    assert.equal(refresher.state().status.state, "idle");
    assert.equal(refresher.snapshot.fetchedAt, "2026-02-02T00:00:00.000Z");
});

test("takes over a lock left by a dead process or past its time budget, and cleans up after it", async (t) => {
    const expired = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    for (const stale of [{ pid: DEAD_PID }, { pid: process.ppid, startedAt: expired }]) {
        const dir = await tempDir(t);
        await writeFile(join(dir, "refresh.lock.3"), lockBody({ pid: DEAD_PID, token: "older" }));
        await writeFile(join(dir, "refresh.lock.3.done"), JSON.stringify({ token: "older" }));
        await writeFile(join(dir, "refresh.lock.4"), lockBody({ token: "gone", ...stale }));
        const crashedTemp = join(dir, "refresh.lock.4.crashed.tmp");
        await writeFile(crashedTemp, "");
        const old = new Date(Date.now() - 60_000);
        await utimes(crashedTemp, old, old);
        let runs = 0;
        const refresher = new Refresher({ dir, timeoutMs: 60_000, runCli: async () => (runs++, cliResult()) });
        const { status } = await refresher.refresh();
        assert.equal(runs, 1, JSON.stringify(stale));
        assert.equal(status.state, "idle");
        assert.deepEqual(await listDir(dir), ["refresh.lock.5", "refresh.lock.5.done", "snapshot.json"], "stale generations and temp files are removed");
    }
});

test("a done marker only frees the lock it names", async (t) => {
    const dir = await tempDir(t);
    await writeFile(join(dir, "refresh.lock.1"), lockBody({ pid: process.ppid, token: "live" }));
    await writeFile(join(dir, "refresh.lock.1.done"), JSON.stringify({ token: "earlier-holder" }));
    let runs = 0;
    const refresher = new Refresher({ dir, runCli: async () => (runs++, cliResult()) });
    assert.equal((await refresher.refresh()).status.byOtherSession, true);
    assert.equal(runs, 0, "a leftover marker from an earlier holder of generation 1 does not free it");

    await writeFile(join(dir, "refresh.lock.1.done"), JSON.stringify({ token: "live" }));
    const { status } = await refresher.refresh();
    assert.equal(runs, 1, "the owner's own marker does");
    assert.equal(status.state, "idle");
});

test("a lock that cannot be parsed yet is respected until it is clearly abandoned", async (t) => {
    const dir = await tempDir(t);
    const lockPath = join(dir, "refresh.lock.1");
    await writeFile(lockPath, '{"pid":'); // another session is mid-write (no-hard-link fallback)
    let runs = 0;
    const refresher = new Refresher({ dir, runCli: async () => (runs++, cliResult()) });
    const { status } = await refresher.refresh();
    assert.equal(runs, 0);
    assert.equal(status.byOtherSession, true);
    assert.equal(await readFile(lockPath, "utf8"), '{"pid":');

    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);
    await refresher.refresh();
    assert.equal(runs, 1, "a corrupt lock is taken over once it is old");
    assert.deepEqual(await listDir(dir), ["refresh.lock.2", "refresh.lock.2.done", "snapshot.json"]);
});

/** Separate sessions in one test process: each treats locks with another token as live. */
class Session extends Refresher {
    isOtherSessionLock(lock) {
        if (lock?.token && lock.token !== this.lockToken) return true;
        return super.isOtherSessionLock(lock);
    }
}

test("sessions racing to take over the same stale lock end up with exactly one owner", async (t) => {
    for (let round = 0; round < 25; round++) {
        const dir = await tempDir(t);
        await writeFile(join(dir, "refresh.lock.1"), lockBody({ pid: DEAD_PID }));
        const sessions = [0, 1, 2].map(() => new Session({ dir }));
        const won = await Promise.all(sessions.map((s) => s.acquireLock()));
        assert.equal(won.filter(Boolean).length, 1, `round ${round}: ${won}`);
        const owner = sessions[won.indexOf(true)];
        assert.equal((await readJson(join(dir, "refresh.lock.2"))).token, owner.lockToken);
        assert.deepEqual(await listDir(dir), ["refresh.lock.2"], "no stale or temp files left");
    }
});

test("a session that read an old generation backs off and removes the file it created", async (t) => {
    const dir = await tempDir(t);
    const current = lockBody({ pid: process.ppid, token: "current" });
    await writeFile(join(dir, "refresh.lock.3"), current);
    class Laggard extends Refresher {
        async currentLock() {
            return { generation: 1, lock: null }; // listed the folder before generations 2 and 3 existed
        }
    }
    const laggard = new Laggard({ dir });
    assert.equal(await laggard.acquireLock(), false);
    assert.equal(laggard.lockToken, null);
    assert.deepEqual(await listDir(dir), ["refresh.lock.3"]);
    assert.equal(await readFile(join(dir, "refresh.lock.3"), "utf8"), current);
});

test("a late release never frees a newer session's lock", async (t) => {
    const dir = await tempDir(t);
    let now = Date.now();
    const options = { dir, now: () => now, timeoutMs: 1000 };
    const a = new Refresher(options);
    assert.equal(await a.acquireLock(), true);
    now += a.staleAfterMs() + 1000; // A stalls past its time budget, so B takes over
    const b = new Refresher(options);
    assert.equal(await b.acquireLock(), true);
    assert.deepEqual(await listDir(dir), ["refresh.lock.2"]);

    await a.releaseLock(); // A finally finishes
    const c = new Refresher(options);
    assert.ok(await c.otherSessionLock(), "B's lock still holds");
    assert.equal(await c.acquireLock(), false);
    await b.releaseLock();
    assert.equal(await c.acquireLock(), true);
    assert.deepEqual(await listDir(dir), ["refresh.lock.3"]);
});

test("a timed-out run keeps its lock until it expires, so a lingering CLI never overlaps the next run", async (t) => {
    const dir = await tempDir(t);
    let now = Date.now();
    let runs = 0;
    const refresher = new Refresher({
        dir,
        now: () => now,
        timeoutMs: 1000,
        runCli: async () => {
            runs++;
            if (runs === 1) throw Object.assign(new Error("The CLI timed out after 1s"), { timedOut: true });
            return cliResult();
        },
    });
    const first = await refresher.refresh();
    assert.equal(first.status.state, "error");
    assert.deepEqual(await listDir(dir), ["refresh.lock.1"], "no done marker");

    const again = await refresher.refresh();
    assert.equal(runs, 1);
    assert.equal(again.status.state, "error");
    assert.match(again.status.error, /timed out and may still be stopping/);
    const other = new Refresher({ dir, now: () => now, timeoutMs: 1000, runCli: async () => assert.fail("must not run") });
    assert.equal((await other.refresh()).status.byOtherSession, true, "other sessions wait too");

    now += refresher.staleAfterMs() + 1000;
    const { status } = await refresher.refresh();
    assert.equal(runs, 2);
    assert.equal(status.state, "idle");
});

test("respects a live lock from older versions (refresh.lock) and never removes it", async (t) => {
    const dir = await tempDir(t);
    const legacy = join(dir, "refresh.lock");
    await writeFile(legacy, lockBody({ pid: process.ppid }));
    let runs = 0;
    const refresher = new Refresher({ dir, runCli: async () => (runs++, cliResult()) });
    assert.equal((await refresher.refresh()).status.byOtherSession, true);
    assert.equal(runs, 0);

    await writeFile(legacy, lockBody({ pid: DEAD_PID }));
    const { status } = await refresher.refresh();
    assert.equal(runs, 1, "a stale legacy lock is ignored");
    assert.equal(status.state, "idle");
    assert.ok((await readdir(dir)).includes("refresh.lock"));
});

test("concurrent loads read the snapshot once and never overwrite a newer one", async (t) => {
    const dir = await tempDir(t);
    await writeSnapshot(sampleAt("2026-01-01T00:00:00.000Z"), dir);
    const refresher = new Refresher({ dir, runCli: async () => cliResult() });
    const first = refresher.load();
    const shared = refresher.loading;
    refresher.load();
    assert.equal(refresher.loading, shared, "concurrent callers share one read");
    refresher.snapshot = { fetchedAt: "2026-03-03T00:00:00.000Z" }; // a refresh landed while the file was being read
    assert.equal((await first).fetchedAt, "2026-03-03T00:00:00.000Z");
});

test("with no panel open, every load reads the file again", async (t) => {
    const dir = await tempDir(t);
    await writeSnapshot(sampleAt("2026-01-01T00:00:00.000Z"), dir);
    const refresher = new Refresher({ dir, runCli: async () => cliResult() });
    assert.equal((await refresher.load()).fetchedAt, "2026-01-01T00:00:00.000Z");
    await writeSnapshot(sampleAt("2026-02-02T00:00:00.000Z"), dir); // another session refreshed
    assert.equal((await refresher.load()).fetchedAt, "2026-02-02T00:00:00.000Z", "get_summary never serves a stale copy");
});

test("reopening after every panel closed reads the snapshot again, keeping a newer one in memory", async (t) => {
    const dir = await tempDir(t);
    await writeSnapshot(sampleAt("2026-01-01T00:00:00.000Z"), dir);
    const refresher = new Refresher({ dir, pollMs: 60_000, runCli: async () => cliResult() });
    t.after(() => refresher.release());
    refresher.acquire();
    assert.equal((await refresher.load()).fetchedAt, "2026-01-01T00:00:00.000Z");
    refresher.release();

    await writeSnapshot(sampleAt("2026-02-02T00:00:00.000Z"), dir); // another session refreshed while no panel was open
    refresher.acquire();
    assert.equal((await refresher.load()).fetchedAt, "2026-02-02T00:00:00.000Z");
    refresher.release();

    refresher.snapshot = sampleAt("2026-03-03T00:00:00.000Z");
    refresher.acquire();
    assert.equal((await refresher.load()).fetchedAt, "2026-03-03T00:00:00.000Z", "an older file never replaces a newer snapshot");
});

test("a deleted snapshot is dropped from memory; an unreadable one keeps the last good copy", async (t) => {
    const dir = await tempDir(t);
    await writeSnapshot(sampleAt("2026-01-01T00:00:00.000Z"), dir);
    const refresher = new Refresher({ dir });
    assert.ok(await refresher.load());
    await writeFile(join(dir, "snapshot.json"), "{ half written");
    assert.equal((await refresher.load()).fetchedAt, "2026-01-01T00:00:00.000Z");
    await unlink(join(dir, "snapshot.json"));
    assert.equal(await refresher.load(), null);
});

test("the file watcher ignores an older snapshot and reports a deleted one", async (t) => {
    const dir = await tempDir(t);
    const refresher = new Refresher({ dir });
    refresher.snapshot = sampleAt("2026-03-03T00:00:00.000Z");
    const changes = [];
    refresher.on("change", (s) => changes.push(s.snapshot?.fetchedAt ?? null));
    await writeSnapshot(sampleAt("2026-01-01T00:00:00.000Z"), dir); // a slower session finished after a newer refresh
    await refresher.onSnapshotFileChanged();
    assert.equal(refresher.snapshot.fetchedAt, "2026-03-03T00:00:00.000Z");
    assert.deepEqual(changes, []);

    await unlink(join(dir, "snapshot.json"));
    await refresher.onSnapshotFileChanged();
    assert.equal(refresher.snapshot, null);
    assert.deepEqual(changes, [null]);
});

test("a slow read that started before the snapshot was deleted cannot bring it back", async (t) => {
    const dir = await tempDir(t);
    const reads = [];
    const refresher = new Refresher({ dir, readSnapshot: () => new Promise((resolve) => reads.push(resolve)) });
    refresher.snapshot = sampleAt("2026-01-01T00:00:00.000Z");
    const slow = refresher.readFromDisk(); // opened the file just before it was deleted
    const latest = refresher.readFromDisk(); // the watcher saw the delete
    let slowDone = false;
    void slow.then(() => (slowDone = true));
    reads[0]({ snapshot: sampleAt("2026-02-02T00:00:00.000Z"), missing: false });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(slowDone, false, "a superseded read waits for the latest one");
    reads[1]({ snapshot: null, missing: true });
    assert.equal(await latest, true);
    assert.equal(await slow, false);
    assert.equal(refresher.snapshot, null);
});

test("snapshot reads fail closed while the folder can't be made private, and recover once it can", async (t) => {
    const dir = await tempDir(t);
    await writeSnapshot(sampleAt("2026-01-01T00:00:00.000Z"), dir);
    let unsafe = null;
    let runs = 0;
    const refresher = new Refresher({
        dir,
        pollMs: 60_000,
        readSnapshot: async (d) => (unsafe ? { snapshot: null, missing: false, unsafe } : readSnapshotFile(d)),
        runCli: async () => (runs++, cliResult()),
    });
    refresher.acquire(); // a panel is open, so load() normally reuses its read
    t.after(() => refresher.release());
    assert.ok(await refresher.load());
    const changes = [];
    refresher.on("change", (s) => changes.push([s.snapshot?.fetchedAt ?? null, s.status.state, s.status.error]));

    unsafe = "not private";
    await refresher.onSnapshotFileChanged(); // the file watcher path
    assert.equal(refresher.snapshot, null, "the snapshot on show is dropped");
    assert.equal(await refresher.load(), null, "get_summary gets nothing either");
    assert.deepEqual(changes, [[null, "error", "not private"]], "reported once");
    assert.equal((await refresher.refresh()).status.error, "not private");
    assert.equal(runs, 0, "no CLI run writes session data into that folder");
    assert.deepEqual(await listDir(dir), ["snapshot.json"], "not even a lock file");

    unsafe = null;
    assert.equal((await refresher.load()).fetchedAt, "2026-01-01T00:00:00.000Z", "fixing the folder takes effect without a file change");
    assert.deepEqual([refresher.state().status.state, refresher.state().status.error], ["idle", null]);
});

test("a failing periodic check becomes an error status, not an unhandled rejection", async (t) => {
    const dir = await tempDir(t);
    const refresher = new Refresher({ dir, runCli: async () => assert.fail("must not run") });
    refresher.checkOtherSession = async () => {
        throw Object.assign(new Error("EACCES: permission denied, scandir"), { code: "EACCES" });
    };
    const failed = new Promise((resolve) => refresher.once("change", resolve));
    refresher.tick();
    const { status } = await failed;
    assert.equal(status.state, "error");
    assert.match(status.error, /EACCES/);

    await refresher.dispose();
    const afterDispose = [];
    refresher.on("change", (s) => afterDispose.push(s));
    refresher.tick();
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(afterDispose, [], "nothing is reported after dispose");
});

test("dispose stops the run, waits for it and publishes nothing afterwards", async (t) => {
    const dir = await tempDir(t);
    const cli = gatedCli();
    const killed = [];
    const refresher = new Refresher({
        dir,
        kill: (target) => {
            killed.push(target);
            cli.finish();
        },
        runCli: cli.runCli,
    });
    const running = refresher.refresh();
    await cli.started;
    await refresher.dispose();
    assert.deepEqual(killed, [{ pid: 4242 }]);
    await running;
    assert.deepEqual(await listDir(dir), ["refresh.lock.1", "refresh.lock.1.done"], "lock released after the run ended, no snapshot written during shutdown");
    await refresher.refresh();
    assert.equal(cli.runs, 1, "no new runs after dispose");
});

test("dispose leaves the lock to expire when the run does not end in time", async (t) => {
    const dir = await tempDir(t);
    const cli = gatedCli();
    const refresher = new Refresher({ dir, disposeWaitMs: 20, kill: () => {}, runCli: cli.runCli });
    t.after(() => cli.finish());
    void refresher.refresh();
    await cli.started;
    await refresher.dispose();
    assert.deepEqual(await listDir(dir), ["refresh.lock.1"], "no done marker while the CLI may still be running");
    const other = new Refresher({ dir });
    assert.ok(await other.otherSessionLock(), "other sessions keep waiting");
});

test("a lock that can't be released is reported, and not mistaken for another session's run", async (t) => {
    const dir = await tempDir(t);
    await mkdir(join(dir, "refresh.lock.1.done")); // the done marker can't be written
    let runs = 0;
    const refresher = new Refresher({ dir, runCli: async () => (runs++, cliResult()) });
    const { status, snapshot } = await refresher.refresh();
    assert.equal(status.state, "error");
    assert.match(status.error, /refresh lock could not be released/);
    assert.ok(snapshot, "the new stats are still used");
    assert.ok(await readSnapshot(dir));
    assert.ok(await new Refresher({ dir }).otherSessionLock(), "other sessions see the lock as held until it expires");

    const again = await refresher.refresh();
    assert.deepEqual([again.status.state, again.status.byOtherSession], ["error", false], "this session does not wait for itself");
    assert.match(again.status.error, /refresh lock could not be released/);
    assert.equal(runs, 1);
});

test("waiting for another session's refresh returns when its snapshot lands", async (t) => {
    const dir = await tempDir(t);
    await writeFile(join(dir, "refresh.lock.1"), lockBody({ pid: process.ppid, token: "other" }));
    const refresher = new Refresher({ dir, pollMs: 10, runCli: async () => assert.fail("must not run") });
    assert.equal((await refresher.refresh()).status.byOtherSession, true);
    setTimeout(async () => {
        await writeSnapshot(sampleAt("2026-04-04T00:00:00.000Z"), dir);
        await writeFile(join(dir, "refresh.lock.1.done"), JSON.stringify({ token: "other" }));
    }, 30);
    const { status, snapshot } = await refresher.waitForOtherSession();
    assert.equal(status.state, "idle");
    assert.equal(snapshot.fetchedAt, "2026-04-04T00:00:00.000Z");

    await writeFile(join(dir, "refresh.lock.2"), lockBody({ pid: process.ppid, token: "other-again" }));
    await refresher.refresh();
    const timedOut = await refresher.waitForOtherSession({ maxWaitMs: 30 });
    assert.equal(timedOut.status.state, "running", "gives up after maxWaitMs");
});

test("another session's refresh that ends without a new snapshot is reported as a failure", async (t) => {
    const endings = {
        "releases its lock": (dir) => writeFile(join(dir, "refresh.lock.1.done"), JSON.stringify({ token: "other" })),
        "dies": (dir) => writeFile(join(dir, "refresh.lock.1"), lockBody({ pid: DEAD_PID, token: "other" })),
    };
    for (const [how, end] of Object.entries(endings)) {
        const dir = await tempDir(t);
        const previous = sampleAt("2026-01-01T00:00:00.000Z");
        await writeSnapshot(previous, dir);
        await writeFile(join(dir, "refresh.lock.1"), lockBody({ pid: process.ppid, token: "other" }));
        const refresher = new Refresher({ dir, pollMs: 10, runCli: async () => assert.fail("must not run") });
        assert.equal((await refresher.refresh()).status.byOtherSession, true);
        setTimeout(() => void end(dir), 30);
        const { status, snapshot } = await refresher.waitForOtherSession();
        assert.equal(status.state, "error", `when the other session ${how}`);
        assert.match(status.error, /ended without new stats/);
        assert.equal(status.byOtherSession, false);
        assert.equal(snapshot.fetchedAt, previous.fetchedAt, "the previous snapshot stays on show");
    }
});

test("another session's snapshot counts even when it was read before that session's lock ended", async (t) => {
    const dir = await tempDir(t);
    await writeSnapshot(sampleAt("2026-01-01T00:00:00.000Z"), dir);
    const otherStarted = new Date(Date.now() - 60 * 1000).toISOString();
    await writeFile(join(dir, "refresh.lock.1"), lockBody({ pid: process.ppid, token: "other", startedAt: otherStarted }));
    const refresher = new Refresher({ dir, runCli: async () => assert.fail("must not run") });
    assert.equal((await refresher.refresh()).status.byOtherSession, true);

    // get_summary with no panel open reads the new snapshot directly, before the other session releases its lock.
    const fresh = new Date().toISOString();
    await writeSnapshot(sampleAt(fresh), dir);
    assert.equal((await refresher.load()).fetchedAt, fresh);
    assert.equal(refresher.state().status.state, "running");
    await writeFile(join(dir, "refresh.lock.1.done"), JSON.stringify({ token: "other" }));
    await refresher.checkOtherSession();
    assert.deepEqual([refresher.state().status.state, refresher.state().status.finishedAt], ["idle", fresh]);

    // Already on hand when this session began waiting, but written after the other run started: still that run's result.
    await writeFile(join(dir, "refresh.lock.2"), lockBody({ pid: process.ppid, token: "other-2", startedAt: otherStarted }));
    assert.equal((await refresher.refresh()).status.byOtherSession, true);
    await writeFile(join(dir, "refresh.lock.2.done"), JSON.stringify({ token: "other-2" }));
    await refresher.checkOtherSession();
    assert.equal(refresher.state().status.state, "idle");
});
