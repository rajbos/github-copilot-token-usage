# Repo health scan

A daily pass over eight code-health topics that turns **one** finding per day
into an issue and a PR that fixes it, and keeps a running dashboard of the
rest.

| Topic | What is flagged |
|---|---|
| Style & validation | ESLint style/validation rule violations, grouped per file |
| Naming consistency | ESLint `naming-convention`; file names that break their tree's dominant convention |
| Cyclomatic complexity | Functions over `complexity`, `sonarjs/cognitive-complexity`, `max-depth` or `max-lines-per-function` |
| Large files | ≥ 1500 non-blank lines (≥ 3000 for tests); ≥ 6000 is an error, matching ESLint `max-lines` |
| Dead code | Unused variables/imports, unreachable code, exports nothing references |
| Duplicate code | Clone groups ≥ 14 lines from `scripts/check-code-duplication.js` |
| Modularization | Layer-boundary imports, runtime import cycles, CLI re-declaring a shared `src/` function |
| Technical debt | TODO/FIXME/HACK markers and `@ts-ignore`/`@ts-nocheck`; plus trend counters for `eslint-disable` and explicit `any` |

## The pieces

| Piece | Role | AI cost |
|---|---|---|
| `scripts/repo-health-scan.js` | Deterministic scanner. Reuses ESLint and the duplication detector rather than re-implementing them. | none |
| `.github/workflows/repo-health-scan.yml` | Daily scan → step summary + the **Repo health dashboard** issue (label `repo-health-dashboard`), with the change since the previous run (measured against that run's report artifact, never the editable issue). | none |
| `repo-health-scan` agent (`.github/agents/`, `.claude/agents/`) | Picks one untracked finding, opens a `repo-health` issue, fixes it, opens a PR with `Fixes #n`. | one agent run |

Every finding has a stable id (`rh-` + 12 hex characters, derived from topic,
file and symbol/content — never a line number). The issue body ends with a
visible `repo-health-id:` footer. Any id that appears in **any** `repo-health`
issue, open or closed, is never picked again. So:

- closing an issue as **not planned** permanently suppresses that finding;
- a failed fix leaves its issue open for a human instead of retrying daily;
- if more than three `repo-health` PRs are open, no new work starts.

The starting topic rotates by date, so each topic gets attention instead of
the cheapest one winning every time. Findings in
`vscode-extension/src/extension.ts` are reported but never picked; that file has
its own plan (`docs/adr/EXTENSION-TS-DECOMPOSITION.md`).

## Choosing who does the fixing

The scan and dashboard always run on GitHub. The fixing half runs in one of two
places. Pick one; running both would just race for the same finding.

### Option A: local Claude Code routine (default, no AI credits)

A scheduled task in the Claude desktop app runs the `repo-health-scan` agent in a
fresh worktree from `origin/main`, like the existing
`refactor-large-function-weekly` routine. It uses your Claude plan rather than
GitHub AI credits, and it only runs while your machine is on. Leave the
`REPO_HEALTH_COPILOT_HANDOFF` variable unset.

### Option B: GitHub-native (Copilot coding agent)

Set the repository variable `REPO_HEALTH_COPILOT_HANDOFF=true`, or tick
`copilot_handoff` on a manual run. After the scan, the workflow opens the issue
and assigns it to Copilot. The coding agent then works it per the agent file,
starting at Step 4. This needs the `GH_PAT` secret, because `GITHUB_TOKEN`
cannot assign Copilot. Each handoff costs one coding-agent session.

## Running the scanner yourself

```bash
cd vscode-extension && npm ci && cd ..         # ESLint-backed topics need this
node scripts/repo-health-scan.js               # Markdown report
node scripts/repo-health-scan.js --json --out report.json
node scripts/repo-health-scan.js --from report.json --pick --tracked tracked.json
node scripts/repo-health-scan.js --skip-eslint # fast, non-ESLint topics only
node --test scripts/repo-health-scan.test.js   # unit tests
```

A full scan takes about 1–2 minutes, mostly ESLint. `--from` renders any mode
from a saved report instantly.

## Tuning

Thresholds, layer rules and exclusions are constants at the top of
`scripts/repo-health-scan.js` (`LARGE_FILE_WARN`, `LAYER_RULES`,
`EXPORT_ALLOWLIST`, `PICK_EXCLUDED_FILES`, …). Changing a finding's `key` scheme
changes its id, so existing issues stop matching and the finding would be picked
again. Avoid that, or accept a one-time wave of re-picks.
