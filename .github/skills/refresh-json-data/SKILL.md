---
name: refresh-json-data
description: Refresh token estimator and model pricing JSON files with latest data from AI model providers
---

# Refresh JSON Data Skill

This skill helps you update the token estimation ratios and model pricing data in the Copilot Token Tracker extension.

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
- Node.js and npm installed

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
   - Typical ratios range from 0.24-0.25 (roughly 4 characters per token)
   - GPT models typically use 0.25
   - Claude models typically use 0.24
   - Check model documentation or use tokenizer tools to verify

2. **Add or update entries** in the `estimators` object:
   ```json
   "new-model-name": 0.25
   ```

3. **Common model families and their ratios**:
   - GPT-4, GPT-5, GPT-o models: 0.25
   - Claude models: 0.24
   - Gemini models: 0.25
   - Other models: verify with provider documentation

4. **Validation**:
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
   - Anthropic: https://www.anthropic.com/pricing
   - Google Gemini: https://ai.google.dev/pricing
   - GitHub Copilot Models: https://docs.github.com/en/copilot/reference/ai-models/supported-models

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

After updating the JSON files:

1. **Validate JSON syntax**:
   ```bash
   # Check JSON is valid
   node -e "require('./src/tokenEstimators.json')"
   node -e "require('./src/modelPricing.json')"
   ```

2. **Rebuild the extension**:
   ```bash
   npm run compile
   ```

3. **Test in VS Code**:
   - Press F5 to launch Extension Development Host
   - Check that the extension loads without errors
   - Verify token tracking still works correctly
   - Review the details panel to confirm pricing calculations

4. **Review changes**:
   ```bash
   git diff src/tokenEstimators.json
   git diff src/modelPricing.json
   ```

## Step 4: Commit Changes

1. **Stage the files**:
   ```bash
   git add src/tokenEstimators.json src/modelPricing.json
   ```

2. **Commit with descriptive message**:
   ```bash
   git commit -m "Update model pricing and token estimators

   - Updated pricing for [model names]
   - Added support for [new models]
   - Refreshed data from provider APIs as of [date]"
   ```

3. **Push and create PR**:
   ```bash
   git push origin your-branch-name
   ```

## Important Notes

- **Bundled at build time**: These JSON files are bundled into the extension during compilation via `esbuild.js`
- **Rebuild required**: Always run `npm run compile` after changes
- **Pricing disclaimer**: GitHub Copilot pricing may differ from direct API usage
- **Estimation nature**: Token counts are estimates based on character ratios
- **Documentation**: See `src/README.md` for additional details

## Reference Resources

- VS Code extension development: https://code.visualstudio.com/api
- Token estimation methodology: Character-to-token ratios based on model tokenizers
- Cost calculation: Uses 50/50 split between input and output tokens for estimates

## Troubleshooting

**JSON validation errors**:
- Use a JSON validator or VS Code's built-in JSON validation
- Check for missing commas, quotes, or brackets

**Build failures after update**:
- Verify JSON syntax is correct
- Ensure all required fields are present
- Check that numeric values are not strings

**Extension not loading updated data**:
- Confirm you ran `npm run compile`
- Reload the Extension Development Host (Cmd/Ctrl+R)
- Check the output console for errors

## Example Update Workflow

```bash
# 1. Update the JSON files with new data
code src/tokenEstimators.json
code src/modelPricing.json

# 2. Validate JSON syntax
node -e "require('./src/tokenEstimators.json')" && echo "tokenEstimators.json: OK"
node -e "require('./src/modelPricing.json')" && echo "modelPricing.json: OK"

# 3. Rebuild the extension
npm run compile

# 4. Test in VS Code
# Press F5 to launch Extension Development Host

# 5. Commit changes
git add src/tokenEstimators.json src/modelPricing.json
git commit -m "Update model pricing data for 2026-01"
git push origin update-model-data
```

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
