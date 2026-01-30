---
name: load-cache-data
description: Load and inspect the last 10 rows from the local session file cache to iterate with real data. Use when you need to understand cached session statistics, debug cache behavior, or work with actual cached data.
---

# Load Cache Data Skill

This skill helps you access and inspect the GitHub Copilot Token Tracker's local session file cache. The cache stores pre-computed statistics for session files to avoid re-processing unchanged files.

## Overview

The extension maintains a local cache of session file statistics in VS Code's `globalState`. This cache contains:
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

The cache is stored in VS Code's global state under the key `'sessionFileCache'`. Each cache entry is keyed by the absolute file path and contains:

```typescript
interface SessionFileCache {
  tokens: number;                      // Total token count
  interactions: number;                // Number of interactions
  modelUsage: ModelUsage;              // Per-model token breakdown
  mtime: number;                       // File modification timestamp
  usageAnalysis?: SessionUsageAnalysis; // Detailed usage statistics
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

**Cache Storage**: `VS Code globalState → 'sessionFileCache'`
- Accessed via: `context.globalState.get<Record<string, SessionFileCache>>('sessionFileCache')`
- Persisted automatically by VS Code
- Lives in VS Code's internal database (`state.vscdb`)

**Implementation**: `src/extension.ts` (lines 74-80, 194, 336-360)

## How to Access the Cache

### From Within the Extension

The cache can be accessed through the extension's context at runtime:

```typescript
// Load cache from global state
const cacheData = context.globalState.get<Record<string, SessionFileCache>>('sessionFileCache');
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
```

### Using the Provided Script

This skill includes an executable script that demonstrates the cache structure and provides example data:

**Location**: `.github/skills/load-cache-data/load-cache-data.js`

**Usage:**
```bash
# Show last 10 cache entries (default)
node .github/skills/load-cache-data/load-cache-data.js

# Show last 5 entries
node .github/skills/load-cache-data/load-cache-data.js --last 5

# Output as JSON
node .github/skills/load-cache-data/load-cache-data.js --json

# Show last 3 entries as JSON
node .github/skills/load-cache-data/load-cache-data.js --last 3 --json

# Show help
node .github/skills/load-cache-data/load-cache-data.js --help
```

**What it does:**
- Finds VS Code installation paths on the current system
- Demonstrates the cache data structure with example entries
- Shows how cache entries are formatted and sorted
- Provides code examples for accessing real cache data

**Note**: The script generates example data because VS Code's internal database is only accessible through the extension's API at runtime. Use the extension's API (shown above) to access real cache data.

## Cache Management Methods

### Loading Cache
**Method**: `loadCacheFromStorage()`
**Location**: `src/extension.ts` (lines 336-350)

Loads the cache from VS Code's global state on extension activation:
```typescript
const cacheData = this.context.globalState.get<Record<string, SessionFileCache>>('sessionFileCache');
if (cacheData) {
  this.sessionFileCache = new Map(Object.entries(cacheData));
}
```

### Saving Cache
**Method**: `saveCacheToStorage()`
**Location**: `src/extension.ts` (lines 352-360)

Saves the cache to VS Code's global state:
```typescript
const cacheData = Object.fromEntries(this.sessionFileCache);
await this.context.globalState.update('sessionFileCache', cacheData);
```

### Cache Validation
**Method**: `isCacheValid()`
**Location**: `src/extension.ts` (lines 285-290)

Validates cache entries by comparing modification times:
```typescript
private isCacheValid(filePath: string, currentMtime: number): boolean {
  const cached = this.sessionFileCache.get(filePath);
  return cached !== undefined && cached.mtime === currentMtime;
}
```

### Clearing Cache
**Method**: `clearExpiredCache()`
**Location**: `src/extension.ts` (lines 308-333)

Removes cache entries for files that no longer exist:
```typescript
const sessionFiles = await this.getCopilotSessionFiles();
const validPaths = new Set(sessionFiles);
for (const [filePath, _] of this.sessionFileCache) {
  if (!validPaths.has(filePath)) {
    this.sessionFileCache.delete(filePath);
  }
}
```

## Cache Entry Lifecycle

1. **Session File Discovery**: Extension finds session files via `getCopilotSessionFiles()`
2. **Cache Check**: For each file, checks if cache is valid via `isCacheValid()`
3. **Read or Compute**: If valid, uses cache; otherwise, reads and parses the file
4. **Cache Update**: New statistics are stored in cache via `setCachedSessionData()`
5. **Persistence**: Cache is saved to global state via `saveCacheToStorage()`
6. **Cleanup**: Expired entries are removed via `clearExpiredCache()`

## Example Use Cases

### Example 1: Inspecting Recent Sessions
```typescript
// Get cache data
const cache = context.globalState.get('sessionFileCache');
const entries = Object.entries(cache || {});

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
const cache = context.globalState.get('sessionFileCache');
const modelTotals = {};

for (const [path, data] of Object.entries(cache || {})) {
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
const cache = context.globalState.get('sessionFileCache');
const entries = Object.entries(cache || {});

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

1. **Session File Processing**: `getSessionFileDataCached()` (lines 1414-1450)
   - Checks cache validity
   - Reads and parses file if needed
   - Updates cache with new data

2. **Statistics Calculation**: `calculateDetailedStats()` (lines 379-693)
   - Uses cached data when available
   - Aggregates statistics across all cached sessions
   - Includes usage analysis from cache

3. **Performance Optimization**:
   - FIFO cache eviction after 1000 entries (line 305)
   - Modification time comparison for validation
   - Automatic cleanup of expired entries

## Troubleshooting

### Cache Not Loading
**Symptoms**: Extension shows no cached data or logs "No cached session files found"
**Solutions**:
1. Check that session files exist via `getCopilotSessionFiles()`
2. Verify global state is accessible
3. Look for errors in Output channel (GitHub Copilot Token Tracker)

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

1. **Cache implementation**: `src/extension.ts`
   - Cache interface definition (lines 74-80)
   - Cache management methods (lines 285-360)
   - Cache usage in statistics (lines 379-693)

2. **Session file discovery**: `src/extension.ts`
   - Session file discovery (lines 975-1073)
   - File scanning logic (lines 1078-1110)

3. **Session parsing**: `src/sessionParser.ts`
   - Session file parsing logic
   - Token estimation
   - Usage analysis extraction

4. **Skill script**: `.github/skills/load-cache-data/load-cache-data.js`
   - Demonstrates cache structure
   - Provides example data
   - Shows access patterns

## Notes

- Cache is stored in VS Code's internal SQLite database (`state.vscdb`)
- Cache entries are validated by file modification time
- Maximum of 1000 entries maintained (FIFO eviction)
- Cache persists between VS Code sessions
- Clearing cache forces re-processing of all session files
- Cache improves performance significantly for large numbers of session files
