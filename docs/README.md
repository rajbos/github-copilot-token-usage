---
title: Documentation Index
created: 2026-01-19
updated: 2026-09-05
status: active
type: reference
tags: [documentation, index]
---

# Documentation

This directory contains all documentation for the GitHub Copilot Token Tracker / AI Engineering Fluency project.

## Core Reference

Essential reference documents covering the data model, scoring rules, and tracked metrics.

| File | Description |
|---|---|
| [FLUENCY-LEVELS.md](FLUENCY-LEVELS.md) | Scoring rules for the Copilot Fluency Score (stages, categories, thresholds) |
| [FLUENCY-METRICS-SCHEMA.md](FLUENCY-METRICS-SCHEMA.md) | Schema for fluency metrics stored in Azure Tables |
| [TRACKABLE-DATA.md](TRACKABLE-DATA.md) | All metrics extractable from GitHub Copilot Chat session logs |
| [USAGE-ANALYSIS.md](USAGE-ANALYSIS.md) | Guide to the Usage Analysis Dashboard features and tracked metrics |
| [COPILOT-CLI-FORMAT-CHANGES.md](COPILOT-CLI-FORMAT-CHANGES.md) | Breaking changes to Copilot CLI session log format and their impact |
| [COPILOT-CLI-OTEL-EXPORT.md](COPILOT-CLI-OTEL-EXPORT.md) | Enabling Copilot CLI's OpenTelemetry file export for exact token counts |
| [VALIDATION.md](VALIDATION.md) | What each check catches, and the one-command release preflight (`npm run preflight`) |
| [REPO-HEALTH-SCAN.md](REPO-HEALTH-SCAN.md) | Daily code-health scan (8 topics) → one issue → one PR, via GitHub Actions or a local Claude Code routine |

## Component Documentation

Per-component guides and READMEs.

| Folder | Description |
|---|---|
| [cli/](cli/README.md) | CLI tool (npm package) — commands, options, configuration, data sources, troubleshooting and development guide |
| [copilot-app/](copilot-app/README.md) | GitHub Copilot app canvas (`ai-fluency-canvas` plugin) — one-click and CLI install, usage, updating, troubleshooting |
| [vscode-extension/](vscode-extension/README.md) | VS Code extension guide |
| [vscode-extension/DESIGN.md](vscode-extension/DESIGN.md) | VS Code extension UI design system (DESIGN.md spec) |
| [vscode-extension/WEBVIEW-MESSAGING.md](vscode-extension/WEBVIEW-MESSAGING.md) | How data reaches a webview panel: trust model, readiness/replay, diagnostics, companion-extension impact |
| [vscode-extension/VIEW-HIERARCHY.md](vscode-extension/VIEW-HIERARCHY.md) | View → sub-view → content-block map of every webview panel, and the rules for grouping them |
| [vscode-extension/DATA-TABLE.md](vscode-extension/DATA-TABLE.md) | The shared `renderDataTable` component every webview table uses: layout, CSS, sorting, pagination, filters |
| [visual-studio/](visual-studio/README.md) | Visual Studio extension guide |
| [sharing-server/](sharing-server/README.md) | Sharing server setup, personal dashboard and Team Insights |
| [Sharing server data separation contract](../sharing-server/AGENTS.md) | Authoritative server privacy, comparison semantics and coding/testing requirements |
| [specs/backend.md](specs/backend.md) | Backend API specification |
| [specs/nonCopilotFilesDetection.md](specs/nonCopilotFilesDetection.md) | Non-Copilot file detection spec |

## Log File Schemas

Documentation and JSON schemas for Copilot session log file formats across different editors/tools.

| File | Description |
|---|---|
| [logFilesSchema/README.md](logFilesSchema/README.md) | Guide for working with schemas and the analysis script |
| [logFilesSchema/SCHEMA-ANALYSIS.md](logFilesSchema/SCHEMA-ANALYSIS.md) | Quick reference — field-level schema analysis |
| [logFilesSchema/VSCODE-VARIANTS.md](logFilesSchema/VSCODE-VARIANTS.md) | VS Code variant support details |
| [logFilesSchema/gemini-cli-session-format.md](logFilesSchema/gemini-cli-session-format.md) | Gemini CLI JSONL session format (Windows) |
| [logFilesSchema/vscode-chat-debug-log-format.md](logFilesSchema/vscode-chat-debug-log-format.md) | VS Code Copilot Chat debug log — exact tokens and the AI Unit billing path |
| [logFilesSchema/hydrafusion-routing-events.md](logFilesSchema/hydrafusion-routing-events.md) | HydraFusion routing events in Copilot CLI logs — which models ran behind one answer, and what each leg cost |
| [logFilesSchema/session-file-schema.json](logFilesSchema/session-file-schema.json) | Manual schema documentation (JSON) |
| [logFilesSchema/session-file-schema-analysis.json](logFilesSchema/session-file-schema-analysis.json) | Auto-generated schema analysis (JSON) |

```powershell
# Re-generate schema analysis
.\.github\skills\copilot-log-analysis\analyze-session-schema.ps1
```

## Feature Documentation

Detailed documentation for individual features.

| File | Description |
|---|---|
| [features/BLOB-UPLOAD.md](features/BLOB-UPLOAD.md) | Uploading session log files to Azure Blob Storage |
| [features/BLOB-UPLOAD-QUICKSTART.md](features/BLOB-UPLOAD-QUICKSTART.md) | Quick-start guide for blob upload setup |
| [features/EXPORT_FEATURE_SUMMARY.md](features/EXPORT_FEATURE_SUMMARY.md) | Export functionality for the Fluency Score dashboard |
| [features/EXPORT_FEATURE_UI.md](features/EXPORT_FEATURE_UI.md) | Export feature UI layout and visual description |
| [features/SOCIAL-MEDIA-SHARE.md](features/SOCIAL-MEDIA-SHARE.md) | Social media sharing (LinkedIn, Bluesky, Mastodon) |
| [features/VISUAL-MOCKUP-SHARE-FEATURE.md](features/VISUAL-MOCKUP-SHARE-FEATURE.md) | Visual mockup of the social share UI |
| [features/FLUENCY-LEVEL-VIEWER.md](features/FLUENCY-LEVEL-VIEWER.md) | Debug-only Fluency Level Viewer tool |
| [features/FLUENCY-LEVEL-VIEWER-TEST-PLAN.md](features/FLUENCY-LEVEL-VIEWER-TEST-PLAN.md) | Test plan for the Fluency Level Viewer |
| [features/FLUENCY-LEVEL-VIEWER-UI-MOCKUP.md](features/FLUENCY-LEVEL-VIEWER-UI-MOCKUP.md) | UI mockup for the Fluency Level Viewer |
| [features/THEMING_CHANGES.md](features/THEMING_CHANGES.md) | Light theme support implementation details |
| [features/TOOL-CURATION.md](features/TOOL-CURATION.md) | Tool Curation — surface unused MCP servers and stale skills |
| [features/MODEL-EFFICIENCY-COMPARISON.md](features/MODEL-EFFICIENCY-COMPARISON.md) | Models tab — compare two models, or one model across two periods |
| [features/EFFICIENCY-TRENDS.md](features/EFFICIENCY-TRENDS.md) | Efficiency trends — time presets, drill-down, and the per-tab filter policy |
| [features/CORRECTIONS.md](features/CORRECTIONS.md) | Corrections tab — detect moments where the agent or the user had to correct the conversation |
| [features/REPEATED-TASKS.md](features/REPEATED-TASKS.md) | Skill Suggestions — find tasks you keep prompting for across sessions and turn them into skills |
| [features/COPILOT-MEMORY-FILES-INSIGHT.md](features/COPILOT-MEMORY-FILES-INSIGHT.md) | Copilot memory-files hygiene: shared analysis module, insight card, CLI `memory-files` command, and a Tools-tab UI section |
| [features/COPILOT-SERVER-MEMORIES.md](features/COPILOT-SERVER-MEMORIES.md) | Copilot's server-side per-repository memory store: undocumented API contract, and turning re-learned facts into `AGENTS.md` entries |
| [features/CLOUD-AGENT-COST.md](features/CLOUD-AGENT-COST.md) | Cloud Agent tab — per-repository AI credits, and the hourly cached snapshot behind it |
| [features/DARK-FACTORY-READINESS.md](features/DARK-FACTORY-READINESS.md) | Dark Factory Readiness — per-repository governance control scan on the Fluency Score view |
| [features/WORKSPACE-GROUPING.md](features/WORKSPACE-GROUPING.md) | Workspace grouping — folding worktrees, clones and remote spellings of one repository into one workspace, shared by the extension and the CLI |
| [features/TTFT-TRENDS.md](features/TTFT-TRENDS.md) | Research > TTFT diagnostics tab — time-to-first-token averages and per-model trendlines from VS Code Chat's debug log |
| [features/WHATS-NEW.md](features/WHATS-NEW.md) | What's New view and the one-a-day new-feature notification — the release catalog, view-visit tracking, and the pacing rules |

## Architecture Decision Records (ADR)

Implementation notes and decisions captured during development sessions.

| File | Description |
|---|---|
| [adr/IMPLEMENTATION-SUMMARY.md](adr/IMPLEMENTATION-SUMMARY.md) | Fluency Level Viewer implementation summary |
| [adr/LIGHT-THEME-SUPPORT.md](adr/LIGHT-THEME-SUPPORT.md) | Light theme support implementation summary |
| [adr/IMPLEMENTATION-SUMMARY-SOCIAL-SHARE.md](adr/IMPLEMENTATION-SUMMARY-SOCIAL-SHARE.md) | Social media share feature implementation summary |
| [adr/FLUENCY-DATA-IMPLEMENTATION.md](adr/FLUENCY-DATA-IMPLEMENTATION.md) | Fluency data cloud upload — gap analysis and plan |
| [adr/PR_SUMMARY.md](adr/PR_SUMMARY.md) | PR summary: comprehensive light theme support |
| [adr/SQLITE-WAL-READS.md](adr/SQLITE-WAL-READS.md) | Why sql.js reads of data.db/opencode.db must merge pending WAL frames first |
| [adr/ANALYSIS-WORKER.md](adr/ANALYSIS-WORKER.md) | Why session parsing and workspace scans run on worker threads, and how that is kept from regressing |
| [adr/LOCALIZATION-ARCHITECTURE.md](adr/LOCALIZATION-ARCHITECTURE.md) | Repo-wide localization standard: the four runtime tiers and one source of truth |
| [adr/INSIGHTS-CATALOG-LOCALIZATION.md](adr/INSIGHTS-CATALOG-LOCALIZATION.md) | How the Insights catalog is localized without giving up insightsEngine.ts's purity |
| [adr/TOOL-EXECUTION-STATS.md](adr/TOOL-EXECUTION-STATS.md) | Per-tool failure counts and latency histograms (reliability, latency, MCP health, cost-vs-speed panels): data sources, additive design, phased plan |
