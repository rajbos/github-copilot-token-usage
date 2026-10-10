# Dark Factory Readiness — a per-repository control scan

The **AI Readiness** tab in **Usage Analysis** (or the **Show AI Readiness** command) assesses each
repository in the workspace against the software-development "dark factory" maturity ladder, and
names the specific controls blocking its next stage. It is separate from the personal Fluency Score
view; opening or refreshing that score no longer runs a repository scan.

A dark factory is *not* vibe coding at scale. It is a governed, observable production system in
which humans specify intent, constraints, risk and evidence of success, while agents implement and
validate. The ladder therefore measures **governance and evidence controls**, not AI adoption.

## Two rules that shape the whole design

1. **Measure controls, never claim autonomy.** The scan reports what a repository has. It never
   tells anyone they are ready to go dark — a green build from an unbounded agent is weak evidence.
2. **Per product line, never per person.** The unit of assessment is the repository. Nothing in this
   feature reads, derives or reports anything about an individual developer. That is deliberate:
   the research this comes from explicitly warns against individual performance scoring.

## The ladder

| Stage | Name | What it means |
|---|---|---|
| 0 | Manual / fragmented | Human coding, inconsistent repos and releases. The outcome sought is visibility, not autonomy. |
| 1 | Standardized software delivery | Trunk-oriented delivery, reliable tests, IaC, ownership. Nothing above this is trustworthy without it. |
| 2 | AI-assisted engineers | Developers remain the authors; repository instructions steer assistants; AI policy is written down. |
| 3 | Agent-delegated, human-reviewed | Bounded work packages. An agent may branch, implement, test and open a PR — but cannot approve or merge its own work. |
| 4 | Spec-driven autonomous team | Versioned specifications, acceptance scenarios, independent evaluators, risk classification, progressive delivery. |
| 5 | Bounded dark factory | **Never awarded by this scan.** Hidden holdouts, digital twins, automated rollback and explicit legal accountability are not machine-detectable, and a completely human-free merge path is not the current native GitHub model. |

## The two detection tiers

| Tier | Needs auth? | Examples |
|---|---|---|
| **Filesystem** | No | `.github/workflows/*`, reusable-workflow calls, `CODEOWNERS`, `.devcontainer/`, `.github/agents/`, `.github/skills/`, Issue Forms, `dependabot.yml`, `.github/copilot-instructions.md`, `AGENTS.md`, IaC markers, agentic workflow definitions |
| **GitHub API** | Yes | Rulesets and branch protection, required checks, merge queue, environment protection rules, CodeQL / dependency review / secret scanning enablement, artifact attestations |

The API tier is expected to be unavailable or partially denied — a token may be absent,
fine-grained, or refused on a private repository. That is the common case, not the edge case.

## `present`, `absent`, and `unknown`

A control has three states, and `unknown` is a first-class one. It is never collapsed into a pass or
a fail. The scan turns that into a **band** rather than a single number:

- **`confirmedStage`** — the highest stage whose controls are *all* observed present. Unknowns never
  lift it, so it is a lower bound.
- **`ceilingStage`** — the highest stage nothing observed rules out. Unknowns are treated
  optimistically here, so it is an upper bound, not a claim.

A repository with good files but no GitHub token typically reads *"Stage 0 confirmed · up to Stage 3
unverified — 9 controls not checked"*. That is the honest answer, and the gap is exactly the
evidence the scan could not reach.

Three further honesty rules, all enforced in `resolveControl()`:

- A control with **no observation at all** is `unknown`, never `absent`.
- A control marked `unknownWhenAbsent` (presence is observable, absence is not) reports `unknown`
  rather than `absent`. CodeQL is the clearest case: its *default setup* leaves no file in the
  repository, so a missing `codeql.yml` says nothing about whether scanning is on.
- A **governance** control (`ai-policy`, `risk-classification`) is always `unknown`. A written policy
  cannot be observed by a scanner, so the scan says so instead of guessing. This also means no
  repository is ever reported as fully evidenced.

The collector applies the same rule one level down, in `darkFactorySignals.ts`: **`absent` is only
reported when every path the control needed was actually readable.** A directory that exists but
cannot be read (`EACCES`, `EIO`, …) and a workflow scan cut short by the file cap are both missing
evidence, so they downgrade the result to `unknown`. `ENOENT` and `ENOTDIR` are the exception — those
mean the path genuinely is not there, which is a real answer. Because unreadable evidence can only
ever produce a false *absence* and never a false presence, a positive match is always reported as
`present` even when the surrounding scan was incomplete.

Controls detected by pattern matching are labelled **heuristic** in the UI — they produce
candidates, not verdicts.

## Anti-patterns

Findings surface the anti-patterns from the research that are actually observable:

| Finding | Severity | Trigger |
|---|---|---|
| `agents-before-delivery` | High | AI/agent controls are configured while stage 1 delivery (CI, tests in CI) is absent. |
| `no-independent-evaluator` | Medium | Custom agents exist but none reads as a review, test or security agent — the implementation agent would own its own acceptance oracle. |
| `unbounded-workflow-permissions` | Medium | A workflow declares `permissions: write-all`. |
| `long-lived-cloud-credentials` | Medium | A workflow references static cloud credentials without requesting an OIDC token. |

## Where the code lives

| Concern | File |
|---|---|
| Control catalogue (stages, controls, remediation) | `src/darkFactoryControls.json` |
| Scoring — **pure**, no VS Code API and no filesystem access | `src/darkFactoryReadiness.ts` |
| Filesystem signal collection | `src/darkFactorySignals.ts` |
| Orchestration (paths → signals → PR join → report) | `vscode-extension/src/darkFactoryService.ts` |
| Rendering | `vscode-extension/src/webview/usage/main.ts` and the shared renderer `vscode-extension/src/webview/maturity/darkFactorySection.ts` |
| Types | `src/types.ts` (`DarkFactory*`) |

## Cost

The scan issues **no network calls of its own**. Per repository it is a bounded set of `existsSync`
probes, one shallow `readdir` per interesting directory, and a capped read of at most
`MAX_WORKFLOW_FILES` (50) workflow files. Repository identity comes from reading the git config
directly rather than spawning `git remote get-url`, because a workspace can contribute hundreds of
paths. That read follows the `.git` *file* that linked worktrees and submodules use, via its
`gitdir:` pointer and (for worktrees) the `commondir` hop to the shared config. At most `MAX_SCANNED_REPOS` (25) repositories are scanned per run, and the report says how
many it skipped rather than truncating silently.

The one GitHub-derived signal — `agent-authored-pull-requests` — reuses the pull-request statistics
the Usage Analysis view has **already** fetched (which itself caps at 5 pages per repository). When
those statistics are absent, the control is `unknown`.

## Limitations

- **The API tier is not implemented yet.** Rulesets, required reviews, merge queue, environment
  protection rules and scanning enablement all report as `unknown` with "Needs a GitHub token". The
  data model and `resolveControl()` already handle real API answers, including a 403 arriving as an
  explicit `unknown`.
- Several stage-1 and stage-4 controls (`ci-test-execution`, `infrastructure-as-code`,
  `versioned-specifications`, `executable-acceptance`, `independent-evaluator-agent`) are heuristics
  over file and workflow patterns. They are labelled as such in the UI.
- The scan reads the working tree as checked out. A repository whose delivery is defined entirely in
  a shared reusable workflow will under-report; that is why `artifact-attestations` and
  `deployment-environments` resolve absence to `unknown`.
- Stage 5 is described in the catalogue but is never awarded, by design.
