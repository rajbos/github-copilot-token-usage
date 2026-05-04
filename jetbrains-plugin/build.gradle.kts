// AI Engineering Fluency — JetBrains plugin build script.
//
// Mirrors the architecture of the Visual Studio extension (visualstudio-extension/):
//   * shells out to the bundled CLI (cli/) for stats
//   * hosts the same compiled webview JS bundles as the VS Code extension
//   * injects the same vscode-shim.js so the bundles run unchanged
//
// Webview bundles, the shim, and the CLI binaries are produced by other
// projects in this monorepo and copied into src/main/resources/ by the
// `prepareBundledAssets` task below (or by the root build.ps1 orchestrator).

import org.jetbrains.intellij.platform.gradle.TestFrameworkType

plugins {
    kotlin("jvm") version "2.3.21"
    id("org.jetbrains.intellij.platform") version "2.16.0"
}

group = providers.gradleProperty("pluginGroup").get()
version = providers.gradleProperty("pluginVersion").get()

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

kotlin {
    jvmToolchain(21)
}

dependencies {
    intellijPlatform {
        // IntelliJ IDEA Community is the smallest base that bundles JCEF.
        // The resulting plugin also installs into Rider, PyCharm, WebStorm,
        // GoLand, RubyMine, CLion, and the rest of the family because we only
        // use `com.intellij.modules.platform` APIs (see plugin.xml).
        create(
            providers.gradleProperty("platformType").get(),
            providers.gradleProperty("platformVersion").get(),
        )

        // Test fixtures (IntelliJ Platform test framework + JUnit 5).
        testFramework(TestFrameworkType.Platform)
    }

    testImplementation(platform("org.junit:junit-bom:6.0.3"))
    testImplementation("org.junit.jupiter:junit-jupiter")
    testImplementation("org.opentest4j:opentest4j:1.3.0")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

intellijPlatform {
    pluginConfiguration {
        version = providers.gradleProperty("pluginVersion")
        ideaVersion {
            sinceBuild = providers.gradleProperty("pluginSinceBuild")
            untilBuild = providers.provider { null } // open-ended; safer for cross-IDE compatibility
        }
    }

    // Marketplace publishing token comes from the env at publish time.
    publishing {
        token = providers.environmentVariable("PUBLISH_TOKEN")
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Bundled assets task
//
// Copies the prebuilt artefacts produced by the other monorepo projects into
// the resources directory so they end up on the plugin classpath:
//
//   vscode-extension/dist/webview/*.js                  -> resources/webview/
//   visualstudio-extension/.../vscode-shim.js           -> resources/webview/
//   cli/dist/copilot-token-tracker.exe (+ sql-wasm.wasm) -> resources/cli-bundle/win-x64/
//   cli/dist/copilot-token-tracker-macos                -> resources/cli-bundle/darwin-x64/
//   cli/dist/copilot-token-tracker-linux                -> resources/cli-bundle/linux-x64/
//
// The macOS/Linux binaries are produced by an extended bundle-exe script (see
// jetbrains-plugin/README.md). Missing files are tolerated so the plugin can
// still build with only the OS bundles that are currently available — at
// runtime CliBridge surfaces a clear error if the user's OS isn't covered.
// ─────────────────────────────────────────────────────────────────────────────

val prepareBundledAssets by tasks.registering(Copy::class) {
    description = "Copy webview bundles, vscode-shim, and CLI binaries into plugin resources."
    group = "build"

    val repoRoot = rootProject.projectDir.parentFile

    // 1. Webview JS bundles produced by `npm run compile` in vscode-extension/.
    from("$repoRoot/vscode-extension/dist/webview") {
        include("details.js", "chart.js", "usage.js", "diagnostics.js", "environmental.js", "maturity.js")
        into("webview")
    }

    // 2. The vscode-shim that fakes acquireVsCodeApi() — same file the VS extension uses.
    from("$repoRoot/visualstudio-extension/src/CopilotTokenTracker/WebBridge") {
        include("vscode-shim.js")
        into("webview")
    }

    // 3. CLI binaries per OS. Each block silently skips if the file is missing,
    //    so partial builds (e.g. Windows-only on a dev machine) still succeed.
    from("$repoRoot/cli/dist") {
        include("copilot-token-tracker.exe", "sql-wasm.wasm")
        into("cli-bundle/win-x64")
    }
    from("$repoRoot/cli/dist") {
        include("copilot-token-tracker-macos", "sql-wasm.wasm")
        rename("copilot-token-tracker-macos", "copilot-token-tracker")
        into("cli-bundle/darwin-x64")
    }
    from("$repoRoot/cli/dist") {
        include("copilot-token-tracker-linux", "sql-wasm.wasm")
        rename("copilot-token-tracker-linux", "copilot-token-tracker")
        into("cli-bundle/linux-x64")
    }

    into(layout.buildDirectory.dir("bundled-assets"))
}

sourceSets {
    main {
        resources {
            srcDir(prepareBundledAssets)
        }
    }
}

tasks {
    processResources {
        dependsOn(prepareBundledAssets)
        // Multiple OS folders may contain a sql-wasm.wasm — that's intentional.
        duplicatesStrategy = DuplicatesStrategy.INCLUDE
    }

    test {
        useJUnitPlatform()
    }

    // `runIde` is contributed by the IntelliJ Platform plugin; no extra wiring needed.
    // `buildPlugin` produces build/distributions/<name>-<version>.zip.
}
