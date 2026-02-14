# Fluency Level Viewer - Debug Feature

## Overview

The Fluency Level Viewer is a debug-only tool that displays all fluency score rules, thresholds, and tips for each category and stage. This feature is designed to help developers understand how the scoring system works and what actions trigger different fluency levels.

## Availability

**Important**: This feature is only available when a VS Code debugger is active. This is intentional to keep it as a development and testing tool rather than a production feature.

## How to Access

### When Debugger is Active

1. **From Fluency Score Dashboard:**
   - Open the Copilot Fluency Score panel (`Ctrl+Shift+P` → "Show Copilot Fluency Score")
   - If a debugger is active, you'll see a "🔍 Level Viewer" button in the header
   - Click the button to open the Level Viewer

2. **Via Command Palette:**
   - Press `Ctrl+Shift+P` (or `Cmd+Shift+P` on Mac)
   - Type "Show Fluency Level Viewer"
   - Run the command

### When Debugger is NOT Active

- The "🔍 Level Viewer" button will not appear in the Fluency Score dashboard
- If you try to run the command directly, you'll see a warning message: "Fluency Level Viewer is only available when a debugger is active."
- A "Learn More" button will redirect you to VS Code debugging documentation

## Features

### Category Selection

The tool displays all 6 fluency categories:
- **💬 Prompt Engineering**: How you structure prompts and use modes
- **📎 Context Engineering**: Your use of context references
- **🤖 Agentic**: Agent mode and autonomous feature usage
- **🔧 Tool Usage**: Built-in tools and MCP server integration
- **⚙️ Customization**: Repository customization and model selection
- **🔄 Workflow Integration**: Regular usage and mode diversity

Click on any category to view its stage definitions.

### Stage Details

For each category, you can see all 4 stages (Skeptic → Explorer → Collaborator → Strategist) with:

1. **Stage Label and Description**
   - Clear description of what defines this stage

2. **Requirements to Reach This Stage**
   - Specific, measurable thresholds
   - Concrete criteria used by the scoring algorithm
   - Examples: "At least 30 total interactions", "Using 2+ slash commands"

3. **Next Steps (Tips)**
   - Actionable suggestions to advance to the next level
   - Context-specific guidance based on current stage
   - Tips disappear at Stage 4 (highest level)

### Visual Design

- **Color-coded stages**: 
  - Stage 1 (Red): Skeptic
  - Stage 2 (Orange): Explorer
  - Stage 3 (Blue): Collaborator
  - Stage 4 (Green): Strategist
- **Left border highlight** on each stage card matches the stage color
- **Debug badge** in header shows you're in debug mode

## Use Cases

### For Extension Developers

- **Test scoring logic**: Verify that thresholds and rules are correctly defined
- **Debug scoring issues**: Understand why a particular score is calculated
- **Documentation**: Reference for updating scoring algorithms
- **User support**: Explain scoring criteria to users

### For Power Users (in debug mode)

- **Understand scoring**: See exactly what actions influence your fluency score
- **Plan improvement**: Identify specific actions to advance to the next stage
- **Validate progress**: Check if your usage patterns align with stage criteria

## Technical Implementation

### Debug Detection

```typescript
const isDebugMode = vscode.debug.activeDebugSession !== undefined;
```

The feature checks if `vscode.debug.activeDebugSession` is active. This ensures the tool is only accessible during debugging sessions.

### Navigation

The Level Viewer integrates with the existing webview navigation system:
- Refresh button to reload data
- Navigation buttons to other panels (Details, Chart, Usage, Diagnostics, Fluency Score)
- Consistent button appearance using the shared `buttonConfig.ts`

### Data Source

All threshold and tip data is defined in `extension.ts` in the `getFluencyLevelData()` method. This ensures the Level Viewer always displays the exact same rules used by the actual scoring algorithm in `calculateMaturityScores()`.

## Examples

### Example 1: Prompt Engineering - Stage 2 → Stage 3

**Current Stage 2 Requirements:**
- At least 5 total interactions
- Average 3+ exchanges per session shows iterative refinement
- Beginning to use slash commands or agent mode

**Tips to reach Stage 3:**
- Try agent mode for multi-file changes
- Use slash commands like /explain, /fix, or /tests to give structured prompts
- Experiment with multi-turn conversations to refine responses

**Stage 3 Requirements:**
- At least 30 total interactions
- Using 2+ slash commands or agent mode regularly
- Average 5+ exchanges per session OR model switching in sessions

### Example 2: Context Engineering - Stage 1 → Stage 2

**Current Stage 1:**
- Zero explicit context references (#file, #selection, @workspace, etc.)

**Tips to reach Stage 2:**
- Try adding #file or #selection references to give Copilot more context
- Start with #file to reference specific files in your prompts

**Stage 2 Requirements:**
- At least 1 context reference used
- Exploring basic references like #file or #selection

## Maintenance

When updating the fluency scoring algorithm in `calculateMaturityScores()`:

1. Update the thresholds in the actual scoring logic
2. Update the corresponding thresholds in `getFluencyLevelData()`
3. Update tips to reflect new guidance
4. Test in debug mode to verify changes are reflected correctly

This dual-maintenance approach ensures the Level Viewer always matches the production scoring algorithm.
