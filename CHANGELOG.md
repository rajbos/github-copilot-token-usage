# Change Log

All notable changes to the "copilot-token-tracker" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.0.14]

## What's Changed
### ✨ Features & Improvements
* Add reset button to restore dismissed fluency tips by @Copilot in https://github.com/rajbos/github-copilot-token-usage/pull/292
* Improve radar chart size and label positioning by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/293
* Enhance tips and fluency guidance with documentation links by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/296
* Improve logging for VS Code and OpenCode session path discovery by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/301
* Add per-row data cleanup button in Team Dashboard by @Virginia-Hamra in https://github.com/rajbos/github-copilot-token-usage/pull/302
* Add fluency metrics to Azure Table Storage with unified team scoring by @Copilot in https://github.com/rajbos/github-copilot-token-usage/pull/303
* Add non-Copilot customization file detection (Cursor, Windsurf, Claude, etc.) by @FokkoVeegens in https://github.com/rajbos/github-copilot-token-usage/pull/304
* Add repo hygiene scanner for Copilot best practices by @UncleBats in https://github.com/rajbos/github-copilot-token-usage/pull/305
* Fix token totals: support new API formats and add regex fallback for malformed logs by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/306
* Soften fluency level 1 & 2 colors from red/orange to lighter blue/green by @Copilot in https://github.com/rajbos/github-copilot-token-usage/pull/309
* Make Fluency Level Viewer available to all users (not just debug mode) by @Copilot in https://github.com/rajbos/github-copilot-token-usage/pull/311
* Enhance repo hygiene: add docs links and "Ask Copilot to Improve" button by @Copilot in https://github.com/rajbos/github-copilot-token-usage/pull/314
* Preserve webview UI state during background timer updates by @Copilot in https://github.com/rajbos/github-copilot-token-usage/pull/315
* Add Fluency Score news banner shown after 5 extension opens by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/316
* Show notification for unknown tools after 8 extension opens by @Copilot in https://github.com/rajbos/github-copilot-token-usage/pull/317
* Add missing friendly names for MCP tools (Context7, Playwright) by @Copilot in https://github.com/rajbos/github-copilot-token-usage/pull/319
* Update Context7 MCP tool display names by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/320
* Add missing friendly names for 14 tools (bash, claude-code, glob, grep, etc.) by @Copilot in https://github.com/rajbos/github-copilot-token-usage/pull/323
* Expand unknown tool detection to all tools, not just MCP by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/324
* Add pre-release checklist, screenshot/demo mode config, automate pre-release steps by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/326
* Add screenshot capture scripts by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/334
### 🐛 Bug Fixes
* Fix CSP violation and button rendering issues in production builds by @UncleBats in https://github.com/rajbos/github-copilot-token-usage/pull/295
* Refactor file stat handling to always check for file modifications by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/299
### 📝 Documentation
* Document WSL environment requirements for session data tracking by @Copilot in https://github.com/rajbos/github-copilot-token-usage/pull/300
* Update README Known Issues to reflect actual (not estimated) token usage by @Copilot in https://github.com/rajbos/github-copilot-token-usage/pull/321
### 🔒 Security
* Sanitize model names and dynamic content to prevent XSS vulnerabilities by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/325
* Escape HTML in diagnostics and usage analysis webviews to prevent XSS by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/327
* Fix code scanning alert #32: harden formatFileSize against DOM-based XSS by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/329
* Fix code scanning alert #45: add sanitizeStats to validate postMessage data by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/330
* Fix TypeScript errors in sanitizeStats XSS security fix by @Copilot in https://github.com/rajbos/github-copilot-token-usage/pull/331
* Fix code scanning alert #32: escape editorName and title fields in session table by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/332
* Fix 4 npm dependency vulnerabilities (ajv, markdown-it, diff, serialize-javascript) by @Copilot in https://github.com/rajbos/github-copilot-token-usage/pull/333
### 🔧 CI / Workflow
* Pin @github/copilot CLI version in package.json for Dependabot tracking by @Copilot in https://github.com/rajbos/github-copilot-token-usage/pull/294
* Skip model-sync PR creation when only lastUpdated metadata changes by @Copilot in https://github.com/rajbos/github-copilot-token-usage/pull/297
* Fix Pinned-Dependencies scorecard alert: use npm ci in copilot-setup-steps by @Copilot in https://github.com/rajbos/github-copilot-token-usage/pull/298
* Fix npm ci usage in scrape-models.sh to comply with OpenSSF scorecard by @Copilot in https://github.com/rajbos/github-copilot-token-usage/pull/308
### 📦 Dependencies
* Bump basic-ftp from 5.1.0 to 5.2.0 by @dependabot in https://github.com/rajbos/github-copilot-token-usage/pull/307
* Bump minimatch from 3.1.2 to 3.1.5 by @dependabot in https://github.com/rajbos/github-copilot-token-usage/pull/310
* Bump fast-xml-parser from 5.3.6 to 5.4.1 by @dependabot in https://github.com/rajbos/github-copilot-token-usage/pull/312
* Bump fast-xml-parser from 5.3.6 to 5.4.1 in azure-storage-loader by @dependabot in https://github.com/rajbos/github-copilot-token-usage/pull/313
## New Contributors
* @Virginia-Hamra made their first contribution in https://github.com/rajbos/github-copilot-token-usage/pull/302
* @FokkoVeegens made their first contribution in https://github.com/rajbos/github-copilot-token-usage/pull/304
* @UncleBats made their first contribution in https://github.com/rajbos/github-copilot-token-usage/pull/295

## [0.0.13]

### Changed
- Adding fix for Code - Insiders.
- Show stats for all different editors:
-  — Stable VS Code release
-  — VS Code Insiders (preview) builds
-  — Exploration/pre-release builds
-  — Community-built VS Code distribution
-  — Cursor editor
- Update model colors to avoid using grey/white/black for the largest models.
### Dependencies
- Bump devops-actions/issue-comment-tag from 0.1.8 to 0.1.9.
- Bump the minor-and-patch-updates group with 4 updates.
## [0.0.7]
## [0.0.6]
### Added
- Diagnostic report generation for troubleshooting extension issues.
## [0.0.5]
## [0.0.4]
### Added
- Intelligent file caching to improve performance when processing session files.
- Cache management with automatic size limits and cleanup of non-existent files.
- Cache hit/miss rate logging for performance monitoring.
### Changed
- Session file processing now uses cached data when files haven't been modified.
- Reduced file I/O operations during periodic updates for better performance.
## [0.0.3]
## [0.0.2]
### Added
- CI build pipeline with GitHub Actions.
- GitHub issue templates for bug reports and feature requests.
- Development guidelines for minimal file changes to Copilot instructions.
-  file with bug report guidance.
- Button to refresh the data on demand.
- Estimated water usage tracking to token usage display.
- Support for other platforms (macOS, Linux).
- Dependabot configuration for automated dependency and GitHub Actions updates.
### Changed
- Added missing publishing info.

## [0.0.12]

### Changed
- Adding fix for Code - Insiders.
- Show stats for all different editors:
-  — Stable VS Code release
-  — VS Code Insiders (preview) builds
-  — Exploration/pre-release builds
-  — Community-built VS Code distribution
-  — Cursor editor
- Update model colors to avoid using grey/white/black for the largest models.
### Dependencies
- Bump devops-actions/issue-comment-tag from 0.1.8 to 0.1.9.
- Bump the minor-and-patch-updates group with 4 updates.
## [0.0.7]
## [0.0.6]
### Added
- Diagnostic report generation for troubleshooting extension issues.
## [0.0.5]
## [0.0.4]
### Added
- Intelligent file caching to improve performance when processing session files.
- Cache management with automatic size limits and cleanup of non-existent files.
- Cache hit/miss rate logging for performance monitoring.
### Changed
- Session file processing now uses cached data when files haven't been modified.
- Reduced file I/O operations during periodic updates for better performance.
## [0.0.3]
## [0.0.2]
### Added
- CI build pipeline with GitHub Actions.
- GitHub issue templates for bug reports and feature requests.
- Development guidelines for minimal file changes to Copilot instructions.
-  file with bug report guidance.
- Button to refresh the data on demand.
- Estimated water usage tracking to token usage display.
- Support for other platforms (macOS, Linux).
- Dependabot configuration for automated dependency and GitHub Actions updates.
### Changed
- Added missing publishing info.

## [0.0.11]

## What's Changed
* open log file by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/147
* Add devContainer by @UncleBats in https://github.com/rajbos/github-copilot-token-usage/pull/148
* Copilot tooltip enhancements by @JasperGilhuis in https://github.com/rajbos/github-copilot-token-usage/pull/149
* minor text updates by @JasperGilhuis in https://github.com/rajbos/github-copilot-token-usage/pull/152
* Refactor model detection to use modelPricing.json data by @Copilot in https://github.com/rajbos/github-copilot-token-usage/pull/151
* Add Azure Storage backend integration with comprehensive sync, sharing, and analytics capabilities by @jongio in https://github.com/rajbos/github-copilot-token-usage/pull/145
* 🐛 Fix dashboard data discrepancy by @liubchigo in https://github.com/rajbos/github-copilot-token-usage/pull/153
* Readd file viewer link again by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/156
* Prevent status bar animations on timer updates by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/158
* Convert tool calls display from list to table in file viewer by @Copilot in https://github.com/rajbos/github-copilot-token-usage/pull/159
* Add load-cache-data agent skill for inspecting session file cache by @Copilot in https://github.com/rajbos/github-copilot-token-usage/pull/161
* Add azure-storage-loader skill for querying token usage data from Azure Tables by @Copilot in https://github.com/rajbos/github-copilot-token-usage/pull/162
* add information where logs from the devContainer are stored by @UncleBats in https://github.com/rajbos/github-copilot-token-usage/pull/160
* Persist active tab state in diagnostic view by @Copilot in https://github.com/rajbos/github-copilot-token-usage/pull/164
* Add Azure Storage backend configuration panel to diagnostics by @Copilot in https://github.com/rajbos/github-copilot-token-usage/pull/163
* Show last month stats next to this month by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/166
* Add clickable links for empty sessions in Diagnostic Report by @Copilot in https://github.com/rajbos/github-copilot-token-usage/pull/165
* Enhance usage analysis with model tracking features by @FokkoVeegens in https://github.com/rajbos/github-copilot-token-usage/pull/157
* Progressive loading for diagnostics view - eliminate 10-30s UI blocking by @Copilot in https://github.com/rajbos/github-copilot-token-usage/pull/169
* detect implicit selections by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/176
* Potential fix for code scanning alert no. 22: Client-side cross-site scripting by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/175
* Potential fix for code scanning alert no. 26: Client-side cross-site scripting by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/174
* Fix cache loading by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/171
* Potential fix for code scanning alert no. 25: Client-side cross-site scripting by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/173
* Add formatted JSONL viewer to diagnostics by @Copilot in https://github.com/rajbos/github-copilot-token-usage/pull/170
* copilot/update jsonl file viewer by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/180
* Cache session file details for diagnostics to avoid repeated disk I/O by @Copilot in https://github.com/rajbos/github-copilot-token-usage/pull/178
* Use rolling 30-day window for annual projections instead of current month by @Copilot in https://github.com/rajbos/github-copilot-token-usage/pull/179
* Fix vuln deps links by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/181
* Skip validate job when skill matrix is empty by @Copilot in https://github.com/rajbos/github-copilot-token-usage/pull/183
* Potential fix for code scanning alert no. 22: Client-side cross-site scripting by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/184
* repo refs by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/185
* Detect #sym references and fix diagnostics logging by @Copilot in https://github.com/rajbos/github-copilot-token-usage/pull/186
* Add pricing data for claude-opus-4.6-fast model by @Copilot in https://github.com/rajbos/github-copilot-token-usage/pull/189
* Fix MCP tool detection from toolNames.json by @Copilot in https://github.com/rajbos/github-copilot-token-usage/pull/192
* Update cache version and enhance MCP tools detection in session analysis by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/193
* Enforce npm ci to prevent package-lock.json churn from peer dependencies by @Copilot in https://github.com/rajbos/github-copilot-token-usage/pull/190
* Track additional GitHub Copilot context commands (#terminalLastCommand, #clipboard, etc.) by @Copilot in https://github.com/rajbos/github-copilot-token-usage/pull/188
* Add Claude Opus 4.6 model support by @Copilot in https://github.com/rajbos/github-copilot-token-usage/pull/198
* Bump version by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/199
* Fix sync-release-notes workflow: set upstream on branch push by @Copilot in https://github.com/rajbos/github-copilot-token-usage/pull/200
## Dependency updates
* npm(deps-dev): bump the minor-and-patch-updates group with 2 updates by @dependabot[bot] in https://github.com/rajbos/github-copilot-token-usage/pull/167
* npm(deps): bump @azure/arm-subscriptions from 5.1.1 to 6.0.0 by @dependabot[bot] in https://github.com/rajbos/github-copilot-token-usage/pull/168
* npm(deps-dev): bump the minor-and-patch-updates group with 3 updates by @dependabot[bot] in https://github.com/rajbos/github-copilot-token-usage/pull/194
* github-actions(deps): bump the minor-and-patch-updates group with 2 updates by @dependabot[bot] in https://github.com/rajbos/github-copilot-token-usage/pull/196
* npm(deps): bump jsdom from 27.4.0 to 28.0.0 by @dependabot[bot] in https://github.com/rajbos/github-copilot-token-usage/pull/197
## New Contributors
* @UncleBats made their first contribution in https://github.com/rajbos/github-copilot-token-usage/pull/148
* @JasperGilhuis made their first contribution in https://github.com/rajbos/github-copilot-token-usage/pull/149
* @jongio made their first contribution in https://github.com/rajbos/github-copilot-token-usage/pull/145
* @liubchigo made their first contribution in https://github.com/rajbos/github-copilot-token-usage/pull/153
* @FokkoVeegens made their first contribution in https://github.com/rajbos/github-copilot-token-usage/pull/157

## [0.0.10]

### Changed
- Adding fix for Code - Insiders.
- Show stats for all different editors:
-  — Stable VS Code release
-  — VS Code Insiders (preview) builds
-  — Exploration/pre-release builds
-  — Community-built VS Code distribution
-  — Cursor editor
- Update model colors to avoid using grey/white/black for the largest models.
### Dependencies
- Bump devops-actions/issue-comment-tag from 0.1.8 to 0.1.9.
- Bump the minor-and-patch-updates group with 4 updates.
## [0.0.7]
## [0.0.6]
### Added
- Diagnostic report generation for troubleshooting extension issues.
## [0.0.5]
## [0.0.4]
### Added
- Intelligent file caching to improve performance when processing session files.
- Cache management with automatic size limits and cleanup of non-existent files.
- Cache hit/miss rate logging for performance monitoring.
### Changed
- Session file processing now uses cached data when files haven't been modified.
- Reduced file I/O operations during periodic updates for better performance.
## [0.0.3]
## [0.0.2]
### Added
- CI build pipeline with GitHub Actions.
- GitHub issue templates for bug reports and feature requests.
- Development guidelines for minimal file changes to Copilot instructions.
-  file with bug report guidance.
- Button to refresh the data on demand.
- Estimated water usage tracking to token usage display.
- Support for other platforms (macOS, Linux).
- Dependabot configuration for automated dependency and GitHub Actions updates.
### Changed
- Added missing publishing info.

## [0.0.9]

### Changed
- Adding fix for Code - Insiders.
- Show stats for all different editors:
-  — Stable VS Code release
-  — VS Code Insiders (preview) builds
-  — Exploration/pre-release builds
-  — Community-built VS Code distribution
-  — Cursor editor
- Update model colors to avoid using grey/white/black for the largest models.
### Dependencies
- Bump devops-actions/issue-comment-tag from 0.1.8 to 0.1.9.
- Bump the minor-and-patch-updates group with 4 updates.
## [0.0.7]
## [0.0.6]
### Added
- Diagnostic report generation for troubleshooting extension issues.
## [0.0.5]
## [0.0.4]
### Added
- Intelligent file caching to improve performance when processing session files.
- Cache management with automatic size limits and cleanup of non-existent files.
- Cache hit/miss rate logging for performance monitoring.
### Changed
- Session file processing now uses cached data when files haven't been modified.
- Reduced file I/O operations during periodic updates for better performance.
## [0.0.3]
## [0.0.2]
### Added
- CI build pipeline with GitHub Actions.
- GitHub issue templates for bug reports and feature requests.
- Development guidelines for minimal file changes to Copilot instructions.
-  file with bug report guidance.
- Button to refresh the data on demand.
- Estimated water usage tracking to token usage display.
- Support for other platforms (macOS, Linux).
- Dependabot configuration for automated dependency and GitHub Actions updates.
### Changed
- Added missing publishing info.

## [0.0.8]

## What's Changed
* Adding fix for Code - Insiders by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/111
* Update model colors by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/112
* Support views for different editors:
- `Code` — Stable VS Code release
- `Code - Insiders` — VS Code Insiders (preview) builds
- `Code - Exploration` — Exploration/pre-release builds
- `VSCodium` — Community-built VS Code distribution
- `Cursor` — Cursor editor
- <img width="1142" height="772" alt="image" src="https://github.com/user-attachments/assets/20f31a38-1a9e-44c0-a0b6-8e79dc5a5c34" />
## Dependency updates
* github-actions(deps): bump devops-actions/issue-comment-tag from 0.1.8 to 0.1.9 by @dependabot[bot] in https://github.com/rajbos/github-copilot-token-usage/pull/109
* npm(deps-dev): bump the minor-and-patch-updates group with 4 updates by @dependabot[bot] in https://github.com/rajbos/github-copilot-token-usage/pull/110
* Update docs by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/113

## [0.0.7]

### Added
- Intelligent file caching to improve performance when processing session files
- Cache management with automatic size limits and cleanup of non-existent files
- Cache hit/miss rate logging for performance monitoring
### Changed
- Session file processing now uses cached data when files haven't been modified
- Reduced file I/O operations during periodic updates for better performance
- Initial release
- Automated VSIX build and release workflow

## [0.0.6]

## What's Changed
* Add diagnostic report generation for troubleshooting extension issues by @Copilot in https://github.com/rajbos/github-copilot-token-usage/pull/103
## Other changes
* Update prelaunch tasks by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/101
* Add error message display to release workflow step summary by @Copilot in https://github.com/rajbos/github-copilot-token-usage/pull/99
* * docs updates by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/104
## Dependencies
* npm(deps-dev): bump the minor-and-patch-updates group with 2 updates by @dependabot[bot] in https://github.com/rajbos/github-copilot-token-usage/pull/100

## [0.0.5]

## What's Changed
* Update model names by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/96
* Add chart panel for day-by-day token usage visualization by @Copilot in https://github.com/rajbos/github-copilot-token-usage/pull/93
* Chart by model by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/94
* Show loading on start by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/95
- <img width="1278" height="1019" alt="image" src="https://github.com/user-attachments/assets/d7a72fd1-2ea4-4da9-b276-fb6b3a63d539" />
## Other updates
* Change CodeQL language matrix to include actions by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/82
* Update publish script with extra checks by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/85
* Update GitHub Script action version in workflow by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/84
* Release by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/97
## Dependency updates
* github-actions(deps): bump actions/github-script from 7.1.0 to 8.0.0 by @dependabot[bot] in https://github.com/rajbos/github-copilot-token-usage/pull/90
* github-actions(deps): bump step-security/harden-runner from 2.13.1 to 2.14.0 by @dependabot[bot] in https://github.com/rajbos/github-copilot-token-usage/pull/87
* npm(deps-dev): bump qs from 6.14.0 to 6.14.1 by @dependabot[bot] in https://github.com/rajbos/github-copilot-token-usage/pull/92
* github-actions(deps): bump actions/setup-node from 4.4.0 to 6.1.0 by @dependabot[bot] in https://github.com/rajbos/github-copilot-token-usage/pull/91
* github-actions(deps): bump actions/checkout from 4.3.0 to 6.0.1 by @dependabot[bot] in https://github.com/rajbos/github-copilot-token-usage/pull/88
* github-actions(deps): bump actions/upload-artifact from 4.6.2 to 6.0.0 by @dependabot[bot] in https://github.com/rajbos/github-copilot-token-usage/pull/86
* npm(deps-dev): bump the minor-and-patch-updates group with 2 updates by @dependabot[bot] in https://github.com/rajbos/github-copilot-token-usage/pull/89

## [0.0.4]

### Added
- Intelligent file caching to improve performance when processing session files
- Cache management with automatic size limits and cleanup of non-existent files
- Cache hit/miss rate logging for performance monitoring
### Changed
- Session file processing now uses cached data when files haven't been modified
- Reduced file I/O operations during periodic updates for better performance
- Initial release
- Automated VSIX build and release workflow

## [0.0.3]

### Added
- Intelligent file caching to improve performance when processing session files
- Cache management with automatic size limits and cleanup of non-existent files
- Cache hit/miss rate logging for performance monitoring
### Changed
- Session file processing now uses cached data when files haven't been modified
- Reduced file I/O operations during periodic updates for better performance
- Initial release
- Automated VSIX build and release workflow

## [0.0.2]

## What's Changed
* Add CI build pipeline with GitHub Actions by @Copilot in https://github.com/rajbos/github-copilot-token-usage/pull/9
* Add GitHub issue templates for bug reports and feature requests by @Copilot in https://github.com/rajbos/github-copilot-token-usage/pull/2
* Add development guidelines for minimal file changes to Copilot instructions by @Copilot in https://github.com/rajbos/github-copilot-token-usage/pull/13
* Add SUPPORT.md file with bug report guidance by @Copilot in https://github.com/rajbos/github-copilot-token-usage/pull/4
* Add missing publishing info by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/15
* button to refresh the data on demand by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/16
* Add estimated water usage tracking to token usage display by @Copilot in https://github.com/rajbos/github-copilot-token-usage/pull/11
* Add support for other platforms by @readefries in https://github.com/rajbos/github-copilot-token-usage/pull/14
* Add Dependabot configuration for automated dependency and GitHub Actions updates by @Copilot in https://github.com/rajbos/github-copilot-token-usage/pull/6
* github-actions(deps): bump actions/setup-node from 4 to 5 by @dependabot[bot] in https://github.com/rajbos/github-copilot-token-usage/pull/20
* github-actions(deps): bump actions/checkout from 4 to 5 by @dependabot[bot] in https://github.com/rajbos/github-copilot-token-usage/pull/19
* npm(deps-dev): bump @types/node from 22.18.6 to 24.5.2 by @dependabot[bot] in https://github.com/rajbos/github-copilot-token-usage/pull/21
* Add automated VSIX build and release workflow for version tags by @Copilot in https://github.com/rajbos/github-copilot-token-usage/pull/18
* Committing new version number for new release by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/24
* Add permissions for release job in workflow by @rajbos in https://github.com/rajbos/github-copilot-token-usage/pull/26
* [StepSecurity] Apply security best practices by @step-security-bot in https://github.com/rajbos/github-copilot-token-usage/pull/25
## New Contributors
* @Copilot made their first contribution in https://github.com/rajbos/github-copilot-token-usage/pull/9
* @rajbos made their first contribution in https://github.com/rajbos/github-copilot-token-usage/pull/15
* @readefries made their first contribution in https://github.com/rajbos/github-copilot-token-usage/pull/14
* @dependabot[bot] made their first contribution in https://github.com/rajbos/github-copilot-token-usage/pull/20
* @step-security-bot made their first contribution in https://github.com/rajbos/github-copilot-token-usage/pull/25

## [0.0.1] - Pre-release

- First rough version, not complete of course!
- Only tested on windows
- Use at your own risk 😄
- Screenshots in the README
- VS Code v1.104 or higher
