---
title: View Hierarchy
description: The full view → sub-view → content-block map of the VS Code extension's webview panels, plus the grouping rules that keep it navigable
lastUpdated: 2026-09-12
status: current
---
# View Hierarchy

Every panel the extension ships, broken down three levels deep: **view** (a webview panel,
reached from the shared nav row) → **sub-view** (a tab within it) → **content block** (one
`.section` card, table, or chart).

This document exists because the hierarchy is not visible anywhere in the code. A view's blocks
are concatenated into one template literal in its `main.ts`, so nothing distinguishes "these
four sections answer the same question" from "this section was appended last year and never
found a home". The Usage Analysis view had reached nine sibling sections in a single tab, and
the last two were read as leftovers precisely because nothing said otherwise.

Related: [DESIGN.md](DESIGN.md) (visual system), [WEBVIEW-MESSAGING.md](WEBVIEW-MESSAGING.md)
(how data reaches a panel), [VALIDATION.md](../VALIDATION.md) (what checks each view).

## Level 1 — views

The shared nav row (`src/webview/shared/buttonConfig.ts`, `NAV_ORDER`) is the canonical order:

| View | Bundle | Sub-views | Question it answers |
|---|---|---|---|
| Details | `details` | — | What are my raw token/cost numbers right now? |
| Token Usage Over Time | `chart` | — | How has that moved over time? |
| **Usage Analysis** | `usage` | 4 groups → 10 tabs | How do I actually work with AI, and what does it cost? |
| Fluency Score | `maturity` | — | How mature is my AI engineering practice? |
| Efficiency | `efficiency` | 8 tabs | Am I getting more output per dollar over time? |
| Environmental Impact | `environmental` | — | What is the energy/water/carbon footprint? |
| Diagnostics | `diagnostics` | 3 groups → 14 tabs | Is the extension itself seeing my data correctly? |
| Team Dashboard | `dashboard` | 2 tabs | How does my team compare? (only when a backend is configured) |

Three further panels are reached contextually rather than from the nav row: **Log Viewer**
(`logviewer`, opened from a session row), **Fluency Level Viewer** (`fluency-level-viewer`,
opened from the Fluency Score view), and **What's New** (`whatsnew`, opened on upgrade).

## Level 2 & 3 — sub-views and content blocks

### Usage Analysis (`usage`) — the big one

Ten tabs under four group tabs. The group strip and leaf strips are built by
`buildTabStripHtml`; `USAGE_TAB_GROUPS` in `usage/tabGroups.ts` owns the mapping, and each tab
panel gets its own `build*TabPanelHtml` function.

The count moves: AI Readiness joined the view in #2194 and took it from nine to ten. Rather than
trusting this number, trust the test — `webview-usageTabGroups.test.ts` asserts `USAGE_TAB_GROUPS`
covers *exactly* `SWITCHABLE_TABS`, so a tab added to one and not the other fails the build.

Leaf tab ids are deliberately unchanged from the flat strip that preceded the groups: they are the
`viewTabOpened` telemetry key the host records against, the `switchTab` message payload, and the
target of the What's New view's "Take me there" deep links. Grouping them is chrome; renaming
them would break those three callers.

The active tab is *not* persisted — `UsageWebviewState` stores only `aboutCollapsed`, and
`activeTab` resets to `activity` whenever the panel is recreated. Same for which leaf each group
was last left on. Both are in-memory navigation state that survives re-renders within a session,
not user settings.

| Group | Tab | Content blocks |
|---|---|---|
| 📊 **Usage** | **My Activity** | *(three bands — see below)* |
| | **Recent Sessions** | Lookback selector · filter pills · sessions table (sortable, configurable columns) |
| 📁 **Workspace** | **Tools & Integrations** | Tool Usage (3 periods) · Multi-Model Usage · MCP Tools · Tool Curation · unknown-tool banner |
| | **Workspace Health** | Copilot Customization Files table (20 per page, sortable, filter to workspaces with no customization files; path on hover) |
| | **AI Readiness** | Per-repo readiness overview (collapsible) · Copilot Chat drafts |
| | **Worktrees** | scan controls · roots list · progress · results table |
| 🐙 **GitHub** | **Repository PRs** | AI Activity in Repository PRs |
| | **Cloud Agent** | Copilot Cloud Agent Sessions |
| 🎓 **Coaching** | **Insights** | Insight cards (new/acted/dismissed) |
| | **Corrections** | Corrections report · Skill Suggestions (repeated-task clusters) |

The **My Activity** tab is itself banded, via section-group headings
(`sectionGroupHeadingHtml`) rather than further tabs:

| Band | Sections |
|---|---|
| 📊 Overview | Sessions Summary · Interaction Modes |
| 💵 Spend & models | AI Billing Coverage · Model Cost Usage · Multi-Model Usage · Local Model Leaderboard · Thinking Effort (Reasoning) |
| 🧠 Context | Context References · Context Window & Long-Context Pricing (incl. context compaction) |

All tab switching goes through one `activateUsageTab()`, whether the user clicked a tab, the
host sent a `switchTab` message, or the unknown-tool banner jumped here. Revealing the owning
group, the active markers, the panel, the telemetry ping and the first-visit lazy loads all live
there once, so a new entry point cannot implement half of it.

### Diagnostics (`diagnostics`)

The view this pattern came from: a **group tab → leaf tab** strip, now shared with Usage
Analysis. Copy it when a view outgrows one row of tabs.

| Group | Leaf tabs |
|---|---|
| 🩺 Diagnostics | Report · Session Files · Cache · Path Analyzer · Share Card |
| 🔬 Research | Model Usage · Tool Analysis · Skill Usage · OTel Delta · TTFT |
| ⚙️ Settings | Display · Backend Storage · GitHub Auth · Debug (debug mode only) |

### Efficiency (`efficiency`)

Flat tab strip, defined as a single array — the cheapest sub-view structure in the codebase:
Trends · Tools & Skills · Month vs Month · Cost Attribution · Prompt Cache · Models · Value ·
Combined.

### Views with no sub-views

| View | Content blocks (in render order) |
|---|---|
| Details | plan badge · provider panel · metrics table (grouped rows) · Editor Usage (with "Other" disclosure) · Model Usage (with "Other" disclosure) · estimates footnote |
| Chart | header · summary cards · period toggles · time-window/metric/split/rolling controls · chart canvas · editor cards · language heatmap |
| Fluency Score | radar chart · category cards · agentic sparkline · Stage Reference · Share card · About |
| Environmental | impact cards (per period, with analogies) · estimates footnote |
| Team Dashboard | *Azure Dashboard* tab: personal section · team section · model breakdown · leaderboard · fluency detail — *Team Server* tab: launch card |
| Log Viewer | session header · turns overview · Hydra fusion section · turn detail |
| Fluency Level Viewer | level list · Scoring Guide · Requirements · Next Steps · About |
| What's New | release entries with "Take me there" deep links |

## Grouping rules

Three mechanisms, in increasing order of cost. Pick the cheapest one that fits.

### 1. Section-group heading — a band within one tab

`sectionGroupHeadingHtml(icon, titleKey, subtitleKey)` in `usage/main.ts`. A labelled rule above a
run of `.section` cards. Use it when a tab has **more than ~4 sections** that fall into obvious
groups but do not deserve separate tabs, because a reader wants them on one scroll.

Note the parameter names: the last two are **webview localization keys**, not display text. The
helper resolves them through `localize()` and escapes the result, so a heading added with literal
strings would render the key names *and* bypass the localization chain the `lint:hardcoded-strings`
gate enforces.

Nothing about the sections themselves changes — no markup, no message contract, no telemetry,
no tab id. That is the point: it is the one regrouping that costs nothing to try.

### 2. Leaf tabs under a group tab — the Diagnostics pattern

Use it when a view's tab strip **wraps or exceeds ~8 tabs** and the tabs fall into groups a
reader picks between before picking a tab. It is what keeps Diagnostics' 14 tabs and Usage
Analysis' 10 legible.

Keep the leaf tab ids exactly as they were and this costs no migration at all: the
`viewTabOpened` telemetry and any deep links keep working, and the owning group is derived from
the tab rather than stored alongside it. Renaming leaf ids is what would be expensive — so don't,
unless the rename is the point.

**The one thing grouping does break is the view's `states` in
`.github/skills/visual-view-diff/views.config.json.`** A non-active group's leaf bar is
`display:none`, so a state that clicks straight at `.tab-button[data-tab="x"]` can no longer
reach it and the state fails to render — which silently takes the visual diff, the CI
screenshots and the release video's shot of that tab with it. Prepend a
`{ "click": ".group-tab[data-group=\"<group>\"]" }` step to every state outside the group that
is open on first render, the way the diagnostics states already do, and name the group in the
state's `title` (`"Workspace › Worktrees tab"`) — `tabName()` in `release-video/src/surfaces.ts`
splits on the `›` so the narration can say "under Workspace".

### 3. A new view

Only when the content has a **different data source and a different cadence** from everything
in the host view. A new nav button is the most expensive thing on this page: it is permanent,
it is in everyone's muscle memory, and it competes for the nav row's limited width.

### The long-tail rule

A list that enumerates *everything the extension can detect* — reference kinds, models, editors —
shows the entries with recent usage and folds the rest into an **"Other" group**, never dropping
them. Three implementations do this, via two different mechanisms:

| List | Disclosure | Mechanism | "Recent" means |
|---|---|---|---|
| Context References | `.ctx-ref-other` (`usage/contextRefTableHtml.ts`, split by `usage/contextRefRows.ts`) | `<details>` + module flag | today + last 30 days > 0 |
| Local Model Leaderboard | `.model-leaderboard-other` | `<details>` + module flag | above the long-tail turn share |
| Details: Editor / Model Usage | per-table "Other" parent row | expandable row + its own state | non-zero in any shown period |

For the two `<details>` ones, the open/closed state lives in a module-level flag restored on
re-render via a **capture-phase** `toggle` listener — `toggle` does not bubble, and both tables
are rebuilt from scratch whenever new stats arrive. The Details view predates that pattern and
uses a clickable parent row instead; copy whichever matches the table you are adding to, not
"the long-tail pattern" as if there were only one.

**This is a rule for lists that preserve their tail, not for every list.** The Usage view's Tool
Usage tables are the counter-example: `renderToolsTable()` sorts and truncates to its `limit`,
so entries past the cut are simply not shown. That is a deliberate top-N table, not a long tail
with a disclosure — don't "fix" it into one without deciding that showing every tool is wanted.

## Keeping this file honest

This hierarchy goes stale the same way the structure diagram in `AGENTS.md` does, and the
failure is the same: a contributor reads a map of a UI that no longer exists.

**Adding, removing, or moving a view, a tab, or a content block means updating the table above
in the same PR.** A new view additionally needs an entry in
`.github/skills/visual-view-diff/views.config.json` — that one registry feeds the visual diff,
the CI screenshots, and the interaction crawl, so a view missing from it is silently unvalidated
by all three.
