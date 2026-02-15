# Sync Tool Names from vscode-copilot-chat

Scan `microsoft/vscode-copilot-chat` for model-facing tool identifiers, compare them to the existing `toolnames.json` friendly-name mapping in this repository, and output the **delta** as JSON entries that can be pasted directly into the mapping.

## Requirements

1. The `microsoft/vscode-copilot-chat` repository has been checked out and is available in the workspace. Use the paths provided in the Context Paths section below.
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
   - Preserve known acronyms: `VS Code`, `MCP`, `GitHub`, `API`, `URL`, `JSON`.
6. Output **only** the missing entries in a format directly pasteable into the existing mapping object, using the same style as the mapping (leading comma on each line), e.g.:
   ```
   ,"some_tool": "Some Tool"
   ```
7. If `missing` is empty, output nothing except a single line: `NO_DELTA`.
8. Also print (as plain text, after the delta or NO_DELTA) the upstream commit SHA used for the scan and the exact file path scanned in upstream, for traceability.

## Constraints

- Do not modify any files.
- Do not open a PR.
- Do not include tools that are not model-facing (only those defined in upstream `ToolName` / `ContributedToolName` string values).
- Be resilient to minor refactors (enum order changes, added comments, etc.).
