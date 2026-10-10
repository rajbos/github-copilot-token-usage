# Model Efficiency Comparison

The **Models** tab in the Efficiency view answers a question the other tabs could
only hint at: *is my current AI usage more efficient than before, and is the model
mix the reason?*

Typical questions it can now settle:

- "I've been using Kimi a lot more this month than last — did that actually help?"
- "Is Claude Opus worth its price per edit turn compared with a cheaper model?"
- "Is the model I rely on getting better or quietly getting worse over time?"

## Two modes

| Mode | What it compares | Use it for |
|---|---|---|
| **Compare two models** | Model A vs Model B over the *same* window | Head-to-head model choice |
| **One model, two periods** | The same model across two windows | Detecting drift in a model you already rely on |

Windows available: last 30 days, previous 30 days, last 90 days, this month, last month.

## Scoping the comparison

The scope toolbar above the tab narrows *what goes into* both modes. See
[EFFICIENCY-TRENDS.md](EFFICIENCY-TRENDS.md) for the toolbar itself; this tab
adds two dimensions of its own.

### Underlying model vendor

The vendor filter narrows which models the A/B pickers offer — Anthropic,
OpenAI, Google, Mistral AI, xAI, and so on. It exists so you can ask "of the
Anthropic models I actually use, which is cheaper per edit turn?" without the
alternative the view refuses to offer: silently *aggregating* unlike models into
one "vendor" row, which would blend different prices and different task mixes
into a number that looks precise and means nothing.

**Vendor is the model's own provider, not who bills you.** It comes from
`getModelBillingProvider()`. A Claude model used through GitHub Copilot is an
*Anthropic* model on a *GitHub Copilot* bill; `getBillingGroup(editor, model)`
answers that second question and is deliberately **not** used here — it stays
reserved for the actual-biller views such as the Chart view's billing breakdown.
The exception is a BYOK custom endpoint, which carries the provider group the
user configured for it (e.g. `Mistral (Custom)`) because that endpoint serves
*and* bills the call; the filter surfaces that label as-is.

Changing the vendor (or editor) re-points the A/B selection at models that still
exist in the narrowed scope, so the comparison never silently keeps pointing at
a model the current scope has no data for.

### Editor

The editor filter conditions the comparison on one environment, which is the
honest way to compare models that you use for different things in different
places. Attribution is exact rather than estimated: per-model counters are
written per editor from the same sessions, so merging every editor row of a day
reproduces the unsplit day. Sessions whose editor could not be determined are
counted in the unfiltered view and excluded from every editor scope.

Both filters shrink the sample, so the existing floors bite sooner: a narrowed
scope legitimately shows more "—" and more caveats than the global view. That is
the guardrail working, not a bug.

### Time and resolution

The time preset and resolution drive the **Drift over time** chart at the bottom
of the tab (daily, weekly or monthly buckets over 30 days to a year, with
click-to-drill into a bucket's days). The head-to-head comparison keeps its own
window pickers, because "baseline vs compared period" is a different question
from "how far back does the drift chart go".

## What it measures

| Metric | Direction | Meaning |
|---|---|---|
| Cost per edit turn | lower is better | Price of one turn that actually changed code |
| Cost per session | lower is better | Price of an end-to-end piece of work |
| Cost per 1000 lines | lower is better | Price per unit of output (weak proxy — see caveats) |
| Dollars per million tokens | lower is better | Raw rate, mix-adjusted |
| Tokens per edit turn / per session | lower is better | Verbosity and context overhead |
| One-shot edit rate | higher is better | Share of edits that landed without a retry |
| Edit retry rate | lower is better | Retries per edit turn |
| Self-correction rate | lower is better | How often the model fixed its own output |
| Cache read share | higher is better | Prompt reuse, which lowers cost |
| Active minutes per session | lower is better | Wall-clock time to get the work done |
| Apply rate | higher is better | Suggested blocks you actually accepted |

## How the numbers are attributed

Per-turn counters — calls, edit turns, retries, one-shot edits, self-corrections,
tool calls — are recorded **per model** and are never split or estimated.

Session-level signals that no editor reports per model — active duration, lines
added/removed, applies, code blocks — are split across the session's models by
**token share**. A session that spent 70% of its tokens on model A and 30% on
model B contributes its duration and line counts in that ratio. The split is
lossless: the parts always sum back to the session total.

Because of that split there are two session counts:

- `sessions` — every session that touched the model (a two-model session counts
  for both).
- `sessionShare` — the token-weighted fractional equivalent. This is the honest
  denominator for per-session ratios, and it is what the tab uses.

## Cost basis

The Models tab prices tokens at **provider/API rates**, so it measures the models
themselves rather than a billing plan. This is deliberately different from the
**Cost Attribution** tab, which uses Copilot AI-Credit pricing to reflect what a
Copilot subscription actually consumes. Comparing dollar figures across the two
tabs is not meaningful.

## Guardrails against false conclusions

The tab is designed to refuse a verdict rather than invent one.

- **Sample floors.** A side needs at least 5 session-shares and 10 edit turns
  before its metrics are treated as comparable. Metrics below the floor render
  as `—` rather than a confident number.
- **Noise gate.** A difference under 10% is reported as a *tie*, not a win.
  Only decisive metrics feed the verdict.
- **Caveats banner.** Raised when a side is below a sample floor, when the two
  sides' task mixes diverge by 20 points or more, or when a model's usage is
  dominated by mixed-model sessions (so its duration and line figures are
  approximate).
- **Task mix bars.** Task categories are classified per session and distributed
  across that session's models by token share. They are shown as *context* —
  if one side did mostly refactoring and the other mostly greenfield work, part
  of any gap belongs to the work, not the model. Task mix never scores a model.

## Reading the radar

Each axis is normalized so the better side scores 100 and the other scores
proportionally. A larger overall shape means a better all-round profile; a spiky
shape means the side wins on some dimensions and loses on others — which is
usually the more interesting result. Axes where either side lacks data are
dropped, and the radar is hidden entirely below three usable axes.

## The Cost Attribution model-mix table

The Cost Attribution tab's **Model mix movement** table is the per-model detail
behind its "Model mix ($/token)" bar: for each model, its share of the period's
tokens before and after, and the movement between them in percentage points.

`buildModelShifts()` in `src/efficiencyAnalysis.ts` decides what appears there
and in what order — movements under **0.5 percentage points** are dropped as
noise, the rest are sorted by absolute movement and the **top six** are kept.
The view renders that list as given; it never re-filters or re-sorts.

What the table does *not* carry is names. `ModelMixShift` is deliberately
canonical — a raw `model` id plus numbers — because the friendly-name resolver
`getModelDisplayName()` reads the pricing JSON from `window.__MODEL_PRICING__`,
a global that exists only inside a webview. Resolving in the extension host
therefore produced raw ids in the shipped UI. The Efficiency webview
(`vscode-extension/src/webview/efficiency/modelMixTable.ts`) resolves the name
at render time instead, where the pricing data is present, reusing the one
shared resolver that already understands pricing aliases, `copilot/` prefixes,
custom-endpoint ids, org UUID prefixes and dash/dot version variants.

A model with no pricing entry is never relabelled with a guess: its normalized
identifier is shown as-is, so an unknown or in-house model stays unique and
inspectable. Where a friendly name and its canonical id differ, both are
reachable — the id is in the cell's `title` and in the row's screen-reader text.

For readability the table caps at a readable desktop width, uses compact
Previous/Current headers with the date range as a sub-label, and scrolls
horizontally inside its own region on narrow panels rather than compressing the
numbers. Only the model name truncates visually.

## Where the data comes from

Per-model efficiency counters are accumulated onto `DailyTokenStats.modelEfficiency`,
which makes them sliceable by arbitrary date windows, and mirrored per editor onto
`DailyTokenStats.editorModelEfficiency`, which makes them sliceable by environment.
Both are written from the same session in the same place, so merging every editor
slice reproduces the unsplit day exactly. Two accumulation paths run at different
cadences:

- **Tokens and cost** are accumulated once per session *per day*, from that day's
  `modelUsage`, so they line up with the other daily series.
- **Turn counters and duration** are accumulated once per session, on the day of
  last activity, matching the existing lines-of-code attribution convention —
  these describe a whole session and cannot be split across days.

The webview receives one row per (day, editor) pair, built by
`splitModelDayByEditor`. The day's task-category tokens are apportioned across
those rows by each editor's share of the day's model tokens, so the shares sum
back to 1 and the unfiltered task mix is identical to the unsplit day's.

The comparison engine itself lives in `src/efficiencyAnalysis.ts`
(`computeModelPeriodMetrics`, `listComparableModels`, `compareModels`,
`buildModelBucketSeries`, `selectModelDaysForEditor`, `listModelVendors`,
`filterModelsByVendor`) and is shared, so the CLI and other hosts can consume
the same logic without reimplementing it.

## Limitations

- Requires session logs that carry per-turn tool-call detail. Editors that only
  report aggregate token counts will not appear as comparable models.
- Lines of code is a weak proxy for value; refactors and generated boilerplate
  distort cost-per-1000-lines in both directions.
- Active duration depends on the editor adapter reporting it; where it is absent
  the duration metrics are omitted rather than guessed.
- A model comparison is observational, not an experiment. Even with the caveats
  above, you did not randomly assign work to models.
- The vendor filter narrows *which models you may pick*. It never aggregates a
  vendor's models into a single row — different models from one vendor are not
  interchangeable, and a blended "Anthropic" figure would hide exactly the
  difference the tab exists to show.
- Editor-scoped comparisons exclude sessions whose editor could not be
  determined, so a scoped total can be smaller than the unfiltered one.
