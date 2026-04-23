---
applyTo: "cli/**"
---

# CLI — Architecture & Integration Guide

The CLI (`cli/`) is a standalone command-line tool that **shares the session discovery and data access classes** from `vscode-extension/src/` but has its own aggregation pipeline. It is built with TypeScript and bundled via `cli/esbuild.js` into `cli/dist/cli.js`.

## Key Files

- **`cli/src/helpers.ts`**: Shared helper functions — session discovery, file processing, stats aggregation. Imports all data access classes from `vscode-extension/src/`.
- **`cli/src/commands/`**: One file per sub-command (`stats`, `usage`, `environmental`, `fluency`, `diagnostics`).
- **`cli/esbuild.js`**: Build script. Copies JSON data files from `vscode-extension/src/` to a temp location before bundling, then removes them.
- **`cli/tsconfig.json`**: `paths` alias points to `../vscode-extension/src/*`.

## Developer Workflow

```bash
cd cli
npm install
npm run build            # development build
npm run build:production # minified release build
```

Or from the repo root:
```powershell
./build.ps1 -Project cli
```

## Adding a New Editor / Data Source

When adding support for a new editor or data source, wire it into **both** `vscode-extension/src/` (see `.github/instructions/vscode-extension.instructions.md`) **and** this CLI.

> **Adapter architecture (issue #654)**: The CLI shares the adapter classes from `vscode-extension/src/adapters/` and registers them in `_ecosystems` inside `cli/src/helpers.ts`. Currently 9 adapters are registered: OpenCode, Crush, Continue, ClaudeCode, ClaudeDesktop, VisualStudio, MistralVibe, **CopilotChat**, **CopilotCli**. The Copilot adapters own discovery but their `handles()` returns `false`, so `processSessionFile()` falls through to the existing per-format helpers (JSONL/JSON parsing) for those files. Order matters — register Copilot adapters **last**.

### CLI Files to Update

| File | What to add |
|---|---|
| `cli/src/helpers.ts` | Import, factory function, singleton, detection, stat routing, `processSessionFile()` branch, `calculateUsageAnalysisStats()` deps |
| `cli/src/commands/stats.ts` | Add entry to `getEditorDisplayName()` |
| `cli/src/commands/usage.ts` | No change needed — uses shared helpers |
| `cli/README.md` | Add the new editor to the "Data Sources" section |

### Integration Points in `cli/src/helpers.ts`

1. **Import** — `import { NewEditorDataAccess } from '../../vscode-extension/src/neweditor';`
2. **Factory function** — `function createNewEditor(): NewEditorDataAccess { return new NewEditorDataAccess(); }`
3. **Singleton** — `const _newEditorInstance = createNewEditor();`
4. **`createSessionDiscovery()`** — pass `newEditor: _newEditorInstance` in the deps object
5. **`statSessionFile()`** — add guard routing virtual paths to the real DB file (before the generic `fs.promises.stat()` fallthrough)
6. **`getEditorSourceFromPath()`** — add a path pattern check *before* the generic `'/code/'` or `'vscode'` fallthrough, returning a stable lowercase identifier (e.g. `'neweditor'`)
7. **`processSessionFile()`** — add a guard block calling `getTokens()`, `countInteractions()`, `getModelUsage()` from the data access class and returning a `SessionData` object
8. **`calculateUsageAnalysisStats()` deps** — pass `newEditor: _newEditorInstance` so `analyzeSessionUsage()` can route to it

### Checklist

- [ ] `cli/src/helpers.ts` — import, factory, singleton, detection, stat routing, processSessionFile block, usageAnalysis deps
- [ ] `cli/src/commands/stats.ts` — `getEditorDisplayName()` entry
- [ ] `cli/README.md` — "Data Sources" section updated
- [ ] `npm run build` passes (from `cli/`)
- [ ] CLI `stats` command shows the new editor in the session list
- [ ] Token counts are non-zero and plausible
