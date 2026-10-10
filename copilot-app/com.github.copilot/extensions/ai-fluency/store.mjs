import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export const SCHEMA_VERSION = 1;
export const PERIODS = ["today", "last30Days", "month", "lastMonth"];

export function artifactsDir() {
    const home = process.env.COPILOT_HOME || join(homedir(), ".copilot");
    return join(home, "extensions", "ai-fluency", "artifacts");
}

export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

/**
 * The snapshot holds session titles (often the first prompt) and project names, so the artifacts folder and the
 * snapshot in it are owner-only. This also tightens folders and snapshots written by older versions, and throws when
 * either cannot be made private (for example, a folder owned by another user), so callers can fail closed. POSIX
 * modes do not apply on Windows: there the folder inherits the ACLs of `COPILOT_HOME`, by default the user profile,
 * which only the user, administrators and SYSTEM can read. Windows ACLs are not rewritten here: `COPILOT_HOME` also
 * holds Copilot's own session logs (the full prompts these titles come from), so it has to be private regardless.
 */
export async function ensurePrivateDir(dir = artifactsDir()) {
    await mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
    if (process.platform === "win32") return;
    await makePrivate(dir, PRIVATE_DIR_MODE);
    await makePrivate(snapshotPath(dir), PRIVATE_FILE_MODE, { mayBeMissing: true });
}

/** `chmod`, except that a path it cannot change (a read-only file system) is fine when it is ours and owner-only already. */
async function makePrivate(path, mode, { mayBeMissing = false } = {}) {
    try {
        await chmod(path, mode);
    } catch (error) {
        if (mayBeMissing && error.code === "ENOENT") return;
        const info = await stat(path).catch(() => null);
        if (!info || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw error;
    }
}

const num = (value) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

function sortedEntries(map, toRow) {
    return Object.entries(map ?? {})
        .map(([name, value]) => toRow(name, value ?? {}))
        .sort((a, b) => b.tokens - a.tokens);
}

function trimPeriod(period = {}) {
    return {
        tokens: num(period.tokens),
        thinkingTokens: num(period.thinkingTokens),
        sessions: num(period.sessions),
        avgInteractionsPerSession: num(period.avgInteractionsPerSession),
        avgTokensPerSession: num(period.avgTokensPerSession),
        estimatedCost: num(period.estimatedCost),
        estimatedCostCopilot: num(period.estimatedCostCopilot),
        co2: num(period.co2),
        waterUsage: num(period.waterUsage),
        treesEquivalent: num(period.treesEquivalent),
        models: sortedEntries(period.modelUsage, (name, m) => ({
            name,
            tokens: num(m.inputTokens) + num(m.outputTokens),
            inputTokens: num(m.inputTokens),
            outputTokens: num(m.outputTokens),
            cachedTokens: num(m.cachedReadTokens),
        })),
        editors: sortedEntries(period.editorUsage, (name, e) => ({ name, tokens: num(e.tokens), sessions: num(e.sessions) })),
    };
}

export const CHART_PERIODS = ["day", "week", "month"];
export const TOP_SERIES = 8;
// Chart view "split" datasets per metric, keyed by the CLI's `chart.periods.<period>` field names.
const SPLIT_SOURCES = {
    tokens: { model: "modelDatasets", editor: "editorDatasets", provider: "providerTokensDatasets", repository: "repositoryDatasets" },
    cost: { model: "modelCostDatasets", editor: "editorCostDatasets", provider: "billingGroupCostDatasets" },
    sessions: { model: "modelSessionsDatasets", editor: "editorSessionsDatasets", provider: "providerSessionsDatasets" },
};

/**
 * Keeps the largest series (bottom of the stack first) and folds the rest into one "Other" series, so the legend
 * stays readable in a side panel — the CLI emits up to ~90 model series for the monthly view.
 */
export function topSeries(datasets, length, { limit = TOP_SERIES, digits = 0 } = {}) {
    if (!Array.isArray(datasets)) return [];
    const isOther = (s) => /^other$/i.test(s.label);
    const series = datasets
        .map((d) => {
            const data = Array.from({ length }, (_, i) => round(num(d?.data?.[i]), digits));
            return { label: String(d?.label ?? ""), data, total: data.reduce((a, b) => a + b, 0) };
        })
        .filter((s) => s.label && s.total > 0);
    const ranked = series.filter((s) => !isOther(s)).sort((a, b) => b.total - a.total);
    const rest = [...ranked.slice(limit), ...series.filter(isOther)];
    const kept = ranked.slice(0, limit).map(({ label, data }) => ({ label, data }));
    if (rest.length === 1) kept.push({ label: rest[0].label, data: rest[0].data, ...(isOther(rest[0]) && { other: true }) });
    else if (rest.length > 1) {
        const data = Array.from({ length }, (_, i) => round(rest.reduce((a, s) => a + s.data[i], 0), digits));
        kept.push({ label: `Other (${rest.length})`, data, other: true });
    }
    return kept;
}

function trimChartPeriod(period) {
    const labels = Array.isArray(period?.labels) ? period.labels.map(String) : [];
    if (!labels.length) return null;
    const series = (values, digits = 0) => (Array.isArray(values) ? labels.map((_, i) => round(num(values[i]), digits)) : null);
    const splits = {};
    for (const [metric, sources] of Object.entries(SPLIT_SOURCES)) {
        splits[metric] = {};
        for (const [split, key] of Object.entries(sources)) {
            const kept = topSeries(period[key], labels.length, { digits: metric === "cost" ? 4 : 0 });
            if (kept.length) splits[metric][split] = kept;
        }
    }
    return {
        labels,
        tokens: series(period.tokensData) ?? labels.map(() => 0),
        sessions: series(period.sessionsData) ?? labels.map(() => 0),
        cost: series(period.costData, 4),
        splits,
    };
}

/** Day / week / month aggregations for the Chart view. Older CLIs only send the flat daily fields. */
function trimCharts(chart = {}) {
    const periods = chart.periods ?? {};
    return {
        day: trimChartPeriod({ ...chart, ...periods.day }),
        week: trimChartPeriod(periods.week),
        month: trimChartPeriod(periods.month),
    };
}

function trimFluency(fluency = {}) {
    if (!Array.isArray(fluency.categories)) return null;
    return {
        overallStage: num(fluency.overallStage),
        overallLabel: String(fluency.overallLabel ?? ""),
        categories: fluency.categories.map((c) => ({
            category: String(c.category ?? ""),
            icon: String(c.icon ?? ""),
            stage: num(c.stage),
            evidence: Array.isArray(c.evidence) ? c.evidence.map(String) : [],
            tips: Array.isArray(c.tips) ? c.tips.map(String) : [],
        })),
    };
}

function yamlValue(text, key) {
    // `[ \t]*`, not `\s*`: an empty value must not run on into the next line (`name:\ncwd: …` is not a title).
    const match = text.match(new RegExp(`^${key}:[ \\t]*(.+)$`, "m"));
    if (!match) return null;
    return match[1].trim().replace(/^(['"])(.*)\1$/, "$2") || null;
}

/** Session names are often the first prompt: strip markdown/escapes and cap the length. */
export function cleanLabel(value) {
    if (!value) return null;
    const text = String(value)
        .replace(/\\[nrt]/g, " ")
        .replace(/\*\*|__|`/g, "")
        .replace(/^#+\s*/, "")
        .replace(/\s+/g, " ")
        .trim();
    if (!text) return null;
    return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

/**
 * Last segment of a path recorded in session metadata. Unlike `path.basename`,
 * this splits on both `\` and `/`, because the recorded path may come from a
 * different OS than the one running the canvas.
 */
function lastSegment(path) {
    return String(path).replace(/[\\/]+$/, "").split(/[\\/]/).pop() || null;
}

function projectFromCwd(cwd) {
    if (!cwd) return null;
    const worktree = cwd.match(/copilot-worktrees[\\/]([^\\/]+)/i);
    return worktree ? worktree[1] : lastSegment(cwd);
}

function readJson(path) {
    return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * The CLI does not return session titles, so derive a readable label and
 * project from the session's on-disk location. Only small metadata files next
 * to the session are read — never the session transcript itself.
 */
export function describeSession(filePath = "") {
    try {
        const copilotCli = filePath.match(/^(.*[\\/]session-state[\\/][0-9a-f-]{36})[\\/]events\.jsonl$/i);
        if (copilotCli) {
            const yamlPath = join(copilotCli[1], "workspace.yaml");
            if (existsSync(yamlPath)) {
                const yaml = readFileSync(yamlPath, "utf8");
                return { label: cleanLabel(yamlValue(yaml, "name") ?? yamlValue(yaml, "summary")), project: projectFromCwd(yamlValue(yaml, "cwd")) };
            }
        }
        const vscode = filePath.match(/^(.*[\\/]workspaceStorage[\\/][^\\/]+)[\\/]chatSessions[\\/]/i);
        if (vscode) {
            const workspaceJson = join(vscode[1], "workspace.json");
            if (existsSync(workspaceJson)) {
                const { folder, workspace } = readJson(workspaceJson);
                const uri = decodeURIComponent(String(folder ?? workspace ?? ""));
                return { label: null, project: lastSegment(uri)?.replace(/\.code-workspace$/, "") || null };
            }
        }
        const folder = basename(dirname(filePath));
        const claudeWorktree = folder.match(/^(?:[A-Za-z]--Users-[^-]+-)?(.*?)-+claude-worktrees-(.+)$/);
        if (claudeWorktree) {
            return { label: claudeWorktree[2].replace(/-[0-9a-f]{6}$/, ""), project: claudeWorktree[1].replace(/^code-repos-/, "") || null };
        }
        if (/[\\/]\.claude[\\/]projects[\\/]/i.test(filePath)) {
            return { label: null, project: folder.replace(/^[A-Za-z]--Users-[^-]+-/, "").replace(/^code-repos-/, "") || null };
        }
    } catch {
        // metadata is best-effort
    }
    return { label: null, project: null };
}

function shortId(filePath = "") {
    const afterHash = filePath.includes("#") ? filePath.slice(filePath.lastIndexOf("#") + 1) : null;
    if (afterHash) return afterHash.replace(/^ses_/, "").slice(0, 8);
    const file = basename(filePath).replace(/\.[^.]+$/, "");
    const id = ["events", "meta"].includes(file) ? basename(dirname(filePath)) : file;
    return id.replace(/^session_\d+_\d+_/, "").slice(0, 8);
}

function trimSessions(usage = {}, describe) {
    const recent = usage.recentSessions ?? {};
    // Not `currentMonth`: early in a month it reaches back past the 30-day window, and this list is the Sessions tab's scope.
    const all = [...(recent.last30 ?? []), ...(recent.last7 ?? []), ...(usage.todaySessions ?? [])];
    const byPath = new Map();
    for (const session of all) {
        if (!session?.filePath || byPath.has(session.filePath)) continue;
        byPath.set(session.filePath, session);
    }
    return [...byPath.values()]
        .map((s) => {
            const { label, project } = describe(s.filePath);
            return {
                id: createHash("sha1").update(s.filePath).digest("hex").slice(0, 12),
                shortId: shortId(s.filePath),
                label: cleanLabel(typeof s.title === "string" && s.title ? s.title : label),
                project,
                editor: String(s.editor ?? "Unknown"),
                models: Array.isArray(s.models) ? s.models.map(String) : [],
                interactions: num(s.interactions),
                toolCalls: num(s.toolCalls),
                totalTokens: num(s.totalTokens),
                inputTokens: num(s.inputTokens),
                outputTokens: num(s.outputTokens),
                cachedTokens: num(s.cachedTokens),
                thinkingTokens: num(s.thinkingTokens),
                estimatedCost: num(s.estimatedCost),
                activeDurationMs: num(s.activeDurationMs),
                lastActivity: s.lastActivity ?? null,
            };
        })
        .sort((a, b) => String(b.lastActivity).localeCompare(String(a.lastActivity)));
}

/** Reduce the ~700 KB `all --json` payload to what the canvas renders. */
export function buildSnapshot(payload, { fetchedAt = new Date().toISOString(), durationMs = 0, cli = null, describe = describeSession } = {}) {
    const details = payload.details ?? {};
    return {
        schemaVersion: SCHEMA_VERSION,
        fetchedAt,
        durationMs,
        cliVersion: cli?.version ?? null,
        cliSource: cli?.source ?? null,
        periods: Object.fromEntries(PERIODS.map((p) => [p, trimPeriod(details[p])])),
        charts: trimCharts(payload.chart),
        sessions: trimSessions(payload.usage, describe),
        fluency: trimFluency(payload.fluency),
    };
}

export function snapshotPath(dir = artifactsDir()) {
    return join(dir, "snapshot.json");
}

/**
 * Reads the snapshot. `missing` is true only when the file does not exist (for example after `artifacts/` was deleted
 * to reset the canvas); a file that cannot be read or parsed gives `{ snapshot: null, missing: false }`, so callers can
 * keep the last good copy instead of forgetting it.
 */
export async function readSnapshotFile(dir = artifactsDir()) {
    let text;
    try {
        text = await readFile(snapshotPath(dir), "utf8");
    } catch (error) {
        return { snapshot: null, missing: error.code === "ENOENT" };
    }
    try {
        const snapshot = JSON.parse(text);
        return { snapshot: snapshot?.schemaVersion === SCHEMA_VERSION ? snapshot : null, missing: false };
    } catch {
        return { snapshot: null, missing: false };
    }
}

export async function readSnapshot(dir = artifactsDir()) {
    return (await readSnapshotFile(dir)).snapshot;
}

/**
 * Like `readSnapshotFile`, but only after making sure the folder and snapshot are private (`ensurePrivateDir`). When
 * that fails the file is not read at all and `unsafe` holds the reason, so the canvas never shows or summarizes a
 * snapshot that other users may be able to read.
 */
export async function readPrivateSnapshotFile(dir = artifactsDir()) {
    try {
        await ensurePrivateDir(dir);
    } catch (error) {
        const unsafe =
            `The stats folder can't be made private to your user account, so the canvas won't use it (${error.message}). ` +
            `Make ${dir} and the snapshot.json in it yours and readable only by you, or delete the folder.`;
        return { snapshot: null, missing: false, unsafe };
    }
    return readSnapshotFile(dir);
}

export async function writeSnapshot(snapshot, dir = artifactsDir()) {
    await ensurePrivateDir(dir);
    const target = snapshotPath(dir);
    // Unique name + exclusive create, so a leftover or planted file is never reused; rename keeps the owner-only mode.
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
        await writeFile(temp, JSON.stringify(snapshot), { encoding: "utf8", flag: "wx", mode: PRIVATE_FILE_MODE });
        await rename(temp, target);
    } catch (error) {
        await unlink(temp).catch(() => {});
        throw error;
    }
}

const round = (value, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;

/**
 * Start (local midnight) of an N-day window that includes today, as a timestamp. Same rule as the CLI's
 * `getTimeWindowStartDate` (src/timeWindows.ts): calendar days, not a rolling 24-hour count, so DST shifts don't matter.
 */
export function windowStart(days, now = new Date()) {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() - days + 1).getTime();
}

/**
 * Compact, agent-friendly view of a snapshot. Whatever this returns is sent to the model as a tool result, so session
 * titles and project names are only included when the caller asks for them (`topSessions` > 0).
 */
export function summarize(snapshot, { topSessions = 0, now = new Date() } = {}) {
    if (!snapshot) return { available: false, message: "No snapshot yet — a refresh is needed (it takes several minutes)." };
    const period = (p) => ({
        tokens: p.tokens,
        sessions: p.sessions,
        estimatedApiCostUsd: round(p.estimatedCost),
        copilotCreditsUsd: round(p.estimatedCostCopilot),
        avgTokensPerSession: Math.round(p.avgTokensPerSession),
        co2Grams: round(p.co2),
        waterLiters: round(p.waterUsage, 3),
        topModels: p.models.slice(0, 5).map((m) => ({ name: m.name, tokens: m.tokens })),
        editors: p.editors.map((e) => ({ name: e.name, tokens: e.tokens, sessions: e.sessions })),
    });
    const since = windowStart(7, now);
    const lastWeek = snapshot.sessions.filter((s) => Date.parse(s.lastActivity) >= since);
    return {
        available: true,
        fetchedAt: snapshot.fetchedAt,
        cliVersion: snapshot.cliVersion,
        periods: Object.fromEntries(PERIODS.map((p) => [p, period(snapshot.periods[p])])),
        fluency: snapshot.fluency && {
            overall: snapshot.fluency.overallLabel,
            categories: snapshot.fluency.categories.map((c) => ({ category: c.category, stage: c.stage, tips: c.tips })),
        },
        topSessionsLast7Days: [...lastWeek]
            .sort((a, b) => b.totalTokens - a.totalTokens)
            .slice(0, topSessions)
            .map((s) => ({
                label: s.label ?? `${s.editor} ${s.shortId}`,
                project: s.project,
                editor: s.editor,
                models: s.models,
                tokens: s.totalTokens,
                estimatedApiCostUsd: round(s.estimatedCost),
                interactions: s.interactions,
                lastActivity: s.lastActivity,
            })),
    };
}
