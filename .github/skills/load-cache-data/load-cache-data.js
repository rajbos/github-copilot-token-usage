#!/usr/bin/env node
/**
 * Load Cache Data Script
 * 
 * This script demonstrates how to access the GitHub Copilot Token Tracker's
 * local cache data. The cache stores pre-computed session file statistics
 * to avoid re-processing unchanged files.
 * 
 * The cache is stored in VS Code's globalState (extension storage) and is
 * only directly accessible when the extension is running. This script provides
 * utilities and examples for understanding the cache structure and accessing
 * the data through the extension's API.
 * 
 * Usage:
 *   node .github/skills/load-cache-data/load-cache-data.js [--last N] [--json]
 * 
 * Options:
 *   --last N     Show only the last N cache entries (default: 10)
 *   --json       Output as JSON
 *   --help       Show this help message
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Parse command line arguments
const args = process.argv.slice(2);
const lastCount = (() => {
    const lastIndex = args.indexOf('--last');
    if (lastIndex !== -1 && args[lastIndex + 1]) {
        return parseInt(args[lastIndex + 1], 10) || 10;
    }
    return 10;
})();
const jsonOutput = args.includes('--json');
const showHelp = args.includes('--help');

if (showHelp) {
    console.log(`
Load Cache Data Script

This script provides utilities for accessing the GitHub Copilot Token Tracker's
local cache data. The cache contains pre-computed statistics for session files.

CACHE STRUCTURE:
  The cache is stored in VS Code's globalState under the key 'sessionFileCache'.
  Each entry contains:
  - tokens: total token count
  - interactions: number of interactions
  - modelUsage: per-model token breakdown
  - mtime: file modification time (for cache validation)
  - usageAnalysis: detailed usage statistics (optional)

ACCESSING THE CACHE:
  Since the cache is stored in VS Code's internal database, it can only be
  accessed through the extension's API at runtime. This script demonstrates
  the cache structure and provides example code.

USAGE:
  node .github/skills/load-cache-data/load-cache-data.js [--last N] [--json]

OPTIONS:
  --last N     Show only the last N cache entries (default: 10)
  --json       Output as JSON format
  --help       Show this help message

EXAMPLES:
  # Show last 10 cache entries
  node .github/skills/load-cache-data/load-cache-data.js

  # Show last 5 cache entries as JSON
  node .github/skills/load-cache-data/load-cache-data.js --last 5 --json

  # Show all cache entries
  node .github/skills/load-cache-data/load-cache-data.js --last 99999

FOR DEVELOPERS:
  To access the cache programmatically within the extension:
  
  // Get cache data from global state
  const cacheData = context.globalState.get('sessionFileCache');
  const cacheEntries = Object.entries(cacheData || {});
  
  // Get last 10 entries (sorted by modification time)
  const last10 = cacheEntries
    .sort((a, b) => (b[1].mtime || 0) - (a[1].mtime || 0))
    .slice(0, 10);

  // Display cache entries
  for (const [filePath, cacheEntry] of last10) {
    console.log({
      file: filePath,
      tokens: cacheEntry.tokens,
      interactions: cacheEntry.interactions,
      modelUsage: cacheEntry.modelUsage,
      lastModified: new Date(cacheEntry.mtime).toISOString()
    });
  }
`);
    process.exit(0);
}

/**
 * Try to find and read the VS Code state database
 * This is a simplified approach and may not work in all cases
 */
function findVSCodeStatePaths() {
    const platform = os.platform();
    const homedir = os.homedir();
    const paths = [];

    const vscodeVariants = ['Code', 'Code - Insiders', 'Code - Exploration', 'VSCodium', 'Cursor'];

    if (platform === 'win32') {
        const appDataPath = process.env.APPDATA || path.join(homedir, 'AppData', 'Roaming');
        for (const variant of vscodeVariants) {
            paths.push(path.join(appDataPath, variant, 'User'));
        }
    } else if (platform === 'darwin') {
        for (const variant of vscodeVariants) {
            paths.push(path.join(homedir, 'Library', 'Application Support', variant, 'User'));
        }
    } else {
        const xdgConfigHome = process.env.XDG_CONFIG_HOME || path.join(homedir, '.config');
        for (const variant of vscodeVariants) {
            paths.push(path.join(xdgConfigHome, variant, 'User'));
        }
    }

    return paths.filter(p => fs.existsSync(p));
}

/**
 * Generate example cache data for demonstration
 * This simulates what real cache data would look like
 */
function generateExampleCacheData(count = 10) {
    const exampleData = {};
    const now = Date.now();
    const models = ['gpt-4o', 'gpt-4o-mini', 'claude-3.5-sonnet', 'o3-mini'];
    const editors = ['VS Code', 'VS Code Insiders', 'Cursor'];
    
    for (let i = 0; i < count; i++) {
        const model = models[i % models.length];
        const editor = editors[i % editors.length];
        const filePath = `/home/user/.config/${editor}/User/workspaceStorage/abc123/chatSessions/session-${i}.json`;
        const mtime = now - (i * 3600000); // Each entry 1 hour older
        
        exampleData[filePath] = {
            tokens: Math.floor(Math.random() * 10000) + 1000,
            interactions: Math.floor(Math.random() * 50) + 1,
            modelUsage: {
                [model]: {
                    inputTokens: Math.floor(Math.random() * 5000) + 500,
                    outputTokens: Math.floor(Math.random() * 5000) + 500
                }
            },
            mtime: mtime,
            usageAnalysis: {
                toolCalls: {
                    total: Math.floor(Math.random() * 10),
                    byTool: {
                        'view': Math.floor(Math.random() * 5),
                        'edit': Math.floor(Math.random() * 3),
                        'bash': Math.floor(Math.random() * 4)
                    }
                },
                modeUsage: {
                    ask: Math.floor(Math.random() * 20) + 5,
                    edit: Math.floor(Math.random() * 10),
                    agent: Math.floor(Math.random() * 5)
                },
                contextReferences: {
                    file: Math.floor(Math.random() * 8),
                    selection: Math.floor(Math.random() * 5),
                    symbol: Math.floor(Math.random() * 3),
                    codebase: Math.floor(Math.random() * 2),
                    workspace: Math.floor(Math.random() * 4),
                    terminal: Math.floor(Math.random() * 1),
                    vscode: Math.floor(Math.random() * 1)
                },
                mcpTools: {
                    total: Math.floor(Math.random() * 5),
                    byServer: { 'mcp-server': Math.floor(Math.random() * 3) },
                    byTool: { 'tool-name': Math.floor(Math.random() * 2) }
                }
            }
        };
    }
    
    return exampleData;
}

/**
 * Format cache data for display
 */
function formatCacheEntries(cacheData, limit = 10) {
    const entries = Object.entries(cacheData);
    
    // Sort by modification time (most recent first)
    entries.sort((a, b) => (b[1].mtime || 0) - (a[1].mtime || 0));
    
    // Take last N entries
    const limitedEntries = entries.slice(0, limit);
    
    return limitedEntries.map(([filePath, cacheEntry]) => ({
        file: path.basename(filePath),
        fullPath: filePath,
        tokens: cacheEntry.tokens,
        interactions: cacheEntry.interactions,
        modelUsage: cacheEntry.modelUsage,
        lastModified: cacheEntry.mtime ? new Date(cacheEntry.mtime).toISOString() : 'unknown',
        usageAnalysis: cacheEntry.usageAnalysis
    }));
}

/**
 * Display cache entries in human-readable format
 */
function displayCacheEntries(entries) {
    console.log('='.repeat(80));
    console.log('GitHub Copilot Token Tracker - Local Cache Data');
    console.log('='.repeat(80));
    console.log('');
    console.log(`Showing ${entries.length} cache entries (sorted by most recent):`);
    console.log('');
    
    entries.forEach((entry, index) => {
        console.log(`${index + 1}. ${entry.file}`);
        console.log(`   Path: ${entry.fullPath}`);
        console.log(`   Tokens: ${entry.tokens.toLocaleString()}`);
        console.log(`   Interactions: ${entry.interactions}`);
        console.log(`   Last Modified: ${entry.lastModified}`);
        console.log(`   Model Usage:`);
        
        for (const [model, usage] of Object.entries(entry.modelUsage)) {
            console.log(`     - ${model}:`);
            console.log(`       Input: ${usage.inputTokens.toLocaleString()} tokens`);
            console.log(`       Output: ${usage.outputTokens.toLocaleString()} tokens`);
        }
        
        if (entry.usageAnalysis) {
            console.log(`   Usage Analysis:`);
            console.log(`     Tool Calls: ${entry.usageAnalysis.toolCalls.total}`);
            console.log(`     Mode Usage: Ask=${entry.usageAnalysis.modeUsage.ask}, Edit=${entry.usageAnalysis.modeUsage.edit}, Agent=${entry.usageAnalysis.modeUsage.agent}`);
            const contextRefs = entry.usageAnalysis.contextReferences;
            const totalRefs = Object.values(contextRefs).reduce((sum, val) => sum + val, 0);
            console.log(`     Context References: ${totalRefs} total`);
        }
        
        console.log('');
    });
    
    console.log('='.repeat(80));
    console.log('');
    console.log('NOTE: This is example/demonstration data.');
    console.log('To access real cache data, use the extension\'s API at runtime.');
    console.log('See --help for more information.');
}

// Main execution
(function main() {
    console.log('');
    console.log('Copilot Token Tracker - Cache Data Viewer');
    console.log('Platform:', os.platform());
    console.log('Home directory:', os.homedir());
    console.log('');
    
    // Try to find VS Code installations
    const vscodePaths = findVSCodeStatePaths();
    if (vscodePaths.length > 0) {
        console.log('VS Code installations found:');
        vscodePaths.forEach(p => console.log('  ' + p));
        console.log('');
    } else {
        console.log('No VS Code installations found.');
        console.log('');
    }
    
    // Since we can't directly access VS Code's internal database without
    // special libraries, we'll show example data with a notice
    console.log(`NOTE: The cache is stored in VS Code's internal database (state.vscdb)`);
    console.log('      and is only accessible through the extension\'s API at runtime.');
    console.log('      Below is example data demonstrating the cache structure:');
    console.log('');
    
    // Generate example cache data
    const exampleCache = generateExampleCacheData(lastCount);
    const formattedEntries = formatCacheEntries(exampleCache, lastCount);
    
    if (jsonOutput) {
        // JSON output
        console.log(JSON.stringify({
            platform: os.platform(),
            homeDirectory: os.homedir(),
            vscodePathsFound: vscodePaths,
            cacheEntriesShown: formattedEntries.length,
            requestedCount: lastCount,
            isExampleData: true,
            entries: formattedEntries
        }, null, 2));
    } else {
        // Human-readable output
        displayCacheEntries(formattedEntries);
    }
    
    console.log('For more information, run with --help');
    console.log('');
})();
