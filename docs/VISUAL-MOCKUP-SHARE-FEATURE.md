# Visual Mockup - Social Media Share Feature

This document shows what the new social media share section looks like in the Copilot Fluency Score dashboard.

## Dashboard Layout

```
┌─────────────────────────────────────────────────────────────────────┐
│ 🎯 Copilot Fluency Score                    [Buttons: Refresh, etc] │
├─────────────────────────────────────────────────────────────────────┤
│                                                                       │
│ [Info box about the dashboard]                                       │
│                                                                       │
│ ┌───────────────────────────────────────────────────────────────┐   │
│ │         Overall Copilot Fluency                                │   │
│ │      Stage 3: Copilot Collaborator                            │   │
│ │  Regular, purposeful use across multiple features             │   │
│ └───────────────────────────────────────────────────────────────┘   │
│                                                                       │
│ ┌──────────────────────┐  ┌─────────────────────────────────────┐   │
│ │   [Radar Chart]      │  │   Stage Reference Legend            │   │
│ │                      │  │   • Stage 1: Copilot Skeptic        │   │
│ │       /\             │  │   • Stage 2: Copilot Explorer       │   │
│ │      /  \            │  │   • Stage 3: Copilot Collaborator   │   │
│ │     /    \           │  │   • Stage 4: Copilot Strategist     │   │
│ │                      │  │                                     │   │
│ └──────────────────────┘  └─────────────────────────────────────┘   │
│                                                                       │
│ [Category Cards Grid - 6 cards showing each category's details]      │
│                                                                       │
├─────────────────────────────────────────────────────────────────────┤
│ 📢 Share Your Copilot Fluency Score                                  │
│                                                                       │
│ Share your progress with the community and inspire others to         │
│ level up their Copilot skills!                                       │
│                                                                       │
│ ┌────────────────┐ ┌────────────────┐ ┌────────────────┐           │
│ │ 💼 Share on    │ │ 🦋 Share on    │ │ 🐘 Share on    │           │
│ │   LinkedIn     │ │   Bluesky      │ │   Mastodon     │           │
│ └────────────────┘ └────────────────┘ └────────────────┘           │
│ ┌────────────────┐                                                   │
│ │ 💾 Download    │                                                   │
│ │   Chart Image  │                                                   │
│ └────────────────┘                                                   │
├─────────────────────────────────────────────────────────────────────┤
│ ⚠️ Beta — This screen is in beta...        [📤 Share to Issue]      │
└─────────────────────────────────────────────────────────────────────┘
```

## Share Button Styles

The share buttons use platform-specific colors:

### LinkedIn Button (💼 Share on LinkedIn)
- Color: Professional blue (#0a66c2)
- Background gradient: Dark blue (#0a2540 → #0d3050)
- Hover: Elevates with blue glow

### Bluesky Button (🦋 Share on Bluesky)
- Color: Bright blue (#1285fe)
- Background gradient: Dark blue-teal (#0a2540 → #0d3550)
- Hover: Elevates with blue glow

### Mastodon Button (🐘 Share on Mastodon)
- Color: Purple (#6364ff)
- Background gradient: Dark purple (#1a1a3e → #20204e)
- Hover: Elevates with purple glow

### Download Button (💾 Download Chart Image)
- Color: Green (#10b981)
- Background gradient: Dark green (#0d2d20 → #123d2a)
- Hover: Elevates with green glow

## Example Share Text

When a user clicks any of the social media buttons, they get this pre-formatted text:

```
🎯 My GitHub Copilot Fluency Score

Overall: Stage 3: Copilot Collaborator

💬 Prompt Engineering: Stage 3
📎 Context Engineering: Stage 2
🤖 Agentic: Stage 2
🔧 Tool Usage: Stage 3
⚙️ Customization: Stage 2
🎓 Learning: Stage 4

Track your Copilot usage and level up your AI-assisted development skills!

Get the extension: https://marketplace.visualstudio.com/items?itemName=RobBos.ai-engineering-fluency

#CopilotFluencyScore
```

## User Flow Examples

### LinkedIn Flow:
1. User clicks "💼 Share on LinkedIn"
2. Share text is copied to clipboard
3. VS Code shows notification: "Share text copied to clipboard! Paste it into your LinkedIn post."
4. User clicks "Open LinkedIn" (optional)
5. LinkedIn share page opens in browser
6. User pastes the text from clipboard and adds their own commentary
7. User posts to LinkedIn

### Bluesky Flow:
1. User clicks "🦋 Share on Bluesky"
2. Bluesky compose window opens in browser
3. Text is pre-filled in the compose field
4. User can edit and add images if desired
5. User posts to Bluesky

### Mastodon Flow:
1. User clicks "🐘 Share on Mastodon"
2. VS Code prompts: "Enter your Mastodon instance (e.g., mastodon.social)"
3. User enters their instance (default: mastodon.social)
4. Mastodon share page opens for their instance
5. Text is pre-filled
6. User posts to Mastodon

### Download Chart Flow:
1. User clicks "💾 Download Chart Image"
2. VS Code shows informational message with instructions:
   ```
   💡 To save the chart as an image:
   
   1. Right-click on the radar chart above
   2. Select "Save image as..." or "Copy image"
   3. Use it in your social media posts!
   
   The chart is an SVG graphic that can be saved directly from your browser.
   ```
3. User clicks "Got it"
4. User follows the instructions to save the chart

## Responsive Design

The share buttons adapt to screen width:
- Desktop: 4 buttons in a 2x2 grid or 4 columns
- Tablet: 2 buttons per row
- Mobile: 1 button per row (stacked)

The grid uses `grid-template-columns: repeat(auto-fit, minmax(200px, 1fr))` for automatic responsive layout.
