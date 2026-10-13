# AI Engineering Fluency — Windows Desktop App

A lightweight Electron tray app that surfaces the same dashboards as the VS Code
extension (Details, Environmental Impact, Token Usage Chart, Efficiency, Usage Analysis,
Fluency Score, Scoring Guide, Diagnostics) outside of VS Code.

## Install

Download `AI-Engineering-Fluency-Setup-<version>.exe` from the newest
**Desktop App** release on the
[releases page](https://github.com/rajbos/ai-engineering-fluency/releases) and
run it. Windows x64 only for now.

The installer is not code-signed, so Windows SmartScreen shows "Windows
protected your PC" on first run — choose **More info → Run anyway**.

The app lives in the system tray. It checks for a new version shortly after
launch and every six hours, downloads it in the background, and offers
**Restart to install** in the tray menu (it also installs on the next quit).
**Check for updates** in the same menu checks on demand.

## How it works

The desktop app does **not** reimplement the UI. It reuses the existing
artifacts from the other packages in this repo:

- **Webview bundles** — the IIFE panel bundles are copied from
  `../vscode-extension/dist/webview/` at build time (see
  [`esbuild.js`](esbuild.js) → `copyStaticAssets`). Each bundle already includes
  the `vscode-elements` web components it uses, so no separate toolkit is loaded.
- **Stats logic** — `src/main.ts` imports session discovery and stat
  calculations directly from `../cli/src/helpers` and
  `../vscode-extension/src/`.

`src/preload.ts` exposes an `acquireVsCodeApi()` shim so the unmodified webview
bundles run without changes — `postMessage` is routed to the main process over
IPC. Panels are served from an in-process `app://` protocol handler rather than
from disk.

## Build

```sh
pnpm install
pnpm run build
```

The desktop build depends on the extension's webview bundles
(`../vscode-extension/dist/webview/*.js`). If those are missing, `esbuild.js`
builds the extension automatically before continuing, so a fresh checkout works
with a single `pnpm run build`.

That auto-build requires the extension's dependencies to be installed. If it
cannot complete it fails with a clear error rather than silently producing an app
with blank panels — in that case build the extension manually first:

```sh
cd ../vscode-extension && pnpm install && pnpm run compile
```

## Scripts

| Script                  | Purpose                                                        |
| ----------------------- | -------------------------------------------------------------- |
| `pnpm run build`         | Development bundle (sourcemaps, no minify) → `dist/`.          |
| `pnpm run build:production` | Production bundle (minified).                               |
| `pnpm run dev`           | Watch mode: rebuild on change and relaunch Electron.           |
| `pnpm start`             | Build then launch Electron once.                               |
| `pnpm run pack`          | Production build + `electron-builder --dir` (unpacked app).    |
| `pnpm run dist`          | Production build + NSIS installer → `release/` (never publishes). |
| `pnpm run check-types`   | `tsc --noEmit`. See the caveat below.                          |

In development the app writes its Electron profile to `.dev-profile/` (kept out
of `%APPDATA%` so hot-reload restarts don't fight over a shared, locked cache).
`.dev-profile/`, the Electron logs, and `release/` are all git-ignored.

## Packaging

Installer config lives under `build` in [`package.json`](package.json).
Installers are written to `release/` (separate from the esbuild `dist/` output so
they are never re-packaged into the next build). Target: NSIS (x64).

## Releasing

1. Bump `version` in `package.json` (and `pnpm-lock.yaml`) and merge that.
2. Tag the merge commit `desktop/v<version>` and push the tag.

[`desktop-publish.yml`](../.github/workflows/desktop-publish.yml) then builds
the installer, creates the **Desktop App v<version>** release, and updates the
auto-update feed. Running that workflow manually builds the installer as a
workflow artifact without releasing anything.

### Why the update feed is a separate release

`electron-updater`'s GitHub provider reads `latest.yml` from the repository's
"latest release". This repo ships several products, so that is usually a VS Code
extension, CLI or JetBrains release with no `latest.yml` in it. The app
therefore uses the `generic` provider against a fixed URL: the rolling
`desktop-latest` release, which holds a single `latest.yml` whose download URLs
point at the installer in the versioned release. Do not delete that release or
tag — installed apps stop finding updates without it.

## Icons

`assets/icon.png` (512×512) is the installer/window icon — electron-builder
derives the multi-resolution `.ico` from it. `assets/tray-icon.png` (256×256) is
the system tray icon, copied into `dist/` at build time so it ships with the
packaged app. Both are cropped from the shared 645×645 brand logo
(`../visualstudio-extension/src/AIEngineeringFluency/assets/logo.png`) and can be
regenerated with:

```sh
npx electron scripts/generate-icon.js
```

## Type checking

`pnpm run check-types` (`tsc --noEmit`) is a real, passing gate on the desktop
app's own TypeScript. `tsconfig.json` lists only `src/**/*.ts` as inputs and lets
`tsc` follow the actual import graph into `../cli` and `../vscode-extension`, so
those sibling sources are checked exactly as the desktop app consumes them — not
by globbing whole sibling trees (which previously dragged in unrelated CLI
command/test files with their own dependencies and pre-existing errors). `DOM` is
added to `lib` because some transitively-imported webview helpers (e.g.
`shared/dataLoader`) reference `window`.

Run it from `desktop/` after installing dependencies in the sibling packages so
their types (`chalk`, `sql.js`, `@types/node`) resolve:

```sh
(cd ../cli && pnpm install)
(cd ../vscode-extension && pnpm install)
pnpm install
pnpm run check-types
```

The authoritative build gate remains `pnpm run build` (esbuild, which follows only
the real import graph). `check-types` is the stricter companion that also reports
type errors in every file it touches.
