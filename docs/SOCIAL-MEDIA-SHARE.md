# Social Media Share Feature

The Copilot Fluency Score dashboard now includes built-in social media sharing capabilities, allowing users to share their achievements and progress with the community.

## Features

### Share Buttons

The dashboard includes four share buttons located below the category cards:

1. **💼 Share on LinkedIn** - Opens LinkedIn share dialog with pre-formatted text
2. **🦋 Share on Bluesky** - Opens Bluesky compose window with share text
3. **🐘 Share on Mastodon** - Prompts for Mastodon instance, then opens share dialog
4. **💾 Download Chart Image** - Provides instructions for saving the radar chart

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

#### Download Chart
- Provides instructions for saving the SVG radar chart
- Users can right-click the chart to save or copy the image

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
- Share section HTML with four buttons
- Event listeners for each share action
- Messages sent to extension host

### Backend (extension.ts)
- `shareToSocialMedia(platform)` - Handles share logic for each platform
- `downloadChartImage()` - Provides download instructions
- URL encoding for safe sharing
- Clipboard integration for LinkedIn

### Styling (webview/maturity/styles.css)
- `.share-section` - Container styling
- `.share-btn` - Button base styles
- Platform-specific classes for colors and effects
- Responsive grid layout for buttons
