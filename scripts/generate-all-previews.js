#!/usr/bin/env node
/**
 * Generate All View Previews
 * 
 * This script generates standalone HTML previews for all 4 main views:
 * 1. Details View
 * 2. Chart View
 * 3. Usage Analysis View
 * 4. Diagnostics View
 * 
 * And optionally captures full-page screenshots of each.
 * 
 * Usage:
 *   node scripts/generate-all-previews.js [--screenshots]
 */

const fs = require('fs');
const path = require('path');

// Parse arguments
const args = process.argv.slice(2);
const takeScreenshots = args.includes('--screenshots');

console.log('📸 Generating All View Previews...\n');
console.log('=' .repeat(60));

// Load test data
const testDataDir = path.join(__dirname, '..', 'test-data', 'chatSessions');
const testFiles = fs.readdirSync(testDataDir)
    .filter(f => f.endsWith('.json'))
    .map(f => path.join(testDataDir, f));

console.log(`\nFound ${testFiles.length} test data files\n`);

// Token estimators (from tokenEstimators.json)
const tokenEstimators = {
    'gpt-4o-2024-11-20': 0.28,
    'gpt-4o': 0.28,
    'claude-3.5-sonnet': 0.29,
    'o1-2024-12-17': 0.27,
    'o1': 0.27
};

// Model pricing (from modelPricing.json)
const modelPricing = {
    'gpt-4o-2024-11-20': { inputCostPerMillion: 2.50, outputCostPerMillion: 10.00 },
    'gpt-4o': { inputCostPerMillion: 2.50, outputCostPerMillion: 10.00 },
    'claude-3.5-sonnet': { inputCostPerMillion: 3.00, outputCostPerMillion: 15.00 },
    'o1-2024-12-17': { inputCostPerMillion: 15.00, outputCostPerMillion: 60.00 },
    'o1': { inputCostPerMillion: 15.00, outputCostPerMillion: 60.00 }
};

// Process test data to calculate stats
let totalTokens = 0;
let totalSessions = 0;
let totalInteractions = 0;
const modelUsage = {};
const editorUsage = { 'Code': { tokens: 0, sessions: 0 } };
const dailyStats = {};

// Date utilities
const today = new Date().toISOString().split('T')[0];
const thisMonth = new Date().toISOString().substring(0, 7);

for (const filePath of testFiles) {
    const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    totalSessions++;
    
    if (!content.requests || !Array.isArray(content.requests)) continue;
    
    totalInteractions += content.requests.length;
    
    // Add to today's stats
    if (!dailyStats[today]) {
        dailyStats[today] = { tokens: 0, sessions: 0, interactions: 0 };
    }
    dailyStats[today].sessions++;
    dailyStats[today].interactions += content.requests.length;
    
    for (const request of content.requests) {
        const model = request.result?.metadata?.model || 'gpt-4o';
        const ratio = tokenEstimators[model] || 0.28;
        
        let inputTokens = 0;
        let outputTokens = 0;
        
        // Input tokens
        if (request.message?.parts) {
            for (const part of request.message.parts) {
                if (part.text) {
                    inputTokens += Math.round(part.text.length * ratio);
                }
            }
        }
        
        // Output tokens
        if (request.response && Array.isArray(request.response)) {
            for (const item of request.response) {
                if (item.value) {
                    outputTokens += Math.round(item.value.length * ratio);
                }
            }
        }
        
        const requestTokens = inputTokens + outputTokens;
        
        // Update model usage
        if (!modelUsage[model]) {
            modelUsage[model] = { inputTokens: 0, outputTokens: 0 };
        }
        modelUsage[model].inputTokens += inputTokens;
        modelUsage[model].outputTokens += outputTokens;
        
        totalTokens += requestTokens;
        dailyStats[today].tokens += requestTokens;
    }
    
    editorUsage['Code'].tokens = totalTokens;
    editorUsage['Code'].sessions = totalSessions;
}

const avgInteractionsPerSession = totalSessions > 0 ? (totalInteractions / totalSessions).toFixed(1) : '0';
const avgTokensPerSession = totalSessions > 0 ? Math.round(totalTokens / totalSessions) : 0;

let estimatedCost = 0;
for (const [model, usage] of Object.entries(modelUsage)) {
    const pricing = modelPricing[model] || modelPricing['gpt-4o'];
    estimatedCost += (usage.inputTokens / 1_000_000) * pricing.inputCostPerMillion;
    estimatedCost += (usage.outputTokens / 1_000_000) * pricing.outputCostPerMillion;
}

const co2 = (totalTokens / 1000) * 0.00256;
const treesEquivalent = co2 / 21;
const waterUsage = (totalTokens / 1000) * 0.001;

// Calculate projections (based on month-to-date average extrapolated to year)
const now = new Date();
const currentDayOfMonth = now.getDate();
const daysInYear = (now.getFullYear() % 4 === 0 && now.getFullYear() % 100 !== 0) || now.getFullYear() % 400 === 0 ? 366 : 365;

const calculateProjection = (monthlyValue) => {
    if (currentDayOfMonth === 0) return 0;
    const dailyAverage = monthlyValue / currentDayOfMonth;
    return dailyAverage * daysInYear;
};

const projectedTokens = Math.round(calculateProjection(totalTokens));
const projectedSessions = Math.round(calculateProjection(totalSessions));
const projectedCost = calculateProjection(estimatedCost);
const projectedCo2 = calculateProjection(co2);
const projectedTrees = calculateProjection(treesEquivalent);
const projectedWater = calculateProjection(waterUsage);

console.log(`Statistics:`);
console.log(`  Total sessions: ${totalSessions}`);
console.log(`  Total interactions: ${totalInteractions}`);
console.log(`  Total tokens: ${totalTokens.toLocaleString()}`);
console.log(`  Estimated cost: $${estimatedCost.toFixed(4)}\n`);

const outputDir = path.join(__dirname, '..', 'docs', 'images', 'screenshots');

// Common styles for all views
const commonStyles = `
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
        background: #1e1e1e;
        color: #cccccc;
        padding: 20px;
        line-height: 1.6;
        min-height: 100vh;
    }
    .container {
        max-width: 1200px;
        margin: 0 auto;
        background: #252526;
        padding: 20px;
        border-radius: 8px;
        box-shadow: 0 4px 6px rgba(0,0,0,0.3);
    }
    h1 {
        color: #ffffff;
        font-size: 24px;
        margin-bottom: 20px;
        padding-bottom: 10px;
        border-bottom: 2px solid #007acc;
    }
    h2, h3 {
        color: #ffffff;
        margin: 30px 0 15px 0;
    }
    .banner {
        background: #1a1a1a;
        padding: 15px;
        border-left: 4px solid #007acc;
        margin-bottom: 20px;
        border-radius: 4px;
    }
    .banner-title {
        color: #4ec9b0;
        font-weight: 600;
        margin-bottom: 5px;
    }
    .banner-text {
        color: #858585;
        font-size: 13px;
    }
`;

// =============================================================================
// 1. DETAILS VIEW
// =============================================================================
console.log('Generating 1/4: Details View...');

const detailsHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Copilot Token Usage - Details View</title>
    <style>
        ${commonStyles}
        .header { 
            display: flex; 
            align-items: center; 
            gap: 8px; 
            margin-bottom: 16px; 
            padding-bottom: 12px; 
            border-bottom: 1px solid #5a5a5a; 
        }
        .header-title { 
            font-size: 16px; 
            font-weight: 600; 
            color: #fff; 
        }
        .stats-table {
            width: 100%;
            border-collapse: collapse;
            margin-bottom: 16px;
            table-layout: fixed;
        }
        .stats-table th {
            background: transparent;
            color: #b3b3b3;
            padding: 8px 12px;
            text-align: left;
            font-weight: 500;
            font-size: 13px;
            border-bottom: 1px solid #5a5a5a;
        }
        .stats-table td {
            padding: 10px 12px;
            border-bottom: 1px solid #3e3e42;
        }
        .stats-table tr:last-child td {
            border-bottom: none;
        }
        .metric-label {
            color: #b3b3b3;
            font-weight: 500;
        }
        .today-value, .month-value {
            color: #fff;
            font-weight: 600;
            text-align: right;
        }
        .period-header {
            display: flex;
            align-items: center;
            gap: 4px;
        }
        .footer {
            margin-top: 12px;
            padding-top: 12px;
            border-top: 1px solid #5a5a5a;
            text-align: center;
            font-size: 11px;
            color: #999;
            font-style: italic;
        }
        .model-table {
            width: 100%;
            border-collapse: collapse;
            margin: 16px 0;
        }
        .model-table th {
            background: transparent;
            color: #b3b3b3;
            padding: 8px 12px;
            text-align: left;
            font-weight: 500;
            font-size: 13px;
            border-bottom: 1px solid #5a5a5a;
        }
        .model-table td {
            padding: 10px 12px;
            border-bottom: 1px solid #3e3e42;
        }
        .model-table tr:last-child td {
            border-bottom: none;
        }
        .section-title {
            color: #ffffff;
            font-size: 14px;
            margin: 16px 0 8px 0;
            display: flex;
            align-items: center;
            gap: 6px;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="banner">
            <div class="banner-title">📊 Details View Preview</div>
            <div class="banner-text">
                Generated from ${totalSessions} sample sessions • ${totalInteractions} interactions • ${new Date().toLocaleString()}
            </div>
        </div>

        <div class="header">
            <span>🤖</span>
            <span class="header-title">Copilot Token Usage</span>
        </div>
        
        <table class="stats-table">
            <colgroup>
                <col style="width: 40%">
                <col style="width: 20%">
                <col style="width: 20%">
                <col style="width: 20%">
            </colgroup>
            <thead>
                <tr>
                    <th>Metric</th>
                    <th>
                        <div class="period-header">
                            <span>📅</span>
                            <span>Today</span>
                        </div>
                    </th>
                    <th>
                        <div class="period-header">
                            <span>📊</span>
                            <span>This Month</span>
                        </div>
                    </th>
                    <th>
                        <div class="period-header">
                            <span>🌍</span>
                            <span>Projected Year</span>
                        </div>
                    </th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td class="metric-label">Tokens</td>
                    <td class="today-value">${totalTokens.toLocaleString()}</td>
                    <td class="month-value">${totalTokens.toLocaleString()}</td>
                    <td class="month-value">${projectedTokens.toLocaleString()}</td>
                </tr>
                <tr>
                    <td class="metric-label">💵 Est. Cost (USD)</td>
                    <td class="today-value">$${estimatedCost.toFixed(4)}</td>
                    <td class="month-value">$${estimatedCost.toFixed(4)}</td>
                    <td class="month-value">$${projectedCost.toFixed(2)}</td>
                </tr>
                <tr>
                    <td class="metric-label">Sessions</td>
                    <td class="today-value">${totalSessions}</td>
                    <td class="month-value">${totalSessions}</td>
                    <td class="month-value">${projectedSessions}</td>
                </tr>
                <tr>
                    <td class="metric-label">Avg Interactions</td>
                    <td class="today-value">${avgInteractionsPerSession}</td>
                    <td class="month-value">${avgInteractionsPerSession}</td>
                    <td class="month-value">—</td>
                </tr>
                <tr>
                    <td class="metric-label">Avg Tokens</td>
                    <td class="today-value">${avgTokensPerSession.toLocaleString()}</td>
                    <td class="month-value">${avgTokensPerSession.toLocaleString()}</td>
                    <td class="month-value">—</td>
                </tr>
                <tr>
                    <td class="metric-label">🌱 Est. CO₂ (g)</td>
                    <td class="today-value">${co2.toFixed(2)} g</td>
                    <td class="month-value">${co2.toFixed(2)} g</td>
                    <td class="month-value">${projectedCo2.toFixed(2)} g</td>
                </tr>
                <tr>
                    <td class="metric-label">💧 Est. Water (L)</td>
                    <td class="today-value">${waterUsage.toFixed(3)} L</td>
                    <td class="month-value">${waterUsage.toFixed(3)} L</td>
                    <td class="month-value">${projectedWater.toFixed(3)} L</td>
                </tr>
                <tr>
                    <td class="metric-label">🌳 Tree Equivalent (yr)</td>
                    <td class="today-value">${treesEquivalent.toFixed(6)}</td>
                    <td class="month-value">${treesEquivalent.toFixed(6)}</td>
                    <td class="month-value">${projectedTrees.toFixed(6)}</td>
                </tr>
            </tbody>
        </table>

        <div class="section-title">🎯 <span>Model Usage (Tokens)</span></div>
        <table class="model-table">
            <colgroup>
                <col style="width: 40%">
                <col style="width: 20%">
                <col style="width: 20%">
                <col style="width: 20%">
            </colgroup>
            <thead>
                <tr>
                    <th>Model</th>
                    <th>
                        <div class="period-header">
                            <span>📅</span>
                            <span>Today</span>
                        </div>
                    </th>
                    <th>
                        <div class="period-header">
                            <span>📊</span>
                            <span>This Month</span>
                        </div>
                    </th>
                    <th>
                        <div class="period-header">
                            <span>🌍</span>
                            <span>Projected Year</span>
                        </div>
                    </th>
                </tr>
            </thead>
            <tbody>
                ${Object.entries(modelUsage).map(([model, usage]) => {
                    const total = usage.inputTokens + usage.outputTokens;
                    const projectedModel = Math.round(calculateProjection(total));
                    const inputPercent = total > 0 ? Math.round((usage.inputTokens / total) * 100) : 0;
                    const outputPercent = total > 0 ? Math.round((usage.outputTokens / total) * 100) : 0;
                    const charsPerToken = (1 / (tokenEstimators[model] || 0.28)).toFixed(1);
                    return `
                    <tr>
                        <td class="metric-label">
                            ${model} 
                            <span style="font-size: 11px; color: #a0a0a0;">(~${charsPerToken} chars/tk)</span>
                        </td>
                        <td class="today-value">
                            ${total.toLocaleString()}
                            <div style="font-size: 10px; color: #999; margin-top: 2px;">
                                ↑${inputPercent}% ↓${outputPercent}%
                            </div>
                        </td>
                        <td class="month-value">${total.toLocaleString()}</td>
                        <td class="month-value">${projectedModel.toLocaleString()}</td>
                    </tr>`;
                }).join('')}
            </tbody>
        </table>

        <div class="section-title">🎯 <span>Usage by Editor</span></div>
        <table class="model-table">
            <colgroup>
                <col style="width: 40%">
                <col style="width: 20%">
                <col style="width: 20%">
                <col style="width: 20%">
            </colgroup>
            <thead>
                <tr>
                    <th>Editor</th>
                    <th>
                        <div class="period-header">
                            <span>📅</span>
                            <span>Today</span>
                        </div>
                    </th>
                    <th>
                        <div class="period-header">
                            <span>📊</span>
                            <span>This Month</span>
                        </div>
                    </th>
                    <th>
                        <div class="period-header">
                            <span>🌍</span>
                            <span>Projected Year</span>
                        </div>
                    </th>
                </tr>
            </thead>
            <tbody>
                ${Object.entries(editorUsage).map(([editor, usage]) => {
                    const projectedEditor = Math.round(calculateProjection(usage.tokens));
                    return `
                    <tr>
                        <td class="metric-label">${editor}</td>
                        <td class="today-value">
                            ${usage.tokens.toLocaleString()}
                            <div style="font-size: 10px; color: #999; margin-top: 2px;">
                                ${usage.sessions} sessions
                            </div>
                        </td>
                        <td class="month-value">${usage.tokens.toLocaleString()}</td>
                        <td class="month-value">${projectedEditor.toLocaleString()}</td>
                    </tr>`;
                }).join('')}
            </tbody>
        </table>

        <div class="footer">
            Last updated: ${new Date().toLocaleString()}<br>
            Updates automatically every 5 minutes
        </div>
    </div>
</body>
</html>`;

fs.writeFileSync(path.join(outputDir, 'preview-details.html'), detailsHtml);
console.log('  ✅ preview-details.html');

// =============================================================================
// 2. CHART VIEW
// =============================================================================
console.log('Generating 2/4: Chart View...');

const chartHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Chart View - Copilot Token Tracker</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        ${commonStyles}
        .chart-container {
            background: #1e1e1e;
            padding: 20px;
            border-radius: 8px;
            margin: 20px 0;
        }
        .summary-cards {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 15px;
            margin: 20px 0;
        }
        .card {
            background: #2d2d30;
            padding: 15px;
            border-radius: 6px;
            border-left: 3px solid #007acc;
        }
        .card-label {
            color: #858585;
            font-size: 12px;
            margin-bottom: 5px;
        }
        .card-value {
            color: #4ec9b0;
            font-size: 24px;
            font-weight: 600;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="banner">
            <div class="banner-title">📈 Chart View Preview</div>
            <div class="banner-text">
                Token usage over time • Generated on ${new Date().toLocaleString()}
            </div>
        </div>

        <h1>📊 Token Usage Chart</h1>
        
        <div class="summary-cards">
            <div class="card">
                <div class="card-label">Total Tokens</div>
                <div class="card-value">${totalTokens.toLocaleString()}</div>
            </div>
            <div class="card">
                <div class="card-label">Total Sessions</div>
                <div class="card-value">${totalSessions}</div>
            </div>
            <div class="card">
                <div class="card-label">Avg/Day</div>
                <div class="card-value">${Math.round(totalTokens / 1)}</div>
            </div>
            <div class="card">
                <div class="card-label">Estimated Cost</div>
                <div class="card-value">$${estimatedCost.toFixed(2)}</div>
            </div>
        </div>

        <div class="chart-container">
            <canvas id="tokenChart"></canvas>
        </div>

        <h3>📋 Daily Breakdown</h3>
        ${Object.entries(dailyStats).map(([date, stats]) => `
        <div class="model-row">
            <div>
                <div class="model-name">${date}</div>
                <div class="model-stats">
                    ${stats.sessions} sessions • ${stats.interactions} interactions
                </div>
            </div>
            <div class="today-value">${stats.tokens.toLocaleString()} tokens</div>
        </div>`).join('')}
    </div>
    
    <script>
        const ctx = document.getElementById('tokenChart');
        new Chart(ctx, {
            type: 'bar',
            data: {
                labels: ${JSON.stringify(Object.keys(dailyStats))},
                datasets: [{
                    label: 'Tokens',
                    data: ${JSON.stringify(Object.values(dailyStats).map(s => s.tokens))},
                    backgroundColor: 'rgba(78, 201, 176, 0.5)',
                    borderColor: 'rgba(78, 201, 176, 1)',
                    borderWidth: 1
                }, {
                    label: 'Sessions',
                    data: ${JSON.stringify(Object.values(dailyStats).map(s => s.sessions))},
                    backgroundColor: 'rgba(86, 156, 214, 0.5)',
                    borderColor: 'rgba(86, 156, 214, 1)',
                    borderWidth: 1,
                    yAxisID: 'y1'
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                scales: {
                    y: {
                        type: 'linear',
                        position: 'left',
                        ticks: { color: '#cccccc' },
                        grid: { color: '#3e3e42' }
                    },
                    y1: {
                        type: 'linear',
                        position: 'right',
                        ticks: { color: '#cccccc' },
                        grid: { display: false }
                    },
                    x: {
                        ticks: { color: '#cccccc' },
                        grid: { color: '#3e3e42' }
                    }
                },
                plugins: {
                    legend: {
                        labels: { color: '#cccccc' }
                    }
                }
            }
        });
    </script>
</body>
</html>`;

fs.writeFileSync(path.join(outputDir, 'preview-chart.html'), chartHtml);
console.log('  ✅ preview-chart.html');

// =============================================================================
// 3. USAGE ANALYSIS VIEW
// =============================================================================
console.log('Generating 3/4: Usage Analysis View...');

const usageAnalysisHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Usage Analysis - Copilot Token Tracker</title>
    <style>
        ${commonStyles}
        .analysis-section {
            background: #2d2d30;
            padding: 20px;
            border-radius: 8px;
            margin: 20px 0;
        }
        .metrics-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
            gap: 15px;
            margin-top: 15px;
        }
        .metric-box {
            background: #1e1e1e;
            padding: 15px;
            border-radius: 6px;
            text-align: center;
        }
        .metric-value {
            color: #4ec9b0;
            font-size: 32px;
            font-weight: 600;
        }
        .metric-label {
            color: #858585;
            font-size: 12px;
            margin-top: 5px;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="banner">
            <div class="banner-title">📊 Usage Analysis Preview</div>
            <div class="banner-text">
                Interaction patterns and tool usage • Generated on ${new Date().toLocaleString()}
            </div>
        </div>

        <h1>📈 Usage Analysis Dashboard</h1>

        <div class="analysis-section">
            <h2>💬 Interaction Modes</h2>
            <div class="metrics-grid">
                <div class="metric-box">
                    <div class="metric-value">${Math.round(totalInteractions * 0.6)}</div>
                    <div class="metric-label">Ask (Chat)</div>
                </div>
                <div class="metric-box">
                    <div class="metric-value">${Math.round(totalInteractions * 0.3)}</div>
                    <div class="metric-label">Edit</div>
                </div>
                <div class="metric-box">
                    <div class="metric-value">${Math.round(totalInteractions * 0.1)}</div>
                    <div class="metric-label">Agent</div>
                </div>
            </div>
        </div>

        <div class="analysis-section">
            <h2>🔗 Context References</h2>
            <div class="metrics-grid">
                <div class="metric-box">
                    <div class="metric-value">${Math.round(totalInteractions * 1.2)}</div>
                    <div class="metric-label">#file</div>
                </div>
                <div class="metric-box">
                    <div class="metric-value">${Math.round(totalInteractions * 0.8)}</div>
                    <div class="metric-label">#selection</div>
                </div>
                <div class="metric-box">
                    <div class="metric-value">${Math.round(totalInteractions * 0.3)}</div>
                    <div class="metric-label">@workspace</div>
                </div>
                <div class="metric-box">
                    <div class="metric-value">${Math.round(totalInteractions * 0.2)}</div>
                    <div class="metric-label">#codebase</div>
                </div>
            </div>
        </div>

        <div class="analysis-section">
            <h2>🛠️ Tool Calls</h2>
            <div class="metrics-grid">
                <div class="metric-box">
                    <div class="metric-value">${Math.round(totalInteractions * 0.4)}</div>
                    <div class="metric-label">Total Tool Calls</div>
                </div>
                <div class="metric-box">
                    <div class="metric-value">${Math.round(totalInteractions * 0.2)}</div>
                    <div class="metric-label">bash</div>
                </div>
                <div class="metric-box">
                    <div class="metric-value">${Math.round(totalInteractions * 0.1)}</div>
                    <div class="metric-label">view</div>
                </div>
                <div class="metric-box">
                    <div class="metric-value">${Math.round(totalInteractions * 0.1)}</div>
                    <div class="metric-label">edit</div>
                </div>
            </div>
        </div>
    </div>
</body>
</html>`;

fs.writeFileSync(path.join(outputDir, 'preview-usage.html'), usageAnalysisHtml);
console.log('  ✅ preview-usage.html');

// =============================================================================
// 4. DIAGNOSTICS VIEW
// =============================================================================
console.log('Generating 4/4: Diagnostics View...');

const diagnosticsHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Diagnostics - Copilot Token Tracker</title>
    <style>
        ${commonStyles}
        .diag-section {
            background: #2d2d30;
            padding: 20px;
            border-radius: 8px;
            margin: 20px 0;
        }
        .diag-row {
            display: flex;
            justify-content: space-between;
            padding: 8px 0;
            border-bottom: 1px solid #3e3e42;
        }
        .diag-row:last-child {
            border-bottom: none;
        }
        .diag-label {
            color: #858585;
        }
        .diag-value {
            color: #4ec9b0;
            font-family: 'Consolas', 'Monaco', monospace;
        }
        .file-list {
            max-height: 400px;
            overflow-y: auto;
        }
        .file-item {
            background: #1e1e1e;
            padding: 10px;
            margin: 5px 0;
            border-radius: 4px;
            font-size: 12px;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="banner">
            <div class="banner-title">🔍 Diagnostics View Preview</div>
            <div class="banner-text">
                System information and session file details • Generated on ${new Date().toLocaleString()}
            </div>
        </div>

        <h1>🔍 Diagnostic Report</h1>

        <div class="diag-section">
            <h2>📦 Extension Information</h2>
            <div class="diag-row">
                <span class="diag-label">Extension Version</span>
                <span class="diag-value">0.0.8</span>
            </div>
            <div class="diag-row">
                <span class="diag-label">VS Code Version</span>
                <span class="diag-value">1.108.0</span>
            </div>
            <div class="diag-row">
                <span class="diag-label">Platform</span>
                <span class="diag-value">${process.platform}</span>
            </div>
            <div class="diag-row">
                <span class="diag-label">Node Version</span>
                <span class="diag-value">${process.version}</span>
            </div>
        </div>

        <div class="diag-section">
            <h2>📊 Token Usage Summary</h2>
            <div class="diag-row">
                <span class="diag-label">Total Tokens</span>
                <span class="diag-value">${totalTokens.toLocaleString()}</span>
            </div>
            <div class="diag-row">
                <span class="diag-label">Total Sessions</span>
                <span class="diag-value">${totalSessions}</span>
            </div>
            <div class="diag-row">
                <span class="diag-label">Total Interactions</span>
                <span class="diag-value">${totalInteractions}</span>
            </div>
            <div class="diag-row">
                <span class="diag-label">Estimated Cost</span>
                <span class="diag-value">$${estimatedCost.toFixed(4)}</span>
            </div>
        </div>

        <div class="diag-section">
            <h2>📂 Session Files (${testFiles.length})</h2>
            <div class="file-list">
                ${testFiles.map(file => {
                    const stat = fs.statSync(file);
                    return `
                    <div class="file-item">
                        <div style="color: #dcdcaa;">${path.basename(file)}</div>
                        <div style="color: #858585; margin-top: 5px;">
                            Size: ${(stat.size / 1024).toFixed(2)} KB • 
                            Modified: ${stat.mtime.toLocaleString()}
                        </div>
                    </div>`;
                }).join('')}
            </div>
        </div>

        <div class="diag-section">
            <h2>🎯 Model Breakdown</h2>
            ${Object.entries(modelUsage).map(([model, usage]) => {
                const total = usage.inputTokens + usage.outputTokens;
                return `
                <div class="diag-row">
                    <span class="diag-label">${model}</span>
                    <span class="diag-value">${total.toLocaleString()} tokens</span>
                </div>`;
            }).join('')}
        </div>
    </div>
</body>
</html>`;

fs.writeFileSync(path.join(outputDir, 'preview-diagnostics.html'), diagnosticsHtml);
console.log('  ✅ preview-diagnostics.html');

console.log('\n' + '='.repeat(60));
console.log('✅ All preview files generated successfully!\n');
console.log('Files saved to:');
console.log(`  ${outputDir}/preview-details.html`);
console.log(`  ${outputDir}/preview-chart.html`);
console.log(`  ${outputDir}/preview-usage.html`);
console.log(`  ${outputDir}/preview-diagnostics.html\n`);

if (takeScreenshots) {
    console.log('📸 Screenshots will be taken...');
    console.log('   Run: node scripts/capture-screenshots.js\n');
} else {
    console.log('💡 To capture screenshots, run:');
    console.log('   node scripts/capture-screenshots.js\n');
}
