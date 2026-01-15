# Change Log

All notable changes to the "copilot-token-tracker" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.0.8]

### Changed
- Adding fix for Code - Insiders.
- Show stats for all different editors:
  - `Code` — Stable VS Code release
  - `Code - Insiders` — VS Code Insiders (preview) builds
  - `Code - Exploration` — Exploration/pre-release builds
  - `VSCodium` — Community-built VS Code distribution
  - `Cursor` — Cursor editor
- Update model colors to avoid using grey/white/black for the largest models.

### Dependencies
- Bump devops-actions/issue-comment-tag from 0.1.8 to 0.1.9.
- Bump the minor-and-patch-updates group with 4 updates.

## [0.0.7]

### Added
- Support for VS Code Insiders, VSCodium, Cursor and other VS Code variants.
- Support for Copilot CLI session files (`.jsonl`).
- Display of token usage per editor in the details panel and chart view.

### Changed
- Improved session file discovery to be more robust across different environments.
- Updated README with new features and improved formatting.

## [0.0.6]

### Added
- Diagnostic report generation for troubleshooting extension issues.

## [0.0.5]

### Added
- Chart panel for day-by-day token usage visualization.
- Ability to view token usage by model in the chart.

### Changed
- Updated model names for better accuracy.
- Show a loading indicator on startup.

## [0.0.4]

### Added
- Intelligent file caching to improve performance when processing session files.
- Cache management with automatic size limits and cleanup of non-existent files.
- Cache hit/miss rate logging for performance monitoring.

### Changed
- Session file processing now uses cached data when files haven't been modified.
- Reduced file I/O operations during periodic updates for better performance.

## [0.0.3]

### Changed
- Automated VSIX build and release workflow.

## [0.0.2]

### Added
- CI build pipeline with GitHub Actions.
- GitHub issue templates for bug reports and feature requests.
- Development guidelines for minimal file changes to Copilot instructions.
- `SUPPORT.md` file with bug report guidance.
- Button to refresh the data on demand.
- Estimated water usage tracking to token usage display.
- Support for other platforms (macOS, Linux).
- Dependabot configuration for automated dependency and GitHub Actions updates.

### Changed
- Added missing publishing info.

## [0.0.1] - Initial Release

- Initial release
- Real-time token tracking with status bar display
- Automatic updates every 5 minutes
- Click to refresh functionality
- Smart estimation using character-based analysis
- Detailed view with comprehensive statistics
