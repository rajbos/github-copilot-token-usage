# extension.ts Decomposition Plan

> **Status:** Proposed (plan only; nothing in this document has been executed) · **Added:** 2026-09-12 · **Verified against code on:** 2026-10-11
>
> The "Verified numbers" below were measured on 2026-09-12. `vscode-extension/src/extension.ts` has since grown to ~15,990 lines (it was 12,332), so the per-cluster method and line counts are out of date. Re-measure before using them to size a PR: `wc -l vscode-extension/src/extension.ts`.

## Problem Statement

`vscode-extension/src/extension.ts` has grown into a single god-object file that
now sits outside every other quality gate in the repo: it is the only file the
new `max-lines` ESLint rule flags, it is excluded from the `test:coverage`
gate's `--test-coverage-include` globs, and it holds a disproportionate share
of the codebase's `any` usage. This document is the *plan* for making it
tractable — it does not refactor anything. Actual extraction happens later,
one `refactor-large-function`-style PR at a time, against this plan.

## Verified numbers

The originating review's numbers were close but not exact; re-measured directly
against the file on this branch (`git branch --show-current` →
`claude/code-review-feedback-luf2lu`):

| Metric | Reviewed estimate | Verified |
|---|---|---|
| Total lines | 12,332 | **12,332** (exact match) |
| Class | `CopilotTokenTracker`, starts at line 476 | confirmed, spans lines 476–11838 |
| Methods/accessors on the class | ~169 | **552** methods/accessors + 1 constructor (553 members), via TypeScript AST parse — the file mixes tab and 2-space indentation in different sections, which undercounts badly with a line-regex approach |
| Instance/static fields on the class | not stated | **118** property declarations |
| `dispose()` length | ~361 lines | **53 lines** (11785–11837) — see "What `dispose()` actually shows," below, for why it's still a meaningful signal despite being shorter than reported |
| `any` annotations in this file | ~160 of ~590 repo-wide | **198** of **659** repo-wide (`grep -oP ':\s*any\b\|\bas\s+any\b\|<any>\|\bany\[\]\|\bany\)'`) — same ~30% concentration the review described |
| Excluded from coverage gate | yes | confirmed — `test:coverage`'s `--test-coverage-include` globs list `backend/**`, `utils/**`, and four named `src/*.ts` files; `extension.ts` appears in none of them |

Takeaway: the file is exactly as large as reported, and the `any`-concentration
and coverage-exclusion claims hold up. The method count was undercounted by
the original grep-based pass; the AST count (553) is the trustworthy one and
is used for cluster sizing below. `dispose()` is shorter than claimed, but see
below — its *shape*, not its length, is the real finding.

## What's actually in there

Methods were clustered by name/purpose (AST-extracted, then grouped by
regex over method names, spot-checked by reading representative methods).
Line counts are method-body lines only — they don't include the ~118 field
declarations or blank/comment lines between methods, so they don't sum to
12,332.

| Cluster | Methods | Lines | Notes |
|---|---:|---:|---|
| Session parsing / token estimation engine | 122 | ~1,756 | JSONL/delta/CLI event parsing, token/cost estimation, debug-log reconciliation. Directly overlaps `src/tokenEstimation.ts` and `src/sessionParser.ts` — this is the "reimplemented instead of reused" pattern AGENTS.md's CLI section already warns about, just inside the extension instead of the CLI. |
| Usage analysis panel (message handling + stats) | 46 | ~999 | `_getAnalysisMessageHandlers()`'s ~25-entry dispatch table plus the stats-computation methods it calls. |
| Diagnostics panel (HTML + message handling) | 44 | ~657 | `diagHandle*` message handlers, `buildDiagReport*` report-section builders, `getDiagnosticReportHtml`. |
| Daily rollups / stats aggregation | 35 | ~832 | Daily-entry accumulation, billing-group cost math, workspace matrix building. |
| Worktree scanning/cleanup | 27 | ~440 | Orchestration around the already-extracted pure helpers in `src/worktreeScan.ts` / `src/worktreeBackgroundScan.ts`. |
| Maturity/fluency score panel + export | 24 | ~498 | Includes PDF/PPTX export (`exportFluencyScorePdf/Pptx`) — a distinct concern bolted onto the same cluster. |
| Team dashboard (server sync) | 21 | ~380 | Team-server leaderboard aggregation, entity fluency accumulation. |
| Details panel | 17 | ~500 | |
| Cache management | 16 | ~214 | Thin wrapper over `src/cacheManager.ts`. |
| Tooltip / status-bar text builders | 16 | ~188 | |
| Agent sessions (Copilot CLI / coding agent) | 15 | ~244 | Orchestration over the already-extracted `agentSessionsService.ts` (`collectAgentSessions` etc. already live there). |
| Folder / workspace discovery (disk scanning) | 14 | ~186 | |
| Local view regression / self-test | 14 | ~312 | Backs `check:interaction`'s headless probe. |
| GitHub PR stats / social sharing | 12 | ~299 | Orchestration over `githubPrService.ts`. |
| Chart panel | 11 | ~199 | |
| Backend sync / cloud storage / plan+quota telemetry | 19 | ~242 | Copilot plan/quota logging glue around `backend/services/*`. |
| Efficiency panel | 9 | ~220 | |
| Log viewer panel | 9 | ~149 | |
| Onboarding / notifications / status banners | 6 | ~151 | Overlaps `onboarding.ts`. |
| Config / settings | 6 | ~63 | |
| Lifecycle (constructor/dispose/initialize) | 5 | ~140 | |
| Environmental panel | 3 | ~97 | |
| Extension points / buttons (customization API) | 4 | ~39 | `broadcastExtensionPointButtons` alone touches all 9 panel fields — see hazards. |
| Model efficiency / pricing | 1 | ~17 | |
| Everything else (small named helpers not matched above — log-line builders, dedup helpers, JSON accumulators, HTML shells) | 57 | ~844 | Mostly single-purpose 5–20 line helpers that belong with whichever cluster above calls them; not a coherent cluster on its own. |

Two things fall out of this that should shape the plan more than the raw
counts:

1. **Roughly a third of the file (session parsing + rollups + tooltip/status
   text, ~2,800 lines) is business logic that has nothing to do with VS
   Code's API** — no `vscode.*` calls, no webview panels. It's stranded in
   `extension.ts` next to UI code, not because it belongs there, but because
   it grew there.
2. **Several clusters already have a sibling module that does the heavy
   lifting** (`worktreeScan.ts`, `agentSessionsService.ts`, `githubPrService.ts`,
   `cacheManager.ts`, `onboarding.ts`, `insightsEngine.ts`, `darkFactoryService.ts`).
   `extension.ts` still carries the *orchestration* layer for each — thinner
   than the raw method count suggests, but real, and worth moving so those
   modules are legible on their own instead of split down the middle.

## Where each cluster should go

Matching the conventions already visible in `vscode-extension/src/`
(`backend/services/*`, `backend/ui/`, `webview/<panel>/`, top-level
service files):

| Cluster | Destination |
|---|---|
| Session parsing / token estimation engine | `src/tokenEstimation.ts` / `src/sessionParser.ts` (repo-root `src/`, so the CLI gets it too — the same rule AGENTS.md states for the CLI: don't reimplement, call the shared function) |
| Daily rollups / stats aggregation | `vscode-extension/src/backend/rollups.ts` (already exists, already holds related logic) |
| Diagnostics panel (HTML + handlers) | `vscode-extension/src/backend/ui/diagnosticsPanel.ts` (new, alongside the existing `backend/ui/messages.ts`) |
| Usage analysis panel (HTML + handlers) | `vscode-extension/src/backend/ui/usageAnalysisPanel.ts` (new) |
| Details / Chart / Maturity / Efficiency / Environmental / Log Viewer / Dashboard panels | one `backend/ui/<panel>Panel.ts` each, mirroring the existing `backend/configPanel.ts` / `backend/teamServerConfigPanel.ts` precedent — each owns its `getXxxHtml`, its message-handler map, and its panel lifecycle (create/reveal/dispose) |
| Worktree scanning/cleanup orchestration | `vscode-extension/src/backend/services/worktreeService.ts` (new); pure helpers stay in the existing `worktreeScan.ts`/`worktreeBackgroundScan.ts` |
| Agent sessions orchestration | fold into `agentSessionsService.ts` (already holds `collectAgentSessions` etc.) |
| GitHub PR stats / social sharing | fold into `githubPrService.ts`; social-share-only methods to a new small `socialShareService.ts` if they don't fit PR stats cleanly |
| Team dashboard (server sync) | `vscode-extension/src/backend/services/` — new `dashboardService.ts`, alongside `syncService.ts`/`dataPlaneService.ts` |
| Cache management orchestration | fold into `cacheManager.ts` |
| Onboarding / notifications | fold into `onboarding.ts` |
| Hooks management | fold into `hookManager.ts` (already thin — verify no logic duplication) |
| Extension points / buttons | fold into `extensionPoints.ts` |
| Backend sync / plan+quota telemetry | `backend/services/` — likely `dataPlaneService.ts` or a new `planQuotaService.ts` |
| Local view regression / self-test | `vscode-extension/src/viewRegression.ts` (already exists) |
| Tooltip / status-bar text builders | new `vscode-extension/src/statusBarPresenter.ts` |
| Lifecycle (constructor/dispose/initialize) + the ~118 fields | stays on `CopilotTokenTracker` — this is the class's actual job once everything above moves out: own state, wire dependencies, hold panel references |

After this, `CopilotTokenTracker` becomes a composition root: it owns the
`vscode.ExtensionContext`, the panel references, and the ecosystem adapters,
and it wires them into the services/panel-controllers above rather than
implementing their logic inline.

## A safe extraction order

Ordered lowest-risk first — pure, stateless, or already-half-extracted
clusters before anything that reaches into shared mutable state or the
"touches every panel" methods.

**PR 1 — Session parsing / token estimation → `src/tokenEstimation.ts` /
`src/sessionParser.ts`.** These 122 methods are the biggest win and, per the
`refactor-large-function` conventions, the *safest*: most take explicit
arguments (a JSONL line, a raw event, a session file) and return a value with
no `this.` reads beyond passing through injected deps (`this.tokenEstimators`,
`this.modelPricing` — already collected into `usageAnalysisDeps` at line 527,
which is the seam to reuse). Move in batches of 10–15 related methods, not all
122 at once, so each PR stays independently reviewable. This also directly
serves the CLI-reuse rule in AGENTS.md — once these live in `src/`, the CLI's
existing calls to `estimateTokensFromJsonlSession()` / `getModelUsageFromSession()`
start reading from the same code the extension edited, instead of two
similar-but-diverging copies.

**PR 2 — Worktree orchestration → `backend/services/worktreeService.ts`.**
Medium risk: touches `this.worktreeScanId`/`this.worktreeCleanupId`/
`this.backgroundWorktreeScanId` cancellation counters and calls back into
`this.diagnosticsPanel` to post progress. Extract as a class that takes the
panel-posting callback and the counters as constructor arguments (dependency
injection instead of closing over `this`), so it's unit-testable without a
real webview.

**PR 3 — Diagnostics panel → `backend/ui/diagnosticsPanel.ts`.** The
`getDiagnosticReportHtml` builder and the `diagHandle*` dispatch map are
naturally paired and already namespaced by the `diagHandle` prefix, making
this the cleanest single-panel extraction to prove out the
`backend/ui/<panel>Panel.ts` pattern before repeating it for the other eight
panels. Webview-facing, so `check:contract` and `check:interaction` are
required (see Verification).

Beyond PR 3, repeat the panel-extraction pattern (Details, Chart, Maturity,
Efficiency, Environmental, Log Viewer, Dashboard — 7 more PRs), then take the
remaining orchestration clusters (agent sessions, GitHub PR stats, dashboard
sync, cache, onboarding, hooks, extension points) one at a time, folding each
into its existing sibling service file. Team dashboard and backend
sync/telemetry are the highest-risk of the orchestration clusters — they
touch `this.cacheManager`, `this.context.secrets`, and network calls together
— and should go last, after the panel and pure-logic extractions have already
shrunk the file enough to make `this.` usage easier to trace by eye.

## The seams and hazards

**`dispose()` is short (53 lines) but tells on the class anyway.** It doesn't
run any real logic — every line is either `clearInterval`/`clearTimeout` on a
class-held timer, an `if (panel) panel.dispose()` on one of 9 separate panel
fields (`detailsPanel`, `chartPanel`, `analysisPanel`, `maturityPanel`,
`logViewerPanel`, `diagnosticsPanel` are the ones actually disposed here —
`dashboardPanel`, `fluencyLevelViewerPanel`, `environmentalPanel`,
`efficiencyPanel` are *not* disposed in this method, which is worth a
follow-up bug check on its own), or a fire-and-forget cache save. The
*signal* isn't length, it's that one method has to individually know about
every long-lived resource the class owns because nothing is registered in a
`vscode.Disposable[]` bag or a panel registry. Any extraction that moves a
panel out to its own controller file has to also decide who disposes it —
either the controller implements `vscode.Disposable` and `CopilotTokenTracker`
keeps one list of disposables instead of 9 named fields, or dispose stays
centralized and each new controller file exposes its own `dispose()` for the
class to keep calling by name. The former is the actual fix; the latter is
what a naive extraction defaults to and just moves the god-object problem
sideways.

**`broadcastExtensionPointButtons()` reaches into all 9 panel fields
directly** (`this.analysisPanel`, `this.detailsPanel`, `this.chartPanel`,
`this.dashboardPanel`, `this.diagnosticsPanel`, `this.maturityPanel`,
`this.fluencyLevelViewerPanel`, `this.environmentalPanel`,
`this.efficiencyPanel`) to post one message to whichever are open. This is
the clearest single method proving panels need a registry (`Map<panelId,
WebviewPanel>`) before per-panel extraction can be clean — otherwise every
panel controller that gets extracted still needs a callback into the parent
class's panel list for cross-panel broadcasts, which is a smell but an
acceptable interim state for PR 3 onward (don't block the first extractions
on building the registry; note it as the natural PR to do once 3–4 panels are
extracted and the duplication of "reach back into the parent for broadcast"
becomes visible three times).

**`getXxxHtml()` builders are not pure**, despite looking like simple string
templates. `getChartHtml`, for example, reads `this.extensionUri`,
`this.lastChartPeriod`/`lastChartView`/`lastChartMetric`/`lastChartSplit`
(persisted user preferences), calls `this.getEffectiveMonthlyBudget()` and
`this.getWebviewLocalization()`, and calls three more `this.*Script()` helpers
shared across *every* panel's HTML (`getJsonConfigScript`,
`extensionPointButtonsScript`, `getLocalViewRegressionProbeScript`). Extract
those three shared shell-builders first, as free functions taking `nonce` and
explicit small params — they're the same three lines duplicated across all
~10 `getXxxHtml` methods and are the lowest-risk win to shrink every future
panel extraction's diff. Only after that, convert each panel's `getXxxHtml`
into a function that takes an explicit view-state object instead of reading
`this.*` — this is the part that needs care, since the persisted-preference
fields (`lastChartPeriod` etc.) are read *and* written elsewhere in the class
and need to travel with whichever object now owns them.

**The `_getAnalysisMessageHandlers()` dispatch map is a ~25-entry router that
reaches into nearly every cluster** (worktree handlers, PR stats, agent
sessions, curation tracing, clipboard fallback) via `this.<method>()` closures.
It's genuinely thin — each entry is one line calling `this.dispatch(...)` —
so it isn't itself a decomposition target, but it means the "usage analysis
panel" extraction (a later PR, not among the first three) can't fully isolate
its logic without either keeping the map on `CopilotTokenTracker` and
delegating outward to newly-extracted services, or building a small service
locator the extracted panel controller receives in its constructor. Prefer
the former for now — it matches how PR 2's worktree service is already
consumed via `this.diagHandleScanWorktrees()` calling into it — and revisit
only if the constructor argument list for the panel controller gets
unwieldy.

## Verification per step

Every step: `cd vscode-extension && npm run test:node` (must stay green) and
`npm run lint` (0 errors; new warnings on touched files must be resolved per
the `refactor-large-function` skill's rule — pre-existing warnings on
untouched code are fine to leave).

Additional checks by what a step touches:

- **Any panel extraction** (PR 3 onward, and the Details/Chart/Maturity/
  Efficiency/Environmental/Log Viewer/Dashboard panels that follow) —
  `npm run check:contract` (every posted `postMessage` still has a handler on
  the other side) and `npm run check:interaction` (headless click-through of
  every control), per AGENTS.md's "Webview changes must be validated by
  clicking, not by reading." Run the `visual-view-diff` skill before/after to
  confirm the panel renders pixel-identical — a pure code-organization change
  should produce a zero-diff screenshot.
- **Session parsing / token estimation move** (PR 1) — `npm run test:node`
  already covers `src/tokenEstimation.ts`/`sessionParser.ts` directly (unlike
  `extension.ts`, they're inside the coverage gate), so a regression here is
  more likely to be caught than for UI-adjacent moves. Also worth a manual
  spot-check: run `validate-session-schemas` and `validate-model-pricing`
  skills afterward, since they exercise these code paths against real local
  session logs.
- **Worktree orchestration move** (PR 2) — no dedicated worktree test suite
  currently touches `extension.ts`'s orchestration layer (only the pure
  helpers in `worktreeScan.ts`/`worktreeBackgroundScan.ts` have unit tests);
  add tests for the extracted `worktreeService.ts` as part of the same PR,
  since it moves into a location that *can* be covered.
- **Any move into an already-covered file** (`backend/services/*`,
  `backend/rollups.ts`, `cacheManager.ts`, etc.) — check whether
  `test:coverage`'s thresholds (currently 85% lines / 88% functions / 85%
  branches) still pass; a large method landing in a file that was previously
  small and 100%-covered can drop the percentage below the gate even with no
  behavior change, and the newly-moved code needs its own tests added in the
  same PR rather than the threshold being lowered.

## Known conflict to resolve before PR 1

`.claude/agents/refactor-large-function.md` (and its mirrored
`.github/agents/refactor-large-function.agent.md`) currently instructs:
*"Skip `src/extension.ts` — it is intentionally large and hard to test in
isolation."* That rule was written before this plan existed and is correct
for *unplanned*, opportunistic refactors of one flagged function — it stops
someone from yanking a random 90-line method out of context. It is not
correct once a specific extraction PR from this plan is in flight. Update
that line (in both the `.claude/agents/` and mirrored `.github/agents/` copy,
per AGENTS.md's mirroring rule) to reference this document once PR 1 lands,
so the skip-rule becomes "skip *unplanned* extraction from extension.ts;
follow docs/adr/EXTENSION-TS-DECOMPOSITION.md for planned extractions"
instead of a blanket skip. Left as a follow-up, not done in this PR, since it
touches files outside this task's stated scope.
