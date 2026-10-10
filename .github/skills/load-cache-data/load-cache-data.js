#!/usr/bin/env node
/**
 * Load Cache Data Script
 * 
 * This script loads and displays the AI Engineering Fluency's local cache data.
 * The cache stores pre-computed session file statistics to avoid re-processing unchanged files.
 * 
 * The extension persists its cache to a snapshot file in its globalStorage directory
 * (cache_<prod|dev>.snapshot.json), which this script reads. The cache is not kept in
 * VS Code's globalState.
 * 
 * Usage:
 *   node .github/skills/load-cache-data/load-cache-data.js [--last N] [--json] [--include-sensitive]
 * 
 * Options:
 *   --last N     Show only the last N cache entries (default: 10, maximum: 100)
 *   --json       Output as JSON
 *   --include-sensitive  Include session titles, prompts, paths, and repository URLs
 *   --help       Show this help message
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_LAST_COUNT = 10;
const MAX_LAST_COUNT = 100;

// Parse command line arguments
const args = process.argv.slice(2);
const includeSensitive = args.includes('--include-sensitive');
const showHelp = args.includes('--help');

function parseLastCount() {
    for (let index = 0; index < args.length; index++) {
        if (args[index] !== '--last') {
            continue;
        }

        const value = args[index + 1];
        if (!value || !/^\d+$/.test(value)) {
            throw new Error('--last must be a positive integer.');
        }

        const count = Number(value);
        if (Number.isNaN(count) || count < 1) {
            throw new Error('--last must be a positive integer.');
        }

        return Math.min(count, MAX_LAST_COUNT);
    }
    return DEFAULT_LAST_COUNT;
}

if (showHelp) {
    console.log(`
Load Cache Data Script

This script loads and displays the GitHub Copilot Token Tracker's local cache data.
The cache contains pre-computed statistics for session files.

CACHE STRUCTURE:
  The cache is persisted to cache_<prod|dev>.snapshot.json in the extension's
  globalStorage directory, as an envelope whose 'entries' map is keyed by session
  file path. Each entry contains:
  - tokens: total token count
  - interactions: number of interactions
  - modelUsage: per-model token breakdown
  - mtime: file modification time (for cache validation)
  - usageAnalysis: detailed usage statistics (optional)

CACHE FILE LOCATIONS:
  This script looks only in VS Code globalStorage for Code, Insiders,
  Exploration, VSCodium, and Cursor. It reads the extension's shared cache
  snapshot (cache_prod.snapshot.json, then cache_dev.snapshot.json), falling back
  to a legacy session-cache.json export. It does not trust files in temp or
  current-working directories.

  Session titles, prompts, correction excerpts, workspace paths, referenced file
  paths, per-file-type line counts, repository URLs, and cache file paths are
  omitted by default. Use --include-sensitive only when you intend to expose them.

USAGE:
  node .github/skills/load-cache-data/load-cache-data.js [--last N] [--json] [--include-sensitive]

OPTIONS:
  --last N     Show only the last N cache entries (default: 10, maximum: 100)
  --json       Output as JSON format
  --include-sensitive  Include session titles, prompts, paths, and repository URLs
  --help       Show this help message

EXAMPLES:
  # Show last 10 cache entries
  node .github/skills/load-cache-data/load-cache-data.js

  # Show last 5 cache entries as JSON
  node .github/skills/load-cache-data/load-cache-data.js --last 5 --json

  # Include session-identifying fields only when explicitly needed
  node .github/skills/load-cache-data/load-cache-data.js --include-sensitive --json

FOR DEVELOPERS:
  To access the cache programmatically within the extension:
  
  // CacheManager.cache is a Map<string, SessionFileCache>
  const cacheEntries = Array.from(cacheManager.cache.entries());
  
  // Get last 10 entries (sorted by modification time)
  const last10 = cacheEntries
    .sort((a, b) => (b[1].mtime || 0) - (a[1].mtime || 0))
    .slice(0, 10);

  // Display cache entries
  for (const [index, [, cacheEntry]] of last10.entries()) {
    console.log({
      session: \`session-\${index + 1}\`,
      tokens: cacheEntry.tokens,
      interactions: cacheEntry.interactions,
      modelUsage: cacheEntry.modelUsage,
      lastModified: new Date(cacheEntry.mtime).toISOString()
    });
  }
`);
    process.exit(0);
}

let lastCount;
try {
    lastCount = parseLastCount();
} catch (error) {
    console.error(error.message);
    process.exit(2);
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
    // Current extension id (publisher.name, lowercased) and the pre-rename id
    const extensionIds = ['robbos.ai-engineering-fluency', 'robbos.copilot-token-tracker'];
    // The extension's shared cache snapshot (CacheManager.getSharedSnapshotPath(): prod, then
    // Extension Development Host), then a legacy flat export written by hand or by tests
    const candidateFiles = ['cache_prod.snapshot.json', 'cache_dev.snapshot.json', 'session-cache.json'];

    if (platform === 'win32') {
        // Windows: %APPDATA%\Code\User\globalStorage\<extensionId>\<cacheFile>
        const appDataPath = process.env.APPDATA || path.join(homedir, 'AppData', 'Roaming');
        for (const variant of vscodeVariants) {
            for (const extensionId of extensionIds) {
                for (const fileName of candidateFiles) {
                    paths.push(path.join(appDataPath, variant, 'User', 'globalStorage', extensionId, fileName));
                }
            }
        }
    } else if (platform === 'darwin') {
        // macOS: ~/Library/Application Support/<variant>/User/globalStorage/<extensionId>/<cacheFile>
        for (const variant of vscodeVariants) {
            for (const extensionId of extensionIds) {
                for (const fileName of candidateFiles) {
                    paths.push(path.join(homedir, 'Library', 'Application Support', variant, 'User', 'globalStorage', extensionId, fileName));
                }
            }
        }
    } else {
        // Linux: ~/.config/Code/User/globalStorage/extensionId/cache.json
        const xdgConfigHome = process.env.XDG_CONFIG_HOME || path.join(homedir, '.config');
        for (const variant of vscodeVariants) {
            for (const extensionId of extensionIds) {
                for (const fileName of candidateFiles) {
                    paths.push(path.join(xdgConfigHome, variant, 'User', 'globalStorage', extensionId, fileName));
                }
            }
        }
    }
    
    return paths;
}

const SAFE_CACHE_ENTRY_FIELDS = new Set([
    'tokens', 'interactions', 'modelUsage', 'mtime', 'size', 'detailsOnly',
    'usageAnalysis', 'taskCategory', 'taskCategoryShares', 'firstInteraction',
    'lastInteraction', 'repositoryResolved', 'thinkingTokens', 'actualTokens',
    'cacheReadTokens', 'modelTurns', 'debugLogInputTokens', 'debugLogOutputTokens',
    'debugLogChecked', 'subAgentCalls', 'copilotExactCostDollars', 'truncationCount',
    'messagesRemovedByTruncation', 'maxRequestInputTokens', 'contextTier',
    'dailyRollups', 'linesAdded', 'linesRemoved'
    // languageUsage is omitted: it is keyed by file extension, or by the whole basename for
    // extensionless files (Dockerfile, .env, private file names)
]);

// usageAnalysis fields whose maps are keyed by session-supplied names
const NAME_KEYED_USAGE_FIELDS = ['toolCalls', 'mcpTools', 'skillCalls'];

// CorrectionMoment fields that are counts, flags, timestamps or this repo's own labels
const SAFE_CORRECTION_MOMENT_FIELDS = new Set([
    'type', 'turnNumber', 'timestamp', 'retried', 'matchedPattern', 'intensity', 'escalated', 'corroboratedBy'
]);

function sanitizeCacheEntry(cacheEntry) {
    if (!cacheEntry || typeof cacheEntry !== 'object' || Array.isArray(cacheEntry)) {
        return {};
    }
    const safeEntry = Object.fromEntries(
        Object.entries(cacheEntry).filter(([key]) => SAFE_CACHE_ENTRY_FIELDS.has(key))
    );

    const usageAnalysis = safeEntry.usageAnalysis;
    if (usageAnalysis && typeof usageAnalysis === 'object' && !Array.isArray(usageAnalysis)) {
        const safeUsageAnalysis = { ...usageAnalysis };
        delete safeUsageAnalysis.firstUserPrompt;
        const contextReferences = safeUsageAnalysis.contextReferences;
        if (contextReferences && typeof contextReferences === 'object' && !Array.isArray(contextReferences)) {
            // byPath is keyed by the referenced files' local paths
            const safeContextReferences = { ...contextReferences };
            delete safeContextReferences.byPath;
            safeUsageAnalysis.contextReferences = safeContextReferences;
        }
        const editScope = safeUsageAnalysis.editScope;
        if (editScope && typeof editScope === 'object' && !Array.isArray(editScope)) {
            // Same basename-keyed map as the top-level languageUsage
            const safeEditScope = { ...editScope };
            delete safeEditScope.languageUsage;
            safeUsageAnalysis.editScope = safeEditScope;
        }
        const modelSwitching = safeUsageAnalysis.modelSwitching;
        if (isPlainObject(modelSwitching)) {
            // selectedModelExtensions lists the ids of the extensions that supplied the selected
            // models (e.g. a private or internal model-provider extension), not model ids
            const safeModelSwitching = { ...modelSwitching };
            delete safeModelSwitching.selectedModelExtensions;
            safeUsageAnalysis.modelSwitching = safeModelSwitching;
        }
        // Tool, MCP server/tool and skill names come straight from the session (an MCP server
        // or skill can carry a private project or customer name). Keep each usage object's
        // scalar totals; drop its name-keyed maps (byTool, byServer, byName, latencyBy*, ...).
        for (const field of NAME_KEYED_USAGE_FIELDS) {
            const usage = safeUsageAnalysis[field];
            if (isPlainObject(usage)) {
                safeUsageAnalysis[field] = Object.fromEntries(
                    Object.entries(usage).filter(([, value]) => value === null || typeof value !== 'object')
                );
            }
        }
        if (Array.isArray(safeUsageAnalysis.correctionMoments)) {
            // Allowlist: snippet (message text), tool (session tool name) and file (local path)
            // and any future field are dropped
            safeUsageAnalysis.correctionMoments = safeUsageAnalysis.correctionMoments
                .filter(isPlainObject)
                .map(moment => Object.fromEntries(
                    Object.entries(moment).filter(([key]) => SAFE_CORRECTION_MOMENT_FIELDS.has(key))
                ));
        }
        safeEntry.usageAnalysis = safeUsageAnalysis;
    }

    return safeEntry;
}

/**
 * Drop credentials (user:token@) from a remote URL. Applied even with
 * --include-sensitive: opting in to repository URLs is not opting in to secrets.
 */
function stripUrlUserinfo(remote) {
    if (typeof remote !== 'string') {
        return remote;
    }
    return remote.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^\/@]*@/i, '$1');
}

function includeSensitiveEntry(cacheEntry) {
    if (!cacheEntry || typeof cacheEntry !== 'object' || Array.isArray(cacheEntry) || !('repository' in cacheEntry)) {
        return cacheEntry;
    }
    return { ...cacheEntry, repository: stripUrlUserinfo(cacheEntry.repository) };
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isSnapshotFile(filePath) {
    return path.basename(filePath).endsWith('.snapshot.json');
}

/**
 * The extension's snapshot wraps the cache map in an envelope
 * ({ schemaVersion, cacheVersion, cacheId, generatedAt, entryCount, entries });
 * a legacy export is the bare map. Returns { entries } or { error }.
 *
 * A snapshot that does not parse or lacks a usable envelope is an error, not a
 * reason to fall back: falling back would silently report an older legacy export
 * as the current cache, and treating the envelope as a bare map would print its
 * metadata fields as cache entries.
 */
function parseCacheEntries(filePath, content) {
    const fileName = path.basename(filePath);
    let data;
    try {
        data = JSON.parse(content);
    } catch {
        return { error: `Malformed cache file ${fileName}: not valid JSON` };
    }
    if (isSnapshotFile(filePath)) {
        if (!isPlainObject(data) || typeof data.schemaVersion !== 'number' || !isPlainObject(data.entries)) {
            return { error: `Malformed cache snapshot ${fileName}: expected an envelope with a numeric schemaVersion and an entries object` };
        }
        return { entries: data.entries };
    }
    if (!isPlainObject(data)) {
        return { error: `Malformed cache file ${fileName}: expected an object of cache entries` };
    }
    return { entries: data };
}

/**
 * Try to find and read the cache file
 * Returns { success: boolean, data?: any, filePath?: string, error?: string }
 */
function readCacheFile() {
    const possiblePaths = getCacheFilePaths();

    // All decisions are made about the open descriptor, never a path checked beforehand:
    // 1. Open the candidate (O_NOFOLLOW on POSIX refuses a symlink outright).
    // 2. fstat the descriptor: it must be a regular file.
    // 3. lstat the path (not following links) and require a regular file with the same
    //    dev + ino as the descriptor. This refuses a symlink on Windows, where O_NOFOLLOW
    //    does not exist and open() followed it (lstat reports the link, not the target),
    //    and refuses a path that was swapped after the open.
    // 4. Read through the same descriptor.
    const openFlags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
    for (const filePath of possiblePaths) {
        let fd;
        let content;
        try {
            fd = fs.openSync(filePath, openFlags);
            const fileStat = fs.fstatSync(fd, { bigint: true });
            if (!fileStat.isFile()) {
                continue;
            }
            const linkStat = fs.lstatSync(filePath, { bigint: true });
            if (linkStat.isSymbolicLink() || !linkStat.isFile()
                || linkStat.dev !== fileStat.dev || linkStat.ino !== fileStat.ino) {
                continue;
            }
            content = fs.readFileSync(fd, 'utf8');
        } catch (error) {
            // Missing, unreadable, a refused symlink or swapped file: try the next candidate
            continue;
        } finally {
            if (fd !== undefined) {
                fs.closeSync(fd);
            }
        }

        // The first file that exists decides the result; a malformed one stops the search.
        const parsed = parseCacheEntries(filePath, content);
        if (parsed.error) {
            return { success: false, malformed: true, error: parsed.error };
        }
        return { success: true, data: parsed.entries, filePath };
    }

    return {
        success: false,
        error: 'No cache file found'
    };
}

// Main execution
(function main() {
    // Try to read actual cache file
    const cacheResult = readCacheFile();

    if (cacheResult.success) {
        const entries = Object.entries(cacheResult.data || {});
        entries.sort((a, b) => ((b[1] && b[1].mtime) || 0) - ((a[1] && a[1].mtime) || 0));
        const limited = entries.slice(0, lastCount);
        const limitedObj = Object.fromEntries(limited.map(([filePath, cacheEntry], index) => [
            includeSensitive ? filePath : `session-${index + 1}`,
            includeSensitive ? includeSensitiveEntry(cacheEntry) : sanitizeCacheEntry(cacheEntry)
        ]));

        const output = {
            ...(includeSensitive ? { cacheFile: cacheResult.filePath } : {}),
            requestedCount: lastCount,
            totalCacheEntries: Object.keys(cacheResult.data || {}).length,
            entries: limitedObj
        };

        console.log(JSON.stringify(output));
        return;
    }

    if (cacheResult.malformed) {
        // A cache file exists but cannot be used: say so instead of reporting "not found"
        console.log(JSON.stringify({ cacheFound: true, malformed: true, error: cacheResult.error }));
        process.exit(3);
    }

    // No cache found: output JSON error
    const errorOut = {
        cacheFound: false,
        error: cacheResult.error
    };
    console.log(JSON.stringify(errorOut));
    process.exit(1);
})();
