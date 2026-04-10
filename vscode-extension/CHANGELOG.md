# Change Log

All notable changes to the VS Code extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

## [0.1.1]

<!-- Release notes generated using configuration in .github/release.yml at main -->

## What's Changed
### Changes
* Add friendly display names for 4 missing tools by @Copilot in https://github.com/rajbos/github-copilot-token-usage/pull/501
* Add friendly display names for 4 missing tools by @Copilot in https://github.com/rajbos/github-copilot-token-usage/pull/503
* Fix CCA setup by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/505
* fix cli refs by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/506
* Adding formatting options by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/507
* Add README.md to vscode-extension for VS Code Marketplace display by @Copilot in https://github.com/rajbos/github-copilot-token-usage/pull/509
* feat(vs-extension): Load all views with a single CLI call instead of one per view by @Copilot in https://github.com/rajbos/github-copilot-token-usage/pull/500
* Add missing friendly names for container-tools and github-pull-request tools by @Copilot in https://github.com/rajbos/github-copilot-token-usage/pull/512
* Claude Code support by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/513
* version bump by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/514
* address workflow failures by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/517
* feat: limit model usage table to top 10 with collapsible "Other" group by @Copilot in https://github.com/rajbos/github-copilot-token-usage/pull/516
* fix vs extension release error by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/518
* release process improvement by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/519
* fix release issue by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/520
* fix release issue by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/521
* add logos to the assets folder by @kasuken in https://github.com/rajbos/github-copilot-token-usage/pull/524
* Add AI Engineering Fluency logos to extension packages and READMEs by @Copilot in https://github.com/rajbos/github-copilot-token-usage/pull/525
* feat(vs-extension): add AI Engineering Fluency icon to VSIX manifest by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/526
* fix: convert sync I/O to async in session discovery to prevent VS Code UI freeze by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/527
* fix config setup by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/528
* feat: annotate automatic tools and exclude from fluency scoring by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/529
* VS extension: batch all CLI calls into a single `all --json` invocation by @Copilot in https://github.com/rajbos/github-copilot-token-usage/pull/530
* Fix model pricing: correct $0 prices for GPT-5.4 and Claude Sonnet 4.6 by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/531
* Fix null safety in response array loops and OpenCode method reference by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/532
* team dashboard by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/510
* Parallelize session discovery and file-processing loops by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/533
* fix warning by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/534
* release by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/535
* Add npmjs package link to CLI docs by @Copilot in https://github.com/rajbos/github-copilot-token-usage/pull/536
* fix(ci): correct working-directory for extension npm ci step by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/537
* Add missing friendly display names for 5 tools by @Copilot in https://github.com/rajbos/github-copilot-token-usage/pull/539
* feat(usage): split usage analysis view into 3 tabs by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/540
* fix: prevent loading stalls during session discovery by @saschabuehrle in https://github.com/rajbos/github-copilot-token-usage/pull/545
* chore: bump VS Code extension version to 0.0.26 by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/547
* fix: await extension activation before checking commands in integration test by @Copilot in https://github.com/rajbos/github-copilot-token-usage/pull/548
* Add friendly name for mcp_gitkraken_git_log_or_diff tool by @Claude in https://github.com/rajbos/github-copilot-token-usage/pull/553
* feat: add friendly names for copilot_runInTerminal and mcp_laravel-boost_tinker by @Claude in https://github.com/rajbos/github-copilot-token-usage/pull/554
* Add friendly name for Power BI MCP tool by @Copilot in https://github.com/rajbos/github-copilot-token-usage/pull/555
* chore: bump versions for release 0.0.27 / 1.0.4 / 0.0.7 by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/557
* Add friendly display names for MiniMax, DingDocuments, Fetch, and invalid tools by @Copilot in https://github.com/rajbos/github-copilot-token-usage/pull/561
* fix: use badge colors for "auto" label to improve dark theme readability by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/562
* feat: add local view regression test command by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/569
* fix: eliminate repeated JSONL delta reconstruction that starves extension host by @tianzheng-zhou in https://github.com/rajbos/github-copilot-token-usage/pull/565
* feat: add Prep Release custom agent by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/568
* chore: bump versions for release (VS Code extension) by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/570
* fix: gate VS extension job and harden marketplace version check by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/571
* Add per-tool suppression for unknown tool name notifications (#560) by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/563
* Fix: wrap long MCP tool names in session viewer by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/574
* fix: track token usage from sub-agent calls in Copilot agent mode (#567) by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/573
* Fix Copilot CLI session titles showing empty by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/575
* Show git branch in status bar when running in debug mode by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/576
* feat: Add Claude Desktop Cowork session support by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/572
* Add GitHub authentication support to extension by @Copilot in https://github.com/rajbos/github-copilot-token-usage/pull/182
* chore: bump VS Code extension version to 0.1.1 by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/578
* Potential fix for code scanning alert no. 53: Client-side cross-site scripting by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/579
### 📦 GitHub Actions Dependencies
* github-actions(deps): bump actions/download-artifact from 2.1.1 to 8.0.1 by @dependabot[bot] in https://github.com/rajbos/github-copilot-token-usage/pull/523
* github-actions(deps): bump github/codeql-action from 4.34.1 to 4.35.1 in the minor-and-patch-updates group by @dependabot[bot] in https://github.com/rajbos/github-copilot-token-usage/pull/522
* github-actions(deps): bump step-security/harden-runner from 2.16.0 to 2.16.1 in the minor-and-patch-updates group by @dependabot[bot] in https://github.com/rajbos/github-copilot-token-usage/pull/550
### 📦 Other Dependencies
* Bump esbuild from 0.27.4 to 0.27.5 in /cli by @dependabot[bot] in https://github.com/rajbos/github-copilot-token-usage/pull/541
* Bump esbuild from 0.27.5 to 0.28.0 in /cli by @dependabot[bot] in https://github.com/rajbos/github-copilot-token-usage/pull/544
* Bump @types/node from 25.5.0 to 25.5.2 in /cli by @dependabot[bot] in https://github.com/rajbos/github-copilot-token-usage/pull/546
* chore(deps): bump basic-ftp from 5.2.0 to 5.2.1 in /.github/scripts in the npm_and_yarn group across 1 directory by @dependabot[bot] in https://github.com/rajbos/github-copilot-token-usage/pull/564
* chore(deps): bump basic-ftp from 5.2.1 to 5.2.2 in /.github/scripts in the npm_and_yarn group across 1 directory by @dependabot[bot] in https://github.com/rajbos/github-copilot-token-usage/pull/577

## New Contributors
* @kasuken made their first contribution in https://github.com/rajbos/github-copilot-token-usage/pull/524
* @saschabuehrle made their first contribution in https://github.com/rajbos/github-copilot-token-usage/pull/545
* @Claude made their first contribution in https://github.com/rajbos/github-copilot-token-usage/pull/553
* @tianzheng-zhou made their first contribution in https://github.com/rajbos/github-copilot-token-usage/pull/565

**Full Changelog**: https://github.com/rajbos/github-copilot-token-usage/compare/vscode/v0.0.23...vscode/v0.1.1

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
