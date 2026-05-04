# Change Log

All notable changes to the CLI (`@rajbos/ai-engineering-fluency`) will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

## [0.1.0] - 2026-05-04

### ✨ Features & Improvements
- Added Gemini CLI support as a trackable ecosystem
- Added JetBrains adapter to CLI ecosystem registry
- Added Mistral Vibe session support
- Added weekly/monthly chart periods and fixed usage analysis routing
- Added GitHub Copilot AI-Credit pricing alongside provider pricing
- Added dedicated CLI interaction mode in Usage Analysis (#659)
- Added macOS path support for Claude Desktop Cowork sessions (#714)
- Improved fluency spiderweb chart for Claude-only users
- Renamed cost labels: (API) → (est.) and (Copilot) → (TBB) with explainer tooltips
- Display CO2 in kg when ≥ 1000g for readability

### 🐛 Bug Fixes
- Fixed: align token counting with VS Code extension
- Fixed: use actual tokens for all periods; increased session timeout to 120s
- Fixed: prefer `actualTokens` from `session.shutdown` over estimates
- Fixed: use UTC date boundaries for period attribution
- Fixed: extract per-model usage from `session.shutdown` events
- Fixed: populate estimated cost data in chart view for all periods

### 🔧 Maintenance
- Migrated to IEcosystemAdapter registry pattern for improved extensibility
- Bumped cache version to 3 to reflect SessionData shape changes

## [0.0.14] - 2026-04-30

### ✨ Features & Improvements
- Added macOS path support for Claude Desktop Cowork sessions (#714)
- Added dedicated CLI interaction mode in Usage Analysis (#659)
- Added GitHub Copilot AI-Credit pricing alongside provider pricing
- Added Mistral Vibe session support
- Improved fluency spiderweb chart for Claude-only users
- Renamed cost labels: `(API)` → `(est.)` and `(Copilot)` → `(TBB)` with explainer tooltips
- Display CO2 in kg when ≥ 1000g for readability

### 🔧 Maintenance
- Migrated to IEcosystemAdapter registry pattern for improved extensibility

## [0.0.8] - 2026-04-11

### ✨ Features & Improvements
- Added Claude Desktop Cowork session support as a usage analysis data source (#572)
- Added thinking effort (reasoning effort) tracking for sessions that use reasoning models
- Added missing friendly display names for 14 tools (#584)

### 🐛 Bug Fixes
- Fixed token usage tracking from sub-agent calls in Copilot agent mode (#567, #573)
- Fixed Copilot CLI sessions falling back to first user message as title when no explicit title is set
- Fixed 0-interaction sessions being shown in diagnostics view; documented CLI session format
- Fixed potential client-side cross-site scripting vulnerability in usage webview (#579)

## [0.0.7] - 2026-04-08

### ✨ Features & Improvements
- Added npmjs package link to CLI documentation (#536)

### 🔧 Maintenance
- Bumped esbuild from 0.27.4 → 0.28.0
- Bumped @types/node from 25.5.0 → 25.5.2

## [0.0.6] - 2026-04-01

### ✨ Features & Improvements
- Automatic tools are now annotated and excluded from fluency scoring (#529)
- Parallelized session discovery and file processing for improved performance

## [0.0.5] - 2026-03-28

### ✨ Features & Improvements
- Added Claude Code session file support as a usage analysis data source
- Added formatting options (number formatting) to stats output
- Fixed CLI output references

## [0.0.4] - 2026-03-26

### ✨ Features & Improvements
- Added Continue.dev as a usage analysis data source
- Updated tsconfig module resolution to `bundler` for improved ESM compatibility