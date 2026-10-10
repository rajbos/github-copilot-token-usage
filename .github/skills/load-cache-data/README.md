# Load Cache Data Skill - Quick Reference

This skill provides tools and documentation for accessing the AI Engineering Fluency's local session file cache.

## Quick Start

```bash
# Show last 10 cache entries (default)
node .github/skills/load-cache-data/load-cache-data.js

# Show last 5 entries
node .github/skills/load-cache-data/load-cache-data.js --last 5

# Include session-identifying fields only when explicitly needed
node .github/skills/load-cache-data/load-cache-data.js --include-sensitive --json

# Output as JSON
node .github/skills/load-cache-data/load-cache-data.js --json

# Show help
node .github/skills/load-cache-data/load-cache-data.js --help
```

## What This Skill Does

1. **Reads actual cache data** - Loads the extension's shared cache snapshot from disk
2. **Scoped search locations** - Checks only VS Code globalStorage, not temp or current directories
3. **Helps debugging** - Inspect what's being cached and when
4. **Supports development** - Iterate with real data structures when building features

By default, output omits session titles, prompt excerpts, correction snippets and the failing tool / edited file they name, workspace paths, referenced file paths, per-file-type line counts (`languageUsage`, keyed by extension or extensionless basename), per-tool, per-MCP-server and per-skill name maps (only their totals are kept), model-provider extension ids, unrecognized reference kinds (counted as `other`), repository URLs, cache file paths, and unknown entry fields. `--include-sensitive` opts into full entries and their local paths; credentials in repository URLs are stripped even then. `--last` is capped at 100 entries.

## Cache File Locations

The script reads `cache_prod.snapshot.json`, then `cache_dev.snapshot.json` (the extension's shared cache snapshot, unwrapped from its envelope), then a legacy `session-cache.json` export, under each supported VS Code variant's globalStorage directory:

- **Windows:** `%APPDATA%\<variant>\User\globalStorage\<extension id>\`
- **macOS:** `~/Library/Application Support/<variant>/User/globalStorage/<extension id>/`
- **Linux:** `${XDG_CONFIG_HOME:-~/.config}/<variant>/User/globalStorage/<extension id>/`

The extension id is `robbos.ai-engineering-fluency` (current) or `robbos.copilot-token-tracker` (pre-rename). Supported variants include Code, Insiders, Code - Exploration, VSCodium, and Cursor. Temporary and current-working directories are not trusted as cache sources.

## Important Note

The extension persists its cache only to the snapshot file (`cache_prod.snapshot.json` / `cache_dev.snapshot.json`) in its globalStorage directory, and that file is what this script reads. The cache is not in VS Code's `globalState`: on activation the extension removes any leftover cache keys from it. No manual export is needed once the extension has run. A legacy `session-cache.json` written by tests or by hand is still accepted as a fallback.

Inside the extension, the same data is the in-memory map held by `CacheManager`:

```typescript
// CacheManager.cache is a Map<string, SessionFileCache>
const entries = Array.from(cacheManager.cache.entries());

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
