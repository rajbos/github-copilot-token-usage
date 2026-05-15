# Export Feature UI Visual Description

## Before (Previous Version)
```
╔═══════════════════════════════════════════════════════════════╗
║  Share Your Copilot Fluency Score                            ║
║  Share your progress with the community...                    ║
║                                                                ║
║  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐          ║
║  │ 💼 LinkedIn  │ │ 🦋 Bluesky   │ │ 🐘 Mastodon  │          ║
║  └──────────────┘ └──────────────┘ └──────────────┘          ║
║                                                                ║
║  ┌────────────────────────────────┐                           ║
║  │ 💾 Download Chart Image        │                           ║
║  └────────────────────────────────┘                           ║
╚═══════════════════════════════════════════════════════════════╝
```

## After (New Version)
```
╔═══════════════════════════════════════════════════════════════╗
║  Share Your Copilot Fluency Score                            ║
║  Share your progress with the community...                    ║
║                                                                ║
║  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐          ║
║  │ 💼 LinkedIn  │ │ 🦋 Bluesky   │ │ 🐘 Mastodon  │          ║
║  └──────────────┘ └──────────────┘ └──────────────┘          ║
║                                                                ║
║  ┌────────────────────────────────┐                           ║
║  │ 💾 Export Fluency Score    ▼  │ ← Dropdown Button         ║
║  └────────────────────────────────┘                           ║
╚═══════════════════════════════════════════════════════════════╝
```

## With Dropdown Open
```
╔═══════════════════════════════════════════════════════════════╗
║  Share Your Copilot Fluency Score                            ║
║  Share your progress with the community...                    ║
║                                                                ║
║  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐          ║
║  │ 💼 LinkedIn  │ │ 🦋 Bluesky   │ │ 🐘 Mastodon  │          ║
║  └──────────────┘ └──────────────┘ └──────────────┘          ║
║                                                                ║
║  ┌────────────────────────────────┐                           ║
║  │ 💾 Export Fluency Score    ▼  │                           ║
║  └────────────────────────────────┘                           ║
║  ┌────────────────────────────────┐                           ║
║  │ 🖼️ Export as PNG Image        │ ← Menu Item 1             ║
║  ├────────────────────────────────┤                           ║
║  │ 📄 Export as PDF Report        │ ← Menu Item 2             ║
║  └────────────────────────────────┘                           ║
╚═══════════════════════════════════════════════════════════════╝
```

## UI Flow

### Step 1: Click Export Button
User clicks the "💾 Export Fluency Score ▼" button

### Step 2: Dropdown Opens
Menu appears below the button with two options:
- 🖼️ Export as PNG Image
- 📄 Export as PDF Report

### Step 3A: PNG Export Flow
```
Click "Export as PNG Image"
    ↓
Dropdown closes
    ↓
System captures spider chart
    ↓
Converts SVG to Canvas to PNG (1100x1100)
    ↓
File save dialog appears
"Save Fluency Score Chart"
Default: copilot-fluency-score.png
Filter: PNG Image (*.png)
    ↓
User selects location and saves
    ↓
Confirmation message:
"Chart image saved to [path]"
[Open Image] button available
```

### Step 3B: PDF Export Flow
```
Click "Export as PDF Report"
    ↓
Dropdown closes
    ↓
System generates PDF using jsPDF
- Cover page with summary
- 6 category pages with details
    ↓
File save dialog appears
"Export Fluency Score Report"
Default: copilot-fluency-score.pdf
Filter: PDF Document (*.pdf)
    ↓
User selects location and saves
    ↓
Confirmation message:
"Fluency Score PDF saved to [path]"
[Open PDF] button available
```

## Button Styling

### Export Button (Closed State)
- Background: Green gradient (#0d2d20 to #123d2a)
- Border: Green (#10b98180)
- Text: Green (#10b981)
- Icon: 💾
- Arrow: ▼ (10px, transitions on open)
- Hover: Elevated with glow effect

### Dropdown Menu
- Background: Dark gradient (#1a1a2e to #16213e)
- Border: Subtle gray (#2e2e34)
- Shadow: 0 4px 12px rgba(0,0,0,0.3)
- Position: Absolute, below button
- Z-index: 1000 (appears above other content)

### Menu Items
- Full width, left-aligned
- Padding: 12px 16px
- Font: 13px, weight 600
- Icon + Text layout with 8px gap
- Transparent background
- Hover: Blue overlay (rgba(59,130,246,0.15))
- Active: Darker blue (rgba(59,130,246,0.25))
- Smooth transitions (0.2s)

## Interaction Details

### Dropdown Behavior
- Click button → Toggle dropdown visibility
- Click outside → Close dropdown
- Select menu item → Close dropdown + Execute action
- ESC key support (handled by VS Code webview)

### Click Prevention
- Uses `e.stopPropagation()` to prevent event bubbling
- Menu item clicks don't trigger outside click handler
- Button click doesn't trigger outside click handler

### Accessibility
- Keyboard navigable (native button elements)
- Screen reader friendly (semantic HTML)
- Clear visual feedback on hover/focus
- High contrast colors for readability

## Color Scheme
Matches existing dashboard theme:
- Primary: Green (#10b981) for export action
- Background: Dark gradients (#1a1a2e, #16213e)
- Text: Light gray (#e7e7e7)
- Accent: Blue (#3b82f6) for hover states
- Borders: Subtle gray (#2e2e34)
