# Session File Schema Documentation

This directory contains documentation and analysis of AI tool session file schemas.

## Files

### session-file-schema.json
**Manually curated documentation** of the GitHub Copilot session file structure. This file describes:
- File locations and formats (.json and .jsonl)
- Complete schema for JSON session files
- Complete schema for JSONL session files (both Copilot CLI and VS Code Incremental formats)
- Links to official vscode-copilot-chat repository source code
- Which fields the extension actually uses
- Detailed descriptions and examples

This is the **primary reference** for understanding Copilot session file structure.

### claude-code-session-schema.json
**Manually curated documentation** of the Claude Code (Anthropic CLI/IDE extension) session file structure. This file describes:
- File locations: `~/.claude/projects/{project-hash}/{session-uuid}.jsonl` and subagent files
- All event types: `user`, `assistant`, `queue-operation`, `file-history-snapshot`, `ai-title`
- The `assistant.message.usage` object containing **actual Anthropic API token counts** (no estimation needed)
- Prompt cache token fields: `cache_creation_input_tokens`, `cache_read_input_tokens`
- Sub-agent session structure and how it differs from the main session
- The `~/.claude/stats-cache.json` pre-aggregated stats format
- Integration guidance for extending the token tracker to support Claude Code

### jetbrains-session-schema.json
**Manually curated documentation** of the GitHub Copilot for JetBrains IDE session file structure. This file describes:
- File locations: `~/.copilot/jb/{conversationId}/partition-{n}.jsonl`
- All event types: `partition.created`, `user.message`, `user.message_rendered`, `assistant.turn_start`, `assistant.message`, `tool.execution_start`, `tool.execution_complete`, `assistant.turn_end`
- Token estimation rules (no actual token counts are recorded — estimation is required)
- Mode detection heuristic (presence of `tool.execution_start` ⇒ agent mode; otherwise ask)
- Model attribution heuristic from `toolCallId` prefix (`toolu_*` ⇒ Anthropic, `call_*` ⇒ OpenAI)
- Why the JetBrains JSONL must NOT be conflated with the Copilot CLI JSONL under `~/.copilot/session-state/`

### devin-windsurf-session-format.md
**Research documentation** of Devin (Cognition Labs' desktop IDE) and its relationship to
Windsurf. Devin is a direct fork/rebrand of Windsurf and shares the exact same Cascade
`.pb` trajectory storage, bundled `codeium.windsurf` extension, and gRPC API — covers the
**desktop app only**. This file documents:
- The `product.json` / `oldDataFolderName` evidence that Devin is a Windsurf fork
- Why `src/windsurf.ts` (`WindsurfDataAccess`) is the single data access layer for both editors
- How live sessions are attributed to "Windsurf" vs. "Devin" based on `vscode.env.appName`
- The known limitation for file-based `.pb` fallback discovery (always labeled "Windsurf")
- A cross-reference to devin-cli-session-format.md for the separate Devin CLI tool

### devin-cli-session-format.md
**Research documentation** of Devin CLI (Cognition Labs' separate, ACP-based CLI agent
tool — distinct from the Devin desktop app above). Integrated as a regular
`IEcosystemAdapter` (`DevinCliAdapter`/`DevinCliDataAccess`), not a special case. This file
documents:
- The global `sessions.db` SQLite schema (`sessions`, `message_nodes` tree via
  `parent_node_id`/`main_chain_id`, `prompt_history`, `tool_call_state`)
- Best-effort `chat_message` JSON parsing inferred from the ACP v2 protocol schema
- Why token counts are estimated (ACP has no per-message token counts; `cogs_json` field
  names are guessed defensively) rather than actual API usage
- The known limitation that all data tables were empty on the machine this was researched
  on, so the schema is confirmed but example values are not

### gemini-cli-session-format.md
**Research documentation** of an observed Gemini CLI session format on Windows. This file describes:
- File locations under `~/.gemini/`
- The observed `session-*.jsonl` event stream format
- Actual token fields in assistant records (`input`, `output`, `cached`, `thoughts`, `tool`, `total`)
- Turn reconstruction rules, including deduping assistant updates by `id`
- Why the observed format differs from TokTrack's current Gemini parser assumptions
- Why the logs are sufficient for token totals, session lists, and chat turn rendering

### hydrafusion-routing-events.md
**Schema documentation** of the HydraFusion routing events the Copilot CLI writes into its
own `~/.copilot/session-state/{id}/events.jsonl`. HydraFusion is a synthetic model that runs
several real models per turn; the CLI shows you one answer and one credit number, and these
events are the only record of what ran behind it. This file documents:
- The four event types (`session.fusion_resolved`, `assistant.fusion_phase_completed`,
  `session.fusion_handoff`, `session.fusion_completed`) and every field on them
- The accounting rules that separate a correct reading from a plausible one — above all that
  the turn rollup and its phase events are the same credits counted twice
- Why review spend, final-source attribution and planned-but-skipped legs are the numbers
  worth surfacing, with calibration figures from a real 24-turn session
- Which fields are deliberately discarded (all model output: `content`, `projectionMessage`,
  handoff `message`)

Parsed by [`src/hydrafusion.ts`](../../src/hydrafusion.ts); rendered as the "⚡ HydraFusion
Routing" section of the Session Log Viewer.


### session-file-schema-analysis.json
**Auto-generated analysis** from actual session files on disk. Generated by running:
```powershell
.\.github\skills\copilot-log-analysis\analyze-session-schema.ps1
```

Contains:
- All discovered field paths with types (no field values: example values are
  opt-in via `-IncludeExamples` and must never be committed, since they are
  copied verbatim from your prompts and session titles)
- Field occurrence counts
- Detection of new fields not in the manual documentation

## Session File Formats

The extension supports the following session file formats:

| Format | Tool | Extension | Location | Discriminator |
|--------|------|-----------|----------|---------------|
| **JSON** | GitHub Copilot | `.json` | workspaceStorage, globalStorage | N/A (standard JSON) |
| **JSONL CLI** | GitHub Copilot | `.jsonl` | `~/.copilot/session-state/` | `type` field (string) |
| **JSONL Incremental** | GitHub Copilot | `.jsonl` | workspaceStorage (VS Code Insiders) | `kind` field (number) |
| **JSONL Claude Code** | Claude Code (Anthropic) | `.jsonl` | `~/.claude/projects/{hash}/` | Path-based: `~/.claude/` prefix |

### JSONL Format Detection

When processing `.jsonl` files, the extension checks:
1. If lines have a `kind` field (number) → **VS Code Incremental format**
2. If lines have a `type` field (string) → **Copilot CLI format**

### VS Code Incremental Format (New in 2026)

VS Code Insiders introduced a new incremental JSONL format that stores session data as deltas:
- `kind: 0` - Session header with metadata
- `kind: 1` - Delete operation (rare)
- `kind: 2` - Insert/Update with request data

See `session-file-schema.json` → `jsonlIncrementalSchema` for full details.

### Claude Code Format (New)

Claude Code (Anthropic's CLI/IDE extension) writes sessions to `~/.claude/projects/{project-hash}/{session-uuid}.jsonl`:
- Each line is a `user`, `assistant`, `queue-operation`, `file-history-snapshot`, or `ai-title` event
- **Key advantage**: Assistant events contain actual Anthropic API token counts in `message.usage` — no estimation needed
- Includes prompt cache fields: `cache_creation_input_tokens`, `cache_read_input_tokens`
- Sub-agents are stored in `{session-uuid}/subagents/{agent-id}.jsonl`

See `claude-code-session-schema.json` for full details.

### Gemini CLI Format

An observed Windows Gemini CLI installation wrote sessions to:

```text
~/.gemini/tmp/<project>/chats/session-*.jsonl
```

The integrated Gemini CLI support is based on the observed format, which contains:

- session metadata in a header line
- `user` turn records with plain-text prompts
- `gemini` turn records with actual token counts
- `thoughts[]` and `toolCalls[]` payloads
- enough information to reconstruct session lists and turn timelines

See `gemini-cli-session-format.md` for the full analysis and integration notes.

## Official Source References

The session file schemas are defined in the following repositories:

- [vscode-copilot-chat](https://github.com/microsoft/vscode-copilot-chat):
  - [Chat Session Provider](https://github.com/microsoft/vscode-copilot-chat/blob/main/src/extension/vscode.proposed.chatSessionsProvider.d.ts) - Session metadata interfaces
  - [Edit Log Service](https://github.com/microsoft/vscode-copilot-chat/blob/main/src/platform/multiFileEdit/common/editLogService.ts) - Edit logging
  - [Session Content Builder](https://github.com/microsoft/vscode-copilot-chat/blob/main/src/extension/chatSessions/vscode-node/copilotCloudSessionContentBuilder.ts) - Streaming responses
  - [Workspace Recorder](https://github.com/microsoft/vscode-copilot-chat/blob/main/src/extension/workspaceRecorder/vscode-node/workspaceRecorder.ts) - JSONL logging
- [OpenCode](https://github.com/anomalyco/opencode):
  - OpenCode session log and database schema

## Updating the Schema

### When to Update

Run the analysis script periodically to detect schema changes:
- After GitHub Copilot updates
- When adding new features to the extension
- Monthly check for new fields

### How to Update

1. **Run the analysis script:**
   ```powershell
   .\.github\skills\copilot-log-analysis\analyze-session-schema.ps1 -MaxFiles 10
   ```

2. **Review new fields detected:**
   The script will highlight any new field paths found that aren't in `session-file-schema.json`

3. **Investigate new fields:**
   - Open `session-file-schema-analysis.json`
   - Look for new field paths in the `newFieldsDetected` section
   - Check the `fields` section for type and occurrence count
   - Need sample values? Re-run with `-IncludeExamples -OutputFile` pointing
     outside the repository, and keep that file local

4. **Update manual documentation:**
   - Add newly discovered fields to `session-file-schema.json`
   - Add descriptions and note whether the extension should use them
   - Update the version and lastUpdated date

5. **Consider extension updates:**
   - If new fields contain useful data (e.g., actual token counts), consider updating the extension to use them
   - Update the extension's parsing logic in `src/extension.ts`

## Script Parameters

The analysis script accepts several parameters:

```powershell
# Analyze more files for better coverage
.\.github\skills\copilot-log-analysis\analyze-session-schema.ps1 -MaxFiles 20

# Save to a different location
.\.github\skills\copilot-log-analysis\analyze-session-schema.ps1 -OutputFile "temp-analysis.json"

# Skip comparison with existing documentation
.\.github\skills\copilot-log-analysis\analyze-session-schema.ps1 -CompareWithExisting $false

# Include up to 3 example values per field (private: write outside the repo)
.\.github\skills\copilot-log-analysis\analyze-session-schema.ps1 -IncludeExamples -OutputFile "$env:TEMP\schema-with-examples.json"
```

## Reading the Analysis Output

The `session-file-schema-analysis.json` file contains:

```json
{
  "generatedAt": "timestamp",
  "filesAnalyzed": {
    "json": 6,
    "jsonl": 3
  },
  "newFieldsDetected": {
    "json": [...],   // New fields not in documentation
    "jsonl": [...]
  },
  "jsonFileSchema": {
    "totalFields": 35269,
    "fields": {
      "fieldPath": {
        "type": "string|number|boolean|array|object",
        "count": 10,        // How many times seen
        "examples": [...]   // Only with -IncludeExamples; never commit
      }
    }
  },
  "jsonlFileSchema": { ... },
  "topLevelJsonFields": [...],
  "commonJsonlEventTypes": [...]
}
```

## Field Path Notation

- `fieldName` - Top-level field
- `parent.child` - Nested field
- `array[]` - Array items
- `array[].field` - Field in array items

Example: `requests[].response[].value` = the `value` field in items of the `response` array within items of the `requests` array.

## Common Tasks

### Find fields related to token counting
```powershell
$analysis = Get-Content docs\logFilesSchema\session-file-schema-analysis.json | ConvertFrom-Json
$analysis.jsonFileSchema.fields.PSObject.Properties | Where-Object { $_.Name -like "*token*" }
```

### Check what models are detected
```powershell
# Needs a local run with -IncludeExamples; the committed file has no values
$analysis = Get-Content "$env:TEMP\schema-with-examples.json" | ConvertFrom-Json
$analysis.jsonFileSchema.fields.'result.details'.examples
```

### List all JSONL event types
```powershell
$analysis = Get-Content docs\logFilesSchema\session-file-schema-analysis.json | ConvertFrom-Json
$analysis.commonJsonlEventTypes
```

## Notes

- The analysis script only processes the first few items in large arrays to keep the output manageable
- Fields that appear infrequently might indicate optional fields or special scenarios
- JSONL files typically have fewer unique field paths because events share common structure
