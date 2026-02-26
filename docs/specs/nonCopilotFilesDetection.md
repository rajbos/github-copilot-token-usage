# Plan: Non-Copilot Instruction File Detection (Missed Potential)

**Status**: Design - Ready for Implementation

## Context

The extension currently tracks Copilot-specific customization files (`.github/copilot-instructions.md`, `SKILL.md`, etc.) and displays them in a matrix on the Usage Analysis dashboard. The goal is to identify repositories that have instruction files for OTHER AI tools (Cursor, Windsurf, Claude, etc.) but NO Copilot files - representing "missed potential" where translating those files would benefit Copilot adoption.

## Discovery Findings

### Existing Infrastructure
1. **Workspace tracking**: `resolveWorkspaceFolderFromSessionPath()` maps sessions → workspace folders
2. **File scanning**: `scanWorkspaceCustomizationFiles()` scans for files defined in `customizationPatterns.json`
3. **Caching**: Results cached in `_customizationFilesCache`
4. **Display**: Customization matrix on Usage Analysis dashboard shows workspace × file type grid with ✅/⚠️/❌ status
5. **Architecture**: All logic in `CopilotTokenTracker` class (`src/extension.ts`)

### Non-Copilot Tools to Detect
This list merges the original and Agent Configs table for comprehensive detection:

- **Amazon Q**: `.amazonq/rules/*.md`
- **Claude Code**: `.claude/settings.json` (other Claude instructions are compatible with Copilot, so we won't count `CLAUDE.md` as non-Copilot)
- **Gemini CLI / Google Gemini**: `GEMINI.md`, `.gemini/`
- **Cursor**: `.cursorrules`, `.cursor/rules/*.md`, `.cursor/rules/*.mdc`
- **Windsurf**: `.windsurfrules` (legacy), `.windsurf/rules/` (new), `.windsurf/skills/`, `.windsurf/workflows/*.md`, `global_rules.md`
- **Aider**: `.aider.conf.yml`
- **Continue**: `.continue/`, `.continuerc.json`, `config.json`
- **Cline**: `.clinerules`
- **JetBrains AI / Junie**: `.aiassistant/rules/*.md`, `.junie/`, `.junie/guidelines.md`
- **OpenAI Codex**: `.codex/`, `CODEX.md`
- **Roo Code**: `.roo/`
- **Amp (Sourcegraph)**: `AGENTS.md` (AGENTS.md is Copilot compatible, so we won't count it as non-Copilot)
- **Entire HQ**: `.entire/`
- **OpenCode**: `opencode.json`, `.opencode/`
- **Zed**: `.rules`
- **Trae**: `.trae/rules/`

**Notes:**
- Some tools use both config files and directories (e.g., `.claude/`, `.agents/`, `.junie/`).
- Copilot accepts the following files (all others are non-Copilot):
  - `.github/copilot-instructions.md`
  - `.github/instructions/*.md`
  - `.github/**/SKILL.md`
  - `**/AGENT.md`
  - `.github/agents/*.md`
  - `.github/prompts/*.md`
  - `CLAUDE.md`
  - `.claude/CLAUDE.md`
- The detection logic should be extensible to support new tools by adding their config/instruction patterns here and in `customizationPatterns.json`.

## User Requirements (Confirmed)

1. **Display Location**: Separate section below existing matrix, showing ONLY workspaces with missed potential
2. **Detection Scope**: Flag workspaces that have non-Copilot AI instruction files BUT NO Copilot files
3. **Visual Treatment**: Warning background color + '⚠️ Missed Potential' badge
4. **Action Items**: Informational only (no conversion features yet) > point to https://code.visualstudio.com/docs/copilot/customization/custom-instructions for next steps

## Implementation Approach

Two-category system:
- **Copilot files**: Existing patterns in `customizationPatterns.json` (type: instructions/skill/agent/mcp-config/coding-agent)
- **Non-Copilot files**: New patterns with `category: "non-copilot"` flag

Detection logic:
- `hasCopilotFiles = any Copilot-category file exists`
- `hasNonCopilotFiles = any non-Copilot-category file exists`
- `missedPotential = hasNonCopilotFiles && !hasCopilotFiles`

---

## Implementation Plan

### TL;DR
Add detection of non-Copilot AI instruction files (Cursor, Windsurf, Claude, etc.) to identify "missed potential" - repositories using other AI tools but lacking Copilot customization. Display these workspaces in a separate warning section on the Usage Analysis dashboard.

### Steps

**Phase 1: Extend Data Model** *(parallel with Phase 2)*

1. **Add non-Copilot patterns to `customizationPatterns.json`**
   - Add `category` field to each pattern: `"copilot"` or `"non-copilot"`
   - Add 9 new patterns for non-Copilot tools (see table above)
   - Mark all existing patterns as `category: "copilot"`
   - Reference: existing patterns use `id`, `type`, `icon`, `label`, `path`, `scanMode`

2. **Update TypeScript interfaces in `extension.ts`**
   - Add `category?: "copilot" | "non-copilot"` to pattern type
   - Add `category?: string` field to `CustomizationFileEntry` interface
   - Add new interface: `MissedPotentialWorkspace` with `workspacePath`, `workspaceName`, `sessionCount`, `interactionCount`, `nonCopilotFiles: CustomizationFileEntry[]`

**Phase 2: Extend Scanning Logic** *(parallel with Phase 1)*

3. **Modify `scanWorkspaceCustomizationFiles()`** in `extension.ts`
   - Already returns `CustomizationFileEntry[]` with metadata
   - Add `category` field from pattern to each entry
   - No other changes needed (method already handles all scanModes)

**Phase 3: Detection Logic** *(depends on Phase 1, 2)*

4. **Create `detectMissedPotential()` method** in `extension.ts` (around line 2400, near customization matrix logic)
   - Input: `workspaceSessionCounts: Map<string, number>`, `workspaceInteractionCounts: Map<string, number>`
   - For each workspace in the map:
     - Get cached files: `this._customizationFilesCache.get(workspacePath)`
     - Split by category: `copilotFiles = files.filter(f => f.category === "copilot")` 
     - Split by category: `nonCopilotFiles = files.filter(f => f.category === "non-copilot")`
     - If `nonCopilotFiles.length > 0 && copilotFiles.length === 0`: add to `missedPotential` array
   - Return: `MissedPotentialWorkspace[]` sorted by interaction count (descending)

5. **Integrate into `calculateUsageAnalysisStats()`** around line 2428
   - After building customization matrix, call `detectMissedPotential()`
   - Store result in `UsageAnalysisStats` interface (add `missedPotential?: MissedPotentialWorkspace[]` field)
   - Pass to webview via `_lastUsageAnalysisStats`

**Phase 4: UI Display** *(depends on Phase 3)*

6. **Update webview interfaces** in `src/webview/usage/main.ts`
   - Add `MissedPotentialWorkspace` interface (matching extension.ts)
   - Add `missedPotential?: MissedPotentialWorkspace[]` to `UsageAnalysisStats` interface
   - Add to `Window.__INITIAL_USAGE__` type

7. **Create `renderMissedPotential()` function** in `src/webview/usage/main.ts` (around line 300)
   - If no missed potential: return empty string
   - Otherwise render section with:
     - Title: "⚠️ Missed Potential: Non-Copilot Instruction Files"
     - Subtitle: "These workspaces use other AI tools but lack Copilot customizations"
     - Table with columns: Workspace | Sessions | Interactions | Non-Copilot Files Found
     - Row styling: warning background (`background: rgba(251, 191, 36, 0.1); border: 1px solid rgba(251, 191, 36, 0.3)`)
     - Workspace name with '⚠️' badge
     - Non-Copilot Files column: expandable list with file icons + paths
     - Legend explaining the tools detected

8. **Integrate into layout** in `renderLayout()` function
   - Call `renderMissedPotential(stats)` after existing customization matrix HTML
   - Insert HTML in layout around line 280 (after customizationHtml but before the main stats sections)

**Phase 5: Testing & Documentation** *(depends on Phase 4)*

9. **Test with sample repositories**
   - Create test workspaces with each non-Copilot file type
   - Verify detection works for each scanMode (exact, oneLevel, recursive)
   - Verify workspaces with both Copilot + non-Copilot files are NOT flagged
   - Verify sorting by interaction count

10. **Update documentation**
   - Add section to `docs/specs/customization-files.md` about non-Copilot file detection
   - Update `src/README.md` with instructions for maintaining the non-Copilot patterns
   - Add to CHANGELOG.md as a new feature

### Relevant Files

- [src/customizationPatterns.json](src/customizationPatterns.json) — Add non-Copilot patterns with `category` field, mark existing as "copilot"
- [src/extension.ts](src/extension.ts) — Around line 240: Update interfaces (CustomizationFileEntry, UsageAnalysisStats). Around line 506: Update scanWorkspaceCustomizationFiles to capture category. Around line 2400: Add detectMissedPotential() method. Around line 2428: Call detectMissedPotential in calculateUsageAnalysisStats
- [src/webview/usage/main.ts](src/webview/usage/main.ts) — Around line 76: Add interfaces. Around line 300: Add renderMissedPotential(). Around line 280: Integrate into renderLayout()
- [docs/specs/customization-files.md](docs/specs/customization-files.md) — Document the new feature
- [src/README.md](src/README.md) — Update maintenance instructions

### Verification

1. **Unit tests**: Create test workspace paths with mock file structures. Call detectMissedPotential() and verify results.
2. **Integration test**: Run extension in dev mode (F5), create test workspaces with various file combinations:
   - Workspace A: Only `.cursor/rules/test.md` → should appear in missed potential
   - Workspace B: `.cursor/rules/test.md` + `.github/copilot-instructions.md` → should NOT appear
   - Workspace C: Only `.github/copilot-instructions.md` → should NOT appear
   - Workspace D: `CLAUDE.md` + `GEMINI.md` (multiple non-Copilot) → should appear
3. **Visual check**: Open Usage Analysis dashboard, verify:
   - Missed potential section appears with correct styling
   - Warning background color on rows
   - '⚠️' badge on workspace names
   - File list is readable and correctly grouped
   - Legend explains what each file type means
4. **Performance check**: Verify scanning doesn't slow down stats calculation significantly (add timing logs if needed)

### Decisions

- **Category approach**: Use `category` field instead of boolean `isCopilot` to allow future extensibility (e.g., "deprecated", "experimental")
- **Sorting**: Sort missed potential by interaction count (descending) to prioritize active workspaces
- **Unresolved workspaces**: Not included in missed potential (can't scan filesystem without path)
- **Config files vs. instructions**: Include config files (`.aider.conf.yml`, `.continuerc.json`) as they indicate tool usage even if not markdown instructions
- **Staleness**: Non-Copilot files don't use staleness checking (no ⚠️ state, only ✅ present or ❌ missing)
- **Display priority**: Missed potential section shown AFTER the existing customization matrix to maintain context flow

### Further Considerations

1. **Translation Guide**: Future enhancement - link to documentation explaining how to convert each file type to Copilot format. Out of scope for this plan.
2. **AI-powered conversion**: Future enhancement - button to auto-convert using Copilot/LLM. Very complex, out of scope.
3. **Workspace-level recommendations**: Could add specific recommendations per workspace (e.g., "Convert CLAUDE.md → .github/copilot-instructions.md"). Defer to user feedback.

---

## Non-Copilot File Patterns to Add

Based on user's table, each pattern needs:
- `id`: unique identifier (kebab-case)
- `type`: logical grouping (use `"non-copilot-instructions"` for consistency)
- `category`: `"non-copilot"` (NEW field)
- `icon`: appropriate emoji
- `label`: tool name + file type
- `path`: file path pattern
- `scanMode`: "exact", "oneLevel", or "recursive"
- `maxDepth`: if recursive (optional)
- `caseInsensitive`: true/false (optional)

### Pattern Specs

1. **Amazon Q Rules**
   ```json
   { "id": "amazonq-rules", "type": "non-copilot-instructions", "category": "non-copilot", 
     "icon": "🟠", "label": "Amazon Q Rules", 
     "path": ".amazonq/rules/*.md", "scanMode": "oneLevel" }
   ```

2. **Claude Code**
   ```json
   { "id": "claude-code", "type": "non-copilot-instructions", "category": "non-copilot",
     "icon": "🎭", "label": "Claude Code", 
     "path": "CLAUDE.md", "scanMode": "exact", "caseInsensitive": true }
   ```

3. **Gemini CLI**
   ```json
   { "id": "gemini-cli", "type": "non-copilot-instructions", "category": "non-copilot",
     "icon": "💎", "label": "Gemini CLI", 
     "path": "GEMINI.md", "scanMode": "exact", "caseInsensitive": true }
   ```

4. **Cursor Rules (Markdown)**
   ```json
   { "id": "cursor-rules-md", "type": "non-copilot-instructions", "category": "non-copilot",
     "icon": "🔷", "label": "Cursor Rules", 
     "path": ".cursor/rules/*.md", "scanMode": "recursive", "maxDepth": 2 }
   ```

5. **Cursor Rules (MDC)**
   ```json
   { "id": "cursor-rules-mdc", "type": "non-copilot-instructions", "category": "non-copilot",
     "icon": "🔷", "label": "Cursor Rules (MDC)", 
     "path": ".cursor/rules/*.mdc", "scanMode": "recursive", "maxDepth": 2 }
   ```

6. **Windsurf Rules**
   ```json
   { "id": "windsurf-rules", "type": "non-copilot-instructions", "category": "non-copilot",
     "icon": "🌊", "label": "Windsurf Rules", 
     "path": ".windsurf/rules/*.md", "scanMode": "recursive", "maxDepth": 2 }
   ```

7. **Windsurf Workflows**
   ```json
   { "id": "windsurf-workflows", "type": "non-copilot-instructions", "category": "non-copilot",
     "icon": "🌊", "label": "Windsurf Workflows", 
     "path": ".windsurf/workflows/*.md", "scanMode": "recursive", "maxDepth": 2 }
   ```

8. **Windsurf Global Rules**
   ```json
   { "id": "windsurf-global", "type": "non-copilot-instructions", "category": "non-copilot",
     "icon": "🌊", "label": "Windsurf Global Rules", 
     "path": "global_rules.md", "scanMode": "exact", "caseInsensitive": true }
   ```

9. **aider Config**
   ```json
   { "id": "aider-config", "type": "non-copilot-config", "category": "non-copilot",
     "icon": "🤖", "label": "aider Config", 
     "path": ".aider.conf.yml", "scanMode": "exact" }
   ```

10. **Continue Config (RC)**
    ```json
    { "id": "continue-rc", "type": "non-copilot-config", "category": "non-copilot",
      "icon": "➡️", "label": "Continue Config", 
      "path": ".continuerc.json", "scanMode": "exact" }
    ```

**Example for future pattern addition:**
```json
{ "id": "opencode-config", "type": "non-copilot-config", "category": "non-copilot", "icon": "🟢", "label": "OpenCode Config", "path": "opencode.json", "scanMode": "exact" }
```
11. **Continue Config**
    ```json
    { "id": "continue-config", "type": "non-copilot-config", "category": "non-copilot",
      "icon": "➡️", "label": "Continue Config", 
      "path": "config.json", "scanMode": "exact" }
    ```
    Note: Generic filename, may need context checking or exclude from root scan

12. **Cline Rules**
    ```json
    { "id": "cline-rules", "type": "non-copilot-instructions", "category": "non-copilot",
      "icon": "🧵", "label": "Cline Rules", 
      "path": ".clinerules", "scanMode": "exact" }
    ```

13. **JetBrains AI Rules**
    ```json
    { "id": "jetbrains-ai", "type": "non-copilot-instructions", "category": "non-copilot",
      "icon": "🧠", "label": "JetBrains AI Rules", 
      "path": ".aiassistant/rules/*.md", "scanMode": "recursive", "maxDepth": 2 }
    ```
