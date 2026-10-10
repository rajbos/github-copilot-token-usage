---
title: Visual View Diff Skill
description: Render the extension's webview panels headlessly and report which ones changed visually, with before/after/diff screenshots
lastUpdated: 2026-08-28
---

# Visual View Diff Skill

A GitHub Copilot Agent Skill that renders the VS Code extension's webview panels
in headless Chromium, screenshots them, and reports which views changed compared
to a baseline commit.

It produces images and a Markdown report. **Publishing them — as a PR comment,
a job summary, an artifact — is a separate concern and deliberately not part of
this skill.** On pull requests that concern is handled by the `ui-checks` job in
`.github/workflows/ci.yml`, which posts the before/after/diff images to the PR
with `gh pr comment --attach` via `.github/workflows/scripts/visual-diff-comment.js`.

## Files in This Directory

- **SKILL.md** — Main skill file with YAML frontmatter and full instructions for the agent
- **README.md** — This file
- **views.config.json** — Registry of the panels to render (bundle name, data global, fixture, per-view options) and the `states` — tabs and modes — each panel is also screenshotted in
- **lib/steps.js** — Replays a state's `click`/`select` steps; shared with `scripts/interaction-smoke.js`
- **visual-diff.js** — End-to-end run: build the baseline commit in a git worktree, build the working tree, render both, compare
- **render-views.js** — Render the configured views to PNGs from a given build
- **diff-screenshots.js** — Compare two screenshot directories and write the report
- **fixtures/** — One JSON payload per view, exactly what `extension.ts` passes it
- **lib/harness.js** — Rebuilds a panel's HTML shell around a fixture so the real bundle renders outside VS Code
- **lib/imageDiff.js** — Per-pixel comparison, run inside Chromium so no image library is needed
- **lib/browser.js** — Locates a Playwright install without adding one as a dependency
- **lib/report.js** — Markdown rendering of the comparison
- **lib/theme-dark.css / lib/theme-light.css** — The `--vscode-*` tokens VS Code would normally inject

## Quick Usage

```bash
# Build the bundles first
cd vscode-extension && npm install && node esbuild.js && cd ..

# Compare the working tree against the merge base with origin/main
node .github/skills/visual-view-diff/visual-diff.js

# Screenshot the current state only, both themes
node .github/skills/visual-view-diff/render-views.js --out visual-output/current --theme both
```

Output goes to `visual-output/` (git-ignored): `baseline/`, `current/`, and
`diff/` with `report.md` and `report.json`.

## How to Invoke via Copilot

Ask Copilot something like:

- "Show me what this change does to the extension's views"
- "Did my CSS refactor change any of the webviews visually?"
- "Take screenshots of the details and chart views"

## Requirements

- Playwright with Chromium (found locally or globally; not a dependency of the extension)
- Built webview bundles in `vscode-extension/dist/webview/`
- `vscode-extension/node_modules` present — the baseline worktree symlinks it instead of installing again

## Notes

- Does **not** launch VS Code or the Extension Development Host, per the
  "Never Launch a Real Editor/IDE Instance" rule in `.github/copilot-instructions.md`.
- Fixtures use fixed timestamps and synthetic values so unchanged code always
  produces identical screenshots.
- The Team Dashboard fixture supplies synthetic Azure rollups and a Team Server
  configuration; both tabs render without contacting a live backend. When a
  previously disabled view gains a fixture, the baseline bundle uses the same
  fixture so its visual diff compares layouts rather than a loader with data.
- See SKILL.md for adding a view, fixture conventions, and known limits.
