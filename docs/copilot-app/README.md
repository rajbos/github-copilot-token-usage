# AI Engineering Fluency — GitHub Copilot app canvas

![AI Engineering Fluency](https://raw.githubusercontent.com/rajbos/ai-engineering-fluency/main/assets/AI%20Engineering%20Fluency%20-%20Transparent.png)

A canvas for the [GitHub Copilot app](https://docs.github.com/en/copilot/how-tos/github-copilot-app) that shows your
AI Engineering Fluency stats — token usage, estimated cost, recent sessions, usage charts and your fluency score —
in a side panel next to your sessions. It is shipped as the **`ai-fluency-canvas`** Copilot plugin from the
**`ai-engineering-fluency`** plugin marketplace in this repository.

**Contents:** [What you get](#what-you-get) · [Requirements](#requirements) ·
[Install in the Copilot app](#install--one-click-copilot-app) · [Install with the Copilot CLI](#install--copilot-cli) ·
[Open the canvas](#open-the-canvas) · [Update, disable, uninstall](#update-disable-uninstall) ·
[Migrating from a manual copy](#migrating-from-a-manually-installed-copy) · [Manual install](#manual-install-alternative) ·
[Where your data lives](#where-your-data-lives) · [Troubleshooting](#troubleshooting) · [Versioning](#versioning-and-releases)

## What you get

The canvas runs the [AI Engineering Fluency CLI](../cli/README.md) (`ai-engineering-fluency all --json`) over the
session logs on your machine and renders the result with the same look as the VS Code extension. It follows the
Copilot app's light/dark theme, and its footer links back to the
[rajbos/ai-engineering-fluency](https://github.com/rajbos/ai-engineering-fluency) repository.

![AI Engineering Fluency canvas showing the Fluency Score tab with the stage, the six-category spider chart and the stage reference](../images/copilot-app-canvas-fluency-score.png)

| Tab | What it shows |
|---|---|
| **Details** | Tokens, estimated cost, activity and environmental impact for today, the last 30 days, this month, last month and a projected year, plus usage by editor and by model. On narrow panels a picker shows one of those columns at a time. Select the ℹ️ button next to a cost row to see what that estimate means. |
| **Chart** | Usage per day, week or month as tokens, cost or sessions — as a total or split by model, editor or provider — with a rolling average and a projected bar for the current period. |
| **Sessions** | Every session of the last 30 days across all tracked tools; filter by today / 7 days / 30 days (calendar days, like the CLI), search, and sort by recency, tokens or cost. |
| **Fluency Score** | Your overall stage, a radar chart of the six fluency categories, and per-category evidence and next-step tips. See [FLUENCY-LEVELS.md](../FLUENCY-LEVELS.md). |

The agent can use it too: ask things like *"how many tokens did I use this month?"* and it reads the cached numbers
through the canvas's `get_summary` action (which never re-runs the CLI), or triggers a `refresh`.

In the cost chart, the **Total** prices all usage at GitHub Copilot AI Credit (UBB) rates, while the **By Editor** and
**By Provider** splits price non-Copilot tools at their providers' API list prices — so split bars can add up to a
different amount than the Total. The canvas shows a note when you pick a cost split.

**Privacy.** The canvas itself sends nothing anywhere:

- The CLI reads the session log files that your AI tools already write to disk. Session titles come from small
  metadata files next to each session; the canvas never reads transcripts itself.
- The trimmed snapshot is stored in your own Copilot config folder (see [Where your data lives](#where-your-data-lives)),
  readable only by your user account on macOS and Linux; on Windows it has the same permissions as that folder.
- The UI is served from `127.0.0.1` only, under a random URL path that is different for every panel (so other
  programs on your machine cannot guess it), with a strict same-origin Content Security Policy.
- The canvas uploads nothing. Its only network access is downloading the CLI package from npm when it is not
  installed globally.
- **What the agent sees:** when the agent calls `get_summary`, the result becomes part of the conversation and is sent
  to the model, like any other tool result. By default that is aggregate numbers only (tokens, cost, sessions, model
  and editor names, fluency stages and tips). Session titles — often your first prompt — and project names are only
  included when the agent asks for them with `topSessions`, which the bundled skill tells it to do only when you ask
  about specific sessions.

## Requirements

- The **GitHub Copilot app** (to see the canvas). The Copilot CLI can install and manage the plugin; the app and the
  CLI share the same `~/.copilot` configuration.
- **Node.js 22 or newer** on your `PATH` — the canvas runs the CLI with `npx`, so nothing else has to be installed.
- Optional, for faster refreshes: install the CLI globally so the canvas does not go through `npx` on every run.

  ```bash
  npm install -g @rajbos/ai-engineering-fluency
  ```

## Install — one-click (Copilot app)

Click the two buttons in order. Each one opens the Copilot app on a **pre-filled form**; nothing is added or
installed until you confirm it in the app.

1. **Add the marketplace** (once):

   [![Step 1: Add marketplace](https://img.shields.io/badge/Step%201-Add%20marketplace-8957e5?logo=githubcopilot&logoColor=white)](https://github.com/copilot/app/launch?open=ghapp%3A%2F%2Fplugins%2Fmarketplace%2Fadd%3Fsource%3Drajbos%252Fai-engineering-fluency)

   This opens `ghapp://plugins/marketplace/add?source=rajbos%2Fai-engineering-fluency`.

2. **Install the plugin**:

   [![Step 2: Install plugin](https://img.shields.io/badge/Step%202-Install%20plugin-8957e5?logo=githubcopilot&logoColor=white)](https://github.com/copilot/app/launch?open=ghapp%3A%2F%2Fplugins%2Finstall%3Fsource%3Dai-fluency-canvas%2540ai-engineering-fluency)

   This opens `ghapp://plugins/install?source=ai-fluency-canvas%40ai-engineering-fluency`.

If the buttons do not open the app, add the marketplace `rajbos/ai-engineering-fluency` and install
`ai-fluency-canvas@ai-engineering-fluency` by hand under **Customize → Plugins** in the app, or use the CLI below.
The links follow GitHub's [deep link format](https://docs.github.com/en/copilot/how-tos/github-copilot-app/open-with-deep-links).

## Install — Copilot CLI

```bash
# Register the marketplace, then install the plugin from it
copilot plugin marketplace add rajbos/ai-engineering-fluency
copilot plugin install ai-fluency-canvas@ai-engineering-fluency
```

Or install straight from the repository folder, without registering the marketplace:

```bash
copilot plugin install rajbos/ai-engineering-fluency:copilot-app
```

The CLI warns that direct installs (repositories, URLs, local paths) are deprecated in favor of `plugin@marketplace`
installs, so prefer the marketplace commands above.

The Copilot app and the Copilot CLI share the same configuration folder (`~/.copilot`), so a plugin installed with
the CLI shows up in the app. Start a new session (or restart the app) afterwards so the canvas gets loaded.

## Open the canvas

Ask the agent in any Copilot app session, for example:

> open the AI Engineering Fluency canvas

The canvas is listed as **AI Engineering Fluency**; its id is `ai-fluency`. The plugin also ships a small
`ai-fluency` skill so the agent knows when to open it and how to use its actions:

| Action | What it does |
|---|---|
| `get_summary` | Returns the cached stats (periods, top models, editors, fluency tips). Pass `{ "topSessions": 1-25 }` to also get the top sessions of the last 7 days with their titles and project names. Never runs the CLI. |
| `refresh` | Re-runs the CLI in the background and replies once the run has begun — or, if another session is already refreshing, that this canvas will use that run's result. It fails straight away when a refresh can't start. Pass `{ "wait": true }` to wait for it to finish. If another session is already refreshing, it waits for that run instead of starting a second one, and reports a failure if that run ends without new stats. |

**The first run takes a while.** With no snapshot yet, the CLI parses all of your local session logs, which can take
several minutes. After that the last snapshot shows instantly, refreshes when you open the canvas and it is older
than 5 minutes, and refreshes every 30 minutes while a canvas is open. Only one CLI run happens at a time, even with
the canvas open in several sessions.

## Update, disable, uninstall

```bash
copilot plugin marketplace update            # fetch the latest catalog
copilot plugin update ai-fluency-canvas      # install the newer version

copilot plugin disable ai-fluency-canvas     # keep it installed but stop loading it
copilot plugin enable ai-fluency-canvas
copilot plugin uninstall ai-fluency-canvas   # remove it
```

The app also offers **Update**, **Disable** and **Uninstall** under **Customize → Plugins**. Your cached snapshot
is not part of the plugin, so it survives updates and reinstalls.

## Migrating from a manually installed copy

If you installed the canvas by hand before, you have `~/.copilot/extensions/ai-fluency/extension.mjs`. Remove that
folder's **code** before or after installing the plugin — otherwise two providers declare the same `ai-fluency`
canvas. Keep the `artifacts/` subfolder: it holds your cached snapshot, which the plugin uses as well.

PowerShell:

```powershell
$ext = Join-Path $HOME ".copilot\extensions\ai-fluency"
Get-ChildItem $ext -Exclude artifacts | Remove-Item -Recurse -Force
```

macOS / Linux:

```bash
cd ~/.copilot/extensions/ai-fluency && find . -mindepth 1 -maxdepth 1 ! -name artifacts -exec rm -rf {} +
```

(If you set `COPILOT_HOME`, use that folder instead of `~/.copilot`.) Then start a new session or restart the app.

## Manual install (alternative)

Prefer not to use plugins? The canvas is a regular user-level extension, so you can install it by hand:

- **Copy the folder**: copy
  [`copilot-app/com.github.copilot/extensions/ai-fluency/`](../../copilot-app/com.github.copilot/extensions/ai-fluency)
  to `~/.copilot/extensions/ai-fluency/`, then restart the app or start a new session.
- **"Install extension" in the app**: use the app's install-extension flow (or ask the agent to install an extension)
  with this repository folder URL:

  ```text
  https://github.com/rajbos/ai-engineering-fluency/tree/main/copilot-app/com.github.copilot/extensions/ai-fluency
  ```

  The folder contains the `copilot-extension.json` manifest that flow looks for.

A manual copy does not update itself; the plugin install is the recommended route. Don't run both at the same time
(see [Migrating](#migrating-from-a-manually-installed-copy)).

## Where your data lives

| What | Where |
|---|---|
| Plugin code | Managed by Copilot under `~/.copilot/installed-plugins/` — don't edit it there. |
| Cached snapshot | `$COPILOT_HOME/extensions/ai-fluency/artifacts/snapshot.json` (`COPILOT_HOME` defaults to `~/.copilot`). On macOS and Linux the `artifacts/` folder is owner-only (`0700`) and the snapshot `0600`, because it contains session titles; the canvas also tightens folders written by older versions. If it can't (for example, the folder belongs to another user), the canvas refuses to read or write it and shows an error instead. On Windows the folder inherits the permissions of `COPILOT_HOME`: by default that is inside your user profile, which only you, administrators and the system can read. If you point `COPILOT_HOME` at a shared folder, restrict it to your account yourself — Copilot keeps your full session logs there too. |
| Refresh locks | `refresh.lock.<n>` files (plus a `.done` marker once a run finishes) in the same folder. Only the newest one is kept; older ones are cleaned up by the next run. |

Delete the `artifacts/` folder to reset the canvas; the next open runs a full refresh again.

## Troubleshooting

| Problem | What to try |
|---|---|
| The canvas is not listed / the agent can't open it | Run `copilot plugin list` and check `ai-fluency-canvas` is installed and enabled. Start a new session or restart the app so plugins are loaded again. You can also ask the agent to list the loaded extensions and show the `ai-fluency` extension log. |
| The agent asks which `ai-fluency` provider to use | Both the plugin and a manual copy are installed — see [Migrating](#migrating-from-a-manually-installed-copy). |
| The canvas stays on "refreshing" for minutes | Expected on the first run: every local session log is parsed. Install the CLI globally (`npm install -g @rajbos/ai-engineering-fluency`) to skip the `npx` download on each run. A run is stopped after 20 minutes, including any `npx`/`node` processes it started; the next refresh then waits a couple of minutes so a run that is still exiting can't overlap it. |
| Refresh fails with an `npx`/`node` error | Install Node.js 22+ and make sure `node` and `npx` are on the `PATH` the Copilot app sees (restart the app after installing). Behind a proxy, `npx` needs access to the npm registry, or install the CLI globally. |
| "Another Copilot session's refresh ended without new stats" | A different session was already running the CLI, and its run failed or was stopped (for example, that session was closed) before it wrote a snapshot. The last snapshot stays on screen; use **Refresh** to run it again from this session. |
| "The stats folder can't be made private to your user account" | macOS/Linux only: the `artifacts/` folder (or the `snapshot.json` in it) belongs to another user or can't be set to owner-only, so the canvas won't show or store session data there. Make it yours (`chown`) with mode `700`, or delete the folder; the canvas picks it up again on its own once it is private. |
| "`ai-engineering-fluency --version` timed out" | The global install did not answer within 30 seconds. The canvas does not fall back to `npx` then, because the stuck process might still be running next to it; like any timed-out run, it holds off the next refresh until that run's lock expires (about 20 minutes). Check that `ai-engineering-fluency --version` works in a terminal, or uninstall the global package to use `npx`. |
| Numbers look different from the VS Code extension | Both read the same logs, but the canvas shows the snapshot from its last refresh — check "Updated … ago" at the top of the canvas and use **Refresh**. See the [CLI docs](../cli/README.md) for what is counted. |

## Versioning and releases

The plugin version lives in two places that must stay equal (a test enforces this):

- `version` in [`copilot-app/plugin.json`](../../copilot-app/plugin.json)
- the `ai-fluency-canvas` entry's `version` in [`.github/plugin/marketplace.json`](../../.github/plugin/marketplace.json)

Bump both (semver) in the same pull request. Once it is merged to `main`, users get the new version with
`copilot plugin marketplace update` and `copilot plugin update ai-fluency-canvas`. Developer notes (layout, tests,
trying a branch before merge) are in [copilot-app/README.md](../../copilot-app/README.md).
