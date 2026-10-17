// Entry point of the headless render check (scripts/validate-desktop-render.js).
//
// Bundled and run under plain Node, with HOME pointed at a temporary directory, it
// builds every panel's page with the desktop's own panel builder (panelPage.ts) over
// session files written below, and writes the pages to the output directory. The
// check script then loads them in a browser. Nothing here imports `electron`.
//
// Usage: node renderPanels.js <outDir> <populated|empty>
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    discoverSessionFiles,
    calculateDetailedStats,
    calculateUsageAnalysisStats,
    calculateViewStats,
    buildChartPayload,
    buildEfficiencyPayload,
} from '../../../cli/src/helpers';
import { withUsageAnalysisViewStats } from '../../../cli/src/usageAnalysisView';
import { buildPanelHtml, PANEL_IDS, type PanelDataSource } from '../panelPage';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A small Claude Code session (two models, cache tokens) that started `daysAgo` days ago. */
function claudeCodeSession(sessionId: string, daysAgo: number): string {
    const start = Date.now() - daysAgo * DAY_MS;
    const at = (seconds: number) => new Date(start + seconds * 1000).toISOString();
    const base = { sessionId, cwd: '/work/demo', isSidechain: false };
    return [
        { ...base, type: 'user', timestamp: at(0), message: { role: 'user', content: 'Add a README' } },
        { ...base, type: 'assistant', timestamp: at(5), requestId: `${sessionId}-r1`, message: { id: `${sessionId}-m1`, role: 'assistant', model: 'claude-sonnet-4.5', content: [{ type: 'text', text: 'Done.' }], usage: { input_tokens: 100, cache_creation_input_tokens: 1000, cache_read_input_tokens: 5000, output_tokens: 200 } } },
        { ...base, type: 'user', timestamp: at(60), message: { role: 'user', content: 'Summarize it' } },
        { ...base, type: 'assistant', timestamp: at(63), requestId: `${sessionId}-r2`, message: { id: `${sessionId}-m2`, role: 'assistant', model: 'claude-haiku-4.5', content: [{ type: 'text', text: 'Summary.' }], usage: { input_tokens: 400, output_tokens: 80 } } },
    ].map(line => JSON.stringify(line)).join('\n') + '\n';
}

function writeFixtureSessions(): void {
    const dir = path.join(os.homedir(), '.claude', 'projects', '-work-demo');
    fs.mkdirSync(dir, { recursive: true });
    [0, 1, 3, 9, 20].forEach((daysAgo, i) => {
        const id = `00000000-0000-4000-8000-00000000000${i}`;
        fs.writeFileSync(path.join(dir, `${id}.jsonl`), claudeCodeSession(id, daysAgo));
    });
}

async function main(): Promise<void> {
    const [outDir, scenario] = process.argv.slice(2);
    if (!outDir || (scenario !== 'populated' && scenario !== 'empty')) {
        throw new Error('usage: renderPanels.js <outDir> <populated|empty>');
    }
    if (scenario === 'populated') { writeFixtureSessions(); }

    // Uncached equivalents of main.ts's loaders: the same cli/src calls over the discovered files.
    const files = await discoverSessionFiles();
    const viewStats = () => calculateViewStats(files, false);
    const usage = async () => withUsageAnalysisViewStats(files, await calculateUsageAnalysisStats(files), { workspaceFolderPaths: [] });
    const source: PanelDataSource = {
        getStats: () => calculateDetailedStats(files),
        getUsageStats: usage,
        getSessionFiles: async () => files,
        getChartPayload: async () => buildChartPayload((await viewStats()).dailyStats),
        getEfficiencyPayload: async () => {
            const [stats, usageStats] = await Promise.all([viewStats(), usage()]);
            return buildEfficiencyPayload({ dailyStats: stats.dailyStats, usage: usageStats, sessionInputs: stats.efficiencySessionInputs });
        },
    };

    fs.mkdirSync(outDir, { recursive: true });
    for (const isDark of [true, false]) {
        for (const panel of PANEL_IDS) {
            const html = await buildPanelHtml(panel, { locale: 'en-US', isDark }, source, '0.0.0-render-check');
            fs.writeFileSync(path.join(outDir, `${panel}.${isDark ? 'dark' : 'light'}.html`), html);
        }
    }
    console.log(JSON.stringify({ sessionFiles: files.length, panels: [...PANEL_IDS] }));
}

main().catch((err) => { console.error(err); process.exit(1); });
