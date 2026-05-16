# Oh-My-Posh Token Usage Segment

Display your AI token usage (today and last 30 days) directly in your terminal prompt, powered by the [`@rajbos/ai-engineering-fluency`](https://www.npmjs.com/package/@rajbos/ai-engineering-fluency) CLI.

Example output in your prompt:

```
 󱊤 1.2K today · 45.3K 30d 
```

The segment reads **local session files** on your machine — no internet connection or API token required. It tracks tokens from VS Code Copilot Chat, Claude Code, Gemini CLI, OpenCode, and [all other supported editors](../cli/README.md).

---

## How It Works

The CLI's `segment` command outputs a compact formatted string. Oh-my-posh calls it via the `{{ cmd }}` template helper and caches the result, so your prompt stays fast.

Two caches work together:
| Cache | Location | TTL | Purpose |
|---|---|---|---|
| **Oh-my-posh segment cache** | in-memory, per shell session | 5 min (configurable) | Prevents calling the CLI on every keystroke |
| **CLI segment cache** | `~/.copilot-token-tracker/omp-segment-cache.json` | 15 min (configurable) | Prevents re-parsing session files when OMP cache expires |

A session parsing run (cache miss) typically takes < 1 second.

---

## Prerequisites

1. **Node.js 22+** — [nodejs.org](https://nodejs.org)
2. **Oh-my-posh** — [ohmyposh.dev/docs/installation](https://ohmyposh.dev/docs/installation)
3. **The CLI installed globally:**

```powershell
npm install -g @rajbos/ai-engineering-fluency
```

Verify it works:

```powershell
ai-engineering-fluency segment
# e.g.: 1.2K today · 45.3K 30d
```

> **Note:** If you use `npx` instead of a global install, replace `"ai-engineering-fluency"` with `"npx"` and add `"-y"`, `"@rajbos/ai-engineering-fluency"` as additional arguments in the `cmd` call below. `npx` is significantly slower due to package resolution on first run.

---

## Method 1: Using `{{ cmd }}`

> **Note:** The `{{ cmd }}` template function is not available in all oh-my-posh builds. If you see `invalid template text` in your prompt, your version does not support it — use [Method 2](#method-2-powershell-pre-prompt-hook) instead.

This is the cleanest approach if your OMP version supports it. Add the segment config to your oh-my-posh theme file.

### Step 1: Find your theme file

```powershell
# Show the currently active theme path
$env:POSH_THEME

# Or export your current config to edit it
oh-my-posh config export --output "$env:USERPROFILE\.omp.json"
```

### Step 2: Add the segment

Open your theme JSON (or YAML/TOML) and add the following to a `segments` array inside a `block`. The content of [`segment.omp.json`](./segment.omp.json) can be pasted directly:

```json
{
  "type": "text",
  "style": "diamond",
  "leading_diamond": "\ue0b6",
  "trailing_diamond": "\ue0b4",
  "foreground": "#ffffff",
  "background": "#005ca5",
  "cache": {
    "duration": "5m",
    "strategy": "session"
  },
  "template": " \uec1e {{ cmd \"ai-engineering-fluency\" \"segment\" }} "
}
```

> The `\uec1e` character is the Copilot icon from [Nerd Fonts](https://www.nerdfonts.com). Remove it (or replace with `🤖`) if you are not using a Nerd Font.

### Step 3: Reload your shell

```powershell
# Reload your profile
. $PROFILE

# Or open a new terminal window
```

---

## Method 2: PowerShell Pre-Prompt Hook — Recommended

Use this if `{{ cmd }}` is not supported in your OMP version, or if you want more control over the output.

### Step 1: Add the hook to your PowerShell profile

Copy the function from [`posh-hook.ps1`](./posh-hook.ps1) into your `$PROFILE`:

```powershell
# Open your profile to edit
notepad $PROFILE
```

Paste the `Set-PoshContext` function at the end of the file, then add a call to it immediately after the function definition:

```powershell
# ... Set-PoshContext function above ...

# Pre-populate token env vars so the first prompt render shows values
Set-PoshContext
```

Without this, the segment shows empty values on the first prompt after every new terminal or profile reload (OMP reads env vars before the hook fires on the very first render).

Save the file.

### Step 2: Add the environment-variable segment to your theme

```json
{
  "type": "text",
  "style": "diamond",
  "leading_diamond": "\ue0b6",
  "trailing_diamond": "\ue0b4",
  "foreground": "#ffffff",
  "background": "#005ca5",
  "template": " \uec1e {{ .Env.COPILOT_TOKENS_TODAY }} today · {{ .Env.COPILOT_TOKENS_30D }} 30d "
}
```

The hook updates `$env:COPILOT_TOKENS_TODAY` and `$env:COPILOT_TOKENS_30D` at most once every 15 minutes.

---

## Style Variants

### Powerline style (arrow separators)

```json
{
  "type": "text",
  "style": "powerline",
  "powerline_symbol": "\ue0b0",
  "foreground": "#ffffff",
  "background": "#005ca5",
  "cache": { "duration": "5m", "strategy": "session" },
  "template": " \uec1e {{ cmd \"ai-engineering-fluency\" \"segment\" }} "
}
```

### Plain / no background

```json
{
  "type": "text",
  "style": "plain",
  "foreground": "#005ca5",
  "cache": { "duration": "5m", "strategy": "session" },
  "template": "\uec1e {{ cmd \"ai-engineering-fluency\" \"segment\" }} "
}
```

### Hide when no data

```json
{
  "type": "text",
  "style": "diamond",
  "leading_diamond": "\ue0b6",
  "trailing_diamond": "\ue0b4",
  "foreground": "#ffffff",
  "background": "#005ca5",
  "cache": { "duration": "5m", "strategy": "session" },
  "template": "{{ $out := cmd \"ai-engineering-fluency\" \"segment\" \"--hide-zero\" }}{{ if $out }} \uec1e {{ $out }} {{ end }}"
}
```

---

## Options Reference

```
ai-engineering-fluency segment [options]

Options:
  --ttl <minutes>   Segment cache TTL in minutes (default: 15)
  --refresh         Force refresh — bypass the segment output cache
  --hide-zero       Output nothing when both token counts are zero
  --no-cache        Also bypass the underlying session file cache
  -h, --help        Show help
```

### Force a refresh

```powershell
# Refresh the segment output cache immediately
ai-engineering-fluency segment --refresh

# Force a full re-parse of all session files
ai-engineering-fluency --no-cache segment --refresh
```

---

## Local Validation

### Test the CLI output directly

```powershell
# Check basic output
ai-engineering-fluency segment

# Force refresh to see current numbers
ai-engineering-fluency segment --refresh

# Inspect the cache file
Get-Content "$env:USERPROFILE\.copilot-token-tracker\omp-segment-cache.json" | ConvertFrom-Json
```

### Preview the segment in your theme

```powershell
# Export your current config (if you haven't already)
oh-my-posh config export --output "$env:TEMP\test.omp.json"

# Add the segment to test.omp.json (open in your editor)
code "$env:TEMP\test.omp.json"

# Preview the prompt without changing your active theme
oh-my-posh prompt print primary --config "$env:TEMP\test.omp.json"

# Full debug output showing all segment values
oh-my-posh debug --config "$env:TEMP\test.omp.json"
```

### Measure render time

```powershell
# Time a single prompt render (OMP cache cold)
oh-my-posh cache clear
Measure-Command { oh-my-posh prompt print primary --config "$env:TEMP\test.omp.json" }

# Time a render with OMP cache warm (should be near-instant)
Measure-Command { oh-my-posh prompt print primary --config "$env:TEMP\test.omp.json" }
```

### Activate the test theme in your shell

```powershell
oh-my-posh init pwsh --config "$env:TEMP\test.omp.json" | Invoke-Expression
# Open a new terminal to test, then restore your normal theme
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Command not found: `ai-engineering-fluency` | CLI not installed globally | `npm install -g @rajbos/ai-engineering-fluency` |
| Segment shows `0 today · 0 30d` | No session files found | Run `ai-engineering-fluency diagnostics` to check paths |
| Segment shows `invalid template text` | `{{ cmd }}` not supported in your OMP version | Switch to [Method 2](#method-2-powershell-pre-prompt-hook--recommended) |
| Segment shows `today · 30d` without values | `Set-PoshContext` not called before first render | Add `Set-PoshContext` call at end of `$PROFILE` after the function definition |
| Segment never updates | OMP cache too long | Set `cache.duration` to `"1m"` or use `--hide-zero` |
| Stale numbers | CLI cache still valid | Run `ai-engineering-fluency segment --refresh` |
| Icon shows as a box / `?` | Not using a Nerd Font | Replace `\uec1e` with `🤖` or remove the icon |
| Prompt slows down | OMP cache not set | Add `"cache": {"duration": "5m", "strategy": "session"}` to the segment |

---

## Publishing / Sharing

The oh-my-posh **theme marketplace is closed** to new submissions, but you can share your setup:

- Post in [oh-my-posh Discussions → Themes](https://github.com/JanDeDobbeleer/oh-my-posh/discussions/categories/themes)
- Share in the [oh-my-posh Discord](https://discord.com/channels/1023597603331526656/1055533233309233252) `#themes` channel

If you'd like to contribute this as a **native Go segment** to the oh-my-posh project (so it appears in the official docs), the contribution guide is at [ohmyposh.dev/docs/contributing/segment](https://ohmyposh.dev/docs/contributing/segment). A native Go segment would call `exec.Command("ai-engineering-fluency", "segment")` and parse its output, making it available as a first-class `"type": "copilot-tokens"` (or similar) segment.
## GitHub Copilot CLI Statusline (Experimental)

GitHub Copilot CLI has an experimental `STATUS_LINE` feature that calls a local command and renders its output at the bottom of the Copilot terminal UI. This folder includes ready-to-use scripts that combine the standard Copilot session data (context tokens, session duration, line changes) with your total daily / 30-day token usage from `ai-engineering-fluency`.

> **Credit:** Setup pattern from [Scott Hanselman's gist](https://gist.github.com/shanselman/9623ac74888a07ba82f63f5310fda11b).

Example statusline:

```
main +2/-1 > ctx 123.5k/200.0k > ######.... > 00:12:34 > +42/-8 > 12.9M today · 1443.5M 30d
```

### Files

| File | Purpose |
|---|---|
| [`statusline.cmd`](./statusline.cmd) | Windows wrapper — points `statusLine.command` at the PowerShell script |
| [`statusline.ps1`](./statusline.ps1) | Reads Copilot's JSON stdin, sets env vars, calls `ai-engineering-fluency segment`, renders via oh-my-posh |
| [`statusline.omp.json`](./statusline.omp.json) | Compact oh-my-posh theme — git, context gauge, duration, changes, token totals |

### Requirements

In addition to the [prerequisites above](#prerequisites):

- **GitHub Copilot CLI** with the experimental `STATUS_LINE` feature flag
- **oh-my-posh** available on `PATH` (`oh-my-posh version` should return output)

### Setup

#### Step 1 — Copy the files to your Copilot folder

```powershell
$dest = "$env:USERPROFILE\.copilot"
New-Item -ItemType Directory -Force $dest | Out-Null

# Adjust the source path to match where you cloned this repo
$src = "path\to\ai-engineering-fluency\omp-segment"
Copy-Item "$src\statusline.cmd"      $dest
Copy-Item "$src\statusline.ps1"      $dest
Copy-Item "$src\statusline.omp.json" $dest
```

#### Step 2 — Edit `%USERPROFILE%\.copilot\settings.json`

Create or update the file (replace `YOURUSER` with your Windows username):

```json
{
  "statusLine": {
    "type": "command",
    "command": "C:\\Users\\YOURUSER\\.copilot\\statusline.cmd",
    "padding": 1
  },
  "feature_flags": {
    "enabled": ["STATUS_LINE"]
  },
  "experimental": true
}
```

If you already have a `feature_flags.enabled` array, **add** `"STATUS_LINE"` to it instead of replacing the array.

#### Step 3 — Restart Copilot CLI

```
/restart
```

### Test Without Copilot

Pipe a sample JSON payload directly to the command to verify output before wiring it into Copilot:

```powershell
@'
{
  "cwd": "C:\\src\\my-repo",
  "context_window": {
    "current_context_tokens": 123456,
    "displayed_context_limit": 200000,
    "current_context_used_percentage": 61.7
  },
  "cost": {
    "total_duration_ms": 754000,
    "total_lines_added": 42,
    "total_lines_removed": 8
  }
}
'@ | & "$env:USERPROFILE\.copilot\statusline.cmd"
```

Expected output (appearance depends on your Nerd Font):

```
main +2/-1 > ctx 123.5k/200.0k > ######.... > 00:12:34 > +42/-8 > 12.9M today · 1443.5M 30d
```

### Customising the Theme

Open `%USERPROFILE%\.copilot\statusline.omp.json` to adjust colours, icons, or segments.

To use Nerd Font glyphs instead of plain ASCII separators, replace the diamond and powerline values:

```json
"leading_diamond": "\ue0b6",
"trailing_diamond": "\ue0b0",
"powerline_symbol": "\ue0b0"
```

> **Keep the theme small.** The statusline must render quickly — remove any segment that makes network calls or scans large directories.

### How the Token Cache Works Here

In the standard shell prompt setup, oh-my-posh's segment-level `cache` block prevents calling the CLI on every keystroke. That OMP cache **does not apply** in the Copilot CLI statusline context — each Copilot status refresh calls the script fresh.

What does help is the CLI's own segment cache (`~/.copilot-token-tracker/omp-segment-cache.json`, default 15-minute TTL). After the first call, subsequent statusline renders return the cached value in ~150 ms instead of the full ~7 s cold parse.

Tune the TTL with the `--ttl` flag inside `statusline.ps1` if you want more or less freshness:

```powershell
# Inside statusline.ps1 — change the ai-engineering-fluency segment call:
$tokenOutput = & ai-engineering-fluency segment --ttl 5 2>$null   # refresh every 5 min
```

---

## Related

- [AI Engineering Fluency CLI docs](../docs/cli/README.md)
- [npm package: `@rajbos/ai-engineering-fluency`](https://www.npmjs.com/package/@rajbos/ai-engineering-fluency)
- [oh-my-posh template functions](https://ohmyposh.dev/docs/configuration/templates)
- [oh-my-posh segment configuration](https://ohmyposh.dev/docs/configuration/segment)
