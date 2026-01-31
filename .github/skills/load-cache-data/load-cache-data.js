#!/usr/bin/env node
/**
 * Load Cache Data Script
 * 
 * This script loads and displays the GitHub Copilot Token Tracker's local cache data.
 * The cache stores pre-computed session file statistics to avoid re-processing unchanged files.
 * 
 * The extension's cache is stored in VS Code's globalState, which is persisted in a SQLite
 * database (state.vscdb). This script looks for a cache export file that the extension or
 * tests may write to disk in a known location for inspection.
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

This script loads and displays the GitHub Copilot Token Tracker's local cache data.
The cache contains pre-computed statistics for session files.

CACHE STRUCTURE:
  The cache is stored in VS Code's globalState under the key 'sessionFileCache'.
  Each entry contains:
  - tokens: total token count
  - interactions: number of interactions
  - modelUsage: per-model token breakdown
  - mtime: file modification time (for cache validation)
  - usageAnalysis: detailed usage statistics (optional)

CACHE FILE LOCATIONS:
  This script looks for cache export files in the following locations:
  1. VS Code globalStorage: %APPDATA%\\Code\\User\\globalStorage\\rajbos.copilot-token-tracker\\cache.json
  2. Temp directory: %TEMP%\\copilot-token-tracker-cache.json
  3. Current directory: ./cache-export.json

  To create a cache export for testing or inspection, the extension or tests
  can write the cache data to one of these locations.

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
 * Get possible cache file locations
 * Returns array of paths where cache export files might be located
 */
function getCacheFilePaths() {
    const platform = os.platform();
    const homedir = os.homedir();
    const paths = [];

    // VS Code variants to check
    const vscodeVariants = ['Code', 'Code - Insiders', 'Code - Exploration', 'VSCodium', 'Cursor'];
    // Support both the original author id and the machine-specific id (robbos)
    const extensionId = 'robbos.copilot-token-tracker';
    // Candidate cache file names to look for (include session-cache.json used on the user's machine)
    const candidateFiles = ['session-cache.json'];

    if (platform === 'win32') {
        // Windows: %APPDATA%\Code\User\globalStorage\<extensionId>\<cacheFile>
        const appDataPath = process.env.APPDATA || path.join(homedir, 'AppData', 'Roaming');
        for (const variant of vscodeVariants) {
            for (const fileName of candidateFiles) {
                paths.push(path.join(appDataPath, variant, 'User', 'globalStorage', extensionId, fileName));
            }
        }
        // Also check temp directory for common export names
        const tempPath = process.env.TEMP || process.env.TMP || path.join(homedir, 'AppData', 'Local', 'Temp');
        paths.push(path.join(tempPath, 'copilot-token-tracker-cache.json'));
        paths.push(path.join(tempPath, 'session-cache.json'));
    } else if (platform === 'darwin') {
        // macOS: ~/Library/Application Support/<variant>/User/globalStorage/<extensionId>/<cacheFile>
        for (const variant of vscodeVariants) {
            for (const fileName of candidateFiles) {
                paths.push(path.join(homedir, 'Library', 'Application Support', variant, 'User', 'globalStorage', extensionId, fileName));
            }
        }
        // Also check temp directory
        paths.push(path.join(os.tmpdir(), 'copilot-token-tracker-cache.json'));
        paths.push(path.join(os.tmpdir(), 'session-cache.json'));
    } else {
        // Linux: ~/.config/Code/User/globalStorage/extensionId/cache.json
        const xdgConfigHome = process.env.XDG_CONFIG_HOME || path.join(homedir, '.config');
        for (const variant of vscodeVariants) {
            for (const fileName of candidateFiles) {
                paths.push(path.join(xdgConfigHome, variant, 'User', 'globalStorage', extensionId, fileName));
            }
        }
        // Also check temp directory
        paths.push(path.join(os.tmpdir(), 'copilot-token-tracker-cache.json'));
        paths.push(path.join(os.tmpdir(), 'session-cache.json'));
    }

    // Also check current directory and common export names
    paths.push(path.join(process.cwd(), 'cache-export.json'));
    paths.push(path.join(process.cwd(), 'session-cache.json'));
    
    return paths;
}

/**
 * Try to find and read the cache file
 * Returns { success: boolean, data?: any, filePath?: string, error?: string }
 */
function readCacheFile() {
    const possiblePaths = getCacheFilePaths();
    
    for (const filePath of possiblePaths) {
        try {
            if (fs.existsSync(filePath)) {
                const content = fs.readFileSync(filePath, 'utf8');
                const data = JSON.parse(content);
                return { success: true, data, filePath };
            }
        } catch (error) {
            // Continue to next path if this one fails
            continue;
        }
    }
    
    return { 
        success: false, 
        error: 'No cache file found',
        searchedPaths: possiblePaths 
    };
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
function displayCacheEntries(entries, sourceFile) {
    console.log('='.repeat(80));
    console.log('GitHub Copilot Token Tracker - Local Cache Data');
    console.log('='.repeat(80));
    console.log('');
    
    if (sourceFile) {
        console.log(`Cache file: ${sourceFile}`);
        console.log('');
    }
    
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
}

/**
 * Display message when no cache file is found
 */
function displayNoCacheFound(searchedPaths) {
    console.log('='.repeat(80));
    console.log('GitHub Copilot Token Tracker - Local Cache Data');
    console.log('='.repeat(80));
    console.log('');
    console.log('NO CACHE FILE FOUND');
    console.log('');
    console.log('This script looks for cache export files in the following locations:');
    searchedPaths.forEach(p => console.log(`  - ${p}`));
    console.log('');
    console.log('The extension stores its cache in VS Code\'s internal globalState,');
    console.log('which is not directly accessible from external scripts.');
    console.log('');
    console.log('To export cache data for inspection:');
    console.log('  1. The extension can be modified to write cache to disk');
    console.log('  2. Tests can export cache data to one of the above locations');
    console.log('  3. Use the extension\'s API to access cache at runtime');
    console.log('');
    console.log('See --help for more information on cache structure and access patterns.');
    console.log('='.repeat(80));
}

// Main execution
(function main() {
    // Try to read actual cache file
    const cacheResult = readCacheFile();

    if (cacheResult.success) {
        // Return raw cache data (limit to last N entries) as JSON only
        const entries = Object.entries(cacheResult.data || {});
        entries.sort((a, b) => (b[1].mtime || 0) - (a[1].mtime || 0));
        const limited = entries.slice(0, lastCount);
        const limitedObj = Object.fromEntries(limited);

        const output = {
            cacheFile: cacheResult.filePath,
            requestedCount: lastCount,
            totalCacheEntries: Object.keys(cacheResult.data || {}).length,
            entries: limitedObj
        };

        console.log(JSON.stringify(output));
        return;
    }

    // No cache found: output JSON error
    const errorOut = {
        cacheFound: false,
        error: cacheResult.error,
        searchedPaths: cacheResult.searchedPaths
    };
    console.log(JSON.stringify(errorOut));
    process.exit(1);
})();
