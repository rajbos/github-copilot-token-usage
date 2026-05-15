# Fluency Level Viewer - UI Mockup

## Main Interface Layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│ 🔍 Fluency Level Viewer                    [🐛 DEBUG MODE]               │
│                                                                           │
│ [🔄 Refresh] [🎯 Fluency Score] [🤖 Details] [📈 Chart]                  │
│ [📊 Usage Analysis] [🔍 Diagnostics]                                     │
├──────────────────────────────────────────────────────────────────────────┤
│ ℹ️ About This Tool                                                        │
│ This debug-only tool shows all fluency score rules, thresholds, and      │
│ tips for each category and stage. Use it to understand how the scoring   │
│ system works and what actions trigger different fluency levels.          │
│ Select a category below to view its stage definitions and advancement    │
│ criteria.                                                                 │
├──────────────────────────────────────────────────────────────────────────┤
│ CATEGORY SELECTOR:                                                        │
│                                                                           │
│ [💬 Prompt Engineering] [📎 Context Engineering] [🤖 Agentic]            │
│ [🔧 Tool Usage] [⚙️ Customization] [🔄 Workflow Integration]            │
│                     ^--- Selected (highlighted in blue)                   │
├──────────────────────────────────────────────────────────────────────────┤
│ LEVEL CARDS (Grid Layout):                                               │
│                                                                           │
│ ┌─────────────────────────┐  ┌─────────────────────────┐                │
│ │ Stage 1: Copilot Skeptic│  │ Stage 2: Copilot Explorer│               │
│ │ [Stage 1]               │  │ [Stage 2]                │               │
│ │ ────────────────────────│  │ ────────────────────────│               │
│ │ Rarely uses Copilot or  │  │ Exploring Copilot        │               │
│ │ uses only basic features│  │ capabilities with        │               │
│ │                         │  │ occasional use           │               │
│ │ 🎯 Requirements:        │  │                          │               │
│ │ ▸ Fewer than 5 total    │  │ 🎯 Requirements:        │               │
│ │   interactions          │  │ ▸ At least 5 total      │               │
│ │ ▸ No slash commands     │  │   interactions           │               │
│ │                         │  │ ▸ Average 3+ exchanges  │               │
│ │ 💡 Next Steps:          │  │                          │               │
│ │ 💡 Try asking Copilot   │  │ 💡 Next Steps:          │               │
│ │    a question           │  │ 💡 Try agent mode       │               │
│ │ 💡 Start with simple    │  │ 💡 Use slash commands   │               │
│ │    queries              │  │                          │               │
│ └─────────────────────────┘  └─────────────────────────┘                │
│                                                                           │
│ ┌─────────────────────────┐  ┌─────────────────────────┐                │
│ │ Stage 3: Copilot        │  │ Stage 4: Copilot        │               │
│ │ Collaborator [Stage 3]  │  │ Strategist   [Stage 4]  │               │
│ │ ────────────────────────│  │ ────────────────────────│               │
│ │ Regular, purposeful use │  │ Strategic, advanced use │               │
│ │ across multiple features│  │ leveraging the full     │               │
│ │                         │  │ Copilot ecosystem       │               │
│ │ 🎯 Requirements:        │  │                          │               │
│ │ ▸ At least 30 total     │  │ 🎯 Requirements:        │               │
│ │   interactions          │  │ ▸ At least 100 total    │               │
│ │ ▸ Using 2+ slash        │  │   interactions           │               │
│ │   commands              │  │ ▸ Using agent mode      │               │
│ │                         │  │   regularly              │               │
│ │ 💡 Next Steps:          │  │                          │               │
│ │ 💡 Try agent mode for   │  │ 💡 Next Steps:          │               │
│ │    autonomous tasks     │  │ 💡 You're at the        │               │
│ │ 💡 Experiment with      │  │    highest level!       │               │
│ │    different models     │  │                          │               │
│ └─────────────────────────┘  └─────────────────────────┘                │
├──────────────────────────────────────────────────────────────────────────┤
│ 🐛 Debug Tool - Only available when a debugger is active · 6 categories │
│ · 4 stages each                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

## Color Scheme

### Stage Colors (Left Border)
- **Stage 1** (Red): `#ef4444` - Skeptic level
- **Stage 2** (Orange): `#f59e0b` - Explorer level
- **Stage 3** (Blue): `#3b82f6` - Collaborator level
- **Stage 4** (Green): `#10b981` - Strategist level

### UI Elements
- **Selected Category Button**: Blue background with focus border
- **Debug Badge**: Orange background (`rgba(255, 152, 0, 0.2)`) with orange text
- **Info Box**: Blue background with information about the tool
- **Navigation Buttons**: Standard VS Code button styling

## Responsive Behavior

### Wide Layout (> 1200px)
```
[Card 1] [Card 2]
[Card 3] [Card 4]
```

### Narrow Layout (< 800px)
```
[Card 1]
[Card 2]
[Card 3]
[Card 4]
```

## Category Button States

### Default State
```
[ 💬 Prompt Engineering ]
```

### Selected/Active State
```
[ 💬 Prompt Engineering ]  ← Blue background, focus border
```

### Hover State
```
[ 💬 Prompt Engineering ]  ← Slightly lighter background
```

## Navigation Flow

```
Fluency Score Panel (with debugger active)
    ↓
    [🔍 Level Viewer Button] (visible only when debugger active)
    ↓
Fluency Level Viewer Panel Opens
    ↓
    Select Category → View Stages → Read Requirements & Tips
    ↓
    Navigate back via [🎯 Fluency Score] button
```

## Debug Mode Indicator

When debugger is **active**:
```
🔍 Fluency Level Viewer    [🐛 DEBUG MODE]
```

When debugger is **NOT active** (command palette):
```
⚠️ Warning Message:
"Fluency Level Viewer is only available when a debugger is active."
[Learn More]
```

## Example Content: Prompt Engineering Category

### Stage 1: Copilot Skeptic
**Requirements:**
- Fewer than 5 total interactions in 30 days
- Minimal multi-turn conversations
- No slash commands or agent mode usage

**Tips:**
- Try asking Copilot a question using the Chat panel
- Start with simple queries to get familiar with the interface

### Stage 2: Copilot Explorer
**Requirements:**
- At least 5 total interactions
- Average 3+ exchanges per session shows iterative refinement
- Beginning to use slash commands or agent mode

**Tips:**
- Try agent mode for multi-file changes
- Use slash commands like /explain, /fix, or /tests
- Experiment with multi-turn conversations

### Stage 3: Copilot Collaborator
**Requirements:**
- At least 30 total interactions
- Using 2+ slash commands or agent mode regularly
- Average 5+ exchanges per session OR model switching

**Tips:**
- Try agent mode for autonomous, multi-step coding tasks
- Experiment with different models for different tasks
- Explore more slash commands

### Stage 4: Copilot Strategist
**Requirements:**
- At least 100 total interactions
- Using agent mode regularly
- Active model switching OR 3+ diverse slash commands

**Tips:**
- You're at the highest level!
- Continue exploring advanced combinations

## Technical Details

### Panel Type
- `vscode.WebviewPanel`
- View Column: `vscode.ViewColumn.One`
- Preserve Focus: `true`
- Retain Context When Hidden: `false`

### Script Loading
- Entry point: `dist/webview/fluency-level-viewer.js`
- Initial data via `window.__INITIAL_FLUENCY_LEVEL_DATA__`
- CSP: Strict content security policy with nonce-based script loading

### State Management
- Category selection stored in component state
- No persistence between panel closes (fresh data on each open)
- Real-time debug mode detection on panel open and refresh
