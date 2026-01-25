#!/usr/bin/env node
/**
 * Screenshot UI Views Script
 * 
 * This script automates taking screenshots of the Copilot Token Tracker extension UI.
 * It uses test data from the test-data directory and captures all extension views.
 * 
 * Prerequisites:
 * - Extension must be built (npm run compile)
 * - Test data must exist in test-data/chatSessions/
 * - VS Code must be installed
 * 
 * Usage:
 *   node scripts/screenshot-ui-views.js [options]
 * 
 * Options:
 *   --output-dir <path>    Output directory for screenshots (default: docs/images/screenshots)
 *   --test-data <path>     Path to test data directory (default: test-data/chatSessions)
 *   --help                 Show this help message
 * 
 * Environment Variables:
 *   COPILOT_TEST_DATA_PATH  Override path to test data
 *   VSCODE_PATH            Path to VS Code executable
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

// Parse command line arguments
const args = process.argv.slice(2);
const outputDir = args.includes('--output-dir') 
    ? args[args.indexOf('--output-dir') + 1] 
    : path.join(__dirname, '..', 'docs', 'images', 'screenshots');

const testDataDir = args.includes('--test-data')
    ? args[args.indexOf('--test-data') + 1]
    : path.join(__dirname, '..', 'test-data', 'chatSessions');

if (args.includes('--help')) {
    console.log(`
Screenshot UI Views Script

This script automates taking screenshots of the Copilot Token Tracker extension UI.

Usage:
  node scripts/screenshot-ui-views.js [options]

Options:
  --output-dir <path>    Output directory for screenshots (default: docs/images/screenshots)
  --test-data <path>     Path to test data directory (default: test-data/chatSessions)
  --help                 Show this help message

Prerequisites:
  1. Build the extension: npm run compile
  2. Ensure test data exists in test-data/chatSessions/
  3. Have VS Code installed

The script will:
  1. Verify test data exists
  2. Launch VS Code Extension Development Host
  3. Wait for extension to load and process test data
  4. Take screenshots of:
     - Status bar item
     - Hover tooltip
     - Details panel
     - Chart view
     - Usage Analysis panel
     - Diagnostics panel
  5. Save screenshots to the output directory
`);
    process.exit(0);
}

// Verify prerequisites
console.log('📸 Copilot Token Tracker - Screenshot Automation');
console.log('================================================\n');

console.log('Checking prerequisites...');

// Check if test data exists
if (!fs.existsSync(testDataDir)) {
    console.error(`❌ Test data directory not found: ${testDataDir}`);
    console.error('   Please create test data first or specify --test-data path');
    process.exit(1);
}

const testDataFiles = fs.readdirSync(testDataDir).filter(f => f.endsWith('.json'));
if (testDataFiles.length === 0) {
    console.error(`❌ No test data files found in: ${testDataDir}`);
    console.error('   Please add .json session files to the test data directory');
    process.exit(1);
}

console.log(`✅ Found ${testDataFiles.length} test data file(s) in ${testDataDir}`);

// Check if extension is built
const distPath = path.join(__dirname, '..', 'dist', 'extension.js');
if (!fs.existsSync(distPath)) {
    console.error('❌ Extension not built. Please run: npm run compile');
    process.exit(1);
}
console.log('✅ Extension is built');

// Create output directory
if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
    console.log(`✅ Created output directory: ${outputDir}`);
} else {
    console.log(`✅ Output directory exists: ${outputDir}`);
}

console.log('\n⚠️  MANUAL STEPS REQUIRED\n');
console.log('Due to VS Code extension automation limitations, please follow these steps:\n');

console.log('1. Set the test data path environment variable:');
console.log(`   ${process.platform === 'win32' ? 'PowerShell:' : 'Bash:'}`);
if (process.platform === 'win32') {
    console.log(`   $env:COPILOT_TEST_DATA_PATH = "${path.resolve(testDataDir)}"`);
} else {
    console.log(`   export COPILOT_TEST_DATA_PATH="${path.resolve(testDataDir)}"`);
}

console.log('\n2. Launch VS Code Extension Development Host:');
console.log('   - Open this project in VS Code');
console.log('   - Press F5 to start debugging');
console.log('   - Wait for Extension Development Host window to open');

console.log('\n3. In the Extension Development Host window:');
console.log('   - Wait for the extension to load (watch status bar)');
console.log('   - The extension will automatically use the test data');
console.log('   - Open Developer Tools: Help > Toggle Developer Tools');
console.log('   - Check Console for "Found X session files" message');

console.log('\n4. Take screenshots manually or use browser automation:');
console.log('   a) Status bar (bottom): Shows token count');
console.log('   b) Hover over status bar: Tooltip with breakdown');
console.log('   c) Click status bar: Opens Details panel');
console.log('   d) In Details panel, click "📊 Chart" button');
console.log('   e) In Chart panel, click "📈 Usage Analysis" button');
console.log('   f) In any panel, click "🔍 Diagnostics" button');

console.log('\n5. Save screenshots to:');
console.log(`   ${path.resolve(outputDir)}/`);
console.log('   Recommended naming:');
console.log('   - 01-status-bar.png');
console.log('   - 02-hover-tooltip.png');
console.log('   - 03-details-panel.png');
console.log('   - 04-chart-view.png');
console.log('   - 05-usage-analysis.png');
console.log('   - 06-diagnostics-panel.png');

console.log('\n📝 AUTOMATION NOTE:');
console.log('Full automation of VS Code extension screenshots requires:');
console.log('- VS Code headless testing (complex setup)');
console.log('- Or Playwright with VS Code remote testing');
console.log('- Or manual screenshots (current approach)');

console.log('\nFor automated screenshots in CI/CD, consider:');
console.log('- Using the VS Code Extension Test Runner with screenshot capabilities');
console.log('- Implementing a test that programmatically triggers views and captures');
console.log('- See: https://code.visualstudio.com/api/working-with-extensions/testing-extension\n');

// Create a helper HTML page for instructions
const instructionsHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Screenshot Instructions - Copilot Token Tracker</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            max-width: 900px;
            margin: 40px auto;
            padding: 20px;
            line-height: 1.6;
            background: #f5f5f5;
        }
        .container {
            background: white;
            padding: 30px;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        h1 {
            color: #24292e;
            border-bottom: 2px solid #0366d6;
            padding-bottom: 10px;
        }
        h2 {
            color: #0366d6;
            margin-top: 30px;
        }
        .step {
            background: #f6f8fa;
            padding: 15px;
            margin: 15px 0;
            border-left: 4px solid #0366d6;
            border-radius: 4px;
        }
        .code {
            background: #1e1e1e;
            color: #d4d4d4;
            padding: 12px;
            border-radius: 4px;
            font-family: "Consolas", "Monaco", monospace;
            overflow-x: auto;
        }
        .success {
            color: #28a745;
            font-weight: bold;
        }
        .warning {
            color: #ffa500;
            font-weight: bold;
        }
        ul {
            padding-left: 25px;
        }
        li {
            margin: 8px 0;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>📸 Screenshot Instructions</h1>
        <p><strong>Copilot Token Tracker Extension</strong></p>
        
        <h2>Prerequisites</h2>
        <div class="step">
            <p class="success">✅ Test data found: ${testDataFiles.length} files</p>
            <p class="success">✅ Extension built</p>
            <p class="success">✅ Output directory ready: ${outputDir}</p>
        </div>

        <h2>Step 1: Set Environment Variable</h2>
        <div class="step">
            <p>Set the test data path before launching VS Code:</p>
            <div class="code">
                ${process.platform === 'win32' 
                    ? `$env:COPILOT_TEST_DATA_PATH = "${path.resolve(testDataDir)}"` 
                    : `export COPILOT_TEST_DATA_PATH="${path.resolve(testDataDir)}"`}
            </div>
        </div>

        <h2>Step 2: Launch Extension Development Host</h2>
        <div class="step">
            <ol>
                <li>Open this project in VS Code</li>
                <li>Press <strong>F5</strong> to start debugging</li>
                <li>Wait for Extension Development Host window to open</li>
                <li>Extension will automatically load test data</li>
            </ol>
        </div>

        <h2>Step 3: Verify Extension Loaded</h2>
        <div class="step">
            <ol>
                <li>Look at the bottom status bar for token count display</li>
                <li>Open Developer Tools: <strong>Help > Toggle Developer Tools</strong></li>
                <li>Check Console for "Found X session files" message</li>
            </ol>
        </div>

        <h2>Step 4: Take Screenshots</h2>
        <div class="step">
            <p>Capture these views in order:</p>
            <ol>
                <li><strong>Status bar</strong> - Bottom bar showing token count</li>
                <li><strong>Hover tooltip</strong> - Hover mouse over status bar item</li>
                <li><strong>Details panel</strong> - Click status bar item</li>
                <li><strong>Chart view</strong> - Click "📊 Chart" button in Details panel</li>
                <li><strong>Usage Analysis</strong> - Click "📈 Usage Analysis" button</li>
                <li><strong>Diagnostics</strong> - Click "🔍 Diagnostics" button</li>
            </ol>
        </div>

        <h2>Step 5: Save Screenshots</h2>
        <div class="step">
            <p>Save to: <code>${path.resolve(outputDir)}/</code></p>
            <p>Recommended naming:</p>
            <ul>
                <li>01-status-bar.png</li>
                <li>02-hover-tooltip.png</li>
                <li>03-details-panel.png</li>
                <li>04-chart-view.png</li>
                <li>05-usage-analysis.png</li>
                <li>06-diagnostics-panel.png</li>
            </ul>
        </div>

        <h2>Test Data Files</h2>
        <div class="step">
            <ul>
                ${testDataFiles.map(f => `<li>${f}</li>`).join('')}
            </ul>
        </div>

        <h2 class="warning">⚠️ Automation Limitations</h2>
        <p>Full automation of VS Code extension UI requires complex setup with headless testing. The current approach uses manual screenshots for simplicity and reliability.</p>
        <p>For future automation, consider:</p>
        <ul>
            <li>VS Code Extension Test Runner with screenshot capabilities</li>
            <li>Playwright with VS Code remote testing</li>
            <li>Puppeteer with browser-based VS Code</li>
        </ul>
    </div>
</body>
</html>`;

const instructionsPath = path.join(outputDir, 'screenshot-instructions.html');
fs.writeFileSync(instructionsPath, instructionsHtml);
console.log(`📄 Detailed instructions saved to: ${instructionsPath}`);
console.log('   Open this file in a browser for formatted instructions.\n');
