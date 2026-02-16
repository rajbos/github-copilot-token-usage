# Sync Tool Names from vscode-copilot-chat

Scan `microsoft/vscode-copilot-chat` repo for model-facing tool identifiers, compare them to the existing `src/toolnames.json` in our repo in the `current` folder. Comapare with friendly-name mapping in this repository, and output the **delta** as JSON entries that can be pasted directly into the mapping. Do not output any other text, only a json response with the missing entries, or `NO_DELTA` if there are none. 

## Requirements

1. The `microsoft/vscode-copilot-chat` repository has been checked out and is available in the workspace in the folder `vscode-copilot-chat`. Use the paths provided in the Context Paths section below.
2. In the vscode-copilot-chat repo, treat `src/extension/tools/common/toolNames.ts` as the source of truth for tool IDs.
   - Extract tool IDs from:
     - `export enum ToolName { ... }` (string literal values)
     - `export enum ContributedToolName { ... }` (string literal values)
   - Ignore TypeScript keys (enum member names). Only collect the **string values** (the model-facing tool names).
3. In *this* repo, load the existing mapping file `src/toolNames.json`. Treat its top-level keys as the set of already-known tool IDs.
4. Compute `missing = (upstreamToolIds - existingMappingKeys)`.
   - Deduplicate.
   - Sort ascending (stable, locale-insensitive).
5. For each missing tool ID, generate a default friendly name:
   - Replace `_` / `-` / `.` with spaces.
   - Split camelCase / PascalCase boundaries into words.
   - Uppercase words (Title Case).
   - Preserve known acronyms in ALL CAPS: `VSCODE`, `MCP`, `GITHUB`, `API`, `URL`, `JSON`, `HTTP`, `HTTPS`, `CLI`, `UI`, `IO`, `ID`.
   - Examples:
     - `github_api_tool` → `GitHub API Tool`
     - `copilot_readFile` → `Copilot Read File`
     - `mcp.io.github.git` → `MCP IO GitHub Git`
     - `search_subagent` → `Search Subagent`
     - `run_in_terminal` → `Run In Terminal`
     - `vscode_command` → `VSCode Command`
6. Inject **only** the missing entries into our existing mapping object in the current repository, using the same style as the mapping (leading comma with space on each line), e.g.:
   ```
   , "some_tool": "Some Tool"
   ```
7. If `missing` is empty, output nothing except a single line: `NO_DELTA`.
8. Also print (as plain text, after the delta or NO_DELTA) the upstream commit SHA used for the scan and the exact file path scanned in upstream, for traceability.

## Constraints
- Only modify our toolNames.json file.
- Do not open a PR.
- Do not include tools in the list that are not model-facing (only those defined in upstream `ToolName` / `ContributedToolName` string values).
- Be resilient to minor refactors (enum order changes, added comments, etc.).
