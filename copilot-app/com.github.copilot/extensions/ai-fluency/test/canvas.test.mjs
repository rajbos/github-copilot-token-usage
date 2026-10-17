import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CANVAS_ID, startExtension } from "../canvas.mjs";
import { Refresher } from "../refresher.mjs";
import { buildSnapshot, writeSnapshot } from "../store.mjs";
import { samplePayload } from "./fixtures.mjs";

class FakeCanvasError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

const cliResult = () => ({ payload: samplePayload(), cli: null });

async function until(check, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error("timed out waiting for condition");
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

/** Starts the extension against a stub SDK, a temp-dir refresher, fake panel servers and a fake process. */
async function setup(t, { runCli = async () => cliResult(), pollMs = 60_000 } = {}) {
    const dir = await mkdtemp(join(tmpdir(), "ai-fluency-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const refresher = new Refresher({ dir, pollMs, runCli });
    const processRef = new EventEmitter();
    processRef.exitCodes = [];
    processRef.exit = (code) => processRef.exitCodes.push(code);
    const servers = [];
    const start = async () => {
        const server = { url: `http://127.0.0.1:1/panel-${servers.length}/`, closed: false, close: async () => void (server.closed = true) };
        servers.push(server);
        return server;
    };
    const logs = [];
    let canvases;
    const sdk = {
        CanvasError: FakeCanvasError,
        createCanvas: (definition) => ({ definition }),
        joinSession: async (options) => {
            canvases = options.canvases;
            return { log: async (message, options) => void logs.push({ message, options }) };
        },
    };
    const extension = await startExtension(sdk, { refresher, processRef, start });
    t.after(() => extension.shutdown());
    const [{ definition }] = canvases;
    const action = (name) => definition.actions.find((a) => a.name === name).handler;
    return { dir, refresher, processRef, servers, logs, definition, action };
}

test("registers the ai-fluency canvas with its two agent actions", async (t) => {
    const { definition } = await setup(t);
    assert.equal(CANVAS_ID, "ai-fluency");
    assert.equal(definition.id, CANVAS_ID);
    assert.equal(definition.displayName, "AI Engineering Fluency");
    assert.deepEqual(definition.actions.map((a) => a.name), ["get_summary", "refresh"]);
});

test("get_summary serves the cached snapshot without running the CLI, with titles only on request", async (t) => {
    let runs = 0;
    const { dir, action } = await setup(t, { runCli: async () => (runs++, cliResult()) });
    await writeSnapshot(buildSnapshot(samplePayload(), { describe: () => ({ label: "secret prompt", project: "private-repo" }) }), dir);
    const summary = await action("get_summary")({ input: null });
    assert.equal(summary.available, true);
    assert.equal(summary.refresh.state, "idle");
    assert.doesNotMatch(JSON.stringify(summary), /secret prompt|private-repo/);
    assert.match(JSON.stringify(await action("get_summary")({ input: { topSessions: 1 } })), /secret prompt/);
    assert.equal(runs, 0);
});

test("refresh returns once the run has begun and runs in the background", async (t) => {
    let finish;
    const gate = new Promise((resolve) => (finish = resolve));
    const { action, refresher } = await setup(t, { runCli: async () => (await gate, cliResult()) });
    const result = await action("refresh")({ input: {} });
    assert.equal(result.started, true);
    assert.deepEqual([result.status.state, result.status.byOtherSession], ["running", false]);
    const again = await action("refresh")({ input: null });
    assert.deepEqual([again.started, again.status.state], [true, "running"], "a second call joins the run in flight");
    finish();
    await until(() => refresher.state().status.state === "idle");
});

test("refresh without wait says when it joined another session's run, and fails at once when it can't start", async (t) => {
    const { dir, action, refresher } = await setup(t, { runCli: async () => assert.fail("must not run") });
    await writeFile(join(dir, "refresh.lock.1"), JSON.stringify({ pid: process.ppid, token: "other", startedAt: new Date().toISOString() }));
    const joined = await action("refresh")({ input: {} });
    assert.equal(joined.started, false);
    assert.equal(joined.status.byOtherSession, true);
    assert.match(joined.message, /Another Copilot session is already refreshing/);

    refresher.readSnapshot = async () => ({ snapshot: null, missing: false, unsafe: "not private" });
    await assert.rejects(action("refresh")({ input: {} }), (error) => {
        assert.deepEqual([error.code, error.message], ["refresh_failed", "not private"]);
        return true;
    });

    await refresher.dispose();
    await assert.rejects(action("refresh")({ input: {} }), /shutting down/);
    await assert.rejects(action("refresh")({ input: { wait: true } }), /shutting down/);
});

test("refresh with wait returns the new snapshot; a failure becomes a CanvasError and a session warning", async (t) => {
    let fail = false;
    const { action, logs } = await setup(t, {
        runCli: async () => {
            if (fail) throw new Error("CLI exploded");
            return cliResult();
        },
    });
    const done = await action("refresh")({ input: { wait: true } });
    assert.equal(done.status.state, "idle");
    assert.ok(done.fetchedAt);

    fail = true;
    await assert.rejects(action("refresh")({ input: { wait: true } }), (error) => {
        assert.ok(error instanceof FakeCanvasError);
        assert.equal(error.code, "refresh_failed");
        assert.equal(error.message, "CLI exploded");
        return true;
    });
    assert.deepEqual(logs, [{ message: "AI Engineering Fluency refresh failed: CLI exploded", options: { level: "warning", ephemeral: true } }]);
});

test("refresh with wait also waits for a refresh another session is running", async (t) => {
    const { dir, action } = await setup(t, { pollMs: 10, runCli: async () => assert.fail("must not run") });
    await writeFile(join(dir, "refresh.lock.1"), JSON.stringify({ pid: process.ppid, token: "other", startedAt: new Date().toISOString() }));
    setTimeout(async () => {
        await writeSnapshot(buildSnapshot(samplePayload(), { fetchedAt: "2026-05-05T00:00:00.000Z", describe: () => ({ label: null, project: null }) }), dir);
        await writeFile(join(dir, "refresh.lock.1.done"), JSON.stringify({ token: "other" }));
    }, 30);
    const result = await action("refresh")({ input: { wait: true } });
    assert.equal(result.status.state, "idle");
    assert.equal(result.fetchedAt, "2026-05-05T00:00:00.000Z");
});

test("refresh with wait fails when another session's refresh ends without a new snapshot", async (t) => {
    const { dir, action } = await setup(t, { pollMs: 10, runCli: async () => assert.fail("must not run") });
    await writeSnapshot(buildSnapshot(samplePayload(), { fetchedAt: "2026-01-01T00:00:00.000Z", describe: () => ({ label: null, project: null }) }), dir);
    await writeFile(join(dir, "refresh.lock.1"), JSON.stringify({ pid: process.ppid, token: "other", startedAt: new Date().toISOString() }));
    setTimeout(() => void writeFile(join(dir, "refresh.lock.1.done"), JSON.stringify({ token: "other" })), 30);
    await assert.rejects(action("refresh")({ input: { wait: true } }), (error) => {
        assert.equal(error.code, "refresh_failed");
        assert.match(error.message, /ended without new stats/);
        return true;
    });
});

test("opening a panel starts its server, watches the snapshot and refreshes a missing one; closing releases it", async (t) => {
    let runs = 0;
    const { definition, refresher, servers } = await setup(t, { runCli: async () => (runs++, cliResult()) });
    const opened = await definition.open({ instanceId: "a" });
    assert.deepEqual(opened, { title: "AI Engineering Fluency", url: servers[0].url });
    await definition.open({ instanceId: "a" }); // reopening focuses the same panel
    assert.equal(servers.length, 1);
    assert.equal(refresher.users, 1);
    assert.equal(refresher.watching, true);
    await until(() => refresher.snapshot);
    assert.equal(runs, 1, "one refresh for a panel opened twice");

    await definition.onClose({ instanceId: "a" });
    assert.equal(servers[0].closed, true);
    assert.equal(refresher.users, 0);
    assert.equal(refresher.watching, false);
});

test("a failure in the refresh started on open becomes an error status and a session warning", async (t) => {
    const { definition, refresher, logs } = await setup(t);
    refresher.maybeRefresh = async () => {
        throw new Error("EACCES: permission denied, scandir");
    };
    await definition.open({ instanceId: "a" });
    await until(() => refresher.state().status.state === "error");
    assert.match(refresher.state().status.error, /EACCES/);
    assert.match(logs.at(-1).message, /EACCES/);
});

test("SIGTERM closes every panel, stops the refresher and exits", async (t) => {
    const { definition, processRef, refresher, servers } = await setup(t);
    await definition.open({ instanceId: "a" });
    await definition.open({ instanceId: "b" });
    processRef.emit("SIGTERM");
    await until(() => processRef.exitCodes.length > 0);
    assert.deepEqual(processRef.exitCodes, [0]);
    assert.equal(servers.length, 2);
    assert.ok(servers.every((server) => server.closed));
    assert.equal(refresher.disposed, true);
});
