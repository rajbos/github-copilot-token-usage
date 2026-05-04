# Change Log

All notable changes to the VS Code extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

## [0.3.3]

<!-- Release notes generated using configuration in .github/release.yml at main -->

## What's Changed
### Changes
* chore: bump Visual Studio extension version to 1.0.5 by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/590
* feat: add Product Owner agent with rubber-duck multi-model reviews by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/591
* Fix Open VSX badge rendering by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/592
* feat: add token count column to diagnostics session files tab by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/593
* feat: add Day/Week/Month period toggle to chart view by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/594
* feat(chart): persist period selection and compact period picker UI by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/595
* chore: bump versions for release (vscode-extension) by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/596
* fix(workflows): consolidate VS extension release into release.yml by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/597
* test(maturity-scoring): add unit tests for Fluency Score logic by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/598
* test(workspace-helpers): add unit tests + fix off-by-one in extractCustomAgentName by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/599
* test(usage-analysis): add unit tests for mergeUsageAnalysis, analyzeContextReferences, deriveConversationPatterns by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/600
* Add test coverage to CI step summary by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/601
* ci: update workflows to Node.js 24 by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/603
* feat(tests): add Stryker mutation testing to VS Code extension by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/602
* fix: compute mutation score from counts instead of r.mutationScore by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/605
* test: improve mutation score from 29% to 40%+ with 89 targeted tests by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/608
* feat: cache-aware cost estimation for Claude and OpenCode sessions by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/607
* Add missing friendly names for click_element, mcp_github_pull_request_read, mcp_microsoftdocs_microsoft_docs_search, type_in_page by @Copilot in https://github.com/rajbos/ai-engineering-fluency/pull/614
* fix: skip VS filesystem scan on macOS/Linux to prevent extension hang (#611) by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/615
* docs: add Windsurf/Open VSX install badges and Windsurf details by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/617
* feat: display CO2 in kg when ≥ 1 000 g for readability by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/618
* Add sync-automatic-tools prompt by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/621
* Add missing friendly names for capitalized tool variants and cowork/workspace MCP tools by @Copilot in https://github.com/rajbos/ai-engineering-fluency/pull/620
* ci: skip mutation tests on PRs with no TS source changes by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/622
* Fix case-insensitive tool name lookup and remove duplicate entries by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/623
* Add repository statistics calculation script by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/624
* chore: bump versions for release (vscode-extension, cli, visualstudio-extension) by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/626
* chore(cli): bump version to v0.0.10 by @github-actions[bot] in https://github.com/rajbos/ai-engineering-fluency/pull/627
* fix: add node types to CLI tsconfig by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/629
* fix: use absolute URLs for logo image in README files by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/633
* test: extend coverage gate to core data pipeline modules (#630) by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/634
* Extract GitHub PR feature into a dedicated testable service by @Copilot in https://github.com/rajbos/ai-engineering-fluency/pull/635
* Add empty-state guidance for first-time users in the Details panel by @Copilot in https://github.com/rajbos/ai-engineering-fluency/pull/636
* chore: bump versions for release (vscode-extension, visualstudio-extension) by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/637
* feature/mistralvibe integration by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/640
* fix prompt front matter by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/642
* fix: rename VS Code command IDs to aiEngineeringFluency.* by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/643
* refactor: replace ecosystem if-chains with IEcosystemAdapter registry by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/641
* fix: discover Windows-side VS Code sessions when running inside WSL by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/650
* Add missing friendly display names for 10 tools by @Copilot in https://github.com/rajbos/ai-engineering-fluency/pull/651
* Add friendly name for Azure MCP `get_bestpractices` tool by @Copilot in https://github.com/rajbos/ai-engineering-fluency/pull/652
* fix: handle case-sensitive extension ID and nested chatSessions path by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/653
* fix: use content timestamps for lastInteraction, not max(timestamp, mtime) by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/655
* Extract CopilotChat and CopilotCli adapters (#654) by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/656
* feat: self-hosted sharing server (Phases 1–3) by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/639
* feat: add dedicated CLI interaction mode in Usage Analysis by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/659
* fix: pin Docker base image to SHA256 digest by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/660
* fix(usage-analysis): prevent blank page on cold start and improve error handling by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/661
* docs: add sharing server setup guide with dashboard screenshot by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/662
* Add friendly names for `Microsoft_Learn_microsoft_docs_search` and `get_output_window_logs` by @Copilot in https://github.com/rajbos/ai-engineering-fluency/pull/664
* Refresh model pricing data from current provider docs by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/666
* Fix VS Code extension security alerts by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/665
* Potential fix for code scanning alert no. 56: Client-side cross-site scripting by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/668
* fix: update uuid to 14.0.0 via overrides (GHSA-w5hq-g745-h8pq) by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/669
* Stabilize VS Code extension npm test runs by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/670
* feat: improve fluency spiderweb for Claude-only users by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/672
* feat: add AI fluency score to sharing server dashboard by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/671
* Add missing friendly display names for 13 tools (Claude/MCP variants) by @Copilot in https://github.com/rajbos/ai-engineering-fluency/pull/675
* chore: bump versions for release (vscode-extension, cli, visualstudio-extension) by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/676
* chore: update in-range dev dependencies by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/679
* feat: complete non-copilot instruction file detection (Missed Potential) by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/681
* refactor: remove (tokenTracker as any) casts in activate() by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/680
* Add Figma MCP tool friendly names by @Copilot in https://github.com/rajbos/ai-engineering-fluency/pull/682
* Remove PAT login from sharing server by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/683
* fix toolnames discovery by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/684
* Add GitHub Copilot AI-Credit pricing alongside provider pricing by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/685
* chore: bump versions for release (vscode-extension v0.2.1) by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/688
* chore: bump Visual Studio extension to v1.0.10 by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/690
* chore(cli): bump version to v0.0.12 by @github-actions[bot] in https://github.com/rajbos/ai-engineering-fluency/pull/689
* feat: Azure Container Apps deployment for sharing server (Terraform + workflows) by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/677
* feat: scan workspaceStorage debug-logs directories for session files by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/692
* fix: populate dailyRollups for Mistral Vibe and Claude Desktop Cowork sessions by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/693
* feat(sharing-server): add ADMIN_GITHUB_LOGINS for declarative admin management by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/691
* feat(sharing-server): admin token usage dashboard by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/694
* feat: load and log Copilot plan info from copilot_internal/user API by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/687
* Add missing friendly display names for 28 tools by @Copilot in https://github.com/rajbos/ai-engineering-fluency/pull/695
* sharing-server: add admin overview dashboard with aggregate stats and trend chart by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/696
* chore: make test environment cleanup manual-only by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/697
* feat: add deploy_to_test workflow_dispatch input by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/698
* chore: bump versions for release (vscode-extension, cli) by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/699
* chore(cli): bump version to v0.0.14 by @github-actions[bot] in https://github.com/rajbos/ai-engineering-fluency/pull/700
* fix: show Configure Backend button when backend storage info is unavailable by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/701
* feat: add target_app workflow_dispatch input to update named test environments by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/702
* fix: exclude suppressed tools from unknown tools banner by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/704
* feat: add estimated cost view to chart page by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/703
* fix: use esbuild as preLaunchTask so F5 debug always works by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/705
* feat(sharing-server): add deployment footer with version info by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/706
* feat: first-value onboarding empty-state guidance and Scoring Guide panel by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/710
* feat: extract pure stats helpers and add date-boundary contract tests by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/711
* feat: add macOS path support for Claude Desktop Cowork sessions by @Copilot in https://github.com/rajbos/ai-engineering-fluency/pull/714
* chore: bump versions for release (vscode-extension 0.3.0, cli 0.0.14) by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/715
* fix: replace hardcoded dark backgrounds in log viewer with theme CSS variables by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/716
* feat: daily auto-sync of model multipliers from github-copilot-model-notifier by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/718
* fix: eco-session token count in diagnostics matches file viewer by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/717
* feat(vscode): add JetBrains IDE Copilot session discovery by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/719
* Extract pure stats helpers and add date-boundary contract tests by @Copilot in https://github.com/rajbos/ai-engineering-fluency/pull/709
* fix: count subagent tool results in token estimation + show subagent count in log viewer by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/720
* fix: change esbuild prelaunch task to type process by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/722
* Add dev.ps1 convenience script for VS Code extension development by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/721
* fix dev script by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/724
* feat: add Path Analyzer tab to diagnostics panel by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/713
* Add friendly names and usage tracking for Copilot CLI built-in tools by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/723
* Add friendly display names for 16 unknown tools by @Copilot in https://github.com/rajbos/ai-engineering-fluency/pull/726
* Rename project to 'AI Engineering Fluency' by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/729
* ci: convert mutation testing to daily scheduled run with Copilot CLI follow-up by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/727
* fix: use relative path for header image in marketplace README (v0.3.1) by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/730
* feat: dual-publish VS Code extension under new AI Engineering Fluency ID by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/731
* fix: handle cert timeout leaving non-Succeeded state in Azure by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/732
* Detect JetBrains editor + ask/agent mode in usage stats by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/728
* fix: don't pass custom domain to branch test environments by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/734
* feat: add DNS drift detection to sharing server deploy workflow by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/737
* feat: auto-cleanup per-branch ACA test environments on branch deletion by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/738
* chore: sync model data from rajbos/github-copilot-model-notifier by @github-actions[bot] in https://github.com/rajbos/ai-engineering-fluency/pull/736
* fix: unbind custom domains and delete managed certs before terraform destroy by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/739
* feat(sharing-server): improve admin/user nav distinction and clean up dashboard by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/741
* Add missing friendly names for Context7, Microsoft Docs, and Slidev tools by @Copilot in https://github.com/rajbos/ai-engineering-fluency/pull/742
* feat: add JetBrains plugin scaffold (Kotlin + IntelliJ Platform v2) by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/733
* fix: disable installed extension when running in debug mode by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/743
* fix(jetbrains): fix chart period switchers not working after refresh by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/745
* fix: populate estimated cost data in chart view for all periods by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/744
* fix(cli): align token counting with VS Code extension by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/740
* Add Gradle wrapper upkeep checks by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/747
* Document observed Gemini CLI session format by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/748
* Fix cost estimate reason by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/749
* Add official tool logos to the README by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/759
* Add Gemini CLI session support by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/761
* feat: detect and surface Copilot PR chat context references (#pr) by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/760
* chore: bump versions for release (vscode-extension, cli, visualstudio-extension) by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/762
* fix(release): rename legacy VSIX display name and flip publish order by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/763
* fix(release): use unique display name for legacy VSIX by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/764
* feat(vscode): show migration notice in deprecated copilot-token-tracker extension by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/765
* chore: bump versions for release (vscode-extension) by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/766
* fix: auto-commit regenerated gradle wrapper files on PR by @rajbos in https://github.com/rajbos/ai-engineering-fluency/pull/767
### 📦 GitHub Actions Dependencies
* github-actions(deps): bump the minor-and-patch-updates group with 3 updates by @dependabot[bot] in https://github.com/rajbos/ai-engineering-fluency/pull/606
* github-actions(deps): bump the minor-and-patch-updates group with 4 updates by @dependabot[bot] in https://github.com/rajbos/ai-engineering-fluency/pull/628
* github-actions(deps): bump step-security/harden-runner from 2.18.0 to 2.19.0 in the minor-and-patch-updates group by @dependabot[bot] in https://github.com/rajbos/ai-engineering-fluency/pull/673
* github-actions(deps): bump docker/login-action from 3.7.0 to 4.1.0 by @dependabot[bot] in https://github.com/rajbos/ai-engineering-fluency/pull/755
* github-actions(deps): bump docker/build-push-action from 6.19.2 to 7.1.0 by @dependabot[bot] in https://github.com/rajbos/ai-engineering-fluency/pull/758
* github-actions(deps): bump docker/metadata-action from 5.10.0 to 6.0.0 by @dependabot[bot] in https://github.com/rajbos/ai-engineering-fluency/pull/756
* github-actions(deps): bump the minor-and-patch-updates group across 1 directory with 3 updates by @dependabot[bot] in https://github.com/rajbos/ai-engineering-fluency/pull/754
* github-actions(deps): bump docker/setup-buildx-action from 3.12.0 to 4.0.0 by @dependabot[bot] in https://github.com/rajbos/ai-engineering-fluency/pull/757
### 📦 Other Dependencies
* chore(deps): bump basic-ftp from 5.2.2 to 5.3.0 in /.github/scripts in the npm_and_yarn group across 1 directory by @dependabot[bot] in https://github.com/rajbos/ai-engineering-fluency/pull/612
* chore(deps): bump dompurify from 3.3.2 to 3.4.0 in /vscode-extension in the npm_and_yarn group across 1 directory by @dependabot[bot] in https://github.com/rajbos/ai-engineering-fluency/pull/610
* chore(deps-dev): bump typescript from 6.0.2 to 6.0.3 in /cli by @dependabot[bot] in https://github.com/rajbos/ai-engineering-fluency/pull/616
* chore(deps): bump puppeteer from 24.40.0 to 24.41.0 in /.github/scripts by @dependabot[bot] in https://github.com/rajbos/ai-engineering-fluency/pull/609
* chore(deps): bump puppeteer from 24.41.0 to 24.42.0 in /.github/scripts by @dependabot[bot] in https://github.com/rajbos/ai-engineering-fluency/pull/638
* chore(deps): bump fast-xml-parser from 5.5.7 to 5.7.1 in /.github/skills/azure-storage-loader in the npm_and_yarn group across 1 directory by @dependabot[bot] in https://github.com/rajbos/ai-engineering-fluency/pull/645
* chore(deps): bump fast-xml-parser from 5.5.7 to 5.7.1 in /vscode-extension in the npm_and_yarn group across 1 directory by @dependabot[bot] in https://github.com/rajbos/ai-engineering-fluency/pull/644
* chore(deps-dev): bump esbuild from 0.24.2 to 0.25.0 in /sharing-server in the npm_and_yarn group across 1 directory by @dependabot[bot] in https://github.com/rajbos/ai-engineering-fluency/pull/657
* chore(deps): bump postcss from 8.5.8 to 8.5.10 in /vscode-extension in the npm_and_yarn group across 1 directory by @dependabot[bot] in https://github.com/rajbos/ai-engineering-fluency/pull/667
* gradle(deps): bump org.junit:junit-bom from 5.11.4 to 6.0.3 in /jetbrains-plugin by @dependabot[bot] in https://github.com/rajbos/ai-engineering-fluency/pull/752
* gradle(deps): bump org.gradle.toolchains.foojay-resolver-convention from 0.8.0 to 1.0.0 in /jetbrains-plugin by @dependabot[bot] in https://github.com/rajbos/ai-engineering-fluency/pull/753
* gradle(deps): bump the minor-and-patch-updates group across 1 directory with 2 updates by @dependabot[bot] in https://github.com/rajbos/ai-engineering-fluency/pull/750


**Full Changelog**: https://github.com/rajbos/ai-engineering-fluency/compare/cli/v0.0.8...vscode/v0.3.3

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
