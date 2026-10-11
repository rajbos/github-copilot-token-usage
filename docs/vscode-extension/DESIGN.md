---
version: alpha
name: AI Engineering Fluency (VS Code)
description: >
  Native VS Code webview design system. Themable via VS Code CSS custom
  properties (light/dark), plus a distinct "Industrial Redux" mode that
  activates automatically under VS Code's high-contrast themes.
colors:
  bg-primary: "var(--vscode-editor-background)"
  bg-secondary: "var(--vscode-sideBar-background)"
  bg-tertiary: "var(--vscode-editorWidget-background)"
  text-primary: "var(--vscode-editor-foreground)"
  text-secondary: "var(--vscode-descriptionForeground)"
  text-muted: "var(--vscode-disabledForeground)"
  border-color: "var(--vscode-panel-border)"
  border-subtle: "var(--vscode-widget-border)"
  button-bg: "var(--vscode-button-background)"
  button-fg: "var(--vscode-button-foreground)"
  button-secondary-bg: "var(--vscode-button-secondaryBackground)"
  button-secondary-fg: "var(--vscode-button-secondaryForeground)"
  link-color: "var(--vscode-textLink-foreground)"
  error: "var(--vscode-errorForeground)"
  warning: "var(--vscode-editorWarning-foreground)"
  success: "var(--vscode-terminal-ansiGreen)"
  badge-bg: "var(--vscode-badge-background)"
  badge-fg: "var(--vscode-badge-foreground)"
  stage-1: "#93c5fd"
  stage-2: "#a78bfa"
  stage-3: "#3b82f6"
  stage-4: "#22d3ee"
  stage-1-light: "#1d6fa4"
  stage-2-light: "#7c3aed"
  stage-3-light: "#2563eb"
  stage-4-light: "#0891b2"
typography:
  body:
    fontFamily: "var(--vscode-font-family)"
    fontSize: 13px
  h1-title:
    fontFamily: inherit
    fontSize: 28px
    fontWeight: 900
    letterSpacing: 2px
  section-heading:
    fontFamily: inherit
    fontSize: 16px
    fontWeight: bold
  stat-value:
    fontFamily: inherit
    fontSize: 32px
    fontWeight: 900
  label-caps:
    fontFamily: inherit
    fontSize: 12px
    fontWeight: bold
    letterSpacing: 0.5px
  code-mono:
    fontFamily: "var(--vscode-editor-font-family), monospace"
rounded:
  none: 0px
spacing:
  xs: 4px
  sm: 8px
  md: 15px
  lg: 20px
  xl: 40px
components:
  nav-button-row:
    display: flex
    gap: "{spacing.md}"
  nav-button-active:
    backgroundColor: "{colors.button-secondary-bg}"
    textColor: "{colors.button-secondary-fg}"
    borderBottom: "2px solid var(--vscode-focusBorder)"
  stat-card:
    backgroundColor: transparent
    rounded: "{rounded.none}"
    padding: "{spacing.md}"
  fluency-badge-stage-1:
    textColor: "#f0abfc"
  fluency-badge-stage-2:
    textColor: "#2dd4bf"
  fluency-badge-stage-3:
    textColor: "#facc15"
  fluency-badge-stage-4:
    textColor: "#fb7185"
---

## Overview

The extension does not ship its own visual identity — every webview panel
(Dashboard, Details, Chart, Usage Analysis, Diagnostics, Fluency Score,
Level Viewer, Environmental Impact, Log Viewer) is themed entirely through
VS Code's built-in CSS custom properties (`--vscode-*`). This means the UI
automatically matches whatever color theme the user has installed — light,
dark, or a third-party theme — with zero extension-side color logic.

There is one deliberate exception: VS Code's **high-contrast** theme kinds
(`vscode-high-contrast`, `vscode-high-contrast-light`) trigger a distinct,
intentionally loud styling mode nicknamed **"Industrial Redux"** — stark
black/white outlines, uppercase monospace navigation, neon accent colors,
and hard drop-shadows. This is scoped entirely to high-contrast themes via
`body[data-vscode-theme-kind="..."]` selectors in `theme.css`; normal
light/dark themes keep the native, unobtrusive VS Code look.

All webviews share one navigation bar (rendered from a single button
config) and one `theme.css` token layer, so a change to a shared variable
propagates to every panel.

## Colors

Every semantic color token is a passthrough alias for a VS Code theme
variable (see `vscode-extension/src/webview/shared/theme.css`) — no
hard-coded hex values for base UI chrome. The only fixed hex colors in the
system are the four **fluency stage accent colors**, which need to stay
visually distinct and recognizable across all themes:

- **Stage 1 (`#93c5fd` dark / `#1d6fa4` light):** Blue — earliest fluency stage.
- **Stage 2 (`#a78bfa` dark / `#7c3aed` light):** Purple.
- **Stage 3 (`#3b82f6` dark / `#2563eb` light):** Deeper blue.
- **Stage 4 (`#22d3ee` dark / `#0891b2` light):** Cyan — most advanced stage.

Per-button nav icon accents (e.g. `#c37bff` robot icon for Details,
`#60a5fa` for Chart, `#22d3ee` for Usage Analysis) are defined once in
`buttonConfig.ts` and applied via a `--icon-accent` custom property, so the
button label stays the theme's normal foreground while only the glyph
carries color. In high-contrast mode this override is disabled and icons
fall back to `currentColor` to preserve stark monochrome contrast.

Status colors (`error`, `warning`, `success`) map directly to VS Code's own
semantic tokens so error/warning states match the editor's own diagnostics
coloring.

## Typography

No custom web fonts are loaded. Body text uses `var(--vscode-font-family)`
(the user's configured VS Code UI font) and code/numeric values use
`var(--vscode-editor-font-family)` so they match the user's editor font
(monospace fallback). In high-contrast mode, the entire panel switches to
the editor's monospace font stack (`"JetBrains Mono", "Fira Code", monospace`
as fallbacks) to reinforce the "industrial/terminal" identity.

Scale is expressed in raw pixels rather than a rem scale: 12–13px for
labels/body, 16px for section headings, 28px for page titles, and 32px for
large stat numbers. Titles and labels frequently use `text-transform:
uppercase` with positive `letter-spacing` (0.5–2px) for a dashboard/data-hud
feel, most pronounced in high-contrast mode.

## Layout

- Content is capped at `max-width: 1200px` and centered (`margin: 0 auto`)
  with `20px` padding.
- Section spacing uses a small fixed scale: `4px` / `8px` / `15px` / `20px`
  / `40px` — no fluid/rem-based spacing scale.
- Grids use `repeat(auto-fit, minmax(200px, 1fr))` for responsive stat card
  rows rather than fixed breakpoints.
- The nav button row is a `flex` row with `gap` and `flex-wrap: wrap` so it
  degrades gracefully in narrow panel widths without horizontal scrolling.

## Elevation & Depth

Two distinct depth languages coexist, selected by theme kind:

- **Normal themes:** soft alpha-blended shadows (`rgb(0,0,0,0.16)` dark /
  `rgb(0,0,0,0.08)` light for resting state, slightly stronger on hover) —
  conventional card elevation.
- **High-contrast themes:** **hard, offset "brutalist" shadows** with no
  blur (`4px 4px 0 var(--vscode-panel-border)`, growing to `6px 6px 0` and
  translating the card `-2px -2px` on hover) — depth communicated by outline
  and offset rather than blur, since blur reads poorly in high-contrast.

## Shapes

Border radius is `0` everywhere in the current design — no rounded corners
on cards, badges, buttons, or table cells. Borders are the primary shape
language: `2px solid` for standard containment (cards, tables, list items),
escalating to `4px solid` for page-level dividers (header/footer rules,
error message boxes) and high-contrast component outlines.

## Components

- **Navigation button row** (`buttonConfig.ts` + `theme.css`): one shared
  `<vscode-button>` row rendered identically across all panels. The
  `Refresh` button is `appearance="primary"`; every other nav destination
  is `appearance="secondary"` (outlined) so the row doesn't read as a wall
  of solid pills. The button for the currently open view is rendered
  `disabled` with a `.nav-active` class — secondary background + a
  `2px solid var(--vscode-focusBorder)` bottom border — so the row reads as
  a tab strip, not a set of always-clickable actions.
- **Stat card**: bordered, non-rounded box with a large bold value, a
  dotted-underline uppercase label, and a hard drop-shadow that intensifies
  and lifts on hover.
- **Section container**: a bordered card whose `<h2>` "floats" above the
  top border edge (`position: absolute; top: -16px`) with an inverted
  background — a tab/label motif borrowed from technical schematics.
- **Fluency badge**: pill-shaped-but-square (`border-radius: 0`) outlined
  badge, colored per stage via `currentColor`, used inline in tables and
  leaderboards.
- **Data table** (`shared/dataTable.ts` + `shared/dataTable.css`, see
  [DATA-TABLE.md](DATA-TABLE.md)): the one table component every panel
  uses — square-cornered bordered grid, sticky header row, hover highlight,
  sortable column headers with ↑/↓ indicators, and a shared Previous/Next
  pager. In high-contrast mode the header row inverts and rows get a dashed
  hover outline. View-specific rows (e.g. the leaderboard's `current-user`
  row) are styled through a row class, not by restyling the table.
- **Loading indicator**: a single filled square that pulses opacity
  (`step-end` easing) instead of a spinner — deliberately blocky rather than
  a smooth circular spinner, consistent with the square-cornered system.

## Do's and Don'ts

- **Do** source all chrome colors from `--vscode-*` variables — never
  hard-code a hex value for backgrounds, text, or borders that should
  respect the user's theme.
- **Do** gate any new "loud" high-contrast styling behind
  `body[data-vscode-theme-kind="vscode-high-contrast"]` /
  `vscode-high-contrast-light` selectors so normal themes are unaffected.
  Every Industrial Redux rule in `theme.css` follows this pattern; verify
  new components do too.
- **Do** reuse the shared `buttonConfig.ts` / `theme.css` navigation row and
  `.nav-active` state instead of hand-rolling a new nav pattern per panel.
- **Do** keep border-radius at `0` for new components in this system —
  rounded corners break the current sharp-edged, table/schematic aesthetic.
- **Don't** introduce new arbitrary hex colors outside the four documented
  fluency-stage accent colors and the per-button icon accents already
  defined in `buttonConfig.ts`.
- **Don't** load external web fonts — typography must stay tied to
  `--vscode-font-family` / `--vscode-editor-font-family` so it matches the
  user's own editor configuration.
- **Don't** rely on blur-based shadows for depth in high-contrast mode;
  use the hard offset-shadow pattern already defined for `.stat-card`.
