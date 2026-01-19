# Refresh JSON Data Skill

This is a GitHub Copilot Agent Skill that provides instructions for refreshing the token estimator and model pricing data in the Copilot Token Tracker extension.

## What is this?

This skill helps developers and maintainers update the JSON data files that contain:
- Character-to-token ratio estimators for AI models
- Pricing information for various AI model providers

## Files in this directory

- **SKILL.md** - The main skill file with YAML frontmatter and detailed instructions
- **validate-json.js** - A Node.js script to validate the JSON files after updates
- **README.md** - This file

## How to use this skill

GitHub Copilot will automatically recognize and use this skill when you ask questions like:
- "How do I update the model pricing data?"
- "Add support for a new AI model"
- "Refresh the token estimator ratios"
- "Update pricing information from OpenAI"

The skill provides step-by-step instructions for:
1. Updating tokenEstimators.json with new model ratios
2. Updating modelPricing.json with current pricing
3. Validating the changes
4. Building and testing the extension
5. Committing the updates

## Using the validation script

After updating the JSON files, run the validation script:

```bash
node .github/skills/refresh-json-data/validate-json.js
```

This will check:
- JSON syntax validity
- Required fields are present
- Data types are correct
- Values are within reasonable ranges

## Requirements

- Node.js installed
- Repository cloned locally
- Basic understanding of JSON format
- Access to AI provider pricing documentation

## References

- [VS Code Agent Skills Documentation](https://code.visualstudio.com/docs/copilot/customization/agent-skills)
- [GitHub Copilot Agent Skills](https://docs.github.com/en/copilot/concepts/agents/about-agent-skills)
- [Extension Source Code](../../../src/)

## Maintenance

This skill should be updated when:
- New AI models are added to GitHub Copilot
- Pricing structures change significantly
- Token estimation methodologies improve
- Additional validation checks are needed
