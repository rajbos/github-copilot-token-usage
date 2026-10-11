# AI Engineering Fluency — Repository Instructions

(Previously known as the "GitHub Copilot Token Tracker")

This document provides top-level guidance for AI agents contributing to this repository. Detailed, folder-specific instructions live in `.github/instructions/` and are applied automatically by Copilot when you work inside those folders.

## Repository Structure

Run `ls -a` (or `git ls-files | cut -d/ -f1 | sort -u`) for the live top level.

```
/
├── AGENTS.md                    ← This file (the canonical content)
├── CLAUDE.md                    ← Claude Code entry point (imports this file and sharing-server/AGENTS.md)
├── build.ps1 / dev.ps1          ← Root build orchestrator / local dev helper
├── src/                         ← Shared TypeScript sources + JSON data files
│                                   (session parsing, token estimation, adapters —
│                                    consumed by vscode-extension/ and cli/)
├── vscode-extension/            ← VS Code extension (TypeScript / Node.js)
├── cli/                         ← Command-line tool  (TypeScript / Node.js)
├── copilot-app/                 ← GitHub Copilot app canvas, shipped as the `ai-fluency-canvas`
│                                   Copilot plugin (plain Node .mjs, no build; runs the CLI)
├── visualstudio-extension/      ← Visual Studio extension (C# / .NET)
├── jetbrains-plugin/            ← JetBrains IDE plugin (Kotlin / Gradle / IntelliJ Platform)
├── desktop/                     ← Electron tray app; reuses vscode-extension's built
│                                   webview bundles and cli/vscode-extension stats logic
├── sharing-server/              ← Self-hosted API server + web dashboard for sharing
│                                   fluency data across a team (TypeScript, SQLite, Docker)
├── release-video/               ← Local release-video generator: the What's New
│                                   catalog + the visual-view-diff harness ->
│                                   narrated MP4 (TypeScript, FFmpeg, local TTS)
├── scripts/                     ← Build/release/CI helper scripts (Node, PowerShell, Python)
├── omp-segment/                 ← Oh My Posh terminal prompt segment showing token usage
├── assets/                      ← Logos and other static brand assets
├── docs/                        ← Shared documentation
├── screenshots/                 ← Only a `.vscode/settings.json` pointing the sample-data
│                                   setting at sample session data; not otherwise used
├── .vscode/                     ← Shared VS Code settings, tasks and launch configs
│                                   (for human developers; see "Never Launch a Real Editor/IDE Instance")
├── .devcontainer/               ← Dev container definition (see "DevContainer Terminal Behavior")
├── .claude/                     ← Claude Code subagents (`agents/`) and skills (`skills/`),
│                                   mirrored from `.github/` (see the mirroring section)
├── .github/
│   ├── copilot-instructions.md  ← Pointer to this file (`See ../AGENTS.md`)
│   ├── agents/ , skills/        ← Copilot custom agents and Agent Skills (mirrored to `.claude/`)
│   ├── workflows/               ← CI/CD
│   ├── plugin/marketplace.json  ← Copilot plugin marketplace catalog (lists copilot-app/)
│   └── instructions/            ← Folder-specific guides (see the table below)
└── README.md, CONTRIBUTING.md, CHANGELOG.md, SECURITY.md, SUPPORT.md, LICENSE, and generated
    reports (LOC_STATS.md, hardcoded-strings-report.md)
```

## Sub-project Instructions

| Folder | Instructions file |
|---|---|
| `vscode-extension/` | `.github/instructions/vscode-extension.instructions.md` |
| `cli/` | `.github/instructions/cli.instructions.md` |
| `visualstudio-extension/` | `.github/instructions/visualstudio-extension.instructions.md` |
| `jetbrains-plugin/` | `.github/instructions/jetbrains-plugin.instructions.md` |
| `sharing-server/` | [sharing-server/AGENTS.md](sharing-server/AGENTS.md), `.github/instructions/sharing-server.instructions.md` |
| `.github/workflows/` | `.github/instructions/workflows.instructions.md` |

All sharing-server coding, testing, documentation and downstream customization
must follow the [server data separation contract](sharing-server/AGENTS.md).

## Building Everything

Use the root orchestrator from the repo root:

```powershell
./build.ps1                          # build all projects
./build.ps1 -Project vscode          # build VS Code extension only
./build.ps1 -Project cli             # build CLI only
./build.ps1 -Project vscode -Target test   # run tests
```

Individual project builds:
```bash
cd vscode-extension && pnpm run compile   # VS Code extension
cd cli && pnpm run build                   # CLI
```

## Documentation

The `docs/` folder contains all project documentation. Start with the index:

📖 **[docs/README.md](docs/README.md)** — Full categorized index of all documentation

Key categories:
- **Core Reference** — fluency scoring rules, data schemas, trackable metrics
- **Component Docs** — per-component guides (`cli/`, `vscode-extension/`, `visual-studio/`, `sharing-server/`, `specs/`)
- **Log File Schemas** — session log formats for all supported editors (`docs/logFilesSchema/`)
- **Feature Docs** — per-feature documentation (`docs/features/`)
- **ADRs** — implementation notes and architectural decisions (`docs/adr/`)

## Development Guidelines

- **Minimal Changes**: Only modify files directly needed for the task. Avoid touching unrelated files.
- **Focused Modifications**: Make surgical, precise changes without affecting other functionality.
- **Preserve Existing Structure**: Don't refactor or reorganize unless essential for the task.

## Never Launch a Real Editor/IDE Instance

AI agents (Claude Code, GitHub Copilot, etc.) must never launch a real, visible instance of an IDE as part of testing or verifying a change — e.g. `code .` / `code <file>`, pressing `F5` to start the VS Code Extension Development Host, `./gradlew runIde` (JetBrains sandbox IDE), or opening Visual Studio/`devenv`. These pop open real windows on the developer's machine, which is disruptive and unexpected when it happens mid-session, especially in unattended or scheduled agent runs.

These steps are documented in places like `.github/instructions/vscode-extension.instructions.md` and `.github/instructions/jetbrains-plugin.instructions.md` **for human developers only**, who can watch the window, click through the UI, and close it when done. An agent has no way to "close" a window it opens and no way to observe it, so these steps are meaningless for automated verification and only cause disruptive side effects.

Instead, verify changes using non-interactive tooling: compile/build scripts (`pnpm run compile`, `./gradlew build`, `dotnet build`), automated unit test suites (`pnpm run test:node`, `./gradlew test`, `dotnet test`), and linters/type-checkers. If you are writing or editing a skill, prompt, or instructions file, do not add steps that tell an agent to launch a GUI editor/IDE — mark such steps explicitly as manual/human-only, or omit them entirely from agent-facing docs.

This also governs `.github/github-app.yml`. Its `code .` script has **no `triggers` entry**, on purpose — that makes it an on-demand action a human clicks in the GitHub App's session UI, not something that fires automatically. **Never attach `triggers: [session.create]` (or any other trigger) to a script that launches an editor/IDE.** `automation.auto_issue_session: true` means sessions can be created unattended (e.g. an issue auto-assigned to Copilot) with nobody there to click anything — a triggered `code .` would pop open a real VS Code window during those unattended sessions too, which is the exact bug this section exists to prevent. Non-GUI setup steps (installing dependencies, compiling) are fine to keep on `session.create` since they have no visible side effect.

## CLI Must Reuse Shared Functions

The CLI (`cli/`) is a thin consumer of the shared TypeScript modules in the repo-root `src/` folder (the same modules the VS Code extension uses). **Never reimplement session parsing or cost attribution logic in the CLI — always call the shared functions from `src/`.**

### The canonical split (mirrors `getSessionFileDataCached` in `extension.ts`)

| What you need | Function to call | Source |
|---|---|---|
| Token counts (total, actual, thinking) | `estimateTokensFromJsonlSession()` | `tokenEstimation.ts` |
| Per-model cost attribution (model usage) | `getModelUsageFromSession()` | `usageAnalysis.ts` |
| Debug-log token override | `extractAllTokensFromDebugLog()` | `tokenEstimation.ts` |

**Critical rule**: `estimateTokensFromJsonlSession().modelUsage` must **not** be used as the primary source for model attribution. It returns `{}` for delta-format sessions (VS Code Chat JSONL), causing $0 cost for those sessions. Always call `getModelUsageFromSession()` separately for model attribution — it handles all formats through a single code path.

```typescript
// Correct — matches VS Code's getSessionFileDataCached pattern:
const result = estimateTokensFromJsonlSession(content);         // token counts only
tokens = result.actualTokens > 0 ? result.actualTokens : result.tokens;
fileModelUsage = await getModelUsageFromSession(deps, filePath, content); // attribution

// Wrong — diverges from VS Code, breaks delta-format sessions:
fileModelUsage = result.modelUsage; // empty {} for VS Code Chat sessions
```

If you find yourself adding a fallback like "if modelUsage is empty, call X" in the CLI, that is a sign the primary attribution source is wrong — fix the source instead.

## Coding Agent Data Sources

When running as the GitHub Copilot Coding Agent (bootstrapped via `.github/workflows/copilot-setup-steps.yml`), extra data may be hydrated into the workspace: `./session-logs/`, `./usage-data/usage-agg-daily.json` and `./usage-data/agent-sessions.json`. They are **not** present in local development, and the Azure-backed ones only exist when the `copilot` GitHub environment has `COPILOT_STORAGE_ACCOUNT` configured (`agent-sessions.json` comes from the GitHub API and does not need it). The `session-log-data` skill (`.github/skills/session-log-data/SKILL.md`) documents the schemas, analysis examples and cost estimation. Check that the files exist before relying on them.

These hydrated files are generated output, not source. `session-logs/` and `usage-data/` are git-ignored; **never commit or force-add them** to a PR.

### Code knowledge graph (graphify)

The same setup workflow builds a code-only graphify knowledge graph at **`.graphify-agent/graph.json`** (local AST parsing, no secrets, non-blocking — it can be missing if the build failed; then fall back to ordinary file search). For structural questions (what calls a symbol, what a change reaches) prefer it over fanning `grep` across the tree:

```bash
export GRAPHIFY_OUT=.graphify-agent
graphify query "how does the CLI attribute per-model cost"
graphify explain "getModelUsageFromSession"
graphify affected "src/tokenEstimation.ts"     # blast radius
graphify path "extension.ts" "modelPricing.json"
```

The graph is a setup-time snapshot and covers code only (not docs). Refresh it with `GRAPHIFY_OUT=.graphify-agent graphify extract . --code-only --no-viz`. CI builds into `.graphify-agent/`; never build into the default `graphify-out/` (it is git-ignored, nothing in it is committed, and a stale local copy there is not the CI graph), and do not use `graphify update .` for this.

## Agent Changes to CI and Agent Configuration Need a Human

`.github/workflows/guard-agent-config.yml` fails a pull request that both
(a) touches `.github/**`, `.claude/**`, `.devcontainer/**`, `AGENTS.md` or
`CLAUDE.md`, and (b) looks agent-authored — an agent branch prefix
(`claude/`, `copilot/`, `agent-review/`), a bot PR author other than
dependabot or github-actions, or an AI `Co-authored-by:` trailer on any
commit. That trailer match is not limited to Claude and Copilot — it also
covers GPT, Codex, Gemini, Mistral, Vibe, Devin, Cursor and Aider, so do not
read the two examples as the whole list.

These are the files that decide what automation is allowed to do, so an agent
must not be able to change them unattended. If your PR trips this check, that
is the check working: say what you changed and why, and ask the maintainer to
review those paths and add the `agent-config-approved` label. Do not try to
route around it by renaming the branch or dropping the co-author trailer.

## Keep Claude Code's Mirrored Agents & Skills in Sync

This repo also ships Claude Code equivalents of the Copilot customizations below, kept as separate files because the two tools use different formats/locations:

- `.github/agents/*.agent.md` (Copilot custom agents) ↔ `.claude/agents/*.md` (Claude subagents) — same name, same body content, but frontmatter `tools:` uses Claude's tool names (`Read`, `Grep`, `Glob`, `Bash`, `Edit`, `Write`, `Agent`) instead of Copilot's internal tool IDs (`search/codebase`, `execute/runInTerminal`, etc.). Bodies **should** match, but **may** intentionally diverge where the two platforms' mechanics genuinely differ — e.g. CI-driven vs. local Bash invocation, cross-vendor model names vs. Claude Code's own (`opus`/`sonnet`/`haiku`), or the `task` tool vs. the `Agent` tool. Keep any such divergence minimal and deliberate: it should read as a platform adaptation of the same instruction, not a different instruction.
- `.github/skills/*/SKILL.md` (Copilot Agent Skills) ↔ `.claude/skills/*/SKILL.md` (Claude Skills) — **only** the `SKILL.md` is duplicated (same content, same format on both tools). The scripts, README, and other supporting files live **only** under `.github/skills/<name>/` — do not copy them. The `.claude/skills/<name>/SKILL.md` file's instructions reference those scripts by their real `.github/skills/<name>/...` path, so there is a single source of truth for the code and no duplication.

**If you add, remove, or edit a file under `.github/agents/`, make the matching change under `.claude/agents/` in the same PR** (and vice versa). **If you edit a skill's `SKILL.md` under `.github/skills/`, copy the same edit into `.claude/skills/<name>/SKILL.md`** — but if you only change a script/README/data file (not `SKILL.md` itself) under `.github/skills/`, no Claude-side change is needed, since Claude's copy just points at that same file. Claude Code does not read `.github/agents/` or `.github/skills/` on its own — without this manual mirroring the Claude-side copy silently goes stale.

## Keep This File's Structure Diagram and Title in Sync

This file's "Repository Structure" diagram and H1 title are the brief every agent
reads to learn what this repo *is*. They go stale the same way the agents/skills
mirror above does, and the failure mode is worse: agents get briefed on a repo
that no longer exists.

**Adding or removing a top-level directory, or renaming the product, requires
updating this file's structure diagram and title in the same PR.** Concretely:

- A new or removed directory under the repo root → add or remove its line (with
  a short one-line description) in the diagram above.
- A product rename → update the H1 and any other name references here, the way
  `README.md`'s title and "Previously known as" line do.

## Skill security classification

Every skill under `.github/skills/<name>/` that ships scripts (`.js .mjs .cjs .ts .ps1 .sh .py`, excluding `tests/` directories and `*.test.*`/`*.spec.*` files) must be classified. It either carries a one-page `SECURITY.md` next to its `SKILL.md`, or it is declared `exempt` (with a reason) or `pending` (with a tracking issue number) in `.github/skills/skill-security-classification.json`. Never both. `scripts/validate-skill-security.js` enforces this over all skills in CI (`validate-skills.yml`) and fails the build otherwise.

A skill needs a `SECURITY.md` when any shipped script:

1. makes network requests;
2. reads, stores or sends credentials, tokens or keys;
3. parses content from outside the operator's control (downloads, PR diffs from forks, another repo's content);
4. writes anywhere other than stdout or its declared output location;
5. runs an external program with arguments or input derived from any of the above;
6. emits content read from the user's AI session logs or home-directory data in a way that can carry private prompt text into a chat transcript, CI log, PR comment or tracked file. Output limited to counts, field paths, model IDs and file metadata, with values only behind an explicit opt-in flag, is exempt with the privacy note in the reason. Printing or persisting session-derived free text (titles, prompts, example values) by default is not.

The `SECURITY.md` template is deliberately short. Required `##` sections: *What the scripts do and talk to*, *Credentials used and where they come from*, *Untrusted inputs parsed*, *What it writes and where*, *External programs run*, *Mitigations in the code*, *Known gaps*. Derive every statement from reading the scripts; write `None.` where a section does not apply. Do not invent threats or mitigations.

When you add or change a skill script, classify it in the same PR. A change that adds or alters a trigger surface (a new network call, credential, output location, spawned program, or a new way session data reaches output) updates that skill's `SECURITY.md`, or moves it between exempt and modelled, in the same PR. `SECURITY.md` and the classification file live only under `.github/skills/`; they are not mirrored to `.claude/skills/`.

## DevContainer Terminal Behavior

Inside the devcontainer (`.devcontainer/devcontainer.json`), terminal output capture can be unreliable — commands run but their output comes back empty or truncated (a remote filesystem limitation). Don't retry-loop, poll, redirect to temp files, or delegate to a subagent hoping for cleaner output; none of that converges. Instead:

1. **Use the package scripts (pnpm)** (from `vscode-extension/`): `pnpm run compile`, `pnpm run validate` (type-check + lint + build), `pnpm run compile-tests`, `pnpm run test:node`, `pnpm run test:coverage`.
2. **Check compile errors with the project's type-check/validate script** or your tool's diagnostics, rather than running `tsc` by hand. (Copilot users: the `get_errors` tool.)
3. **Run tests one file at a time**, e.g.
   ```bash
   cd vscode-extension
   node --require ./out/vscode-extension/test/unit/vscode-shim-register.js --test out/vscode-extension/test/unit/sessionParser.test.js
   ```
4. **Accept a single run.** If a command returns no output, don't re-run it.
5. If you must capture output to a file, write it inside the workspace, not `/tmp/`, so your file-read tool can reach it. (Copilot users: `run_in_terminal` / `read_file`.)

## Webview changes must be validated by clicking, not by reading

The `postMessage` wire between a webview panel and the extension host is untyped by construction, and a `<button>` nobody attached a listener to looks identical to a working one in the source. After any change under `vscode-extension/src/webview/**` or to a panel's message handling in `extension.ts`, run both checks (they render the real bundles headlessly and never open an editor window, so they are safe for agents):

```bash
cd vscode-extension
pnpm run check:contract      # every posted message has a handler on the other side
pnpm run check:interaction   # clicks every control in every panel
```

For any change that alters what a panel *looks like*, also run `pnpm run visual:diff` and read `../visual-output/diff/report.md` (repo-root `visual-output/`) plus the diff PNGs: the views you changed should show as changed and nothing else should. Name the expected views/tabs in the PR body. CI posts the before/after/diff screenshots on the PR itself: the `ui-checks` job renders and uploads them, and the separate `ui-checks-comment.yml` `workflow_run` workflow (it runs from the default branch, where the upload secret lives) attaches them as one comment, replaced on every push. Do not commit PNGs or upload images by hand.

Registry rules (a miss fails nothing, so they are easy to forget):

- **A new webview panel must be added to `.github/skills/visual-view-diff/views.config.json`**, with a fixture for its `__INITIAL_*__` payload. That one registry feeds the visual diff, the CI screenshots, the interaction crawl and `release-video/`.
- **A new tab or mode on an existing panel needs a `state`** in the same file, or it diffs as "unchanged" and ships without a screenshot. (`release-video/` falls back to the `.tab-button[data-tab="…"]` / `#tab-panel-…` convention for catalogued tabs without a state, but only a registered state gets the tab into the diff, screenshots and crawl.)

What each check catches, and the one-command release preflight, is in [docs/VALIDATION.md](docs/VALIDATION.md).

## Localization changes require test coverage

When adding or changing runtime localization keys (entries in `vscode-extension/package.nls.json` / `package.nls.zh-cn.json` consumed via the `l10n.t()` helper in `vscode-extension/src/l10n.ts`), add unit tests in `vscode-extension/test/unit/l10n.test.ts` asserting the new keys resolve to their expected English text (and zh-CN translation where one exists). PR review flags localization changes that ship without this coverage.

## File-size ceiling (`max-lines`)

`vscode-extension/eslint.config.mjs` enforces a `max-lines` ceiling (the threshold and severity live in that file) alongside the per-function complexity rules. Small functions alone don't stop a file from becoming unmanageable, so new code should not push any linted file past the ceiling — split instead. Run `cd vscode-extension && pnpm run lint` to see the current offenders; `vscode-extension/src/extension.ts` is by far the largest offender (other large files, such as the usage webview's `main.ts`, may also show up). Ratchet the threshold down as files shrink; don't raise it to accommodate growth.

### Where the `extension.ts` decomposition stands

`docs/adr/EXTENSION-TS-DECOMPOSITION.md` is a **plan**, not a description of the code, and the figures inside it are a snapshot that has since drifted. Its destinations fall into two groups:

- **Already exist** (extraction folds code into them): the shared `src/tokenEstimation.ts` and `src/sessionParser.ts`, and in `vscode-extension/src/` `backend/rollups.ts`, `agentSessionsService.ts`, `cacheManager.ts`, `githubPrService.ts`, `onboarding.ts`, `hookManager.ts`, `extensionPoints.ts`, `viewRegression.ts` and `backend/services/*`.
- **Not created yet** (the new per-panel UI modules and services the ADR proposes, for example `backend/ui/diagnosticsPanel.ts`, `backend/services/worktreeService.ts`, `statusBarPresenter.ts`): check with `ls` before assuming one is there.

`extension.ts` is still one large `CopilotTokenTracker` class. Do not add new feature logic to it: put it in a new or existing module and call it from there. Do not move existing code out opportunistically either; follow the ADR's extraction order and batch sizes: one cluster per PR at most, and a large cluster (such as session parsing) is moved in several small PRs rather than all at once.

## Pre-PR self-review checklist

A reviewer that flags one case of a bug will keep finding the next adjacent
case if the fix addresses only the cited instance instead of the whole class.

Before pushing a fix for review feedback, agents must:

- **Close the whole class, not just the cited instance.** When a review comment flags one case of a bug (one race condition, one edge case, one unguarded call site), explicitly enumerate the full set of cases/call-sites/interleavings/state transitions that issue belongs to (e.g. every `await` point in the same state machine where a concurrent clear/write/reset could interleave), and fix all of them in that same pass — not just the one instance the reviewer pointed at.
- **Batch a full round into one push.** Before pushing, collect and address every currently-open review comment together, then push once for that round. Don't push a commit per individual fix as each comment trickles in — that's what turns a handful of review rounds into a dozen.
