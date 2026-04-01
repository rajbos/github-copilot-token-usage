# Change Log

All notable changes to the VS Code extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

## [0.0.25]

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
### 📦 GitHub Actions Dependencies
* github-actions(deps): bump actions/download-artifact from 2.1.1 to 8.0.1 by @dependabot[bot] in https://github.com/rajbos/github-copilot-token-usage/pull/523
* github-actions(deps): bump github/codeql-action from 4.34.1 to 4.35.1 in the minor-and-patch-updates group by @dependabot[bot] in https://github.com/rajbos/github-copilot-token-usage/pull/522

## New Contributors
* @kasuken made their first contribution in https://github.com/rajbos/github-copilot-token-usage/pull/524

**Full Changelog**: https://github.com/rajbos/github-copilot-token-usage/compare/vscode/v0.0.23...vscode/v0.0.25

## [0.0.24] - 2026-03-28

### ✨ Features & Improvements
- Added Claude Code session file support as a usage analysis data source
- Added formatting options to details and log viewer panels
- Added friendly display names for container-tools and github-pull-request tools
- Added friendly display names for additional missing MCP/VS Code tools

## [0.0.23] - 2026-03-26

### ✨ Features & Improvements
- Renamed extension to **AI Engineering Fluency** (was "Copilot Token Tracker")
- Added friendly display names for CMakeTools and misc non-MCP tools
- Added friendly display names for Python and Pylance MCP tools
- Improved maturity scoring view with updated labels and layout
- Improved fluency level viewer with updated labels
- Updated details and diagnostics webview panel titles
- Added Visual Studio session file support (shared data layer)
- Added LICENSE file to extension package
