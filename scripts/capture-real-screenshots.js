#!/usr/bin/env node
/**
 * Capture Real Screenshots
 *
 * Renders the actual compiled webview bundles (details, chart, usage,
 * diagnostics) in headless Chromium via Playwright with realistic test
 * data.  The bundles are the exact same JS that runs inside VS Code
 * webviews — the only difference is that we supply concrete CSS values
 * for VS Code's --vscode-* theme tokens and a tiny acquireVsCodeApi mock.
 *
 * Prerequisites:
 *   cd vscode-extension && npm run compile   # build webview bundles
 *   npm install playwright                   # (one-time)
 *   npx playwright install chromium          # (one-time)
 *
 * Usage:
 *   node scripts/capture-real-screenshots.js [--output-dir <path>]
 */

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// CLI arguments
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const outputDir = args.includes('--output-dir')
    ? args[args.indexOf('--output-dir') + 1]
    : path.join(__dirname, '..', 'docs', 'images', 'screenshots');

const extensionDir = path.join(__dirname, '..', 'vscode-extension');
const distWebview = path.join(extensionDir, 'dist', 'webview');

// ---------------------------------------------------------------------------
// Preflight checks
// ---------------------------------------------------------------------------
console.log('📸 Capture Real Screenshots — using actual webview bundles');
console.log('='.repeat(60));

const requiredBundles = ['details.js', 'chart.js', 'usage.js', 'diagnostics.js'];
for (const b of requiredBundles) {
    if (!fs.existsSync(path.join(distWebview, b))) {
        console.error(`\n❌ Missing bundle: dist/webview/${b}`);
        console.error('   Run:  cd vscode-extension && npm run compile');
        process.exit(1);
    }
}
console.log('✅ All webview bundles found\n');

// ---------------------------------------------------------------------------
// VS Code "Dark+" theme token values
// (sampled from the default Dark+ theme shipped with VS Code)
// ---------------------------------------------------------------------------
const vscodeThemeVars = `
    --vscode-editor-background: #1e1e1e;
    --vscode-editor-foreground: #cccccc;
    --vscode-sideBar-background: #252526;
    --vscode-editorWidget-background: #252526;
    --vscode-descriptionForeground: #b0b0b0;
    --vscode-disabledForeground: #6a6a6a;
    --vscode-panel-border: #3c3c3c;
    --vscode-widget-border: #3c3c3c;
    --vscode-contrastBorder: transparent;
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
    --vscode-badge-foreground: #ffffff;
    --vscode-focusBorder: #007fd4;
    --vscode-textLink-foreground: #3794ff;
    --vscode-textLink-activeForeground: #3794ff;
    --vscode-errorForeground: #f48771;
    --vscode-editorWarning-foreground: #cca700;
    --vscode-terminal-ansiGreen: #23d18b;
    --vscode-font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
    --vscode-font-size: 13px;
`;

// ---------------------------------------------------------------------------
// Build realistic sample data payloads matching the window.__INITIAL_*__
// shapes expected by each webview bundle.
// ---------------------------------------------------------------------------

function buildPeriodStats(tokens, sessions, models, editors) {
    const interactions = sessions * 4;
    const modelUsage = {};
    for (const [name, ratio] of Object.entries(models)) {
        modelUsage[name] = {
            inputTokens: Math.round(tokens * ratio * 0.35),
            outputTokens: Math.round(tokens * ratio * 0.65),
        };
    }
    const editorUsage = {};
    for (const [name, ratio] of Object.entries(editors)) {
        editorUsage[name] = { tokens: Math.round(tokens * ratio), sessions: Math.round(sessions * ratio) };
    }
    return {
        tokens,
        thinkingTokens: Math.round(tokens * 0.08),
        estimatedTokens: Math.round(tokens * 0.6),
        actualTokens: Math.round(tokens * 0.4),
        sessions,
        avgInteractionsPerSession: +(interactions / sessions).toFixed(1),
        avgTokensPerSession: Math.round(tokens / sessions),
        modelUsage,
        editorUsage,
        co2: +(tokens * 0.0000042).toFixed(4),
        treesEquivalent: +(tokens * 0.0000001).toFixed(6),
        waterUsage: +(tokens * 0.000015).toFixed(4),
        estimatedCost: +(tokens * 0.000008).toFixed(4),
    };
}

const models = { 'gpt-4o': 0.45, 'claude-sonnet-4.5': 0.35, 'o3-mini': 0.20 };
const editors = { 'VS Code': 0.70, 'VS Code Insiders': 0.20, 'Cursor': 0.10 };

const detailsData = {
    today: buildPeriodStats(12480, 8, models, editors),
    month: buildPeriodStats(347920, 142, models, editors),
    lastMonth: buildPeriodStats(285600, 118, models, editors),
    last30Days: buildPeriodStats(412350, 168, models, editors),
    lastUpdated: new Date().toISOString(),
    backendConfigured: false,
    sortSettings: {
        editor: { key: 'name', dir: 'asc' },
        model: { key: 'name', dir: 'asc' },
    },
    compactNumbers: false,
};

// Chart data: 30 days of token usage
function buildChartData() {
    const labels = [];
    const tokensData = [];
    const sessionsData = [];
    const modelDatasets = {};
    const editorDatasets = {};
    const now = new Date();
    const colours = [
        { bg: 'rgba(54, 162, 235, 0.6)', border: 'rgba(54, 162, 235, 1)' },
        { bg: 'rgba(255, 99, 132, 0.6)', border: 'rgba(255, 99, 132, 1)' },
        { bg: 'rgba(75, 192, 192, 0.6)', border: 'rgba(75, 192, 192, 1)' },
    ];
    const modelNames = Object.keys(models);
    const editorNames = Object.keys(editors);
    for (const [i, m] of modelNames.entries()) {
        modelDatasets[m] = { label: m, data: [], backgroundColor: colours[i].bg, borderColor: colours[i].border, borderWidth: 1 };
    }
    for (const [i, e] of editorNames.entries()) {
        editorDatasets[e] = { label: e, data: [], backgroundColor: colours[i].bg, borderColor: colours[i].border, borderWidth: 1 };
    }
    let totalTokens = 0;
    let totalSessions = 0;
    for (let d = 29; d >= 0; d--) {
        const day = new Date(now); day.setDate(day.getDate() - d);
        labels.push(day.toISOString().split('T')[0]);
        const base = 8000 + Math.round(Math.random() * 12000);
        const sess = 3 + Math.round(Math.random() * 8);
        tokensData.push(base);
        sessionsData.push(sess);
        totalTokens += base;
        totalSessions += sess;
        for (const [mi, m] of modelNames.entries()) {
            modelDatasets[m].data.push(Math.round(base * Object.values(models)[mi]));
        }
        for (const [ei, e] of editorNames.entries()) {
            editorDatasets[e].data.push(Math.round(base * Object.values(editors)[ei]));
        }
    }
    const editorTotalsMap = {};
    for (const e of editorNames) editorTotalsMap[e] = editorDatasets[e].data.reduce((a, b) => a + b, 0);
    return {
        labels,
        tokensData,
        sessionsData,
        modelDatasets: Object.values(modelDatasets),
        editorDatasets: Object.values(editorDatasets),
        editorTotalsMap,
        repositoryDatasets: [],
        repositoryTotalsMap: {},
        dailyCount: 30,
        totalTokens,
        avgTokensPerDay: Math.round(totalTokens / 30),
        totalSessions,
        lastUpdated: new Date().toISOString(),
        backendConfigured: false,
        compactNumbers: false,
    };
}

const chartData = buildChartData();

// Usage analysis data
const usageData = {
    today: buildUsagePeriod(12480, 8),
    last30Days: buildUsagePeriod(412350, 168),
    month: buildUsagePeriod(347920, 142),
    locale: 'en-US',
    customizationMatrix: null,
    missedPotential: [],
    lastUpdated: new Date().toISOString(),
    backendConfigured: false,
    currentWorkspacePaths: ['/home/user/projects/my-app'],
};

function buildUsagePeriod(tokens, sessions) {
    return {
        sessions,
        toolCalls: { total: sessions * 3, byTool: { 'read_file': sessions, 'run_terminal_cmd': sessions, 'edit_file': sessions } },
        modeUsage: { ask: Math.round(sessions * 0.3), edit: Math.round(sessions * 0.25), agent: Math.round(sessions * 0.35), plan: Math.round(sessions * 0.05), customAgent: Math.round(sessions * 0.05) },
        contextReferences: {
            file: Math.round(sessions * 2.1), selection: Math.round(sessions * 0.8),
            implicitSelection: Math.round(sessions * 0.3), symbol: Math.round(sessions * 0.5),
            codebase: Math.round(sessions * 0.4), workspace: Math.round(sessions * 0.2),
            terminal: Math.round(sessions * 0.6), vscode: Math.round(sessions * 0.1),
            terminalLastCommand: Math.round(sessions * 0.3), terminalSelection: 0,
            clipboard: Math.round(sessions * 0.1), changes: Math.round(sessions * 0.4),
            outputPanel: 0, problemsPanel: Math.round(sessions * 0.2),
            byKind: {}, copilotInstructions: Math.round(sessions * 0.15),
            agentsMd: Math.round(sessions * 0.1), byPath: {},
        },
        mcpTools: { total: 0, byServer: {}, byTool: {} },
        modelSwitching: {
            switchCount: Math.round(sessions * 0.2),
            modelSequences: [],
            uniqueModels: ['gpt-4o', 'claude-sonnet-4.5', 'o3-mini'],
            modelsPerSession: Array.from({ length: sessions }, () => 1 + Math.round(Math.random() * 2)),
            totalSessions: sessions,
            averageModelsPerSession: 1.8,
            maxModelsPerSession: 3,
            minModelsPerSession: 1,
            switchingFrequency: 0.35,
            standardModels: ['gpt-4o', 'o3-mini'],
            premiumModels: ['claude-sonnet-4.5'],
            unknownModels: [],
            mixedTierSessions: Math.round(sessions * 0.3),
            standardRequests: Math.round(sessions * 2.5),
            premiumRequests: Math.round(sessions * 1.2),
            unknownRequests: 0,
            totalRequests: Math.round(sessions * 3.7),
        },
        repositories: ['user/my-app', 'user/toolkit'],
        repositoriesWithCustomization: ['user/my-app'],
        editScope: { singleFile: Math.round(sessions * 0.6), multiFile: Math.round(sessions * 0.4), avgFilesPerEdit: 2.3 },
        applyUsage: { totalApplies: Math.round(sessions * 1.2), acceptedApplies: Math.round(sessions * 0.9), discardedApplies: Math.round(sessions * 0.3) },
        sessionDuration: { avgMinutes: 12.5, medianMinutes: 9.0, totalMinutes: sessions * 12.5 },
        conversationPatterns: { avgTurnsPerSession: 4.2, maxTurns: 18, singleTurnSessions: Math.round(sessions * 0.15), multiTurnSessions: Math.round(sessions * 0.85) },
        agentTypes: { copilot: sessions, thirdParty: 0, byName: { 'GitHub Copilot': sessions } },
    };
}

// Diagnostics data
const diagnosticsData = {
    report: [
        '=== Copilot Token Tracker — Diagnostic Report ===',
        '',
        `Generated: ${new Date().toLocaleString()}`,
        `Extension version: 1.16.0`,
        `VS Code version: 1.100.0`,
        `Platform: linux x64`,
        '',
        '--- Session Discovery ---',
        'Session folders scanned: 3',
        'Total session files found: 38',
        'JSON files: 32 | JSONL files: 6',
        '',
        '--- Token Estimation ---',
        'Estimator file: tokenEstimators.json (loaded OK)',
        'Model pricing: modelPricing.json (loaded OK)',
        'Default char/token ratio: 0.25',
        '',
        '--- Cache ---',
        'Cache entries: 38',
        'Cache size: 0.24 MB',
        'Last rebuild: just now',
    ].join('\n'),
    sessionFiles: Array.from({ length: 12 }, (_, i) => ({
        file: `/home/user/.config/Code/User/workspaceStorage/abc${i}/chatSessions/session-${i}.json`,
        size: 8000 + Math.round(Math.random() * 20000),
        modified: new Date(Date.now() - i * 86400000).toISOString(),
    })),
    detailedSessionFiles: Array.from({ length: 12 }, (_, i) => ({
        file: `/home/user/.config/Code/User/workspaceStorage/abc${i}/chatSessions/session-${i}.json`,
        size: 8000 + Math.round(Math.random() * 20000),
        modified: new Date(Date.now() - i * 86400000).toISOString(),
        interactions: 2 + Math.round(Math.random() * 8),
        contextReferences: { file: 3, selection: 1, implicitSelection: 0, symbol: 0, codebase: 0, workspace: 0, terminal: 0, vscode: 0, terminalLastCommand: 0, terminalSelection: 0, clipboard: 0, changes: 0, outputPanel: 0, problemsPanel: 0, byKind: {}, copilotInstructions: 0, agentsMd: 0, byPath: {} },
        firstInteraction: new Date(Date.now() - i * 86400000 - 3600000).toISOString(),
        lastInteraction: new Date(Date.now() - i * 86400000).toISOString(),
        editorSource: 'code',
        editorName: 'VS Code',
        title: `Session ${i + 1}`,
        repository: i % 2 === 0 ? 'user/my-app' : 'user/toolkit',
    })),
    sessionFolders: [
        { dir: '/home/user/.config/Code/User/workspaceStorage/abc0/chatSessions', count: 12 },
        { dir: '/home/user/.config/Code/User/globalStorage/emptyWindowChatSessions', count: 8 },
    ],
    cacheInfo: { size: 38, sizeInMB: 0.24, lastUpdated: new Date().toISOString(), location: 'VS Code Global State — sessionFileCache (38 entries)', storagePath: null },
    backendStorageInfo: null,
    backendConfigured: false,
    isDebugMode: false,
    globalStateCounters: { openCount: 47, unknownMcpOpenCount: 0, fluencyBannerDismissed: false, unknownMcpDismissedVersion: '' },
};

// ---------------------------------------------------------------------------
// Build harness HTML for one view
// ---------------------------------------------------------------------------
function harnessHtml(title, windowVar, data, bundlePath) {
    const dataJson = JSON.stringify(data).replace(/</g, '\\u003c');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${title}</title>
<style>
  :root { ${vscodeThemeVars} }
  body {
    margin: 0;
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
  }
</style>
</head>
<body data-vscode-theme-kind="vscode-dark">
<div id="root"></div>
<script>
  // Mock the VS Code API that webviews expect
  function acquireVsCodeApi() {
    return {
      postMessage: function() {},
      setState: function() {},
      getState: function() { return undefined; },
    };
  }
  window.${windowVar} = ${dataJson};
</script>
<script src="${bundlePath}"></script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Views to capture
// ---------------------------------------------------------------------------
const views = [
    { name: 'details',     title: 'Details View',    windowVar: '__INITIAL_DETAILS__',     data: detailsData,     bundle: 'details.js',     output: '03-details-panel.png' },
    { name: 'chart',        title: 'Chart View',      windowVar: '__INITIAL_CHART__',       data: chartData,        bundle: 'chart.js',       output: '04-chart-view.png' },
    { name: 'usage',        title: 'Usage Analysis',  windowVar: '__INITIAL_USAGE__',       data: usageData,        bundle: 'usage.js',       output: '05-usage-analysis.png' },
    { name: 'diagnostics',  title: 'Diagnostics',     windowVar: '__INITIAL_DIAGNOSTICS__', data: diagnosticsData,  bundle: 'diagnostics.js', output: '06-diagnostics-panel.png' },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
    let chromium;
    try {
        ({ chromium } = require('playwright'));
    } catch {
        console.error('❌ Playwright not found. Install it first:');
        console.error('   npm install playwright && npx playwright install chromium');
        process.exit(1);
    }

    fs.mkdirSync(outputDir, { recursive: true });

    // Write harness HTML files (useful for local debugging too)
    for (const v of views) {
        // Use relative path from the HTML file to the bundle
        const bundleRelPath = path.relative(outputDir, path.join(distWebview, v.bundle)).replace(/\\/g, '/');
        const html = harnessHtml(v.title, v.windowVar, v.data, bundleRelPath);
        fs.writeFileSync(path.join(outputDir, `harness-${v.name}.html`), html);
    }
    console.log('✅ Harness HTML files written\n');

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        deviceScaleFactor: 2,
    });

    for (const v of views) {
        const harnessPath = path.resolve(path.join(outputDir, `harness-${v.name}.html`));
        const fileUrl = `file://${harnessPath.replace(/\\/g, '/')}`;
        const page = await context.newPage();
        console.log(`📷 ${v.title}`);
        await page.goto(fileUrl, { waitUntil: 'networkidle' });
        // Give webview JS a moment to render the DOM
        await page.waitForTimeout(1500);
        const outPath = path.join(outputDir, v.output);
        await page.screenshot({ path: outPath, fullPage: true });
        const { size } = fs.statSync(outPath);
        console.log(`   ✅ ${v.output} (${(size / 1024).toFixed(1)} KB)`);
        await page.close();
    }

    await browser.close();

    console.log('\n' + '='.repeat(60));
    console.log('✅ All real screenshots captured!\n');
    console.log(`Saved to: ${outputDir}`);
    views.forEach(v => console.log(`  • ${v.output}`));
    console.log('\nThese use the actual compiled webview bundles from dist/webview/.');
}

main().catch(err => {
    console.error('❌ Error:', err.message);
    process.exit(1);
});
