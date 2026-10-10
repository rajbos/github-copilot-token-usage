import { app, BrowserWindow, Tray, Menu, clipboard, ipcMain, nativeTheme, protocol, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { randomBytes } from 'crypto';
import { checkForUpdates, getUpdateState, installUpdate, startUpdateChecks } from './updater';
import {
    discoverSessionFiles,
    effectiveTokens,
    calculateDetailedStats,
    calculateDailyStats,
    calculateUsageAnalysisStats,
    buildChartPayload,
    getDiagnosticPaths,
    getSessionBackingPath,
    getSessionLastActivity,
    getSessionMeta,
    processSessionFile,
    loadCache,
    saveCache,
} from '../../cli/src/helpers';
import { getEditorSourceFromPath, runWithConcurrency } from '../../cli/src/analysis';
import type { DetailedStats, UsageAnalysisStats } from '../../src/types';
import { getEnvironmentalMethodologySourceUrl } from '../../src/environmentalImpact';
import { createEmptyContextRefs } from '../../src/tokenEstimation';
import { toLocalDayKey } from '../../src/utils/dayKeys';
import {
    calculateMaturityScores,
    getFluencyLevelData,
} from '../../src/maturityScoring';
import { getToolFamilies } from '../../vscode-extension/src/toolFamilies';
import {
    getLoadingHtmlCssBase,
    getLoadingHtmlCssSteps,
    getLoadingHtmlBody,
} from '../../vscode-extension/src/loadingHtml';
import { detectEditorSource } from '../../src/workspaceHelpers';
import { getEditorIconByName } from '../../vscode-extension/src/editorIcons';
import { buildWebviewLocalization } from '../../vscode-extension/src/webviewLocalization';
import { createTranslator, resolvedLocale } from '../../vscode-extension/src/l10nCore';

// JSON config data embedded into every panel HTML (mirrors extension's getJsonConfigScript)
import tokenEstimatorsData from '../../src/tokenEstimators.json';
import modelPricingData from '../../src/modelPricing.json';
import toolNamesData from '../../src/toolNames.json';
import automaticToolsData from '../../src/automaticTools.json';

// In dev mode use a local userData directory so cache files never conflict
// between hot-reload restarts (the default %APPDATA%\Electron is shared with
// all Electron dev apps and gets locked by the dying old process).
if (!app.isPackaged) {
    app.setPath('userData', path.join(__dirname, '..', '.dev-profile'));
}

// Register the app:// scheme as privileged BEFORE app is ready
protocol.registerSchemesAsPrivileged([
    {
        scheme: 'app',
        privileges: { secure: true, standard: true, supportFetchAPI: true, corsEnabled: false },
    },
]);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

type PanelId = 'details' | 'environmental' | 'chart' | 'usage' | 'diagnostics' | 'maturity' | 'fluency-level-viewer';

// Mirrors build.appId in package.json. Used as the Windows AppUserModelID so the
// OS associates the taskbar button (and its icon) with this app rather than the
// generic electron.exe identity it would otherwise inherit when run unpackaged.
const APP_ID = 'com.rajbos.ai-engineering-fluency';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let currentPanel: PanelId = 'details';
let cachedStats: DetailedStats | null = null;
let cachedSessionFiles: string[] | null = null;
let cachedUsageStats: UsageAnalysisStats | null = null;
let cachedChartPayload: object | null = null;
// Local day the cached stats, usage and chart data were computed for. All three
// have "today" / "this month" windows baked in, so a tray app left running
// overnight must rebuild them rather than keep showing yesterday as today.
let cachedDataDay = '';
let isRefreshing = false;
// Bumped whenever a refresh replaces the session-file list. A computation that
// started against an older list must not cache its result over the newer data.
let dataGeneration = 0;

// ---------------------------------------------------------------------------
// Static asset path
// ---------------------------------------------------------------------------

/** Directory from which the IIFE webview bundles are served. */
function getWebviewDir(): string {
    return path.join(__dirname, 'webview');
}

/** Resolve the app icon, preferring the dist-bundled icon then falling back to source assets. */
function resolveAppIcon(): string {
    const candidates = [
        // Bundled into dist/ by esbuild — the only path that exists in a packaged build.
        path.join(__dirname, 'tray-icon.png'),
        // Dev fallbacks: the generated source asset, then the extension's robot icon.
        path.join(__dirname, '..', 'assets', 'tray-icon.png'),
        path.join(__dirname, '..', '..', 'vscode-extension', 'media', 'robot-icon.png'),
    ];
    return candidates.find(fs.existsSync) ?? candidates[candidates.length - 1];
}

// ---------------------------------------------------------------------------
// VS Code CSS variable seed
// Provides concrete values for --vscode-* custom properties so the existing
// webview IIFE bundles render correctly outside of VS Code.
// ---------------------------------------------------------------------------

const VSCODE_DARK_VARS = `
:root {
    --vscode-editor-background: #1e1e1e;
    --vscode-sideBar-background: #252526;
    --vscode-editorWidget-background: #252526;
    --vscode-editor-foreground: #d4d4d4;
    --vscode-descriptionForeground: #9d9d9d;
    --vscode-disabledForeground: #585858;
    --vscode-panel-border: #454545;
    --vscode-widget-border: #454545;
    --vscode-button-background: #0e639c;
    --vscode-button-foreground: #ffffff;
    --vscode-button-hoverBackground: #1177bb;
    --vscode-button-secondaryBackground: #3a3d41;
    --vscode-button-secondaryForeground: #cccccc;
    --vscode-button-secondaryHoverBackground: #45494e;
    --vscode-input-background: #3c3c3c;
    --vscode-input-foreground: #cccccc;
    --vscode-input-border: #3c3c3c;
    --vscode-list-hoverBackground: #2a2d2e;
    --vscode-list-activeSelectionBackground: #094771;
    --vscode-list-activeSelectionForeground: #ffffff;
    --vscode-list-inactiveSelectionBackground: #37373d;
    --vscode-badge-background: #4d4d4d;
    --vscode-badge-foreground: #cccccc;
    --vscode-focusBorder: #007fd4;
    --vscode-textLink-foreground: #3794ff;
    --vscode-textLink-activeForeground: #3794ff;
    --vscode-errorForeground: #f48771;
    --vscode-editorWarning-foreground: #cca700;
    --vscode-terminal-ansiGreen: #4ec94c;
    --vscode-contrastBorder: #6fc3df;
    --vscode-foreground: #cccccc;
    --vscode-editor-font-family: Consolas, 'Courier New', monospace;
    --vscode-button-border: transparent;
    --vscode-dropdown-background: #313131;
    --vscode-dropdown-foreground: #cccccc;
    --vscode-dropdown-border: #3c3c3c;
    --vscode-textBlockQuote-background: #2b2b2b;
    --vscode-editorInfo-foreground: #3794ff;
    --vscode-inputValidation-infoBackground: #063b49;
    --vscode-inputValidation-infoBorder: #1a85ff;
    --vscode-inputValidation-warningBackground: #352a05;
    --vscode-inputValidation-warningBorder: #b89500;
    --vscode-inputValidation-errorBackground: #5a1d1d;
    --vscode-inputValidation-errorBorder: #be1100;
    --vscode-charts-blue: #4daafc;
    --vscode-charts-green: #89d185;
    --vscode-charts-orange: #d18616;
    --vscode-charts-purple: #b180d7;
    --vscode-charts-red: #f14c4c;
    --vscode-charts-yellow: #cca700;
    --vscode-terminal-ansiCyan: #11a8cd;
}
`;

const VSCODE_LIGHT_VARS = `
@media (prefers-color-scheme: light) {
    :root {
        --vscode-editor-background: #ffffff;
        --vscode-sideBar-background: #f3f3f3;
        --vscode-editorWidget-background: #f3f3f3;
        --vscode-editor-foreground: #000000;
        --vscode-descriptionForeground: #717171;
        --vscode-disabledForeground: #717171;
        --vscode-panel-border: #e7e7e7;
        --vscode-widget-border: #c8c8c8;
        --vscode-button-background: #007acc;
        --vscode-button-foreground: #ffffff;
        --vscode-button-hoverBackground: #0062a3;
        --vscode-button-secondaryBackground: #5f6a79;
        --vscode-button-secondaryForeground: #ffffff;
        --vscode-button-secondaryHoverBackground: #4c5561;
        --vscode-input-background: #ffffff;
        --vscode-input-foreground: #616161;
        --vscode-input-border: #cecece;
        --vscode-list-hoverBackground: #e8e8e8;
        --vscode-list-activeSelectionBackground: #0060c0;
        --vscode-list-activeSelectionForeground: #ffffff;
        --vscode-list-inactiveSelectionBackground: #e4e6f1;
        --vscode-badge-background: #c4c4c4;
        --vscode-badge-foreground: #333333;
        --vscode-focusBorder: #0090f1;
        --vscode-textLink-foreground: #006ab1;
        --vscode-textLink-activeForeground: #006ab1;
        --vscode-errorForeground: #a1260d;
        --vscode-editorWarning-foreground: #b89500;
        --vscode-terminal-ansiGreen: #00bc00;
        --vscode-contrastBorder: #6fc3df;
        --vscode-foreground: #3b3b3b;
        --vscode-dropdown-background: #ffffff;
        --vscode-dropdown-foreground: #3b3b3b;
        --vscode-dropdown-border: #cecece;
        --vscode-textBlockQuote-background: #f8f8f8;
        --vscode-editorInfo-foreground: #1a85ff;
        --vscode-inputValidation-infoBackground: #d6ecf2;
        --vscode-inputValidation-infoBorder: #007acc;
        --vscode-inputValidation-warningBackground: #f6f5d2;
        --vscode-inputValidation-warningBorder: #b89500;
        --vscode-inputValidation-errorBackground: #f2dede;
        --vscode-inputValidation-errorBorder: #be1100;
        --vscode-charts-blue: #1a85ff;
        --vscode-charts-green: #388a34;
        --vscode-charts-purple: #652d90;
        --vscode-charts-red: #e51400;
        --vscode-charts-yellow: #bf8803;
        --vscode-terminal-ansiCyan: #0598bc;
    }
}
`;

const BASE_BODY_STYLE = `
body {
    margin: 0;
    padding: 0;
    background-color: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 13px;
}
/* Controls the desktop app cannot act on yet. They are rendered by the shared
   webview bundles, so the only host-side way to avoid a dead control is to hide
   it. Remove a selector here when its message gets a handler in registerIpcHandlers. */
#btn-efficiency,
/* Diagnostics: formatted-file viewer, editor-path reporting, GitHub sign-in,
   backend/team-server setup, VS Code settings, folder analysis, cache reset,
   social sharing. */
.view-formatted-link,
.report-editor-link,
#btn-authenticate-github,
#btn-sign-out-github,
#btn-team-server-auth-warning,
#btn-configure-backend,
#btn-configure-backend-team,
#btn-open-settings,
#btn-open-display-settings,
#btn-open-tool-families-settings,
#btn-browse-folder,
#btn-analyze-folder,
#btn-clear-cache,
#btn-clear-cache-tab,
#btn-reset-insights,
#btn-reset-insights-tab,
#btn-reset-discovered-editors,
#btn-reset-debug-counters,
.share-btn { display: none !important; }
`;

// ---------------------------------------------------------------------------
// Stats loading
// ---------------------------------------------------------------------------

// Computations currently running, by name. These walk the whole session history,
// so a second caller (opening Chart while startup is still pre-warming it, or
// reloading a view) must join the run in progress instead of starting another.
const inFlight = new Map<string, Promise<unknown>>();

function shareInFlight<T>(name: string, run: () => Promise<T>): Promise<T> {
    // Keyed by data generation as well as name: a reader that starts after a
    // refresh has committed must not join a promise from before it, which may
    // already hold the old result and be waiting only for its cleanup to run.
    const key = `${name}:${dataGeneration}`;
    const running = inFlight.get(key) as Promise<T> | undefined;
    if (running) { return running; }
    const started = run().finally(() => { inFlight.delete(key); });
    inFlight.set(key, started);
    return started;
}

async function getSessionFiles(): Promise<string[]> {
    // Read the committed list first. Joining an in-flight discovery when a list
    // is already cached could hand back the list that promise was started for,
    // which a refresh may have replaced since.
    if (cachedSessionFiles) { return cachedSessionFiles; }
    return shareInFlight('sessionFiles', loadSessionFiles);
}

async function loadSessionFiles(): Promise<string[]> {
    while (!cachedSessionFiles) {
        const generation = dataGeneration;
        const files = await discoverSessionFiles();
        // A refresh that landed meanwhile already stored a newer list; keep that one.
        if (generation === dataGeneration && !cachedSessionFiles) { cachedSessionFiles = files; }
    }
    return cachedSessionFiles;
}

/**
 * Runs `compute` over the current session files and hands the result to `commit`,
 * retrying if a refresh replaced the file list while it was running.
 *
 * The generation check and `commit` run in the same synchronous step on purpose:
 * returning the result for the caller to cache would resume the caller a tick
 * later, and a refresh landing in that gap would have its newer data overwritten
 * by this older result.
 */
async function computeForCurrentFiles<T>(compute: (files: string[]) => Promise<T>, commit: (result: T) => void): Promise<void> {
    for (;;) {
        const generation = dataGeneration;
        const files = await getSessionFiles();
        // The list itself must be the committed one, not just the generation:
        // a refresh can commit while the list was being awaited.
        if (files !== cachedSessionFiles) { continue; }
        const result = await compute(files);
        if (generation === dataGeneration && files === cachedSessionFiles) {
            commit(result);
            return;
        }
    }
}

/** Post a progress message to the loading screen (bridged to window messages by the preload). */
function sendLoadingMessage(message: Record<string, unknown>): void {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('loading-message', message);
    }
}

/** Editor display name for a session path: the CLI's detector, then the shared path detector. */
function sessionEditorName(file: string): string {
    const editor = getEditorSourceFromPath(file);
    if (editor && editor !== 'Unknown') { return editor; }
    return detectEditorSource(file) || 'Unknown';
}

/**
 * Map discovered session file paths to the editor pills shown by the loading
 * screen. Uses the CLI's detector first — the same labels that end up in the
 * desktop's stats tables — and falls back to the shared path detector for
 * editors the CLI mapping doesn't cover (e.g. Pi).
 */
function detectLoadingEditors(files: string[]): { icon: string; name: string }[] {
    const editorSet = new Set<string>();
    for (const file of files) {
        const editor = sessionEditorName(file);
        if (editor !== 'Unknown') { editorSet.add(editor); }
    }
    return [...editorSet].map(name => ({ icon: getEditorIconByName(name), name }));
}

/**
 * Drives the shared loading screen while session files are parsed. Mirrors the
 * extension's buildProgressCallback: a one-time 'parsing' step transition, then
 * progress ticks throttled to 500ms, then 'computing' once parsing finishes.
 * Editors ride along on every message so the pills pop in as parsing advances.
 */
function buildLoadingProgressCallback(editors: { icon: string; name: string }[]): (completed: number, total: number) => void {
    let parsingNotified = false;
    let lastSentMs = 0;
    return (completed, total) => {
        if (!parsingNotified) {
            parsingNotified = true;
            sendLoadingMessage({ command: 'loadingStep', step: 'parsing', total, editors });
        }
        const now = Date.now();
        if (now - lastSentMs >= 500 || completed === total) {
            lastSentMs = now;
            const percentage = Math.round((completed / total) * 100);
            sendLoadingMessage({ command: 'loadingProgress', completed, total, percentage, editors });
        }
        if (completed === total) {
            sendLoadingMessage({ command: 'loadingStep', step: 'computing' });
        }
    };
}

function getStats(): Promise<DetailedStats> {
    return shareInFlight('stats', loadStats);
}

async function loadStats(): Promise<DetailedStats> {
    expireCachesOnDateChange();
    while (!cachedStats) {
        sendLoadingMessage({ command: 'loadingStep', step: 'discovering' });
        await computeForCurrentFiles(
            files => calculateDetailedStats(files, buildLoadingProgressCallback(detectLoadingEditors(files))),
            // A refresh may have stored fresher stats while this ran; prefer those.
            (stats) => { cachedStats ??= stats; },
        );
    }
    return cachedStats;
}

function getUsageStats(): Promise<UsageAnalysisStats> {
    return shareInFlight('usage', loadUsageStats);
}

async function loadUsageStats(): Promise<UsageAnalysisStats> {
    expireCachesOnDateChange();
    // Loops because a refresh can clear the cache again between the commit and
    // this function resuming; the next pass then computes against the new data.
    while (!cachedUsageStats) {
        await computeForCurrentFiles(
            files => calculateUsageAnalysisStats(files),
            (usageStats) => { cachedUsageStats ??= usageStats; },
        );
    }
    return cachedUsageStats;
}

/**
 * Chart payload, computed once and reused. Building it walks every session file,
 * which on a large history blocks the main process for a long time — doing that
 * on every open of the Chart view left the window black until it finished.
 */
function getChartPayload(): Promise<object> {
    return shareInFlight('chart', loadChartPayload);
}

async function loadChartPayload(): Promise<object> {
    expireCachesOnDateChange();
    while (!cachedChartPayload) {
        await computeForCurrentFiles(
            async (files) => {
                const { labels, days, allDaysMap } = await calculateDailyStats(files);
                return buildChartPayload(labels, days, allDaysMap);
            },
            (payload) => { cachedChartPayload ??= payload; },
        );
    }
    return cachedChartPayload;
}

/** Whether a panel can render straight away, i.e. without a long computation first. */
/**
 * Drops the day-scoped caches when the local date has changed since they were
 * built. Called before every read, so the next getter recomputes.
 */
function expireCachesOnDateChange(): void {
    const today = toLocalDayKey(new Date());
    if (cachedDataDay === today) { return; }
    if (cachedDataDay !== '') {
        cachedStats = null;
        cachedUsageStats = null;
        cachedChartPayload = null;
        // A calculation that started yesterday must not cache yesterday's
        // totals under today's day: make its generation check fail so it retries.
        dataGeneration++;
    }
    cachedDataDay = today;
}

function isPanelDataReady(panel: PanelId): boolean {
    expireCachesOnDateChange();
    switch (panel) {
        case 'details':
        case 'environmental':
            return cachedStats !== null;
        case 'chart':
            return cachedChartPayload !== null;
        case 'usage':
        case 'maturity':
            return cachedUsageStats !== null;
        case 'diagnostics':
            return cachedSessionFiles !== null;
        default:
            return true;
    }
}

/** Runs the computation a panel depends on, so the panel request itself returns quickly. */
async function loadPanelData(panel: PanelId): Promise<void> {
    switch (panel) {
        case 'details':
        case 'environmental':
            await getStats();
            break;
        case 'chart':
            await getChartPayload();
            break;
        case 'usage':
        case 'maturity':
            await getUsageStats();
            break;
        case 'diagnostics':
            await getSessionFiles();
            break;
        default:
            break;
    }
}

async function refreshStats(): Promise<void> {
    if (isRefreshing) { return; }
    isRefreshing = true;
    try {
        const files = await discoverSessionFiles();
        const stats = await calculateDetailedStats(files);
        // Swap everything in one synchronous step, so no reader can pair the new
        // file list with stats, usage or chart data computed from the old one.
        dataGeneration++;
        cachedSessionFiles = files;
        cachedStats = stats;
        // The day these stats describe is the one their period boundaries were
        // built from, not the day the refresh finished — they can differ when a
        // refresh spans midnight, and the next read must then expire them.
        cachedDataDay = toLocalDayKey(stats.lastUpdated);
        cachedUsageStats = null; // reset so it recomputes on next access
        cachedChartPayload = null;
        await saveCache();
    } finally {
        isRefreshing = false;
    }
}

// ---------------------------------------------------------------------------
// HTML generation (mirrors VS Code extension's getDetailsHtml / getEnvironmentalHtml)
// ---------------------------------------------------------------------------

const JSON_CONFIG_SCRIPT = [
    `window.__TOKEN_ESTIMATORS__=${JSON.stringify(tokenEstimatorsData).replace(/</g, '\\u003c')};`,
    `window.__MODEL_PRICING__=${JSON.stringify(modelPricingData).replace(/</g, '\\u003c')};`,
    `window.__TOOL_NAMES__=${JSON.stringify(toolNamesData).replace(/</g, '\\u003c')};`,
    `window.__AUTOMATIC_TOOLS__=${JSON.stringify(automaticToolsData).replace(/</g, '\\u003c')};`,
    `window.__EXTENSION_POINT_BUTTONS__=[];`,
].join('');

/**
 * The localization dictionary and resolved locale for this app's webviews.
 *
 * The desktop app reuses the VS Code extension's webview bundles verbatim, and
 * those bundles only localize themselves if the host puts this dictionary in
 * the panel's initial payload. It did not, so every panel rendered the bundles'
 * built-in English fallback regardless of the user's system language — silently,
 * because each bundle guards with `if (initialData?.localization)` and simply
 * skips initialization when it is absent.
 *
 * Resolved once: `app.getLocale()` does not change while the app is running,
 * and rebuilding 147 strings per panel open would be wasted work.
 */
let cachedWebviewLocalization: Record<string, string> | undefined;
function desktopWebviewLocalization(): Record<string, string> {
    if (!cachedWebviewLocalization) {
        const language = app.getLocale();
        cachedWebviewLocalization = {
            ...buildWebviewLocalization(createTranslator(language)),
            '__language__': language,
        };
    }
    return cachedWebviewLocalization;
}

/**
 * Serializes a panel's initial payload into its `window.__INITIAL_*__` script.
 *
 * Every payload goes through here so the localization dictionary cannot be
 * omitted from one of them — which is exactly how the desktop app came to ship
 * seven panels that were all unlocalizable. It also centralizes the `<`
 * escaping that each call site previously repeated.
 */
function panelPayloadScript(windowKey: string, data: object): string {
    const payload = {
        ...data,
        localization: desktopWebviewLocalization(),
        // Display language — which strings. Separate from `locale` below, which
        // some panels set for number/date formatting: a German user on an English
        // system wants 1.234,56 with English UI.
        language: resolvedLocale(app.getLocale()),
    };
    return `window.${windowKey}=${JSON.stringify(payload).replace(/</g, '\\u003c')};`;
}

/** Plain-text diagnostic report, shown in the Diagnostics view and copied by "Copy report". */
function buildDiagnosticReport(sessionFileCount: number): string {
    return `AI Engineering Fluency — Desktop Diagnostic Report\n${'='.repeat(50)}\n\nVersion: ${app.getVersion()}\nSession files found: ${sessionFileCount}\nTimestamp: ${new Date().toISOString()}`;
}

/** Same bounds the extension applies to the Diagnostics session table. */
const DIAGNOSTICS_SESSION_DAYS = 14;
const DIAGNOSTICS_SESSION_LIMIT = 500;

/**
 * Rows for the Diagnostics session table: the newest sessions of the last two
 * weeks, with the token and interaction counts the CLI's session parser
 * produces. The parser result is cached from the startup stats walk, so this is
 * cheap. The table reads every field here while rendering — a missing
 * `contextReferences` throws and leaves the whole panel blank — so the fields
 * the desktop cannot fill are set to their explicit "unknown" values, not left out.
 */
async function buildDetailedSessionFiles(sessionFiles: { file: string; size: number; modified: string }[]) {
    const cutoff = Date.now() - DIAGNOSTICS_SESSION_DAYS * 24 * 60 * 60 * 1000;
    // `modified` is the backing file's mtime. It is only a pre-filter that keeps
    // per-session parsing bounded on large histories; the real filter below uses
    // each session's own last activity. Virtual (DB-backed) sessions skip it:
    // SQLite can hold recent writes in its WAL while the .db file's mtime stays
    // old, so the mtime says nothing about a session's recency.
    // Stage 1 — pick the newest sessions from cheap signals only: the file's
    // mtime, or for virtual (DB-backed) sessions the adapter's single-row
    // last-activity lookup, since the database mtime says nothing about one
    // session. A virtual session whose adapter cannot answer falls back to the
    // full metadata read rather than to the mtime, so it is never dropped
    // unseen. Nothing is parsed here: only the path and the timestamp are needed.
    const preselected = await runWithConcurrency(sessionFiles, async (f) => {
        const virtual = getSessionBackingPath(f.file) !== f.file;
        let activity = f.modified;
        if (virtual) {
            const last = await getSessionLastActivity(f.file)
                ?? await getSessionMeta(f.file).then(m => (m?.lastInteraction ? new Date(m.lastInteraction) : null));
            if (!last) { return undefined; }
            activity = last.toISOString();
        }
        if (Date.parse(activity) < cutoff) { return undefined; }
        return { f, activity };
    });
    const selected = preselected
        .filter((p): p is NonNullable<typeof p> => p !== undefined)
        .sort((a, b) => b.activity.localeCompare(a.activity))
        .slice(0, DIAGNOSTICS_SESSION_LIMIT);
    // Stage 2 — parse and read adapter metadata (title, exact interaction
    // times) for the selected rows only. Both can read a session's messages,
    // so this is the expensive part and runs with bounded concurrency.
    const rows = await runWithConcurrency(selected, async ({ f }) => {
        const [data, meta] = await Promise.all([
            processSessionFile(f.file).catch(() => null),
            getSessionMeta(f.file),
        ]);
        const modelUsage: { [model: string]: { inputTokens: number; outputTokens: number } } = {};
        for (const [model, usage] of Object.entries(data?.modelUsage ?? {})) {
            modelUsage[model] = { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
        }
        const lastInteraction = meta?.lastInteraction ?? (data ? data.lastModified.toISOString() : null);
        return {
            ...f,
            interactions: data?.interactions ?? 0,
            // Same choice the stats make: the actual count when the session has one.
            tokens: data ? effectiveTokens(data) : undefined,
            modelUsage,
            // Adapters that know the session title provide it; otherwise name an
            // active session after its file so it is not labelled "(Empty session)".
            title: meta?.title || (data && data.interactions > 0 ? path.basename(f.file) : undefined),
            // The adapter's own repository id when it records one (Copilot CLI does),
            // else the workspace directory the view derives a name from.
            repository: meta?.repository ?? meta?.workspacePath,
            // Context references are not tracked by the CLI parser: zero, not guessed.
            contextReferences: createEmptyContextRefs(),
            firstInteraction: meta?.firstInteraction ?? null,
            lastInteraction,
            editorSource: data?.editorSource || sessionEditorName(f.file),
        };
    }, 8);
    return rows
        .filter((r): r is NonNullable<typeof r> => r !== undefined)
        .filter(r => r.lastInteraction !== null && Date.parse(r.lastInteraction) >= cutoff)
        .sort((a, b) => Date.parse(b.lastInteraction!) - Date.parse(a.lastInteraction!))
        .slice(0, DIAGNOSTICS_SESSION_LIMIT);
}

async function buildPanelHtml(panel: PanelId): Promise<string> {
    const isDark = nativeTheme.shouldUseDarkColors;
    const themeKind = isDark ? 'vscode-dark' : 'vscode-light';

    let initialDataScript = '';
    // Inline script appended after the view bundle, for messages the page must
    // receive once its own listener exists. Part of this page's markup, so it
    // can never reach a different navigation.
    let afterBundleScript = '';
    let scriptFile = `${panel}.js`;
    let title = 'AI Engineering Fluency';

    if (panel === 'details' || panel === 'environmental') {
        const stats = await getStats();
        const windowKey = panel === 'details' ? '__INITIAL_DETAILS__' : '__INITIAL_ENVIRONMENTAL__';
        title = panel === 'details' ? 'AI Engineering Fluency' : 'Environmental Impact';
        const dataWithMeta = {
            ...stats,
            backendConfigured: false,
            compactNumbers: false,
            ...(panel === 'details' ? {
                sortSettings: {
                    editor: { key: 'name', dir: 'asc' },
                    model: { key: 'name', dir: 'asc' },
                    modelOtherExpanded: false,
                    editorOtherExpanded: false,
                },
            } : {}),
        };
        initialDataScript = panelPayloadScript(windowKey, dataWithMeta);

    } else if (panel === 'chart') {
        title = 'Token Usage Chart';
        const chartPayload = await getChartPayload();
        const chartData = {
            ...chartPayload,
            initialPeriod: 'day',
            initialView: 'total',
            initialMetric: 'tokens',
            initialSplit: 'total',
            monthlyBudget: 0,
        };
        initialDataScript = panelPayloadScript('__INITIAL_CHART__', chartData);

    } else if (panel === 'usage') {
        title = 'Usage Analysis';
        const usageStats = await getUsageStats();
        const locale = Intl.DateTimeFormat().resolvedOptions().locale;
        const usageData = {
            today: usageStats.today,
            last30Days: usageStats.last30Days,
            month: usageStats.month,
            lastMonth: usageStats.lastMonth,
            locale,
            customizationMatrix: null,
            missedPotential: [],
            lastUpdated: usageStats.lastUpdated.toISOString(),
            backendConfigured: false,
            currentWorkspacePaths: [],
            suppressedUnknownTools: [],
            todaySessions: usageStats.todaySessions || [],
            use24HourTime: false,
            insights: [],
            curationAnalysis: null,
        };
        initialDataScript = panelPayloadScript('__INITIAL_USAGE__', usageData);

    } else if (panel === 'diagnostics') {
        title = 'Diagnostics';
        const files = await getSessionFiles();
        const diagnosticPaths = getDiagnosticPaths();
        const sessionFiles = await Promise.all(files.map(async (f) => {
            try {
                // Stat the backing file: DB-backed sessions use virtual paths.
                const s = await fs.promises.stat(getSessionBackingPath(f));
                return { file: f, size: s.size, modified: s.mtime.toISOString() };
            } catch {
                return { file: f, size: 0, modified: new Date().toISOString() };
            }
        }));
        const toolFamilies = getToolFamilies();
        const detailedSessionFiles = await buildDetailedSessionFiles(sessionFiles);
        if (detailedSessionFiles.length === 0) {
            // The shared view reads an empty initial list as "still loading" and
            // waits for the host's completion message; without it the Session
            // Files tab spins forever. Post it from the page itself, right after
            // the bundle has registered its listener.
            afterBundleScript = `window.postMessage(${JSON.stringify({ command: 'sessionFilesLoaded', detailedSessionFiles: [] })}, '*');`;
        }
        const diagData = {
            report: buildDiagnosticReport(files.length),
            sessionFiles,
            detailedSessionFiles,
            sessionFolders: [],
            cacheInfo: { size: 0, sizeInMB: 0, lastUpdated: null, location: 'Desktop (in-memory)', storagePath: null },
            backendStorageInfo: null,
            backendConfigured: false,
            isDebugMode: false,
            globalStateCounters: { openCount: 0, unknownMcpOpenCount: 0, fluencyBannerDismissed: false, unknownMcpDismissedVersion: '' },
            displaySettings: { showTokens: true, showCost: true, monthlyBudget: 0 },
            quotaEntitlements: null,
            toolCallStats: null,
            toolFamilies,
            diagnosticPaths,
        };
        initialDataScript = panelPayloadScript('__INITIAL_DIAGNOSTICS__', diagData);

    } else if (panel === 'maturity') {
        title = 'AI Engineering Fluency Score';
        const maturityData = await calculateMaturityScores(
            undefined,
            () => getUsageStats()
        );
        const maturityWithMeta = { ...maturityData, backendConfigured: false, dismissedTips: [], isDebugMode: false };
        initialDataScript = panelPayloadScript('__INITIAL_MATURITY__', maturityWithMeta);

    } else if (panel === 'fluency-level-viewer') {
        title = 'Scoring Guide';
        scriptFile = 'fluency-level-viewer.js';
        const fluencyData = { ...getFluencyLevelData(false), backendConfigured: false };
        initialDataScript = panelPayloadScript('__INITIAL_FLUENCY_LEVEL_DATA__', fluencyData);
    }

    // Inline scripts run only with this per-page nonce, like the extension's own
    // webview CSP, so markup that ends up in the page cannot execute as script.
    const nonce = randomBytes(16).toString('base64');

    // Set data-vscode-theme-kind on the body so the existing CSS selectors in theme.css work
    const themeScript = `document.body.setAttribute('data-vscode-theme-kind','${themeKind}');`;

    return `<!DOCTYPE html>
<html lang="${resolvedLocale(app.getLocale())}">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' app://panel; script-src 'nonce-${nonce}' app://static; img-src data: app://static blob:; font-src app://panel data:;" />
    <link id="vscode-codicon-stylesheet" rel="stylesheet" href="app://panel/${PANEL_ASSET_PREFIX}codicons/codicon.css" />
    <title>${title}</title>
    <style>${VSCODE_DARK_VARS}${VSCODE_LIGHT_VARS}${BASE_BODY_STYLE}</style>
</head>
<body>
    <div id="root"></div>
    <script nonce="${nonce}">${themeScript}${initialDataScript}${JSON_CONFIG_SCRIPT}</script>
    <script nonce="${nonce}" src="app://static/${scriptFile}"></script>${afterBundleScript ? `
    <script nonce="${nonce}">${afterBundleScript}</script>` : ''}
</body>
</html>`;
}

/** App icon as a data URI so the loading page (served from a data: URL) can embed it. */
function getLoadingIconDataUri(): string | undefined {
    try {
        const png = fs.readFileSync(resolveAppIcon());
        return `data:image/png;base64,${png.toString('base64')}`;
    } catch {
        return undefined; // shared body falls back to the 🤖 emoji
    }
}

/**
 * The extension's animated "Building Activity Index" loading screen, reused via
 * the shared vscode-extension/src/loadingHtml.ts module. Progress messages are
 * sent over the 'loading-message' IPC channel and bridged to window messages by
 * the preload, so the shared script works exactly as it does in VS Code.
 */
function buildLoadingHtml(): string {
    const nonce = randomBytes(16).toString('base64');
    return `<!DOCTYPE html>
<html lang="${resolvedLocale(app.getLocale())}">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src data:;" />
    <title>AI Engineering Fluency — Loading</title>
    <style>
${VSCODE_DARK_VARS}${VSCODE_LIGHT_VARS}
${getLoadingHtmlCssBase()}
${getLoadingHtmlCssSteps()}
    </style>
</head>
${getLoadingHtmlBody(nonce, getLoadingIconDataUri())}
</html>`;
}

function buildErrorHtml(panel: string, err: unknown): string {
    const message = err instanceof Error ? (err.stack || err.message) : String(err);
    const escaped = message.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    return `<!DOCTYPE html>
<html lang="${resolvedLocale(app.getLocale())}">
<head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';" />
    <title>Error</title>
    <style>
        ${VSCODE_DARK_VARS}${VSCODE_LIGHT_VARS}
        body { margin: 0; padding: 24px; background: var(--vscode-editor-background);
               color: var(--vscode-editor-foreground); font-family: -apple-system, 'Segoe UI', sans-serif; }
        h2 { font-weight: 400; color: var(--vscode-errorForeground); }
        pre { white-space: pre-wrap; font-size: 12px; opacity: 0.8; }
    </style>
</head>
<body>
    <h2>Couldn't load the “${panel}” view</h2>
    <pre>${escaped}</pre>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Protocol handler
// ---------------------------------------------------------------------------

const STATIC_MIME_TYPES: Record<string, string> = {
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.ttf': 'font/ttf',
};

/**
 * Path prefix under which static files are also served from the panels' own
 * origin (app://panel). Web fonts are fetched in CORS mode, and the `app` scheme
 * has CORS disabled, so the codicon font cannot be loaded from app://static by
 * a page on app://panel — it has to be same-origin.
 */
const PANEL_ASSET_PREFIX = 'assets/';

async function serveStaticFile(encodedFilename: string): Promise<Response> {
    let filename: string;
    try {
        filename = decodeURIComponent(encodedFilename);
    } catch {
        // Malformed percent-encoding: an ordinary bad request, not a handler failure.
        return new Response('Not Found', { status: 404 });
    }
    const webviewDir = path.resolve(getWebviewDir());
    const filePath = path.resolve(webviewDir, filename);
    // Never serve anything outside the bundled webview directory. Compared as a
    // relative path rather than a string prefix, so case and separator
    // differences cannot slip a path past the check.
    const relative = path.relative(webviewDir, filePath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        return new Response('Not Found', { status: 404 });
    }
    try {
        const content = await fs.promises.readFile(filePath);
        const mimeType = STATIC_MIME_TYPES[path.extname(filename)] ?? 'application/octet-stream';
        return new Response(content, { headers: { 'Content-Type': mimeType } });
    } catch {
        return new Response('Not Found', { status: 404 });
    }
}

function registerProtocol(): void {
    protocol.handle('app', async (request) => {
        const url = new URL(request.url);

        if (url.host === 'panel' && url.pathname.startsWith('/' + PANEL_ASSET_PREFIX)) {
            return serveStaticFile(url.pathname.slice(1 + PANEL_ASSET_PREFIX.length));
        }

        if (url.host === 'panel') {
            const panel = url.pathname.slice(1) as PanelId;
            try {
                const html = await buildPanelHtml(panel);
                return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
            } catch (err) {
                // Surface failures instead of leaving a blank window.
                console.error(`[panel:${panel}] failed to build:`, err);
                return new Response(buildErrorHtml(panel, err), {
                    status: 500,
                    headers: { 'Content-Type': 'text/html; charset=utf-8' },
                });
            }
        }

        if (url.host === 'static') {
            return serveStaticFile(url.pathname.slice(1));
        }

        return new Response('Not Found', { status: 404 });
    });
}

// ---------------------------------------------------------------------------
// Window management
// ---------------------------------------------------------------------------

function createWindow(): BrowserWindow {
    const win = new BrowserWindow({
        width: 960,
        height: 700,
        minWidth: 600,
        minHeight: 400,
        show: false,
        title: 'AI Engineering Fluency',
        icon: resolveAppIcon(),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
    });

    // Show loading state immediately so the window appears quickly
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(buildLoadingHtml()));

    win.once('ready-to-show', () => win.show());

    // Prevent navigating away from the app (e.g. if a link is clicked)
    win.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (event, navUrl) => {
        if (!navUrl.startsWith('app://')) {
            event.preventDefault();
            shell.openExternal(navUrl);
        }
    });

    // Hide to tray on close instead of quitting
    win.on('close', (event) => {
        if (!isQuitting) {
            event.preventDefault();
            win.hide();
        }
    });

    return win;
}

function showPanel(panel: PanelId): void {
    currentPanel = panel;
    if (!mainWindow) { return; }
    const win = mainWindow;
    win.show();
    win.focus();
    if (isPanelDataReady(panel)) {
        win.loadURL(`app://panel/${panel}`);
        return;
    }
    // The data behind this panel is still being computed, which can take a while
    // and keeps the main process busy. Put the loading screen up first — and let
    // it paint — so the window is never left blank while that runs.
    void win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(buildLoadingHtml()))
        .catch(() => { /* superseded by a later navigation */ })
        .then(() => loadPanelData(panel))
        .catch(() => { /* surfaced by the panel's own error page below */ })
        .then(() => {
            if (currentPanel === panel && !win.isDestroyed()) {
                win.loadURL(`app://panel/${panel}`);
            }
        });
}

/** Panels in the order they appear in the tray and Go menus. */
const PANEL_MENU: { label: string; panel: PanelId }[] = [
    { label: 'Details', panel: 'details' },
    { label: 'Environmental Impact', panel: 'environmental' },
    { label: 'Token Usage Chart', panel: 'chart' },
    { label: 'Usage Analysis', panel: 'usage' },
    { label: 'Fluency Score', panel: 'maturity' },
    { label: 'Scoring Guide', panel: 'fluency-level-viewer' },
    { label: 'Diagnostics', panel: 'diagnostics' },
];

function panelMenuItems(): Electron.MenuItemConstructorOptions[] {
    return PANEL_MENU.map(({ label, panel }) => ({ label, click: () => showPanel(panel) }));
}

// ---------------------------------------------------------------------------
// System tray
// ---------------------------------------------------------------------------

function createTray(): Tray {
    const t = new Tray(resolveAppIcon());
    t.setToolTip('AI Engineering Fluency');
    updateTrayMenu(t);

    t.on('double-click', () => showPanel(currentPanel));
    return t;
}

/** Tray item reflecting the updater state: a ready update stays one click away until installed. */
function updateMenuItem(): Electron.MenuItemConstructorOptions {
    const state = getUpdateState();
    switch (state.status) {
        case 'checking':
            return { label: 'Checking for updates…', enabled: false };
        case 'downloading':
            return { label: `Downloading ${state.version}… ${state.percent}%`, enabled: false };
        case 'downloaded':
            return { label: `Restart to install ${state.version}`, click: () => installUpdate() };
        case 'error':
            return { label: 'Update check failed — retry', click: () => { void checkForUpdates(true); } };
        default:
            return { label: 'Check for updates', click: () => { void checkForUpdates(true); } };
    }
}

function updateTrayMenu(t: Tray): void {
    const menu = Menu.buildFromTemplate([
        ...panelMenuItems(),
        { type: 'separator' },
        {
            label: 'Refresh',
            click: async () => {
                await refreshStats();
                if (mainWindow?.isVisible()) {
                    mainWindow.loadURL(`app://panel/${currentPanel}`);
                }
            },
        },
        { type: 'separator' },
        {
            label: 'Launch at startup',
            type: 'checkbox',
            checked: app.getLoginItemSettings().openAtLogin,
            click: (item) => {
                app.setLoginItemSettings({ openAtLogin: item.checked });
                updateTrayMenu(t);
            },
        },
        { type: 'separator' },
        { label: `Version ${app.getVersion()}`, enabled: false },
        updateMenuItem(),
        { type: 'separator' },
        {
            label: 'Quit',
            click: () => {
                isQuitting = true;
                app.quit();
            },
        },
    ]);
    t.setContextMenu(menu);
}

// ---------------------------------------------------------------------------
// IPC — messages from webview panels
// ---------------------------------------------------------------------------

function registerIpcHandlers(): void {
    ipcMain.on('webview-message', async (_event, message: { command: string; [key: string]: unknown }) => {
        switch (message.command) {
            case 'refresh':
                await refreshStats();
                mainWindow?.loadURL(`app://panel/${currentPanel}`);
                break;

            case 'showDetails':
                showPanel('details');
                break;

            case 'showEnvironmental':
                showPanel('environmental');
                break;

            case 'showChart':
                showPanel('chart');
                break;

            case 'showUsageAnalysis':
                showPanel('usage');
                break;

            case 'showDiagnostics':
                showPanel('diagnostics');
                break;

            case 'openSessionFile':
            case 'revealPath': {
                // Reveal rather than open: the path comes from the page, and
                // showing it in Explorer never executes anything. Session entries
                // from DB-backed editors are virtual paths (`opencode.db#<id>`),
                // so resolve to the file that actually exists on disk first.
                const requested = message.command === 'openSessionFile' ? message.file : message.path;
                if (typeof requested !== 'string' || !requested) { break; }
                const target = getSessionBackingPath(requested);
                if (fs.existsSync(target)) {
                    shell.showItemInFolder(target);
                }
                break;
            }

            case 'copyText':
                if (typeof message.text === 'string') { clipboard.writeText(message.text); }
                break;

            case 'copyReport':
                // Built on demand, so the copy never depends on which views were opened first.
                clipboard.writeText(buildDiagnosticReport((await getSessionFiles()).length));
                break;

            case 'openIssue':
                // Fixed address: the page never supplies the URL.
                void shell.openExternal('https://github.com/rajbos/ai-engineering-fluency/issues/new');
                break;

            case 'showMaturity':
            case 'showDashboard':
                showPanel('maturity');
                break;

            case 'showFluencyLevelViewer':
                showPanel('fluency-level-viewer');
                break;

            case 'saveSortSettings':
                // Persist sort preferences — stored in memory for now
                break;

            case 'openFile':
                if (typeof message.path === 'string' && message.path) {
                    shell.openPath(message.path);
                }
                break;

            case 'openMethodologySource': {
                // Fixed id -> URL lookup: the webview never supplies the address itself.
                const url = getEnvironmentalMethodologySourceUrl(message.source);
                if (url) { void shell.openExternal(url); }
                break;
            }

            default:
                break;
        }
    });
}

// ---------------------------------------------------------------------------
// Application menu
// ---------------------------------------------------------------------------

/**
 * Build a trimmed-down menu bar. We drop Electron's default Edit menu and the
 * Reload / Force Reload items (this is a read-only data viewer — they only cause
 * confusion), but keep the Zoom controls, which are genuinely useful. Developer
 * tools stay available in unpackaged (dev) builds only.
 */
function buildAppMenu(): Menu {
    const viewSubmenu: Electron.MenuItemConstructorOptions[] = [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
    ];
    if (!app.isPackaged) {
        viewSubmenu.push({ type: 'separator' }, { role: 'toggleDevTools' });
    }

    return Menu.buildFromTemplate([
        {
            label: 'File',
            submenu: [
                // The window 'close' handler hides to tray, so an explicit Quit
                // must flag a real quit first (same as the tray's Quit item).
                { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => { isQuitting = true; app.quit(); } },
            ],
        },
        {
            // Always-available way back to a known view, independent of the
            // in-page buttons — the way out if a panel fails to render.
            label: 'Go',
            submenu: [
                { label: 'Home', accelerator: 'Alt+Home', click: () => showPanel('details') },
                { type: 'separator' },
                ...panelMenuItems(),
                { type: 'separator' },
                { label: 'Reload View', accelerator: 'F5', click: () => showPanel(currentPanel) },
            ],
        },
        { label: 'View', submenu: viewSubmenu },
        { role: 'windowMenu' },
    ]);
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

let isQuitting = false;

// A tray app must be single-instance: a second launch (Start menu, launch at
// startup racing a manual start) would otherwise add a second tray icon and a
// second process parsing the same session files.
const hasInstanceLock = app.requestSingleInstanceLock();
if (!hasInstanceLock) {
    app.quit();
}
app.on('second-instance', () => {
    if (mainWindow) { showPanel(currentPanel); }
});

app.whenReady().then(async () => {
    if (!hasInstanceLock) { return; }

    // Set the AppUserModelID early so Windows shows our taskbar icon/identity.
    if (process.platform === 'win32') {
        app.setAppUserModelId(APP_ID);
    }

    registerProtocol();
    registerIpcHandlers();
    Menu.setApplicationMenu(buildAppMenu());

    // Pre-load the cache so the first panel render is fast
    await loadCache();

    mainWindow = createWindow();
    tray = createTray();

    // Warm the caches in the background, showing the loading page meanwhile.
    // Detailed stats power Details/Chart/Environmental; usage stats power Usage
    // Analysis and Fluency Score. Both are expensive (tens of seconds over large
    // histories) and run synchronously, so pre-warm BOTH at startup — otherwise
    // the first open of Usage Analysis / Fluency Score freezes the UI mid-click
    // and looks like the panel never loads.
    getStats().then(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.loadURL(`app://panel/${currentPanel}`);
        }
        // Continue warming the chart and usage data so those panels open instantly too.
        return getChartPayload().then(() => getUsageStats());
    }).catch(() => { /* surfaced per-panel via the error page */ });

    startUpdateChecks({
        onStateChange: () => { if (tray) { updateTrayMenu(tray); } },
        // The window's 'close' handler hides to tray; flag a real quit so the
        // updater can actually close the app and run the installer.
        beforeInstall: () => { isQuitting = true; },
    });

    // Listen for system theme changes and reload the current panel
    nativeTheme.on('updated', () => {
        if (mainWindow?.isVisible()) {
            mainWindow.loadURL(`app://panel/${currentPanel}`);
        }
    });
});

app.on('window-all-closed', () => {
    // On Windows, keep the app alive in the tray even when all windows are closed
    if (process.platform !== 'darwin') {
        // Don't quit — the tray keeps it running
    }
});

app.on('activate', () => {
    if (!mainWindow) {
        mainWindow = createWindow();
    } else {
        mainWindow.show();
    }
});

app.on('before-quit', async () => {
    await saveCache();
});
