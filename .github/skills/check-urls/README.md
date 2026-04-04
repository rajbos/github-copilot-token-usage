---
title: Check URLs Skill
description: Scan TypeScript source files for hardcoded URLs and verify they resolve
lastUpdated: 2026-03-18
---

# Check URLs Skill

A GitHub Copilot Agent Skill that finds all hardcoded `http(s)://` URLs in the TypeScript source files and verifies that each one still resolves.

## Files in This Directory

- **SKILL.md** — Main skill file with YAML frontmatter and detailed instructions for the agent
- **check-urls.js** — Node.js script that performs the scan and HTTP resolution checks
- **README.md** — This file

## Quick Usage

```bash
node .github/skills/check-urls/check-urls.js
```

## How to Invoke via Copilot

Ask Copilot something like:
- "Check that all hardcoded URLs in the source code still resolve"
- "Are any of the links in the fluency hints broken?"
- "Validate all URL links in the TypeScript files"
