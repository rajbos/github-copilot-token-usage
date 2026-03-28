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

1. **Reads actual cache data** - Loads real cache data from export files on disk
2. **Multiple search locations** - Checks VS Code globalStorage, temp directory, and current directory
3. **Helps debugging** - Inspect what's being cached and when
4. **Supports development** - Iterate with real data structures when building features

## Cache File Locations

The script searches for cache export files in these locations (in order):

**Windows:**
- `%APPDATA%\Code\User\globalStorage\rajbos.copilot-token-tracker\cache.json`
- `%TEMP%\copilot-token-tracker-cache.json`
- `.\cache-export.json`

**macOS:**
- `~/Library/Application Support/Code/User/globalStorage/rajbos.copilot-token-tracker/cache.json`
- `/tmp/copilot-token-tracker-cache.json`
- `./cache-export.json`

**Linux:**
- `~/.config/Code/User/globalStorage/rajbos.copilot-token-tracker/cache.json`
- `/tmp/copilot-token-tracker-cache.json`
- `./cache-export.json`

*Note: Also checks other VS Code variants (Insiders, Cursor, VSCodium, Code - Exploration)*

## Important Note

The extension stores its cache in VS Code's internal globalState (SQLite database `state.vscdb`), which is not directly accessible from external scripts. To use this skill with real data:

1. **Export from extension**: Add functionality to export cache to disk
2. **Export from tests**: Test code can write cache data to one of the expected locations
3. **Manual export**: Extract cache from globalState and save to disk

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
