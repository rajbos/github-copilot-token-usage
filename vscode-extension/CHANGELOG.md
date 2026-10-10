# Change Log

All notable changes to the VS Code extension will be documented in this file.

## [Unreleased]

### Features
- Usage Analysis → Workspace → Tools & Integrations gains four sections built from per-tool execution data that was already in the session logs but never kept: **Tool execution reliability** (success vs. failure volume per tool), **Tool latency profile** (p50 bar + p95 marker of the observed start→result duration per tool, including permission-prompt and queueing time), **MCP server health** (calls and error share per connected server), and a **Cost vs speed map** (p50 latency × tokens per call for built-in, subagent and skill tools; bubble size = calls; MCP calls are covered per server by the health section). Recorded from Copilot CLI and JetBrains (`tool.execution_start`/`complete`) and Claude Code / Claude Desktop (`tool_use`/`tool_result`) sessions; other editors show an explanatory empty state. Session cache version bumped so existing entries are re-analysed. See `docs/adr/TOOL-EXECUTION-STATS.md`.
- Usage Analysis → Workspace → Workspace Health: the **Copilot Customization Files** table now shows 20 workspaces per page with sortable columns (workspace, sessions, a new interactions column, and each customization type, which sorts ✅ > ⚠️ > ❌). Hovering a workspace name shows its full path, so two workspaces with the same folder name can be told apart. A new "Only workspaces without customization files" toggle lists just the ones the warning counts, and the header stays visible while you scroll (#2289)
- Tool Curation's MCP server, built-in tool and unused-skill tables can now be sorted and browsed in 10-row pages; the MCP usage filter is applied before pagination, and table controls keep working after refreshes (#2303, #2285)
- The Efficiency view's Models tab can now compare Copilot CLI's **HydraFusion** and **Auto** routers against ordinary models. The CLI keys a routed session's turn counters by the router you picked but its token metrics by the real models that served each leg, so the router showed up as "0 sessions, low sample" with every per-session ratio blank, while the real models were charged the router's tokens and cost without the matching edit turns. Routed sessions are now attributed to the router (priced at each leg's own model rate; a model you also picked by name during the session keeps its own usage), HydraFusion is filed under the GitHub Copilot vendor instead of "Other" (the bare `auto` id is left unclassified, since Kiro CLI records its sessions under `auto` too), and they display as "HydraFusion" / "Auto". A session that switched between the two routers is left as-is, since its token metrics cannot be split between them. The Usage view and the Session Log Viewer's HydraFusion Routing section still show the real models behind each leg

- What's New gains a **View index** tab: a tree of every view, its tabs (and tab groups) and the sections on each tab, each with a short description. A fuzzy search across names, descriptions and keywords narrows it down, and the open button on any line opens that view, switches to the tab and scrolls to the section. Panels other than Usage Analysis learn a shared `revealSurface` request for this, so What's New "Take me there" buttons now land on the right tab and section in those panels too (and the Usage Analysis → GitHub → Cloud Agent tab can now be deep-linked)
- Every table in every view now uses one shared table component, so tables look and behave the same everywhere: the same layout and styling (with a high-contrast variant), sortable column headers with ↑/↓ indicators, and the same Previous/Next pager at 10 rows per page (fixed-structure tables such as configuration details show all rows). Tables that could only be read top to bottom — e.g. in Diagnostics, the Log Viewer, Details, the Team Dashboard and Efficiency — can now be sorted and paged. See `docs/vscode-extension/DATA-TABLE.md`

### Bug Fixes
- The exact Copilot billed cost of a resumed Copilot CLI session is no longer counted more than once. `totalNanoAiu` is a running total for the whole session, repeated in every `session.usage_checkpoint` and `session.shutdown` event, including after a resume. The latest value is now used instead of the sum of all shutdowns. Sessions that are still running get it from their latest usage checkpoint instead of falling back to an estimate. The session cache version was bumped so already-cached sessions are re-analysed
- Efficiency → Models no longer inflates the cost per edit turn and cost per session of models that served HydraFusion or Auto legs (see the HydraFusion comparison feature above)

## [0.19.0] - 2026-10-02

### Features
- Copilot budget is now shown for every GitHub account signed in to VS Code for the configured GitHub host (github.com by default, or your GitHub Enterprise host when `github-enterprise.uri` is set), not just the one VS Code prefers for the extension: a "GitHub accounts" list in the status bar tooltip, the Usage view's AI Billing Coverage section and the Diagnostics quota card (a lone account that already has a balance is not repeated; never prompts to sign in)
- The Usage Analysis view's ten tabs now sit under four group tabs — **📊 Usage** (My Activity, Recent Sessions), **📁 Workspace** (Tools & Integrations, Workspace Health, AI Readiness, Worktrees), **🐙 GitHub** (Repository PRs, Cloud Agent) and **🎓 Coaching** (Insights, Corrections) — matching the group-tab/leaf-tab strip the Diagnostics view already uses. The flat ten-tab strip wrapped onto a second row at ordinary panel widths and gave no hint that, say, Repository PRs and Cloud Agent are the same kind of thing. Re-opening a group returns you to the tab you last had open in it. Tab ids are unchanged, so "Take me there" links from What's New and the worktree notification's "Show Me" action still land on the right tab (and now open its group with them)
- The Usage Analysis "My Activity" tab is now grouped into three labelled bands instead of nine sibling sections in one flat stack: **📊 Overview** (sessions, interaction modes), **💵 Spend & models** (billing coverage, model cost, multi-model, model leaderboard, thinking effort) and **🧠 Context** (context references, context window & long-context pricing). "Thinking Effort (Reasoning)" and "Context Window & Long-Context Pricing" previously trailed off the bottom of the tab with nothing to say they answered a different question from the cost sections above them. The full view → sub-view → content-block map, and the rules for when to use a band, leaf tabs or a new view, are in [docs/vscode-extension/VIEW-HIERARCHY.md](../docs/vscode-extension/VIEW-HIERARCHY.md)
- The Usage Analysis "Context References" table now lists only the reference kinds you have actually used — anything with no usage today *and* none in the last 30 days collapses into an "Other references" disclosure, the same way the model leaderboard's long tail already did. The table enumerates all 21 kinds the extension can detect, so on most machines the majority of rows were permanently zero. Nothing is dropped: the group expands, and the totals row is unaffected by the collapse — it is computed from the stats rather than from the rows on screen. That table's column headers and its totals row are now localized too, so they follow the rest of the view into Simplified Chinese instead of staying English
- The automatic-compactions card in the Usage Analysis "Context Window & Long-Context Pricing" section no longer sits between the per-period columns and the long-context pricing bar; the bar now follows the columns it belongs to, and the 7-day compaction count follows both under its own "Context compaction" heading

- The Chart view's Summary → "By Editor" cards now show each tool's official logo (VS Code, Claude, Copilot, Codex, Antigravity, Kilo, Hermes, JetBrains, Cursor, Gemini, Kiro and more), falling back to the emoji for tools without one

### Bug Fixes
- Today, month, last-30-days and last-month totals now use the exact Copilot billing cost from VS Code Copilot Chat debug logs instead of an estimate, for sessions whose exact cost only comes from a debug log
- The desktop app now remembers whether the Chart view's "By Editor" section was collapsed (and other per-panel UI choices) instead of reopening it expanded every time
- A session first opened in the Details/Diagnostics views (before any full analysis) is no longer frozen at 0 tokens and an empty usage analysis until its file changes: such placeholder cache entries are now flagged and always re-analyzed. The cache version was bumped so already-affected entries are rebuilt
- The Copilot CLI OpenTelemetry usage index is now saved to disk and restored on the next start, so a multi-GB export is no longer re-read from the start in every window. Sessions that need it while it is still being built are refreshed as soon as it is ready, rather than waiting for the next refresh
- Clicking around the extension's views no longer freezes while data refreshes. Reading and parsing session files, and scanning workspaces for customization files, now run on background worker threads instead of the extension host's single thread. On one real 30-day history a cold refresh used to block the host for up to ~90 seconds in one stretch; it now blocks it for under a second and finishes sooner. If a stall does happen, the *AI Engineering Fluency* output channel now says so (`Extension host event loop stalled: ...`). See [docs/adr/ANALYSIS-WORKER.md](../docs/adr/ANALYSIS-WORKER.md)
- A very large Copilot CLI OpenTelemetry export (`~/.copilot/otel`, multi-GB on long-lived machines) can no longer crash the extension host if its background reader fails; it is skipped for that refresh instead

## [0.18.3] - 2026-09-29

### Features
- The AI Readiness tab is easier to scan across many repositories: each repository is now a collapsed row showing its confirmed stage, per-stage verdict dots and missing/unchecked/anti-pattern counts, and expands to the full detail. You can tick missing controls and anti-patterns and draft an agent-mode Copilot Chat prompt to address them; nothing is sent until you press Enter (#2226)

### Bug Fixes
- MCP tool ids that differ only by server prefix (for example `mcp__Claude_Browser__…` vs `mcp__claude-in-chrome__…`) now resolve to the same friendly name, and MCP server display names are no longer reported as unknown tools (#2225)

### Chores
- Friendly tool names from community issues (#2224)

## [0.18.2] - 2026-09-28

### Changed
- **Environmental Impact estimates are now based on published research, and for most people they are much lower.** CO₂ and water used to be flat guesses with no source: 0.2 g CO₂e and 0.3 L of water per 1,000 tokens, whatever the model or token type. They are now derived from Jegham et al., *How Hungry is AI?* ([arXiv:2505.09598](https://arxiv.org/abs/2505.09598)), using the approach published by [neuland/tokendashboard-backend](https://github.com/neuland/tokendashboard-backend/blob/main/docs/co2-methodology.md):
  - **Token type matters:** output tokens count fully, fresh input counts 1/20 as much, and cache reads almost nothing.
  - **Model size matters:** each model is scaled from Claude Sonnet by its output-token price (Haiku ⅓×, Opus 1⅔×).
  - **Water** uses the paper's own formula for data-center cooling plus electricity generation.

  **What to expect:** figures drop sharply for cache-heavy agent use (Claude Code, Copilot CLI) — on one real 30-day history CO₂ fell about 38× and water about 3,000×. Sessions without a per-model token breakdown change much less. **Some usage can come out higher than before:** output-heavy work on large models now counts up to 1,400 g CO₂e per million output tokens for Opus (2,800 g for Fable), against the old flat 200 g per million tokens of any kind. Every period, including past ones, is recalculated from your existing data, so trends shift as a whole rather than jumping at the upgrade. The *Calculation & Estimates* section of the Environmental Impact view shows the full derivation and links both sources; see [docs/TRACKABLE-DATA.md](../docs/TRACKABLE-DATA.md)

### Features
- **AI Readiness has its own tab in Usage Analysis**, also accessible from the Command Palette, instead of a section buried under the personal Fluency Score. It scans each repository's delivery and governance controls when opened, shows what blocks its next stage, and distinguishes missing controls from those it could not check. Opening the Fluency Score no longer scans repositories.
- The Team Dashboard now uses the same look as the extension's other views (#2196)

### Bug Fixes
- Team Server (sharing server) uploads no longer depend on the Azure Storage backend toggle: a Team Server-only setup made through "Configure Team Server Backend" now actually uploads its rollups (#2181)
- The Team Server "Last Sync" marker now only advances when an upload succeeds, instead of reporting a healthy recent sync while uploads were failing (#2179)
- The chart's "Last 30 days" window now applies to the day view too; it was showing your full history and its totals (#2187, #2188)
- The Details "Estimated cost (selected providers)" row no longer applies a saved provider exclusion, or points at the "Cost by Provider" filter, when that panel is hidden. A stale exclusion could silently zero out a period's total with no visible way to undo it (#2201)
- The Corrections tab's escalating filter pill no longer shows "undefined 📈 escalating" for reports from older caches (#2200)
- Diagnostic Report controls stay responsive while session files are being scanned (#2176)
- Opening an Environmental Impact methodology source only resolves known source ids (#2183)

### Chores
- Friendly tool names from community issues and model data syncs

## [0.18.1] - 2026-09-21

### Features
- Usage Analysis can look up Copilot Code Review activity for your repositories' pull requests on demand: which PRs got a completed review pass. GitHub offers no user-accessible API for the review cost itself on enterprise-licensed seats (#2145)
- Surface Copilot's server-side repository memories (the per-repository store GitHub keeps for the coding agent) alongside the local memory-file hygiene card (#2134)

### Bug Fixes
- Mistral Vibe sessions no longer overstate cost by ignoring cached input tokens. Vibe records `session_cached_tokens` as the cache-read portion *already included* in `session_prompt_tokens`, and Mistral discounts those heavily (Mistral Medium 3.5: $0.15 vs $1.50 per million) — but the full prompt total was being billed at the input rate, overstating cache-heavy sessions by up to ~5x (one real session: $43.65 instead of $8.22). Cached reads are now reported and priced separately, reproducing Vibe's own `session_cost` exactly
- Mistral Vibe sessions running `glm-5-2` or `devstral-2` no longer contribute $0 to cost totals — neither model had a pricing entry, so all of their usage was silently free. Both are now priced at the rates Vibe itself reports ($1.40/$4.40 and $0.40/$2.00 per million)
- Recognise Visual Studio Copilot sessions stored in Visual Studio's AppData folder (chats started without a solution open), which were discovered but never counted (#2137, #2139)
- Remove the "Mistral Cloud (Beta)" Diagnostic Report tab: the API it used lists conversations created through the Agents API, not Vibe cloud sessions, so it was always empty (#2152)

### Chores
- The personalized Insights catalog is now fully localized, in English and Simplified Chinese. All 53 insights — every title, body sentence and action label — previously shipped as hardcoded English; they now resolve through the extension's localization bundles, with a separate entry per grammatical variant so plural forms and verb agreement translate properly instead of being assembled from English fragments. The English wording is unchanged. `npm run lint:hardcoded-strings` now guards the catalog against new hardcoded text. See [docs/adr/INSIGHTS-CATALOG-LOCALIZATION.md](../docs/adr/INSIGHTS-CATALOG-LOCALIZATION.md)
- Unified localization architecture; the What's New catalog is now localized (#2138, #2141)

## [0.18.0] - 2026-09-18

### Features
- New "⚡ HydraFusion Routing" section in the Session Log Viewer for Copilot CLI sessions that ran on the `hydrafusion` synthetic model. HydraFusion spends several real models on one prompt — drafting, judging, repairing — then hands back a single answer and a single credit figure; this section reconstructs the legs behind it from the routing decisions the CLI records for its own resume and rewind. It shows how often the router went compound rather than single-model, how often a judge rejected the first answer, what share of credits went on review rather than on the answer you received, which models served which legs and which of them actually supplied answers, where the credits went per phase kind, and a per-turn breakdown with the planned route (including conditional legs that never ran), each leg's verdict, duration and cost, and a marker on the leg whose output you actually read. See [docs/logFilesSchema/hydrafusion-routing-events.md](../docs/logFilesSchema/hydrafusion-routing-events.md)
- The Usage Analysis "Context Window" section now counts *sessions* that ran out of context, not just compaction events: two new rows per period show how many sessions were automatically compacted (out of those with context data) and how many Copilot CLI sessions filled at least 80% of their window without compacting, plus the fullest session's fill percentage. Two new insights go with it — a tip when sessions repeatedly approach the limit, and a celebration when none of them do — and the existing auto-compaction insight now reports the per-session share as well
- The "Some sessions nearly ran out of context window" insight is now actionable: a "Show these N sessions" button opens the Usage Analysis "Recent Sessions" tab over the last 30 days, filtered to exactly the sessions it counted. The same drill-down is available directly in that tab — a new "Context" column shows how full each session's window got (flagged with ⚠️ at 80% or more), and a "🧠 Near context limit" filter pill narrows the list to those sessions. Context fill is now filled in for every lookback period, not only Today
- Worktree cleanup now explains *why* each worktree could not be removed and lets you act on it: every skipped/failed row shows when the folder was last touched, the last commit's age, whether the branch still has a remote (and whether that remote branch was deleted), the ahead/behind push status, and the number of modified/untracked files — plus "💻 Open in VS Code", "📂 Reveal folder" and "🗑️ Delete anyway…" buttons on the row itself
- New "What's New" view (command palette: *AI Engineering Fluency: What's New*) listing the last 5 releases in plain English, plus a one-at-a-time notification that points out a new view/tab/section after an update — at most one a day, at most 3 per release, and never one you already opened yourself. Turn the notifications off with `aiEngineeringFluency.whatsNew.notificationsEnabled`; see [docs/features/WHATS-NEW.md](../docs/features/WHATS-NEW.md)
- New "Research > TTFT" tab in the Diagnostic Report: time-to-first-token averages by day/week/month with a trendline per model, read from VS Code Copilot Chat's own debug log (`attrs.ttft`) — no setup required, see [docs/features/TTFT-TRENDS.md](../docs/features/TTFT-TRENDS.md)
- New "Skill Suggestions" section in the Usage Analysis Tools & Integrations tab: clusters the first prompt of each session to find tasks you keep prompting for manually (candidates for a reusable skill or prompt file), plus a new insight when a task repeats across 3+ sessions
- New "Corrections" tab in the Usage Analysis view: surfaces moments where the agent corrected itself after an error (failed tool calls, immediate edit retries, verbal self-corrections) or you had to correct the agent, grouped per repository over its 25 most recent sessions with detected moments
- New insights that fire when user corrections or tool-error/edit-retry volume in the last 30 days is high, pointing to the Corrections tab
- New "🤖 Ask Copilot to fix this" button per repository in the Corrections tab (plus a matching action on the "you had to correct the agent repeatedly" insight): builds a prompt from that repo's most notable correction examples and sends it to Copilot Chat, asking for concrete workspace-setup improvements (instructions files, custom instructions, prompt files) grounded in what actually went wrong — with a "Copy prompt" fallback for pasting into a different workspace's chat
- Group models from user-configured custom endpoints (BYOK) under their own provider group (e.g. `Mistral (Custom)`) in the Details "Cost by Provider" panel and the provider charts, instead of lumping them into "GitHub Copilot"/"Other"
- Show only the model part of a three-part custom-endpoint model ID (`customendpoint/Mistral/mistral-medium-latest` → `mistral-medium-latest`), and estimate its cost from that model's pricing entry
- Efficiency view, Cost Attribution tab: hovering a factor bar now shows a self-contained tooltip with the previous and current value, their unit and the signed estimated cost effect at full precision (e.g. `Session count: 64 → 73 sessions` / `Estimated cost effect: +$7.3500`), instead of raw ungrouped numbers. Every number on the tab — costs, session counts, blended rates — now formats through the shared locale-aware helpers, so groupings, decimal separators and the USD symbol follow your locale, and a non-zero sub-cent effect renders as `-$0.0037` rather than a misleading `-$0.00`
- The status bar hover popup is easier to read: the Today / Current Month / Last 30 Days columns now have a proper gutter between them (the header row included), "💰 Costs by Provider — Current Month" doubles as its table's header instead of sitting above an empty one, provider costs are right-aligned into a single column, and the "🎯 Copilot Budget" gauge no longer wraps — its tracked amount, untracked (other devices/cloud) amount and remaining budget are three short lines beneath it rather than being crammed onto the gauge row and one run-on sub-row

### Performance
- Opening the Efficiency view no longer jumps to 96% and then sits there. The whole wait used to happen inside a step the progress bar drew as "the last 4%", because the view reported a single "computing" step and then went quiet. The bar now tracks the full-year daily-stats pass file by file — the only one of the view's three passes that parses anything cold, since the other two read strict subsets of the same window straight out of the session cache it fills
- Efficiency builds are serialized, so opening the view and refreshing it can no longer interleave their writes to the shared stat caches and leave the older result behind
- The Efficiency loading screen now reports real progress: per-file counts and editor pills while session logs are parsed, then named sub-steps ("Aggregating daily activity", "Analysing usage patterns", "Reading session signals", "Building efficiency trends") as the aggregation runs. Refreshing the view shows the same progress instead of leaving the old numbers frozen on screen
- Every loading screen's progress bar now moves forward across the step from parsing into computing. The bar is one value with two bands — parsing fills the first 85%, the compute phase the rest — where previously parsing ran to 100% and the compute step set it back to a fixed 96%. Within parsing the bar still tracks the reported percentage in both directions, because session discovery streams in batches and the total it is measured against grows as they arrive; pinning it there would freeze the bar at an early batch's high-water mark instead. This applies to the Details panel and the desktop tray app as well, whose parsing progress now fills 0–85% rather than 0–100% before their compute step takes it to 96%
- The Details/Environmental loading screen no longer parks at a fixed 96% for the whole compute phase on first launch: the main refresh now reports named sub-steps ("Calculating usage statistics", "Analysing usage patterns", "Scoring AI fluency") as it works through them, the same pattern the Efficiency view already used. The Environmental Impact panel, which previously showed no progress at all while waiting on the very same refresh, now receives these updates too
- A scan with many slow-to-parse session files no longer piles up hundreds of them running concurrently in the background. A parse that exceeds the per-file timeout is deferred to keep going without blocking the rest of the scan, but nothing previously capped how many could be in flight at once — on a large cache this meant hundreds of CPU-bound parses competing for the same single-threaded event loop that also delivers progress updates to the loading screen, which is very likely why that screen could look frozen even though work was still happening. The number of concurrently deferred parses is now capped, with new work pausing briefly until a slot frees up
- The cache checkpoint that runs periodically during a long scan no longer saves to disk when nothing has actually changed. It used to fire on a time interval alone, so a scan that was 100% cache hits still triggered a full read-merge-write of the shared snapshot file every ~20 seconds for no effect; it also undercounted real changes (a re-parsed, changed file didn't count toward the threshold) and could run from a follower window, writing that window's deliberately partial cache over the leader's in-progress snapshot. All three are fixed: the checkpoint now only runs the leader, and only when there is something dirty (a new, changed, or deleted entry) to save

### Bug Fixes
- The "🎯 Copilot Budget" tooltip row now states spend and remaining budget against the *combined* tracked + untracked total, matching the percentage shown on its bar — previously the headline "$X / $Y" figure only counted this device's locally-tracked usage, so a reader had to notice the separate "untracked (other devices/cloud)" sub-row and subtract it themselves to find out how much budget was actually left. Remaining budget is listed on its own line under the gauge rather than appended to it
- Clearing the cache no longer leaves any view serving numbers from before the clear. A calculation already running when you cleared would finish afterwards and write its result — computed from the cache you had just emptied — back into the shared statistics, and the next open would reuse it. Each of those cached statistics now records the state it was computed from, and anything produced before a clear is recalculated rather than reused. A refresh that was already in flight no longer gets to *display* its pre-clear result one last time either: it discards its results instead of pushing them to the status bar and the Details, Chart, Usage Analysis, Maturity and Environmental views — insight cards and their notifications included — and the clear waits for it and then runs a real refresh of its own rather than reusing the discarded one. Clearing also now waits for a pre-existing refresh's still-running foreground session-file parses, and for any it has already deferred to the background, before it clears — previously such a parse finishing after the clear (whether it was still on its ordinary pass over a file or had already timed out into the background) could silently repopulate the cache with the exact pre-clear data the clear was meant to remove. (Two gaps remain, tracked separately: clearing does not itself reset the insight badge, which keeps its last counts until the next evaluation replaces them; and the wait for a pre-clear refresh's parses has no deadline of its own — a single session file whose read never settles (e.g. an unresponsive network mount) would leave Clear Cache blocked rather than resurrecting stale data, the same accepted trade-off already made for the deferred-parse reserve pool elsewhere in this cache rework. The gap noted here previously — the on-disk snapshot having no tombstone, so such an in-flight save could put its entries back — is fixed: a cleared cache deletes tombstones too and its on-disk delete is serialized against any write already in flight, in this window or another)
- A cleared cache can no longer be silently undone by another open VS Code window. Previously, clearing the cache only reset *this* window's own memory and deleted its on-disk snapshot — a second window with its own, untouched copy of the pre-clear data could still republish it later (its next checkpoint or refresh save, whenever that happened to run — not just one already in flight at the moment of the clear), or simply keep showing it on screen from its own memory, with nothing telling that window a clear had happened anywhere. A small durable marker file now records every clear; every window checks it before publishing a save (so a save built from pre-clear data is skipped instead of landing on disk) and once per refresh cycle (so an already-open window drops its own stale in-memory data instead of continuing to display it), closing both gaps. The marker is advanced under the same lock, and in the same held critical section, that now serializes the on-disk delete against any write in flight — so a writer blocked on that lock is only ever let through once both the delete and the marker bump have landed, and always sees the fresh marker before it can publish. If the marker write itself fails (e.g. a disk error), Clear Cache no longer reports unconditional success: the command now surfaces a warning that other open windows may not see the clear, instead of silently claiming the cross-window fence held when it did not. The same is true if deleting the on-disk snapshot itself fails for a genuine reason (not just "already gone"): since a failed delete is often a transient file lock rather than a real permissions failure, the clear now falls back to replacing the snapshot with an empty one (the same tmp-file-plus-rename publish path already used elsewhere, which only needs to replace the directory entry) before giving up — only when that also fails does the marker stay un-advanced, for the same "don't tell a window a clear happened when the stale snapshot is still fully present" reason. Either failure path also now bookmarks this window's own mtime tracking against the still-present file, so this window's own very next refresh cannot resurrect the same data it just failed to clear either, independent of any peer. A peer's clear is now also visible to more than just the cache manager's own session cache: it also drops the extension's separate per-view statistics and diagnostics view state, and (if open) rebuilds the Efficiency panel and reloads the Diagnostic Report, the same invalidation a local clear already does — previously only a local clear reached that far, so a peer's clear could leave a reopened view, or an already-open Efficiency or Diagnostic Report panel, rendering pre-clear numbers indefinitely. The very first, provisional "instant paint" a window does from its on-disk cache at startup now also re-checks for a peer's clear immediately before reading that cache, closing a narrow gap where one landing in the brief window after the startup cache load finishes but before that first paint runs would otherwise go undetected and flash stale numbers for the few seconds until the real refresh overwrites them. (A gap remains, tracked separately: a session-file parse that was already in flight in a *peer* window before that peer's clear, and only finishes afterward, is not covered by the wait clearCache() now does for its own window's in-flight parses — it can still land its result straight into that peer's in-memory cache after the peer has otherwise correctly detected and dropped the clear, and get published on that peer's next save. Closing this needs each in-flight parse to carry the epoch active when it started and get rejected on a mismatch when it completes, the same shape of fix as the same-window one above, extended across windows — a separate, larger change. A second gap: this fence only protects peers running this same, updated `CacheManager` — a window still on a previous extension version writes the shared snapshot without ever consulting the epoch file, so its post-clear (to it, ordinary) publish can still land pre-clear data that every up-to-date window will accept, having no way to tell it apart from a legitimate one. Closing this needs the snapshot envelope itself to carry the epoch it was written under, and every loader to reject one older than its own baseline — a cache-version-level protocol change, not an extension of the marker-file check, and one that would invalidate every user's on-disk cache on the next update, so it is deliberately deferred rather than folded in here. A third gap: `deleteSharedSnapshot()` can be stuck retrying the shared cache lock for its whole retry budget (up to 10s) against a peer holding it, before it ever unlinks the snapshot or advances the epoch — a same-process fix now rejects a save or load started in exactly that window on *this* window (a `clearInProgress` counter, checked alongside the epoch and generation), but a *different* window has no way to observe it: nothing durable records "a clear is in flight, not just decided" until the epoch marker itself is written at the very end of that window. A peer's load landing anywhere in that up-to-10-second gap can still merge the still-present pre-clear snapshot undetected. Closing this needs a durable, cross-window "clear intent" signal peers can check before the epoch itself is known to have moved — visible earlier in the sequence than the epoch bump this PR already added, and with its own staleness/dead-owner handling akin to the lock file's — a fourth marker file and lifecycle, not an extension of the existing checks. A fourth: the epoch is a plain float64 number, so it cannot be safely incremented once it reaches `Number.MAX_SAFE_INTEGER` — under real, `Date.now()`-driven usage this needs longer than any deployment will run, but a marker corrupted to exactly that value is a real, if narrow, input. On hitting it, the fix holds the epoch at the ceiling rather than picking a smaller replacement, since falling back to a smaller value would *regress* it below whatever a peer may have already adopted, letting that peer silently treat every later real clear as old — worse than the write simply failing to advance. Properly resolving exhaustion (so a clear that hits this ceiling is still individually detectable) needs a wider representation, such as a `BigInt` or decimal string, everywhere the epoch is read, compared and persisted — a representation change, not an extension of the numeric comparisons this PR's checks already do. A fifth: `clearInProgressCount` is only ever decremented by `deleteSharedSnapshot()`, so `clearAllCachedData()` — a public method — must always be immediately followed by a matching `deleteSharedSnapshot()` call; `clearCache()`, the only production caller, already does this with no `await` in between, so the gap does not occur there today, but nothing in the type system enforces the pairing for any other caller. Calling `clearAllCachedData()` alone (e.g. a future feature wanting only an in-memory reset, or a test) wedges the counter above zero permanently, silently failing every later save and discarding every later load on that instance. Properly closing this needs a single method that owns both halves atomically instead of two independently-callable public methods — a public API change, not just an internal fix, so it is deferred rather than folded in here; a regression test in `cacheManager-snapshot.test.ts` documents the current, accepted shape of this gap. A sixth: `readClearEpoch()` fails open to `0` for both a genuinely missing marker (the normal, expected first-run case, where `0` is correct) and a corrupt/unparseable one (an abnormal case where the real value might be far higher and is simply unknown). Combined with a backward system-clock step on the window doing the bump, this can write a new epoch below a value some peer already legitimately holds — that peer's `persisted <= this.clearEpoch` check then treats this real clear (and any further ones, until the clock catches up) as old. The existing local-epoch floor only protects a window that already observed the higher value itself; a window with no local memory of it (freshly started, or simply new) has nothing to floor against. Properly closing this needs either distinguishing "missing" from "corrupt" and refusing to advance in the latter case (at the cost of leaving the fence permanently disabled until the corruption is manually cleared, since every future clear would hit the same corrupt read) or a redundant, independently-recoverable source of truth for the epoch — both larger trade-offs than this PR's marker-file design, and deliberately not attempted here. This compound precondition (corruption plus a simultaneous backward clock step) is the same class of narrow, accepted residual risk as the two-clears-racing-the-lock gap already noted elsewhere in this entry)
- Every view now declares the language it is actually written in, instead of always claiming English. Screen readers were being told to pronounce translated interface text with English pronunciation rules
- "Last 30 Days" now means the same 30 calendar dates everywhere: the Usage Analysis period totals (tokens, corrections, context pressure, multi-agent trend, and every other "Last 30 Days" statistic) previously started one day earlier than the Recent Sessions tab's `last30` lookback and the chart's rolling 30-day window, so a session active on that extra day could count toward a total without appearing in a same-labelled session list. Both now derive from the same boundary calculation
- Insight notifications now take you to the insight, not just to the tab: the toast's "View" action and the status-bar "💡 N insights" badge scroll the Insights tab to the specific card they named and briefly outline it, instead of leaving you to find it among a dozen look-alike cards. The badge also counts what the Insights tab actually shows: it previously counted from stored state that keeps entries for insights which no longer apply, so it could claim more insights than the tab listed — and miss one whose snooze had just expired
- Fix Cursor session reads filling `%temp%` with multi-GB `cursor-wal-*.db` snapshots when Cursor is running alongside VS Code (#2033): reads Cursor's live `state.vscdb` through a read-only, copy-free connection instead of copying and checkpointing the whole database on every poll; the still-present copy-based fallback now caps the database size it will ever copy, throttles merge attempts per database, and backs off further while a writer looks active. A one-time best-effort sweep on activation reclaims any `cursor-wal-*`/`sqlite-wal-*` temp files stranded by earlier versions
- The worktree cleanup report no longer disappears when the run empties the worktree list — the skipped/failed rows you still have to act on stayed hidden behind the "No worktrees found yet" empty state
- Corrections tab filtering is now readable: the "📈 escalating" badge is a real filter pill (it did nothing when clicked before), active pills are outlined and bold with a "✕" plus a "Clear filter" button, a "Showing X of Y listed correction moments" bar states what the list below is filtered to, each repository header reports how many of its sessions and moments match, and the empty-filter state explains why a counted moment can sit outside the capped detail sample
- Fix the "Efficiency" nav button in the Efficiency view doing nothing when clicked — the view passed no active view to the shared nav bar, so its own button rendered enabled with no click handler instead of being marked as the current page
- Surface a warning when copying a path from the Usage Analysis view fails: the webview reported the failure but nothing on the extension side listened, so a failed copy was completely silent
- Sharing-server sync now reports "Copilot App" and "Claude (VS Code)" as their own editor labels (matching the local Interaction Modes view) instead of lumping them into "Copilot CLI"/"Claude Code" — the team dashboard's "Editors Used" panel previously had no way to show these categories at all, since the synced `editor` field never carried the distinction
- The Efficiency view's "🎁 Value" tab now updates itself when Repository PR data loads in Usage Analysis, instead of keeping its "Connect GitHub and open Usage Analysis → Repository PRs" hint until you pressed Refresh. Only the Value cards are replaced — the selected tab, controls and charts stay as they are — and a result that arrives while the view is still rendering is replayed to the new document. Cloud Agent task loads still leave Value alone, since `aiPrs` counts bot-authored pull requests rather than cloud-agent tasks (#1962)

### Chores
- New validation tooling: `npm run preflight` runs every check in one pass (see [docs/VALIDATION.md](../docs/VALIDATION.md)), `npm run check:contract` fails the build when a webview message has no handler on the other side, and `npm run check:interaction` clicks every control in every panel headlessly. CI now also renders before/after webview screenshots on pull requests

## [0.17.2] - 2026-08-17

### Features
- 2 additional friendly tool names from community issue #1823 (#1824)

### Bug Fixes
- Recognize Copilot App's `<repo>.worktrees` worktree layout in path/repo detection (#1827)
- Fix Recent Sessions view stuck on "Loading..." for non-Today periods (#1826)
- Fix initial scan showing 0 tokens for today on cold boot with multiple windows and stale refresh-lock recycling (#1825, #1822)

### Chores
- Sync latest model data (#1796)

## [0.17.1] - 2026-07-31

### Bug Fixes
- Fix Efficiency view stuck 'already in flight' after close+reopen (#1797)
- Fix Today stats showing 0 for multi-day adapter sessions with ongoing activity (#1797)

## [0.17.0] - 2026-07-30

### Features
- Efficiency view: are you working more efficiently with AI over time, plus a one-time notification popup pointing users to it (#1791, #1794)
- Cost by Model and Tokens by Provider chart splits (#1781)
- Collapsible By Editor breakdown in Chart view summary (#1785)
- Detect agent-skill usage across Claude Code, Claude Desktop, and Copilot CLI (#1778)
- Show untracked Copilot usage in the API budget bar (#1783)
- 3 additional friendly tool names from community issue #1787 (#1788)
- Model Efficiency section in Usage Analysis: per-model one-shot edit rate, retry rate, self-correction rate, cost per turn, cost per edit, output tokens per turn, and cache hit rate, with sortable columns and period switcher (#1649)
- Insight card that flags models with high edit-retry rates and compares them against your best-performing model (#1649)
- GitHub API requests (PR stats, cloud-agent sessions, Copilot plan info) now honor VS Code's `github-enterprise.uri` setting, so they target a GHE.com or GitHub Enterprise Server host instead of always hitting github.com — matching where the user actually signed in

### Bug Fixes
- Fix `Other` row sorting into the top-N list in Usage by Editor/Models tables (#1786)
- Fix Diagnostics reload being much slower than the initial extension load (#1784)
- Claude Code: attribute multi-day session tokens to the day each turn actually occurred instead of collapsing everything onto the session's start day, and discover subagent/workflow transcripts under `<sessionId>/subagents/**` that were previously silently excluded (#1608)

### Security
- Fix open code-scanning alerts, including a log injection issue sanitized inline (#77-98) (#1790)

### Maintenance
- Decompose `deleteEntitiesForUserDataset` into focused private helpers (#1777)

## [0.13.0] - 2026-07-11

### Features
- Long-context pricing discovery, insights, and Context Window section
- Added friendly tool names from multiple community issues (#1571, #1573, #1577, #1581)
- Clarified provider cost tooltip: unified budget/spend bars, add totals

### Bug Fixes
- Use notifier's real pricing data instead of hardcoded 0.00 stubs

## [0.11.6] - 2026-06-07

### Features
- Track session.truncation events as a negative fluency signal (#1354)
- Add refresh button to log viewer for on-demand session reload (#1349)
- Show context references as a readable table in usage analysis (#1348)
- Add friendly tool names (#1352, #1347)
- Replace premium/standard tier with cost-based model classification (#1345)
- Surface exact Copilot billing cost from nanoAiu data (#1344)

### Bug Fixes
- Use modelUsage input+output sum for Tokens (input+output) display (#1353)

## [0.11.3] - 2026-05-22

### Maintenance
- Patch version bump

## [0.11.2] - 2026-05-22

### Bug Fixes
- fix(vscode): use getConfiguration() with full key for statusBar update() calls (#1046)

## [0.11.1] - 2026-05-22

### Bug Fixes
- fix(vscode): use leaf-key getConfiguration for statusBar settings to fix 'not registered' error (#1044)
- fix: muting unknown tool now instant, skips full stats recalc (#1043)

## [0.11.0] - 2026-05-22

### Features
- Configurable status bar: independently show token counts and/or cost (#1036)
- Added 17+ friendly tool names for Claude in Chrome, Cowork, M365 Connector, and other tools (#1037, #1038, #1039)

### Security
- Added HTML escaping to prevent XSS in configPanel webview

### Maintenance
- Enhanced token tracking: extract all tokens from debug log and update session cache structure (#1040)
- Centralised adapter session path predicates to adapterPredicates.ts (#1034)
- Refactored extension.ts activate() into focused registration helpers (#1035)
- Extracted pathExists helper to utils/fsAsync.ts (#1031)
- Extracted settings validation helpers to backend/settingsValidation.ts (#1030)
- Consolidated path normalisation helpers to utils/pathUtils.ts (#1032)
- Consolidated duplicated webview type definitions to shared/types.ts (#1033)
- Added isNonNegativeInt type guard and safeJsonParse utility (#1029, #1013)
- Extracted registerMessageHandler helper from webview message listeners (#1022)
- Centralised Azure error classification in azureErrorClassifier.ts (#1017)
- Introduced ValidationResult<T> discriminated union for type-safe validation (#1021)
- Extracted Azure Storage endpoint URL builders to shared utility (#1005)
- Multiple additional refactoring improvements for maintainability and type safety

## [0.10.2] - 2026-05-13

### Maintenance
- Internal refactoring and dependency updates

## [0.10.1] - 2026-05-19

### Bug Fixes
- Implement IAnalyzableEcosystem on CopilotCliAdapter to prevent ENOENT errors on virtual session paths (#931)

## [0.10.0] - 2026-05-19

### Features
- Surface Copilot CLI chat-only sessions from session-store.db (#915)
- Add friendly display names for additional tools (#920)
- Persist chart view/period/displayMode selection across navigation (#911)

### Bug Fixes
- Propagate cachedReadTokens/cacheCreationTokens in calculateDailyStats (#907)
- Fix N+1 inefficiency in processing OpenCode sessions (#922)

### Performance
- Apply mtime-based DB caching to crush adapter to fix N+1 inefficiency (#924)
- Eliminate redundant JSON.parse calls in session analysis (#910)

## [0.9.0] - 2026-05-14

### Features
- Add oh-my-posh segment command and Copilot CLI statusline support (#876)
- Post-process SLM output to fix acronym capitalization (MCP, GitHub, etc.) (#880)
- Add SLM-powered job to generate friendly tool names from issues (#875)

### Bug Fixes
- Populate cache tokens from CLI session.shutdown events (#869)
- Pin Ollama install to versioned GitHub release with SHA256 verification (#881)

### Improvements
- Add friendly display names for 50+ tools (#862, #864, #865, #866, #867, #868, #872, #873, #874, #879)

## [0.8.0] - 2026-05-12

### Features
- Team dashboard now supports both Azure and Team Server backends (#854)
- Surface cached tokens from all providers in Details view (#851)
- Extract cached tokens from Copilot Chat debug logs (#851)
- Remove cost estimate row and rename TBB to UBB (#847)
- Add diagnostic logging to Details panel creation to aid blank-panel diagnosis (#845)

### Bug Fixes
- Replace team server iframe with launch card (#854)
- Use PID-based liveness check to break stale cache lock after force-kill (#844)

### Improvements
- Move action buttons to top and reduce report height in diagnostics view (#853)
- Sync latest model data (#852)
- Address npm audit warning
- Exclude `stryker.config.mjs` and `vs-session-sample.json` from VSIX package (#843)

## [0.7.0] - 2026-05-28

### Features
- Add rolling average toggle for Total Tokens and Est. Cost chart views (#836)
- Add Copilot Cloud Agent sessions view (#835)

## [0.5.2] - 2026-05-09

### Security
- Bumped `fast-uri` to ≥3.1.2 to fix GHSA-v39h-62p7-jpjc and GHSA-q3j6-qgpj-74h6

### Improvements
- Added friendly display names for `list_bash`, `read_bash`, and `stop_bash` tools (#822)
- Bumped `fast-xml-builder` dependency (#819)
- Cleaned up legacy code references (#821)

## [0.5.1] - 2026-05-08

### Features
- Show cached input tokens in log viewer summary bar — a "Cached Input" card now appears for Copilot CLI sessions that have `cacheReadTokens` data (#807)

### Improvements
- Added friendly display names for additional tools: ADO MCP, MSSQL, Copilot search/memory tools, `mcp_git_git_log`, `mcp_git_git_show`, and Claude in Chrome MCP tools
- Cleaned up publish script and removed legacy deprecation popup (#809)

## [0.5.0] - 2026-05-06

### Features
- Cost basis toggle moved into Sessions by category panel; chart title updates to reflect active mode
- Added sort indicator to active column header in session table

### Improvements
- Added Mistral AI model pricing and token estimators (#796)
- Added missing friendly names for 17 additional tools (TaskCreate, TaskUpdate, dismiss_deployment_notifications, Claude in Chrome MCP, and 13 others)
- Scatter chart: dark border on dots for readability, crisp rendering, variable circle size restored

### Bug Fixes
- Fixed duplicate loading sessions appearing in the status bar
- Fixed sort indicator wrapping to new line in session table headers

## [0.4.4] - 2026-05-05

### Bug Fixes
- Fixed Cowork (Claude) token over-count caused by duplicate `requestId` entries in `buildTurns` — each request is now counted exactly once (#790)
- Fixed sharing server sync being skipped when Azure Storage sync fails — both backends now sync independently (#789)

## [0.4.3] - 2026-05-05

### Bug Fixes
- Fixed concurrent sync being blocked when VS Code and VS Code Insiders are configured to different server URLs — the sync lock now stores the server URL and treats locks from a different URL as non-blocking (#787)
- Fixed sync to sharing server being skipped when both Azure Storage and the sharing server backends are configured simultaneously — both backends are now synced additively (#787)

## [0.4.2] - 2026-05-05

### Bug Fixes
- Fixed team dashboard showing empty results with Cosmos DB backend — replaced unsupported OData `datetime'...'` filter with `day` field string comparison (#783)
- Fixed `workspaceId` `w:` prefix not being stripped in extension dashboard entity processing (#783)
- Fixed logo image URL in VS Code Marketplace README (#782)

### Improvements
- Team Server diagnostics panel now shows GitHub auth status and a clickable warning banner when backend is configured but GitHub is not authenticated (#783)
- Added friendly display names for 10 additional tools (#784)
- Added friendly names for two missing GitHub MCP (Local) tools (#781)
- Pinned `vsce` and `ovsx` as exact devDependencies for reproducible builds (#785)

## [0.4.1] - 2026-05-05

### Fixes
- Fixed README badges: replaced retired vsmarketplacebadges.dev with shields.io
- Updated all VS Code install links and commands to the current extension ID (`ai-engineering-fluency`)
- Disabled legacy `copilot-token-tracker` VSIX creation and publishing in the release workflow (migration flow complete)

## [0.4.0] - 2026-05-04

### Features and Improvements
- Added Gemini CLI support as a trackable ecosystem
- Added JetBrains IDE Copilot session discovery with ask/agent mode detection, per-turn model tracking, and tooltips for data limits
- Added Copilot PR chat context references detection — surfaces #pr context in session log viewer (#760)
- Added Path Analyzer tab to diagnostics panel (#713)
- Added Editor Mode summary card to log viewer
- Added daily auto-sync of model multipliers from github-copilot-model-notifier (#718)
- Dual-publish VS Code extension under new AI Engineering Fluency marketplace ID (#731)
- Added detection of legacy copilot-token-tracker extension with prompt to uninstall and migration notice
- Added friendly display names for mcp_context7, mcp_microsoftdocs, Slidev, Copilot CLI built-in tools, and JetBrains tools (#723, #726)
- Added missing friendly names for additional tools (#771)
- Surface subagent count in log viewer; fixed subagent tool-result token estimation (#720)
- Added weekly/monthly chart periods and fixed usage analysis routing

### Bug Fixes
- Fixed: only suppress deprecation notice on explicit Dismiss
- Fixed: show correct editor name for eco sessions in diagnostics directory table
- Fixed: eco-session token count in diagnostics matches file viewer
- Fixed: replace hardcoded dark backgrounds in log viewer with theme CSS variables (#716)
- Fixed: populate estimated cost data in chart view for all periods
- Fixed: cost estimate reason display

## [0.3.0] - 2026-04-30

### Features and Improvements
- Added "💰 Est. Cost" view to the chart page: shows estimated daily/weekly/monthly API cost based on per-model token usage and provider pricing data (#703)
- Added first-value onboarding empty-state guidance and Scoring Guide panel (#710)
- Added macOS path support for Claude Desktop Cowork sessions (#714)

### Bug Fixes
- Fixed: show Configure Backend button when backend storage info is unavailable
- Fixed: exclude suppressed tools from unknown tools alert banner

## [0.1.1] - 2026-04-10

### Features and Improvements
- Added GitHub authentication support using VS Code's built-in authentication provider (#182)
- New commands: Authenticate with GitHub and Sign Out from GitHub
- GitHub Auth tab in Diagnostic Report panel showing authentication status
- Foundation for future GitHub-specific features (repository tracking, team collaboration, advanced analytics)
- Added Claude Desktop Cowork session support (#572)
- Added per-tool suppression for unknown tool name notifications (#563)
- Show git branch in status bar when running in debug mode (#576)

### Bug Fixes
- Fixed tracking of token usage from sub-agent calls in Copilot agent mode (#573)
- Fixed long MCP tool names wrapping in session viewer (#574)
- Fixed Copilot CLI session titles showing empty (#575)
- Hide 0-interaction sessions in diagnostics view

### Dependencies
- Bumped basic-ftp (#577)

## [0.1.0]

Release notes: https://github.com/rajbos/ai-engineering-fluency/compare/vscode/v0.0.23...vscode/v0.1.0

## [0.0.27] - 2026-04-07

### Features and Improvements
- Added friendly display names for mcp_gitkraken_git_log_or_diff, copilot_runInTerminal, mcp_laravel-boost_tinker, and Power BI MCP tools (#553, #554, #555)

### Bug Fixes
- Fixed integration test activation timing (#548)

## [0.0.26] - 2026-04-04

### Features and Improvements
- Split usage analysis view into 3 tabs for better navigation (#540)
- Added missing friendly display names for MCP and VS Code tools (#539)

### Bug Fixes
- Fixed loading stalls during session discovery (#545)

## [0.0.24] - 2026-03-28

### Features and Improvements
- Added Claude Code session file support as a usage analysis data source
- Added formatting options to details and log viewer panels
- Added friendly display names for container-tools and github-pull-request tools
- Added friendly display names for additional missing MCP/VS Code tools

## [0.0.23] - 2026-03-26

### Features and Improvements
- Renamed extension to AI Engineering Fluency (was Copilot Token Tracker)
- Added friendly display names for CMakeTools and misc non-MCP tools
- Added friendly display names for Python and Pylance MCP tools
- Improved maturity scoring view with updated labels and layout
- Improved fluency level viewer with updated labels
- Updated details and diagnostics webview panel titles
- Added Visual Studio session file support (shared data layer)
- Added LICENSE file to extension package
