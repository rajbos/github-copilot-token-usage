# HydraFusion routing events (Copilot CLI)

HydraFusion is a synthetic model: you pick `hydrafusion` in the Copilot CLI, and for each
turn a router decides how many real models to spend on the answer — sometimes one, sometimes
a draft plus a review plus a repair. The CLI hands you a single coherent answer and a single
credit number, so the interesting part (which models ran, what they cost, who rejected whom)
happens off screen.

It is not off the record, though. The CLI writes every routing decision into its own session
log so it can resume and rewind a session, and that is what this document describes.

**Where:** `~/.copilot/session-state/{session-id}/events.jsonl` — the same file as any other
Copilot CLI session. Fusion events sit alongside the normal `user.message` /
`assistant.message` / `tool.execution_*` events documented in
[`session-file-schema.json`](session-file-schema.json).

**Parsed by:** [`src/hydrafusion.ts`](../../src/hydrafusion.ts) →
`analyzeHydraFusionSession(content)`, surfaced in the Session Log Viewer's
"⚡ HydraFusion Routing" section.

**Efficiency attribution:** the CLI keys a routed session's per-turn counters by the
synthetic id (`hydrafusion`, likewise `auto`) but its `session.shutdown` model metrics by
the real models that served each leg. The Efficiency view's Models tab re-keys those metrics
onto the router so it can be compared as a model in its own right — see
`findRoutedSessionModel` / `attributeRoutedModelUsage` in
[`src/modelEfficiency.ts`](../../src/modelEfficiency.ts). The Usage view keeps the real
models.

**Credit to prior art:** the event names and the idea of reconstructing a turn as a trace with
one span per leg come from [`samueltauil/hydrafusion-traces`](https://github.com/samueltauil/hydrafusion-traces)
and its [walkthrough](https://samueltauil.github.io/github-copilot/devops/2026/09/10/hydrafusion-model-routing-grafana-traces.html),
which pointed a reader at this file and put Grafana in front of it. This extension reads the
same events in-place instead of exporting them.

> OpenTelemetry cannot express this yet: the GenAI semantic conventions define
> `gen_ai.request.model` as *the model the client asked for*, and have no field for a router
> that expands one request into several model calls. Until they do, the session log is the
> only record of what actually ran.

## Vocabulary

| Term | Meaning |
|---|---|
| **Fusion / turn** | One user turn, identified by `fusionId`. |
| **Phase / leg** | One model call inside a turn (`draft`, `judge`, `repair`, …). |
| **Pattern** | The shape the router chose: `single`, `cascade`, `critique`. |
| **AIU** | AI credit units. Logged as `totalNanoAiu`; **credits = `totalNanoAiu / 1e9`**. |
| **Scope** | `root` legs can become the answer; `review` legs never can. |

## Event types

Every line shares the CLI envelope `{ type, data, id, timestamp, parentId }`.

### `session.fusion_resolved` — the routing decision

Emitted once per turn, *before* any model runs. This is the plan.

```jsonc
{
  "fusionId": "fusion-51606837-...",
  "turnId": "...",
  "syntheticModel": "hydrafusion",
  "policy": "max",
  "routeSource": "capi_plan",
  "pattern": "cascade",
  "phasePlan": [
    { "kind": "primary", "role": "solver", "scope": "root",   "conditional": false },
    { "kind": "judge",   "role": "judge",  "scope": "review", "conditional": false },
    { "kind": "repair",  "role": "solver", "scope": "root",   "conditional": true  }
  ],
  "primaryModel": "mai-code-1.1-flash",
  "secondaryModel": "gpt-5.6-sol",
  "fallbackModel": "gpt-5.6-sol",
  "followUpModel": null,
  "followUp": false,
  "routingLatencyMs": 1134.302,
  "contractVersion": 1, "planVersion": 1, "policyVersion": 1, "modelUniverseVersion": 1,
  "ruleId": "...", "scores": { }
}
```

`conditional: true` phases only run if an earlier leg asks for them — a planned `repair` that
never happened is a turn the judge accepted. The viewer shows planned-but-skipped legs greyed
out for exactly this reason.

### `assistant.fusion_phase_completed` — one per leg

```jsonc
{
  "fusionId": "fusion-51606837-...",
  "phaseId": "fusion-51606837-...:judge",
  "phaseKind": "judge",
  "role": "judge",
  "conversationScope": "review",
  "model": "gpt-5.6-sol",
  "status": "succeeded",
  "verdict": "reject",
  "durationMs": 2095,
  "usage": {
    "requestCount": 1,
    "inputTokens": 989,
    "outputTokens": 106,
    "cachedTokens": 0,
    "cacheWriteTokens": 0,
    "totalNanoAiu": 607600000
  },
  "content": "…", "projectionMessage": "…", "projectionMode": "…"
}
```

`content` and `projectionMessage` carry the leg's actual model output. **The parser
deliberately discards both** — the routing section reports who ran and what it cost, never
what was said.

Observed `phaseKind` values: `primary`, `judge`, `repair`, `draft`, `critic`, `revision`.
Treat the list as open; the router is served remotely and can add kinds.
`verdict` (`accept` / `reject`) appears only on `judge` legs — `critic` legs return prose, not
a verdict.

### `session.fusion_handoff` — the escalation

```jsonc
{
  "fusionId": "...", "sourcePhaseId": "...:judge",
  "targetPhaseId": "...:repair", "targetModel": "gpt-5.6-sol",
  "message": "…"
}
```

The edge between two legs: who was unhappy, and who got handed the work. `message` is model
output and is discarded like the other content fields.

### `session.fusion_completed` — the turn rollup

```jsonc
{
  "fusionId": "...", "commitId": "...", "turnId": "...",
  "syntheticModel": "hydrafusion", "pattern": "cascade", "outcome": "completed",
  "finalSourcePhaseId": "...:repair",
  "finalSourceModel": "gpt-5.6-sol",
  "followUpModel": null,
  "degradedReason": null,
  "phaseCount": 3, "requestCount": 64,
  "inputTokens": 3511390, "outputTokens": 58100,
  "cachedTokens": 3122560, "cacheWriteTokens": 0,
  "totalNanoAiu": 192249068000, "durationMs": 7095038
}
```

`finalSourcePhaseId` is the one fact you cannot derive: **which leg's output you actually
read.** Everything else in the turn was scaffolding.

`degradedReason` is non-null when the router could not execute its own plan and fell back;
those turns are worth surfacing rather than averaging away.

### `session.fusion_commit_started`

Emitted between resolution and completion. Carries no accounting the other events lack; the
parser ignores it.

## Accounting rules

These are the rules that make the difference between a correct reading and a plausible one.

1. **Never sum the rollup and the legs together.** `fusion_completed.totalNanoAiu` is the
   turn total; the phase events' `usage.totalNanoAiu` are its parts. Verified against a real
   24-turn session: both sum to exactly the same 2811.93338 AIU. Adding them double-counts
   every credit. Take turn totals from the rollup, and fall back to summing legs only when
   the rollup is missing (an in-flight turn).
2. **Legs are not requests.** A turn with 3 legs can contain 64 `requestCount` inference
   calls. Both numbers are interesting; conflating them is not.
3. **Review spend is the overhead.** Credits on legs where `phaseId !== finalSourcePhaseId`
   bought review, not the answer. On the reference session that is ~2% of total spend — the
   reason a compound router is affordable at all.
4. **A missing rollup still has a final source.** When `fusion_completed` has not been written
   yet, the answer is the last leg whose `conversationScope` is not `review`; a review leg can
   never be the answer.
5. **A turn is compound when its pattern is not `single`** — not when it has more than one
   leg, because a planned-but-skipped conditional leg still means the router chose to route.

## What a real session looks like

From a 24-turn session (Copilot CLI 1.0.84-x, 18 MB log), for calibration:

| | |
|---|---|
| Turns / legs | 24 / 44 |
| Patterns | `single` 11, `cascade` 7, `critique` 6 → 54% compound |
| Phase kinds | `primary` 18, `judge` 7, `repair` 6, `draft` 6, `critic` 6, `revision` 1 |
| Judge verdicts | 6 reject, 1 accept |
| Models | `gpt-5.6-sol` 26 legs, `gpt-5.6-luna` 7, `claude-opus-5` 6, `mai-code-1.1-flash` 3, `gpt-5.6-terra` 2 |
| Total | 2811.93 AIU, of which 58.46 AIU (2.1%) went on review |
| Routing latency | ~518 ms mean |

Note the shape of it: `claude-opus-5` ran the fewest legs of the top models and cost the most
credits, and the cheapest model (`mai-code-1.1-flash`) supplied zero final answers — it drafted
and was rejected. Neither fact is visible from the single credit number the CLI prints.
