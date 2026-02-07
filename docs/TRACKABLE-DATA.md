---
title: Trackable Data from Copilot Session Logs
description: Comprehensive list of metrics that can be extracted from GitHub Copilot Chat session logs
lastUpdated: 2026-01-26
status: current
---
# Trackable Data from GitHub Copilot Session Logs

This document describes what data can be extracted and tracked from GitHub Copilot Chat session log files.

## Session File Locations

The extension scans multiple locations for session files:

### VS Code Variants
- **Workspace sessions**: `{AppData}/{VSCodeVariant}/User/workspaceStorage/{workspaceId}/chatSessions/*.json`
- **Global sessions**: `{AppData}/{VSCodeVariant}/User/globalStorage/emptyWindowChatSessions/*.json`
- **Copilot Chat global**: `{AppData}/{VSCodeVariant}/User/globalStorage/github.copilot-chat/**/*.json`

Supported variants: Code (Stable), Code - Insiders, Code - Exploration, VSCodium, Cursor

### Remote/Server Environments
- `~/.vscode-server/data/User`
- `~/.vscode-server-insiders/data/User`
- `~/.vscode-remote/data/User`

### Copilot CLI
- **Agent mode sessions**: `~/.copilot/session-state/*.jsonl` (JSONL format)

## File Formats

### JSON Files (.json)
Standard VS Code Copilot Chat sessions with structured request/response pairs.

### JSONL Files (.jsonl)
Copilot CLI and Agent mode sessions - one JSON event per line.

## Currently Tracked Metrics

### 1. Token Usage
**Data Source**: All text content in messages and responses

- **Input tokens**: Estimated from `message.parts[].text` and `message.text`
- **Output tokens**: Estimated from `response[].value` (text responses)
- **Model-specific**: Tracked per AI model using character-to-token ratios

**Method**: Character count × model-specific ratio

### 2. Session Counts
**Data Source**: File modification timestamps

- Sessions per day
- Sessions per month
- Total sessions

### 3. Interaction Counts
**Data Source**: `requests` array length (JSON) or user message events (JSONL)

- Interactions per session
- Average interactions per session

### 4. Model Usage
**Data Source**: `result.details` field or `modelId` field

Detected models include:
- GPT-4, GPT-4.1, GPT-4o, GPT-4o Mini, GPT-3.5 Turbo, GPT-5 variants
- Claude Sonnet 3.5, 3.7, 4, 4.5, Opus variants, Haiku variants
- Gemini 2.5 Pro, 3 Flash, 3 Pro
- o3-mini, o4-mini, Grok, Raptor

### 5. Editor Usage
**Data Source**: File path patterns

Tracked editors:
- VS Code (Stable, Insiders, Exploration, Server)
- VSCodium
- Cursor
- Copilot CLI
- Unknown

### 6. Cost Estimation
**Data Source**: Token counts × model pricing

- Input/output token costs calculated separately
- Fallback to default pricing for unknown models

### 7. Environmental Impact
**Data Source**: Token usage

- CO₂ emissions estimate (~0.2g CO₂e per 1000 tokens)
- Tree equivalent (based on annual CO₂ absorption)
- Water usage estimate (~0.3L per 1000 tokens)

## Newly Added Metrics (Usage Analysis Dashboard)

### 8. Interaction Modes
**Data Source**: `mode.id` at session level, `agent.id` at request level, and file format

- **Ask Mode**: Regular chat panel conversations (session.mode.id is not "agent", and request has no agent.id or non-edits agent)
- **Edit Mode**: Inline code editing interactions (detected from `agent.id = "github.copilot.editsAgent"`)
- **Agent Mode**: Autonomous coding agent (detected from `mode.id = "agent"` at session level, OR JSONL format files from Copilot CLI)

**Important Notes:**
- Agent mode is primarily determined at the **session level** via `mode.id = "agent"`
- Individual requests in agent mode sessions may not have a specific `agent.id`
- The `"github.copilot.editsAgent"` specifically indicates inline editing, NOT agent mode
- All `.jsonl` files (from `~/.copilot/session-state/`) are agent mode by definition

### 9. Context References
**Data Source**: Pattern matching in message text

References detected via regex:
- `#file` - Specific file references
- `#selection` - Selected code/text references
- `#symbol` - Code symbol references (functions, classes, variables)
- `#codebase` - Entire codebase references
- `#terminalLastCommand` - Last command run in terminal
- `#terminalSelection` - Selected terminal output
- `#clipboard` - Clipboard contents
- `#changes` - Uncommitted git changes
- `#outputPanel` - Output panel contents
- `#problemsPanel` - Problems panel contents
- `@workspace` - Workspace-wide context
- `@terminal` - Terminal/command-line context
- `@vscode` - VS Code settings/environment

Also detected in `variableData` objects for @ references.

### 10. Tool Calls
**Data Source**: Response items and metadata

Detected from:
- Response items with `kind: "toolInvocationSerialized"` or `kind: "prepareToolInvocation"`
- `result.metadata` containing tool call information
- JSONL events with `type: "tool.call"` or `type: "tool.result"`

Tracks:
- Total number of tool calls
- Breakdown by tool name
- Tool call patterns per session

### 11. MCP (Model Context Protocol) Tools
**Data Source**: MCP-specific response items and events

Detected from:
- Response items with `kind: "mcpServersStarting"` and `didStartServerIds`
- JSONL events with `type: "mcp.tool.call"` or containing `mcpServer` in data

Tracks:
- Total MCP invocations
- Usage by MCP server
- Usage by specific MCP tool

## Data Not Currently Tracked

The following data is present in session files but not currently tracked:

### Available but Not Used
- `sessionId` - Unique session identifier
- `creationDate` - Session creation timestamp
- `lastMessageDate` - Last message timestamp
- `customTitle` - User-defined session title
- `timestamp` - Individual request timestamps
- `result.timings` - Performance timing data (firstProgress, totalElapsed)
- `followups` - Suggested follow-up questions
- `codeCitations` - Public code citations
- `contentReferences` - Referenced content details
- `attachments` - Attached files/resources
- `selections` - Editor selections/cursor positions
- `responseMarkdownInfo` - Markdown rendering info
- `timeSpentWaiting` - User wait time

### Potential Future Metrics
- Response time patterns
- Follow-up question acceptance rate
- Code citation frequency
- Attachment types and sizes
- Session duration
- Error rates
- Re-try patterns
- Context window usage percentage
- Premium request detection

## Detection Methods

### Pattern Matching
- Context references: Regex patterns in message text
- Models: String matching in `result.details`
- Editors: Path pattern matching

### Structure Analysis
- Modes: Field-based detection in session metadata
- Tool calls: Response item kind detection
- MCP tools: Specific response item types

### Heuristics
- Token estimation: Character count × model-specific ratio
- Cost calculation: Token count × pricing data

## Data Privacy

All analysis is performed locally on session log files:
- No data is sent to external servers
- Diagnostic reports only include aggregated statistics
- File paths and metadata only (no message content)
- User can review all collected data in the dashboard

## Accuracy Considerations

### High Accuracy
- Session counts (exact)
- Interaction counts (exact)
- Editor detection (exact)
- Mode detection (high accuracy)

### Estimated/Heuristic
- Token counts (estimated via character count)
- Context references (pattern matching may have false positives)
- Tool call detection (may miss non-standard formats)
- Cost estimation (based on reference pricing, not actual billing)

### Time-Based Limitations
- Uses file modification time for date grouping
- Not the exact session creation/interaction time
- Historical data limited to existing files

## Extensibility

The architecture supports adding new metrics:

1. **Add detection logic** in `analyzeSessionUsage()` function
2. **Extend interfaces** (SessionUsageAnalysis, UsageAnalysisPeriod)
3. **Update merge logic** in `mergeUsageAnalysis()`
4. **Update HTML generation** in `getUsageAnalysisHtml()`
5. **Document** in USAGE-ANALYSIS.md

Example use cases for future additions:
- Custom organization-specific patterns
- Language-specific usage patterns
- Error/warning detection
- Success rate metrics
- Response quality indicators (if data becomes available)

## References

- [Session File Schema Documentation](logFilesSchema/session-file-schema.json)
- [Usage Analysis Dashboard Documentation](USAGE-ANALYSIS.md)
- [VS Code Variants Documentation](logFilesSchema/VSCODE-VARIANTS.md)
