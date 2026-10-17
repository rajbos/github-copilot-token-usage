// Builds the HTML of a desktop panel. Kept free of `electron` so the headless render
// check (scripts/validate-desktop-render.js) can build the same pages under plain Node;
// main.ts supplies the Electron-specific bits through PanelHost.
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { randomBytes } from 'crypto';
import {
    effectiveTokens,
    getDiagnosticPaths,
    getSessionBackingPath,
    getSessionLastActivity,
    getSessionMeta,
    processSessionFile,
    getCacheStats,
} from '../../cli/src/helpers';
import { standaloneUsageAnalysisViewInputs } from '../../cli/src/usageAnalysisView';
import { calculateMaturityScores, getFluencyLevelData } from '../../src/maturityScoring';
import { buildUsageAnalysisViewData } from '../../src/usageAnalysisViewBuilder';
import { buildCacheInfo, buildDiagnosticsViewData, buildSessionFolderData } from '../../src/diagnosticsViewBuilder';
import { getEcosystems } from '../../cli/src/sessionProcessing';
import { getEditorSourceFromPath, runWithConcurrency } from '../../cli/src/analysis';
import type { DetailedStats, UsageAnalysisStats } from '../../src/types';
import { createEmptyContextRefs } from '../../src/tokenEstimation';
import { mergeToolFamilies } from '../../src/toolFamilies';
import { detectEditorSource } from '../../src/workspaceHelpers';
import { buildWebviewLocalization } from '../../vscode-extension/src/webviewLocalization';
import { createTranslator, resolvedLocale } from '../../cli/src/l10n';
import tokenEstimatorsData from '../../src/tokenEstimators.json';
import modelPricingData from '../../src/modelPricing.json';
import toolNamesData from '../../src/toolNames.json';
import automaticToolsData from '../../src/automaticTools.json';
import unsupportedWebviewCommands from './unsupportedWebviewCommands.json';
import themeDarkCss from '../../.github/skills/visual-view-diff/lib/theme-dark.css';
import themeLightCss from '../../.github/skills/visual-view-diff/lib/theme-light.css';

/** Every panel the app can show; one webview bundle each (`<id>.js`). */
export const PANEL_IDS = ['details', 'environmental', 'chart', 'efficiency', 'usage', 'diagnostics', 'maturity', 'fluency-level-viewer'] as const;
export type PanelId = typeof PANEL_IDS[number];

// ---------------------------------------------------------------------------
// VS Code CSS variable seed
// Provides concrete values for --vscode-* custom properties so the existing
// webview IIFE bundles render correctly outside of VS Code. The values come from
// the visual-view-diff harness's theme files, the one list of tokens the shared
// views reference; scripts/validate-webview-shell.js fails when a view starts
// using a token that list does not define.
// ---------------------------------------------------------------------------

export const VSCODE_THEME_VARS = `
${themeDarkCss}
@media (prefers-color-scheme: light) {
${themeLightCss}
}
`;

/**
 * Controls the desktop app cannot act on yet. They are rendered by the shared
 * webview bundles, so the only host-side way to avoid a dead control is to hide
 * it. The list is the 'hidden' entries of unsupportedWebviewCommands.json, which
 * scripts/validate-desktop-contract.js checks against the views' messages and
 * registerIpcHandlers — remove an entry there when its message gets a handler.
 */
const HIDDEN_CONTROL_SELECTORS: string[] = [...new Set(Object.values(unsupportedWebviewCommands.commands)
    .flatMap(entry => (entry as { hiddenBy?: string[] }).hiddenBy ?? []))];

export const BASE_BODY_STYLE = `
body {
    margin: 0;
    padding: 0;
    background-color: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 13px;
}
${HIDDEN_CONTROL_SELECTORS.length > 0 ? `${HIDDEN_CONTROL_SELECTORS.join(',\n')} { display: none !important; }` : ''}
`;


/**
 * Path prefix under which static files are also served from the panels' own
 * origin (app://panel). Web fonts are fetched in CORS mode, and the `app` scheme
 * has CORS disabled, so the codicon font cannot be loaded from app://static by
 * a page on app://panel — it has to be same-origin.
 */
export const PANEL_ASSET_PREFIX = 'assets/';

/** Editor display name for a session path: the CLI's detector, then the shared path detector. */
export function sessionEditorName(file: string): string {
    const editor = getEditorSourceFromPath(file);
    if (editor && editor !== 'Unknown') { return editor; }
    return detectEditorSource(file) || 'Unknown';
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
 * Resolved once per language: the locale does not change while the app is running,
 * and rebuilding 147 strings per panel open would be wasted work.
 */
let cachedWebviewLocalization: Record<string, string> | undefined;
function desktopWebviewLocalization(language: string): Record<string, string> {
    if (!cachedWebviewLocalization || cachedWebviewLocalization.__language__ !== language) {
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
function panelPayloadScript(windowKey: string, data: object, host: PanelHost): string {
    const payload = {
        ...data,
        localization: desktopWebviewLocalization(host.locale),
        // Display language — which strings. Separate from `locale` below, which
        // some panels set for number/date formatting: a German user on an English
        // system wants 1.234,56 with English UI.
        language: resolvedLocale(host.locale),
    };
    return `window.${windowKey}=${JSON.stringify(payload).replace(/</g, '\\u003c')};`;
}

/** Plain-text diagnostic report, shown in the Diagnostics view and copied by "Copy report". */
export function buildDiagnosticReport(sessionFileCount: number, appVersion: string): string {
    return `AI Engineering Fluency — Desktop Diagnostic Report\n${'='.repeat(50)}\n\nVersion: ${appVersion}\nSession files found: ${sessionFileCount}\nTimestamp: ${new Date().toISOString()}`;
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

/** What the page needs from the Electron shell, so this module never imports `electron`. */
export interface PanelHost {
    /** `app.getLocale()` */
    locale: string;
    /** `nativeTheme.shouldUseDarkColors` */
    isDark: boolean;
}

/** The session-derived inputs of the panels; main.ts caches them, the render check computes them directly. */
export interface PanelDataSource {
    getStats(): Promise<DetailedStats>;
    getChartPayload(): Promise<object>;
    getEfficiencyPayload(): Promise<object>;
    getUsageStats(): Promise<UsageAnalysisStats>;
    getSessionFiles(): Promise<string[]>;
}

export async function buildPanelHtml(panel: PanelId, host: PanelHost, data: PanelDataSource, appVersion: string): Promise<string> {
    const isDark = host.isDark;
    const themeKind = isDark ? 'vscode-dark' : 'vscode-light';

    let initialDataScript = '';
    // Inline script appended after the view bundle, for messages the page must
    // receive once its own listener exists. Part of this page's markup, so it
    // can never reach a different navigation.
    let afterBundleScript = '';
    let scriptFile = `${panel}.js`;
    let title = 'AI Engineering Fluency';

    if (panel === 'details' || panel === 'environmental') {
        const stats = await data.getStats();
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
        initialDataScript = panelPayloadScript(windowKey, dataWithMeta, host);

    } else if (panel === 'chart') {
        title = 'Token Usage Chart';
        const chartPayload = await data.getChartPayload();
        const chartData = {
            ...chartPayload,
            initialPeriod: 'day',
            initialView: 'total',
            initialMetric: 'tokens',
            initialSplit: 'total',
            monthlyBudget: 0,
        };
        initialDataScript = panelPayloadScript('__INITIAL_CHART__', chartData, host);

    } else if (panel === 'efficiency') {
        title = 'AI Efficiency Trends';
        initialDataScript = panelPayloadScript('__INITIAL_EFFICIENCY__', await data.getEfficiencyPayload(), host);

    } else if (panel === 'usage') {
        title = 'Usage Analysis';
        const usageStats = await data.getUsageStats();
        const locale = Intl.DateTimeFormat().resolvedOptions().locale;
        // The shared builder the extension and CLI use. This host keeps no insight state:
        // every applicable insight shows as new, and the cards' dismiss/snooze messages
        // (`insightAction`) are not handled here yet.
        const usageData = buildUsageAnalysisViewData(
            usageStats,
            standaloneUsageAnalysisViewInputs(locale, resolvedLocale(host.locale)),
        );
        initialDataScript = panelPayloadScript('__INITIAL_USAGE__', usageData, host);

    } else if (panel === 'diagnostics') {
        title = 'Diagnostics';
        const files = await data.getSessionFiles();
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
        const toolFamilies = mergeToolFamilies([]);
        const detailedSessionFiles = await buildDetailedSessionFiles(sessionFiles);
        if (detailedSessionFiles.length === 0) {
            // The shared view reads an empty initial list as "still loading" and
            // waits for the host's completion message; without it the Session
            // Files tab spins forever. Post it from the page itself, right after
            // the bundle has registered its listener.
            afterBundleScript = `window.postMessage(${JSON.stringify({ command: 'sessionFilesLoaded', detailedSessionFiles: [] })}, '*');`;
        }
        // The shared builder the extension uses. Fields that are VS Code state (backend sync,
        // globalState counters, Copilot quota and budgets, per-editor skill counts) are passed
        // as the builder's documented "not available in this host" values.
        const cache = getCacheStats();
        const diagData = {
            ...buildDiagnosticsViewData({
                report: buildDiagnosticReport(files.length, appVersion),
                sessionFiles,
                detailedSessionFiles,
                sessionFolders: buildSessionFolderData(files, { findEcosystem: f => getEcosystems().find(e => e.handles(f)) ?? null, homeDir: os.homedir() }),
                // Entry count of the CLI walk cache; its on-disk size is not measured here.
                cacheInfo: buildCacheInfo(cache.entries, 0, 'Desktop session cache', null),
                backendStorageInfo: null,
                backendConfigured: false,
                isDebugMode: false,
                globalStateCounters: { openCount: 0, unknownMcpOpenCount: 0, fluencyBannerDismissed: false, unknownMcpDismissedVersion: '' },
                displaySettings: { showTokens: true, showCost: true, monthlyBudget: 0 },
                quotaEntitlements: null,
                accountBudgets: [],
                usageStats: await data.getUsageStats(),
                skillCallsByEditor: null,
                toolFamilies,
            }),
            diagnosticPaths,
        };
        initialDataScript = panelPayloadScript('__INITIAL_DIAGNOSTICS__', diagData, host);

    } else if (panel === 'maturity') {
        title = 'AI Engineering Fluency Score';
        const maturityData = await calculateMaturityScores(
            undefined,
            () => data.getUsageStats()
        );
        const maturityWithMeta = { ...maturityData, backendConfigured: false, dismissedTips: [], isDebugMode: false };
        initialDataScript = panelPayloadScript('__INITIAL_MATURITY__', maturityWithMeta, host);

    } else if (panel === 'fluency-level-viewer') {
        title = 'Scoring Guide';
        scriptFile = 'fluency-level-viewer.js';
        const fluencyData = { ...getFluencyLevelData(false), backendConfigured: false };
        initialDataScript = panelPayloadScript('__INITIAL_FLUENCY_LEVEL_DATA__', fluencyData, host);
    }

    // Inline scripts run only with this per-page nonce, like the extension's own
    // webview CSP, so markup that ends up in the page cannot execute as script.
    const nonce = randomBytes(16).toString('base64');

    // Set data-vscode-theme-kind on the body so the existing CSS selectors in theme.css work
    const themeScript = `document.body.setAttribute('data-vscode-theme-kind','${themeKind}');`;

    return `<!DOCTYPE html>
<html lang="${resolvedLocale(host.locale)}">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' app://panel; script-src 'nonce-${nonce}' app://static; img-src data: app://static blob:; font-src app://panel data:;" />
    <link id="vscode-codicon-stylesheet" rel="stylesheet" href="app://panel/${PANEL_ASSET_PREFIX}codicons/codicon.css" />
    <title>${title}</title>
    <style>${VSCODE_THEME_VARS}${BASE_BODY_STYLE}</style>
</head>
<body>
    <div id="root"></div>
    <script nonce="${nonce}">${themeScript}${initialDataScript}${JSON_CONFIG_SCRIPT}</script>
    <script nonce="${nonce}" src="app://static/${scriptFile}"></script>${afterBundleScript ? `
    <script nonce="${nonce}">${afterBundleScript}</script>` : ''}
</body>
</html>`;
}

