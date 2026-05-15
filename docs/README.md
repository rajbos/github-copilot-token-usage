---
title: Documentation Index
created: 2026-01-19
updated: 2026-05-15
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

## Component Documentation

Per-component guides and READMEs.

| Folder | Description |
|---|---|
| [cli/](cli/README.md) | CLI tool — commands, options, and development guide |
| [vscode-extension/](vscode-extension/README.md) | VS Code extension guide |
| [visual-studio/](visual-studio/README.md) | Visual Studio extension guide |
| [sharing-server/](sharing-server/README.md) | Sharing server guide |
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

## Architecture Decision Records (ADR)

Implementation notes and decisions captured during development sessions.

| File | Description |
|---|---|
| [adr/IMPLEMENTATION-SUMMARY.md](adr/IMPLEMENTATION-SUMMARY.md) | Fluency Level Viewer implementation summary |
| [adr/LIGHT-THEME-SUPPORT.md](adr/LIGHT-THEME-SUPPORT.md) | Light theme support implementation summary |
| [adr/IMPLEMENTATION-SUMMARY-SOCIAL-SHARE.md](adr/IMPLEMENTATION-SUMMARY-SOCIAL-SHARE.md) | Social media share feature implementation summary |
| [adr/FLUENCY-DATA-IMPLEMENTATION.md](adr/FLUENCY-DATA-IMPLEMENTATION.md) | Fluency data cloud upload — gap analysis and plan |
| [adr/PR_SUMMARY.md](adr/PR_SUMMARY.md) | PR summary: comprehensive light theme support |
