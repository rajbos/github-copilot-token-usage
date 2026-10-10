# Per-tool execution stats: reliability, latency, MCP health, cost-vs-speed

## Context

Session logs already record, per tool call, whether it failed and when it started
and finished. Nothing in the analysis layer kept that: `ToolCallUsage` held call
counts and (for Copilot CLI only) output tokens, `McpToolUsage` held call counts
per server, and the Copilot CLI parser paired `tool.execution_start` with
`tool.execution_complete` by `toolCallId` only to count edit LOC.

Four panels become possible once that data is kept:

| Panel | Needs |
|---|---|
| Tool execution reliability | success vs. failure count per tool |
| Tool latency profile | p50 / p95 observed duration per tool |
| MCP server health | call count and failure share per server |
| Cost vs speed map | p50 latency × tokens per call × call count, coloured by tool kind |

A probe of the logs on a developer machine (aggregates only, no prompt or result
text) confirmed the raw material exists:

| Source | Paired calls | Latency | Failure flag |
|---|---|---|---|
| Copilot CLI (`~/.copilot/session-state/**/events.jsonl`) | ~68k, 99.9 % paired by `toolCallId` | ISO `timestamp` on both events | `data.success === false` (2.6 %), plus `data.error.{message,code}` |
| Claude Code (`~/.claude/projects/**/*.jsonl`) | ~20.6k `tool_use` / `tool_result` paired by `tool_use_id` | message timestamps (`toolUseResult.durationMs` is present on < 1 %) | `tool_result.is_error` (3.6 %) |
| VS Code Copilot Chat debug logs (`workspaceStorage/*/GitHub.copilot-chat/debug-logs/*/main.jsonl`) | ~1.8k `tool_call` events | `dur` | `status`, `attrs.error` |

Copilot CLI additionally reports `data.mcpServerName` / `data.mcpToolName` on the
start event of MCP calls, which is how per-server attribution is done without
guessing from the tool name.

## Decisions

**Store additive records, never averages or percentiles.** Period aggregation
(`mergeUsageAnalysis`), the session cache, and the backend rollups
(`mergeJsonMetrics` sums `toolCallsJson` generically) all merge by addition. A
stored average or percentile would silently become wrong after the first merge.

**Latency is a log-spaced histogram** (`src/latencyHistogram.ts`): bucket `i`
counts durations in `[2^i, 2^(i+1))` ms, 23 buckets (1 ms … ~70 min, last is
overflow), plus `count` and `sumMs`. p50/p95 are derived at read time by
log-interpolating inside the bucket that holds the target rank — accurate to a
factor of two, which is what a log-axis chart needs, at ~25 integers per tool.
Merging tolerates bucket arrays of differing length so a future bucket-count
change does not invalidate old entries.

**Latency means observed duration.** The start→complete delta includes
permission prompts, queueing and user wait time (`read_powershell` has a p50 of
~30 s locally for exactly this reason). UI labels must say "observed execution
duration", not "tool speed".

**Outcomes are tri-state.** `success === false` (Copilot CLI / JetBrains) and
`is_error === true` (Claude Code) are failures; an explicit `true` (or a Claude
result without `is_error`) is a success; a result with no verdict at all —
older Copilot CLI schemas omit `success` — is *unknown* and stays out of
`completedBy*` so it cannot masquerade as a success, while its latency is still
recorded. Starts with no matching complete event (aborted sessions) record
nothing; they are the raw material for an "abandoned" outcome later, not
failures.

**Fields are optional extensions of the existing types** (`ToolCallUsage.
completedByTool` / `failuresByTool` / `latencyByTool`, `McpToolUsage.
completedByServer` / `failuresByServer` / `latencyByServer`). Old cache entries,
and editors whose format has no flag or timestamps, simply lack them; readers
must treat absence as "no data", not zero.

**`completedBy*` is the denominator, never `byTool` / `byServer`.** `byTool`
counts *starts* from every editor — including formats with no completion events,
orphaned starts and Claude Code's streaming re-logs of the same `tool_use` — so
dividing outcome-bearing numbers (failures, result tokens) by it understates
failure rates and tokens per call. `completedBy*` counts exactly the matched
completions the other maps are drawn from, so the reliability bars, the MCP
failure share and the cost-vs-speed map all use it. It also makes "every call
succeeded" distinguishable from "no outcome data": the former has
`completedByTool` and no `failuresByTool`.

**MCP outcomes are recorded per server only.** `recordToolOutcome` routes a call
with a known server to the `mcpTools` maps and everything else to `toolCalls`,
mirroring how `recordToolOrMcpInvocation` keeps MCP calls out of `toolCalls`.

**One writer.** `recordToolOutcome()` in `src/usageAnalysis.ts` is the only
function that touches the six maps, so every session format that gains a flag
or timestamps funnels through the same bookkeeping and `__proto__`-style key
guard.

**Tool kind is classified in one place** (`src/toolKind.ts`,
`classifyToolKind()` → `builtin | mcp | subagent | skill`). The signals existed
but were scattered: MCP prefixes in `workspaceHelpers.isMcpTool`, delegation
names in `taskClassification.DELEGATION_TOOL_PATTERN`, the `Skill` / `skill` /
`__slash__` wrappers in the Claude Code and Copilot CLI parsers, and Copilot
CLI's `<server>-mcp-server-<tool>` naming that `isMcpTool` does not match.

**Cache version bump.** `CopilotTokenTracker.CACHE_VERSION` 77 → 78 (the branch
started at 75 → 76; `main` took 76 and 77 for autonomy usage and the Copilot CLI
MCP routing while this was in review). A
mtime/size hit skips re-analysis, so without the bump existing entries would
never gain the new fields.

## Phases

### Phase 1 — model, histogram, Copilot CLI / JetBrains (done)

- `src/latencyHistogram.ts`, `src/toolKind.ts` (new).
- `src/types.ts`: `LatencyHistogram`, the six optional fields (three on
  `ToolCallUsage`, three on `McpToolUsage`); mirrored in
  `vscode-extension/src/webview/shared/types.ts`.
- `src/usageAnalysis.ts`: `recordToolOutcome()`; the Copilot CLI pending-call
  map now keeps `startedAt` and `mcpServer` from the start event;
  `_asuHandleToolComplete` records outcome before the existing LOC / output-token
  logic; `mergeUsageAnalysis` sums the new maps via `_muaMergeToolOutcomes`.
- `vscode-extension/src/extension.ts`: cache version bump (78 after the merge).
- Tests: `latencyHistogram.test.ts`, `toolKind.test.ts`, two new cases in
  `usageAnalysis.test.ts` (synthetic JSONL covering success, explicit failure,
  zero-delta, MCP server attribution, missing flag, missing timestamp, orphaned
  start; and merge additivity with an old-shape entry).
- `docs/logFilesSchema/session-file-schema.json`: `tool.execution_start` /
  `tool.execution_complete` `usedBy` updated.

Verified against local logs via the CLI: 88 tools with latency samples, 43 with
failures, two MCP servers with per-server counts.

### Phase 2 — Claude Code / Claude Desktop adapters (done)

`ClaudeToolOutcomeTracker` in `src/adapters/claudeCodeAdapter.ts` is shared by
both adapters. It remembers each `tool_use` block's id, name, MCP server (from
the `mcp__server__tool` prefix) and event timestamp — first sighting wins,
because Claude Code re-logs streaming fragments of the same assistant message —
and on the matching `tool_result` block (a harness-replayed `user` event, matched
by `tool_use_id`, sidechain events included) calls `recordToolOutcome(…,
!is_error, resultTimestamp − startedAt)`. Non-MCP result text is sized with
`estimateTokensFromText` into `outputTokensByTool`, so the cost-vs-speed map is
no longer Copilot-only. The ~0.5 % of results carrying
`toolUseResult.durationMs` are deliberately ignored in favour of one consistent
source.

### Phase 3 — UI (done)

Usage Analysis › Workspace › Tools & Integrations, directly below the Tool
Usage tables, as four sections built by
`vscode-extension/src/webview/usage/toolExecutionHtml.ts` from the Last 30 Days
period: `#section-tool-reliability` (stacked success/failure bars),
`#section-tool-latency` (log x-axis, p50 bar + p95 marker),
`#section-mcp-health` (calls with "N · x% fail" labels) and
`#section-tool-cost-speed` (log/log bubble map, size = calls, colour =
`classifyToolKind` over builtin / subagent / skill — MCP is excluded because MCP
outcomes live per server and MCP result tokens are not sized, so an MCP bubble
would have no y value). Hand-written SVG rather than Chart.js: `main.ts` already
sits past the 6000-line `max-lines` ceiling and has an SVG precedent in the
efficiency frontier chart, so the sections live in their own module and the
usage bundle stays chart-library-free. The automatic-tool filter the tables
honour applies here too. Each section renders an explanatory empty state when
its map is absent, so an old cache or an editor without the data never shows a
blank chart. Strings are `usage.toolExec.*` webview keys (en + zh-cn, covered
in `l10n.test.ts`); the visual-diff fixture carries sample histograms so the CI
screenshots show populated charts. `isMcpTool` moved to
`src/utils/toolUtils.ts` (re-exported from `workspaceHelpers`) so `toolKind.ts`
is importable from a webview bundle without pulling in `vscode`.

What's New: `vscode-extension/src/whatsNew/catalog.ts` carries a `0.19.1`
entry (`date: null` until release prep sets it) with one `section` feature,
`usage.tool-execution-stats`, whose surface is view `usage`, tab `tools`,
anchor `section-tool-reliability`. The catalog test requires an unreleased
entry to match `package.json`, so the extension version is bumped to 0.19.1
in the same change; headline and feature strings exist in English and zh-CN
and are asserted in `l10n.test.ts`.

### Phase 4 — VS Code Copilot Chat debug logs, other adapters

The debug-log `tool_call` event (`dur`, `status`, `attrs.error`) is the only
source for VS Code Chat tool latency; nothing reads it today
(`tokenEstimation.ts` parses only `llm_request`). It is per workspace, not per
session file, so decide between folding by `sid` or a workspace-level bucket
before wiring it in `vscode-extension/src/analysis/sessionFileAnalyzer.ts`.
OpenCode/Kilo (`time.start` on tool parts) and Hermes (`tool_call_id` pairing
in `buildTurns`) can adopt `recordToolOutcome` one adapter at a time.

### Phase 5 — workflow-pathway Sankey (deferred)

Session → mode → tool kind → outcome needs a per-session joint record and a
definition of "abandoned" (candidate: session ends on an unpaired tool start).
Write that definition down before building.

## Consequences

- Sync payloads: `syncService.ts` serialises `toolCalls` / `mcpTools` into
  `toolCallsJson` / `mcpToolsJson`, and an Azure Table string property is capped
  at 64 KiB while a day's rollup keeps the union of every tool. The latency
  histograms (~25 integers per tool) are therefore stripped from the uploaded
  JSON (`stripLatencyHistograms`) — nothing server-side reads them — and only
  the count maps travel, so the payload stays bounded by distinct tools × a few
  counters. `mergeNestedObject` in the rollups still sums histograms element-wise
  should they ever be uploaded.
- All new fields are counts and durations keyed by tool / server name. No prompt
  or result text is stored, so the sharing-server data contract is unaffected
  and no skill `SECURITY.md` changes.
- The CLI's `usage-analysis --json` output gains the six optional keys; the
  Visual Studio and JetBrains hosts ignore unknown keys.
- Copilot CLI tags MCP starts with `data.mcpServerName` (older events used
  `data.mcpServer`); `_asuEventMcpServerName` reads both, so those calls land
  in `mcpTools.byServer` and the per-server outcome maps key on the same name.
