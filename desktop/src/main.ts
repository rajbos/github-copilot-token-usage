import { app, BrowserWindow, Tray, Menu, clipboard, ipcMain, nativeTheme, protocol, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { randomBytes } from 'crypto';
import { buildDiagnosticReport, buildPanelHtml as buildPanelPage, sessionEditorName, VSCODE_THEME_VARS, PANEL_ASSET_PREFIX, type PanelId } from './panelPage';
import { checkForUpdates, getUpdateState, installUpdate, startUpdateChecks } from './updater';
import {
    discoverSessionFiles,
    calculateDetailedStats,
    calculateUsageAnalysisStats,
    calculateViewStats,
    buildChartPayload,
    buildEfficiencyPayload,
    getSessionBackingPath,
    loadCache,
    saveCache,
} from '../../cli/src/helpers';
import { withUsageAnalysisViewStats } from '../../cli/src/usageAnalysisView';
import type { DailyTokenStats, DetailedStats, UsageAnalysisStats } from '../../src/types';
import type { EfficiencySessionInput } from '../../src/efficiencyAnalysis';
import { getEnvironmentalMethodologySourceUrl } from '../../src/environmentalImpact';
import { toLocalDayKey } from '../../src/utils/dayKeys';
import {
    getLoadingHtmlCssBase,
    getLoadingHtmlCssSteps,
    getLoadingHtmlBody,
} from '../../src/loadingHtml';
import { getEditorIconByName } from '../../src/editorIcons';
import { resolvedLocale } from '../../cli/src/l10n';

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
// Session-derived inputs behind both the Chart and Efficiency payloads, from one session walk.
let cachedViewStats: ViewStats | null = null;
let cachedEfficiencyPayload: object | null = null;
// Set when a panel's data walk was stopped because the window was hidden to the tray;
// showing the window again resumes that navigation (behind the loading screen).
let resumePanelOnShow = false;
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
// Stats loading
// ---------------------------------------------------------------------------

// Computations currently running, by name. These walk the whole session history,
// so a second caller (opening Usage Analysis while startup is still pre-warming it, or
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
            // The CLI's collectors fill customization and curation the way `usage-analysis`
            // does; with no open workspace only user-level skills count as available tools.
            async files => withUsageAnalysisViewStats(files, await calculateUsageAnalysisStats(files), { workspaceFolderPaths: [] }),
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
        // Inputs are read inside the computation, so a refresh that lands meanwhile
        // fails its generation check and the payload is rebuilt from the new data.
        await computeForCurrentFiles(
            async () => buildChartPayload((await getViewStats()).dailyStats),
            (payload) => { cachedChartPayload ??= payload; },
        );
    }
    return cachedChartPayload;
}

type ViewStats = { dailyStats: DailyTokenStats[]; efficiencySessionInputs: EfficiencySessionInput[] };

/**
 * Full-history daily stats plus the Efficiency session inputs, built in one walk over the
 * session files and shared by the Chart and Efficiency payloads, so a cold Efficiency open
 * does not parse and analyze every session twice.
 */
function getViewStats(): Promise<ViewStats> {
    return shareInFlight('viewStats', loadViewStats);
}

/** The panels that wait on the view stats walk; leaving them all cancels it. */
const VIEW_STATS_PANELS: ReadonlySet<PanelId> = new Set<PanelId>(['chart', 'efficiency']);

async function loadViewStats(): Promise<ViewStats> {
    expireCachesOnDateChange();
    while (!cachedViewStats) {
        await computeForCurrentFiles(
            // The walk can run for minutes on a large history, on this main process, so it stops
            // between files and throws (ViewStatsCancelledError) as soon as nobody needs it:
            //  - the user left Chart and Efficiency; reopening either starts a fresh walk, which
            //    reuses the session cache this one filled;
            //  - a refresh replaced the data it was computed for (dataGeneration moved). The
            //    refreshed navigation owns the walk for the new data; without this the old walk
            //    kept going and computeForCurrentFiles() then retried it, so two ran at once.
            // Nothing partial is cached, and the throw also ends computeForCurrentFiles()'s retry
            // loop for the obsolete caller.
            files => {
                const generation = dataGeneration;
                return calculateViewStats(files, false, undefined, {
                    // Hidden to the tray counts as "nobody waiting" too: closing the window only
                    // hides it and leaves currentPanel unchanged.
                    isCancelled: () => generation !== dataGeneration || !VIEW_STATS_PANELS.has(currentPanel)
                        || !(mainWindow?.isVisible() ?? false),
                });
            },
            (viewStats) => { cachedViewStats ??= viewStats; },
        );
    }
    return cachedViewStats;
}

/**
 * Efficiency payload, built by the same shared builder as the extension's
 * (src/efficiencyViewBuilder.ts). Its session inputs come from the same walk as the
 * Chart's daily stats; the usage analysis (a separate, recent-files pass) runs alongside.
 */
function getEfficiencyPayload(): Promise<object> {
    return shareInFlight('efficiency', loadEfficiencyPayload);
}

async function loadEfficiencyPayload(): Promise<object> {
    expireCachesOnDateChange();
    while (!cachedEfficiencyPayload) {
        await computeForCurrentFiles(
            async () => {
                const [viewStats, usage] = await Promise.all([getViewStats(), getUsageStats()]);
                return buildEfficiencyPayload({ dailyStats: viewStats.dailyStats, usage, sessionInputs: viewStats.efficiencySessionInputs });
            },
            (payload) => { cachedEfficiencyPayload ??= payload; },
        );
    }
    return cachedEfficiencyPayload;
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
        cachedViewStats = null;
        cachedEfficiencyPayload = null;
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
        case 'efficiency':
            return cachedEfficiencyPayload !== null;
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
        case 'efficiency':
            await getEfficiencyPayload();
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
        cachedViewStats = null;
        cachedEfficiencyPayload = null;
        await saveCache();
    } finally {
        isRefreshing = false;
    }
}

/** The panel's page, built from this app's cached data. */
function buildPanelHtml(panel: PanelId): Promise<string> {
    return buildPanelPage(
        panel,
        { locale: app.getLocale(), isDark: nativeTheme.shouldUseDarkColors },
        { getStats, getChartPayload, getEfficiencyPayload, getUsageStats, getSessionFiles },
        app.getVersion(),
    );
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
 * the shared src/loadingHtml.ts module. Progress messages are
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
${VSCODE_THEME_VARS}
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
        ${VSCODE_THEME_VARS}
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

    // A data walk stopped while the window was hidden resumes when it is shown again.
    win.on('show', () => {
        if (!resumePanelOnShow) { return; }
        resumePanelOnShow = false;
        navigateToPanel(currentPanel);
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
    mainWindow.show();
    mainWindow.focus();
    navigateToPanel(panel);
}

/**
 * Loads a panel, putting the loading screen up first when its data still has to be
 * computed. Every navigation goes through here — including the reload after a refresh
 * or the startup warm-up, which clear or have not yet built the caches — because a
 * cache miss can mean a multi-minute walk on this main process (the Chart/Efficiency
 * enrichment), and loading `app://panel/...` directly would block on it with the old
 * page, or nothing, on screen.
 */
/** Bumped by every navigateToPanel() call; a pending navigation that sees a newer value was superseded. */
let navigationGeneration = 0;

function navigateToPanel(panel: PanelId): void {
    if (!mainWindow || mainWindow.isDestroyed()) { return; }
    const win = mainWindow;
    const generation = ++navigationGeneration;
    const isCurrent = () => generation === navigationGeneration && currentPanel === panel && !win.isDestroyed();
    if (isPanelDataReady(panel)) {
        win.loadURL(`app://panel/${panel}`);
        return;
    }
    // The data behind this panel is still being computed, which can take a while
    // and keeps the main process busy. Put the loading screen up first — and let
    // it paint — so the window is never left blank while that runs.
    void win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(buildLoadingHtml()))
        .then(() => true, () => false)
        .then(async (painted) => {
            // Superseded while the loading page went up (another panel, a refresh, or the window
            // closed): never start this panel's computation — on a cold Chart/Efficiency cache
            // that is a multi-minute walk on this main process nobody is waiting for. The later
            // navigation owns the window.
            if (!isCurrent()) { return; }
            if (painted) {
                try { await loadPanelData(panel); } catch { /* surfaced by the panel's own error page below */ }
            }
            // Re-checked after the wait: the user may have moved on while the data was computed.
            if (!isCurrent()) { return; }
            // The walk stops while the window is hidden to the tray. Loading the panel now would
            // start it again, unseen; resume when the window is shown instead.
            if (!win.isVisible() && !isPanelDataReady(panel)) { resumePanelOnShow = true; return; }
            // A loading page that failed for another reason falls through to the panel itself.
            win.loadURL(`app://panel/${panel}`);
        });
}

/** Panels in the order they appear in the tray and Go menus. */
const PANEL_MENU: { label: string; panel: PanelId }[] = [
    { label: 'Details', panel: 'details' },
    { label: 'Environmental Impact', panel: 'environmental' },
    { label: 'Token Usage Chart', panel: 'chart' },
    { label: 'Efficiency', panel: 'efficiency' },
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
                    navigateToPanel(currentPanel);
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
                navigateToPanel(currentPanel);
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

            case 'showEfficiency':
                showPanel('efficiency');
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
                clipboard.writeText(buildDiagnosticReport((await getSessionFiles()).length, app.getVersion()));
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
    // Detailed stats power Details/Environmental; usage stats power Usage
    // Analysis and Fluency Score. Both are expensive (tens of seconds over large
    // histories) and run synchronously, so pre-warm BOTH at startup — otherwise
    // the first open of Usage Analysis / Fluency Score freezes the UI mid-click
    // and looks like the panel never loads.
    // The Chart/Efficiency walk is deliberately NOT pre-warmed: it analyzes every
    // historical session (usage analysis + repository lookup), which on a large
    // history runs for minutes on this main process. Unattended, after Details is
    // already showing, that would freeze the visible window; on demand it runs
    // behind the loading screen showPanel() puts up first.
    getStats().then(() => {
        navigateToPanel(currentPanel);
        return getUsageStats();
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
            navigateToPanel(currentPanel);
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
