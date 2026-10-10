---
name: load-cache-data
description: Load the last 10 cache entries as JSON with session titles, prompt excerpts, paths, and repository URLs omitted by default. Use --include-sensitive only when full entries are explicitly needed.
---

# Load Cache Data Skill

Use `--json` for output; don't pretty-print or write extra files. The default output omits session titles, prompt excerpts, workspace paths, repository URLs, and cache file paths. Never use `--include-sensitive` unless the task explicitly requires those fields.

This skill helps you access and inspect the AI Engineering Fluency's local session file cache. The cache stores pre-computed statistics for session files to avoid re-processing unchanged files.

## Overview

The extension keeps a cache of session file statistics in memory and persists it to a snapshot file in its globalStorage directory (`cache_prod.snapshot.json`, or `cache_dev.snapshot.json` in the Extension Development Host). This cache contains:
- Token counts (total and per-model)
- Interaction counts
- Model usage breakdowns
- File modification times (for cache validation)
- Usage analysis data (tool calls, mode usage, context references)

## When to Use This Skill

Use this skill when you need to:
- Inspect cached session file data
- Debug cache behavior or validation logic
- Understand what data is being cached
- Work with real cached data for testing or development
- Iterate on features that rely on cached statistics

## Cache Structure

The snapshot file is an envelope (`{ schemaVersion, cacheVersion, cacheId, generatedAt, entryCount, entries }`) whose `entries` map is keyed by the absolute session file path. Each entry contains (abridged; see `SessionFileCache` in `src/types.ts`):

```typescript
interface SessionFileCache {
  tokens: number;                      // Total token count
  interactions: number;                // Number of interactions
  modelUsage: ModelUsage;              // Per-model token breakdown
  mtime: number;                       // File modification timestamp
  usageAnalysis?: SessionUsageAnalysis; // Detailed usage statistics
  subAgentCalls?: number;               // Sub-agent/delegation tool calls (absent when 0)
}

interface ModelUsage {
  [model: string]: {
    inputTokens: number;
    outputTokens: number;
  };
}

interface SessionUsageAnalysis {
  toolCalls: ToolCallUsage;            // Tool usage statistics
  modeUsage: ModeUsage;                // Mode distribution
  contextReferences: ContextReferenceUsage; // Context reference counts
  mcpTools: McpToolUsage;              // MCP tool usage
}
```

## Location

**Cache Storage**: `<globalStorageUri>/cache_<prod|dev>.snapshot.json`
- In memory: `CacheManager.cache` (a `Map<string, SessionFileCache>`)
- On disk: written by `CacheManager.trySaveCacheToStorage()`, loaded by `CacheManager.loadCacheFromStorage()`
- Not stored in VS Code's `globalState`: on activation the extension removes any leftover cache keys from it (a one-time migration)

**Implementation**: `src/extension.ts` (see `CacheManager` in `src/cacheManager.ts` below for the actual persistence logic)

## How to Access the Cache

### From Within the Extension

Inside the extension the cache is the in-memory map held by `CacheManager`:

```typescript
// CacheManager.cache is a Map<string, SessionFileCache>
const cacheEntries = Array.from(cacheManager.cache.entries());

// Get last 10 entries (sorted by modification time)
const last10 = cacheEntries
  .sort((a, b) => (b[1].mtime || 0) - (a[1].mtime || 0))
  .slice(0, 10);

// Display cache entries
for (const [, cacheEntry] of last10) {
  console.log({
    tokens: cacheEntry.tokens,
    interactions: cacheEntry.interactions,
    modelUsage: cacheEntry.modelUsage,
    lastModified: new Date(cacheEntry.mtime).toISOString()
  });
}
```

### Using the Provided Script

This skill includes an executable script that loads and displays actual cache data from disk:

**Location**: `.github/skills/load-cache-data/load-cache-data.js`

**Usage:**
```bash
# RECOMMENDED: Always use --json for raw JSON output
node .github/skills/load-cache-data/load-cache-data.js --json

# Show last N entries as JSON (default is 10)
node .github/skills/load-cache-data/load-cache-data.js --last 5 --json

# Include full entries only when explicitly needed
node .github/skills/load-cache-data/load-cache-data.js --include-sensitive --json

# Show help
node .github/skills/load-cache-data/load-cache-data.js --help
```

`--last` is capped at 100 entries. The script searches only VS Code globalStorage; it does not trust files in temporary or current-working directories. Default entry keys are anonymous (`session-1`, etc.), unrecognized fields are omitted, and maps keyed by file paths or names are dropped: `usageAnalysis.contextReferences.byPath`, plus `languageUsage` and `usageAnalysis.editScope.languageUsage` (keyed by file extension, or by the whole basename for extensionless files such as `Dockerfile`). `usageAnalysis.toolCalls`, `mcpTools` and `skillCalls` keep only their totals, because their per-tool, per-server and per-skill maps are keyed by names taken from the session. Correction moments keep only their type, turn number, timestamp, flags and pattern label; the excerpt, failing tool name and file path are dropped. `usageAnalysis.modelSwitching.selectedModelExtensions` (the model-provider extension ids) is dropped; the model ids are kept. Even with `--include-sensitive`, credentials in a repository URL (`https://user:token@host/...`) are stripped.

**What it does:**
- Searches for the extension's cache snapshot in known locations
- Reads actual cache data if a file exists
- Displays cache entries sorted by most recent modification, with identifying fields omitted by default
- Shows detailed token counts, model usage, and usage analysis

**Cache File Locations:**

The script reads the first of these files it finds:

1. **VS Code globalStorage**: `<VS Code user data>\User\globalStorage\<extension id>\`, looking for `cache_prod.snapshot.json`, then `cache_dev.snapshot.json` (the shared snapshot `CacheManager` writes; the entries are unwrapped from its envelope), then a legacy flat `session-cache.json` export. The extension id is `robbos.ai-engineering-fluency` (current) or `robbos.copilot-token-tracker` (pre-rename)
   - The Windows, macOS, and Linux locations are derived from the VS Code user-data directory.
   - Also checks other VS Code variants (Insiders, Cursor, VSCodium, etc.).

**Where the data comes from:**

The snapshot file is the cache's only persistent store: `CacheManager` loads it at startup and rewrites it on save (it is also how windows share parsed results). So a normal installation has a readable cache once the extension has run. A legacy `session-cache.json` (a bare `{ [sessionFile]: entry }` map) is still read as a fallback, for exports written by tests or by hand.

**Exit Codes:**
- `0`: Cache file found and displayed successfully
- `1`: No cache file found
- `2`: Invalid `--last` value
- `3`: The first cache file found is malformed (invalid JSON, or a snapshot without a usable `{ schemaVersion, entries }` envelope). The script reports this instead of falling back to the legacy export.

**Note**: If no cache file is found, the script reports that no cache file was found without printing local filesystem paths.

## Cache Management Methods

All cache persistence and validation logic lives in `CacheManager`
(`src/cacheManager.ts`), not `extension.ts` — `extension.ts` only holds a thin
`private trySaveCacheToStorage()` wrapper that delegates to it.

### Loading Cache
**Method**: `CacheManager.loadCacheFromStorage()`
**Location**: `src/cacheManager.ts`

Loads the cache from the shared on-disk snapshot file (not VS Code's global
state — the cache moved off `globalState` to avoid its ~2-3 MB size warning):
```typescript
const snapshotPath = this.getSharedSnapshotPath(); // globalStorageUri/cache_<id>.snapshot.json
const content = await fs.promises.readFile(snapshotPath, 'utf-8');
const envelope = JSON.parse(content);
// ...validates schema/cache version, then populates this.sessionFileCache
```

### Saving Cache
**Method**: `CacheManager.trySaveCacheToStorage()`
**Location**: `src/cacheManager.ts`

Writes the shared on-disk snapshot, guarded by a cross-window file lock so
concurrent VS Code windows never corrupt each other's write. Returns `false`
(never throws) when the lock is held by another window or the write fails,
so callers can tell "skipped/failed" from "persisted":
```typescript
async trySaveCacheToStorage(): Promise<boolean> {
  const acquired = await this.acquireCacheLock();
  if (!acquired) { return false; } // another window holds the lock
  try { return await this.writeSharedSnapshot(); }
  finally { await this.releaseCacheLock(); }
}
```

### Cache Validation
**Method**: `CacheManager.isCacheValid()`
**Location**: `src/cacheManager.ts`

Validates cache entries by comparing both modification time and file size:
```typescript
isCacheValid(filePath: string, currentMtime: number, currentSize: number): boolean {
  const cached = this.sessionFileCache.get(filePath);
  if (!cached) { return false; }
  return this.policy.isValid(cached, currentMtime, currentSize);
}
```

### Clearing Cache
**Method**: `CacheManager.clearExpiredCache()`
**Location**: `src/cacheManager.ts`

Removes cache entries for files that no longer exist on disk (batched,
async, and skips virtual session paths like `<db-file>#<session-id>` that
`fs.access()` can't validate):
```typescript
const filesToCheck = Array.from(this.sessionFileCache.keys());
for (const filePath of filesToCheck) {
  if (CacheManager.isVirtualSessionPath(filePath)) { continue; }
  try { await fs.promises.access(filePath); }
  catch { /* only ENOENT/ENOTDIR tombstone the entry — see the method's own doc comment */ }
}
```

## Cache Entry Lifecycle

1. **Session File Discovery**: Extension finds session files via `getCopilotSessionFiles()`
2. **Cache Check**: For each file, checks if cache is valid via `CacheManager.isCacheValid()`
3. **Read or Compute**: If valid, uses cache; otherwise, reads and parses the file
4. **Cache Update**: New statistics are stored in cache via `CacheManager.setCachedSessionData()`
5. **Persistence**: Cache is saved to the shared on-disk snapshot via `CacheManager.trySaveCacheToStorage()` (periodically, and unconditionally at the end of a leader refresh)
6. **Cleanup**: Expired entries are removed via `CacheManager.clearExpiredCache()`

## Example Use Cases

### Example 1: Inspecting Recent Sessions
```typescript
// Get cache data
const entries = Array.from(cacheManager.cache.entries());

// Sort by most recent
entries.sort((a, b) => (b[1].mtime || 0) - (a[1].mtime || 0));

// Show top 10
console.log('Most recent sessions:');
entries.slice(0, 10).forEach(([path, data], i) => {
  console.log(`${i + 1}. ${path.split('/').pop()}`);
  console.log(`   Tokens: ${data.tokens}, Interactions: ${data.interactions}`);
  console.log(`   Modified: ${new Date(data.mtime).toLocaleString()}`);
});
```

### Example 2: Analyzing Model Usage in Cache
```typescript
const modelTotals = {};

for (const [path, data] of cacheManager.cache) {
  for (const [model, usage] of Object.entries(data.modelUsage)) {
    if (!modelTotals[model]) {
      modelTotals[model] = { input: 0, output: 0 };
    }
    modelTotals[model].input += usage.inputTokens;
    modelTotals[model].output += usage.outputTokens;
  }
}

console.log('Cached model usage:');
for (const [model, totals] of Object.entries(modelTotals)) {
  console.log(`  ${model}: ${totals.input + totals.output} tokens`);
}
```

### Example 3: Cache Statistics
```typescript
const entries = Array.from(cacheManager.cache.entries());

const stats = {
  totalEntries: entries.length,
  totalTokens: 0,
  totalInteractions: 0,
  oldestEntry: null,
  newestEntry: null
};

entries.forEach(([path, data]) => {
  stats.totalTokens += data.tokens;
  stats.totalInteractions += data.interactions;
  
  if (!stats.oldestEntry || data.mtime < stats.oldestEntry.mtime) {
    stats.oldestEntry = { path, mtime: data.mtime };
  }
  if (!stats.newestEntry || data.mtime > stats.newestEntry.mtime) {
    stats.newestEntry = { path, mtime: data.mtime };
  }
});

console.log('Cache Statistics:', stats);
```

## Integration with Extension

The cache is tightly integrated with the extension's token tracking:

1. **Session File Processing**: `getSessionFileDataCached()`
   - Checks cache validity
   - Reads and parses file if needed
   - Updates cache with new data

2. **Statistics Calculation**: `calculateDetailedStats()`
   - Uses cached data when available
   - Aggregates statistics across all cached sessions
   - Includes usage analysis from cache

3. **Performance Optimization**:
   - FIFO cache eviction after 1000 entries
   - Modification time comparison for validation
   - Automatic cleanup of expired entries

## Troubleshooting

### Cache Not Loading
**Symptoms**: Extension shows no cached data or logs "No cached session files found"
**Solutions**:
1. Check that session files exist via `getCopilotSessionFiles()`
2. Check that the extension's globalStorage directory holds `cache_prod.snapshot.json` (or `cache_dev.snapshot.json`)
3. Look for errors in Output channel (AI Engineering Fluency)

### Cache Out of Sync
**Symptoms**: Token counts don't match session file contents
**Solutions**:
1. Clear cache via Command Palette: "Clear Cache"
2. Check file modification times
3. Manually refresh via "Refresh Token Usage" command

### Cache Too Large
**Symptoms**: Extension slow to start or save
**Solutions**:
1. Cache automatically limits to 1000 entries
2. Clear expired entries via `clearExpiredCache()`
3. Manually clear cache if needed

## Related Files

1. **Cache implementation**: `src/cacheManager.ts` (`CacheManager`)
   - Cache interface definition
   - Cache management methods
   - Cache usage in statistics

2. **Session file discovery**: `src/extension.ts` (via `SessionDiscovery`)
   - Session file discovery
   - File scanning logic

3. **Session parsing**: `src/sessionParser.ts`
   - Session file parsing logic
   - Token estimation
   - Usage analysis extraction

4. **Skill script**: `.github/skills/load-cache-data/load-cache-data.js`
   - Demonstrates cache structure
   - Provides example data
   - Shows access patterns

## Notes

- Cache is persisted to `cache_<prod|dev>.snapshot.json` in the extension's globalStorage directory, not to VS Code's `globalState`
- Cache entries are validated by file modification time
- Maximum of 1000 entries maintained (FIFO eviction)
- Cache persists between VS Code sessions
- Clearing cache forces re-processing of all session files
- Cache improves performance significantly for large numbers of session files
