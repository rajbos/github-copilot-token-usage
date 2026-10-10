---
name: improve-tool-families
description: Analyze coverage of the vscode-extension's tool-family definitions (DEFAULT_TOOL_FAMILIES in vscode-extension/src/toolFamilies.ts) against the canonical tool-name list in src/toolNames.json and/or a live agent tool list, and suggest which family missing tool names likely belong to. Use when the Tool Output Token Analysis tab shows too many tools bucketed under "Other Tools", after adding a new editor adapter, after a new agent/CLI's tool list grows, or when asked to improve/expand the preconfigured tool families.
---

# Improve Tool Families Skill

The "Tool Output Token Analysis" tab in the VS Code extension groups tool
calls into **families** (File Reading, File Writing, Search & Discovery,
Shell / Terminal, Code Intelligence, Web & Research, ...) so a "built-in"
tool's token efficiency can be compared against "alternative" tools that do
the same job. That grouping comes from `DEFAULT_TOOL_FAMILIES` in
`vscode-extension/src/toolFamilies.ts`, merged with any user overrides in the
`aiEngineeringFluency.toolFamilies` VS Code setting.

**The matching is an exact string match** against the raw tool name recorded
per editor (see `src/adapters/*.ts` and `usageAnalysis.ts` writing into
`toolCalls.byTool`/`outputTokensByTool`) — there is no cross-editor
normalization step first. That means every spelling a different editor/agent
uses for "read a file", "run a shell command", "search text", etc. must be
listed explicitly, or it silently falls into the generic "Other Tools"
bucket instead of being compared.

## What the script does

`analyze-tool-families.js`:
1. Loads the canonical set of known tool names from `src/toolNames.json`
   (the cross-editor tool-name → friendly-name map used elsewhere in the
   repo) and/or an ad-hoc list passed via `--tools`.
2. Parses `DEFAULT_TOOL_FAMILIES` out of `vscode-extension/src/toolFamilies.ts`
   (no build step needed).
3. Reports which candidate tool names are **not yet covered** by any
   family's `builtIn`/`alternatives` arrays.
4. Suggests a likely family for each uncovered name using keyword
   heuristics (e.g. names containing `read`/`view` → `reading`,
   `grep`/`glob`/`search` → `search`, `run`/`terminal`/`bash` → `shell`,
   `web`/`fetch` → `web`, etc.).

It does **not** edit `toolFamilies.ts` automatically — deciding whether a
tool is a plain "builtIn" (baseline) tool or a more token-efficient
"alternative" is a judgment call that needs a human/agent to review the
tool's actual behavior, not just its name.

## Usage

```bash
# Compare against every name in src/toolNames.json
node .github/skills/improve-tool-families/analyze-tool-families.js

# Also check specific tool names (e.g. the current agent session's own tool list)
node .github/skills/improve-tool-families/analyze-tool-families.js --tools view,edit,grep,glob,powershell,web_fetch,ask_user

# Machine-readable JSON (for further processing)
node .github/skills/improve-tool-families/analyze-tool-families.js --json
```

### Options

| Flag | Meaning |
|------|---------|
| `--tools=a,b,c` | Additional comma-separated tool names to check for coverage (e.g. this session's own live tool list) |
| `--json` | Emit JSON only |
| `--help` | Print this file |

### Exit codes

- `0` — ran successfully (report may still list uncovered tools)
- `2` — configuration / environment error (source files not found or unparsable)

## Workflow: applying the suggestions

1. Run the script (optionally with `--tools` set to your current tool list —
   in an agent session this is just the list of tools you have available).
2. For each suggested family, look at the listed tool names and decide:
   - Is it just **another editor's spelling of an existing baseline tool**
     (e.g. `Read`, `read_file` vs. `read`/`view`) → add to `builtIn`.
   - Is it a **genuinely more targeted/efficient tool** for the same job
     (e.g. `apply_patch`, `replace_string_in_file`, `multi_edit` vs. a full
     file rewrite) → add to `alternatives`.
   - Is it **not actually comparable** (e.g. issue/PR/notebook management
     tools, orchestration tools like `task`/`write_agent`) → leave it out;
     not every tool needs a family.
3. Edit `vscode-extension/src/toolFamilies.ts` (`DEFAULT_TOOL_FAMILIES`).
4. Verify with `cd vscode-extension && npm run validate` (tsc + eslint +
   esbuild).
5. Re-run this script to confirm the previously-uncovered names are now
   covered.

## Related files

- `vscode-extension/src/toolFamilies.ts` — `DEFAULT_TOOL_FAMILIES`,
  `mergeToolFamilies`, `getToolFamilies` (source of truth for family data)
- `vscode-extension/package.json` — JSON schema for the
  `aiEngineeringFluency.toolFamilies` override setting
- `vscode-extension/src/webview/diagnostics/main.ts` —
  `renderToolAnalysisTab`/`renderToolFamilySection` (exact-match rendering
  logic; anything not claimed by a family lands in "Other Tools")
- `src/toolNames.json` — canonical cross-editor tool-name → friendly-name
  map, the best available source of real-world tool name spellings
- `src/adapters/*.ts`, `src/usageAnalysis.ts` — where raw tool names are
  recorded into `toolCalls.byTool` / `outputTokensByTool` per editor
