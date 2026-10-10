# Shared Sources & Data Files

This directory contains the TypeScript sources and JSON configuration files shared between the VS Code extension (`vscode-extension/`) and the CLI npm package (`cli/`).

> Note: `copilotPlans.json` is only used by the VS Code extension and lives in `vscode-extension/src/copilotPlans.json`; it is documented here alongside the other data files.

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
- `monthlyAiCreditsUsd` — dollar value of AI credits included with the plan (1 AI credit = $0.01); `0` = none included
- `codeCompletionsPerMonth` — tab completions limit; `null` = unlimited (paid plans)

**Current plans:**

| ID | Name | $/user/mo | AI credits/mo | Premium requests/mo |
|----|------|-----------|---------------|---------------------|
| `free` | Copilot Free | $0 | none | 50 |
| `individual` / `pro` | Copilot Pro | $10 | $10 | 300 |
| `pro_plus` | Copilot Pro+ | $39 | $39 | 1,500 |
| `business` | Copilot Business | $19 | $19 | 300 |
| `enterprise` | Copilot Enterprise | $39 | $39 | 1,000 |

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

**Copilot Auto routing:** estimated paid-plan AI-Credit costs apply GitHub's
[10% Auto discount](https://code.visualstudio.com/blogs/2025/09/15/autoModelSelection)
only to requests with an `autoModeResolution` response item or a request-level
`modelId` of `auto` / `copilot/auto`. The resolved model supplies the rate;
unresolved Auto stays unpriced. `ModelUsage.autoRouting` holds the eligible token
subset (including optional cache fields), not extra usage, so manual requests
for the same model are not discounted. Provider/API prices, provider fallbacks
without a `copilotPricing` block, and recorded exact Copilot charges are unchanged.
Session logs do not identify plan eligibility; these are paid-plan rate estimates,
not a claim that a Free account incurs a charge. Premium-request counts are not
converted into token costs by this calculation.

Auto subsets survive aggregation and day allocation. When debug logs replace
per-model tokens without a per-request routing split, the original Auto input/output
proportions are retained as an estimate; cache tokens use the Auto input proportion.
If a partial debug breakdown omits an Auto-routed model entirely, that unmatched
subset cannot be priced reliably and is not transferred to another model. Recovering
its discount requires linking debug requests to their original model/routing evidence;
the current per-model totals do not provide that link.
The Session Steps Overview uses Copilot rates for Copilot editors and provider
rates for other editors. Sub-agents do not inherit the parent's Auto discount.
Copilot CLI's model-change events and per-model billing/shutdown totals do not
provide a reliable per-request Auto signal in the supported schemas; neither
these nor JetBrains/Visual Studio heuristics receive an inferred discount.
Other vendors' `auto` model names are not treated as Copilot routing.

When a model has no `copilotPricing` block the `'copilot'` source falls back to
the provider rates as a proxy — this means the Copilot cost is never
*under-reported* due to a missing entry, it just won't reflect the (often
identical) GitHub-published rate explicitly.

> ℹ️ **Caching note.** VS Code Copilot Chat sessions expose cached-token counts
> through the debug log companion file (`debug-logs/{sessionId}/main.jsonl`),
> where each `llm_request` event records `attrs.cachedTokens`. The extension reads
> this file automatically and applies the reduced `cachedInputCostPerMillion` rate.
> Other sources without cache data (Continue.dev, Cursor, Visual Studio) still fall
> back to the full input rate.

**Cache pricing fields (optional):**

| Field | Description |
|-------|-------------|
| `cachedInputCostPerMillion` | Cost per million tokens for cache **reads** — tokens already cached and billed at a reduced rate |
| `cacheCreationCostPerMillion` | Cost per million tokens for cache **creation**, 5-minute TTL — writing tokens into the cache (billed at a premium) |
| `cacheCreation1hCostPerMillion` | Cost per million tokens for cache **creation**, 1-hour TTL — Anthropic's longer-lived cache tier, billed at a higher premium than the 5-minute TTL |

When these fields are absent, the full `inputCostPerMillion` rate is applied to all input tokens.

**Anthropic prompt caching rates** (used for all `claude-*` models):
- Cache reads: **10% of input rate** (e.g. $0.30/M for Claude Sonnet 4 at $3.00/M input)
- Cache creation, 5-minute TTL: **125% of input rate** (e.g. $3.75/M for Claude Sonnet 4)
- Cache creation, 1-hour TTL: **200% of input rate** (e.g. $6.00/M for Claude Sonnet 4) — Claude Code uses this TTL by default, so its cache-write tokens should be priced with `cacheCreation1hCostPerMillion`, not the 5-minute rate.

For sources that report the TTL breakdown (`cache_creation.ephemeral_1h_input_tokens` vs. `ephemeral_5m_input_tokens` in the raw Anthropic usage object — currently Claude Code and Claude Desktop), `ModelUsage.cacheCreation1hTokens` carries the 1-hour portion of `cacheCreationTokens`, and `calculateEstimatedCost()` prices it separately. When a source doesn't report the split, all cache-creation tokens fall back to the 5-minute rate (prior behavior, unchanged).

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
| **Gemini CLI** (`geminicli.ts`) | ✅ Yes | `tokens.cached` in `GeminiCliAssistantTokens` |
| **VS Code Copilot Chat** | ✅ Yes (debug log) | `debug-logs/{sessionId}/main.jsonl` → `llm_request.attrs.cachedTokens` |
| **Mistral Vibe** (`mistralvibe.ts`) | ✅ Cache reads only | `meta.json` → `stats.session_cached_tokens`, already counted inside `stats.session_prompt_tokens` (so it maps to `cachedReadTokens`, never added on top). No cache-creation field is reported |
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
- Cost estimates use actual input/output token counts when available. Cache-aware pricing is applied automatically for sources that expose cache token breakdowns (Claude Desktop, Claude Code, OpenCode, Gemini CLI, VS Code Copilot Chat, Mistral Vibe).

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
