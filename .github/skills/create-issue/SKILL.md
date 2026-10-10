---
name: create-issue
description: Create a well-scoped GitHub issue in this repo. Gathers what to implement and where from the user (asking about gaps), maps the change to concrete places in the codebase, lists tests to update, and checks for cross-surface gaps (VS Code extension vs. shared src/ vs. CLI/npm package vs. other hosts) before filing. Use whenever the user asks to create, file, write up or log an issue, feature request, bug or tech-debt item for this repository.
---

# Create Issue Skill

This skill is guidance only (no scripts). It describes how issues in this repo must be prepared before they are filed, so that whoever picks the issue up (a person or a coding agent) can start without re-doing the research.

## When to Use This Skill

Use it whenever you are asked to create, file or write up an issue for this repository — features, bugs, improvements, tech debt. Do **not** file an issue from a one-line request without going through the steps below.

## Step 1 — Understand what and where

Get the following from the user. Take what they already said; do not re-ask for it.

- **What** should be implemented, fixed or changed, and **why** (the problem or the value).
- **Where** it shows up: which surface(s) — VS Code extension, CLI, Visual Studio, JetBrains, desktop app, sharing-server, copilot-app canvas, docs/scripts — and which view/tab/command if it is UI.
- For bugs: steps to reproduce, expected vs. actual, versions/editor involved.

If any of this is unclear, ambiguous or you detect a gap (e.g. the request names a view but not what data it should show, or it is unclear whether other surfaces should get it too), **ask the user before continuing**. Ask concise, specific questions; batch them in one message. Prefer a recommendation ("I assume X, correct?") over open-ended questions. If the user cannot answer, record the open question in the issue instead of guessing.

## Step 2 — Investigate the codebase

Before writing anything, look at the code. Do not describe changes from memory.

- Start from `AGENTS.md` (repo structure, sub-project instructions) and the matching `.github/instructions/*.instructions.md`.
- If `.graphify-agent/graph.json` exists, query it for structural questions (callers, blast radius), e.g. `GRAPHIFY_OUT=.graphify-agent graphify query "<question>"` (or pass `--graph .graphify-agent/graph.json`). Do not use the committed `graphify-out/` directory; if the graph is missing, search with grep/glob.
- Check `docs/` (especially `docs/features/`, `docs/adr/`, `docs/FLUENCY-METRICS-SCHEMA.md`, `docs/TRACKABLE-DATA.md`) for existing design decisions that apply.
- Search existing open and recently closed issues/PRs (`gh issue list --state all --search "<keywords>"`, `gh pr list --state all --search "<keywords>"`) to avoid duplicates; link related ones instead of duplicating.

## Step 3 — Define the implementation

In the issue, list the **places in the codebase that need to change, and how**. Be concrete: file paths (and function/class names where useful), and one or two sentences per place on what changes there. Respect the repo's architecture:

- Session parsing, token estimation and cost attribution live in the shared `src/` modules; the CLI and VS Code extension consume them. Logic must **not** be reimplemented per surface (see "CLI Must Reuse Shared Functions" in `AGENTS.md`).
- Webview changes must be registered/validated per `AGENTS.md` (`views.config.json`, a `state` for new tabs, `check:contract`, `check:interaction`, `visual:diff`).
- New user-facing strings need localization keys and `l10n.test.ts` coverage.
- Changes to sharing-server must follow `sharing-server/AGENTS.md` (data separation contract).
- Changes to agents or skills under `.github/` need the mirrored change under `.claude/` (and vice versa).

State the approach you recommend; if there are real alternatives with different trade-offs, name them briefly.

## Step 4 — Tests

List the tests that must be added or updated: the existing test files that cover the touched code (find them, give paths) and new cases needed (edge cases, regressions, empty/missing data). Name the validation commands from the relevant instructions file (e.g. `npm run test:node`, `npm run check:contract`, `npm run check:interaction`, `dotnet test`, `./gradlew test`). If a UI changes, note that before/after screenshots are expected.

## Step 5 — Check for cross-surface gaps

This is the step that is most often skipped. Actively look for **gaps the change would surface**, by following the data from where it is produced to every place it is consumed.

The canonical example: a field is added to a view in the VS Code extension, but the data behind it is not available in the shared `src/` modules / the CLI / the npm package (`@rajbos/ai-engineering-fluency`), so the other extension surfaces (CLI, Visual Studio, JetBrains, desktop, sharing-server, copilot-app) cannot show it and end up with empty or partial views.

Check, and record the result of each in the issue (even "not affected"):

- **Data availability**: is every new piece of data computed in shared code and exposed through the CLI/npm package output, or only inside `vscode-extension/`? Does it need adding to the JSON/export schema and its docs?
- **Other surfaces**: does each host that renders this view (Visual Studio, JetBrains via `sync-host-views`, desktop, sharing-server dashboard, copilot-app canvas) receive the new data, or will it show empty sections? Is a follow-up issue needed for those hosts?
- **Editors/adapters**: does it work for every supported session source (Copilot Chat, Copilot CLI, Claude Code, JetBrains, etc.), or only the one the user tested with? What does the view show when the data is absent?
- **Upload/sharing path**: if data is uploaded or shared, does the sharing-server schema, API and privacy contract need to change?
- **Docs & catalog**: CHANGELOG, `docs/`, the What's New catalog, `package.nls*.json`, README screenshots.
- **Compatibility**: stored/cached data and older CLI/extension versions reading new data (or vice versa).

If a gap is out of scope for this issue, say so explicitly and propose a separate follow-up issue (create it only with the user's agreement).

## Step 6 — Create the issue

Compose the issue and show the user the draft (title + body) **before filing**, unless they already told you to just create it. Then file it with `gh issue create`.

- **Template/title/labels**: this repo has issue templates in `.github/ISSUE_TEMPLATE/` (VS Code, CLI, Visual Studio). Use the one that matches the primary surface for the title prefix (e.g. `[FEATURE][vscode] `, `[BUG][cli] `) and labels; for other surfaces, use a similar prefix and only labels that exist (`gh label list`). Do not invent labels.
- Pass the body via `--body-file` (write it to a scratch file) to avoid shell quoting problems.

Suggested body structure:

```markdown
## Summary
What and why, in 2–4 sentences.

## Current behaviour / problem
(bugs: repro steps, expected vs. actual)

## Proposed change
Where and how, per surface/file:
- `path/to/file.ts` — what changes
- ...

## Tests
- Update: `path/to/existing.test.ts` — what to add/adjust
- New: ...
- Validation: commands to run

## Cross-surface impact / gaps
- Data availability (shared `src/`, CLI, npm package): ...
- Other surfaces (VS Code, CLI, Visual Studio, JetBrains, desktop, sharing-server, copilot-app): ...
- Docs / changelog / What's New / localization: ...

## Open questions
Anything the user could not answer yet.

## Related
Links to related issues/PRs/docs.
```

Keep it factual and scoped; do not pad sections that do not apply (write "n/a" with a short reason instead). After filing, give the user the issue URL and a short list of any follow-up issues you recommend.

## Rules

- Never file before Steps 1–5 are done; never fabricate file paths, test names or labels — verify they exist.
- Never include secrets, personal data or real session content in an issue.
- Do not start implementing the issue unless the user asks.
