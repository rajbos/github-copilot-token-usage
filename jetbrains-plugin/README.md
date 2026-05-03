# AI Engineering Fluency — JetBrains Plugin

A JetBrains IDE plugin that surfaces your GitHub Copilot token usage and AI
engineering fluency directly inside any IntelliJ-based IDE (IDEA, Rider,
PyCharm, WebStorm, GoLand, RubyMine, CLion, …).

It is the JetBrains-side companion to the
[VS Code extension](../vscode-extension/) and
[Visual Studio extension](../visualstudio-extension/) and is built as a thin
shell over the same shared assets:

| Reused from sibling project              | What it gives us                    |
| ---------------------------------------- | ----------------------------------- |
| `vscode-extension/dist/webview/*.js`     | the actual UI (charts, usage, …)    |
| `visualstudio-extension/.../vscode-shim.js` | `acquireVsCodeApi()` shim          |
| `cli/dist/copilot-token-tracker[.exe]`   | stats engine (per-OS native binary) |

The plugin itself is ~5 small Kotlin files: a `ToolWindowFactory`, a JCEF
panel, a CLI bridge, an HTML builder, and the `plugin.xml` descriptor.

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│ JetBrains IDE (any flavour, 2024.3+)                                 │
│ ┌──────────────────────────────────────────────────────────────────┐ │
│ │ Tool Window  ── TokenTrackerToolWindowFactory ──> TokenTrackerPanel│
│ │                                                       │            │
│ │                          ┌────────────────────────────┘            │
│ │                          ▼                                         │
│ │  ┌───────────────────────────────────────────────────────────┐     │
│ │  │ JBCefBrowser (JCEF)                                       │     │
│ │  │   <script>vscode-shim.js</script>                         │     │
│ │  │   <script>webview/<view>.js</script>  ◀── reused bundles  │     │
│ │  └───────────────────────────────────────────────────────────┘     │
│ │             ▲                          │                           │
│ │             │ executeJavaScript        │ JBCefJSQuery              │
│ │             │ (host → webview)         ▼ (webview → host)          │
│ │  ┌───────────────────────────────────────────────────────────┐     │
│ │  │ CliBridge.kt: spawns bundled CLI, returns JSON            │     │
│ │  └───────────────────────────────────────────────────────────┘     │
│ │             │                                                      │
│ └─────────────┼──────────────────────────────────────────────────────┘
│               ▼
│  copilot-token-tracker[.exe]   ◀── extracted from /cli-bundle/<os>/  │
└──────────────────────────────────────────────────────────────────────┘
```

## Prerequisites

| Tool      | Version    | Notes                                                   |
| --------- | ---------- | ------------------------------------------------------- |
| JDK       | **21+**    | Microsoft OpenJDK or any other distro. Wrapper handles Gradle for you. |
| Node.js   | 22+        | Only needed to rebuild the webview bundles + CLI binary |
| PowerShell| 7+         | Only needed if you use the root `build.ps1` orchestrator |

Java is the **only** mandatory tool — the included `gradlew` / `gradlew.bat`
wrapper downloads Gradle on first run.

## Building from the command line

The plugin does **not** build its bundled assets itself; it copies them from
the sibling projects. So a complete build is two steps:

```powershell
# 1. From the repo root: rebuild the webview bundles + CLI binaries.
./build.ps1 -Project vscode    # produces vscode-extension/dist/webview/*.js
./build.ps1 -Project cli       # produces cli/dist/copilot-token-tracker.exe (+ sql-wasm.wasm)

# 2. Build the plugin zip.
cd jetbrains-plugin
./gradlew buildPlugin          # output: build/distributions/ai-engineering-fluency-<ver>.zip
```

Or, equivalently, use the orchestrator:

```powershell
./build.ps1 -Project jetbrains
```

### macOS / Linux CLI binaries

Out of the box `cli/bundle-exe.ps1` only produces the Windows `.exe`. To
ship a fully cross-platform plugin, the bundle script must be extended to
also emit:

* `cli/dist/copilot-token-tracker-macos`
* `cli/dist/copilot-token-tracker-linux`

These are produced via Node SEA + `postject` against the matching Node
binary downloads. CI is the natural place to do this (one job per OS,
artifacts uploaded into the plugin resources). Until then, the Gradle build
silently omits the missing binaries and the plugin only works on Windows.

## Running and debugging

The IntelliJ Platform Gradle plugin contributes a `runIde` task that
launches a sandboxed IDE with the plugin loaded — the equivalent of Visual
Studio's `/rootsuffix Exp` experimental hive.

```powershell
cd jetbrains-plugin

# Launch a sandbox IDE with this plugin installed
./gradlew runIde

# Same, but pause the JVM until a debugger attaches on port 5005
./gradlew runIde --debug-jvm

# Run plugin unit tests
./gradlew test

# Run the marketplace verifier (catches API compatibility issues across IDE versions)
./gradlew verifyPlugin

# Produce the installable .zip
./gradlew buildPlugin
```

See [`DEBUGGING-GUIDE.md`](./DEBUGGING-GUIDE.md) for log locations, common
JCEF gotchas, and how to attach IntelliJ IDEA as a debugger.

## Project layout

```
jetbrains-plugin/
├── build.gradle.kts            ← Gradle build (Kotlin DSL, IntelliJ Platform plugin v2)
├── settings.gradle.kts
├── gradle.properties           ← plugin id / version / IDE target
├── gradlew, gradlew.bat        ← Gradle wrapper (no global Gradle install needed)
├── gradle/wrapper/
└── src/main/
    ├── kotlin/com/github/rajbos/aiengineeringfluency/
    │   ├── TokenTrackerToolWindowFactory.kt   ← registers the side-bar tool window
    │   ├── TokenTrackerPanel.kt               ← JCEF host + message bridge
    │   ├── CliBridge.kt                       ← spawns the bundled CLI
    │   └── WebviewResources.kt                ← builds the host HTML
    └── resources/
        ├── META-INF/plugin.xml                ← extension descriptor
        ├── webview/                           ← copied from vscode-extension at build time
        └── cli-bundle/<os-id>/                ← copied from cli/dist at build time
```

## Plugin metadata

| Field    | Value                                          |
| -------- | ---------------------------------------------- |
| Id       | `com.github.rajbos.ai-engineering-fluency`     |
| Name     | AI Engineering Fluency                         |
| Vendor   | rajbos                                         |
| Min IDE  | 2024.3 (build `243`)                           |
| Type     | IntelliJ Platform plugin (single artifact, all IDEs) |

The plugin id is changeable until the first JetBrains Marketplace upload;
after that it becomes the permanent unique identifier.
