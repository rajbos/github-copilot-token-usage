import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { killTree, parsePayload, resolveCli, runFluencyCli } from "../cli.mjs";

/** Fake child_process.spawn: maps a command string to { code, stdout, stderr }. */
function fakeSpawn(responses) {
    const calls = [];
    const spawnImpl = (command, options) => {
        calls.push({ command, options });
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.pid = 1;
        child.exitCode = null;
        const response = responses[command];
        queueMicrotask(() => {
            if (!response) {
                child.emit("error", Object.assign(new Error("not found"), { code: "ENOENT" }));
                return;
            }
            child.stdout.end(response.stdout ?? "");
            child.stderr.end(response.stderr ?? "");
            child.exitCode = response.code ?? 0;
            setImmediate(() => child.emit("close", child.exitCode));
        });
        return child;
    };
    return { spawnImpl, calls };
}

test("prefers the global install when it reports a version", async () => {
    const { spawnImpl, calls } = fakeSpawn({ "ai-engineering-fluency --version": { stdout: "0.6.1\n" } });
    assert.deepEqual(await resolveCli({ spawnImpl }), { command: "ai-engineering-fluency", version: "0.6.1", source: "global" });
    assert.equal(calls[0].options.windowsHide, true);
    assert.equal(calls[0].options.shell, true);
    assert.equal(calls[0].options.detached, process.platform !== "win32", "POSIX runs get their own process group");
});

test("a timeout stops the process tree and settles even if the pipes never close", async () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = 4242;
    child.exitCode = null;
    const kills = [];
    const started = Date.now();
    await assert.rejects(
        runFluencyCli({
            spawnImpl: (command) => {
                if (command.endsWith("--version")) return fakeSpawn({ [command]: { stdout: "0.6.1" } }).spawnImpl(command, {});
                return child; // hangs: never emits close
            },
            killImpl: (target, options) => kills.push({ target, options }),
            timeoutMs: 20,
            graceMs: 10,
        }),
        /timed out/,
    );
    assert.equal(kills.length, 1);
    assert.equal(kills[0].target, child);
    assert.equal(kills[0].options.graceMs, 10);
    assert.ok(child.stdout.destroyed && child.stderr.destroyed, "pipes held open by a survivor are released");
    assert.ok(Date.now() - started < 5000);
});

test("a timeout is reported as a timeout when the killed process closes", async () => {
    const { spawnImpl } = fakeSpawn({ "ai-engineering-fluency --version": { stdout: "0.6.1" } });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = 4243;
    child.exitCode = null;
    await assert.rejects(
        runFluencyCli({
            spawnImpl: (command, options) => (command.endsWith("--version") ? spawnImpl(command, options) : child),
            killImpl: () => setImmediate(() => child.emit("close", null)),
            timeoutMs: 20,
            graceMs: 1000,
        }),
        /timed out/,
    );
});

test("killTree signals the whole process group on POSIX, then force-kills", { skip: process.platform === "win32" && "POSIX only" }, async () => {
    const signals = [];
    killTree({ pid: 4321, exitCode: 0 }, { graceMs: 10, killImpl: (pid, signal) => signals.push([pid, signal]) });
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(signals, [[-4321, "SIGTERM"], [-4321, "SIGKILL"]], "the group is signalled even after the shell exited");

    const gone = [];
    killTree({ pid: 4322, exitCode: null }, { graceMs: 10, killImpl: (pid, signal) => { gone.push(signal); throw Object.assign(new Error("no such process"), { code: "ESRCH" }); } });
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(gone, ["SIGTERM"], "no SIGKILL when the group is already gone");
});

test("killTree uses taskkill /T on Windows", { skip: process.platform !== "win32" && "Windows only" }, () => {
    const calls = [];
    const spawnImpl = (command, args) => (calls.push([command, args]), new EventEmitter());
    killTree({ pid: 4321, exitCode: null }, { spawnImpl });
    assert.deepEqual(calls, [["taskkill", ["/pid", "4321", "/T", "/F"]]]);
});

test("killTree never signals pid 0/1 or a missing pid", () => {
    const signals = [];
    const killImpl = (pid, signal) => signals.push([pid, signal]);
    const spawnImpl = () => (signals.push(["spawn"]), new EventEmitter());
    for (const pid of [undefined, 0, 1, -5]) killTree({ pid, exitCode: null }, { killImpl, spawnImpl });
    assert.deepEqual(signals, []);
});

test("falls back to npx when the global install is missing", async () => {
    const missing = fakeSpawn({ "ai-engineering-fluency --version": { code: 1, stderr: "'ai-engineering-fluency' is not recognized" } });
    assert.equal((await resolveCli({ spawnImpl: missing.spawnImpl })).source, "npx");
    const erroring = fakeSpawn({});
    assert.match((await resolveCli({ spawnImpl: erroring.spawnImpl })).command, /^npx -y @rajbos\/ai-engineering-fluency@latest$/);
});

test("a global probe that times out fails the run instead of starting npx next to it", async () => {
    const probe = new EventEmitter();
    probe.stdout = new PassThrough();
    probe.stderr = new PassThrough();
    probe.pid = 4244;
    probe.exitCode = null;
    const commands = [];
    const error = await runFluencyCli({
        spawnImpl: (command) => (commands.push(command), probe), // hangs until killed
        killImpl: () => setImmediate(() => probe.emit("close", null)),
        probeTimeoutMs: 20,
        graceMs: 1000,
    }).then(
        () => assert.fail("must reject"),
        (e) => e,
    );
    assert.match(error.message, /^`ai-engineering-fluency --version` timed out/);
    assert.equal(error.timedOut, true, "so the refresher keeps its lock until it expires");
    assert.deepEqual(commands, ["ai-engineering-fluency --version"], "no npx run was started");
});

test("runs `all --json` and parses output with a BOM and leading noise", async () => {
    const { spawnImpl, calls } = fakeSpawn({
        "ai-engineering-fluency --version": { stdout: "0.6.1" },
        "ai-engineering-fluency all --json": { stdout: '\uFEFFnoise\n{"details":{},"chart":{}}' },
    });
    const { payload, cli } = await runFluencyCli({ spawnImpl });
    assert.deepEqual(payload, { details: {}, chart: {} });
    assert.equal(cli.version, "0.6.1");
    assert.equal(calls.at(-1).command, "ai-engineering-fluency all --json");
});

test("reports the last stderr line when the CLI fails", async () => {
    const { spawnImpl } = fakeSpawn({
        "ai-engineering-fluency --version": { stdout: "0.6.1" },
        "ai-engineering-fluency all --json": { code: 2, stderr: "warming up\nSomething broke\n" },
    });
    await assert.rejects(runFluencyCli({ spawnImpl }), /Something broke/);
});

test("parsePayload rejects output without the details section", () => {
    assert.throws(() => parsePayload(""), /no JSON/);
    assert.throws(() => parsePayload('{"other":1}'), /details/);
});
