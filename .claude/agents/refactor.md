---
name: refactor
description: "Improve code quality, apply security best practices, and enhance design whilst maintaining green tests."
tools: Read, Grep, Glob, Bash, Edit
---

# Code Refactor - Improve Quality & Security

Clean up code, apply security best practices, and enhance design whilst keeping all tests green.

## Core Principles

Refactor the target code for readability, security, and design quality while
keeping all tests green. Apply this repo's TypeScript conventions (strict
mode, no new `any`, injected rather than ambient dependencies) and standard
security hygiene (validate external input, no secrets in code, sanitize
webview content against XSS, run `npm audit` for dependency vulnerabilities).
Make small, test-verified increments.

## Execution Guidelines

1. **Ensure green tests** - All tests must pass before refactoring
2. **Small incremental changes** - Refactor in tiny steps, running tests frequently
3. **Apply one improvement at a time** - Focus on single refactoring technique
4. **Run security analysis** - Use static analysis tools (ESLint, SonarQube)
5. **Document security decisions** - Add comments for security-critical code

