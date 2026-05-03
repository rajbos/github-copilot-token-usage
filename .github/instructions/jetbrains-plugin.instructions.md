---
applyTo: "jetbrains-plugin/**"
---

# JetBrains Plugin — Coding Agent Instructions

This sub-project is a Kotlin / IntelliJ Platform plugin that mirrors the
architecture of `visualstudio-extension/`: a thin host shell that reuses the
webview bundles from `vscode-extension/` and the CLI binary from `cli/`.

## Hard rules

* **Do not duplicate UI logic.** Anything visual belongs in the shared
  webview bundles (`vscode-extension/src/webview/...`). The Kotlin code is
  only allowed to host the bundle, push stats into it, and react to
  `postMessage` events coming back.
* **Do not modify `vscode-shim.js` from this project.** The shim lives in
  `visualstudio-extension/src/CopilotTokenTracker/WebBridge/vscode-shim.js`
  and is shared. Changes there must keep both extensions working.
* **Do not break the JSON contract** between `CliBridge` and the webview
  bundles. The CLI commands and their `--json` shape are the integration
  point — kept identical to the VS extension's `Data/CliBridge.cs`.
* **Stay in `com.intellij.modules.platform`.** Adding any IDE-specific
  module (e.g. `com.intellij.java`) breaks installation in the rest of the
  JetBrains family. If you need a feature that's only in some IDEs, gate
  it via `PluginId.findId(...)` at runtime.
* **Never commit bundled assets.** The `webview/*.js`, `vscode-shim.js`,
  and `cli-bundle/**` files are reproduced by the build (`prepareBundledAssets`
  task). They are gitignored on purpose.

## Build & test commands

```powershell
# Full pipeline (rebuilds vscode webviews + CLI + plugin zip)
../build.ps1 -Project jetbrains

# Plugin-only commands
./gradlew buildPlugin     # produces build/distributions/*.zip
./gradlew runIde          # sandbox IDE for manual testing
./gradlew test            # JUnit 5 tests
./gradlew verifyPlugin    # marketplace API-compatibility verifier
```

`./gradlew` requires JDK 21+ on `PATH`. Gradle itself is downloaded by the
wrapper on first run; do not commit a global Gradle config.

## Coding style

* Kotlin 2.x, idiomatic Kotlin (no Java-style getters/setters).
* Use `Logger.getInstance(SomeClass::class.java)` (or `thisLogger()`) for
  logging — never `println`.
* Long-running work (CLI spawn, file I/O) goes on
  `ApplicationManager.getApplication().executeOnPooledThread { }`. UI
  updates back on `invokeLater { }`.
* JCEF interop is single-threaded on the EDT; never call
  `executeJavaScript` from a pooled thread.

## Testing

* Unit tests live in `src/test/kotlin/...` and use the IntelliJ Platform
  test framework + JUnit 5.
* Integration tests that need a real JCEF browser belong in headed
  `runIde` sessions, not in the JUnit suite.
