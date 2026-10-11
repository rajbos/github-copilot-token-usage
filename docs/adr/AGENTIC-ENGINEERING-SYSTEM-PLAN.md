# Agentic Engineering System — Implementation Plan

## Problem Statement

GitHub's [Agentic Engineering System](https://github.com/resources/insights/agentic-engineering-system)
argues that faster code generation only creates value when three "stocks" keep pace with agent
adoption: **governance**, **shared knowledge** and **customer value**. Its central rule is:

> As agent use expands, escaped defect rates should stay flat or fall, and the quality of shared
> knowledge should improve alongside delivery speed.

The extension already measures most of the raw ingredients, but in separate places:

| Blog concept | Where it lives today |
|---|---|
| Governance | AI Readiness (Dark Factory) scan — Usage Analysis → **AI Readiness** tab (`vscode-extension/src/webview/usage/darkFactoryTab.ts`, moved there in #2194), controls in `src/darkFactoryControls.json` |
| Shared knowledge | `missing-instructions` insight, customization matrix, memory-file hygiene, stale skills, Skill Suggestions (`src/repeatedTasks.ts`) |
| Rework / tool-call churn | Corrections tab (`src/correctionDetection.ts`), `ModelEfficiencyCounters` (`src/modelEfficiency.ts`) |
| Review burden / agent PRs | `vscode-extension/src/githubPrService.ts` + `repoPrCache.ts` |
| Define / Deliver | `src/taskClassification.ts` (`Planning`, `Delegation`, …) |
| Adoption | Fluency Score (`src/maturityScoring.ts`) |

What is missing is the blog's core diagnostic: **adoption set against foundations, with speed
always paired with an error signal.** This document is the plan for six items that close that
gap. It changes no code; each phase below lands as its own PR.

## Status: implemented

Phase 0 and items 2–6 are implemented; item 1 was dropped (see below). See
[docs/features/AGENTIC-ENGINEERING-SIGNALS.md](../features/AGENTIC-ENGINEERING-SIGNALS.md) for the
shipped behaviour. They landed together, one commit per phase, rather than as the seven PRs sketched
under *Sequencing* below. Where the implementation departs from this plan, it is on purpose:

- **Item 1 (adoption × foundations matrix) was dropped,** together with the
  `agentic-system-stretched` insight and the stretched-repository note on the Fluency Score strip.
  The plan below understated the problem with `confirmedStage`: it is not "at most 1" but 0 for
  every repository, because stage 1 needs `branch-protection` (API-only, not collected) as well as
  stage 2 needing `ai-policy`. The substitute score (present ÷ observed, unknowns excluded) rated a
  repository higher the less the scan could see, so it was not a trustworthy axis. Revisit once
  those controls can actually be observed.
- **Exploration is contextual in the participation split:** director before a session's first
  performer turn (scoping), assessor after it (reading the change back), instead of being dropped
  when it does not follow an edit.
- **Review burden uses cloud-agent PR volume**, split across the two halves of the PR window, not
  `aiReviewRequestedPrs`: GitHub clears requested reviewers once a review is done, so that count
  under-reports exactly the load the insight is about.
- **`unreviewed-agent-merges` mostly says "cannot confirm".** `human-review-enforced` is an API-tier
  control the scan does not collect yet, so it is `unknown`; the insight words that honestly and
  switches to the firmer wording once the control can be observed as absent.
- **The Fluency Score strip is built outside `calculateMaturityScores`,** whose result is also what
  gets uploaded to a sharing server, and is a separate element from the stage banner and radar so
  exports never include it. It is on-screen only, the default the open question below proposed.
- **The Repository PRs sanitizer moved out of `webview/usage/main.ts`** into
  `repoPrStatsSanitizer.ts` to keep that file under the `max-lines` ceiling after the new sections.

## Guardrails (apply to every phase)

1. **Local only.** Every new signal is computed and shown in the local extension. None of it is
   added to backend rollups, Azure uploads or the sharing server. Combining a repository's
   controls with *my own* usage is fine on my machine; published anywhere else it becomes
   per-person scoring, which both the AI Readiness scan
   (`docs/features/DARK-FACTORY-READINESS.md`, "per product line, never per person") and the
   [sharing-server contract](../../sharing-server/AGENTS.md) forbid.
2. **Honest states.** Follow the readiness scan's `present` / `absent` / `unknown` discipline.
   A metric without a denominator is not shown; a repo whose controls were not scanned is
   *unassessed*, not *weak*.
3. **Heuristics are labelled.** Every new classification is shown as a signal with its
   definition and the counts behind it, never as a verdict.
4. **File-size ceiling.** `extension.ts` (~16.1k lines) and `webview/usage/main.ts` (~7.0k) are
   already over the 6000-line `max-lines` ceiling. New logic goes into pure modules under the
   repo-root `src/` (unit-testable, reusable by the CLI); new UI goes into its own webview module
   (the pattern `darkFactoryTab.ts` established). `extension.ts` only wires calls.
5. **Per-change checklist:** l10n keys in `package.nls.json` + `package.nls.zh-cn.json` with
   `test/unit/l10n.test.ts` coverage; a `state` in
   `.github/skills/visual-view-diff/views.config.json` plus fixture data for every new tab or
   section; `npm run check:contract`, `npm run check:interaction`, `npm run visual:diff`;
   a What's New catalog entry (`vscode-extension/src/whatsNew/catalog.ts`); a CHANGELOG line;
   a feature doc under `docs/features/`. Changes to `.github/skills/visual-view-diff/**` trip
   `guard-agent-config.yml` and need the maintainer's `agent-config-approved` label.

## Phase 0 — Shared foundation: per-repository activity

Items 1, 2, 5 and 6 all need the same thing: session signals grouped by repository with a
**denominator**. Today `buildCorrectionReport()` (`extension.ts`) groups only sessions that
*have* correction moments, so there is no "per session" rate per repo.

### 0a. One repository key

- New `src/repoKey.ts`: `repoKeyFromRemote(url, githubHosts)` → lowercase `owner/repo` for a
  remote on github.com or the configured GitHub Enterprise host (the only hosts the readiness scan
  and the PR collector see), and `repoKeyFromSlug(slug)` for readiness `nameWithOwner` and PR
  stats. A remote on any other host keeps its host in the key (`gitlab.com/o/r`), so it is grouped
  on its own and never merged with a GitHub repository of the same `owner/repo`. Only network
  remotes count: `https`, `http`, `ssh`, `git` URLs and scp-style `host:path`. A local path or
  `file://` remote names a directory, not a repository, and is unattributed. Copilot CLI store
  sessions record a GitHub `owner/repo` slug rather than a remote; the extension marks them from
  their adapter and `repoDisplayFromSession` reads only those as slugs.
- **No folder-name fallback.** A folder name cannot join reliably to `owner/repo` and can collide,
  so a readiness report without `nameWithOwner` is shown by name but never joined or classified
  (it is listed as *not placed: no GitHub remote*).
- Sessions carry `SessionFileCache.repository` (remote URL); readiness reports carry
  `nameWithOwner`; PR stats carry `owner`/`repo`. All three join on this key.

### 0b. `src/repoAgentActivity.ts` (pure)

`buildRepoAgentActivity(sessions, window)` → `RepoAgentActivityReport`, one row per repo key,
over the trailing 30 days:

| Field | Source |
|---|---|
| `sessions`, `interactions`, `tokens` | session cache |
| `agenticSessions` — sessions, not interactions: a session counts once when `modeUsage.agent + customAgent + cli > 0` | `usageAnalysis.modeUsage` |
| `delegationSessions`, `subAgentCalls` | `taskClassification`, `subAgentCalls` |
| `editTurns`, `oneShotEditTurns`, `retries`, `selfCorrections`, `toolCalls` | sum of `usageAnalysis.modelEfficiency` counters |
| `sessionsWithCorrections`, `userCorrections`, `toolErrors` | `correctionCounts` |
| `taskCategoryShares` | `taskClassification.categoryShares` |
| `firstPromptChars` distribution | `firstUserPrompt` (already cached) |

Sessions with no resolvable repository go into a single `(no repository)` row that is shown but
never classified. Add `repoActivity?: RepoAgentActivityReport` to `UsageAnalysisStats`
(`src/types.ts`), built next to `buildCorrectionReport`. No parsing changes and no
`CACHE_VERSION` bump: everything is already in the per-session cache.

**Tests:** `test/unit/repoKey.test.ts` (SSH/HTTPS/GHE remotes, case, `.git` suffix, local and
`file://` paths rejected, same `owner/repo` on two hosts kept apart),
`test/unit/repoAgentActivity.test.ts` (grouping, denominators, unknown-repo bucket, window edges).

**PR 1** = Phase 0 alone (no UI). Low risk, unblocks everything else.

## Item 1 — Adoption × Foundations matrix (dropped — see Status)

**Goal:** place every repository in one of the blog's four states and give the matching action.

### Foundations axis — do not use `confirmedStage`

`confirmedStage` is 0 for every repository in practice: stage 1 includes `branch-protection`, an
API control nothing collects, and stage 2 requires `ai-policy`, a `governance` control that
`resolveControl()` always reports as `unknown`. A matrix built on it would
put every repository in the bottom row.

Instead, compute a **foundation score** in a new pure `src/agenticFoundations.ts`:

- Take the controls in stages 1–3 (governance and shared knowledge for delegated work).
- Score = present ÷ (present + absent), with **unknowns excluded from both** and reported
  alongside (`observed: 11 of 19`).
- `strong` ≥ 0.7 **and** `ceilingStage` ≥ 2; `weak` ≤ 0.4 or any stage-1/2 control *absent*
  among `ci-test-execution`, `agent-instructions`/`copilot-instructions`;
  otherwise `partial`. Thresholds sit at the top of the module as tunables.
- Fewer than N observed controls → `unassessed`, never `weak`.

### Adoption axis

From Phase 0: `agenticSessions` — a per-session flag, never the `modeUsage` interaction counts,
which would count a multi-turn session many times — as a share of the repo's sessions, plus an
absolute floor (≥ 5 agentic sessions in 30 days) so one session doesn't count as "high adoption".
Cloud-agent tasks are left out of v1: they are a different population from local sessions, and
adding them to a local-session share would mix denominators.

### Quadrants and actions (blog wording)

| | Low adoption | High adoption |
|---|---|---|
| **Strong foundations** | Healthy but underused → *delegate small, well-bounded tasks* | Healthy agent-native → *expand to the next safe class of work* |
| **Weak foundations** | Underdeveloped → *strengthen foundations first* | **Stretched** → *narrow scope, repair the listed controls* |

`partial` foundations sit on the boundary and show "leaning" rather than being forced into a
quadrant.

### Scope limit

The readiness scan only covers repositories **open in the workspace** (`selectRepoRoots`). Repos
with session activity but no scan appear in an "Adoption only — open this repository to assess
its foundations" list. They are not guessed.

### UI

A new **Agentic System** section at the top of the existing **AI Readiness** tab (not a new
view: #2194 deliberately consolidated repo-level assessment there). A 2×2 grid of repo chips,
each chip opening that repo's readiness card; under the grid, the recommended action and, for
Stretched repos, the missing controls from `nextStageToClose()`. New module
`webview/usage/agenticMatrixSection.ts`, wired through `darkFactoryTab.ts`. The host message
`readinessLoaded` gains `repoActivity` (update `check:contract`).

### Insight

`agentic-system-stretched` in `insightsEngine.ts`: fires when any assessed repo is Stretched,
linking to the tab. Add `repoActivity` and a readiness summary to `InsightContext`.

**Tests:** `agenticFoundations.test.ts` (unknown exclusion, `unassessed`, every quadrant,
threshold edges, a repo whose confirmed stage is 0 but foundations are strong);
`webview-agenticMatrixSection.test.ts`; `usageWebviewMessageFlow.test.ts` for the new payload;
`insightsEngine.test.ts` for the insight. Visual state `readiness` fixture gains two repos in
different quadrants.

**PR 3** (after PR 2).

## Item 2 — Rework as a shared-knowledge signal, per repository

**Goal:** show that rework tracks missing context, using the user's own data.

- New pure `src/knowledgeSignals.ts`: per repo, from Phase 0:
  `correctionsPerSession`, `oneShotRate = oneShotEditTurns / editTurns`,
  `retriesPerEditTurn`, `toolErrorsPerSession`, `toolCallsPerEditTurn` ("tool-call churn").
- Split repos into cohorts by whether they have agent instruction files. The source is the
  per-workspace customization scan the extension already caches, joined **per session**: each
  session's resolved workspace folder gives its instruction files, and the session's own remote
  gives the `owner/repo` key (`collectRepoKnowledge` in `extension.ts`). The
  `WorkspaceCustomizationMatrix` rows themselves carry no repository identity, so they are not
  joined directly. A repository with no scanned checkout is *unknown*, not "no instructions".
  Compare cohort medians.
- Show the comparison only when each cohort has ≥ 3 repos and ≥ 20 sessions. Otherwise show
  per-repo numbers without a claim. Label it clearly: *correlation in your own data, not
  causation*.

**UI:** on the **Corrections** tab, add a "Per repository" summary table above the existing
per-session list: rates and instruction-file presence per repo, plus the cohort comparison
sentence when it qualifies. New module `webview/usage/correctionsRepoSummary.ts`.

**Insight:** upgrade `missing-instructions` to cite the user's own cohort delta when available
("sessions in your repos with an AGENTS.md needed 38% fewer corrections"); fall back to today's
wording otherwise.

**Tests:** `knowledgeSignals.test.ts` (zero edit turns, cohort thresholds, median with even and
odd counts); insight wording in both locales.

**PR 2** (after PR 1). It comes before the matrix because it is lower risk and its numbers are
reused there.

## Item 3 — Pair every speed metric with an error metric

**Goal:** avoid "motion mistaken for progress". Adoption growth should be read next to rework.

- New pure `src/speedVsError.ts`: for `month` vs `lastMonth` (already in `UsageAnalysisStats`),
  compute Δ adoption (agentic sessions, interactions) and Δ rework (corrections per session,
  one-shot rate). Classify: `faster-and-steadier`, `faster-but-weaker` (adoption ↑ and rework ↑
  beyond a tolerance), `steady`, or `insufficient-data`.
- **Fluency Score view:** under the stage header, a small "Quality alongside adoption" strip
  showing one-shot rate and corrections/session with their month-over-month direction. (A
  Stretched-repository note was planned here; it was dropped with Item 1.) **The stage calculation in `maturityScoring.ts` does not change:**
  scoring rules are a documented contract (`docs/FLUENCY-LEVELS.md`) and team uploads depend on
  them.
- **Insight:** `speed-without-quality` when the class is `faster-but-weaker`.

**Tests:** `speedVsError.test.ts` (tolerance edges, empty last month); `insightsEngine.test.ts`;
visual state for the maturity view with the strip.

**PR 4** (after PR 1; independent of Items 1 and 2 apart from the optional Stretched note).

## Item 4 — What happens to AI-authored PRs after merge (escaped-defect proxy)

**Goal:** the only customer-value-adjacent signal a local tool can produce honestly.

- **No extra API calls.** `fetchRepoPrsPage()` already lists `pulls?state=all`, and each item
  carries `title`, `body` and `merged_at`. Extend the collector to keep, per repo:
  - `aiMergedPrs` — PRs **authored by an AI bot account** (cloud agents) with `merged_at`.
    Co-authored PRs are out of scope: detecting a `Co-authored-by:` trailer needs a commits request
    per PR, which the bulk path deliberately does not make. Locally driven agent work therefore
    lands in the baseline, which the UI labels as "others";
  - `aiRevertedPrs` — AI PRs referenced by a later PR whose title matches `^Revert "` and whose
    body matches `Reverts owner/repo#N` (GitHub's revert-button format), or whose title quotes
    the AI PR's title exactly;
  - `aiFollowUpFixes` (optional, v2) — PRs titled `fix…` merged within 7 days that reference the
    AI PR number. Kept out of v1 because it is noisier.
- New pure helper `src/prOutcomes.ts` (`detectReverts(prs)`) so matching is unit-tested without
  HTTP. Bump the `repoPrCache.ts` snapshot version, because the shape changes.
- The **human** side matters too: compute the same revert rate for the user's own non-AI PRs as
  the baseline. The blog's claim is about the *trend*, not an absolute number: show "AI PR revert
  rate vs. your baseline" and the 30-day vs. previous-30-day direction.
- Known blind spots, stated in the UI: reverts done as direct pushes, fix-forwards and squashed
  reverts are not detected. The number is a lower bound.

**UI:** add columns (merged, reverted, rate) to the existing repository PR table in Usage
Analysis (`repos` state), and feed `aiRevertedPrs` into Item 1's Stretched explanation.

**Tests:** `prOutcomes.test.ts` (revert-button body, quoted title, revert of a revert, cross-repo
references ignored); `githubPrService` tests with fixture PR pages; repo-PR cache version test.

**PR 5** (independent; can land in parallel with PRs 2–4).

## Item 5 — Anti-pattern insights

Three new insights in `insightsEngine.ts`, each a pure predicate over existing or Phase-0 data:

| Insight id | Blog anti-pattern | Signal | Threshold (tunable) |
|---|---|---|---|
| `delegation-without-objective` | Delegating execution without defining objectives | Agent or delegation sessions whose `firstUserPrompt` is under N characters (for example 80), with no planning turn before the first edit, that go on to have ≥ 2 user corrections. Compare to the user's longer-prompt sessions. | ≥ 5 such sessions in 30 days **and** a correction rate ≥ 1.5× the long-prompt baseline |
| `unreviewed-agent-merges` | Green checks treated as review | Repos with `agent-authored-pull-requests` present and `human-review-enforced` absent (from the readiness scan) | any; wording differs when the control is `unknown` ("could not verify") |
| `review-burden-rising` | Rising review burden means poor scoping / weak knowledge | Cloud-agent PRs opened in the recent half of the PR window against the earlier half, together with reverted agent PRs or a rising correction rate in that repository's own sessions (see *Status: implemented* above for why not `aiReviewRequestedPrs`) | ≥ 5 recent agent PRs, recent ≥ 1.5× earlier, and reverts > 0 or rework ↑ |

Each insight names the repo(s) and links to the tab that shows the evidence (Item 1 or 2
sections). The first-prompt heuristic sits in `src/promptScoping.ts` with its own tests.

`firstUserPrompt` is truncated to 500 chars, which is fine because only the short end matters.
"No planning turn before the first edit" needs per-turn categories:
`taskClassification.turnCategories` is already cached.

**Tests:** one `insightsEngine.test.ts` block per insight (fires, does not fire, unknown
wording), plus l10n tests for both locales.

**PR 6** (after PRs 2 and 5 for the review-burden insight; the other two only need PR 1).

## Item 6 — Director / Performer / Assessor lens

**Goal:** show how the user's time splits across the blog's three modes.

- Mapping over the existing `TASK_CATEGORIES` (`src/taskClassification.ts`), in a new pure
  `src/participationModes.ts`:
  - **Director:** `Planning`, `Brainstorming`, plus `Delegation` turns (the human sets intent and
    hands off);
  - **Performer:** `Coding`, `Feature Dev`, `Refactoring`, `Debugging`, `Build/Deploy`, `Git Ops`;
  - **Assessor:** `Testing`, and `Exploration` after the session's first performer turn (reading
    the change back). PR reviews are **not** counted: the collector's `role: 'reviewer-requested'`
    means an *AI* reviewer was requested, not the user, so it would invert the signal. A user-review
    signal would need its own data source and is left for later.
  - `Conversation` is left out of the split.
- Weight by turns (from `turnCategories`), not sessions, so a long session is not one vote.
- Show the split overall and per repo (Phase 0), and next to it the delegation share. Signal:
  **high delegation + low Assessor share** means work is being handed off without being checked.
- The mapping is a heuristic and its definition table is shown in the UI. The mapping itself is
  data (a JSON next to the module), so it can be tuned without code changes.

**UI:** a card on the Usage Analysis **Insights** tab (the `insights` state exists), rendered
from a new `webview/usage/participationModesCard.ts`. Optional follow-up: a per-day stacked bar
in the chart view.

**Tests:** `participationModes.test.ts` (mapping, Exploration-after-edit rule, empty sessions,
per-repo split). Visual state for the card.

**PR 7** (after PR 1).

## Sequencing

```
PR 1  Phase 0: repo key + per-repo activity (no UI)
 ├── PR 2  Item 2: rework per repo + cohort comparison         (Corrections tab)
 │    └── PR 3  Item 1: Adoption × Foundations matrix          (AI Readiness tab)
 ├── PR 4  Item 3: speed-vs-error strip + insight              (Fluency Score view)
 ├── PR 7  Item 6: participation modes card                     (Insights tab)
 └── PR 6  Item 5: anti-pattern insights                        (needs PR 5 for review-burden)
PR 5  Item 4: PR outcomes / revert rate                         (independent; Repos tab)
```

PR 3 is the headline and could come right after PR 1 if the cohort numbers from Item 2 are not
needed for the first version of the matrix.

## Risks and open questions

- **Thresholds are guesses** until tried on real data. Each module keeps its tunables at the top
  and the first PR for each item should include a run against local sessions (as
  `CORRECTIONS.md` did for its precision notes) and record the numbers in the feature doc.
- **Repository attribution gaps.** Sessions without a resolvable remote (CLI in `$HOME`, cloud
  chat) land in `(no repository)`. The share of such sessions should be shown so a small
  per-repo sample isn't read as a trend.
- **Small samples.** Per-repo rates hide small denominators. Rule: never show a rate without its
  counts, and hide cohort claims below the minimums above.
- **Non-VS Code hosts.** The CLI, Visual Studio and JetBrains get the pure `src/` modules for
  free, but the readiness scan and PR collector are VS Code-only today. The per-host UI decision
  goes through the `sync-host-views` skill and is out of scope for this plan.
- **Open question for the maintainer:** should the Stage-4 annotation (Item 3) also show in the
  exported/shared fluency image, or stay on-screen only? The default in this plan is on-screen
  only, per guardrail 1.
