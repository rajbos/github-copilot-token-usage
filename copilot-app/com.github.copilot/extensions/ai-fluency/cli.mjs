import { spawn } from "node:child_process";
import { homedir } from "node:os";

const PACKAGE = "@rajbos/ai-engineering-fluency";
const GLOBAL_BIN = "ai-engineering-fluency";
const STDERR_TAIL_BYTES = 4096;
export const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
export const PROBE_TIMEOUT_MS = 30 * 1000;
export const KILL_GRACE_MS = 5000;
const IS_WINDOWS = process.platform === "win32";

// Commands are fixed strings (no user input), so running through the shell is
// safe and lets Windows resolve the npm `.cmd` shims. On POSIX the shell gets its
// own process group, so a timeout can stop everything it started (npx, node).
function run(command, { spawnImpl = spawn, killImpl = killTree, timeoutMs = DEFAULT_TIMEOUT_MS, graceMs = KILL_GRACE_MS, onSpawn, label = "CLI" } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawnImpl(command, {
            shell: true,
            windowsHide: true,
            detached: !IS_WINDOWS,
            cwd: homedir(),
            env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
        });
        onSpawn?.(child);
        const stdout = [];
        let stderr = "";
        let timeoutError = null;
        let giveUp = null;
        let settled = false;
        const settle = (fn, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            clearTimeout(giveUp);
            fn(value);
        };
        const timer = setTimeout(() => {
            const seconds = Math.round(timeoutMs / 1000);
            timeoutError = new Error(`${label} timed out after ${seconds >= 60 ? `${Math.round(seconds / 60)} minutes` : `${seconds} seconds`}`);
            timeoutError.timedOut = true; // the tree may outlive the kill; the refresher lets its lock expire instead of releasing it
            killImpl(child, { graceMs });
            // A descendant that survives the kill can hold stdout/stderr open, so `close` might never fire.
            giveUp = setTimeout(() => {
                child.stdout?.destroy();
                child.stderr?.destroy();
                settle(reject, timeoutError);
            }, graceMs * 2);
        }, timeoutMs);
        child.stdout.on("data", (chunk) => stdout.push(chunk));
        child.stderr.on("data", (chunk) => {
            stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_TAIL_BYTES);
        });
        child.on("error", (error) => settle(reject, error));
        child.on("close", (code) => {
            if (timeoutError) settle(reject, timeoutError);
            else settle(resolve, { code, stdout: Buffer.concat(stdout).toString("utf8"), stderr });
        });
    });
}

/**
 * Stops the CLI and everything it started. Windows: `taskkill /T` walks the tree. POSIX: the shell leads its own
 * process group (`detached`), so the whole group gets SIGTERM, then SIGKILL if it is still around after `graceMs`.
 *
 * On Windows an exited shell is left alone: its PID may already belong to an unrelated process, and `/T` cannot find
 * orphaned descendants through a parent that is gone (that needs a Job Object, which Node cannot create). The CLI
 * starts no background processes, and after a timeout the refresher keeps its lock until it expires, so a survivor
 * cannot overlap the next run within that window.
 */
export function killTree(child, { graceMs = KILL_GRACE_MS, killImpl = process.kill, spawnImpl = spawn } = {}) {
    const pid = child?.pid;
    if (!Number.isInteger(pid) || pid <= 1) return;
    if (IS_WINDOWS) {
        if (child.exitCode !== null) return;
        spawnImpl("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => {});
        return;
    }
    // Signal the group even when the shell itself already exited: its children may still be running.
    const signalGroup = (signal) => {
        try {
            killImpl(-pid, signal);
            return true;
        } catch {
            return false; // ESRCH: the group is gone
        }
    };
    if (!signalGroup("SIGTERM")) return;
    setTimeout(() => signalGroup("SIGKILL"), graceMs).unref?.();
}

function lastLine(text) {
    return text.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
}

/**
 * Prefer the global install; fall back to npx when it is missing or reports no version. A probe that times out is an
 * error instead: its process tree may still be running, and starting npx next to it would overlap two CLI runs, so the
 * refresher keeps its lock until it expires.
 */
export async function resolveCli({ probeTimeoutMs = PROBE_TIMEOUT_MS, ...options } = {}) {
    const probe = `${GLOBAL_BIN} --version`;
    try {
        const { code, stdout } = await run(probe, { ...options, timeoutMs: probeTimeoutMs, label: `\`${probe}\`` });
        const version = lastLine(stdout);
        if (code === 0 && /^\d+\.\d+\.\d+/.test(version)) {
            return { command: GLOBAL_BIN, version, source: "global" };
        }
    } catch (error) {
        if (error?.timedOut) throw error;
        // not installed (or not startable): fall through to npx
    }
    return { command: `npx -y ${PACKAGE}@latest`, version: null, source: "npx" };
}

export function parsePayload(stdout) {
    const text = stdout.replace(/^\uFEFF/, "").trim();
    const start = text.indexOf("{");
    if (start < 0) throw new Error("CLI returned no JSON output");
    const payload = JSON.parse(text.slice(start));
    if (!payload || typeof payload !== "object" || !("details" in payload)) {
        throw new Error("CLI output is missing the expected 'details' section");
    }
    return payload;
}

/** Runs `all --json` and returns the parsed payload plus which CLI produced it. */
export async function runFluencyCli(options = {}) {
    const cli = await resolveCli(options);
    const { code, stdout, stderr } = await run(`${cli.command} all --json`, options);
    if (code !== 0) {
        const detail = lastLine(stderr) || `exit code ${code}`;
        throw new Error(`ai-engineering-fluency failed: ${detail}`);
    }
    return { payload: parsePayload(stdout), cli };
}
