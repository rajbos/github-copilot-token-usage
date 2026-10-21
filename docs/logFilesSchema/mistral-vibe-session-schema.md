# Mistral Vibe Session Schema

Mistral Vibe (<https://github.com/mistralai/mistral-vibe>) is a terminal coding agent. Parsed by `src/mistralvibe.ts` and `src/adapters/mistralVibeAdapter.ts`.

## Location

`<VIBE_HOME or ~/.vibe>/logs/session/session_<YYYYMMDD>_<HHMMSS>_<id8>/`

| File | Used for |
|---|---|
| `meta.json` | Session metadata, token totals, speed, cost and tool-outcome stats. The `meta.json` path is the session file path throughout the pipeline. |
| `messages.jsonl` | One LLM message per line (`role`, `content`, `tool_calls`, `injected`). No per-message timestamps. |

## `meta.json` fields we read

All numeric `stats` fields are read defensively: a missing, non-numeric, negative or non-finite value is `undefined`, never `0`.

| Field | Type | Meaning | Exposed as |
|---|---|---|---|
| `start_time`, `end_time` | ISO 8601 string | Session start / last update | `firstInteraction`, `lastInteraction`; wall-clock fallback for `sessionDuration` |
| `config.active_model` | string | The single model for the session | model key for token attribution |
| `stats.session_prompt_tokens` | number | Input tokens, **including** cached | `inputTokens` |
| `stats.session_completion_tokens` | number | Output tokens | `outputTokens` |
| `stats.session_cached_tokens` | number | Cache-read portion of the prompt tokens (clamped to the prompt total) | `cachedReadTokens` |
| `stats.tokens_per_second` | number | Vendor-reported generation speed | `vendorStats.tokensPerSecond` |
| `stats.last_turn_duration` | number, **seconds** | Duration of the last turn | `vendorStats.lastTurnDurationMs` (converted to ms) |
| `stats.session_cost` | number, dollars | Vendor-reported cost | `vendorStats.reportedCostDollars`, a cross-check only; cost stays on `calculateEstimatedCost` |
| `stats.steps` | number | Agent steps | `vendorStats.steps` |
| `stats.tool_calls_succeeded` / `_failed` / `_rejected` / `_agreed` / `_hook_denied` | number | Session-level tool-call outcomes (not attributed per tool) | `vendorStats.toolOutcomes.{succeeded,failed,rejected,agreed,hookDenied}` |

Fields present in `meta.json` but not read: `last_turn_*_tokens`, `session_total_llm_tokens`, `context_tokens`, the per-million price fields (their values are mirrored in `src/modelPricing.json`), and everything else, including `title` and any system prompt. No text is read from `messages.jsonl` into these stats.

## Derived values and caveats

- **`sessionDuration.activeDurationMs`** is `end_time - start_time`. Vibe records no per-turn timestamps, so this is *wall-clock including idle gaps*, used only as a fallback. It is absent when either timestamp is missing, unparseable or the range is not positive. The other `sessionDuration` averages are 0 for Vibe.
- **`vendorStats`** on `SessionUsageAnalysis` (and summed on `UsageAnalysisPeriod`) holds the speed, cost, steps and tool-outcome values. Rates and durations are stored as `{ samples, sum }` so they merge across sessions; divide to average.
- Tool outcomes are session totals with no tool name, so they are **not** folded into the per-tool `completedByTool` / `failuresByTool` maps. `rejected` and `hookDenied` are calls declined rather than failed.
- Sessions cached before these fields existed are re-read because the cache versions were bumped.

## Drift detection

The `validate-session-schemas` skill covers this platform (`--platform mistral-vibe`). It reads `meta.json` only and reports field paths, never values.
