---
description: "Add friendly display names for unknown MCP and VS Code tools detected in session logs. Handles tool name mapping in src/toolNames.json."
name: "Tool Names - Add Missing Friendly Names"
tools: [execute/getTerminalOutput, execute/runInTerminal, read, search/codebase]
---

# Tool Names - Add Missing Friendly Names

Resolve issues that report unknown/missing tool display names by adding entries to `src/toolNames.json`. This agent understands MCP (Model Context Protocol) server naming conventions and can research tool origins.

## When to Use This Agent

Trigger this agent when:
- An issue reports unknown or missing friendly tool names (title like "Add missing friendly names for tools")
- New MCP tools appear in user session logs without display labels
- The sync-toolnames workflow detects new upstream tools from `microsoft/vscode-copilot-chat`

## Key Files

**`src/toolNames.json`** — The single mapping file from raw tool identifiers to human-readable display names. Every tool the extension encounters gets looked up here; missing entries show as "Unknown" in the UI.

**`src/automaticTools.json`** — An array of tool IDs that Copilot calls *automatically* on its own (file reads, directory listings, searches, error checks, confirmations, memory, etc.). These tools are excluded from fluency scoring because they don't reflect intentional user configuration. When adding new tool entries to `toolNames.json`, you **must also decide** whether each tool is automatic or intentional and add it to `automaticTools.json` if automatic.

## MCP Tool Name Conventions

MCP tools follow predictable naming patterns. The raw tool identifier encodes the MCP server origin and the action:

### Prefix Patterns (raw identifier → display prefix)

| Raw Prefix | Display Prefix | Source Repository |
|---|---|---|
| `mcp.io.github.git.` or `mcp_io_github_git_` | `GitHub MCP (Local):` | [github/github-mcp-server](https://github.com/github/github-mcp-server) |
| `mcp_github_github_` | `GitHub MCP (Remote):` | [github/github-mcp-server](https://github.com/github/github-mcp-server) |
| `mcp_github-code-s_` | `GitHub MCP (Code Scanning):` | [github/github-mcp-server](https://github.com/github/github-mcp-server) |
| `mcp_com_microsoft_` | `Microsoft MCP:` | Microsoft internal MCP server |
| `mcp_microsoftdocs_microsoft_` | `Microsoft Docs MCP:` | Microsoft MCP server for official documentation retrieval |
| `mcp_gitkraken_` | `GitKraken MCP:` | GitKraken (no public MCP server repo; tools come from the GitKraken VS Code extension) |
| `mcp_oraios_serena_` | `Serena:` | [oraios/serena](https://github.com/oraios/serena) |
| `mcp_microsoft_pla_` | `Playwright MCP:` | [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp) |
| `mcp_io_github_ups_` | `Context7 MCP:` | [upstash/context7](https://github.com/upstash/context7) |

### How to Generate a Friendly Name

1. **Identify the prefix** — match the raw tool name against the prefix table above.
2. **Extract the action** — remove the prefix to get the action part (e.g., `mcp_io_github_git_search_code` → `search_code`).
3. **Format the action** — replace `_`, `-`, `.` with spaces, split camelCase, then Title Case each word.
4. **Preserve acronyms** — keep these in ALL CAPS: `VSCODE`, `MCP`, `GITHUB`, `API`, `URL`, `JSON`, `HTTP`, `HTTPS`, `CLI`, `UI`, `IO`, `ID`.
5. **Combine** — `"<Display Prefix> <Formatted Action>"`.

### Examples

```
mcp_io_github_git_search_code       → "GitHub MCP (Local): Search Code"
mcp_github_github_issue_read        → "GitHub MCP (Remote): Issue Read"
mcp_github-code-s_list_code_scanning_alerts → "GitHub MCP (Code Scanning): List Alerts"
mcp_gitkraken_git_status            → "GitKraken MCP: Git Status"
mcp_oraios_serena_find_symbol       → "Serena: Find Symbol"
mcp_microsoft_pla_browser_navigate  → "Playwright MCP: Browser Navigate"
mcp_io_github_ups_resolve-library-id → "Context7 MCP: Resolve Library ID"
```

### Non-MCP Tools

Tools without an `mcp.` or `mcp_` prefix are VS Code built-in or Copilot tools. Use plain Title Case without a server prefix:

```
run_in_terminal    → "Run In Terminal"
copilot_readFile   → "Read File"
setup.agent        → "Setup Agent"
bash               → "Bash"
grep               → "Grep"
```

Copilot-prefixed tools (`copilot_*`) typically drop the prefix in the friendly name for brevity.

## Researching Unknown MCP Servers

When you encounter an MCP tool with an **unfamiliar prefix** that does not match the table above:

1. **Search GitHub** for the MCP server's source repository:
   - Search for repos with topic `mcp-server` matching keywords from the prefix
   - Check https://github.com/github/github-mcp-server for the official GitHub MCP Server tools reference
   - Check https://github.com/punkpeye/awesome-mcp-servers for a curated community list
   - Search `modelcontextprotocol` org repos: https://github.com/modelcontextprotocol
2. **Inspect the server's tool definitions** — MCP servers typically expose tool names via a manifest or handler registration. Look for files like `server.json`, tool handler source files, or README documentation.
3. **Derive the display prefix** — use the server's product/project name (e.g., "Serena", "GitKraken MCP", "Context7 MCP").
4. **Add the new prefix pattern** to this document's table for future reference.

### Well-Known MCP Server Repositories

Use these repos to look up tool definitions when needed:

| Server | Repository | Language | Tools File / Path |
|---|---|---|---|
| GitHub MCP Server | [github/github-mcp-server](https://github.com/github/github-mcp-server) | Go | `pkg/github/*.go` (each file exposes tools for a domain: issues, PRs, repos, search, actions, code scanning, etc.) |
| Playwright MCP | [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp) | TypeScript | Browser automation tools |
| Serena | [oraios/serena](https://github.com/oraios/serena) | Python | Semantic code editing and symbol navigation |
| Context7 | [upstash/context7](https://github.com/upstash/context7) | TypeScript | Library documentation retrieval |
| Chrome DevTools MCP | [ChromeDevTools/chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) | TypeScript | Browser debugging tools |

## Automatic vs. Intentional Tools

When adding a new tool to `toolNames.json`, also determine if it belongs in `automaticTools.json`.

**Add to `automaticTools.json` (automatic)** — tools the agent calls by itself without any user configuration:
- File system reads: `read_file`, `list_dir`, `view`, `glob`, `grep`, file search variants
- Codebase search: `semantic_search`, `code_search`, `search_workspace_symbols`
- Project info: `get_errors`, `get_changed_files`, `read_project_structure`, `get_vscode_api`
- Terminal reads (not execution): `terminal_selection`, `terminal_last_command`, `get_terminal_output`
- Internal/session: `memory`, `detect_memories`, `tool_replay`, `vscode_get_confirmation*`, `ask_questions`, `switch_agent`, `bash`

**Do NOT add to `automaticTools.json` (intentional)** — tools that require explicit user setup or represent deliberate action:
- Terminal execution: `run_in_terminal`, `run_build`, `run_task`
- File writing/editing: `edit_files`, `write_file`, `create_file`, `apply_patch`
- Tests & runs: `runTests`, `run_notebook_cell`, `run_vscode_command`
- External integrations: `fetch_webpage`, `websearch`, `webfetch`
- MCP tools (all — user must configure the server)
- GitHub integrations: `github_pull_request`, `github_repo`

**Rule of thumb:** If the user must explicitly enable, configure, or consciously invoke the tool, it's intentional. If the agent just uses it as background context gathering, it's automatic.

## Editing `src/automaticTools.json`

- The file is a plain JSON array of tool ID strings
- Add new entries at the end of the array (before the closing `]`)
- Keep related tool variants together (e.g., all variants of `read_file`)
- **Case-insensitive deduplication**: Before adding a tool ID, check if a differently-cased variant (e.g., lowercase equivalent) is already in the array. If `grep` is already there, do **not** add `Grep`. Only add a capitalized variant if the lowercase form is absent.



### Style Rules

- Use leading comma style: `,"new_tool": "Friendly Name"`
- Group related tools together (same MCP server prefix, same tool category)
- Insert new MCP entries near existing entries with the same prefix
- Insert new non-MCP entries alphabetically or near logically related tools
- Never remove existing entries
- **Case-insensitive deduplication**: Before adding a new tool ID, check whether a lowercase (or differently-cased) variant already exists. If `grep` is already mapped, do **not** add `Grep`. If `tool_search` is already mapped, do **not** add `ToolSearch`. The lookup code handles exact-match only, so capitalized variants do map differently — but if both would resolve to the *exact same friendly name*, skip the duplicate. Only add a capitalized variant when it has a meaningfully different name or the lowercase form does not exist at all.

### Validation

After editing `src/toolNames.json`:

1. Run `npm run compile` to verify ESLint + build passes
2. Ensure the JSON is valid (no trailing commas, proper quoting)
3. Run tests with `npm run test:node` to confirm nothing is broken

## Upstream Sync Reference

The `sync-toolnames` workflow (`.github/workflows/sync-toolnames.yml`) automatically syncs tool IDs from `microsoft/vscode-copilot-chat` using the prompt at `.github/workflows/prompts/sync-toolnames-prompt.md`. This covers VS Code built-in and Copilot tools. MCP tool names from user sessions are **not** covered by this sync and must be added manually via issues.

## Checklist

- [ ] Identify all unknown tool names from the issue
- [ ] Determine if each tool is MCP or non-MCP
- [ ] For MCP tools, match the prefix to a known server or research the source
- [ ] Generate friendly names following the conventions above
- [ ] Add entries to `src/toolNames.json` in the correct location
- [ ] For each new tool, decide if it is **automatic** or **intentional** — add automatic tools to `src/automaticTools.json`
- [ ] Run `npm run compile` to validate
- [ ] Run `npm run test:node` to confirm tests pass
