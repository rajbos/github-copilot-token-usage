# Security model: sync-host-views

Lightweight model derived from reading `sync-host-views.js`. Update it in the same PR as
any change that adds or alters a trigger surface (see "Skill security classification" in
the repository `AGENTS.md`).

## What the scripts do and talk to

- `sync-host-views.js` reads three files from the checkout it lives in
  (`vscode-extension/esbuild.js`, the Visual Studio `AIEngineeringFluency.csproj` and
  `jetbrains-plugin/build.gradle.kts`, lines 49-57), lists the file names in
  `vscode-extension/dist/webview`, and compares the view names it extracts with regexes.
- It prints a report (or JSON with `--json`) to stdout and config errors to stderr.
- No network access.
- CI runs it: `.github/workflows/ci.yml` calls it on `pull_request` and `push` as an
  informational step (`|| true`), so its input there is the pull request's checkout.

## Credentials used and where they come from

None. No environment variables, tokens or keys are read. The CI workflow that runs it has
`permissions: contents: read`.

## Untrusted inputs parsed

- The text of the three files above and the directory listing of `dist/webview`. In a
  local run this is the operator's own checkout. In `ci.yml` it is the content of the pull
  request, including pull requests from forks.
- The files are only matched with regexes (lines 86, 120, 137-153). Nothing read from them
  is evaluated, required or used to build a path.

## What it writes and where

Nothing on disk. Output goes to stdout and stderr only, which in CI is the Actions log.

## External programs run

None. The script does not use `child_process`.

## Mitigations in the code

- Every value taken from the parsed files is captured with `[\w-]+` (lines 86, 120, 153),
  so the view names echoed into the report and the CI log contain only word characters and
  hyphens.
- The paths it reads are fixed relative to the script's own location (lines 47-57); no
  argument or parsed value changes them.
- `dist/webview` entries are used as names only; the bundles are never opened.
- A missing or unreadable source file ends the run with exit code 2 and a message
  (lines 70-76, 253-257).

## Known gaps

Recorded, not fixed here.

- In `ci.yml` the script itself is taken from the pull request's checkout, so a pull
  request can change the script that runs. That job already builds and tests the pull
  request's code with read-only permissions, so this adds no access beyond what the job
  has.
- The regexes run over pull-request-controlled text with no size or time limit.
- The `ConfigError` message includes the underlying `fs` error text (line 74), which is
  printed to the log.
