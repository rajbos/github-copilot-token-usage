# Data Files

This directory contains JSON configuration files for the GitHub Copilot Token Tracker extension.

## tokenEstimators.json

Contains character-to-token ratio estimators for different AI models. These ratios are used to estimate token counts from text length.

**Structure:**
```json
{
  "estimators": {
    "model-name": 0.25  // ratio value
  }
}
```

**How to update:**
- Add new models or update existing ratios in the `estimators` object
- Typical ratios range from 0.24-0.25 (roughly 4 characters per token)
- Rebuild the extension after making changes

## modelPricing.json

Contains pricing information for AI models, including input and output token costs per million tokens.

**Structure:**
```json
{
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
      "inputCostPerMillion": 1.75,
      "outputCostPerMillion": 14.0,
      "category": "Model category",
      "tier": "standard|premium|unknown",
      "multiplier": 1
    }
  }
}
```

**How to update:**
1. Check official pricing pages:
   - OpenAI: https://openai.com/api/pricing/
   - Anthropic: https://www.anthropic.com/pricing
   - Google Gemini: https://ai.google.dev/pricing
   - GitHub Copilot Supported Models: https://docs.github.com/en/copilot/reference/ai-models/supported-models
2. Update the `pricing` object with new rates
3. Update `metadata.lastUpdated` with current date
4. Update source URLs and dates if needed
5. Rebuild the extension after making changes

### Current Gemini Model Pricing (per million tokens)

Based on Google AI pricing (retrieved December 27, 2025):

- **Gemini 2.5 Pro**: $1.25 input / $10.00 output
- **Gemini 3 Flash**: $0.50 input / $3.00 output  
- **Gemini 3 Pro**: $2.00 input / $12.00 output (for prompts ≤ 200k tokens)

Note: These are the current GitHub Copilot supported Gemini models. Pricing from direct Google AI API usage applies.

## Important Notes

- These files are imported at compile time and bundled into the extension
- After making changes, run `npm run compile` to rebuild
- Pricing is for reference only - GitHub Copilot may use different pricing structures
- Cost estimates assume a 50/50 split between input and output tokens

## customizationPatterns.json

Defines repository file patterns that the extension will scan for to discover Copilot customization files (for example: `copilot-instructions.md`, `skills/` folders, `agents.md`). The extension uses these patterns to produce the "Customization Files" section in the Usage Analysis webview.

Structure:

```json
{
  "patterns": [
    {
      "id": "copilot-instructions",
      "label": "copilot-instructions.md",
      "path": "copilot-instructions.md",
      "scanMode": "exact",
      "icon": "📋"
    }
  ],
  "stalenessThresholdDays": 90,
  "excludeDirs": [".git", "node_modules"]
}
```

Notes:

- `scanMode` can be `exact`, `oneLevel`, or `recursive`.
- `caseInsensitive` (optional) enables case-insensitive matching for `exact` and `recursive` patterns.
- `stalenessThresholdDays` controls when a file is marked as stale in the UI.
- `excludeDirs` lists directories to skip during recursive scans.

To update patterns:

1. Edit `src/customizationPatterns.json` and add or adjust entries.
2. Run `npm run compile` to rebuild the extension.

The usage webview will surface discovered files per workspace and mark files as stale when their last modification time exceeds `stalenessThresholdDays`.
