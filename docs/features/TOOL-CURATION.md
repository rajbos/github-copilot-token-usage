---
title: Tool Curation
description: Compares available tools (MCP servers, skills, extension tools) against actually-used tools and surfaces recommendations to reduce prompt overhead.
created: 2026-06-11
status: current
---

# Tool Curation

## Overview

The Tool Curation feature analyzes the gap between the tools **available** in your environment and the tools **actually used** within a configurable look-back window. It surfaces actionable recommendations to reduce prompt overhead caused by idle MCP servers and stale skill files.

The curation section appears in the **Tools** tab of the Usage Analysis Dashboard.

## Why It Matters

Every MCP server and skill file contributes a description block to every prompt — even when the tool is never called. Over time, accumulating unused tools inflates prompt token counts, increases latency, and can hit context-window limits.

Tool Curation gives you a concrete view of which tools are pulling their weight and which ones can be safely disabled or refined.

## Browsing the tables

MCP Servers, Built-in VS Code Tools and Unused Skills each show ten rows per page. Select a column heading to sort it; selecting the same heading again reverses the order. Sort and page choices remain in effect when the analysis refreshes while the panel stays open.

The MCP server list initially hides servers with usage. Turn off **Hide servers with usage** to include them; this filter is applied before paging, and the count and page range reflect the filtered rows. Its default order keeps zero-usage servers first, then partly used servers, then fully used servers. Built-in tools and unused skills initially sort by estimated overhead, highest first. The built-in tools section remains collapsed until opened.

## What Is Analyzed

### Available Tools (discovered on disk)

#### MCP Servers

The extension reads the following config files to build the list of configured MCP servers (checked in priority order, deduplicated by server name):

| Location | Scope | Editor |
|---|---|---|
| `<workspace>/.vscode/mcp.json` | Workspace | VS Code |
| `<workspace>/.mcp.json` | Workspace / repo root | Visual Studio |
| `<workspace>/.vs/mcp.json` | Solution-scoped | Visual Studio |
| `<workspace>/.cursor/mcp.json` | Workspace | Cursor |
| `%USERPROFILE%/.mcp.json` (Windows) / `~/.mcp.json` (macOS/Linux) | User-global | Visual Studio |

All files share the same JSON schema: `{ "servers": { "<name>": { ... } } }`.

#### Skill Files

Skill files (`SKILL.md`) are discovered from the following directories:

**Workspace-scoped** (relative to each workspace folder):

| Directory | Editor |
|---|---|
| `.github/skills/` | VS Code / GitHub Copilot |
| `.claude/skills/` | Visual Studio |
| `.agents/skills/` | Visual Studio |

**User-scoped** (in the home directory):

| Directory | Editor |
|---|---|
| `~/.copilot/skills/` | Visual Studio |
| `~/.claude/skills/` | Visual Studio |
| `~/.agents/skills/` | Visual Studio |

Each skill entry's description is extracted from the first `description:` line or `# Heading` in `SKILL.md`.

#### Extension/Runtime Tools

Tools registered via `vscode.lm.tools` at runtime are enumerated separately. MCP tools discovered this way are matched back to their server name via the `mcp__<server>__<tool>` naming convention.

### Used Tools (from session analysis)

Tool usage is counted from the look-back window configured via the **`aiEngineeringFluency.curation.timeWindowDays`** setting (default: 30 days, options: 7 / 30 / 90).

- **MCP server usage**: counted from `mcpTools.byServer` in the aggregated usage period
- **Tool call usage**: counted from `toolCalls.byTool` across all sessions in the window

## Recommendations

The curation analysis produces two types of recommendations:

### `disable-mcp-server`

Triggered when **zero** calls were made to any tool from an MCP server in the look-back window.

Includes an estimated token saving based on the combined description length of all tools from that server.

### `refine-skill`

Triggered when a skill file was **not invoked** during the look-back window. The recommendation suggests updating the skill's description (to improve discoverability) or removing it to reduce instruction-file bloat.

## Settings

| Setting | Type | Default | Description |
|---|---|---|---|
| `aiEngineeringFluency.curation.timeWindowDays` | `number` | `30` | Look-back window for determining "used" vs "unused" tools. Options: `7`, `30`, `90`. |

## Commands

| Command | Description |
|---|---|
| `aiEngineeringFluency.openMcpJson` | Opens the first MCP config file found in the workspace (checks `.vscode/mcp.json`, `.mcp.json`, `.vs/mcp.json`, `.cursor/mcp.json` and user `~/.mcp.json` in priority order; offers to create `.vscode/mcp.json` if none exist). |

## Architecture

The curation logic lives in `src/toolCuration.ts`. The module is intentionally pure (no direct VS Code API calls) so it can be reused by the CLI.

| Function | Purpose |
|---|---|
| `enumerateRuntimeTools(tools)` | Converts `vscode.lm.tools` into `AvailableToolEntry[]` |
| `parseMcpJson(path)` | Parses a single `mcp.json` file and returns server names |
| `buildMcpEntriesFromJson(folderPaths)` | Discovers all MCP entries from all config locations |
| `discoverSkillEntries(folderPaths)` | Discovers all skill entries from workspace + home dirs |
| `analyzeToolCuration(available, usage, windowDays)` | Runs the full curation analysis |

Results are surfaced through:
- The **Tools tab** in the Usage Analysis webview (`src/webview/usage/main.ts`)
- The **Insights engine** (`src/insightsEngine.ts`) — adds `unused-mcp-servers` and `stale-skills` insight cards
- The **CLI** `curation` command (`cli/src/commands/curation.ts`)

## CLI Usage

```bash
copilot-token-tracker curation
copilot-token-tracker curation --json          # machine-readable output
copilot-token-tracker curation --days 7        # use 7-day window
```
