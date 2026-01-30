# Load Cache Data Skill - Quick Reference

This skill provides tools and documentation for accessing the GitHub Copilot Token Tracker's local session file cache.

## Quick Start

```bash
# Show last 10 cache entries (default)
node .github/skills/load-cache-data/load-cache-data.js

# Show last 5 entries
node .github/skills/load-cache-data/load-cache-data.js --last 5

# Output as JSON
node .github/skills/load-cache-data/load-cache-data.js --json

# Show help
node .github/skills/load-cache-data/load-cache-data.js --help
```

## What This Skill Does

1. **Demonstrates cache structure** - Shows the format and content of cached session data
2. **Provides access patterns** - Example code for reading cache from VS Code globalState
3. **Helps debugging** - Understand what's being cached and when
4. **Supports development** - Iterate with real data structures when building features

## Important Note

The cache is stored in VS Code's internal database (`state.vscdb`) and is only directly accessible through the extension's API at runtime. This script generates example data that matches the real cache structure.

To access real cache data, use the extension's API:

```typescript
// In extension.ts or any file with access to ExtensionContext
const cacheData = context.globalState.get<Record<string, SessionFileCache>>('sessionFileCache');
const entries = Object.entries(cacheData || {});

// Sort by most recent
entries.sort((a, b) => (b[1].mtime || 0) - (a[1].mtime || 0));

// Get last 10
const last10 = entries.slice(0, 10);
```

## Full Documentation

See [SKILL.md](./SKILL.md) for complete documentation including:
- Cache structure details
- Integration with extension code
- Cache management methods
- Troubleshooting guide
- Example use cases
