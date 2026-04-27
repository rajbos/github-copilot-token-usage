# Data Files

This directory contains JSON configuration files for the GitHub Copilot Token Tracker extension.

## copilotPlans.json

Contains GitHub Copilot plan definitions — the `plans` object keys match the `copilot_plan` value returned by the `copilot_internal/user` API endpoint.

**Structure:**
```json
{
  "plans": {
    "<plan-id>": {
      "name": "Display name",
      "monthlyPricePerUser": 10,
      "monthlyPremiumRequests": 300,
      "codeCompletionsPerMonth": null,
      "description": "..."
    }
  }
}
```

- `monthlyPremiumRequests` — included allotment per user per month; extra requests are $0.04 each
- `codeCompletionsPerMonth` — tab completions limit; `null` = unlimited (paid plans)

**Current plans:**

| ID | Name | $/user/mo | Premium requests/mo |
|----|------|-----------|---------------------|
| `free` | Copilot Free | $0 | 50 |
| `individual` / `pro` | Copilot Pro | $10 | 300 |
| `pro_plus` | Copilot Pro+ | $39 | 1,500 |
| `business` | Copilot Business | $19 | 300 |
| `enterprise` | Copilot Enterprise | $39 | 1,000 |

**How to update:** Edit the `plans` object when GitHub changes pricing or adds plans. Update `metadata.lastUpdated` and reference the [official plans page](https://docs.github.com/en/copilot/get-started/plans).

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
      "cachedInputCostPerMillion": 0.175,
      "cacheCreationCostPerMillion": 2.1875,
      "category": "Model category",
      "tier": "standard|premium|unknown",
      "multiplier": 1,
      "copilotPricing": {
        "inputCostPerMillion": 1.75,
        "cachedInputCostPerMillion": 0.175,
        "cacheCreationCostPerMillion": 2.1875,
        "outputCostPerMillion": 14.0,
        "releaseStatus": "GA",
        "category": "Versatile"
      }
    }
  }
}
```

**Provider vs. GitHub Copilot pricing**

The top-level `inputCostPerMillion` / `outputCostPerMillion` / cache fields
represent the **direct provider/API price** (OpenAI, Anthropic, Google, xAI, …).
The optional `copilotPricing` block represents **GitHub Copilot's published
per-token AI Credit rates**
(<https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing>,
1 AI credit = $0.01). Both are computed in parallel by `calculateEstimatedCost`:

```ts
calculateEstimatedCost(usage, pricing);             // provider/API cost (default)
calculateEstimatedCost(usage, pricing, 'copilot');  // GitHub Copilot AI-Credit cost
```

When a model has no `copilotPricing` block the `'copilot'` source falls back to
the provider rates as a proxy — this means the Copilot cost is never
*under-reported* due to a missing entry, it just won't reflect the (often
identical) GitHub-published rate explicitly.

> ℹ️ **Caching note.** Copilot Chat session logs do not (yet) expose a
> cached-read / cache-creation token breakdown, so the Copilot cost falls back
> to the full input rate for those sources. Adapters that *do* surface cache
> tokens (Claude Desktop, Claude Code, OpenCode) automatically benefit from the
> reduced cached-input rates in `copilotPricing`.

**Cache pricing fields (optional):**

| Field | Description |
|-------|-------------|
| `cachedInputCostPerMillion` | Cost per million tokens for cache **reads** — tokens already cached and billed at a reduced rate |
| `cacheCreationCostPerMillion` | Cost per million tokens for cache **creation** — writing tokens into the cache (billed at a premium) |

When these fields are absent, the full `inputCostPerMillion` rate is applied to all input tokens.

**Anthropic prompt caching rates** (used for all `claude-*` models):
- Cache reads: **10% of input rate** (e.g. $0.30/M for Claude Sonnet 4 at $3.00/M input)
- Cache creation: **125% of input rate** (e.g. $3.75/M for Claude Sonnet 4)

**OpenAI prompt caching rates** (automatic prefix matching) vary by model family:
- Cache reads use the explicit per-model `cachedInputCostPerMillion` values in `modelPricing.json` (for example: GPT-4o = 50% of input, GPT-4.1 = 25%, GPT-5.4 = 10%)
- Note: OpenAI cache creation does not incur an extra fee, so `cacheCreationCostPerMillion` is not set for OpenAI models.

### Which data sources provide cache token breakdowns?

Cache-aware pricing only applies when the session source actually exposes how many tokens were cached vs. uncached:

| Source | Cache tokens available? | Fields used |
|--------|------------------------|-------------|
| **Claude Desktop** (`claudedesktop.ts`) | ✅ Yes | `usage.cache_creation_input_tokens`, `usage.cache_read_input_tokens` |
| **Claude Code** (`claudecode.ts`) | ✅ Yes | same Anthropic API fields |
| **OpenCode** (`opencode.ts`) | ✅ Yes (DB format) | `msg.tokens.cache.write`, `msg.tokens.cache.read` |
| VS Code Copilot | ❌ Not exposed | Copilot API returns only aggregate `promptTokens` |
| Continue.dev | ❌ No | Character-based estimation only |
| Cursor (Crush) | ❌ No | DB prompt/completion totals only |
| Visual Studio | ❌ No | Character-based estimation only |

For sources without cache data, the full input rate is used (no change from previous behaviour).

**How to update:**
1. Check official pricing pages:
   - OpenAI: https://openai.com/api/pricing/
   - Anthropic: https://www.anthropic.com/pricing (also https://platform.claude.com/docs/en/about-claude/pricing)
   - Google Gemini: https://ai.google.dev/gemini-api/docs/pricing
   - xAI Grok: https://x.ai/api
   - GitHub Copilot Supported Models: https://docs.github.com/en/copilot/reference/ai-models/supported-models
   - GitHub Copilot Premium Requests: https://docs.github.com/en/copilot/managing-copilot/monitoring-usage-and-entitlements/about-premium-requests
   - OpenRouter (cross-provider verification): https://openrouter.ai
2. Update the `pricing` object with new rates
3. Update `metadata.lastUpdated` with current date
4. Update source URLs and dates if needed
5. Rebuild the extension after making changes (`npm run compile`)

### Current Gemini Model Pricing (per million tokens)

Based on Google AI pricing (retrieved March 30, 2026):

- **Gemini 2.5 Pro**: $1.25 input / $10.00 output
- **Gemini 3 Flash**: $0.50 input / $3.00 output
- **Gemini 3 Pro**: $2.00 input / $12.00 output (for prompts ≤ 200k tokens)
- **Gemini 3.1 Flash Lite**: $0.25 input / $1.50 output

Note: These are the current GitHub Copilot supported Gemini models. Pricing from direct Google AI API usage applies.

## Important Notes

- These files are imported at compile time and bundled into the extension
- After making changes, run `npm run compile` to rebuild
- Pricing is for reference only - GitHub Copilot may use different pricing structures
- Cost estimates use actual input/output token counts when available. Cache-aware pricing is applied automatically for sources that expose cache token breakdowns (Claude Desktop, Claude Code, OpenCode).

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
