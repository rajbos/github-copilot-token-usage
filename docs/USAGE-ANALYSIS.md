---
title: Usage Analysis Dashboard
description: Guide to the Usage Analysis Dashboard features and tracked metrics
lastUpdated: 2026-01-26
status: current
---
# Usage Analysis Dashboard

## Overview

The Usage Analysis Dashboard provides insights into how you interact with GitHub Copilot by analyzing session log files. It tracks patterns in your prompting behavior, tool usage, and context references to help you understand and optimize your Copilot workflow.

## Accessing the Dashboard

You can access the Usage Analysis Dashboard in three ways:

1. **From the Details Panel**: Click the status bar item to open the details panel, then click the "📊 Usage Analysis" button
2. **From Command Palette**: Press `Ctrl+Shift+P` (Windows/Linux) or `Cmd+Shift+P` (macOS) and type "Show Usage Analysis Dashboard"
3. **Direct Command**: Run the command `AI Engineering Fluency: Show Usage Analysis Dashboard`

## Tracked Metrics

### 1. Interaction Modes

The dashboard tracks these interaction modes:

- **💬 Ask Mode (Chat)**: Regular conversational interactions where you ask Copilot questions or request explanations in the chat panel
- **✏️ Edit Mode**: Interactions where Copilot directly edits your code inline using the edits agent (triggered via inline edit UI or commands)
- **🤖 Agent Mode**: Autonomous task execution where Copilot operates as an independent agent in the chat panel
- **📋 Plan Mode / ⚡ Custom Agent**: Plan-mode and custom-agent (.agent.md) interactions
- **🖥️ CLI**: Interactions in terminal-based agent CLIs (Copilot CLI, Claude Code CLI, OpenCode, Crush, Mistral Vibe, Hermes, Pi, etc.)
- **✨ Copilot App**: Subset of Copilot CLI usage — sessions started via the Copilot desktop app (detected from `client_name: github/autopilot` in the session's `workspace.yaml`), broken out from terminal CLI usage
- **🖥️ Claude Desktop**: Claude Code sessions launched from the standalone Claude Desktop app (detected via the session's `entrypoint` field), broken out from terminal CLI usage
- **🧩 Claude (VS Code)**: Claude Code sessions running inside an IDE, e.g. the VS Code extension (also detected via `entrypoint`), broken out from terminal CLI usage

**Data Source**: 
- JSON files: 
  - Agent mode: `mode.id = "agent"` at session level
  - Edit mode: `agent.id = "github.copilot.editsAgent"` at request level
  - Ask mode: Default when neither agent nor edit mode indicators are present
- JSONL files: All treated as agent mode (Copilot CLI sessions)

**Key Points:**
- Agent mode is determined at the **session level**, not per-request
- When you start an agent mode session in VS Code, ALL interactions in that session count as agent mode
- Inline code edits (Edit Mode) use a specific agent ID and override the session mode
- JSONL files from `~/.copilot/session-state/` are always agent mode (Copilot CLI)

### 2. Context References

Tracks how often you provide different types of context to Copilot:

- **📄 #file**: References to specific files in your workspace
- **✂️ #selection**: References to selected code or text
- **🔤 #symbol**: References to code symbols (functions, classes, variables)
- **🗂️ #codebase**: References to the entire codebase for search/analysis
- **⌨️ #terminalLastCommand**: References to the last command run in terminal
- **🖱️ #terminalSelection**: References to selected terminal output
- **📋 #clipboard**: References to clipboard contents
- **📝 #changes**: References to uncommitted git changes
- **📤 #outputPanel**: References to output panel contents
- **⚠️ #problemsPanel**: References to problems panel contents
- **📁 @workspace**: References to workspace-wide context
- **💻 @terminal**: References to terminal or command-line context
- **🔧 @vscode**: References to VS Code settings or environment

**Data Source**: 
- Pattern matching in `message.text` and `message.parts[].text` fields
- Detection in `variableData` objects for @ references

### 3. Tool Calls

Monitors when Copilot invokes tools or functions during interactions:

- **Total count** of tool invocations
- **By tool name**: Breakdown showing which tools are used most frequently

**Data Source**:
- JSON files: 
  - Response items with `kind: "toolInvocationSerialized"` or `kind: "prepareToolInvocation"`
  - `result.metadata` fields containing tool call information
- JSONL files:
  - Events with `type: "tool.call"` or `type: "tool.result"`

### 4. MCP (Model Context Protocol) Tools

Tracks usage of MCP servers and tools:

- **Total MCP invocations**
- **By server**: Which MCP servers are being used
- **By tool**: Which specific MCP tools are being called

**Data Source**:
- JSON files:
  - Response items with `kind: "mcpServersStarting"` and `didStartServerIds`
- JSONL files:
  - Events with `type: "mcp.tool.call"` or containing `mcpServer` in data
  - Copilot CLI `tool.execution_start` events tagged with `data.mcpServerName` (their `toolName` is
    `<server>-<tool>`, e.g. `github-mcp-server-get_file_contents`, which the `mcp_`/`mcp__` prefix
    check does not match); these count as MCP usage only, never as regular tool calls

### 5. Tool Curation

The **Tools** tab includes a curation analysis section that compares the tools available in your environment against the tools actually used in the configured look-back window (default: last 30 days).

**Available tools are discovered from:**
- MCP config files: `.vscode/mcp.json`, `.mcp.json`, `.vs/mcp.json`, `.cursor/mcp.json`, and `~/.mcp.json`
- Skill directories: `.github/skills/`, `.claude/skills/`, `.agents/skills/` (workspace) and `~/.copilot/skills/`, `~/.claude/skills/`, `~/.agents/skills/` (user-level)
- Runtime tools registered via `vscode.lm.tools`

**Recommendations produced:**
- **Disable MCP server** — shown when no tools from an MCP server were called in the window, with an estimated token saving
- **Refine skill** — shown when a skill file was never invoked in the window

The look-back window is configurable via **`aiEngineeringFluency.curation.timeWindowDays`** (7 / 30 / 90 days). The MCP Servers, Built-in VS Code Tools and Unused Skills lists are sortable and page ten rows at a time; the MCP usage filter is applied before paging. See [Tool Curation](features/TOOL-CURATION.md#browsing-the-tables) for details.

See [features/TOOL-CURATION.md](features/TOOL-CURATION.md) for the full reference.

## Data Analysis Details

### Session File Processing

The extension analyzes two types of session files:

1. **JSON files** (`.json`): Standard VS Code Copilot Chat sessions
   - Located in: `{AppData}/{VSCodeVariant}/User/workspaceStorage/*/chatSessions/*.json`
   - Contains structured request/response pairs with detailed metadata

2. **JSONL files** (`.jsonl`): Copilot CLI and Agent mode sessions
   - Located in: `~/.copilot/session-state/*.jsonl`
   - Each line is a separate JSON event (user messages, assistant responses, tool calls)

### Time Periods

The dashboard shows metrics for two time periods:

- **📅 Today**: All sessions modified today (based on file modification time)
- **📊 Last 30 Days**: All sessions modified in the last 30 days

### Caching

Session analysis data is cached alongside token counts to improve performance:
- Cache is keyed by file path and modification time
- When a session file is updated, its analysis is recalculated
- Cache is cleared on extension reload

## Interpreting the Data

### Mode Usage Patterns

- **High Ask Mode**: You primarily use Copilot for questions and guidance
- **High Edit Mode**: You frequently use Copilot to directly modify code
- **High Agent Mode**: You leverage autonomous features or use Copilot CLI

### Context Reference Patterns

- **High #file usage**: You often work with specific files
- **High #selection usage**: You frequently reference selected code
- **High #terminalLastCommand usage**: You often ask about terminal commands or errors
- **High #changes usage**: You frequently review uncommitted changes with Copilot
- **High #outputPanel or #problemsPanel usage**: You use Copilot to debug build/test output
- **High @workspace usage**: You provide broad context for better suggestions
- **Low context usage**: Consider providing more context for better results

### Tool Call Patterns

- **Many tool calls**: Copilot is actively using functions to gather information or perform actions
- **Specific tools dominant**: Certain workflows trigger particular tool usage patterns
- **No tool calls**: Either not available for your use case or not being triggered by your prompts

### MCP Tool Patterns

- **MCP usage present**: You have MCP servers configured and they're being utilized
- **No MCP usage**: Either no MCP servers configured or they're not being triggered

## Tips for Optimization

1. **Provide Rich Context**: Use #file, #selection, #terminalLastCommand, #changes, and @workspace to give Copilot better context
2. **Try Different Modes**: Experiment with ask vs. edit mode for different tasks
3. **Leverage Agent Mode**: For complex tasks, consider using agent mode or Copilot CLI
4. **Monitor Tool Usage**: Tools can extend Copilot's capabilities - check which are being used
5. **Explore MCP**: If available, MCP tools can provide additional functionality
6. **Curate Your Tools**: Use the Tool Curation section to identify unused MCP servers and stale skills — disabling them reduces prompt overhead and token cost

## Technical Details

### Analysis Functions

The extension uses several key functions to analyze session files:

- `analyzeSessionUsage()`: Main analysis function that processes a session file
- `analyzeContextReferences()`: Pattern matching for context references in text
- `calculateUsageAnalysisStats()`: Aggregates analysis data across all sessions
- `mergeUsageAnalysis()`: Combines analysis data from multiple sessions
- `analyzeToolCuration()`: Compares available tools against used tools; produces curation recommendations

### Performance

- Analysis runs once per session file and is cached
- Cache invalidation occurs when file modification time changes
- Typical analysis time: <1ms per file (when cached), ~10-50ms per file (uncached)
- Analysis is performed asynchronously to avoid blocking the UI

## Limitations

1. **Estimation-Based**: Some metrics rely on pattern matching and heuristics
2. **File Modification Time**: Uses file mtime for date grouping, not actual session creation time
3. **Historical Data**: Only analyzes files that still exist on disk
4. **Pattern Matching**: Context references detected via regex may have false positives
5. **Tool Call Detection**: Some tool calls may not be captured if they use non-standard formats

## Future Enhancements

Potential future additions to the analysis dashboard:

- Daily/weekly trend charts for usage patterns
- Comparison with previous months
- Success rate tracking for different modes
- Average response times by mode
- Cost analysis per interaction type
- Custom pattern detection for organization-specific references

## Feedback

If you discover new patterns in session log files that should be tracked, or if you have suggestions for improving the analysis dashboard, please [open an issue](https://github.com/rajbos/ai-engineering-fluency/issues) on GitHub.
