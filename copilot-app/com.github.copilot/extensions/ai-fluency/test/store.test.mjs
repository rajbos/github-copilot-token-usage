import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { buildSnapshot, describeSession, ensurePrivateDir, readPrivateSnapshotFile, readSnapshot, readSnapshotFile, summarize, topSeries, windowStart, writeSnapshot } from "../store.mjs";
import { samplePayload } from "./fixtures.mjs";

const noDescribe = () => ({ label: null, project: null });

test("buildSnapshot trims the payload to what the canvas renders", () => {
    const snapshot = buildSnapshot(samplePayload(), { fetchedAt: "2026-01-02T00:00:00.000Z", cli: { version: "9.9.9", source: "global" }, describe: noDescribe });
    assert.equal(snapshot.schemaVersion, 1);
    assert.equal(snapshot.cliVersion, "9.9.9");
    assert.deepEqual(Object.keys(snapshot.periods), ["today", "last30Days", "month", "lastMonth"]);
    assert.equal(snapshot.periods.today.models[0].name, "model-large", "models sorted by tokens desc");
    assert.equal(snapshot.periods.today.models[1].tokens, 120);
    assert.deepEqual(snapshot.periods.today.editors, [{ name: "Editor A", tokens: 1000, sessions: 1 }]);
    assert.deepEqual(snapshot.charts.day, {
        labels: ["2026-01-01", "2026-01-02"],
        tokens: [10, 20],
        sessions: [1, 2],
        cost: [0.1, 0.2346],
        splits: {
            tokens: { model: [{ label: "model-large", data: [8, 15] }, { label: "model-small", data: [2, 5] }] },
            cost: { editor: [{ label: "Editor A", data: [0.1, 0.2346] }] },
            sessions: {},
        },
    });
    assert.deepEqual(snapshot.charts.week, { labels: ["Dec 29–Jan 4"], tokens: [30], sessions: [3], cost: [0.3], splits: { tokens: {}, cost: {}, sessions: {} } });
    assert.equal(snapshot.charts.month, null);
    assert.equal(snapshot.sessions.length, 2, "sessions are de-duplicated by file path");
    assert.ok(snapshot.sessions.every((s) => !("filePath" in s)), "raw file paths are not stored");
    assert.equal(snapshot.fluency.categories[0].tips[0], "do more");
    assert.ok(!("period" in snapshot.fluency));
    assert.ok(!("curation" in snapshot));
});

test("buildSnapshot keeps sessions within the last 30 days only", () => {
    const payload = samplePayload();
    const old = { ...payload.usage.recentSessions.last30[0], filePath: "/tmp/first-of-month.jsonl", lastActivity: "2026-07-01T09:00:00.000Z" };
    payload.usage.recentSessions.currentMonth = [...payload.usage.recentSessions.last30, old]; // e.g. on July 31
    const snapshot = buildSnapshot(payload, { describe: noDescribe });
    assert.deepEqual(snapshot.sessions.map((s) => s.shortId).sort(), ["a", "b"], "a current-month session outside the 30-day window is not stored");
});

test("buildSnapshot tolerates an empty CLI payload", () => {
    const snapshot = buildSnapshot({ details: { today: {}, month: {}, lastMonth: {}, last30Days: {} }, chart: { labels: [] }, usage: {}, fluency: {} }, { describe: noDescribe });
    assert.equal(snapshot.periods.today.tokens, 0);
    assert.deepEqual(snapshot.sessions, []);
    assert.equal(snapshot.fluency, null);
    assert.deepEqual(snapshot.charts, { day: null, week: null, month: null });
});

test("topSeries keeps the largest series and folds the rest into Other", () => {
    const named = Array.from({ length: 10 }, (_, i) => ({ label: `series-${i}`, data: [i + 1, 1] }));
    const kept = topSeries([...named, { label: "Other", data: [5, 0] }, { label: "silent", data: [0, 0] }], 2);
    assert.equal(kept.length, 9);
    assert.deepEqual(kept.slice(0, 2).map((s) => s.label), ["series-9", "series-8"], "largest first");
    assert.deepEqual(kept.at(-1), { label: "Other (3)", data: [1 + 2 + 5, 2], other: true }, "two smallest + the CLI's own Other");
    assert.deepEqual(topSeries([{ label: "a", data: [3] }, { label: "b", data: [1] }], 1, { limit: 1 }), [{ label: "a", data: [3] }, { label: "b", data: [1] }], "a single leftover keeps its name");
    assert.deepEqual(topSeries([{ label: "a", data: [0.123456, "x"] }], 2, { digits: 4 }), [{ label: "a", data: [0.1235, 0] }]);
    assert.deepEqual(topSeries(undefined, 3), []);
});

test("describeSession derives labels from session metadata", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "ai-fluency-"));
    t.after(() => rm(root, { recursive: true, force: true }));

    const cliDir = join(root, "session-state", "11111111-2222-3333-4444-555555555555");
    await mkdir(cliDir, { recursive: true });
    await writeFile(join(cliDir, "workspace.yaml"), "id: x\ncwd: C:\\work\\copilot-worktrees\\demo-repo\\branch-a\nname: Fix the widget\n");
    assert.deepEqual(describeSession(join(cliDir, "events.jsonl")), { label: "Fix the widget", project: "demo-repo" });
    await writeFile(join(cliDir, "workspace.yaml"), 'cwd: C:\\work\\plain-repo\nname: "**Review** the PRs.\\n\\nThen   report back"\n');
    assert.deepEqual(describeSession(join(cliDir, "events.jsonl")), { label: "Review the PRs. Then report back", project: "plain-repo" });
    await writeFile(join(cliDir, "workspace.yaml"), "cwd: /home/someone/code/posix-repo/\nname: Tidy up\n");
    assert.deepEqual(describeSession(join(cliDir, "events.jsonl")), { label: "Tidy up", project: "posix-repo" }, "POSIX cwd, trailing slash");
    await writeFile(join(cliDir, "workspace.yaml"), "cwd: /home/someone/copilot-worktrees/posix-demo/branch-b\n");
    assert.deepEqual(describeSession(join(cliDir, "events.jsonl")), { label: null, project: "posix-demo" }, "POSIX worktree cwd");
    await writeFile(join(cliDir, "workspace.yaml"), "name:\nsummary: From the summary\ncwd: /home/someone/code/empty-name\n");
    assert.deepEqual(describeSession(join(cliDir, "events.jsonl")), { label: "From the summary", project: "empty-name" }, "an empty name falls back to the summary");
    await writeFile(join(cliDir, "workspace.yaml"), "name:\r\ncwd: /home/someone/code/no-title\r\nsummary:   \r\n");
    assert.deepEqual(describeSession(join(cliDir, "events.jsonl")), { label: null, project: "no-title" }, "an empty value never takes the next line");

    const wsDir = join(root, "workspaceStorage", "abc123");
    await mkdir(join(wsDir, "chatSessions"), { recursive: true });
    await writeFile(join(wsDir, "workspace.json"), JSON.stringify({ folder: "file:///c%3A/code/sample-project" }));
    assert.deepEqual(describeSession(join(wsDir, "chatSessions", "s.jsonl")), { label: null, project: "sample-project" });
    await writeFile(join(wsDir, "workspace.json"), JSON.stringify({ workspace: "file:///home/someone/code/team.code-workspace" }));
    assert.deepEqual(describeSession(join(wsDir, "chatSessions", "s.jsonl")), { label: null, project: "team" }, "POSIX workspace file URI");
    await writeFile(join(wsDir, "workspace.json"), JSON.stringify({ folder: "C:\\code\\windows-project\\" }));
    assert.deepEqual(describeSession(join(wsDir, "chatSessions", "s.jsonl")), { label: null, project: "windows-project" }, "Windows folder path");

    assert.deepEqual(describeSession(join(root, "C--Users-someone-code-repos-org-app--claude-worktrees-feature-x", "s.jsonl")), {
        label: "feature-x",
        project: "org-app",
    });
    assert.deepEqual(describeSession(join(root, "C--Users-someone--claude-worktrees-demo-repo-quiet-otter-a1b2c3", "s.jsonl")), {
        label: "demo-repo-quiet-otter",
        project: null,
    });
    assert.deepEqual(describeSession("/nowhere/opencode.db#ses_abc"), { label: null, project: null });
});

test("snapshots round-trip through disk and ignore other schema versions", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "ai-fluency-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    assert.equal(await readSnapshot(dir), null);
    const snapshot = buildSnapshot(samplePayload(), { describe: noDescribe });
    await writeSnapshot(snapshot, dir);
    assert.deepEqual(await readSnapshot(dir), snapshot);
    await writeSnapshot({ ...snapshot, schemaVersion: 0 }, dir);
    assert.equal(await readSnapshot(dir), null);
});

test("summarize returns a compact agent-facing view", () => {
    assert.equal(summarize(null).available, false);
    const snapshot = buildSnapshot(samplePayload(), { describe: noDescribe });
    const summary = summarize(snapshot, { topSessions: 1 });
    assert.equal(summary.available, true);
    assert.equal(summary.periods.today.estimatedApiCostUsd, 1.25);
    assert.equal(summary.periods.today.topModels.length, 2);
    assert.equal(summary.fluency.overall, "Stage 3: AI Collaborator");
    assert.equal(summary.topSessionsLast7Days.length, 1);
    assert.equal(summary.topSessionsLast7Days[0].label, "Editor A a");
});

test("summarize leaves session titles and projects out unless asked", () => {
    const snapshot = buildSnapshot(samplePayload(), { describe: () => ({ label: "secret prompt", project: "private-repo" }) });
    const summary = summarize(snapshot);
    assert.deepEqual(summary.topSessionsLast7Days, []);
    assert.doesNotMatch(JSON.stringify(summary), /secret prompt|private-repo/);
    assert.match(JSON.stringify(summarize(snapshot, { topSessions: 5 })), /secret prompt/);
});

test("the last-7-days window counts calendar days from local midnight, like the CLI", () => {
    const now = new Date(2026, 0, 10, 9, 0); // local Jan 10, 09:00
    assert.equal(windowStart(1, now), new Date(2026, 0, 10).getTime(), "today starts at local midnight");
    assert.equal(windowStart(7, now), new Date(2026, 0, 4).getTime(), "7 days = today plus the 6 days before it");
    const base = buildSnapshot(samplePayload(), { describe: noDescribe });
    const session = (label, lastActivity) => ({ ...base.sessions[0], label, lastActivity: lastActivity.toISOString() });
    const snapshot = {
        ...base,
        sessions: [session("early on the 4th", new Date(2026, 0, 4, 0, 30)), session("late on the 3rd", new Date(2026, 0, 3, 23, 30))],
    };
    const labels = summarize(snapshot, { topSessions: 5, now }).topSessionsLast7Days.map((s) => s.label);
    assert.deepEqual(labels, ["early on the 4th"], "Jan 3 23:30 is inside a rolling 7x24h window, but not on the last 7 calendar days");
});

test("readSnapshotFile tells a missing snapshot apart from an unreadable one", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "ai-fluency-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    assert.deepEqual(await readSnapshotFile(dir), { snapshot: null, missing: true });
    await writeFile(join(dir, "snapshot.json"), "{ half written");
    assert.deepEqual(await readSnapshotFile(dir), { snapshot: null, missing: false });
    const snapshot = buildSnapshot(samplePayload(), { describe: noDescribe });
    await writeSnapshot(snapshot, dir);
    assert.deepEqual(await readSnapshotFile(dir), { snapshot, missing: false });
});

test("snapshots are owner-only on POSIX, including folders from older versions", { skip: process.platform === "win32" && "POSIX modes do not apply on Windows" }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "ai-fluency-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const snapshot = buildSnapshot(samplePayload(), { describe: noDescribe });
    const mode = async (path) => (await stat(path)).mode & 0o777;

    const fresh = join(root, "new", "artifacts");
    await writeSnapshot(snapshot, fresh);
    assert.equal(await mode(fresh), 0o700);
    assert.equal(await mode(join(fresh, "snapshot.json")), 0o600);

    const old = join(root, "old");
    await mkdir(old, { mode: 0o755 });
    await chmod(old, 0o755);
    await writeFile(join(old, "snapshot.json"), "{}", { mode: 0o644 });
    await chmod(join(old, "snapshot.json"), 0o644);
    await ensurePrivateDir(old);
    assert.equal(await mode(old), 0o700, "existing folder is tightened");
    assert.equal(await mode(join(old, "snapshot.json")), 0o600, "existing snapshot is tightened");
    await writeSnapshot(snapshot, old);
    assert.equal(await mode(join(old, "snapshot.json")), 0o600);
});

test("writeSnapshot leaves no temp files behind", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "ai-fluency-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    await writeSnapshot(buildSnapshot(samplePayload(), { describe: noDescribe }), dir);
    await writeSnapshot(buildSnapshot(samplePayload(), { describe: noDescribe }), dir);
    assert.deepEqual(await readdir(dir), ["snapshot.json"]);
});

test("readPrivateSnapshotFile reads a private folder and tolerates a missing snapshot", async (t) => {
    const dir = join(await mkdtemp(join(tmpdir(), "ai-fluency-")), "artifacts");
    t.after(() => rm(dirname(dir), { recursive: true, force: true }));
    assert.deepEqual(await readPrivateSnapshotFile(dir), { snapshot: null, missing: true });
    await writeSnapshot(buildSnapshot(samplePayload(), { describe: noDescribe }), dir);
    const { snapshot, missing, unsafe } = await readPrivateSnapshotFile(dir);
    assert.ok(snapshot);
    assert.equal(missing, false);
    assert.equal(unsafe, undefined);
});

test("readPrivateSnapshotFile refuses a snapshot it can't make private", { skip: (process.platform === "win32" || process.getuid?.() === 0) && "POSIX, non-root only" }, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "ai-fluency-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    // Another user's world-readable file, which this user cannot chmod.
    await symlink("/etc/passwd", join(dir, "snapshot.json"));
    await assert.rejects(ensurePrivateDir(dir), { code: "EPERM" });
    const { snapshot, missing, unsafe } = await readPrivateSnapshotFile(dir);
    assert.equal(snapshot, null);
    assert.equal(missing, false);
    assert.match(unsafe, /can't be made private/);
});
