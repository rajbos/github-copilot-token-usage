# AI Engineering Fluency canvas

GitHub Copilot app canvas that shows the output of the
[`@rajbos/ai-engineering-fluency`](https://github.com/rajbos/ai-engineering-fluency) CLI. The look and feel mirrors
the extension's VS Code webviews (section cards, stats tables, chart colours, stage colours, radar chart), mapped onto
the Copilot app's theme tokens so it follows the app's light/dark theme. The canvas is listed as
**AI Engineering Fluency** (canvas id `ai-fluency`), and its footer links back to this repository.

It ships as the `ai-fluency-canvas` Copilot plugin (this folder is the plugin's
`com.github.copilot/extensions/ai-fluency/`), and can also be installed by hand as a user-level extension in
`$COPILOT_HOME/extensions/ai-fluency/`. Install instructions:
[docs/copilot-app/README.md](../../../../docs/copilot-app/README.md).

- **Details** — the extension's stats table (tokens, cost, activity, environment) for today / last 30 days /
  current month / previous month / projected year, and usage by editor and model. On narrow panels a period
  picker shows one column at a time (including the projected year). Each row's label is a table row header, so
  screen readers announce what a number measures, and the cost explanations open from a focusable ℹ️ button
  (keyboard and touch included) instead of a hover-only tooltip.
- **Chart** — the extension's Chart view: summary cards (with a collapsible per-editor breakdown) and a bar/line
  chart aggregated by day / week / month, with a rolling average, the metric (tokens / cost / sessions) and the
  split (total / by model / by editor / by provider; a by-repository split appears only once the CLI sends
  repository datasets, which it does not yet). The current period gets a projected bar, the
  legend hides series on click, and the tooltip works with pointer or arrow keys. It is drawn as plain SVG (no
  Chart.js or other dependency) using the extension's colours; splits keep the 8 largest series and fold the rest
  into "Other". Options the CLI has no data for (for example cost by model) are disabled. The CLI prices the cost
  Total at Copilot AI Credit rates but the editor/provider cost splits at each tool's own rates, so the canvas shows a
  note when a cost split is selected.
- **Sessions** — every session from the last 30 days across all tracked tools, filterable by
  today / 7 days / 30 days (calendar days from local midnight, the same windows the CLI uses), searchable, sortable
  by recency, tokens or cost. Typing in the search box only updates the results around it, so the caret and input
  method (IME) composition are never disturbed.
- **Fluency Score** — overall stage banner, spider (radar) chart of the six categories with the stage reference,
  and per-category cards with a stage badge, progress bar, evidence and next-step tips.

## How it works

- `cli.mjs` runs `ai-engineering-fluency all --json` (global install preferred, falls back to
  `npx -y @rajbos/ai-engineering-fluency@latest` when it is missing — but not when its `--version` check times out,
  since that process may still be running). A full run parses every local session log and takes
  several minutes, so it always runs in the background.
- `store.mjs` trims the ~700 KB payload into `$COPILOT_HOME/extensions/ai-fluency/artifacts/snapshot.json`
  (~250 KB; `COPILOT_HOME` defaults to `~/.copilot`). That path is the same for plugin and manual installs, so the
  cached snapshot survives plugin updates and reinstalls. On POSIX the folder is kept `0700` and the snapshot
  `0600` (it contains session titles), written through a uniquely named temp file. Every read and write checks this
  first and fails closed: a folder or snapshot that can't be made private is neither shown, summarized nor written to.
  On Windows the folder keeps the ACLs it inherits from `COPILOT_HOME` (by default the user profile); they are not
  rewritten, since `COPILOT_HOME` holds Copilot's own full session logs and has to be private anyway. Sessions are
  taken from the CLI's last-30-days, last-7-days and today lists only, so nothing outside the Sessions tab's scope is
  stored. The snapshot includes the day / week / month
  chart datasets (top 8 series per split plus "Other"). Session titles are
  derived from small metadata files next to each session (Copilot CLI `workspace.yaml`, VS Code
  `workspace.json`, Claude worktree folder names) — transcripts are never read by the canvas.
- `refresher.mjs` shows the last snapshot instantly, refreshes on open when it is older than 5 minutes,
  and auto-refreshes every 30 minutes while a panel is open. With no panel open, `get_summary` reads the snapshot
  file again on every call, so it never serves a copy another session has replaced (or that was deleted). Lock files
  ensure only one CLI run at a time across all Copilot sessions; other sessions pick up the new snapshot via a file
  watcher, which ignores snapshots older than the one it already has. If the other session's lock ends (released,
  or its process gone) without a snapshot newer than the one on hand when the wait began, that refresh is reported
  as failed rather than as a success with the old data. Each run takes the next lock *generation*,
  `refresh.lock.<n>`, published atomically (hard link) with a per-run token, and the highest generation is the
  current lock. A session may only create generation n+1 once generation n is finished (a `refresh.lock.<n>.done`
  marker carrying its token), stale (dead process or past the timeout), or absent. Creating the file is exclusive, so
  exactly one session wins each generation, and the current lock is never deleted — only lower generations are
  cleaned up — so a takeover and a late release can never remove someone else's lock. An unreadable lock is treated
  as held for a few seconds (it may still be being written). A `refresh.lock` from older versions is respected
  while it is live and never removed — as a best effort only, since an older version doesn't know about
  generations, so don't run a manual copy next to the plugin.
  On timeout the CLI's whole process tree is stopped (`taskkill /T` on Windows, the process group on macOS/Linux),
  and the lock is left to expire instead of being released, so a CLI that is still exiting cannot overlap the next
  run. On shutdown the refresher stops the running CLI, waits briefly for it to exit, and releases the lock (or, if
  it has not exited by then, leaves the lock to expire). If the `.done` marker can't be written, the refresh reports
  that as an error: the lock then stays until it expires, and this session doesn't mistake it for another session's run.
- `canvas.mjs` registers the canvas and its agent actions and wires up shutdown; `extension.mjs` only passes it the
  Copilot SDK, so the registration is unit-tested with a stub SDK.
- `panels.mjs` tracks open panels so that concurrent opens and closes start and stop the refresher exactly once each.
- `server.mjs` serves the UI on `127.0.0.1` under a random, per-panel URL path (other local processes cannot
  guess it), with a same-origin-only CSP (inline *styles* are allowed because the Copilot app injects its theme
  as inline `<style>` elements; scripts stay `'self'`), Host-header check, Origin check on `POST api/refresh`,
  `Referrer-Policy: no-referrer`, and pushes state over server-sent events (`events`).
- Dark mode: `app.js` reads the app's `data-theme-tone` / `data-color-mode` attributes (falling back to the
  luminance of `--background-color-default`, then `prefers-color-scheme`) and sets `data-fluency-theme` on the
  root. A `MutationObserver` keeps it in sync when the app theme changes; dark fallback colours cover any token
  the app does not provide.

## Agent actions

| Action        | What it does                                                                 |
|---------------|------------------------------------------------------------------------------|
| `get_summary` | Returns cached stats (periods, top models, editors, fluency tips). Session titles and project names are only included with `{ "topSessions": 1-25 }` (top sessions of the last 7 days). The result is sent to the model like any tool result. Never runs the CLI. |
| `refresh`     | Starts a background refresh and returns once it has begun: `started: true` when it runs in this session, `started: false` with `status.byOtherSession` when another Copilot session is already refreshing (its snapshot is used here). Fails at once when it can't start (for example, a stats folder that isn't private). Pass `{ "wait": true }` to block until it finishes (if another Copilot session is already refreshing, it waits for that run's snapshot instead, and fails if that run ends without one). |

Example: `open_canvas({ canvasId: "ai-fluency", instanceId: "fluency" })`, then
`invoke_canvas_action({ instanceId: "fluency", actionName: "get_summary" })`.

## Development

```powershell
# from the repository root: canvas + plugin manifest tests (synthetic fixtures only)
node --test "copilot-app/**/*.test.mjs"
```

`copilot-extension.json` is only used by the Copilot app's "Install extension" flow (gist or repo folder); the
plugin install ignores it. After editing a manually installed copy, reload extensions in the Copilot app and re-open
the canvas. See [copilot-app/README.md](../../../README.md) for the plugin layout and versioning.
