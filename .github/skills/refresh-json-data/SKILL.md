---
name: refresh-json-data
description: Refresh token estimator and model pricing JSON files with latest data from AI model providers
---

# Refresh JSON Data Skill

This skill helps you update the token estimation ratios and model pricing data in the AI Engineering Fluency extension.

## Overview

The extension uses two JSON data files that need periodic updates:
1. **tokenEstimators.json** - Character-to-token ratio estimators for AI models
2. **modelPricing.json** - Pricing information per million tokens for various AI models

These files are located in `src/` directory and are bundled into the extension at build time.

## When to Use This Skill

Use this skill when you need to:
- Add support for new AI models
- Update token estimation ratios based on new benchmarks
- Refresh pricing information from provider APIs
- Keep model data current with latest releases

## Prerequisites

Before updating these files, ensure you have:
- Access to official pricing documentation from AI providers
- Token estimation benchmarks or documentation
- The repository cloned locally
- Node.js and pnpm installed

## Step 1: Update tokenEstimators.json

### Location
`src/tokenEstimators.json`

### Structure
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "description": "Character-to-token ratio estimators for different AI models.",
  "estimators": {
    "model-name": 0.25
  }
}
```

### Update Process

1. **Research token ratios** for new or updated models:
   - Look at the existing ratios for that provider's other models in
     `tokenEstimators.json` and match the pattern; verify with an actual
     tokenizer if unsure

2. **Add or update entries** in the `estimators` object:
   ```json
   "new-model-name": 0.25
   ```

3. **Validation**:
   - Ensure JSON syntax is valid
   - Keep ratio values between 0.20 and 0.30
   - Use consistent formatting

## Step 2: Update modelPricing.json

### Location
`src/modelPricing.json`

### Structure
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "description": "Model pricing data - costs per million tokens",
  "metadata": {
    "lastUpdated": "YYYY-MM-DD",
    "sources": [
      {
        "name": "Provider Name",
        "url": "https://pricing-url",
        "retrievedDate": "YYYY-MM-DD"
      }
    ],
    "disclaimer": "..."
  },
  "pricing": {
    "model-name": {
      "inputCostPerMillion": 1.25,
      "outputCostPerMillion": 10.0,
      "category": "Model category"
    }
  }
}
```

### Update Process

1. **Check official pricing pages**:
   - OpenAI: https://openai.com/api/pricing/
   - Anthropic: https://www.anthropic.com/pricing (also https://platform.claude.com/docs/en/about-claude/pricing)
   - Google Gemini: https://ai.google.dev/gemini-api/docs/pricing
   - xAI Grok: https://x.ai/api
   - **Mistral AI**: https://pricepertoken.com/pricing-page/provider/mistral-ai (aggregator, updated ~daily)
     - Cross-reference with https://openrouter.ai/mistralai and https://ai-pricing.info/mistral
     - Note: Mistral does not publish a single stable pricing page; use aggregators
   - GitHub Copilot Models: https://docs.github.com/en/copilot/reference/ai-models/supported-models
   - GitHub Copilot Premium Requests: https://docs.github.com/en/copilot/managing-copilot/monitoring-usage-and-entitlements/about-premium-requests
   - OpenRouter (cross-provider verification): https://openrouter.ai

2. **Update pricing entries** in the `pricing` object:
   ```json
   "model-name": {
     "inputCostPerMillion": 1.25,
     "outputCostPerMillion": 10.0,
     "category": "Provider models"
   }
   ```

3. **Update metadata**:
   - Set `metadata.lastUpdated` to current date (YYYY-MM-DD format)
   - Add or update source URLs and retrieval dates
   - Keep the disclaimer intact

4. **Pricing guidelines**:
   - Costs are per million tokens
   - Input costs are typically lower than output costs
   - Group models by category (e.g., "GPT-4 models", "Claude models")
   - Verify pricing is in USD

5. **Validation**:
   - Ensure JSON syntax is valid
   - Verify pricing values are positive numbers
   - Check that all required fields are present

## Step 3: Build and Test

Validate JSON syntax, run `pnpm run compile && pnpm run test:node` (do not
launch VS Code or the Extension Development Host — that is a manual,
human-only debugging step; see `.github/copilot-instructions.md`), review
with `git diff`, then commit/push as usual.

## Important Notes

- **Bundled at build time**: These JSON files are bundled into the extension during compilation via `esbuild.js`
- **Rebuild required**: Always run `pnpm run compile` after changes
- **Pricing disclaimer**: GitHub Copilot pricing may differ from direct API usage
- **Estimation nature**: Token counts are estimates based on character ratios
- **Documentation**: See `src/README.md` for additional details

## Reference Resources

- VS Code extension development: https://code.visualstudio.com/api
- Token estimation methodology: Character-to-token ratios based on model tokenizers
- Cost calculation: Uses 50/50 split between input and output tokens for estimates

## Troubleshooting

**Extension not loading updated data**:
- Confirm you ran `pnpm run compile`
- Confirm `pnpm run test:node` passes
- Check the build output for errors

## Additional Context

The extension reads these files at compile time via:
```typescript
import tokenEstimatorsData from './tokenEstimators.json';
import modelPricingData from './modelPricing.json';
```

The data is then used in the `CopilotTokenTracker` class:
- `tokenEstimators` - Used for token estimation from character counts
- `modelPricing` - Used for cost calculations in the details panel

Both files must maintain their structure to ensure the extension compiles and runs correctly.
