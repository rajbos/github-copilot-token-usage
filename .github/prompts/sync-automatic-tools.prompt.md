---
mode: 'agent'
description: 'Review and improve the automatic vs intentional tool classification in src/automaticTools.json.'
tools: ['read_file', 'write_file', 'search_files']
---

# Review Automatic Tool Classification

Audit `src/automaticTools.json` against `src/toolNames.json` to ensure every tool is classified correctly. The classification directly affects fluency/maturity scoring in the extension — tools in `automaticTools.json` are considered **automatic** (Copilot invokes them on its own) and are **excluded** from the user's intentional tool usage score. Tools that are not in that list are counted as **intentional** (the user deliberately enables or configures them).

## Classification Rules

Apply the rules below in priority order. When a tool matches multiple rules, the first matching rule wins.

### Rule 1 — MCP tools are ALWAYS intentional (never automatic)

Any tool whose ID starts with `mcp_`, `mcp.`, or `mcp__` is a user-configured external MCP server tool. These must **never** appear in `automaticTools.json`.

- Examples: `mcp_github_search_code`, `mcp_io_github_git_create_pull_request`, `mcp__workspace__web_fetch`
- Reason: the user must explicitly install and configure an MCP server; Copilot does not add them autonomously.

### Rule 2 — Write / modify / execute tools are intentional

Tools that write to disk, run commands, install packages, or otherwise have side effects outside the AI context window are **intentional**:

| Category | Examples |
|---|---|
| File editing | `edit_file`, `edit_files`, `copilot_editFiles`, `copilot_writeFile`, `copilot_applyPatch`, `copilot_replaceString`, `copilot_multiReplaceString`, `insert_edit_into_file`, `replace_string_in_file`, `multi_replace_string_in_file`, `write`, `edit`, `multiedit`, `apply_patch` |
| File creation/deletion | `create_file`, `create_directory`, `remove_file`, `copilot_createFile`, `copilot_createDirectory` |
| Terminal execution | `run_in_terminal`, `run_build`, `run_command_in_terminal`, `copilot_runInTerminal`, `run_vscode_command`, `copilot_runVscodeCommand`, `kill_terminal`, `run_task`, `create_and_run_task`, `copilot_createAndRunTask` |
| Test / notebook execution | `runTests`, `copilot_runTests1`, `run_notebook_cell`, `copilot_runNotebookCell`, `copilot_editNotebook` |
| Package / environment management | `install_extension`, `copilot_installExtension`, `install_python_packages`, `create_virtual_environment`, `configure_python_environment` |
| Symbol refactoring | `vscode_renameSymbol` |
| Browser interaction | `click_element`, `navigate_page`, `open_browser_page`, `type_in_page`, `run_playwright_code` |
| Todo writing | `todowrite`, `TodoWrite`, `manage_todo_list` |
| Web fetching | `fetch_webpage`, `copilot_fetchWebPage`, `webfetch`, `websearch`, `WebSearch`, `vscode-websearchforcopilot_webSearch` |

### Rule 3 — Read / search / inspect tools are automatic

Tools that only read, list, or search without side effects are **automatic**. Copilot calls them transparently during exploration:

| Category | Examples |
|---|---|
| File reading | `read_file`, `read`, `view`, `copilot_readFile`, `get_file`, `get_currentfile` |
| Directory listing | `list_dir`, `ls`, `copilot_listDirectory`, `listFiles` |
| File / text search | `find_files`, `file_search`, `file_glob_search`, `glob`, `grep`, `grep_search`, `copilot_findFiles`, `copilot_findTextInFiles`, `copilot_findTestFiles`, `test_search` |
| Code / symbol search | `semantic_search`, `code_search`, `copilot_searchCodebase`, `copilot_getSearchResults`, `get_search_view_results`, `search_workspace_symbols`, `copilot_searchWorkspaceSymbols`, `vscode_listCodeUsages`, `get_symbols_by_name` |
| Errors & diagnostics | `get_errors`, `copilot_getErrors`, `test_failure`, `copilot_testFailure` |
| Project metadata | `read_project_structure`, `copilot_readProjectStructure`, `get_project_setup_info`, `copilot_getProjectSetupInfo`, `get_files_in_project`, `get_projects_in_solution`, `get_python_executable_details` |
| Doc / API info | `get_doc_info`, `copilot_getDocInfo`, `get_vscode_api`, `copilot_getVSCodeAPI` |
| Changed files | `get_changed_files`, `copilot_getChangedFiles` |
| Notebook / image reading | `read_notebook_cell_output`, `copilot_readNotebookCellOutput`, `copilot_getNotebookSummary`, `view_image`, `copilot_viewImage` |
| Terminal output reading | `get_task_output`, `job_output`, `get_terminal_output`, `await_terminal`, `terminal_selection`, `terminal_last_command` |
| Memory / context | `memory`, `copilot_memory`, `detect_memories` |
| Tool introspection | `tool_replay`, `copilot_toolReplay`, `tool_search` |
| Confirmations | `vscode_get_confirmation`, `vscode_get_confirmation_with_options`, `vscode_get_terminal_confirmation`, `vscode_get_modified_files_confirmation` |
| Clarification questions | `ask_questions`, `AskUserQuestion`, `copilot_askQuestions`, `vscode_askQuestions` |
| Agent switching | `switch_agent`, `copilot_switchAgent`, `setup.agent` |
| Internal VS Code variants | `vscode_editFile_internal`, `vscode_fetchWebPage_internal`, `vscode_searchExtensions_internal` |
| Skill reading | `read_skill`, `skill` |
| Diagram rendering | `renderMermaidDiagram` |
| Task subagents | `search_subagent`, `runSubagent` |

### Rule 4 — Single-word tool heuristic (tie-breaker for unknowns)

When a tool ID is a **single word** (no `_`, `.`, `-`) and its name suggests read/lookup behaviour (e.g. `read`, `view`, `grep`, `glob`, `ls`), default to **automatic**. Single-word tools that clearly write or execute (e.g. `write`, `edit`, `task`) are **intentional**.

## Procedure

1. Load `src/toolNames.json` — this is the complete set of known tool IDs.
2. Load `src/automaticTools.json` — the current automatic tool set.
3. For **every** tool ID in `toolNames.json`:
   a. Apply Rules 1–4 to decide: **automatic** or **intentional**.
   b. If the tool should be **automatic** and is **missing** from `automaticTools.json`, add it.
   c. If the tool is currently in `automaticTools.json` but should be **intentional** (e.g. it matches Rule 1 or 2), remove it.
4. Write the updated array back to `src/automaticTools.json`, preserving the existing comment-style grouping (blank lines between logical groups).

## Output

- Modify only `src/automaticTools.json`.
- Do **not** open a PR.
- After writing the file, print a concise summary:
  - Number of tools **added** (with IDs)
  - Number of tools **removed** (with IDs and the reason)
  - Total tools in the updated file
