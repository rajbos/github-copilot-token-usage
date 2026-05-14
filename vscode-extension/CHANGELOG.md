# Change Log

All notable changes to the VS Code extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

## [0.9.0]

<!-- Release notes generated using configuration in .github/release.yml at main -->

## What's Changed
### Changes
* Add friendly names for Claude in Chrome MCP browser tools by @Copilot in https://github.com/rajbos/ai-engineering-fluency/pull/804
* feat: show cached input tokens in log viewer summary bar by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/807
* chore: remove legacy deprecation popup and clean up publish script by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/809
* Add friendly names for mcp_git_git_log and mcp_git_git_show by @Copilot in https://github.com/rajbos/ai-engineering-fluency/pull/810
* Add friendly display names for ADO MCP, MSSQL, and Copilot search/memory tools by @Copilot in https://github.com/rajbos/ai-engineering-fluency/pull/813
* Hide session efficiency navigation buttons by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/815
* chore: bump VS Code extension to v0.5.1 by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/816
* feat(cli): add --json output option to stats command by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/818
* feat: cleanup old code refs by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/821
* Add friendly names for list_bash, read_bash, stop_bash tools by @Copilot in https://github.com/rajbos/ai-engineering-fluency/pull/822
* chore: remove Session Efficiency references from CHANGELOG by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/823
* fix(deps): bump fast-uri to >=3.1.2 (closes Dependabot alerts #81 and #82) by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/824
* chore: bump versions for release (vscode-extension v0.5.2, cli v0.1.1) by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/825
* fix(ci): use OIDC provenance for npm publish by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/826
* fix: always show friendly model names in all display locations by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/828
* fix(mutation-benchmark): gracefully handle invalid/expired GH_PAT by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/829
* chore(cli): bump version to v0.1.2 by @github-actions[bot] in https://github.com/rajbos/ai-engineering-fluency/pull/827
* fix: keep chart in sync with toolbar on background stat refreshes by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/830
* Add friendly names for EnterPlanMode and ExitPlanMode tools by @Copilot in https://github.com/rajbos/ai-engineering-fluency/pull/832
* feat: add extension points API for companion extension button registration by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/833
* chore: bump version to 0.6.0 by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/834
* feat: add Copilot Cloud Agent sessions view by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/835
* feat(chart): add rolling average toggle for Total Tokens and Est. Cost views by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/836
* chore: bump VS Code extension version to 0.7.0 by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/842
* Copilot/fix vscode extension error by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/844
* chore: exclude stryker.config.mjs and vs-session-sample.json from VSIX by @Copilot in https://github.com/rajbos/ai-engineering-fluency/pull/843
* Add diagnostic logging to Details panel creation by @Copilot in https://github.com/rajbos/ai-engineering-fluency/pull/845
* chore: release VS Code extension v0.7.1 by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/846
* feat: remove cost estimate row and rename TBB to UBB by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/847
* feat(vscode): extract cached tokens from Copilot Chat debug logs by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/851
* diagnostics: move action buttons to top and reduce report height by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/853
* chore: sync model data from rajbos/github-copilot-model-notifier by @github-actions[bot] in https://github.com/rajbos/ai-engineering-fluency/pull/852
* feat: team dashboard supports both Azure Storage and Team Server backends by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/854
* Add friendly display name for `update_pull_request` tool by @Copilot in https://github.com/rajbos/ai-engineering-fluency/pull/856
* chore: bump VS Code extension to v0.8.0 by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/857
* refactor: simplify summary card styles by removing actual usage card class by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/859
* Add missing friendly names for tools (fixes #858) by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/864
* Add 10 missing friendly names for tools by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/865
* Add missing friendly names for tools (fixes #862) by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/866
* Add friendly name for mcp_io_github_git_get_job_logs tool by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/867
* Add missing friendly display names for 32 tools by @Copilot in https://github.com/rajbos/ai-engineering-fluency/pull/868
* Add friendly names for Azure MCP Server tools by @Copilot in https://github.com/rajbos/ai-engineering-fluency/pull/872
* Add friendly name for `mcp_git_git_diff_staged` by @Copilot in https://github.com/rajbos/ai-engineering-fluency/pull/873
* feat: add SLM-powered job to generate friendly tool names from issues by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/875
* Add .github/github-app.yml with session setup scripts by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/878
* fix: correct Python dict syntax in add-toolnames-with-slm generate step by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/877
* fix: populate cache tokens from CLI session.shutdown events by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/869
* feat: add oh-my-posh segment command and Copilot CLI statusline support by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/876
* feat: add 14 friendly tool name(s) from issue #874 by @github-actions[bot] in https://github.com/rajbos/ai-engineering-fluency/pull/879
* feat: post-process SLM output to fix acronym capitalization (MCP, GitHub, etc.) by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/880
* fix: pin Ollama install to versioned GitHub release with SHA256 verification by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/881
* chore: bump VS Code extension version to 0.9.0 by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/883
* chore(cli): bump version to v0.1.3 by @github-actions[bot] in https://github.com/rajbos/ai-engineering-fluency/pull/882
### 📦 GitHub Actions Dependencies
* github-actions(deps): Bump github/codeql-action from 4.35.3 to 4.35.4 in the minor-and-patch-updates group by @dependabot[bot] in https://github.com/rajbos/ai-engineering-fluency/pull/837
* github-actions(deps): Bump actions/download-artifact from 4.3.0 to 8.0.1 by @dependabot[bot] in https://github.com/rajbos/ai-engineering-fluency/pull/838
* github-actions(deps): Bump actions/dependency-review-action from 4.9.0 to 5.0.0 by @dependabot[bot] in https://github.com/rajbos/ai-engineering-fluency/pull/840
* github-actions(deps): Bump actions/cache from 4.2.3 to 5.0.5 by @dependabot[bot] in https://github.com/rajbos/ai-engineering-fluency/pull/841
* github-actions(deps): Bump gradle/actions from 4.3.1 to 6.1.0 by @dependabot[bot] in https://github.com/rajbos/ai-engineering-fluency/pull/839
### 📦 Other Dependencies
* chore(deps): Bump the npm_and_yarn group across 1 directory with 2 updates by @dependabot[bot] in https://github.com/rajbos/ai-engineering-fluency/pull/802
* chore(deps): Bump puppeteer from 24.42.0 to 24.43.0 in /.github/scripts by @dependabot[bot] in https://github.com/rajbos/ai-engineering-fluency/pull/805
* chore(deps): Bump hono from 4.12.14 to 4.12.18 in /sharing-server in the npm_and_yarn group across 1 directory by @dependabot[bot] in https://github.com/rajbos/ai-engineering-fluency/pull/812
* chore(deps-dev): Bump @types/node from 25.6.0 to 25.6.2 in /cli by @dependabot[bot] in https://github.com/rajbos/ai-engineering-fluency/pull/814
* chore(deps): Bump fast-xml-builder from 1.1.5 to 1.2.0 in /.github/skills/azure-storage-loader in the npm_and_yarn group across 1 directory by @dependabot[bot] in https://github.com/rajbos/ai-engineering-fluency/pull/820
* chore(deps): Bump fast-xml-builder from 1.1.5 to 1.2.0 in /vscode-extension in the npm_and_yarn group across 1 directory by @dependabot[bot] in https://github.com/rajbos/ai-engineering-fluency/pull/819
* chore(deps): Bump puppeteer from 24.43.0 to 24.43.1 in /.github/scripts by @dependabot[bot] in https://github.com/rajbos/ai-engineering-fluency/pull/849
* chore(deps-dev): Bump @types/node from 25.6.2 to 25.7.0 in /cli by @dependabot[bot] in https://github.com/rajbos/ai-engineering-fluency/pull/850


**Full Changelog**: https://github.com/rajbos/ai-engineering-fluency/compare/vscode/v0.5.0...vscode/v0.9.0

## [0.9.0] - 2026-05-14

### Features
- Add oh-my-posh segment command and Copilot CLI statusline support (#876)
- Post-process SLM output to fix acronym capitalization (MCP, GitHub, etc.) (#880)
- Add SLM-powered job to generate friendly tool names from issues (#875)

### Bug Fixes
- Populate cache tokens from CLI session.shutdown events (#869)
- Pin Ollama install to versioned GitHub release with SHA256 verification (#881)

### Improvements
- Add friendly display names for 50+ tools (#862, #864, #865, #866, #867, #868, #872, #873, #874, #879)

## [0.8.0] - 2026-05-12

### Features
- Team dashboard now supports both Azure and Team Server backends (#854)
- Surface cached tokens from all providers in Details view (#851)
- Extract cached tokens from Copilot Chat debug logs (#851)
- Remove cost estimate row and rename TBB to UBB (#847)
- Add diagnostic logging to Details panel creation to aid blank-panel diagnosis (#845)

### Bug Fixes
- Replace team server iframe with launch card (#854)
- Use PID-based liveness check to break stale cache lock after force-kill (#844)

### Improvements
- Move action buttons to top and reduce report height in diagnostics view (#853)
- Sync latest model data (#852)
- Address npm audit warning
- Exclude `stryker.config.mjs` and `vs-session-sample.json` from VSIX package (#843)

## [0.7.0] - 2026-05-28

### Features
- Add rolling average toggle for Total Tokens and Est. Cost chart views (#836)
- Add Copilot Cloud Agent sessions view (#835)

## [0.5.2] - 2026-05-09

### Security
- Bumped `fast-uri` to ≥3.1.2 to fix GHSA-v39h-62p7-jpjc and GHSA-q3j6-qgpj-74h6

### Improvements
- Added friendly display names for `list_bash`, `read_bash`, and `stop_bash` tools (#822)
- Bumped `fast-xml-builder` dependency (#819)
- Cleaned up legacy code references (#821)

## [0.5.1] - 2026-05-08

### Features
- Show cached input tokens in log viewer summary bar — a "Cached Input" card now appears for Copilot CLI sessions that have `cacheReadTokens` data (#807)

### Improvements
- Added friendly display names for additional tools: ADO MCP, MSSQL, Copilot search/memory tools, `mcp_git_git_log`, `mcp_git_git_show`, and Claude in Chrome MCP tools
- Cleaned up publish script and removed legacy deprecation popup (#809)

## [0.5.0] - 2026-05-06

### Features
- Cost basis toggle moved into Sessions by category panel; chart title updates to reflect active mode
- Added sort indicator to active column header in session table

### Improvements
- Added Mistral AI model pricing and token estimators (#796)
- Added missing friendly names for 17 additional tools (TaskCreate, TaskUpdate, dismiss_deployment_notifications, Claude in Chrome MCP, and 13 others)
- Scatter chart: dark border on dots for readability, crisp rendering, variable circle size restored

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
