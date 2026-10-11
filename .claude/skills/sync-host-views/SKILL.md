---
name: sync-host-views
description: Keep the Visual Studio, JetBrains and desktop-app webview views (screens) in sync with the VS Code views, while preserving the exact set of views each host ships. Detects views added to the VS Code extension (vscode-extension/esbuild.js entryPoints) that the Visual Studio host (AIEngineeringFluency.csproj), JetBrains host (jetbrains-plugin/build.gradle.kts) or desktop app (desktop/esbuild.js WEBVIEW_BUNDLES + desktop/src/main.ts PANEL_MENU) do not yet ship, and surfaces them for a human decision instead of auto-adding. Use after building/updating the VS Code webviews, before a Visual Studio, JetBrains or desktop release, or whenever a host is missing a screen VS Code now has.
---

# Sync Host Views Skill

The VS Code extension owns **all** webview "views" (a.k.a. screens). The Visual
Studio extension, the JetBrains plugin and the desktop app are thin hosts that
load a **subset** of the same compiled webview bundles inside a WebView2 / JCEF /
Electron browser.

No host commits webview content to git any more (see
`docs/adr/VS-WEBVIEW-BUNDLE-SOURCING.md`): all three copy the bundles fresh from
`vscode-extension/dist/webview` at build time — Visual Studio via the
`.csproj`'s `CopyWebviewBundles` MSBuild target, JetBrains via
`prepareBundledAssets` in `build.gradle.kts`, the desktop app via
`copyStaticAssets` in `desktop/esbuild.js`. So there is nothing left for this
skill to refresh or flag as stale; it only tracks **view-LIST drift** — which
named bundles each host's build config references — the same way for every
host:

- 🛑 **Never** silently add a new VS Code view to a host. New views are detected
  and **handed to the user to decide**.
- 🔎 Flag views a host references that VS Code no longer builds (orphans).

## One view == one screen

Each entry in the VS Code esbuild `entryPoints` map is exactly one webview bundle
and one user-facing screen. "Add a screen" therefore means "add a bundle to the
host include list **and** wire up navigation to it" — that is the human decision
this skill protects.

## The three sources of truth

| Role | File | Symbol |
|------|------|--------|
| **Canonical view set** (VS Code) | `vscode-extension/esbuild.js` | `entryPoints` keys mapping to `src/webview/<name>/main.ts` |
| **Built artifacts** | `vscode-extension/dist/webview/<name>.js` | one `.js` per view (produced by `pnpm run package`) |
| **Visual Studio host list** | `visualstudio-extension/src/AIEngineeringFluency/AIEngineeringFluency.csproj` | `_WebviewBundle Include="…\dist\webview\<name>.js"` items (`CopyWebviewBundles` target) |
| **JetBrains host list** | `jetbrains-plugin/build.gradle.kts` | `prepareBundledAssets` → `from(".../dist/webview") { include("<name>.js", …) }` |
| **Desktop app host list** | `desktop/esbuild.js` + `desktop/src/main.ts` | `WEBVIEW_BUNDLES` (copied bundles) **and** `PANEL_MENU` (tray / Go menu entries) — a view counts as shipped only when it is in both |

Run the script (see below) for the current per-host view counts and coverage —
this drifts every time a view is added or a host picks one up. Views a host
doesn't ship are intentionally excluded, not missing.

### Why nothing is committed for any host

No host commits webview bundle content to git. Each copies the compiled
bundles fresh from `vscode-extension/dist/webview` at its own build time:

- **Visual Studio** does it via the `CopyWebviewBundles` MSBuild target in
  `AIEngineeringFluency.csproj` (`BeforeTargets="Build"`), and the CI/local build
  scripts (`visualstudio-build.yml`, `visualstudio-publish.yml`, `release.yml`,
  `build.ps1`) additionally do a wholesale directory copy before MSBuild runs.
- **JetBrains** does it via `prepareBundledAssets` in `build.gradle.kts`.
- **Desktop app** does it via `copyStaticAssets` in `desktop/esbuild.js`, which
  copies each `WEBVIEW_BUNDLES` entry into `desktop/dist/webview`. On its own it
  builds the extension bundles only when they are missing, so the CI and local
  build paths (`desktop-build.yml`, `desktop-publish.yml`,
  `build.ps1 -Project desktop`) rebuild them first — in production mode for
  anything that is packaged.

This used to differ — Visual Studio committed its copies to the repo as a
"possibly stale" fallback, which drifted out of sync in practice (see
`docs/adr/VS-WEBVIEW-BUNDLE-SOURCING.md`). That fallback has been removed:
every host now works exactly like JetBrains always did, so there is nothing left
for this skill to refresh or check for staleness — only the hosts'
**include lists** (which named views each ships) can still drift from the
canonical VS Code set, and that's all this script tracks.

## What the script reports

`sync-host-views.js` classifies, per host, every canonical view as:

1. **tracked** — the host's build config lists this view.
2. **NEW** — VS Code builds it but the host does not list it. Requires a human
   decision; the script exits `3`.
3. **ORPHAN** — the host lists a view VS Code no longer builds. Mechanical drift;
   the script exits `1`.

For the desktop app it also reports half-wired views, both exit `1`:
**UNREACHABLE** (in `WEBVIEW_BUNDLES` but not `PANEL_MENU` — copied, but no menu
opens it) and **UNBUNDLED** (in `PANEL_MENU` but not `WEBVIEW_BUNDLES` — the menu
opens a blank page).

## Usage

```bash
# Detect drift and new screens (read-only). Run from the repo root.
node .github/skills/sync-host-views/sync-host-views.js

# Machine-readable output (CI / further processing).
node .github/skills/sync-host-views/sync-host-views.js --json

# Help.
node .github/skills/sync-host-views/sync-host-views.js --help
```

Build the bundles first if `dist/webview` is empty (only affects the informational
`dist/webview built` line in the report — list-drift detection works either way):

```bash
cd vscode-extension && pnpm run package
```

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | Hosts are in sync — no drift |
| `1` | Mechanical drift the agent can fix (an ORPHAN entry, or a desktop UNREACHABLE / UNBUNDLED view) |
| `2` | Configuration error (a source file was not found / a block moved) |
| `3` | **NEW views detected — stop and ask the user** (takes precedence over `1`) |

## Workflow for the agent

1. **Run the detector.**
   `node .github/skills/sync-host-views/sync-host-views.js`
2. **If exit 3 (NEW views):** do **NOT** add them automatically. Ask the user, one
   view at a time, whether each new VS Code screen should be added to Visual Studio
   and/or JetBrains. Example question: *"VS Code added a `logviewer` screen that
   no host ships. Add it to Visual Studio, JetBrains, the desktop app, several, or skip?"*
   Only after the user opts in:
   - **Visual Studio:** add `<_WebviewBundle Include="..\..\..\vscode-extension\dist\webview\<name>.js" />`
     to the `CopyWebviewBundles` target **and** a matching `<VSIXSourceItem>` entry
     to the `AddWebviewBundlesToVsix` target in `AIEngineeringFluency.csproj`, and
     wire navigation in `ToolWindow/TokenTrackerControl.xaml.cs`
     (`NavigateToViewAsync` switch) plus any toolbar/menu entry. Check
     `WebBridge/ThemedHtmlBuilder.cs` for view-specific hide rules.
   - **JetBrains:** add `"<name>.js"` to the `include(...)` list in the
     `prepareBundledAssets` task in `build.gradle.kts`, and wire navigation in the
     plugin's tool-window/host code.
   - **Desktop app:** add `'<name>.js'` to `WEBVIEW_BUNDLES` in `desktop/esbuild.js`,
     add the id to `PanelId` and `PANEL_MENU` in `desktop/src/main.ts`, build its
     payload in `buildPanelHtml`, and handle its `show*` command in
     `registerIpcHandlers`. Then run `pnpm run check:contract` in `desktop/`: every
     message the new view posts must be handled or listed in
     `desktop/src/unsupportedWebviewCommands.json`.
3. **If exit 1 due to an ORPHAN:** a host lists a view VS Code removed. Confirm the
   removal was intended, then drop the entry from the host list (the `_WebviewBundle`
   item and its `VSIXSourceItem` for Visual Studio, or the `include(...)` entry for
   JetBrains) — surface this to the user since it removes a screen.
4. **Re-run the detector** until it is clean (or only the intentional NEW views
   the user chose to skip remain).

## Sub-screens / tabs (out of automatic scope)

Some bundles contain multiple sub-screens or tabs (e.g. the chart view's
*by model* / *by editor* / *by repository* toggles, or the tables on the details
page). Those live **inside** a single bundle and stay current automatically
because the bundle is rebuilt fresh on every host build — there is no separate
include entry to add. If a host needs to hide a specific sub-screen it is done
with a CSS rule in `ThemedHtmlBuilder.cs` (Visual Studio) or the equivalent
JetBrains host HTML.

## Related files

- `vscode-extension/esbuild.js` — canonical `entryPoints` view list
- `visualstudio-extension/src/AIEngineeringFluency/AIEngineeringFluency.csproj` —
  `CopyWebviewBundles` (`_WebviewBundle` includes, fresh from dist/webview) and
  `AddWebviewBundlesToVsix` (VSIX packaging)
- `visualstudio-extension/src/AIEngineeringFluency/ToolWindow/TokenTrackerControl.xaml.cs` —
  `NavigateToViewAsync` view switch (where a new screen is wired up)
- `visualstudio-extension/src/AIEngineeringFluency/WebBridge/ThemedHtmlBuilder.cs` —
  per-view / per-sub-screen hide CSS
- `jetbrains-plugin/build.gradle.kts` — `prepareBundledAssets` webview `include(...)`
- `desktop/esbuild.js` — `WEBVIEW_BUNDLES`; `desktop/src/main.ts` — `PANEL_MENU`
- `scripts/validate-desktop-contract.js` — the desktop's per-view message contract
- `docs/adr/VS-WEBVIEW-BUNDLE-SOURCING.md` — why nothing is committed any more
- `.github/skills/validate-editor-names/` — complementary skill for editor-name parity
