---
title: GitHub Copilot Agent Skills
description: Overview of agent skills for GitHub Copilot Token Tracker extension
lastUpdated: 2026-01-26
---

# GitHub Copilot Agent Skills

This directory contains Agent Skills for GitHub Copilot and other compatible AI agents. Agent Skills are used to teach agents specialized tasks and provide domain-specific knowledge.

## What are Agent Skills?

Agent Skills are directories containing a `SKILL.md` file and optional supporting resources. When working with Copilot coding agent, GitHub Copilot CLI, or VS Code Insiders, these skills are automatically loaded when relevant to improve the agent's performance on specialized tasks.

## Available Skills

### azure-storage-loader

**Purpose**: Load token usage data from Azure Table Storage for faster iteration and analysis.

**Use this skill when:**
- Analyzing actual usage data without manual export
- Testing query logic against real backend data
- Debugging backend sync issues with live data
- Performing ad-hoc team analytics
- Quickly iterating on data analysis tasks in chat

**Contents:**
- Helper script to fetch data from Azure Storage Tables
- Support for both Entra ID and Shared Key authentication
- Flexible filtering by date, model, workspace, or user
- JSON and CSV output formats
- Azure Table Storage schema documentation
- Authentication and troubleshooting guides

### copilot-log-analysis

**Purpose**: Comprehensive guide for analyzing GitHub Copilot session log files.

**Use this skill when:**
- Working with Copilot session files (.json or .jsonl)
- Understanding the extension's log analysis methods
- Debugging token tracking issues
- Extracting token usage, model information, or interaction data

**Contents:**
- Session file discovery across all VS Code variants
- Field extraction methods with line-by-line references
- Token estimation algorithms and caching strategies
- JSON and JSONL format parsing details
- Schema documentation references
- Usage examples and troubleshooting guides

### refresh-json-data

**Purpose**: Update token estimator and model pricing JSON files with latest data.

**Use this skill when:**
- Adding support for new AI models
- Updating token estimation ratios
- Refreshing pricing information from provider APIs
- Keeping model data current with latest releases

## Using Agent Skills

### In VS Code

Agent Skills are automatically loaded by Copilot when relevant to your task. The skills in this directory are **project-specific** and will be available when working in this repository.

### In GitHub Copilot CLI

Skills are automatically discovered when using the Copilot CLI in this repository:

```bash
gh copilot suggest "How do I analyze Copilot session files?"
```

### Manual Reference

You can also manually refer to these skills when asking Copilot questions:

```
@workspace /explain How does the token estimation work? See the copilot-log-analysis skill.
```

## Skill Structure

Each skill follows the Agent Skills standard:

```
.github/skills/
└── skill-name/
    ├── SKILL.md          # Required: Main skill documentation
    └── [resources...]    # Optional: Scripts, examples, etc.
```

### SKILL.md Format

```markdown
---
name: skill-name
description: What the skill does and when to use it
---

# Skill Title

Content with instructions, examples, and guidelines...
```

## Adding New Skills

To add a new skill:

1. Create a subdirectory: `.github/skills/new-skill-name/`
2. Create `SKILL.md` with YAML frontmatter
3. Add instructions, examples, and guidelines
4. Optionally add supporting resources (scripts, configs, etc.)

**Guidelines:**
- Use lowercase names with hyphens for skill directories
- Keep skills focused on specific tasks
- Include clear examples and use cases
- Reference existing code/documentation with file paths and line numbers
- Make skills self-contained but link to source files for details

## Resources

- [VS Code Agent Skills Documentation](https://code.visualstudio.com/docs/copilot/customization/agent-skills)
- [GitHub Agent Skills Documentation](https://docs.github.com/en/copilot/concepts/agents/about-agent-skills)
- [Agent Skills Standard](https://github.com/agentskills/agentskills)
- [Community Skills Repository](https://github.com/anthropics/skills)

## Notes

- Skills are loaded on-demand based on context
- Skills work with Copilot coding agent, GitHub Copilot CLI, and VS Code Insiders
- Personal skills can be stored in `~/.copilot/skills` for cross-project use
- Organization and enterprise skills support is coming soon
