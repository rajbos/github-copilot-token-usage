# Security model: visual-view-diff

Lightweight model derived from reading `visual-diff.js`, `render-views.js`,
`diff-screenshots.js` and `lib/*.js`. Update it in the same PR as any change that adds or
alters a trigger surface (see "Skill security classification" in the repository
`AGENTS.md`).

## What the scripts do and talk to

- `visual-diff.js` checks out the merge base into a detached `git worktree`, builds the
  webview bundles there and in the working tree, renders both with `render-views.js`, and
  compares them with `diff-screenshots.js`.
- `render-views.js` builds one HTML page per view (`lib/harness.js`) around a committed
  fixture and the real bundle, loads it from a `file://` URL in headless Chromium through
  Playwright, optionally replays declared click/select/type/post steps (`lib/steps.js`),
  and takes screenshots.
- `diff-screenshots.js` loads two PNGs into a Chromium page and compares pixels.
- The scripts make no network requests themselves. The rendered bundle runs inside Chromium
  with no request blocking (see Known gaps).

## Credentials used and where they come from

None are read or sent by the scripts. Every child process (`node esbuild.js`,
`render-views.js`, `diff-screenshots.js`) inherits the caller's full environment
(`execFileSync` or `spawn` without `env`, visual-diff.js lines 46-48 and 133-135), so whatever tokens the
operator's shell holds are visible to the build scripts under review.

## Untrusted inputs parsed

- The code under review: `vscode-extension/esbuild.js` and the webview sources from the
  base commit and from the working tree are executed to build the bundles
  (`buildWebviews`, visual-diff.js lines 108-126), and the resulting bundles are
  executed in Chromium: each page is generated with the bundle as its script
  (render-views.js lines 126-134; the `<script src>` tag is `lib/harness.js` line
  166) and loaded with `page.goto` (render-views.js line 160).
- The base commit's `views.config.json` and fixtures, merged into a baseline registry
  (visual-diff.js lines 216-251). Registry fields drive file paths (`bundle`, `fixture`, `$fromRepoJson`)
  and the UI steps replayed in the page.
- The Playwright module, resolved by `require()` from the repo, the pinned workflow
  install and the global npm root (`lib/browser.js`).
- `--base`, `--out`, `--view`, `--config` and the other CLI arguments.

## What it writes and where

- `visual-output/` by default, or `--out`: `baseline/`, `current/`, `diff/` (PNGs,
  `render-report.json`, `report.json`, `report.md`), `timings.md` (phase names
  and durations only) and the temporary `.baseline-registry.json`. Existing
  `baseline/`, `current/`, `diff/`, `timings.md` and `.baseline-worktree` under
  that directory are deleted first.
- A temporary git worktree at `<out>/.baseline-worktree` containing the baseline build
  output; its `vscode-extension/node_modules` is a symlink to the working tree's
  (visual-diff.js lines 112-120). The worktree is removed in a `finally` block.
- `vscode-extension/dist/` of the working tree (esbuild output).
- A `mkdtemp` directory under the OS temp dir for the generated HTML pages, removed when
  rendering ends (render-views.js lines 257, 290-293).

## External programs run

- `git`: `rev-parse`, `merge-base`, `rev-list`, `worktree add --detach`, `worktree remove`,
  `worktree prune`.
- `node esbuild.js` in both checkouts, `node render-views.js`, `node diff-screenshots.js`.
- `node npm-cli.js root -g` to locate global Playwright (`lib/browser.js` line 31).
- Chromium via Playwright, launched with default options (no flags that disable the
  sandbox).
All use `execFileSync` or `spawn` with argument arrays and no shell. The two
render processes run concurrently; each is awaited before the worktree is removed.

## Mitigations in the code

- The baseline is built in a detached worktree, so the working tree is never checked out
  over or stashed.
- View and state ids must match a strict allowlist, so ids cannot carry path separators
  into screenshot or temp file names (`lib/config.js` `ID_PATTERN`). The fixture file name
  is reduced with `path.basename` (render-views.js line 114).
- Embedded JSON has every `<` escaped as `\u003c`, so a payload cannot close the
  script tag (`lib/harness.js` lines 74-75 and 83, used by the inline scripts at
  lines 162-164).
- The page gets a stub `acquireVsCodeApi` that only records messages in memory; nothing is
  posted anywhere. The harness never launches VS Code and the skill does not upload images.
- Time is frozen and rendering fails loudly on empty roots and page errors, which limits
  silent wrong results (not a security control, but it keeps a blank page from passing).

## Known gaps

Recorded, not fixed here.

- Building runs the reviewed project's `esbuild.js` and dependency tree with the
  operator's full environment (see Credentials). The skill is safe only for code the
  operator already trusts to run locally; it must not be pointed at an unreviewed fork
  without isolation.
- Chromium has no network restriction (no `page.route` or offline mode in
  render-views.js lines 140-160), so a bundle under review can make outbound requests
  while rendering. The wait uses `networkidle`.
- `$fromRepoJson` is joined onto the repo root with no containment check
  (`lib/harness.js` lines 63-64): a fixture can embed any `.json` file readable on disk,
  for example via `../` segments, into the page and the screenshot.
- `view.bundle` from the registry is joined into a path unvalidated (render-views.js
  line 99), so a registry entry can load any `.js` file as the page's script.
- `--out` is deleted into recursively (visual-diff.js lines 269-276): pointing it at a
  directory that contains subdirectories named `baseline`, `current` or `diff` removes them.
- `--base` is passed to `git merge-base`/`rev-parse` as a bare argument, so a value that
  starts with `-` is read as an option.
