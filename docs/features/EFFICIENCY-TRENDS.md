# Efficiency trends — semantic zoom and scoped filters

The **Efficiency** view's trend charts used to show one thing: twelve weekly
points, for everything you did, everywhere. That is a good default and a poor
only-option — when the retry rate jumps in week 9 you cannot see which days did
it, and you cannot tell whether it was your editor or the terminal agent.

This page describes the scope toolbar that answers those two questions, and the
honesty rules that decide which charts are allowed to carry it.

## The toolbar

Above the scoped charts sits one compact toolbar:

| Control | What it does |
|---|---|
| **Time presets** | 30 days, 12 weeks (default), 6 months, 1 year |
| **Resolution** | Auto, Daily, Weekly, Monthly — only the widths the range can honestly carry are offered |
| **Editor** | Narrows to one editor/agent (VS Code, Claude Code, …) |
| **Model vendor** | *Models tab only.* Narrows which models the A/B pickers offer |
| **Drill** | Jumps into the days behind one week or month, with a chip and a **Back** action |

Every control is a real `<button>` or `<select>` with a label, so the toolbar is
keyboard reachable; a live region under it announces the resulting scope
("Showing Last 12 weeks, weekly buckets, all editors") after each change. The
`Drill into…` picker is the keyboard equivalent of clicking a data point — a
`<canvas>` is not focusable and its points are not in the accessibility tree,
so without it the drill-down would be mouse-only.

The whole scope (preset, resolution, editor, vendor, drill stack) is persisted
through the webview state API, so reopening the panel lands you where you left.
A state blob written before this feature existed simply reads as the defaults.

## Ranges, buckets and partial periods

`resolveEfficiencyRange` snaps each preset's start to the boundary it will be
read at — Monday for the 12-week window, the first of the month for the 6-month
and 1-year windows. Buckets then snap *outward* to their natural boundary, and
only the trailing bucket is clipped, to today:

- Every bucket except the last covers a whole day, week or month.
- The current (partial) period is deliberately kept, not dropped — you want to
  see the week you are in, as long as you know it is partial. The Trends intro
  says so in words; on every scoped chart the drill-down chip and the range
  label carry the exact end date, which is today.
- That sentence is only shown while the range still reaches today
  (`ScopedData.includesToday`, from `efficiencyTodayKey()`). A drilled-into past
  week or month ends before today and has no partial bucket, so claiming one
  would send the reader looking for data that was never missing.

`Auto` resolution follows the span: ≤ 31 days → daily, ≤ 200 days → weekly,
otherwise monthly. An explicit choice the range cannot carry (daily over a year,
monthly over a month) falls back to auto rather than rendering 365 noisy points.

Drilling into a weekly or monthly point pushes that bucket's day range onto a
bounded stack and switches to daily; **Back** pops one level, restoring both
the preceding range *and* the resolution that was selected before that level
was entered, so an explicit Weekly or Monthly choice survives a round trip.
Picking a different preset abandons the drill-down rather than nesting inside
it.

A filter value that no longer exists in the data — an editor that has aged out
of the window, a vendor you no longer use — stays visible in its dropdown
labelled as having no data, rather than letting the control read "All editors"
while the charts are still filtered to the missing value.

## How a bucket's numbers are attributed

Two different attribution rules meet in one chart, and the difference matters:

- **Volume metrics** (tokens, sessions, interactions, lines changed, cost) come
  from the daily aggregates. A session spanning three days contributes to all
  three.
- **Session-derived behaviour** (active minutes, edit turns, retries, applies,
  code blocks, skill invocations) is attributed *entirely to the bucket
  containing the session's last activity day*. These describe a whole session
  and cannot be truthfully split across days — the same convention the
  lines-of-code attribution has always used.

At weekly resolution this is invisible; at daily resolution a long session's
retries all land on its final day. That is the honest option: the alternative
is inventing a per-day split of a number that was never measured per day.

Ratio denominators keep their sample floors regardless of bucket width — a
bucket with fewer than five edit turns reports **no** retry rate, not a noisy
one. Nulls render as gaps, never as zeros.

### The two data windows

The payload carries two different horizons, and the toolbar says so when they
disagree:

| Data | Horizon | Why |
|---|---|---|
| Daily volume aggregates | 365 days | Cheap: five numbers per day, plus the same five per editor |
| Session-derived behaviour | 12 weeks | Requires walking every session file in the window |

Selecting a 6-month or 1-year range therefore shows volume across the whole
range and behavioural gaps before the session window. The toolbar states this
explicitly rather than letting the gaps read as "you had no retries".

## Which charts get filters, and why not the rest

The filter policy is deliberately uneven. A filter that a chart's maths cannot
support is worse than no filter, because it produces a confident wrong number.

| Tab | Filters | Rationale |
|---|---|---|
| **Trends** | Time/resolution, Editor | Editor is meaningful for every workflow ratio. No vendor/model filter: blended ratios confound task mix with the provider-versus-Copilot cost basis |
| **Combined** | Time/resolution, Editor | Lets output validate shorter/cheaper sessions within one environment |
| **Models** | Time/resolution, Model A/B, model vendor, Editor | Vendor narrows the eligible models without silently aggregating unlike ones; editor conditions the comparison on an environment |
| **Tools & Skills** | Time/resolution, Editor | Skills are invoked in a particular agent/editor. Model vendor is not a reliable causal dimension here |
| **Cost Attribution** | Time pair only | Its purpose is to explain a *whole population's* model-mix cost change. A mixed-model session appears in several categorical groups at once, which would double-count the volume term |
| **Month vs Month** | Existing adjacent calendar periods | Its detailed metrics are global; a filter could not produce exact duration/retry/apply values |
| **Value** | None (global 30-day context) | PR outcomes are not currently attributable to a session, editor or model |

## Vendor is not the biller

The Models tab's vendor filter uses `getModelBillingProvider()` — **the model's
own provider**. It is not `getBillingGroup(editor, model)`, which answers a
different question: who charges you. A Claude model used through GitHub Copilot
is an *Anthropic* model on a *GitHub Copilot* bill. Conflating the two would
silently change which models the filter hides, so `getBillingGroup()` stays
reserved for the actual-biller views (the Chart view's billing breakdown).

One case blurs the distinction, and the filter does not pretend otherwise: a
**BYOK custom endpoint** is labelled with the provider group the user
configured for it (e.g. `Mistral (Custom)`), because that endpoint both serves
and bills the call. The filter shows that label verbatim rather than guessing
at the model behind the endpoint.

## Editor scoping and what it excludes

Editor scoping is exact, not estimated:

- Daily volume carries a per-editor slice (`byEditor`) whose parts sum back to
  the day totals; the unfiltered series still reads the day totals verbatim, so
  turning the filter off reproduces the original numbers rather than
  re-deriving them.
- Per-model counters are written per editor from the same sessions, so merging
  every editor row of a day reproduces the unsplit day exactly. The day's
  task-category tokens are apportioned by each editor's share of the day's model
  tokens, so the shares sum back to 1 and the unfiltered task mix is unchanged.
- Sessions whose editor could not be determined are counted in the unfiltered
  totals and **excluded** from every editor scope. The toolbar says so while a
  filter is active, rather than folding them into whichever editor is selected.

## Payload and performance

No filter interaction re-reads a session log. The extension ships compact
numeric aggregates once — up to 365 days of per-day volume (with the per-editor
split), the per-session behavioural counters over the session window, and the
per-(day, editor) model slices — and the webview recomputes every scoped series
from them client-side. The payload carries numbers and skill names only: never
session prompts, file paths, titles or repository names.

Chart.js instances are destroyed on every redraw (`destroyCharts()` at the top
of `render()`), so changing scope repeatedly does not leak canvases.

## Where the code lives

| Concern | Location |
|---|---|
| Ranges, resolutions, buckets, bucketed series, editor/vendor helpers | `src/efficiencyAnalysis.ts` |
| Scope state, persistence, drill navigation | `vscode-extension/src/webview/efficiency/viewState.ts` |
| Toolbar rendering, chart wiring | `vscode-extension/src/webview/efficiency/main.ts` |
| Per-editor daily aggregation, payload assembly | `vscode-extension/src/extension.ts` |
| Model vendor grouping | `src/chartDataBuilder.ts` (`getModelBillingProvider`) |

`buildEfficiencyTrends`, `buildSkillUsageTrends` and `buildModelWeeklySeries`
are now thin wrappers over the bucketed builders, so the host-computed default
and the webview's filtered recomputation cannot drift apart.

## Limitations

- Behavioural metrics are unavailable before the 12-week session window, so the
  longer presets show volume-only history.
- Daily resolution concentrates each session's behavioural counters on its last
  active day; read daily retry/apply rates as "sessions that finished that day".
- Editor attribution comes from the session file's location, so a session whose
  editor cannot be identified is invisible to editor-scoped views. Those
  sessions are bucketed under the `Unknown` sentinel, which is deliberately not
  offered as a selectable editor — picking it would contradict the exclusion
  the toolbar promises.
- A filtered slice is a smaller sample. The existing sample floors still apply,
  which means narrow scopes legitimately show more "—" than the global view.
