---
name: validate-editor-names
description: Find all hardcoded path-to-editor-name mappings in the CLI (cli/src/analysis.ts::getEditorSourceFromPath) and VS Code extension (src/workspaceHelpers.ts::getEditorTypeFromPath), verify they return matching friendly display names for the same path patterns, and confirm every CLI-returned name appears in the EDITOR_ICON_MAP in src/editorIcons.ts. Use after adding a new editor adapter, after CLI changes, or if JetBrains/other CLI-based consumers show raw editor keys instead of friendly names.
---

# Validate Editor Names Skill

Checks that the CLI and the VS Code extension always agree on editor display
names, and that every name has an icon in the webview icon map.

There are **three sources of truth** that must stay in sync:

| Source | File | Function / symbol |
|--------|------|-------------------|
| **CLI path detector** | `cli/src/analysis.ts` | `getEditorSourceFromPath` |
| **VS Code path detector** | `src/workspaceHelpers.ts` | `getEditorTypeFromPath` (delegates to `detectToolEditorFromPath` + `detectVSCodeVariantFromPath`) |
| **Webview icon map** | `src/editorIcons.ts` | `EDITOR_ICON_MAP` (the `EditorName` union type is derived from it in `vscode-extension/src/webview/shared/formatUtils.ts`) |

The JetBrains plugin (and any future CLI-based consumer) gets its editor names
**exclusively from the CLI** via `CliBridge.kt`. If the CLI returns a raw
lowercase key instead of a friendly display name the UI falls back to the raw
key everywhere: chart labels, the session list, the stats command.

## What the script checks

1. **CLI-only coverage** — every unique name returned by
   `getEditorSourceFromPath` exists in `EDITOR_ICON_MAP`.
2. **VS Code-only coverage** — every unique name returned by
   `getEditorTypeFromPath` exists in `EDITOR_ICON_MAP`.
3. **Cross-function consistency** — for a canonical set of test paths the CLI
   and VS Code detectors return **identical** names. Any mismatch is a bug.
4. **Ordering invariants** — warns if a broad path pattern (e.g. `/.copilot/`)
   appears before a more specific one (e.g. `/.copilot/jb/`) in the CLI
   function, which would cause the broad check to shadow the specific one.

## Usage

```bash
# Run all checks and print a human-readable report
node .github/skills/validate-editor-names/validate-editor-names.js

# Machine-readable JSON (for CI / further processing)
node .github/skills/validate-editor-names/validate-editor-names.js --json

# Show help
node .github/skills/validate-editor-names/validate-editor-names.js --help
```

### Options

| Flag | Meaning |
|------|---------|
| `--json` | Emit JSON only (no ANSI colour) |
| `--help` | Usage |

### Exit codes

- `0` — all checks pass
- `1` — one or more checks failed (missing icon, name mismatch, ordering issue)
- `2` — configuration / environment error (source files not found)

## When to run this skill

- After **adding a new editor adapter** (`src/adapters/`)
- After **modifying `getEditorSourceFromPath`** or `getEditorTypeFromPath`
- After **updating `EDITOR_ICON_MAP`** in `src/editorIcons.ts`
- When **JetBrains (or another CLI-based view) shows raw editor keys** instead
  of friendly names — this skill will pinpoint which path pattern is missing or
  mismatched

## How to fix failures

| Failure type | Likely cause | Fix |
|---|---|---|
| **Missing icon** for CLI name | New editor added to CLI but not to `src/editorIcons.ts` | Add entry to `EDITOR_ICON_MAP` (the `EditorName` union follows) |
| **Missing icon** for VS Code name | New editor added to VS Code adapter but not to `src/editorIcons.ts` | Same as above |
| **Name mismatch** for a test path | CLI returns raw key; VS Code returns friendly name (or vice versa) | Align `getEditorSourceFromPath` to match `getEditorTypeFromPath` |
| **Ordering issue** | Broad `includes` check appears before specific one in CLI function | Reorder checks in `getEditorSourceFromPath` so specific paths come first |

## Related files

- `cli/src/analysis.ts` — `getEditorSourceFromPath` (the CLI implementation)
- `src/workspaceHelpers.ts` — `getEditorTypeFromPath`,
  `detectToolEditorFromPath`, `detectVSCodeVariantFromPath`
- `src/editorIcons.ts` — `EDITOR_ICON_MAP`; `vscode-extension/src/webview/shared/formatUtils.ts`
  re-exports it and derives the `EditorName` type
- `jetbrains-plugin/src/main/kotlin/.../CliBridge.kt` — the JetBrains host that
  calls the CLI binary and feeds the returned editor names straight into the
  shared webview bundle
- `.github/skills/validate-session-schemas/` — validates session file schemas
  (a complementary skill; run both when adding a new adapter)
- `docs/logFilesSchema/` — per-platform schema documentation
