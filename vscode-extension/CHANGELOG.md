# Change Log

All notable changes to the VS Code extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

## [0.1.4]

<!-- Release notes generated using configuration in .github/release.yml at main -->

## What's Changed
### Changes
* chore: bump Visual Studio extension version to 1.0.5 by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/590
* feat: add Product Owner agent with rubber-duck multi-model reviews by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/591
* Fix Open VSX badge rendering by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/592
* feat: add token count column to diagnostics session files tab by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/593
* feat: add Day/Week/Month period toggle to chart view by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/594
* feat(chart): persist period selection and compact period picker UI by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/595
* chore: bump versions for release (vscode-extension) by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/596
* fix(workflows): consolidate VS extension release into release.yml by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/597
* test(maturity-scoring): add unit tests for Fluency Score logic by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/598
* test(workspace-helpers): add unit tests + fix off-by-one in extractCustomAgentName by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/599
* test(usage-analysis): add unit tests for mergeUsageAnalysis, analyzeContextReferences, deriveConversationPatterns by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/600
* Add test coverage to CI step summary by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/601
* ci: update workflows to Node.js 24 by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/603
* feat(tests): add Stryker mutation testing to VS Code extension by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/602
* fix: compute mutation score from counts instead of r.mutationScore by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/605
* test: improve mutation score from 29% to 40%+ with 89 targeted tests by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/608
* feat: cache-aware cost estimation for Claude and OpenCode sessions by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/607
* Add missing friendly names for click_element, mcp_github_pull_request_read, mcp_microsoftdocs_microsoft_docs_search, type_in_page by @Copilot in https://github.com/rajbos/github-copilot-token-usage/pull/614
* fix: skip VS filesystem scan on macOS/Linux to prevent extension hang (#611) by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/615
* docs: add Windsurf/Open VSX install badges and Windsurf details by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/617
* feat: display CO2 in kg when ≥ 1 000 g for readability by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/618
* Add sync-automatic-tools prompt by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/621
* Add missing friendly names for capitalized tool variants and cowork/workspace MCP tools by @Copilot in https://github.com/rajbos/github-copilot-token-usage/pull/620
* ci: skip mutation tests on PRs with no TS source changes by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/622
* Fix case-insensitive tool name lookup and remove duplicate entries by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/623
* Add repository statistics calculation script by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/624
* chore: bump versions for release (vscode-extension, cli, visualstudio-extension) by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/626
* chore(cli): bump version to v0.0.10 by @github-actions[bot] in https://github.com/rajbos/github-copilot-token-usage/pull/627
* fix: add node types to CLI tsconfig by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/629
* fix: use absolute URLs for logo image in README files by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/633
* test: extend coverage gate to core data pipeline modules (#630) by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/634
* Extract GitHub PR feature into a dedicated testable service by @Copilot in https://github.com/rajbos/github-copilot-token-usage/pull/635
* Add empty-state guidance for first-time users in the Details panel by @Copilot in https://github.com/rajbos/github-copilot-token-usage/pull/636
* chore: bump versions for release (vscode-extension, visualstudio-extension) by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/637
### 📦 GitHub Actions Dependencies
* github-actions(deps): bump the minor-and-patch-updates group with 3 updates by @dependabot[bot] in https://github.com/rajbos/github-copilot-token-usage/pull/606
* github-actions(deps): bump the minor-and-patch-updates group with 4 updates by @dependabot[bot] in https://github.com/rajbos/github-copilot-token-usage/pull/628
### 📦 Other Dependencies
* chore(deps): bump basic-ftp from 5.2.2 to 5.3.0 in /.github/scripts in the npm_and_yarn group across 1 directory by @dependabot[bot] in https://github.com/rajbos/github-copilot-token-usage/pull/612
* chore(deps): bump dompurify from 3.3.2 to 3.4.0 in /vscode-extension in the npm_and_yarn group across 1 directory by @dependabot[bot] in https://github.com/rajbos/github-copilot-token-usage/pull/610
* chore(deps-dev): bump typescript from 6.0.2 to 6.0.3 in /cli by @dependabot[bot] in https://github.com/rajbos/github-copilot-token-usage/pull/616
* chore(deps): bump puppeteer from 24.40.0 to 24.41.0 in /.github/scripts by @dependabot[bot] in https://github.com/rajbos/github-copilot-token-usage/pull/609


**Full Changelog**: https://github.com/rajbos/github-copilot-token-usage/compare/cli/v0.0.8...vscode/v0.1.4

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

Release notes: https://github.com/rajbos/github-copilot-token-usage/compare/vscode/v0.0.23...vscode/v0.1.0

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
