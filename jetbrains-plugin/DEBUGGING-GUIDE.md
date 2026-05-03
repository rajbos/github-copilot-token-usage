# Debugging the JetBrains Plugin

Mirror of [`visualstudio-extension/DEBUGGING-GUIDE.md`](../visualstudio-extension/DEBUGGING-GUIDE.md),
adapted for the IntelliJ Platform sandbox model.

## Quick start

```powershell
cd jetbrains-plugin
./gradlew runIde            # sandbox IDE launches with the plugin pre-installed
```

A second JetBrains IDE window appears with `[Sandbox]` (or similar) in the
title bar. Use it exactly like a regular IDE — the sandbox's settings,
caches, and recent projects live in `build/idea-sandbox/` and are wiped on
`./gradlew clean`.

To open the AI Engineering Fluency tool window:

* `View → Tool Windows → AI Engineering Fluency`
* Or click the icon in the right side bar.

## Attaching a debugger

```powershell
./gradlew runIde --debug-jvm
```

The sandbox IDE pauses on startup waiting for a debugger on port `5005`.
In IntelliJ IDEA (the *outer* one you use for plugin development):

1. `Run → Edit Configurations… → + → Remote JVM Debug`
2. Host `localhost`, port `5005`, leave defaults.
3. Set breakpoints in `TokenTrackerPanel.kt` / `CliBridge.kt` and start
   the debug configuration. Execution resumes once attached.

## Where to look for logs

| Source                         | Location                                                      |
| ------------------------------ | ------------------------------------------------------------- |
| Plugin `Logger.getInstance(…)` | `build/idea-sandbox/system/log/idea.log` (filter by `CliBridge` / `TokenTrackerPanel`) |
| JCEF / browser console         | Right-click the panel → *Open DevTools* (only in sandbox IDEs); or set `ide.browser.jcef.debug.port=9222` and open `chrome://inspect` |
| CLI stdout/stderr              | Captured by `CliBridge.fetchStats(...)` — failures surface as the inline error overlay; raw stderr is logged at `DEBUG` level |

To enable plugin DEBUG logging, in the sandbox IDE:

1. `Help → Diagnostic Tools → Debug Log Settings…`
2. Add: `com.github.rajbos.aiengineeringfluency`

## Common issues

### "Tool window is missing entirely"

The factory's `shouldBeAvailable` requires `JBCefApp.isSupported()`. If JCEF
isn't bundled with the JBR shipped by your IDE (rare on 2024.3+), the tool
window is hidden by design. Switch to a JetBrains-bundled JBR via
`Help → Find Action → Choose Boot Java Runtime for the IDE`.

### "Bundled CLI not found at classpath:/cli-bundle/…"

The plugin shipped without a CLI binary for your OS. Two paths:

* **Build it locally**: rebuild the CLI for your OS (`pwsh cli/bundle-exe.ps1`
  on Windows; macOS/Linux variants are tracked work in `cli/`), then re-run
  `./gradlew buildPlugin`. The `prepareBundledAssets` task picks up whatever
  is in `cli/dist/` and copies it into the plugin resources.
* **Verify the resource is there**: unzip
  `build/distributions/ai-engineering-fluency-*.zip` and look for
  `lib/<jar>!/cli-bundle/<os>/copilot-token-tracker[.exe]`.

### "Webview shows a blank screen"

Almost always one of:

1. The bundle file is missing — check `build/idea-sandbox/.../<plugin>/lib/<jar>!/webview/<view>.js`
2. The bundle threw on load — open DevTools (see logs section above) and
   check the JS console.
3. The CLI returned malformed JSON — turn on DEBUG logging for the plugin
   namespace and re-trigger the panel; the raw stdout is logged.

### "The view shows up but the chart is empty"

Almost always: the CLI is running fine but found no Copilot session files
for the user, or all sessions are older than 30 days. Use Copilot Chat in
any IDE for a few minutes and reopen the panel.

## Iterating quickly

`./gradlew runIde` rebuilds the plugin on every launch but spawns a fresh
JVM. For tighter loops:

* **Code-only change** in the Kotlin host shell → `./gradlew runIde` again.
* **Webview JS change** in `vscode-extension/` → rebuild bundles, then
  re-run; or use the VS Code extension dev loop and only switch to
  `runIde` for final cross-IDE validation.
* **CLI logic change** in `cli/` → rebuild the binary (`pwsh cli/bundle-exe.ps1`),
  then re-run.

The root `build.ps1 -Project jetbrains` does all three rebuilds in one shot.

## Verifying API compatibility

```powershell
./gradlew verifyPlugin
```

Runs the JetBrains Marketplace verifier against the IDE versions configured
in `build.gradle.kts`. Catches accidental use of internal/experimental APIs
that would break the plugin in some IDEs in the family.
