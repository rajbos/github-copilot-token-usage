// Local minimal type definitions to avoid importing from extension (prevents circular imports)
type ModelUsage = { [model: string]: { inputTokens: number; outputTokens: number } };
type EditorUsage = { [editor: string]: { tokens: number; sessions: number } };

interface DetailedStats {
    today: {
        tokens: number;
        sessions: number;
        avgInteractionsPerSession: number;
        avgTokensPerSession: number;
        modelUsage: ModelUsage;
        editorUsage: EditorUsage;
        co2: number;
        treesEquivalent: number;
        waterUsage: number;
        estimatedCost: number;
    };
    month: {
        tokens: number;
        sessions: number;
        avgInteractionsPerSession: number;
        avgTokensPerSession: number;
        modelUsage: ModelUsage;
        editorUsage: EditorUsage;
        co2: number;
        treesEquivalent: number;
        waterUsage: number;
        estimatedCost: number;
    };
    lastUpdated: Date;
}

// Minimal tracker interface for functions we need from the main class
export interface TrackerHelper {
    getEditorIcon(editor: string): string;
    getModelDisplayName(model: string): string;
    tokenEstimators: { [key: string]: number };
    co2Per1kTokens: number;
    waterUsagePer1kTokens: number;
    cacheFilePath?: string;
}

export function getDetailsHtml(tracker: TrackerHelper, stats: DetailedStats): string {
    const usedModels = new Set([
        ...Object.keys(stats.today.modelUsage),
        ...Object.keys(stats.month.modelUsage)
    ]);

    const now = new Date();
    const currentDayOfMonth = now.getDate();
    const daysInYear = (now.getFullYear() % 4 === 0 && now.getFullYear() % 100 !== 0) || now.getFullYear() % 400 === 0 ? 366 : 365;

    const calculateProjection = (monthlyValue: number) => {
        if (currentDayOfMonth === 0) { return 0; }
        const dailyAverage = monthlyValue / currentDayOfMonth;
        return dailyAverage * daysInYear;
    };

    const projectedTokens = calculateProjection(stats.month.tokens);
    const projectedSessions = calculateProjection(stats.month.sessions);
    const projectedCo2 = calculateProjection(stats.month.co2);
    const projectedTrees = calculateProjection(stats.month.treesEquivalent);
    const projectedWater = calculateProjection(stats.month.waterUsage);
    const projectedCost = calculateProjection(stats.month.estimatedCost);

    // Helper sub-templates
    const getEditorUsageHtml = (): string => {
        const allEditors = new Set([
            ...Object.keys(stats.today.editorUsage),
            ...Object.keys(stats.month.editorUsage)
        ]);
        if (allEditors.size === 0) { return ''; }
        const todayTotal = Object.values(stats.today.editorUsage).reduce((s: number, e: any) => s + e.tokens, 0);
        const monthTotal = Object.values(stats.month.editorUsage).reduce((s: number, e: any) => s + e.tokens, 0);

        const rows = Array.from(allEditors).sort().map(editor => {
            const todayUsage = stats.today.editorUsage[editor] || { tokens: 0, sessions: 0 };
            const monthUsage = stats.month.editorUsage[editor] || { tokens: 0, sessions: 0 };
            const todayPercent = todayTotal > 0 ? ((todayUsage.tokens / todayTotal) * 100).toFixed(1) : '0.0';
            const monthPercent = monthTotal > 0 ? ((monthUsage.tokens / monthTotal) * 100).toFixed(1) : '0.0';
            return `
                <tr>
                    <td class="metric-label">${tracker.getEditorIcon(editor)} ${editor}</td>
                    <td class="today-value">${todayUsage.tokens.toLocaleString()}<div style="font-size:10px;color:#999;margin-top:2px;">${todayPercent}% · ${todayUsage.sessions} sessions</div></td>
                    <td class="month-value">${monthUsage.tokens.toLocaleString()}<div style="font-size:10px;color:#999;margin-top:2px;">${monthPercent}% · ${monthUsage.sessions} sessions</div></td>
                </tr>`;
        }).join('');

        return `
            <div style="margin-top:16px;">
                <h3 style="color:#ffffff;font-size:14px;margin-bottom:8px;display:flex;align-items:center;gap:6px;">🎯<span>Usage by Editor</span></h3>
                <table class="stats-table">
                    <colgroup><col class="metric-col"><col class="value-col"><col class="value-col"></colgroup>
                    <thead><tr><th>Editor</th><th><div class="period-header"><span>📅</span><span>Today</span></div></th><th><div class="period-header"><span>📊</span><span>This Month</span></div></th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>`;
    };

    const getModelUsageHtml = (): string => {
        const allModels = new Set([
            ...Object.keys(stats.today.modelUsage),
            ...Object.keys(stats.month.modelUsage)
        ]);
        if (allModels.size === 0) { return ''; }

        const rows = Array.from(allModels).map(model => {
            const todayUsage = stats.today.modelUsage[model] || { inputTokens: 0, outputTokens: 0 };
            const monthUsage = stats.month.modelUsage[model] || { inputTokens: 0, outputTokens: 0 };
            const todayTotal = todayUsage.inputTokens + todayUsage.outputTokens;
            const monthTotal = monthUsage.inputTokens + monthUsage.outputTokens;
            const charsPerToken = ((1 / (tracker.tokenEstimators[model] || 0.25))).toFixed(1);
            return `
                <tr>
                    <td class="metric-label">${tracker.getModelDisplayName(model)} <span style="font-size:11px;color:#a0a0a0;">(~${charsPerToken} chars/tk)</span></td>
                    <td class="today-value">${todayTotal.toLocaleString()}<div style="font-size:10px;color:#999;margin-top:2px;">↑${todayUsage.inputTokens>0?Math.round((todayUsage.inputTokens/todayTotal)*100):0}% ↓${todayUsage.outputTokens>0?Math.round((todayUsage.outputTokens/todayTotal)*100):0}%</div></td>
                    <td class="month-value">${monthTotal.toLocaleString()}</td>
                    <td class="month-value">${Math.round(calculateProjection(monthTotal)).toLocaleString()}</td>
                </tr>`;
        }).join('');

        return `
            <div style="margin-top:16px;">
                <h3 style="color:#ffffff;font-size:14px;margin-bottom:8px;display:flex;align-items:center;gap:6px;">🎯<span>Model Usage (Tokens)</span></h3>
                <table class="stats-table">
                    <colgroup><col class="metric-col"><col class="value-col"><col class="value-col"><col class="value-col"></colgroup>
                    <thead><tr><th>Model</th><th><div class="period-header"><span>📅</span><span>Today</span></div></th><th><div class="period-header"><span>📊</span><span>This Month</span></div></th><th><div class="period-header"><span>🌍</span><span>Projected Year</span></div></th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>`;
    };

    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Copilot Token Usage</title>
        <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #2d2d2d; color: #cccccc; padding: 16px; line-height: 1.5; min-width: 320px; }
            .container { background: #3c3c3c; border: 1px solid #5a5a5a; border-radius: 8px; padding: 16px; box-shadow: 0 4px 12px rgba(0,0,0,0.3); }
            .header { display:flex; align-items:center; gap:8px; margin-bottom:16px; padding-bottom:12px; border-bottom:1px solid #5a5a5a; }
            .header-title { font-size:16px; font-weight:600; color:#fff; }
            .stats-table { width:100%; border-collapse:collapse; margin-bottom:16px; table-layout:fixed; }
            .metric-label { color:#b3b3b3; font-weight:500; }
            .today-value, .month-value { color:#fff; font-weight:600; text-align:right; }
            .period-header { display:flex; align-items:center; gap:4px; }
            .footer { margin-top:12px; padding-top:12px; border-top:1px solid #5a5a5a; text-align:center; font-size:11px; color:#999; font-style:italic; }
            .refresh-button { background:#0e639c; border:1px solid #1177bb; color:#fff; padding:8px 16px; border-radius:4px; cursor:pointer; font-size:12px; font-weight:500; margin-top:12px; display:inline-flex; gap:6px; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header"><span class="header-icon">🤖</span><span class="header-title">Copilot Token Usage</span></div>
            <table class="stats-table">
                <colgroup><col class="metric-col"><col class="value-col"><col class="value-col"><col class="value-col"></colgroup>
                <thead><tr><th>Metric</th><th><div class="period-header"><span>📅</span><span>Today</span></div></th><th><div class="period-header"><span>📊</span><span>This Month</span></div></th><th><div class="period-header"><span>🌍</span><span>Projected Year</span></div></th></tr></thead>
                <tbody>
                    <tr><td class="metric-label">Tokens</td><td class="today-value">${stats.today.tokens.toLocaleString()}</td><td class="month-value">${stats.month.tokens.toLocaleString()}</td><td class="month-value">${Math.round(projectedTokens).toLocaleString()}</td></tr>
                    <tr><td class="metric-label">💵 Est. Cost (USD)</td><td class="today-value">$${stats.today.estimatedCost.toFixed(4)}</td><td class="month-value">$${stats.month.estimatedCost.toFixed(4)}</td><td class="month-value">$${projectedCost.toFixed(2)}</td></tr>
                    <tr><td class="metric-label">Sessions</td><td class="today-value">${stats.today.sessions}</td><td class="month-value">${stats.month.sessions}</td><td class="month-value">${Math.round(projectedSessions)}</td></tr>
                </tbody>
            </table>

            ${getEditorUsageHtml()}
            ${getModelUsageHtml()}

            <div class="footer">Last updated: ${stats.lastUpdated.toLocaleString()}<br>Updates automatically every 5 minutes</div>
        </div>
    </body>
    </html>`;
}

export default { getDetailsHtml };
