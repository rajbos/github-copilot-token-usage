---
name: visual-view-diff
description: Render the VS Code extension's webview panels headlessly and detect which ones changed visually, producing before/after/diff screenshots for review. Use when a change touches webview UI (src/webview/**, view HTML in extension.ts, shared CSS) and you want to see and show what it looks like, or to check that a refactor changed nothing visually.
---

# Visual View Diff Skill

Renders the extension's webview panels **headlessly**, screenshots them, and
reports which views changed compared to a baseline commit.

The screenshots are the deliverable. **Posting them anywhere — a PR comment, a
job summary, an artifact upload — is deliberately not part of this skill.** It
answers exactly one question: *what changed visually, and what does it look
like?* Whoever wants to publish that answer reads `report.md` and the PNGs.

The publisher for pull requests is the `ui-checks` job in
`.github/workflows/ci.yml`: it runs this diff against the PR's merge base and
posts the before/after/diff images as one comment on the PR (replaced on every
push) through `gh pr comment --attach`, rendered by
`.github/workflows/scripts/visual-diff-comment.js`. An agent opening a UI PR
does not have to attach screenshots by hand — it has to make sure the change is
*visible* to this harness (see "States" below) and say in the PR body which
views it expects to change.

## When to use it

- A change touches `vscode-extension/src/webview/**`, the shared webview CSS, or
  a `get*Html` method in `extension.ts`.
- A refactor is supposed to be visually neutral and you want proof.
- You want before/after images of a UI change for a human to look at.

## Why this exists (and why it does not open VS Code)

The repo forbids agents from launching a real editor window — see
"Never Launch a Real Editor/IDE Instance" in `.github/copilot-instructions.md`.
That rules out the Extension Development Host, and with it the existing
`aiEngineeringFluency.runLocalViewRegression` command, which only a human can
run and which checks DOM *metrics* (node counts, text length) rather than
appearance.

This skill covers the gap: it renders the **real webview bundles** outside VS
Code. Every panel's HTML shell in `extension.ts` is the same four ingredients —
a `<div id="root">`, a `window.__INITIAL_<VIEW>__` payload, the shared JSON
config globals, and `<script src="dist/webview/<view>.js">`. The harness
reproduces that shell around a committed fixture and supplies the `--vscode-*`
theme tokens VS Code would normally inject, then lets the real bundle render.

Nothing about the views is re-implemented, which is what makes the screenshots
trustworthy: if rendering code changes, the screenshot changes with it.

## Usage

Everything runs from the repo root. Bundles must be built first
(`cd vscode-extension && npm install && node esbuild.js`).

### Compare against the baseline commit (the usual case)

```bash
node .github/skills/visual-view-diff/visual-diff.js
# or, from vscode-extension/:  npm run visual:diff
```

This builds the webviews at the merge base with `origin/main` in a temporary
`git worktree`, builds the working tree, renders both, and compares. Your
checkout is never touched — no stashing, no branch switching.

Both sides render at the same time, each with `--concurrency` pages open at
once (default 4). Every target still gets its own page and browser context, and
file names and reports are ordered by view, state and theme, not by which page
finished first. The run ends by printing how long each phase took (checkout,
builds, renders, compare) and writes the same table to
`visual-output/timings.md`, which CI appends to the job summary.

```bash
# Compare against something else, or render both themes
node .github/skills/visual-view-diff/visual-diff.js --base origin/main --theme both
node .github/skills/visual-view-diff/visual-diff.js --view details,chart
# Fewer pages at once, e.g. on a small machine or to rule out load-related noise
node .github/skills/visual-view-diff/visual-diff.js --concurrency 1
```

Output lands in `visual-output/` (git-ignored):

```
visual-output/
├── baseline/   <view>.<theme>.png     — before
├── current/    <view>.<theme>.png     — after
├── diff/       <view>.<theme>.diff.png, report.md, report.json
└── timings.md  — how long each phase took
```

A view rendered in one of its declared states (a tab, a mode) is named
`<view>--<state>.<theme>.png`, e.g. `usage--tools.dark.png`.

### Just screenshot the current state

```bash
node .github/skills/visual-view-diff/render-views.js --out visual-output/current --theme both
# or, from vscode-extension/:  npm run visual:render -- --theme both
```

### Compare two directories you already have

```bash
node .github/skills/visual-view-diff/diff-screenshots.js \
  --baseline visual-output/baseline --current visual-output/current --out visual-output/diff
```

## Reading the result

`diff/report.md` is a Markdown summary — a table of every view with its status
(changed / unchanged / added / removed), how many pixels moved, and the image
size. `report.json` is the same data for scripting.

Diff images paint changed pixels magenta over a dimmed copy of the new
screenshot, so a change is easy to locate in context.

**A changed view is not automatically a problem.** Read the diff image and
decide: intended restyle, or accidental regression? The tool reports; you judge.

## Requirements

- **Playwright with Chromium.** Intentionally *not* a dependency of the
  extension — this is developer/CI tooling, not shipped code. `lib/browser.js`
  finds a local or global install, or the pinned one CI uses under
  `.github/workflows/dependencies/playwright`; if none exists:
  `npm install -g playwright && npx playwright install chromium`. The Copilot
  coding agent gets that pinned install from `copilot-setup-steps.yml`, and
  Claude Code's cloud environment ships a global Playwright, so in both an
  agent can run this skill as-is.
- **Built webview bundles** in `vscode-extension/dist/webview/`.
- **`vscode-extension/node_modules`** — the baseline worktree symlinks it rather
  than running a second `npm install`.

## Fixtures

Each view renders from a committed JSON fixture in `fixtures/`, holding exactly
the payload `extension.ts` passes to that view. Fixtures use fixed timestamps
and synthetic numbers so two runs of the same code produce byte-identical
screenshots — a `Date.now()` anywhere would make every view diff against itself.

A fixture can reference a repo data file instead of copying it:

```json
{ "categories": { "$fromRepoJson": "src/fluencyLevelData.json" } }
```

That keeps the fixture small and means editing the source file shows up as the
visual change it really is.

### Adding a view

1. Find the view's HTML shell in `extension.ts` (`get<Name>Html`) and note the
   `window.__INITIAL_*__` global it assigns.
2. Add an entry to `views.config.json` — `id`, `bundle` (its esbuild entry point
   name in `esbuild.js`), `global`, and `fixture`.
3. Write `fixtures/<id>.json` with that payload.
4. Check it renders: `node render-views.js --view <id> --out /tmp/check`.

A view whose `#root` comes out empty is reported as an **error**, not silently
screenshotted blank — a fixture missing a required field would otherwise pass as
"no visual change" forever.

`dashboard` is enabled with synthetic Azure rollups and an additional
`__DASHBOARD_CONFIG__` global declared in the registry's `globals` field. Both
backend tabs render without contacting a live backend. The in-editor regression
runner still skips it because that runner needs a configured live backend. When
enabling a previously disabled view, the visual baseline uses the new fixture
on both bundles to compare layouts rather than a loading screen against data.

### States — tabs and modes

A view is screenshotted in its **initial render** and in every **state** it
declares. This matters more than it sounds: the usage panel opens on "My
Activity", so a whole new section added to its Tools tab once diffed as
"20 unchanged" — the harness never looked at that tab. A state is a few
click/select steps replayed on a fresh page before the screenshot:

```json
{
  "id": "tools",
  "title": "Tools & Integrations tab",
  "steps": [{ "click": ".tab-button[data-tab=\"tools\"]" }],
  "expect": "#tab-panel-tools"
}
```

- `steps` use the same `click` / `select` (+ optional `value`) vocabulary as
  interaction-smoke scenarios, plus `post`: a message delivered to the view as
  if the extension host sent it. A tab that asks the host for data when it
  opens (Repository PRs, Cloud Agent) would otherwise only ever screenshot its
  loading placeholder, so its state declares the answer. Keep that answer
  deterministic — fixed dates, no `fetchedAt` — or the screenshot diffs
  against itself.
- `expect` (required) is what the state must be showing afterwards. If it is
  not, the render is an **error**, not a screenshot of the previous tab that
  would pass as "unchanged" forever; a state without it is refused when the
  registry loads.
- `settleMs` overrides the wait after the steps for a tab that lazily loads a
  chart library and animates in (the efficiency Models tab needs ~3s).
- `noiseFloorPixels` gives a canvas-drawing state its own tolerance, so the
  view's DOM-rendered initial state can stay compared exactly.

**Adding a tab to a view means adding a state for it here**, or the visual
diff will never see what you built. Reach a nested tab by clicking its group
first (the diagnostics Research and Settings groups do this).

The baseline is rendered from the **base commit's own** `views.config.json`
— its definitions, steps, fixtures and bundles — plus every view and state
only the current registry declares. So a state (or a whole view) this branch
introduced is attempted on the old bundle and, where it cannot render there,
skipped by `--allow-missing` and reported as **added**; a state or view this
branch removed or renamed still renders on the baseline side and is reported
as **removed**, rather than vanishing from both sides as "no change"; and a
state whose selector or fixture this branch changed is still driven the old
way on the old bundle, so the comparison shows the real before and after.
`--allow-missing` skips only those current-only targets: a view both sides
declare that fails on the base bundle is an error, never a silent "added".
The current-tree render stays strict too. View and state ids are file names,
so the registry refuses anything but letters, digits, `_` and single dashes,
and duplicates.

## Determinism

Two runs of unchanged code produce identical screenshots. That is load-bearing —
without it every run reports spurious changes. It is achieved by pinning the
locale to `en-US` and the timezone to UTC, freezing the page clock
(`FROZEN_NOW` in `render-views.js`, the fixtures' shared "today"), disabling
CSS animations and transitions, hiding carets, waiting for fonts to settle,
and keeping all time-dependent values out of the fixtures.

The frozen clock matters because views read `new Date()` themselves: the
chart draws a projected bar for the rest of the current period sized by the
minute of the day, so an unfrozen clock made the chart diff against itself
whenever the baseline and current renders straddled a minute boundary. The
constant lives in the harness rather than the registry because the baseline
render uses the base commit's registry, and both sides must see the same time.

The viewport is grown to the page's full height *before* the screenshot rather
than letting the full-page capture do it: that capture-time resize made every
responsive `<canvas>` (Chart.js) redraw mid-capture, and the efficiency Models
tab diffed against itself by 2.6% on every other run.

The views that draw to a `<canvas>` (`chart`, `maturity`, the efficiency chart
tabs) can still differ by a handful of anti-aliased pixels, so they carry a
small `noiseFloorPixels` tolerance in `views.config.json`. Every other view is
compared **exactly** — a global tolerance would hide small real changes, such
as a restyled badge that moves fewer than 200 pixels.

## Limits

- **Not a substitute for looking at the real extension.** The harness supplies
  VS Code's theme tokens from `lib/theme-dark.css` / `lib/theme-light.css`,
  which track Dark Modern and Light Modern. A user's custom theme, high-contrast
  mode, or a token these files do not define will look different in practice.
  When a webview starts using a new `--vscode-*` token, add it to both files.
- **Fixtures are hand-authored**, so they can drift from the real payload shape.
  Drift shows up as a render error or a visibly wrong view, not as a silent pass.
- **Only declared states are covered** — each view is screenshotted in its
  initial render plus the tabs and modes listed under `states` in
  `views.config.json`. Hover, transient dialogs and click sequences beyond
  those are out of scope.
