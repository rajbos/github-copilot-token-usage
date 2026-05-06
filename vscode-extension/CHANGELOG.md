# Change Log

All notable changes to the VS Code extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

## [0.5.0] - 2026-05-06

### Features
- Added Session Efficiency view — scatter chart of sessions by token usage and tool calls, with sortable table, model/PR filters, and async load with spinner
- Added cost-mode toggle (AI credits vs. dollar cost) and explainer to Session Efficiency view
- Added Session Efficiency nav button to all views; removed palette command
- Cost basis toggle moved into Sessions by category panel; chart title updates to reflect active mode
- Added sort indicator to active column header in session table

### Improvements
- Added Mistral AI model pricing and token estimators (#796)
- Added missing friendly names for 17 additional tools (TaskCreate, TaskUpdate, dismiss_deployment_notifications, Claude in Chrome MCP, and 13 others)
- Scatter chart: dark border on dots for readability, crisp rendering, variable circle size restored
- Compact token format in Session Efficiency table; dedup models/PRs; clear filters on click
- Session Efficiency header/buttons match styling of other views

### Bug Fixes
- Fixed duplicate loading sessions appearing in the status bar
- Fixed sort indicator wrapping to new line in session table headers

## [0.4.4] - 2026-05-05

### Bug Fixes
- Fixed Cowork (Claude) token over-count caused by duplicate `requestId` entries in `buildTurns` — each request is now counted exactly once (#790)
- Fixed sharing server sync being skipped when Azure Storage sync fails — both backends now sync independently (#789)

## [0.4.3] - 2026-05-05

### Bug Fixes
- Fixed concurrent sync being blocked when VS Code and VS Code Insiders are configured to different server URLs — the sync lock now stores the server URL and treats locks from a different URL as non-blocking (#787)
- Fixed sync to sharing server being skipped when both Azure Storage and the sharing server backends are configured simultaneously — both backends are now synced additively (#787)

## [0.4.2] - 2026-05-05

### Bug Fixes
- Fixed team dashboard showing empty results with Cosmos DB backend — replaced unsupported OData `datetime'...'` filter with `day` field string comparison (#783)
- Fixed `workspaceId` `w:` prefix not being stripped in extension dashboard entity processing (#783)
- Fixed logo image URL in VS Code Marketplace README (#782)

### Improvements
- Team Server diagnostics panel now shows GitHub auth status and a clickable warning banner when backend is configured but GitHub is not authenticated (#783)
- Added friendly display names for 10 additional tools (#784)
- Added friendly names for two missing GitHub MCP (Local) tools (#781)
- Pinned `vsce` and `ovsx` as exact devDependencies for reproducible builds (#785)

## [0.4.1] - 2026-05-05

### Fixes
- Fixed README badges: replaced retired vsmarketplacebadges.dev with shields.io
- Updated all VS Code install links and commands to the current extension ID (`ai-engineering-fluency`)
- Disabled legacy `copilot-token-tracker` VSIX creation and publishing in the release workflow (migration flow complete)

## [0.4.0] - 2026-05-04

### Features and Improvements
- Added Gemini CLI support as a trackable ecosystem
- Added JetBrains IDE Copilot session discovery with ask/agent mode detection, per-turn model tracking, and tooltips for data limits
- Added Copilot PR chat context references detection — surfaces #pr context in session log viewer (#760)
- Added Path Analyzer tab to diagnostics panel (#713)
- Added Editor Mode summary card to log viewer
- Added daily auto-sync of model multipliers from github-copilot-model-notifier (#718)
- Dual-publish VS Code extension under new AI Engineering Fluency marketplace ID (#731)
- Added detection of legacy copilot-token-tracker extension with prompt to uninstall and migration notice
- Added friendly display names for mcp_context7, mcp_microsoftdocs, Slidev, Copilot CLI built-in tools, and JetBrains tools (#723, #726)
- Added missing friendly names for additional tools (#771)
- Surface subagent count in log viewer; fixed subagent tool-result token estimation (#720)
- Added weekly/monthly chart periods and fixed usage analysis routing

### Bug Fixes
- Fixed: only suppress deprecation notice on explicit Dismiss
- Fixed: show correct editor name for eco sessions in diagnostics directory table
- Fixed: eco-session token count in diagnostics matches file viewer
- Fixed: replace hardcoded dark backgrounds in log viewer with theme CSS variables (#716)
- Fixed: populate estimated cost data in chart view for all periods
- Fixed: cost estimate reason display

## [0.3.0] - 2026-04-30

### Features and Improvements
- Added "💰 Est. Cost" view to the chart page: shows estimated daily/weekly/monthly API cost based on per-model token usage and provider pricing data (#703)
- Added first-value onboarding empty-state guidance and Scoring Guide panel (#710)
- Added macOS path support for Claude Desktop Cowork sessions (#714)

### Bug Fixes
- Fixed: show Configure Backend button when backend storage info is unavailable
- Fixed: exclude suppressed tools from unknown tools alert banner

## [0.1.1] - 2026-04-10

### Features and Improvements
- Added GitHub authentication support using VS Code's built-in authentication provider (#182)
- New commands: Authenticate with GitHub and Sign Out from GitHub
- GitHub Auth tab in Diagnostic Report panel showing authentication status
- Foundation for future GitHub-specific features (repository tracking, team collaboration, advanced analytics)
- Added Claude Desktop Cowork session support (#572)
- Added per-tool suppression for unknown tool name notifications (#563)
- Show git branch in status bar when running in debug mode (#576)

### Bug Fixes
- Fixed tracking of token usage from sub-agent calls in Copilot agent mode (#573)
- Fixed long MCP tool names wrapping in session viewer (#574)
- Fixed Copilot CLI session titles showing empty (#575)
- Hide 0-interaction sessions in diagnostics view

### Dependencies
- Bumped basic-ftp (#577)

## [0.1.0]

Release notes: https://github.com/rajbos/ai-engineering-fluency/compare/vscode/v0.0.23...vscode/v0.1.0

## [0.0.27] - 2026-04-07

### Features and Improvements
- Added friendly display names for mcp_gitkraken_git_log_or_diff, copilot_runInTerminal, mcp_laravel-boost_tinker, and Power BI MCP tools (#553, #554, #555)

### Bug Fixes
- Fixed integration test activation timing (#548)

## [0.0.26] - 2026-04-04

### Features and Improvements
- Split usage analysis view into 3 tabs for better navigation (#540)
- Added missing friendly display names for MCP and VS Code tools (#539)

### Bug Fixes
- Fixed loading stalls during session discovery (#545)

## [0.0.24] - 2026-03-28

### Features and Improvements
- Added Claude Code session file support as a usage analysis data source
- Added formatting options to details and log viewer panels
- Added friendly display names for container-tools and github-pull-request tools
- Added friendly display names for additional missing MCP/VS Code tools

## [0.0.23] - 2026-03-26

### Features and Improvements
- Renamed extension to AI Engineering Fluency (was Copilot Token Tracker)
- Added friendly display names for CMakeTools and misc non-MCP tools
- Added friendly display names for Python and Pylance MCP tools
- Improved maturity scoring view with updated labels and layout
- Improved fluency level viewer with updated labels
- Updated details and diagnostics webview panel titles
- Added Visual Studio session file support (shared data layer)
- Added LICENSE file to extension package
