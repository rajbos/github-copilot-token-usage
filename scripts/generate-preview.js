#!/usr/bin/env node
/**
 * Generate Standalone HTML Preview of Details View
 * 
 * This script processes the test data and generates a standalone HTML file
 * showing what the Details view would look like with the test data.
 * 
 * Usage:
 *   node scripts/generate-preview.js [--output path]
 */

const fs = require('fs');
const path = require('path');

// Parse arguments
const args = process.argv.slice(2);
const outputPath = args.includes('--output') 
    ? args[args.indexOf('--output') + 1]
    : path.join(__dirname, '..', 'docs', 'images', 'screenshots', 'details-view-preview.html');

console.log('📸 Generating Details View Preview...\n');

// Load test data
const testDataDir = path.join(__dirname, '..', 'test-data', 'chatSessions');
const testFiles = fs.readdirSync(testDataDir)
    .filter(f => f.endsWith('.json'))
    .map(f => path.join(testDataDir, f));

console.log(`Found ${testFiles.length} test data files`);

// Token estimators (from tokenEstimators.json)
const tokenEstimators = {
    'gpt-4o-2024-11-20': 0.28,
    'gpt-4o': 0.28,
    'claude-3.5-sonnet': 0.29,
    'o1-2024-12-17': 0.27,
    'o1': 0.27
};

// Process test data to calculate stats
let totalTokens = 0;
let totalSessions = 0;
let totalInteractions = 0;
const modelUsage = {};
const editorUsage = { 'Code': { tokens: 0, sessions: 0 } };

for (const filePath of testFiles) {
    const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    totalSessions++;
    
    if (!content.requests || !Array.isArray(content.requests)) continue;
    
    totalInteractions += content.requests.length;
    
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
        
        // Update model usage
        if (!modelUsage[model]) {
            modelUsage[model] = { inputTokens: 0, outputTokens: 0 };
        }
        modelUsage[model].inputTokens += inputTokens;
        modelUsage[model].outputTokens += outputTokens;
        
        totalTokens += inputTokens + outputTokens;
    }
    
    editorUsage['Code'].tokens += totalTokens;
    editorUsage['Code'].sessions++;
}

const avgInteractionsPerSession = totalSessions > 0 ? (totalInteractions / totalSessions).toFixed(1) : '0';
const avgTokensPerSession = totalSessions > 0 ? Math.round(totalTokens / totalSessions) : 0;

// Model pricing (from modelPricing.json)
const modelPricing = {
    'gpt-4o-2024-11-20': { inputCostPerMillion: 2.50, outputCostPerMillion: 10.00 },
    'gpt-4o': { inputCostPerMillion: 2.50, outputCostPerMillion: 10.00 },
    'claude-3.5-sonnet': { inputCostPerMillion: 3.00, outputCostPerMillion: 15.00 },
    'o1-2024-12-17': { inputCostPerMillion: 15.00, outputCostPerMillion: 60.00 },
    'o1': { inputCostPerMillion: 15.00, outputCostPerMillion: 60.00 }
};

let estimatedCost = 0;
for (const [model, usage] of Object.entries(modelUsage)) {
    const pricing = modelPricing[model] || modelPricing['gpt-4o'];
    estimatedCost += (usage.inputTokens / 1_000_000) * pricing.inputCostPerMillion;
    estimatedCost += (usage.outputTokens / 1_000_000) * pricing.outputCostPerMillion;
}

const co2 = (totalTokens / 1000) * 0.00256;
const treesEquivalent = co2 / 21;
const waterUsage = (totalTokens / 1000) * 0.001;

console.log(`\nStatistics:`);
console.log(`  Total sessions: ${totalSessions}`);
console.log(`  Total interactions: ${totalInteractions}`);
console.log(`  Total tokens: ${totalTokens.toLocaleString()}`);
console.log(`  Estimated cost: $${estimatedCost.toFixed(4)}`);

// Generate HTML
const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Copilot Token Tracker - Details View Preview</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            background: #1e1e1e;
            color: #cccccc;
            padding: 20px;
            line-height: 1.6;
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
        .stats-table {
            width: 100%;
            border-collapse: collapse;
            margin: 20px 0;
            background: #1e1e1e;
            border-radius: 4px;
            overflow: hidden;
        }
        .stats-table th {
            background: #2d2d30;
            color: #ffffff;
            padding: 12px;
            text-align: left;
            font-weight: 600;
            border-bottom: 2px solid #007acc;
        }
        .stats-table td {
            padding: 10px 12px;
            border-bottom: 1px solid #3e3e42;
        }
        .stats-table tr:last-child td {
            border-bottom: none;
        }
        .stats-table tr:hover {
            background: #2d2d30;
        }
        .metric-label {
            color: #cccccc;
            font-weight: 500;
        }
        .today-value {
            color: #4ec9b0;
            font-weight: 600;
        }
        .month-value {
            color: #569cd6;
            font-weight: 600;
        }
        .period-header {
            display: flex;
            align-items: center;
            gap: 6px;
        }
        h3 {
            color: #ffffff;
            font-size: 16px;
            margin: 30px 0 15px 0;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .subtitle {
            color: #858585;
            font-size: 12px;
            margin-top: 4px;
        }
        .model-row {
            background: #2d2d30;
            padding: 8px 12px;
            margin: 4px 0;
            border-radius: 4px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .model-name {
            color: #dcdcaa;
            font-weight: 500;
        }
        .model-stats {
            color: #858585;
            font-size: 11px;
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
    </style>
</head>
<body>
    <div class="container">
        <div class="banner">
            <div class="banner-title">🎬 Preview Generated from Test Data</div>
            <div class="banner-text">
                This preview shows what the Details view looks like with ${totalSessions} sample sessions containing ${totalInteractions} interactions.
                Generated on ${new Date().toLocaleString()}
            </div>
        </div>

        <h1>🤖 GitHub Copilot Token Usage</h1>
        
        <table class="stats-table">
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
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td class="metric-label">💬 Total Tokens</td>
                    <td class="today-value">${totalTokens.toLocaleString()}</td>
                    <td class="month-value">${totalTokens.toLocaleString()}</td>
                </tr>
                <tr>
                    <td class="metric-label">🔄 Sessions</td>
                    <td class="today-value">${totalSessions}</td>
                    <td class="month-value">${totalSessions}</td>
                </tr>
                <tr>
                    <td class="metric-label">💭 Avg Interactions/Session</td>
                    <td class="today-value">${avgInteractionsPerSession}</td>
                    <td class="month-value">${avgInteractionsPerSession}</td>
                </tr>
                <tr>
                    <td class="metric-label">📈 Avg Tokens/Session</td>
                    <td class="today-value">${avgTokensPerSession.toLocaleString()}</td>
                    <td class="month-value">${avgTokensPerSession.toLocaleString()}</td>
                </tr>
                <tr>
                    <td class="metric-label">🌍 CO₂ Emissions</td>
                    <td class="today-value">${co2.toFixed(4)}g</td>
                    <td class="month-value">${co2.toFixed(4)}g</td>
                </tr>
                <tr>
                    <td class="metric-label">🌳 Trees to Compensate</td>
                    <td class="today-value">${treesEquivalent.toFixed(6)}</td>
                    <td class="month-value">${treesEquivalent.toFixed(6)}</td>
                </tr>
                <tr>
                    <td class="metric-label">💧 Water Usage</td>
                    <td class="today-value">${waterUsage.toFixed(4)}L</td>
                    <td class="month-value">${waterUsage.toFixed(4)}L</td>
                </tr>
                <tr>
                    <td class="metric-label">💵 Estimated Cost</td>
                    <td class="today-value">$${estimatedCost.toFixed(4)}</td>
                    <td class="month-value">$${estimatedCost.toFixed(4)}</td>
                </tr>
            </tbody>
        </table>

        <h3>🤖 <span>Model Usage</span></h3>
        ${Object.entries(modelUsage).map(([model, usage]) => {
            const total = usage.inputTokens + usage.outputTokens;
            const percentage = ((total / totalTokens) * 100).toFixed(1);
            return `
            <div class="model-row">
                <div>
                    <div class="model-name">${model}</div>
                    <div class="model-stats">
                        In: ${usage.inputTokens.toLocaleString()} • Out: ${usage.outputTokens.toLocaleString()}
                    </div>
                </div>
                <div class="today-value">${total.toLocaleString()} (${percentage}%)</div>
            </div>`;
        }).join('')}

        <h3>🎯 <span>Usage by Editor</span></h3>
        ${Object.entries(editorUsage).map(([editor, usage]) => `
        <div class="model-row">
            <div>
                <div class="model-name">${editor}</div>
                <div class="model-stats">
                    ${usage.sessions} sessions
                </div>
            </div>
            <div class="today-value">${usage.tokens.toLocaleString()}</div>
        </div>`).join('')}

        <div style="margin-top: 40px; padding-top: 20px; border-top: 1px solid #3e3e42; color: #858585; font-size: 12px; text-align: center;">
            Generated by Copilot Token Tracker Screenshot Preview Tool<br>
            Test data: ${testFiles.length} files • Total tokens: ${totalTokens.toLocaleString()}<br>
            <a href="https://github.com/rajbos/github-copilot-token-usage" style="color: #007acc; text-decoration: none;">View on GitHub</a>
        </div>
    </div>
</body>
</html>`;

// Write HTML file
fs.writeFileSync(outputPath, html);
console.log(`\n✅ Preview generated: ${outputPath}`);
console.log(`\n💡 Open this file in a browser to see the Details view preview.`);
console.log(`   You can take a screenshot of the browser window.`);
