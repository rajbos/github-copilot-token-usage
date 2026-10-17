# Change Log

All notable changes to the Visual Studio extension will be documented in this file.

## [Unreleased]

## [1.4.2] - 2026-10-02

### ✨ Features & Improvements
- Updated webview bundles with the latest shared-view changes: grouped Usage Analysis tabs, official editor logos in the Chart view, and more accurate exact-cost totals from debug logs
- The Environmental view's methodology links now open in your browser

## [1.4.1] - 2026-09-21

### ✨ Features & Improvements
- Updated webview bundles with latest shared-view changes: removed the dead Mistral Cloud tab and fixed Mistral Vibe cost attribution in the Diagnostics view, surfaced Copilot's server-side repository memories in the Usage view, and picked up additional friendly tool-name mappings

## [1.4.0] - 2026-09-18

### ✨ Features & Improvements
- New "Scoring Guide" view — the full fluency rubric: all four stages for each of the six categories, with the explicit thresholds required to reach each stage and the next steps to get there. Reached from the "📊 How is my score calculated?" button on the Fluency Score view, which was previously hidden in Visual Studio because the view did not exist here

## [1.0.5] - 2026-04-11

### ✨ Features & Improvements
- Add thinking effort (reasoning effort) tracking — shows actual vs estimated tokens for Claude models using extended thinking
- Display 'xhigh' reasoning effort as 'Extra High' in the UI
- GitHub authentication support — sign in with your GitHub account to view Copilot Cloud Agent and Review Agent usage
- Add Claude Desktop Cowork session support
- Show actual tokens in log viewer header for CLI sessions
- Fix: track token usage from sub-agent calls in Copilot agent mode
- Fix: wrap long MCP tool names in session viewer
- Add per-tool suppression for unknown tool name notifications
- Add friendly display names for 14 additional tools
- Security fix: sanitize user-provided values in Repository PRs panel

## [1.0.4] - 2026-04-08

### ✨ Features & Improvements
- Updated webview bundles with latest features from VS Code extension (v0.0.27)
- Add AI Engineering Fluency icon to the extension

## [1.0.3] - 2026-03-31

### ✨ Features & Improvements
- Updated webview bundles with latest features from VS Code extension (v0.0.26)
- Performance: batch all CLI calls into a single `all --json` invocation for faster panel loading
- Add support for Claude Code sessions

## [1.0.2] - 2026-03-28

### ✨ Features & Improvements
- Load all webview panels with a single CLI call instead of one per view (performance improvement)

## [1.0.1] - 2026-03-26

### 🎉 Initial Release
- First release of the **AI Engineering Fluency** extension for Visual Studio 2022
- Tracks GitHub Copilot token usage directly inside Visual Studio
- WebView2-powered panels: Details, Chart, Usage Analysis, and Diagnostics
- Shows today's and last-30-days token usage with per-model breakdowns
- Detailed session log viewer for individual Copilot Chat interactions
- Supports Visual Studio 2022 Community, Professional, and Enterprise
