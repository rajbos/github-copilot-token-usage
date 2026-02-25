/**
 * Repository Hygiene Check Skill
 * This skill analyzes repository structure and configuration to identify hygiene issues
 * and provide actionable recommendations.
 */
export const REPO_HYGIENE_SKILL = `---
name: repo-hygiene
description: Analyze repository hygiene and structure to identify missing configuration files, documentation, and best practices. Returns structured JSON report with actionable recommendations.
---

# Repository Hygiene Check Skill

This skill analyzes repository structure and configuration to identify hygiene issues and provide actionable recommendations. It checks for the presence of essential files, consistent coding standards, CI/CD setup, and other foundational signals that indicate a well-maintained repository suitable for AI-assisted development.

## Overview

The skill performs 17 automated checks across 5 categories:

- **Version Control**: Git setup, ignore files, environment templates
- **Code Quality**: Linters, formatters, type safety configuration
- **CI/CD & Automation**: Continuous integration, standard scripts, task runners
- **Environment**: Dev containers, Docker, runtime version pinning
- **Documentation**: License files, commit message quality

Each check has a weight (2-5) indicating its importance. The skill returns a structured JSON report with:

- Overall hygiene score (0-100%)
- Individual check results (pass/fail/warning)
- Prioritized recommendations
- Missing files and configuration hints

## Hygiene Checks Performed

### Category: Version Control (Weight: 13/76 total)

#### 1. Git Repository (\`.git\`)
- **ID**: \`git-repo\`
- **Weight**: 5 (Critical)
- **Type**: Directory check
- **Description**: Repository is under Git version control
- **Paths**: \`['.git']\`

#### 2. Git Ignore File (\`.gitignore\`)
- **ID**: \`gitignore\`
- **Weight**: 5 (Critical)
- **Type**: File check
- **Description**: Prevents tracking of generated/sensitive files
- **Paths**: \`['.gitignore']\`

#### 3. Environment Example (\`.env.example\`)
- **ID**: \`env-example\`
- **Weight**: 3 (Important)
- **Type**: File check
- **Description**: Documents required environment variables without exposing secrets
- **Paths**: \`['.env.example', '.env.sample', '.env.template']\`
- **Hint**: \`cp .env .env.example  # strip secrets\`

### Category: Code Quality (Weight: 17/76 total)

#### 4. Editor Config (\`.editorconfig\`)
- **ID**: \`editorconfig\`
- **Weight**: 2 (Nice-to-have)
- **Type**: File check
- **Description**: Consistent editor settings across contributors and agents
- **Paths**: \`['.editorconfig']\`
- **Hint**: \`touch .editorconfig\`

#### 5. Linter Configuration
- **ID**: \`linter\`
- **Weight**: 4 (Important)
- **Type**: File check
- **Description**: Linting enforces consistent style for humans and agents alike
- **Paths**: JavaScript/TypeScript, Python, Ruby, Go config files

#### 6. Formatter Configuration
- **ID**: \`formatter\`
- **Weight**: 3 (Important)
- **Type**: File check
- **Description**: Auto-formatting keeps agent-generated code consistent
- **Paths**: Prettier, Biome, Deno, and other formatter configs

#### 7. Type Safety Configuration
- **ID**: \`type-safety\`
- **Weight**: 3 (Important)
- **Type**: File check
- **Description**: Type checking helps agents generate correct, type-safe code
- **Paths**: \`['tsconfig.json', 'jsconfig.json', 'mypy.ini', 'pyrightconfig.json']\`

#### 8. Descriptive Commit Messages
- **ID**: \`commit-messages\`
- **Weight**: 3 (Important)
- **Type**: Custom analysis
- **Description**: Recent commit messages are descriptive (not just "fix" or "update")
- **Analysis**: Check last 10 commits for quality (≥60% should be descriptive, ≥10 chars)

#### 9. Conventional Commits
- **ID**: \`conventional-commits\`
- **Weight**: 2 (Nice-to-have)
- **Type**: Custom analysis
- **Description**: Commit messages follow conventional format (feat:, fix:, chore:, etc.)
- **Analysis**: Check last 10 commits for conventional format (≥50% match pattern)

### Category: CI/CD & Automation (Weight: 10/76 total)

#### 10. CI Pipeline Configuration
- **ID**: \`ci-config\`
- **Weight**: 4 (Important)
- **Type**: Directory/File check
- **Description**: CI pipeline catches agent regressions before they merge
- **Paths**: \`['.github/workflows', '.gitlab-ci.yml', '.circleci', 'Jenkinsfile']\`

#### 11. Standard Scripts
- **ID**: \`scripts\`
- **Weight**: 4 (Important)
- **Type**: Custom analysis
- **Description**: Single obvious commands for start/test/lint
- **Analysis**: Check for at least 2 of 3 standard scripts in package.json or Makefile

#### 12. Task Runner Configuration
- **ID**: \`task-runner\`
- **Weight**: 2 (Nice-to-have)
- **Type**: File check
- **Description**: Task runner gives agents discoverable project commands
- **Paths**: \`['Makefile', 'justfile', 'Taskfile.yml']\`

### Category: Environment (Weight: 9/76 total)

#### 13. Dev Container Configuration
- **ID**: \`devcontainer\`
- **Weight**: 3 (Important)
- **Type**: Directory/File check
- **Description**: Reproducible dev environment for agents and contributors
- **Paths**: \`['.devcontainer', '.devcontainer/devcontainer.json']\`

#### 14. Docker Configuration
- **ID**: \`dockerfile\`
- **Weight**: 2 (Nice-to-have)
- **Type**: File check
- **Description**: Containerization provides reproducible environments
- **Paths**: \`['Dockerfile', 'docker-compose.yml', 'compose.yml']\`

#### 15. Runtime Version Pinning
- **ID**: \`version-pinning\`
- **Weight**: 2 (Nice-to-have)
- **Type**: File check
- **Description**: Pinned runtime versions ensure consistent agent environments
- **Paths**: \`['.nvmrc', '.node-version', '.python-version', '.tool-versions']\`

#### 16. License File
- **ID**: \`license\`
- **Weight**: 2 (Nice-to-have)
- **Type**: File check
- **Description**: License file clarifies usage rights for contributors and agents
- **Paths**: \`['LICENSE', 'LICENSE.md', 'LICENCE']\`

## Total Weights: 76 points
- Version Control: 13 points (17%)
- Code Quality: 17 points (22%)
- CI/CD & Automation: 10 points (13%)
- Environment: 9 points (12%)

## Expected JSON Output Schema

Return a structured JSON object with:
- summary: Overall scores and category breakdowns
- checks: Array of 17 check results (id, category, label, status, weight, found, detail, hint)
- recommendations: Prioritized action items (priority, category, action, weight, impact)
- metadata: Scan version, timestamp, repository info

Each check should have status "pass", "fail", or "warning".
Recommendations should be sorted by priority (high > medium > low).
`;
