# Cline Session Storage (VS Code extension `saoudrizwan.claude-dev`)

## Summary

[Cline](https://cline.bot) is an autonomous coding agent that runs as a VS Code
extension (extension id `saoudrizwan.claude-dev`, originally "Claude Dev"). It works in
any VS Code family host (Code, Code - Insiders, VSCodium, Cursor, ...) and stores one
folder per **task** (its session unit) under the host editor's `globalStorage`.

Cline records **real API token counts per request** — no estimation is needed. The
integration is a regular `IEcosystemAdapter` (`ClineAdapter` in
`src/adapters/clineAdapter.ts`, backed by `ClineDataAccess` in `src/cline.ts`)
registered in the shared `src/adapters/adapterRegistry.ts`.

Verified against a live install (Cline 4.0.x, 2026-07) on Windows.

## Storage location

Per VS Code variant host:

| OS | Path |
|---|---|
| Windows | `%APPDATA%\<Variant>\User\globalStorage\saoudrizwan.claude-dev\` |
| macOS | `~/Library/Application Support/<Variant>/User/globalStorage/saoudrizwan.claude-dev/` |
| Linux | `$XDG_CONFIG_HOME/<Variant>/User/globalStorage/saoudrizwan.claude-dev/` (fallback `~/.config/...`) |

where `<Variant>` is `Code`, `Code - Insiders`, `Code - Exploration`, `VSCodium`,
`Cursor`, or a `.vscode-server*` remote data dir. Discovery reuses
`getVSCodeUserPaths()` from `src/adapters/copilotChatAdapter.ts`.

Inside the storage root (confirmed layout):

```
saoudrizwan.claude-dev/
├── state/
│   └── taskHistory.json          ← per-task summary index (authoritative totals)
├── tasks/
│   └── <taskId>/                 ← taskId = task start time in epoch ms
│       ├── ui_messages.json      ← canonical session file for this integration
│       ├── api_conversation_history.json
│       ├── task_metadata.json
│       └── focus_chain_taskid_<taskId>.md (optional)
├── settings/  cache/  checkpoints/
```

The **standalone Cline app data dir `~/.cline/data/`** contains only settings
(`globalState.json`, `secrets.json`, `workspaces/<hash>/workspaceState.json` with rules
toggles) — **no session data lives there** (confirmed across 27 workspace folders on the
test machine).

## Canonical session file

`<...>/saoudrizwan.claude-dev/tasks/<taskId>/ui_messages.json` — a real file, so no
virtual-path scheme is needed. Path detection marker: `/saoudrizwan.claude-dev/tasks/`
(checked **before** the generic `/code/` and `/cursor/` VS Code-variant matches in both
`src/workspaceHelpers.ts` and `cli/src/analysis.ts`, since the path always contains the
host editor's folder name).

## File formats

### `tasks/<taskId>/ui_messages.json`

JSON array of ordered UI messages. All timestamps are **epoch milliseconds**.

```jsonc
{
  "ts": 1782681323228,
  "type": "say",              // or "ask" (user-approval prompts)
  "say": "api_req_started",   // subtype; "ask" messages use an "ask" field instead
  "text": "...",              // free text or JSON payload depending on subtype
  "modelInfo": { "providerId": "cline", "modelId": "stepfun/step-3.7-flash", "mode": "act" },
  "conversationHistoryIndex": 0
}
```

Observed `say` subtypes and how the integration uses them:

| Subtype | Meaning | Used for |
|---|---|---|
| `task` | The user's initial prompt | Turn start, interaction count, title fallback |
| `user_feedback` | A follow-up user message | Turn start, interaction count |
| `api_req_started` | One LLM API request; once complete, its `text` field holds JSON `{ request, tokensIn, tokensOut, cacheWrites, cacheReads, cost }` | **Real token counts**, model usage, daily fractions |
| `reasoning` | Model thinking text | (not counted separately — included in `tokensOut`) |
| `text` / `completion_result` | Assistant response text (may embed raw `<tool_call>` XML, stripped for display) | Turn assistant text |
| `tool` | Tool invocation+result, `text` = JSON `{ tool, path, content }` (e.g. `searchFiles`) | Tool-call analysis |
| `command` / `command_output` | Terminal command + output | Tool-call analysis (`executeCommand`) |
| `use_mcp_server` | MCP call, `text` = JSON `{ serverName, toolName }` | MCP analysis |
| `task_progress`, `checkpoint_created`, `browser_action*` | Bookkeeping / browser | ignored / browserAction tool call |

### `state/taskHistory.json`

JSON array with one summary entry per task (authoritative totals written by Cline):

```jsonc
{
  "id": "1782681302220",            // = tasks/<taskId> folder name
  "ulid": "01KW81BX6G...",
  "ts": 1782681581474,               // last activity, epoch ms
  "task": "how many users does cline have?",   // title
  "tokensIn": 16962, "tokensOut": 606,
  "cacheWrites": 0, "cacheReads": 13312,
  "totalCost": 0,
  "size": 74316,
  "cwdOnTaskInitialization": "c:\\Users\\...\\my-project",  // workspace path
  "modelId": "stepfun/step-3.7-flash"
}
```

Used for: session title, workspace path, and token fallback when a task predates the
per-request `api_req_started` token fields.

### `tasks/<taskId>/api_conversation_history.json`

Anthropic-style message array: `{ role, content: [{type: text|thinking|tool_use|...}],
ts }` plus, on assistant messages, `modelInfo` and
`metrics: { tokens: { prompt, completion, cached }, cost }`. Not read by the
integration (ui_messages.json carries the same token data with per-request timestamps),
but useful for debugging.

### `tasks/<taskId>/task_metadata.json`

`files_in_context[]`, `model_usage[] { ts, model_id, model_provider_id, mode }`, and
`environment_history[] { os_name, host_name ("Visual Studio Code"), host_version,
cline_version }`. Not currently read.

## Token accounting

Total session tokens = Σ per request `(tokensIn + cacheWrites + cacheReads) + tokensOut`
— the same input-includes-cache formula the Claude Code adapter uses. `ModelUsage`
entries carry `cachedReadTokens` / `cacheCreationTokens` breakdowns. `actualTokens`
equals `tokens` (real API counts). Thinking tokens are not tracked separately
(reasoning output is part of `tokensOut`), so `thinkingTokens` is 0.

## Modes

`modelInfo.mode` is `act` (agentic, default) or `plan`; mapped to the `agent` / `plan`
mode buckets in usage analysis.

## Display name / icon

Editor display name: **`Cline`** (all three sources of truth:
`cli/src/analysis.ts::getEditorSourceFromPath`,
`src/workspaceHelpers.ts::getEditorTypeFromPath`, and `EDITOR_ICON_MAP` in
`src/editorIcons.ts`, icon 🤖).
