# Copilot Memory Files Insight

Status: **Implemented** — shared analysis module, VS Code insight card, CLI
command, `extension.ts` runtime wiring, and a Tools-tab UI section are all
live.

> **Local memory only.** This document covers the Markdown memory files Copilot
> Chat writes on *this machine*. Copilot also keeps a separate, server-side memory
> store per repository — see
> [COPILOT-SERVER-MEMORIES.md](COPILOT-SERVER-MEMORIES.md). The metadata-only rule
> below applies here and not there.

## Background

GitHub Copilot's agent (`GitHub.copilot-chat`) writes its own Markdown "memory"
notes to disk as it works — project conventions, decisions, gotchas, scratch
plans. There is no built-in VS Code UI for these; the community extension
[jlieuw/memowl](https://github.com/jlieuw/memowl) fills that gap by browsing
them in a sidebar.

Investigating memowl's source (`README.md`, `src/memoryStore.ts`) confirmed the
on-disk layout and a local scan of this machine confirmed **real memory data
exists** for several projects. This doc proposes surfacing the same data as a
lightweight insight in this extension, since we already resolve the same
`workspaceStorage/<hash>` paths for session parsing.

## On-disk layout (verified)

```
<User>/globalStorage/GitHub.copilot-chat/memory-tool/memories/                <- User (global) scope
<User>/workspaceStorage/<hash>/GitHub.copilot-chat/memory-tool/memories/
    repo/<name>.md                                                             <- Repository scope (literal "repo" folder)
    <base64(sessionId)>/<name>.md                                              <- Session scope, common/observed layout
                                                                                    (folder name is the base64-encoded
                                                                                    chat session UUID, NOT a literal
                                                                                    "session" folder — this diverges
                                                                                    from memowl's README wording and
                                                                                    must be handled explicitly)
    session/<name>.md                                                          <- Session scope, older/alternate layout
                                                                                    (literal "session" folder, no UUID
                                                                                    to decode). Both layouts are
                                                                                    recognized and folded into
                                                                                    session-scope counts.
```

The session-scope folder name decodes (base64) to the same session UUID used
in `workspaceStorage/<hash>/chatSessions/<sessionId>.jsonl`, so a memory file
can be correlated back to the specific chat session that created it.

Confirmed present on this machine, across VS Code + Insiders, for 4 of 8
scanned `workspaceStorage` hashes (repo-scope and session-scope both observed);
no `globalStorage` (user-scope) memories were present.

## Reusable code in this repo

`src/workspacePathResolver.ts` (shared, not VS Code-specific) already exposes
`parseWorkspaceStorageJsonFile()`, which reads a `workspace.json`/`meta.json`
file and extracts the real workspace folder path from its candidate keys.
`copilotMemoryFiles.ts` reuses this directly to resolve a `workspaceStorage/<hash>`
back to a friendly folder name, instead of re-implementing the JSON parsing.

`src/adapters/copilotChatAdapter.ts` also already exposes `getVSCodeUserPaths()`,
which enumerates every VS Code variant's "User" root across Windows/macOS/Linux.
Under WSL it does not include the native Windows-side roots on its own —
`copilotMemoryFiles.ts`'s `getDefaultUserPaths()` additionally calls the
separate `getWSLWindowsPathsSync()` helper and merges its results in, so full
WSL coverage is a two-step combination of both functions, not
`getVSCodeUserPaths()` alone.

## Original design proposal (historical)

> The section below is the original design proposal written before this
> feature was implemented. It is kept for historical context; see
> "What's implemented" further down for the actual shipped surface — a
> Tools-tab section, not a new panel/tab, and without the linked-session
> cross-reference described here (session data is not correlated back to
> chat-session logs in the shipped UI).

A new read-only panel/tab (or a card in an existing insights view) showing,
per known workspace:

| Metric | Source |
|---|---|
| # repo-scope memory files | count of `.md` under `memories/repo/` |
| # session-scope memory files | count of `.md` under base64 session folders |
| Staleness | newest/oldest `mtime` per file |
| Size | file size, flagged if unusually large (e.g. the observed 20KB file) |
| Linked session | decode session-folder name → cross-reference existing chat-session parsing, if the session log is also ingested |

No content of the memory files themselves would be surfaced beyond a
filename-derived title — this is metadata/insight only, not a memory browser
(memowl already does that well). Scope is intentionally narrow: help users
notice **memory files piling up, going stale, or growing unexpectedly
large**, as a hygiene signal, not to duplicate memowl's read/manage UI.

## Resolved design decisions

1. **Surface**: a "Copilot Memory Files" section on the existing **Tools tab**
   (`#section-memory-files`, right after Tool Curation), not a new tab.
2. **Scan scope**: all `workspaceStorage` hashes across every known VS Code
   "User" root on the machine (like the existing multi-workspace session
   scanning), not just the current workspace.
3. **Privacy**: metadata-only. Only `title` (the filename, no extension) is
   surfaced — never file content or first-line previews.


`extension.ts`'s `computeMemoryFilesAnalysis()` calls `discoverAllMemoryFiles()`
and `analyzeMemoryFiles()` (metadata-only, default thresholds) once per stats
build and populates `UsageAnalysisStats.memoryFilesAnalysis`, threaded through
both `InsightContext` builders (toast/badge path and the Insights-tab path) and
all three webview payload builders (silent refresh, full refresh, initial
load) alongside `curationAnalysis`. The underlying scan is a synchronous
`readdirSync`/`statSync` walk, so `computeMemoryFilesAnalysis()` throttles it
to at most once per `MEMORY_FILES_SCAN_TTL_MS` (5 minutes) via the pure
`isMemoryFilesScanFresh()` helper, reusing the cached result across recomputes
in between; an explicit Usage Analysis refresh or `clearCache()` resets the
scan timestamp so the user always gets current data on demand. The two
webview payload builders never send the full `MemoryFilesAnalysis` (which
carries every file's absolute path and session ID) — `toMemoryFilesAnalysisView()`
projects it down to a compact `MemoryFilesAnalysisView` (counts/rollup scalars
only) first, keeping the full analysis for the host-side insight context and
the CLI. The webview (`webview/usage/main.ts`) sanitizes and renders that view
as a "Copilot Memory Files" section on the Tools tab, right after Tool
Curation, listing per-workspace file counts/size/staleness — following the
same persist-across-refresh caching pattern already used for
`curationAnalysis`.

## What's implemented

| Piece | Location |
|---|---|
| Discovery + analysis (pure, shared) | `src/copilotMemoryFiles.ts` — `discoverAllMemoryFiles()`, `discoverMemoryFilesInUserPath()`, `analyzeMemoryFiles()`, `toMemoryFilesAnalysisView()`, `decodeSessionFolderName()` |
| Types | `src/types.ts` — `MemoryFileEntry`, `MemoryFilesWorkspaceSummary`, `MemoryFilesAnalysis`, `MemoryFilesAnalysisView` (compact webview projection) |
| Unit tests | `vscode-extension/test/unit/copilotMemoryFiles.test.ts` |
| Insight card | `vscode-extension/src/insightsEngine.ts` — id `stale-memory-files`, fires when `InsightContext.memoryFilesAnalysis` has stale or oversized files; tests in `insightsEngine.test.ts` |
| CLI command | `cli/src/commands/memory-files.ts` — `ai-engineering-fluency memory-files [--json] [--stale-days] [--large-kb]`, registered in `cli/src/program.ts` |
| Runtime wiring | `vscode-extension/src/extension.ts` — `computeMemoryFilesAnalysis()` (TTL-cached via `isMemoryFilesScanFresh()`), threaded into both insight-context builders and all `updateStats`/initial-payload builders (projected to `MemoryFilesAnalysisView` before being sent) |
| Tools-tab UI | `vscode-extension/src/webview/usage/main.ts` — `buildMemoryFilesSectionHtml()`, `_sanitizeMemoryFilesAnalysis()`, `#section-memory-files` |

The CLI command scans this machine's real `workspaceStorage`/`globalStorage`
folders (no fixtures needed) and was manually verified against the memory
files already present on this machine.

