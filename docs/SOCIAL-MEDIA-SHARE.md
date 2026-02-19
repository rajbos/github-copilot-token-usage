# Social Media Share Feature

The Copilot Fluency Score dashboard now includes built-in social media sharing capabilities, allowing users to share their achievements and progress with the community.

## Features

### Share Buttons

The dashboard includes share and export buttons located below the category cards:

1. **💼 Share on LinkedIn** - Opens LinkedIn share dialog with pre-formatted text
2. **🦋 Share on Bluesky** - Opens Bluesky compose window with share text
3. **🐘 Share on Mastodon** - Prompts for Mastodon instance, then opens share dialog
4. **💾 Export Fluency Score** - Dropdown menu with export options:
   - **🖼️ Export as PNG Image** - Saves the radar chart as a high-resolution PNG image
   - **📄 Export as PDF Report** - Generates a comprehensive multi-page PDF report with:
     - Cover page with overall score and category summary
     - Individual pages for each category with evidence and improvement tips

### Share Content

When sharing to social media, the extension generates a formatted message that includes:

```
🎯 My GitHub Copilot Fluency Score

Overall: [Your Stage Label]

💬 Prompt Engineering: Stage X
📎 Context Engineering: Stage X
🤖 Agentic: Stage X
🔧 Tool Usage: Stage X
⚙️ Customization: Stage X
🎓 Learning: Stage X

Track your Copilot usage and level up your AI-assisted development skills!

Get the extension: https://marketplace.visualstudio.com/items?itemName=RobBos.copilot-token-tracker

#CopilotFluencyScore
```

### Platform-Specific Behavior

#### LinkedIn
- Copies the share text to clipboard
- Shows a notification with instructions
- Optionally opens LinkedIn sharing page
- User can paste the text and add their own commentary

#### Bluesky
- Opens Bluesky compose window directly
- Pre-fills the share text
- User can edit before posting

#### Mastodon
- Prompts for the user's Mastodon instance (e.g., mastodon.social)
- Opens the instance's share dialog
- Pre-fills the share text

#### Export Options

The export dropdown provides two options:

**PNG Image Export:**
- Captures the radar chart as a high-resolution (1100x1100) PNG image
- Includes dark background matching the dashboard theme
- Uses HTML5 Canvas for rendering
- Prompts user to choose save location
- Displays confirmation message with option to open the saved image

**PDF Report Export:**
- Generates a comprehensive multi-page PDF document using jsPDF
- **Cover Page** includes:
  - Title and report date
  - Overall fluency stage
  - Summary of all category scores
  - Report period (last 30 days)
- **Category Pages** (one per category) include:
  - Category name and icon
  - Current stage level
  - Evidence items showing what you've accomplished
  - Tips for reaching the next stage
- Professional A4 format with headers and footers
- Prompts user to choose save location
- Displays confirmation message with option to open the PDF

## Hashtag

All shares include the unique hashtag **#CopilotFluencyScore** to help build a community around the extension and allow users to discover others' experiences.

## Marketplace Link

Each share includes a direct link to the VS Code Marketplace page for the extension:
`https://marketplace.visualstudio.com/items?itemName=RobBos.copilot-token-tracker`

This makes it easy for interested developers to install the extension and start tracking their own Copilot usage.

## Visual Design

The share section features:
- Gradient background matching the dashboard theme
- Platform-specific button colors:
  - LinkedIn: Professional blue (#0a66c2)
  - Bluesky: Bright blue (#1285fe)
  - Mastodon: Purple (#6364ff)
  - Download: Green (#10b981)
- Hover effects with elevation and glow
- Responsive grid layout that adapts to screen size

## Implementation Details

### Frontend (webview/maturity/main.ts)
- Share section HTML with share buttons and export dropdown
- Event listeners for share actions and export options
- `handlePngExport()` - Converts SVG radar chart to PNG using Canvas API
- `handlePdfExport()` - Sends maturity data to extension for PDF generation
- Messages sent to extension host for processing

### Backend (extension.ts)
- `shareToSocialMedia(platform)` - Handles share logic for each platform
- `saveChartImageData(dataUrl)` - Saves PNG image from base64 data
- `exportFluencyScorePdf(maturityData)` - Generates multi-page PDF report using jsPDF
- URL encoding for safe sharing
- Clipboard integration for LinkedIn
- VS Code file dialogs for save location selection

### Styling (webview/maturity/styles.css)
- `.share-section` - Container styling
- `.share-btn` - Button base styles
- `.export-dropdown-container` - Dropdown positioning
- `.export-dropdown-menu` - Popup menu styling with shadow and animations
- `.export-menu-item` - Individual menu item styles with hover effects
- Platform-specific classes for colors and effects
- Responsive grid layout for buttons
