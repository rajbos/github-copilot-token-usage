# AI Engineering Fluency — CLI

![AI Engineering Fluency](../../assets/AI%20Engineering%20Fluency%20-%20Transparent.png)

Command-line interface that reads the session files your AI coding tools leave on disk — GitHub Copilot (VS Code, Copilot CLI, JetBrains, Visual Studio), Claude Code, Gemini CLI, Codex CLI, OpenCode, Cursor and more — and reports token usage, estimated cost, fluency scores and environmental impact. No editor required.

📦 **npm**: [@rajbos/ai-engineering-fluency](https://www.npmjs.com/package/@rajbos/ai-engineering-fluency)

**Contents:** [Quick start](#quick-start) · [Commands](#commands) · [Configuration](#configuration) · [Data sources](#data-sources) · [Scripting and JSON output](#scripting-and-json-output) · [Troubleshooting](#troubleshooting) · [Privacy](#privacy) · [Development](#development)

## Quick Start

```bash
# Run directly with npx (no install required)
npx @rajbos/ai-engineering-fluency stats

# Or install globally
npm install -g @rajbos/ai-engineering-fluency
ai-engineering-fluency stats
```

Requires **Node.js 22.14 or later**. The first run parses every session file it finds and can take a while on a machine with a long history; later runs reuse a local cache (see [Cache files](#cache-files)).

---

## Commands

| Command | Purpose | Options |
|---|---|---|
| [`stats`](#stats--session-overview) | Discovered session files, chat turns and tokens | `-v, --verbose`, `--json` |
| [`usage`](#usage--token-usage-report) | Tokens per period, per editor, per model, cost | `-m, --models`, `-c, --cost`, `--json` |
| [`environmental`](#environmental--environmental-impact) (alias `env`) | CO₂, water and tree estimates | — |
| [`fluency`](#fluency--fluency-score) | Fluency score per category | `-t, --tips`, `--json` |
| [`diagnostics`](#diagnostics--search-locations--stats) | Every search location and what was found there | — |
| [`memory-files`](#memory-files--copilot-memory-files-hygiene-report) | Copilot agent memory-file hygiene | `--json`, `--stale-days`, `--large-kb`, `--server`, `--repo`, `--limit`, `--promote` |
| [`curation`](#curation--tool-curation-report) | MCP servers and skills you load but don't use | `--json`, `--window` |
| [`skill-suggestions`](#skill-suggestions--repeated-tasks) | Tasks you keep prompting for by hand (skill candidates) | `--json`, `--include-prompts` |
| [`segment`](#segment--prompt-segment) | Compact, cached one-liner for shell prompts | `--ttl`, `--refresh`, `--hide-zero`, `--json` |
| [`chart`](#integration-commands-chart-usage-analysis-all) | Daily usage payload (integration) | `--json`, `-v, --verbose` |
| [`usage-analysis`](#integration-commands-chart-usage-analysis-all) | Usage-analysis payload (integration) | `--json`, `--repeated-tasks` |
| [`all`](#integration-commands-chart-usage-analysis-all) | Every payload in one call (integration) | `--json` (required) |

Global options, valid before any command:

| Option | Effect |
|---|---|
| `--no-cache` | Ignore the parsed-session cache (`cli-cache.json`) and re-parse every file; that cache is neither read nor written for the run. It does **not** bypass the `segment` output cache — use `segment --refresh` for that. |
| `-V, --version` | Print the package version. |
| `-h, --help` | Help for the CLI, or for one command: `ai-engineering-fluency usage --help`. |

---

### `stats` — Session Overview

Show discovered session files, chat turns and token counts, broken down by editor.

```bash
ai-engineering-fluency stats
ai-engineering-fluency stats --verbose  # Also list search paths and a per-folder breakdown (top 20)
ai-engineering-fluency stats --json     # Machine-readable JSON output
```

```
🔍 Copilot Token Tracker - Session Statistics

📂 Found 1,204 session file(s)

📊 Summary
──────────────────────────────────────────────────
  Session files (with data):  1,187
  Empty/skipped files:        17
  Total chat turns:           9,318
  Total tokens:               412.6M
  Thinking tokens (included): 1.2M

🖥️  By Editor
──────────────────────────────────────────────────
  VS Code                     640 files     96.1M tokens   4,102 turns
  Copilot CLI                 311 files    201.4M tokens   2,977 turns
  Claude Code                 236 files    115.1M tokens   2,239 turns
```

With `--json`:

```json
{
  "totalFiles": 1204,
  "processedFiles": 1187,
  "emptyFiles": 17,
  "totalTokens": 412600000,
  "totalThinkingTokens": 1200000,
  "totalInteractions": 9318,
  "byEditor": {
    "VS Code":     { "files": 640, "tokens": 96100000,  "interactions": 4102 },
    "Copilot CLI": { "files": 311, "tokens": 201400000, "interactions": 2977 },
    "Claude Code": { "files": 236, "tokens": 115100000, "interactions": 2239 }
  },
  "lastUpdated": "2026-09-29T10:30:00.000Z"
}
```

If no files are found, `--json` prints `{}`.

---

### `usage` — Token Usage Report

Token usage for **Today**, **This Month**, **Last Month** and **Last 30 Days**, each with an editor breakdown.

```bash
ai-engineering-fluency usage
ai-engineering-fluency usage --models  # Add a per-model token breakdown per period
ai-engineering-fluency usage --cost    # Add an estimated cost breakdown per period
ai-engineering-fluency usage --json    # Machine-readable JSON output
```

```
📊 Copilot Token Tracker - Usage Report

📅 Today
────────────────────────────────────────
  Sessions:              10
  Avg interactions/sess: 4.2
  Total tokens:          8.4M
  Thinking tokens:       3.1K (included in total)
  Avg tokens/session:    844.9K

  Editor Breakdown:
    Claude Code                   6 sessions      5.9M tokens
    Copilot CLI                   4 sessions      2.5M tokens

📆 This Month
────────────────────────────────────────
  ...
```

Costs are estimates from the bundled model price list (`modelPricing.json`), not your bill. Requests that Copilot's **Auto** model routing handled get the shared 10% Auto discount; manual model choices and non-Copilot providers are priced undiscounted.

---

### `environmental` — Environmental Impact

Estimated CO₂ emissions, water use and trees-to-offset for Today, This Month, Last Month and Last 30 Days, plus everyday comparisons (km driven, phone charges, cups of coffee, LED-bulb hours) for the last 30 days.

```bash
ai-engineering-fluency environmental
ai-engineering-fluency env  # Short alias
```

```
🌍 Copilot Token Tracker - Environmental Impact

Methodology: Jegham et al., "How Hungry is AI?" (arXiv:2505.09598), via neuland/tokendashboard-backend.
  ...

📈 Last 30 Days
───────────────────────────────────────────────────────
  Tokens used:          412.6M
  CO₂ emissions:        1.84 kgCO₂e
  Water usage:          32.719 liters
  Trees to offset:      0.087619 trees/year
```

Figures are estimates: tokens are weighted by type (output fully, fresh input and cache reads much less) and each model is scaled from a Claude Sonnet reference by its output-token price. The command prints the exact reference values and weights it used.

---

### `fluency` — Fluency Score

Your AI Engineering Fluency stage (1–4) overall and across six categories — Prompt Engineering, Context Engineering, Agentic, Tool Usage, Customization and Workflow Integration — based on the last 30 days, with the evidence behind each score. Scoring rules: [FLUENCY-LEVELS.md](../FLUENCY-LEVELS.md).

```bash
ai-engineering-fluency fluency
ai-engineering-fluency fluency --tips  # Show how to reach the next stage in each category
ai-engineering-fluency fluency --json  # Machine-readable JSON output
```

```
🎯 Copilot Token Tracker - Fluency Score

Overall Fluency Score
───────────────────────────────────────────────────────
  ███░ Stage 3: AI Collaborator

Category Breakdown
───────────────────────────────────────────────────────
  💬 Prompt Engineering
     ███░ Stage 3/4
     ✓ 1,318 total interactions
  ...

📊 Analysis Period (Last 30 Days)
───────────────────────────────────────────────────────
  Sessions analyzed:       187
  Total interactions:      1,318
  ...
```

---

### `diagnostics` — Search Locations & Stats

Every location searched for session files, whether it exists on this machine, and per-location file counts and usage. Run this first when numbers look wrong — see [Troubleshooting](#troubleshooting).

```bash
ai-engineering-fluency diagnostics
```

```
🔬 Copilot Token Tracker - Diagnostics

📂 Search Locations  (6 found / 24 total)
─────────────────────────────────────────────────────────────────
  Source             │ Exists │ Path
  ────────────────────────────────────────────────────────────────────────────────
  VS Code            │ yes    │ …/AppData/Roaming/Code/User
  VS Code            │ no     │ …/AppData/Roaming/Code - Insiders/User
  Copilot CLI        │ yes    │ …/.copilot/session-state
  ...
```

---

### `memory-files` — Copilot Memory Files Hygiene Report

Report on GitHub Copilot agent memory files on this machine (`memory-tool/memories/` notes written by the Copilot agent) — counts, staleness and unusually large files, by workspace. Local files are read for **metadata only** (name, size, last-modified time), never content.

```bash
ai-engineering-fluency memory-files
ai-engineering-fluency memory-files --json               # Machine-readable JSON output
ai-engineering-fluency memory-files --stale-days 30      # Flag files not edited in 30+ days (default: 90)
ai-engineering-fluency memory-files --large-kb 5         # Flag files larger than 5 KB (default: 10)
```

Optionally also read this repository's **server-side** Copilot memories — the per-repository store GitHub keeps for the Copilot coding agent. This is the CLI's only network access. It needs the [GitHub CLI](https://cli.github.com/) (`gh`) installed and signed in to github.com (`gh auth login --hostname github.com`); GitHub Enterprise Server repositories are not supported.

| Option | Effect |
|---|---|
| `--server` | Also fetch the server-side memories for this repository. |
| `--repo <owner/name>` | Repository to read. Default: the current checkout's `origin` remote. Implies `--server`. |
| `--limit <n>` | Maximum number of server memories to request. |
| `--promote` | Print the memories worth promoting into `AGENTS.md` as a ready-to-paste Markdown block. Implies `--server`. |

With `--json` and `--server`, `--repo` or `--promote`, the output gains a `serverMemories` key (`--limit` only controls a server read requested by one of those options):

- `null` only when no repository could be determined — the current directory is not a checkout with a github.com `origin` remote, and no `--repo` was given.
- Otherwise an object with the analysis. If the read failed (no `gh`, no github.com token, no Copilot access, memory disabled, or an invalid `--repo`), the object has an `error` string and zeroed counts. Check `serverMemories.error` rather than testing for `null`.

`--json` takes precedence over `--promote`: the JSON is printed and no Markdown block is written. Without `--json`, a server read failure under `--promote` prints the reason to stderr and exits with code `1`, so an empty promotion list is never mistaken for "nothing to document". If no repository can be determined, the command instead prints guidance to stdout and exits with code `0`.

Background: [COPILOT-SERVER-MEMORIES.md](../features/COPILOT-SERVER-MEMORIES.md).

```
Copilot Memory Files Report
==================================================

Total memory files: 12
Total size:          48.3 KB
Stale (>90d):        3
Large (>10KB):       1

By workspace:
  • ai-engineering-fluency
      repo-scope: 2, session-scope: 4, global-scope: 0, size: 18.2 KB
      stale: onboarding-notes, legacy-api-plan
  • User (global)
      repo-scope: 0, session-scope: 0, global-scope: 6, size: 30.1 KB
```

---

### `curation` — Tool Curation Report

Compare the MCP servers and skills you have configured with the tools your sessions actually called, and estimate the prompt overhead of the unused ones.

```bash
ai-engineering-fluency curation
ai-engineering-fluency curation --window 14   # Window shown in the report text (default: 30) — see note below
ai-engineering-fluency curation --json
```

Run it **from your project folder**: the CLI has no editor to ask for its tool list, so "available tools" come from the file system.

MCP servers are read from:

- `.vscode/mcp.json` (VS Code), `.mcp.json` and `.vs/mcp.json` (Visual Studio) and `.cursor/mcp.json` (Cursor) in the current directory
- `~/.mcp.json` (Visual Studio, user level)

Skills (folders containing a `SKILL.md`) are read from:

- `.github/skills/`, `.claude/skills/` and `.agents/skills/` in the current directory
- `~/.copilot/skills/`, `~/.claude/skills/` and `~/.agents/skills/`, including nested `skills/` folders up to four levels deep
- VS Code agent plugins installed under `~/.vscode/agent-plugins/` and `~/.vscode-insiders/agent-plugins/` (only the skills each plugin declares)
- the folders listed in VS Code's `chat.agentSkillsLocations` setting, read from the Stable and Insiders user `settings.json`

> **Note:** tool usage always comes from the **last 30 days** of sessions. `--window` currently only changes the number of days shown in the report and its recommendations, not the period that is analysed.

```
Tool Curation Report (last 30 days)
==================================================

Available tools: 48
Used tools:      19
Unused tools:    29
Est. overhead:   ~6,400 tokens/interaction

Unused MCP Servers:
  • playwright (~3,100 tokens overhead)
...
```

---

### `skill-suggestions` — Repeated Tasks

Find tasks you keep prompting for by hand — similar first prompts across several sessions, such as "run the tests and fix the failures" — as candidates for a reusable skill, prompt file or custom agent. This is the same report as the **Skill Suggestions** section of the VS Code extension's Usage Analysis view, built by the same shared code; see [features/REPEATED-TASKS.md](../features/REPEATED-TASKS.md).

```bash
ai-engineering-fluency skill-suggestions                          # Text report, prompts included
ai-engineering-fluency skill-suggestions --json                   # JSON without prompt text, keywords or session titles
ai-engineering-fluency skill-suggestions --json --include-prompts # JSON with prompt text, keywords and session titles
```

Sessions active in the current or the previous calendar month (at least the last 30 days) are scanned; for editors that keep many sessions in one database (such as OpenCode and Crush), each session's own last activity decides, not the database file's date. A task is reported once at least two sessions start with a similar prompt.

```
Skill Suggestions — repeated tasks
==================================================

2 repeated task(s) in 184 session(s) with a usable first prompt (a task needs at least 2 similar sessions).

1. "run the tests and fix the failures"
   Sessions:     4
   Keywords:     failures, tests
   Repositories: rajbos/ai-engineering-fluency
   Last seen:    2026-10-08
...
```

`--json` output has the shape `{ "promptsIncluded": false, "repeatedTasks": { "minClusterSize", "sessionsScanned", "clusters": [...] } }`; `repeatedTasks` is `null` when nothing repeats. `sessionsScanned` counts sessions whose first prompt could be clustered — slash commands, very short prompts and prompts made only of filler words are not counted. Each cluster carries `sessionCount`, `repositories` and `sessions` (`file`, `lastInteraction`, `repository`). Prompts are free text you wrote, so `representativePrompt`, the prompt-derived `sharedKeywords` and each session's `title` are only included with `--include-prompts`. Repositories are filled in only for editors whose session files record one.

---

### `segment` — Prompt Segment

A compact token-usage string for shell prompts such as [oh-my-posh](https://ohmyposh.dev/), backed by its own short-lived cache so each prompt render returns immediately. Setup: [omp-segment/README.md](../../omp-segment/README.md).

```bash
ai-engineering-fluency segment               # "8.4M today · 1.2B month · 1.9B 30d"
ai-engineering-fluency segment --ttl 15      # Cache the output for 15 minutes (default: 5)
ai-engineering-fluency segment --refresh     # Ignore the segment cache and recompute
ai-engineering-fluency segment --hide-zero   # Print nothing when today and 30-day counts are both zero
ai-engineering-fluency segment --json        # Structured output, same cache
```

`--json` output:

```json
{
  "today": 8400000, "month": 1200000000, "last30Days": 1900000000,
  "todayFormatted": "8.4M", "monthFormatted": "1.2B", "last30DaysFormatted": "1.9B",
  "formatted": "8.4M today · 1.2B month · 1.9B 30d",
  "updatedAt": "2026-09-29T10:30:00.000Z",
  "cached": true
}
```

For custom prompt hooks, prefer `segment --json` over `usage --json`: it is served from the segment cache, while `usage` recomputes every period on each call.

---

### Integration commands: `chart`, `usage-analysis`, `all`

These print the JSON payloads that the editor front-ends render — the Visual Studio extension runs `all --json` to load every view in a single call. They are useful for building your own dashboards, but their shape follows the extension's views and **may change between releases** (see [Scripting and JSON output](#scripting-and-json-output)).

| Command | Output |
|---|---|
| `chart --json` | Daily token usage (labels, per-day totals, per-editor/model series). `-v, --verbose` logs debug-log discovery details to stderr. Without `--json` it prints a per-period token and cost summary. |
| `usage-analysis --json` | Usage analysis per period: interaction modes, tool calls, MCP usage, context references. `--json` is required. `--repeated-tasks` adds the `repeatedTasks` report (the [`skill-suggestions`](#skill-suggestions--repeated-tasks) data, prompts included); it is left out by default because it carries prompt text. |
| `all --json` | One object with `details`, `chart`, `usage`, `fluency` and `curation` keys — the payloads of `usage --json`, `chart --json`, `usage-analysis --json`, `fluency --json` and `curation --json`. `--json` is required; without it the command prints a hint to stderr and exits. |

---

## Configuration

The CLI has **no configuration file and no settings of its own**. What it finds, and where, is controlled by the command-line options above, a handful of environment variables, and opt-ins in the tools it reads.

> Settings of the VS Code extension (`aiEngineeringFluency.*`, for example `sampleDataDirectory`) **do not apply** to the CLI.

### Environment variables

These change where session files are looked for. They are the same variables the tools themselves honour, so if the tool finds its data, the CLI does too.

| Variable | Effect |
|---|---|
| `CODEX_HOME` | Codex CLI data folder instead of `~/.codex`. |
| `HERMES_HOME` | Hermes data folder instead of `~/.hermes` (`%LOCALAPPDATA%\hermes` on Windows). |
| `VIBE_HOME` | Mistral Vibe data folder instead of `~/.vibe`. |
| `XDG_CONFIG_HOME` | Linux: base for VS Code-family, Cline and Cursor data (default `~/.config`). Linux/macOS: base for Crush's `projects.json`. |
| `XDG_DATA_HOME` | Linux/macOS: base for OpenCode and Kilo Code (default `~/.local/share`). Linux: base for Devin CLI. |
| `APPDATA` | Windows: base for VS Code-family, Cline, Cursor, Kiro and Devin CLI data. |
| `LOCALAPPDATA` | Windows: base for Visual Studio / SSMS logs, Claude Desktop Cowork, Crush and Hermes. |
| `WSL_DISTRO_NAME`, `WSL_INTEROP` | Set automatically inside WSL. When present, the CLI also searches the **Windows-side** VS Code folders under `/mnt/c/Users/<user>/AppData/Roaming/`. |
| `USERPROFILE` | Inside WSL, a value like `/mnt/d/Users/<name>` adds that drive when your Windows profile is not on `C:`. |

> Known limitation: the CLI labels sessions by recognising the default folder names (`.codex`, `.vibe`, `hermes`). If you point `CODEX_HOME`, `VIBE_HOME` or `HERMES_HOME` at a folder with a different name, the sessions may be shown as "VS Code" or not be parsed.

### Opt-ins for exact token counts

Several sources only store estimates unless you enable extra logging in the tool itself:

- **GitHub Copilot CLI** — exact counts come from `~/.copilot/session-store.db` when present, otherwise from Copilot CLI's OpenTelemetry file export in `~/.copilot/otel/`, which is off by default. How to enable it: [COPILOT-CLI-OTEL-EXPORT.md](../COPILOT-CLI-OTEL-EXPORT.md).
- **VS Code Copilot Chat** — when Copilot Chat writes debug logs (`debug-logs/<session>/main.jsonl` next to the chat sessions), their per-request token counts replace the estimate.

### Cache files

The CLI writes two files under `~/.copilot-token-tracker/` (the folder name predates the product rename):

| File | Contents | Lifetime |
|---|---|---|
| `cli-cache.json` | Parsed per-file results, keyed on file path and modification time, so unchanged files are not re-parsed. Holds at most 2,000 entries. | Until the file changes. Discarded automatically when a new CLI version changes the cache format. |
| `omp-segment-cache.json` | Last `segment` output. | `--ttl` minutes (default 5). |

To bypass the parse cache for one run, use `--no-cache`. To reset everything, delete the folder — it is rebuilt on the next run. The [library entry point](#programmatic-use) keeps its cache in memory and never touches these files.

---

## Data Sources

The CLI uses the same discovery and parsing code as the [VS Code extension](../vscode-extension/README.md). "Actual" means the tool records real token counts; "estimated" means the CLI estimates tokens from the conversation text, so treat those numbers as approximate.

| Source | Default location | Tokens |
|---|---|---|
| **VS Code Copilot Chat** — Stable, Insiders, Exploration, VSCodium, Cursor | `<config>/<variant>/User/{workspaceStorage,globalStorage}` where `<config>` is `%APPDATA%` (Windows), `~/Library/Application Support` (macOS) or `~/.config` (Linux). Also `~/.vscode-server`, `~/.vscode-server-insiders`, `~/.vscode-remote` (remote, WSL, Codespaces) | Actual where the session or debug log records it, otherwise estimated |
| **GitHub Copilot CLI** | `~/.copilot/session-state/`, `~/.copilot/session-store.db` | Actual (see [opt-ins](#opt-ins-for-exact-token-counts)), otherwise estimated |
| **JetBrains IDEs** + Copilot | `~/.copilot/jb/` | Estimated |
| **Visual Studio / SSMS** + Copilot | `%LOCALAPPDATA%\Temp\VSGitHubCopilotLogs`, `%LOCALAPPDATA%\Microsoft\VisualStudio\<ver>\VSGitHubCopilot`, and `.vs/<solution>/copilot-chat/` folders under common source roots (`~/code`, `~/repos`, `~/src`, …) | Estimated · **Windows only** |
| **Eclipse** + Copilot | `~/eclipse-workspace/.metadata/.plugins/com.microsoft.copilot.eclipse.core/` and recent Eclipse workspaces | Estimated |
| **Claude Code** | `~/.claude/projects/` (including subagents) | Actual |
| **Claude Desktop Cowork** | Windows: `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\`; macOS: `~/Library/Application Support/Claude/` | Actual · **Windows and macOS only** |
| **Gemini CLI** | `~/.gemini/tmp/<project>/chats/` | Actual |
| **Antigravity** | `~/.gemini/antigravity/brain/` | Estimated |
| **Codex CLI** | `~/.codex/sessions/`, `~/.codex/archived_sessions/`, `~/.codex/state_*.sqlite` (`CODEX_HOME`) | Actual |
| **OpenCode** | `~/.local/share/opencode/` (`XDG_DATA_HOME`) | Actual |
| **Kilo Code** | `~/.local/share/kilo/` (`XDG_DATA_HOME`) | Actual |
| **Crush** | Projects listed in `%LOCALAPPDATA%\crush\projects.json` / `~/.config/crush/projects.json` | Actual |
| **Cline** | `globalStorage/saoudrizwan.claude-dev/tasks/` in each VS Code-family folder | Actual |
| **Continue** | `~/.continue/sessions/` | Estimated |
| **Cursor** (native composer) | `<config>/Cursor/User/globalStorage/state.vscdb` | Input/context tokens only — Cursor stores no output counts |
| **Kiro IDE** | `<config>/Kiro/User/globalStorage/kiro.kiroagent/` (Linux: always `~/.config/Kiro`) | Estimated; credits tracked separately |
| **Kiro CLI** | `~/.kiro/sessions/cli/` | Estimated; credits tracked separately |
| **Mistral Vibe** | `~/.vibe/logs/session/` (`VIBE_HOME`) | Actual |
| **Pi** | `~/.pi/agent/sessions/` | Actual |
| **Hermes** | `~/.hermes/state.db`; Windows `%LOCALAPPDATA%\hermes\state.db` (`HERMES_HOME`) | Actual |
| **Devin CLI** | `%APPDATA%\devin\cli\sessions.db` / `~/.local/share/devin/cli/sessions.db` | Actual when recorded, otherwise estimated |

Windsurf (Cascade) is supported by the VS Code extension only; the CLI does not read it.

Run `ai-engineering-fluency diagnostics` to see exactly which of these locations exist on your machine. File formats are documented in [logFilesSchema/](../logFilesSchema/README.md).

---

## Scripting and JSON output

- With `--json`, progress output is suppressed and the result is written to **stdout** as a single JSON document, so `ai-engineering-fluency usage --json > usage.json` is safe. Errors go to **stderr**.
- Token counts are plain numbers; the `…Formatted` fields in `segment --json` are display strings.
- `stats --json`, `segment --json` and `memory-files --json` have small, documented shapes (above) that are intended for scripts. The integration payloads (`chart`, `usage-analysis`, `all`, and the `usage` / `fluency` payloads) mirror the extension's views and can change between releases — pin the package version if you depend on them.
- Exit code is `0` on success, including when no sessions are found (the JSON is then an empty object or empty payload), and when a `memory-files --json --server` read fails (see `serverMemories.error`). It is `1` when `memory-files --promote` cannot read the server memories, and on any unexpected error, which is printed to stderr.

---

## Programmatic use

Since 0.7.0 the package also works as a Node library. The `@rajbos/ai-engineering-fluency/session` entry point returns token usage and cost for one session file, so another app can show per-session cost without running the CLI. It works with `require()` and `import`, ships its own TypeScript types, and contains none of the CLI code.

```bash
npm install @rajbos/ai-engineering-fluency
```

```js
const { analyzeSessionFile, analyzeSessionFiles } = require('@rajbos/ai-engineering-fluency/session');

const usage = await analyzeSessionFile('/home/me/.copilot/session-state/<id>/events.jsonl');
if (usage) {
  console.log(usage.editorSource, usage.totalTokens, usage.estimatedCostUsd.provider);
  if (usage.copilotCredits !== null) {
    console.log(`${usage.copilotCredits} AI credits billed`);
  }
}

// Several files at once. The Map only holds the files that parsed.
const byPath = await analyzeSessionFiles([claudeSessionPath, copilotEventsPath]);
```

Pass absolute paths (for example built with `os.homedir()`). Node does not expand `~`. `analyzeSessionFile(filePath, { cache? })` resolves to a `SessionUsage`, or to `null` for a missing, unknown or unparsable file, a session file over 100 MB, and a session with no activity recorded yet (no turns, tokens, models or billing). Database-backed sessions (`…/state.db#<id>`, `session-store.db#<id>`, …) are not size-capped, because one database holds every session. It never throws for a bad file, never writes to the console and never exits the process. Each `SessionUsage` has these fields:

| Field | Meaning |
|---|---|
| `filePath` | The path you passed in. |
| `editorSource` | Friendly tool name, the same one the CLI shows: `Claude Code`, `Copilot CLI`, `VS Code`, and so on. |
| `interactions` | Number of user turns. |
| `models` / `modelUsage` | Model ids, and per model: `inputTokens` (including cache reads and writes), `outputTokens`, `cachedReadTokens`, `cacheCreationTokens`, and so on. |
| `totalTokens` | Session total. Exact where the tool records it, otherwise estimated (see [Data Sources](#data-sources)). |
| `copilotNanoAiu` | Exact GitHub Copilot billed amount, in nano-AI-units, from the latest Copilot CLI `session.usage_checkpoint` or `session.shutdown` event, the Copilot CLI billing store, or a Copilot Chat debug log. `0` when not available. |
| `copilotCredits` | `copilotNanoAiu / 1e9` (1 AI credit = $0.01), or `null` when not available. |
| `estimatedCostUsd` | `{ provider, copilot }`: an estimate from the per-model token counts, at provider API rates and at Copilot rates, using the same pricing table as the CLI. |
| `lastModified` | File modification time, ISO 8601. |

**Polling.** Results are cached in memory, per path. A cached result is reused while the session file's modification time and size stay the same, and so do those of the side files it draws on: for Copilot CLI sessions, `~/.copilot/session-store.db` and the OTel export in `~/.copilot/otel/`; for VS Code chat sessions, the Copilot Chat debug log. A repeated call on an unchanged session therefore costs a few `stat` calls. When any of those files changes, including a Claude Code or Copilot CLI log that is still being appended to, the session is re-parsed on the next call. The OTel export is re-indexed at most every 30 seconds. Concurrent calls on the same file share one parse. Pass `{ cache: false }` to always re-parse. Returned objects are frozen, and repeated calls may hand back the same object.

The library does not read or write the CLI's `cli-cache.json`, so it is safe to use while the CLI is running. It never reads anything stored in the OS temp directory, including databases behind `…#<id>` paths, so Visual Studio's logs under `%LOCALAPPDATA%\Temp` are not supported by the library. The CLI still reads those.

---

## Troubleshooting

**"No session files found" or a tool is missing**
1. Run `ai-engineering-fluency diagnostics` and check whether the tool's location is listed and marked as found.
2. If the tool stores its data somewhere custom, set the matching [environment variable](#environment-variables) before running the CLI.
3. In WSL, confirm `WSL_DISTRO_NAME` is set (`echo $WSL_DISTRO_NAME`) so the Windows-side VS Code folders are searched.
4. Some sources are platform-specific — see the [Data Sources](#data-sources) table.

**Numbers didn't change after new activity, or look stale**
Run once with `--no-cache`. For `segment`, use `--refresh` or wait for the `--ttl` to expire.

**Token counts look low or rough for a tool**
Check the "Tokens" column in [Data Sources](#data-sources): estimated sources are approximations. For Copilot CLI, enable the [OpenTelemetry export](#opt-ins-for-exact-token-counts).

**The first run is slow**
Every session file is parsed once; later runs only re-parse files that changed.

---

## Privacy

- Everything runs locally. The CLI reads session files from your disk and writes only its [cache files](#cache-files).
- Nothing is uploaded. The only network call is `memory-files --server` (and `--repo` / `--promote`), which takes your github.com token from the GitHub CLI (`gh auth token`) and reads the repository's Copilot memories from `api.githubcopilot.com`. It is read-only.
- `memory-files` reads local memory files' metadata only, never their content.
- `skill-suggestions` prints the first prompt of your sessions in its text report. Its `--json` output leaves prompt text, the keywords taken from it and session titles out unless you pass `--include-prompts`, and `usage-analysis --json` only includes them with `--repeated-tasks`.

---

## Development

```bash
# From the repository root
npm run cli:build           # Build the CLI
npm run cli:stats           # Run stats command
npm run cli:usage           # Run usage command
npm run cli:environmental   # Run environmental command
npm run cli:fluency         # Run fluency command
npm run cli:diagnostics     # Run diagnostics command
npm run cli -- --help       # Run any CLI command
```

From `cli/`: `npm run build`, `npm test`, `npm run check-types`, `npm run lint`. The CLI is a thin wrapper around the shared modules in the repository's [`src/`](../../src/) folder — parsing and cost logic belong there, not in `cli/`. See the [CLI contributor guide](../../.github/instructions/cli.instructions.md).

When you add or change a command or option, update this page: a unit test (`cli/src/test/docsCoverage.test.ts`) fails if a command or option is missing here.

---

## License

MIT — see [LICENSE](../../LICENSE) for details.
