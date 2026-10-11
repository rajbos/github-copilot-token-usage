# Security model: sync-host-views

Lightweight model derived from reading `sync-host-views.js`. Update it in the same PR as
any change that adds or alters a trigger surface (see "Skill security classification" in
the repository `AGENTS.md`).

## What the scripts do and talk to

- `sync-host-views.js` reads five files from the checkout it lives in
  (`vscode-extension/esbuild.js`, the Visual Studio `AIEngineeringFluency.csproj`,
  `jetbrains-plugin/build.gradle.kts`, `desktop/esbuild.js` and `desktop/src/main.ts`;
  the `PATHS` object), lists the file names in
  `vscode-extension/dist/webview`, and compares the view names it extracts with regexes.
- It prints a report (or JSON with `--json`) to stdout and config errors to stderr.
- No network access.
- CI runs it in two workflows, both as an informational step (`|| true`) on
  `pull_request` and `push`, so its input there is the pull request's checkout:
  `.github/workflows/ci.yml`, and `.github/workflows/desktop-build.yml` ("Report host
  view sync"). `desktop/package.json` also exposes it locally as `pnpm run check:views`.

## Credentials used and where they come from

None. No environment variables, tokens or keys are read. Both CI workflows that run it
have `permissions: contents: read`.

## Untrusted inputs parsed

- The text of the five files above and the directory listing of `dist/webview`. In a
  local run this is the operator's own checkout. In `ci.yml` and `desktop-build.yml` it is
  the content of the pull request, including pull requests from forks.
- The files are only matched with regexes (lines 89, 123, 140-156, 173-185). Nothing read from them
  is evaluated, required or used to build a path.

## What it writes and where

Nothing on disk. Output goes to stdout and stderr only, which in CI is the Actions log.

## External programs run

None. The script does not use `child_process`.

## Mitigations in the code

- Every value taken from the parsed files is captured with `[\w-]+` (lines 89, 123, 156, 177, 185),
  so the view names echoed into the report and the CI log contain only word characters and
  hyphens.
- The paths it reads are fixed relative to the script's own location (lines 50-62); no
  argument or parsed value changes them.
- `dist/webview` entries are used as names only; the bundles are never opened.
- A missing or unreadable source file ends the run with exit code 2 and a message
  (lines 73-79, 303-307).

## Known gaps

Recorded, not fixed here.

- In `ci.yml` and `desktop-build.yml` the script itself is taken from the pull request's
  checkout, so a pull request can change the script that runs. Both jobs already build
  and test the pull request's code with read-only permissions, so this adds no access
  beyond what those jobs have.
- The regexes run over pull-request-controlled text with no size or time limit.
- The `ConfigError` message includes the underlying `fs` error text (line 77), which is
  printed to the log.
