# Shared `src/` API Boundary — Analysis & Recommendation

> **Status:** Proposed (analysis and recommendation only; no barrel file, `@internal` marking or export removal has been made) · **Added:** 2026-09-12 · **Verified against code on:** 2026-10-11 (no barrel/index exists under `src/`)
>
> The symbol counts (549 exported, 269 public, 135 test-only, 103 unused) were measured on 2026-09-12 with a one-off scan and are not reproduced by any checked-in script. Re-run an equivalent scan before acting on them.

## Problem Statement

The repo-root `src/` folder is the shared "brain" behind the VS Code extension and
the CLI: ~82 TypeScript files (48 at the top level, plus `adapters/`, `utils/`,
and `webview/shared/` subfolders), exporting several hundred symbols. There is
no barrel/index file, no `@internal` marking, and no distinction between a
deliberate public API and an implementation detail that merely happens to be
`export`ed because a sibling file in `src/` needed to reach it. Every symbol is
importable from anywhere, so every symbol is effectively frozen — a rename or
signature change anywhere in `src/` is a potential breaking change with no way
to tell, from the export keyword alone, who is actually depending on it.

This document is analysis and a proposed plan, not a refactor. No exports were
removed, no barrel was created, and no imports were rewritten.

---

## The Central Question: Does Tightening `src/` Risk Breaking VS/JetBrains?

**No.** The Visual Studio and JetBrains hosts do not import any TypeScript from
`src/` — they have no TypeScript in their trees at all (`find
visualstudio-extension jetbrains-plugin -name '*.ts'` returns nothing). Both
shell out to the same bundled CLI executable and parse its stdout as JSON:

- `visualstudio-extension/src/AIEngineeringFluency/Data/CliBridge.cs` runs
  `copilot-token-tracker.exe <command> --json` (`usage`, `all`, `chart`,
  `usage-analysis`, `fluency`) via `Process.Start`, reads stdout, and
  deserializes it with `System.Text.Json`.
- `jetbrains-plugin/src/main/kotlin/.../CliBridge.kt` is, per its own doc
  comment, a "direct port of `visualstudio-extension/.../CliBridge.cs`" — it
  extracts the bundled CLI binary from the plugin jar and runs the identical
  `<command> --json` invocations via `ProcessBuilder`, on the stated basis that
  "the JSON contract on stdout is identical so the shared webview bundles
  consume both outputs unchanged."

So the TypeScript export surface of `src/` is completely invisible to those
two hosts. The contract that actually binds them is **the CLI's JSON output
shape** for the `all`, `chart`, `usage-analysis`, `usage`, and `fluency`
commands (`cli/src/commands/*.ts`). That contract is real, and it is a bigger
deal than the working hypothesis suggested: `cli/src/commands/all.ts` itself
imports directly from `../../../src/maturityScoring` and
`../../../src/toolCuration`, so a change to those modules' *return shapes*
(not just their export list) flows straight through to the CLI's JSON and from
there to both native hosts with no compiler in the loop to catch it.

**Conclusion for planning:** the `src/` export-surface refactor has full
freedom with respect to Visual Studio and JetBrains — nothing there imports
TypeScript. It does **not** have freedom with respect to the *shape of data*
those modules produce once it is serialized to JSON by the CLI, and that
shape is currently undocumented (see below).

### The other consumers, confirmed directly

- **`vscode-extension/src/`** and **`vscode-extension/test/`** — the primary,
  heaviest consumer. Imports both production code and, in a fair number of
  cases, test-only internals (see "Test-only" below).
- **`cli/src/`** (including `cli/src/test/`) — a real consumer of `src/` in
  its own right (not just downstream of the extension), reusing shared parsing
  and analysis logic per `AGENTS.md`'s "CLI Must Reuse Shared Functions" rule.
- **`desktop/src/`** — only two files (`main.ts`, `preload.ts`), but `main.ts`
  imports directly from repo-root `src/` (`types`, `maturityScoring`,
  `workspaceHelpers`, and several `.json` data files) rather than going
  through the CLI.
- **`sharing-server/src/`** — imports **nothing** from repo-root `src/`. It is
  a fully independent backend (Azure Table Storage ingestion for the team
  dashboard) with no shared-code dependency at all. It can be ignored for this
  boundary entirely.

So the real TypeScript-level consumer set is three packages
(`vscode-extension`, `cli`, `desktop`), not five.

---

## Method

A throwaway Node script (`analyze.js`, kept out of the repo per instructions,
in the session scratchpad) was used to build the consumption graph:

1. Regex-scan every `.ts` file under `src/` for `export function|const|class|
   interface|type|enum` declarations and `export { a, b as c }` blocks,
   collecting every exported symbol name and its defining file(s).
2. Regex-scan every `.ts`/`.tsx` file under `vscode-extension/src`,
   `vscode-extension/test`, `cli/src` (including `cli/src/test`),
   `desktop/src`, `sharing-server/src`, and `src/` itself, for `import { ... }
   from '...'` statements whose specifier resolves into `src/`.
3. For each exported symbol, recorded which *packages* (not just files)
   reference it, with test files/directories flagged separately from
   production code.
4. Classified each symbol by where its importers live.

This is regex-based, not a real TypeScript/AST analysis — it doesn't resolve
`import * as ns` namespace imports to individual symbols, doesn't follow
re-exports through type aliases, and can be fooled by a same-named local
declaration shadowing an import (spot-checked one such case below and it held
up). It is good enough to establish the *shape* of the graph, which is what
this task asked for, not a byte-perfect dead-code report.

---

## Findings: The Four-Way Classification

| Bucket | Count | Definition |
|---|---:|---|
| **Public** | 269 | Imported by at least one package other than `src/` itself, excluding cases where the *only* outside consumer is a test file |
| **Test-only** | 135 | The only consumer(s) outside `src/` are test files (`vscode-extension/test`, `cli/src/test`) — regardless of whether the symbol is also used in production code inside `src/` itself |
| **Internal** | 42 | Imported only by other files inside `src/` — no consumer package reaches it at all, test or production |
| **Unused** | 103 | Exported, and not imported by anything the scan covered |
| **Total** | 549 | Distinct exported symbol names found across `src/**` |

(549 vs. the ~442 named in the task brief: different counting methods produce
different totals — this pass counts every `export function/const/class/
interface/type/enum` and named re-export, including symbols re-exported
through `adapters/index.ts`, which inflates the count a bit relative to a
"distinct declaration" count. Either number tells the same story: the surface
is an order of magnitude larger than anything resembling a curated API.)

### Public, by which combination of packages uses it

| Consumer combination | Count |
|---|---:|
| `vscode-extension/src` + `vscode-extension/test` | 150 |
| `vscode-extension/src` only | 70 |
| `cli/src` + `vscode-extension/src` + `vscode-extension/test` | 30 |
| `cli/src` + `vscode-extension/test` | 10 |
| `cli/src` + `vscode-extension/src` | 3 |
| `desktop/src` + `vscode-extension/src` + `vscode-extension/test` | 2 |
| `cli/src` + `desktop/src` + `vscode-extension/src` + `vscode-extension/test` | 2 |
| `cli/src` only | 1 |
| `cli/src` + `desktop/src` + `vscode-extension/src` | 1 |

The overwhelming majority of "public" traffic is `vscode-extension` importing
from `src/` (220 of 269 symbols touch it); `cli/src` and `desktop/src` account
for a much smaller, genuinely cross-package slice (~48 symbols).

### The largest internal-only clusters

| File | Internal-only symbols | Examples |
|---|---:|---|
| `src/types.ts` | 9 | `LanguageUsage`, `CorrectionMoment`, `RepeatedTaskSessionRef`, `RepeatedTaskCluster`, `DarkFactoryStageDefinition`, `AvailableToolEntry` |
| `src/ecosystemAdapter.ts` | 5 | `isAnalyzable`, `CandidatePath`, `IDiscoverableEcosystem`, `UsageAnalysisAdapterContext`, `IAnalyzableEcosystem` |
| `src/jetbrains.ts` | 4 | `JetBrainsTurn`, `JetBrainsParsedSession`, `JetBrainsToolCall`, `JetBrainsMode` |
| `src/taskClassification.ts` | 4 | `classifySessionTurns`, `TASK_CATEGORIES`, `TaskTurnSignal`, `TaskClassificationResult` |
| `src/adapters/claudeCodeAdapter.ts` | 2 | `recordSkillCall`, `recordInvokedSkillCall` |
| `src/usageAnalysis.ts` | 2 | `readClaudeCodeEventsForAnalysis`, `addSkillCall` |
| ~14 other files | 1 each | e.g. `getModelCostBucket` (tokenEstimation.ts), `pathExists` (utils/fsAsync.ts), `safeJsonParse` (utils/jsonParse.ts) |

These are the safest, highest-confidence candidates for de-exporting or
`@internal` marking — no code outside `src/` references them at all.

### Dead exports (unused)

103 symbols are exported and referenced nowhere the scan covered. The largest
clusters:

- `src/types.ts` — 14 (`CopilotPricing`, `ChartPeriodData`, `ThinkingEffortUsage`,
  `SkillCallUsage`, `ContextWindowStats`, `InsightState`, several
  `DarkFactory*` enums, etc.)
- `src/efficiencyAnalysis.ts` — 13 (`EfficiencyWeekPoint`, `ModelMixShift`,
  `ValueSignals`, `SkillUsageTrends`, `SkillCohortMetrics`, `ComparableModel`, …)
- `src/adapters/adapterPredicates.ts` — 9 (mostly regex-pattern constants like
  `JSONL_FILE_EXTENSION_PATTERN`, `JETBRAINS_PARTITION_FILE_PATTERN`)
- `src/antigravity.ts`, `src/copilotCliStore.ts`, `src/devinCli.ts`,
  `src/geminicli.ts`, `src/taskClassification.ts` — 4 each, mostly type
  interfaces for session-parsing internals

Spot-checked two of these by hand to sanity-check the script:
`CopilotPricing` has zero references anywhere in the repo, and `ChartPeriodData`
is not dead by re-export — `vscode-extension/src/webview/chart/main.ts` simply
declares its *own*, unrelated, locally-scoped type of the same name. Both
confirm the script's classification rather than exposing a false positive.

This bucket is not automatically safe to delete — some of it may be exported
deliberately for a near-term feature, or for external tooling/tests this scan
doesn't cover — but it is the right list to hand to whoever owns each area for
a "still needed?" pass.

### Test-only exports

135 symbols whose only consumer *outside* `src/` is a test file. A large
fraction of these are the per-ecosystem `*Adapter` classes and `*DataAccess`
classes (`ClineAdapter`, `EclipseDataAccess`, `KiroCliDataAccess`, …) and
low-level helpers (`toUtcDayKey`, `isSafePathSegment`, `parseMcpJson`,
`redactSecretsInText`, correction-detection pattern constants, etc.) that
`vscode-extension/test` imports directly to unit-test in isolation, bypassing
the adapter registry / higher-level entry points that production code
actually goes through.

This is the design smell called out in the task: these symbols are public
only because a test reaches around the intended entry point. It's a weaker
justification than a real cross-package consumer, but not free to fix —
collapsing these into `@internal` would break the tests that import them
directly, and rewriting ~130 test imports to go through a higher-level surface
is a real (if mechanical) undertaking, not a `@internal` tag. Treat this
bucket as informative for now: it marks where the test suite is most
tightly coupled to `src/`'s current shape, which is exactly the coupling that
makes any future boundary change expensive.

### `types.ts` specifically

86 exported symbols, breaking down as: **60 public, 12 internal, 14 unused, 0
test-only.** Of the 12 internal-only ones, every single one is used by exactly
one other file in `src/` — there is no case of a `types.ts` interface shared
by two-or-more internal modules that isn't also consumed externally. That's
a clean signal: `CorrectionMoment` belongs next to `correctionDetection.ts`,
`RepeatedTaskSessionRef`/`RepeatedTaskCluster` next to `repeatedTasks.ts`,
`AvailableToolEntry`/`ToolCurationRecommendation` next to `toolCuration.ts`,
`DarkFactoryStageDefinition`/`DarkFactoryControlState`/`DarkFactoryStageVerdict`
next to `darkFactoryReadiness.ts`. Moving these 8 types out of `types.ts` and
into their owning module is a small, self-contained, zero-consumer-visible
change (they're re-exported from the same barrel path today; moving the
*declaration* doesn't require moving the *export*).

The 14 unused `types.ts` exports listed above are also worth a second look —
`types.ts` is the single largest concentration of dead surface in the repo.

---

## The CLI JSON Output Contract

**Not documented today, beyond a partial, informal treatment.**
`docs/cli/README.md` documents the `stats`, `usage`, `environmental`,
`fluency`, and `diagnostics` commands and their `--json` flag, with a full
JSON schema sample only for `stats --json`. It does not mention the `all`,
`chart`, `usage-analysis`, `segment`, or `curation` commands at all —
and `all --json` and `chart --json` are precisely the commands
`CliBridge.cs`/`CliBridge.kt` depend on for the Visual Studio and JetBrains
hosts. The only in-repo trace of that contract is a doc-comment in
`cli/src/commands/all.ts` ("Used by the Visual Studio extension to load every
view in one CLI call") and the parallel doc-comment in `CliBridge.kt` asserting
the two hosts' JSON expectations are identical.

Per the investigation above, this is very plausibly the higher-value contract
to formalize: two entire native-language hosts depend on it, it currently has
zero schema documentation, zero versioning, and zero compiler enforcement
across the process boundary (a JSON field rename in
`cli/src/commands/payloads.ts` would silently produce `null`s in C#/Kotlin,
not a build error). **This document does not attempt to write that contract
down — it is flagged here as follow-up work**, and arguably should be
prioritized ahead of the TypeScript boundary work below, since it guards
against a class of break (a silent runtime one, in two other languages) that
the TypeScript compiler cannot catch even after this refactor is complete.

---

## Recommended Boundary: An Incremental Sequence

A 442–549 symbol big-bang is not a plan anyone will execute or review. The
sequence below is ordered by risk (lowest first) and each step is independently
useful — stopping after any one of them still leaves the codebase better off.

### Step 1 — `@internal` JSDoc tags on the confirmed internal-only set (proposed, not applied here)

Tag the 42 internal-only symbols (see table above) with `/** @internal */`.
This is purely declarative — `tsc` doesn't enforce it without
`stripInternal` in a `.d.ts` emit step this repo doesn't have, so it changes
no compiled output and breaks nothing. Its value is signaling intent to future
readers and to any future lint rule (Step 3) that wants to consume the tag.

**Why not applied in this pass:** the task explicitly allows implementing
this "only if you can do it accurately for a clearly-bounded set." The set
*is* clearly bounded (42 symbols, ~20 files), but a repo-wide product-name
scrub is concurrently touching prose and comments across `src/` per the task
brief's own file-conflict warning, which makes a multi-file edit pass through
that exact directory tree an avoidable collision risk for no runtime benefit
today. Recommend this as the very next follow-up PR once that scrub lands —
it's a mechanical, reviewable, single-purpose diff of ~42 one-line comment
insertions, with `npm run check-types` and `npm run lint` (which already lints
`../src` from `vscode-extension/package.json`) as the verification gate.

**Cost:** near zero. **Risk:** near zero (comment-only). **Value:** documents
intent, unblocks Step 3.

### Step 2 — `src/index.ts` barrel declaring the intended public surface

Create a barrel that re-exports exactly the 269 symbols in the "Public"
bucket (plus, deliberately, none of the 42 "Internal" ones — "Test-only" and
"Unused" need individual judgment calls, see below). Do **not** delete the
deep-import paths yet; the barrel is additive. Migrate `vscode-extension`,
`cli`, and `desktop` to import from `src/index` at whatever pace is
convenient — each file's migration is a pure mechanical import-path edit, easy
to review one file or one PR at a time.

**Cost:** moderate (one new file, then N small follow-up PRs to migrate
importers — no urgency on those). **Risk:** low — additive only, nothing is
removed until a later step, and the barrel can be built and verified against
the current public-symbol list mechanically (re-run the analysis script,
diff against the barrel's export list).

**Open question for whoever owns this:** what to do with the 135 test-only
symbols. Two honest options: (a) include them in the barrel too, formalizing
"the test suite is a legitimate consumer" and pinning the surface at its
current size, or (b) leave them off the barrel and re-point those ~130 test
imports at higher-level entry points over time, shrinking real coupling. (b)
is more work and the better long-term outcome, but only worth doing
deliberately, test suite by test suite — not as a side effect of drawing the
barrel.

### Step 3 — Import-boundary lint rule

Once the barrel exists and consumers have migrated (or in parallel, gated to
new files only), add an ESLint rule — `eslint-plugin-import`'s
`no-restricted-paths`, or a custom rule — that fails when a file outside
`src/` imports anything from `src/<subpath>` other than `src/index`. This is
where the boundary becomes enforced rather than merely documented.
`vscode-extension/eslint.config.mjs` already lints `../src` (per its `lint`
script), so the wiring point exists; the rule itself is new. **This repo has
another agent actively editing `vscode-extension/eslint.config.mjs` right
now — do not touch that file as part of this work; land the rule in a
follow-up once that edit has merged.**

**Cost:** low (one rule, one config change). **Risk:** low once the barrel
migration (Step 2) is far enough along that the rule doesn't immediately
break dozens of existing imports — sequence matters here, this step should
strictly follow Step 2's migration, not run concurrently with it.

### Step 4 — Split `types.ts` along consumer lines

Move the 8 single-internal-consumer interfaces identified above
(`CorrectionMoment`, `RepeatedTaskSessionRef`, `RepeatedTaskCluster`,
`DarkFactoryStageDefinition`, `AvailableToolEntry`,
`ToolCurationRecommendation`, `DarkFactoryControlState`,
`DarkFactoryStageVerdict`) into their owning modules
(`correctionDetection.ts`, `repeatedTasks.ts`, `toolCuration.ts`,
`darkFactoryReadiness.ts` respectively), keeping their export names and
re-exporting them from `types.ts` for one deprecation window if any external
reference is later found. Separately, delete or re-justify the 14 dead
`types.ts` exports.

**Cost:** low — this is the cheapest structural win available, exactly as the
task brief predicted; each move is independently reviewable and touches only
two files (source + destination) plus the barrel's re-export list.
**Risk:** low, contingent on the "single internal consumer" finding holding up
under a real compiler check (`tsc --noEmit`) rather than just this regex scan.

### Step 5 and beyond — shrink the surface

With the barrel and lint rule in place, use the classification above as a
backlog: retire the 103 dead exports (after a "still needed?" check with
whoever owns each area — some may be intentionally staged ahead of a feature),
and work through the 135 test-only symbols file-by-file, redirecting tests to
higher-level entry points where that's cheap and leaving the barrel entry in
place (accepted as legitimate) where it isn't.

---

## Risks and Costs Summary

| Step | Risk | Cost | Reversible? |
|---|---|---|---|
| 1. `@internal` tags | Near zero (comments only) | ~42 one-line edits | Trivially |
| 2. `src/index.ts` barrel | Low (additive) | 1 new file + N optional migration PRs | Trivially (delete the file) |
| 3. Lint boundary rule | Low, but sequence-dependent on Step 2 | 1 rule + config wiring | Trivially (disable the rule) |
| 4. Split `types.ts` | Low, contingent on compiler confirmation | ~8 type moves, 2 files each | Easily (move back) |
| 5. Retire dead/test-only exports | Medium — requires per-symbol owner sign-off | Ongoing, incremental | Case-by-case |
| (Follow-up) Document CLI JSON contract | N/A — it's documentation | Moderate (5 undocumented commands) | N/A |

The single biggest real risk in this whole area is not in `src/`'s TypeScript
boundary at all — it's the undocumented CLI JSON contract feeding two
process-boundary-separated native hosts with no schema and no compiler
checking it. Recommend treating that as at least equally urgent, tracked as a
separate follow-up.

---

## Scope Note

This document is analysis and proposal only. No exports were removed, no
`src/index.ts` was created, and no imports were rewritten. `@internal` tags
were considered and deliberately not applied in this pass (see Step 1); the
document itself is the deliverable.
