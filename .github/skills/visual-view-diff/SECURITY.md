# Security model: visual-view-diff

Lightweight model derived from reading `visual-diff.js`, `render-views.js`,
`diff-screenshots.js` and `lib/*.js`, plus the two other consumers of the view registry
and `lib/`: `scripts/interaction-smoke.js` and `release-video/src/shots.ts`. Update it in
the same PR as any change that adds or alters a trigger surface (see "Skill security
classification" in the repository `AGENTS.md`).

## What the scripts do and talk to

- `visual-diff.js` checks out the merge base into a detached `git worktree`, builds the
  webview bundles there and in the working tree, renders both with `render-views.js`, and
  compares them with `diff-screenshots.js`.
- `render-views.js` builds one HTML page per view (`lib/harness.js`) around a committed
  fixture and the real bundle, loads it from a `file://` URL in headless Chromium through
  Playwright, optionally replays declared click/select/type/post steps (`lib/steps.js`),
  and takes screenshots.
- `diff-screenshots.js` loads two PNGs into a Chromium page and compares pixels.
- The scripts make no network requests themselves. In `render-views.js` and
  `scripts/interaction-smoke.js`, the rendered bundle runs inside Chromium with every
  non-local request and WebSocket refused (`blockNetwork` in `lib/browser.js`).
  `release-video/src/shots.ts` renders the same bundles without that block (see Known
  gaps).

## Credentials used and where they come from

None are read or sent by the scripts. The bundle build (`node esbuild.js` in both
checkouts) is started with a minimal environment allowlist (`BUILD_ENV_ALLOWLIST` in
visual-diff.js: path, system, home/temp, locale, `CI` and `ESBUILD_BINARY_PATH`; names
match exactly, case-insensitively only on Windows). That only controls what the build
process inherits in its own `process.env`: tokens in the operator's shell are not handed
to it by accident. It is not isolation. The build runs as the operator's user, so it can
still recover them, for example by reading the parent's `/proc/<ppid>/environ` on Linux
(the parent `visual-diff.js` holds the full environment) or the user's credential files
(see Known gaps).
`render-views.js` and `diff-screenshots.js` are the skill's own code and inherit the
caller's environment; the bundles they load run in Chromium, which has no access to it.

## Untrusted inputs parsed

- The code under review: `vscode-extension/esbuild.js` and the webview sources from the
  base commit and from the working tree are executed to build the bundles
  (`buildWebviews` in visual-diff.js), and the resulting bundles are
  executed in Chromium: each page is generated with the bundle as its script
  (`renderView` in render-views.js; the `<script src>` tag is in `buildPageHtml` in
  `lib/harness.js`) and loaded with `page.goto` (`renderView`).
- The base commit's `views.config.json` and fixtures, merged into a baseline registry
  (`writeBaselineRegistry` in visual-diff.js). Registry fields drive file paths (`bundle`, `fixture`, `$fromRepoJson`)
  and the UI steps replayed in the page.
- The Playwright module, resolved by `require()` from the repo, the pinned workflow
  install and the global npm root (`lib/browser.js`).
- `--base`, `--out`, `--view`, `--config` and the other CLI arguments. `--base` values
  that are empty or start with `-` are refused, and `--base`, `--out`, `--theme` or
  `--view` given without a value is an error rather than a silent default. `--theme`
  must be exactly `dark`, `light` or `both` (`parseThemes` in `lib/config.js`, in both
  `visual-diff.js` and `render-views.js`), and `buildPageHtml` refuses any theme other
  than `dark` or `light`, since it names a CSS file and every screenshot file name.
  `--concurrency` must be a positive integer, and `diff-screenshots.js` requires
  `--threshold` in 0–1 and `--noise-floor` ≥ 0 (`parseNumberOption`), because `NaN`
  would make every comparison report "unchanged". `--out`, `--dist`, `--repo-root`,
  `--config`, `--baseline` and `--current` are paths the operator chooses and are not
  restricted.

## What it writes and where

- `visual-output/` by default, or `--out`: `baseline/`, `current/`, `diff/` (PNGs,
  `render-report.json`, `report.json`, `report.md`), `timings.md` (phase names
  and durations only) and the temporary `.baseline-registry.json`. Existing
  `baseline/`, `current/`, `diff/`, `timings.md`, `.baseline-registry.json` and
  `.baseline-worktree` under that directory are deleted first, but only when the
  directory is the default `visual-output/` or carries the `.visual-view-diff-output`
  marker a previous run wrote; otherwise the run refuses to start
  (`prepareOutRoot` in visual-diff.js). How that marker is handled:
  - A missing marker is created as a **directory** with a single `mkdirSync`, which
    fails on anything already at the path and never follows a link. There is no
    check-then-write. (`openSync(..., 'wx')` is not used because on Windows `O_EXCL`
    creates the target of a dangling symlink.) A marker the run just created is
    removed again when the directory is refused.
  - An existing marker is only inspected with `lstat`, never written. It is accepted
    when it is a real **directory** (written by this version) or a **regular file**
    (written by an earlier one). Anything else, such as a symlink, including a dangling
    one, is refused, also in the default `visual-output/`.
  - A symlinked output root is refused, including the default one. A symlinked entry in
    the list above is removed as a link, never through it, before anything is written
    to that path.
- A temporary git worktree at `<out>/.baseline-worktree` containing the baseline build
  output; its `vscode-extension/node_modules` is a symlink to the working tree's
  (`buildWebviews` in visual-diff.js). The worktree is removed in a `finally` block.
- `vscode-extension/dist/` of the working tree (esbuild output).
- A `mkdtemp` directory under the OS temp dir for the generated HTML pages, removed when
  rendering ends (`main` in render-views.js).

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
  into screenshot or temp file names (`lib/config.js` `ID_PATTERN`).
- Every registry-derived path is resolved with `resolveInside` (`lib/harness.js`) in all
  three consumers of the registry (`render-views.js`, `scripts/interaction-smoke.js`,
  `release-video/src/shots.ts`): `view.bundle` against the dist directory, `view.fixture`
  against the fixtures directory, and `$fromRepoJson` against the repo root (inside
  `loadFixture`). The registry value is passed as is, so a relative path that stays
  inside its root (for example `sub/../x.json`) is accepted. Absolute paths, paths that
  leave the root lexically (`../`), the root itself, and existing paths whose real path
  (symlinks resolved) is outside the root are refused. The root is not trusted on its
  own either: each caller passes the checkout it belongs to as an anchor (the repo root,
  or the baseline worktree for baseline renders; `anchorFor` in `lib/harness.js`), and a
  root with a symlink anywhere between that anchor and itself (a committed `fixtures/`
  or `dist/` link, say) is refused. The anchor is the only directory trusted as given;
  a `--dist` or `--config` fixture directory outside both checkouts is the operator's
  choice and is its own anchor.
- `fixtureDir` (the fixtures directory for a view) is dropped by `readConfig` when it
  reads the skill's own `views.config.json`, so a committed registry cannot choose it.
  It is kept only for a registry passed explicitly with `--config`, which is how
  `visual-diff.js` hands `render-views.js` the registry `baselineRegistry` generates.
  That function always sets `fixtureDir` itself.
- Chromium pages (render and interaction smoke) route every request through
  `blockNetwork`: only `file:`, `data:` and `blob:` URLs load; http(s) is aborted and
  WebSockets are closed, at the context level so popups are covered too. A Playwright
  too old to route WebSockets fails the render instead of skipping that block.
- The bundle build is started with an allowlisted environment, not the caller's
  (`buildEnv` in visual-diff.js). This prevents accidental inheritance of tokens by the
  reviewed build scripts; it does not stop a build that goes looking for them (see
  Known gaps).
- Embedded JSON has every `<` escaped as `\u003c`, so a payload cannot close the
  script tag (`toScriptJson` and `readJsonConfigGlobals` in `lib/harness.js`).
- The page gets a stub `acquireVsCodeApi` that only records messages in memory; nothing is
  posted anywhere. The harness never launches VS Code and the skill does not upload images.
- Time is frozen and rendering fails loudly on empty roots and page errors, which limits
  silent wrong results (not a security control, but it keeps a blank page from passing).

## Known gaps

Recorded, not fixed here.

- Building still runs the reviewed project's `esbuild.js` and dependency tree as the
  operator's user, with that user's full filesystem and network access. The environment
  allowlist only keeps tokens out of the child's own `process.env`. The build can still
  read the parent's environment (`/proc/<ppid>/environ` on Linux, or another process of
  the same user on any platform) and files such as `~/.npmrc`, `~/.config/gh/hosts.yml`
  or a git credential store, and send what it finds anywhere. Real isolation needs a
  separate user, a container or an equivalent sandbox, which the skill does not provide.
  It is safe only for code the operator already trusts to run locally, and must not be
  pointed at an unreviewed fork without that isolation.
- The network block covers what Playwright routes (HTTP(S) and WebSockets). Channels it
  does not intercept, such as WebRTC, are not blocked. The build step has no network
  restriction at all, and `release-video/src/shots.ts` does not call `blockNetwork`.
- `resolveInside` checks a path's real path and the caller reads it afterwards, so a
  symlink swapped in between the two is not caught. Exploiting that needs a concurrent
  local writer in the checkout.
