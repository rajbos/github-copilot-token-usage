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
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.provider.Property
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.OutputDirectory
import org.gradle.api.tasks.TaskAction

plugins {
    // Pinned below CodeQL's current Kotlin version ceiling: the CodeQL analysis
    // job fails on 2.4.20 with "Kotlin version 2.4.20 is too recent". Keep the
    // last known-good Kotlin line until CodeQL adds support for 2.4.20+.
    kotlin("jvm") version "2.4.20"
    id("org.jetbrains.intellij.platform") version "2.19.0"
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
    compilerOptions {
        // Generate real JVM default methods instead of delegating bridges in
        // implementing classes. Without this, every Kotlin class implementing a
        // Java interface with default methods (e.g. ToolWindowFactory) emits
        // explicit calls to those defaults — which the Marketplace verifier
        // counts as usages of deprecated/experimental platform APIs.
        freeCompilerArgs.add("-Xjvm-default=all")
    }
}

dependencies {
    intellijPlatform {
        val targetPlatformVersion = providers.gradleProperty("platformVersion").get()

        // IntelliJ IDEA Community is the smallest base that bundles JCEF.
        // The resulting plugin also installs into Rider, PyCharm, WebStorm,
        // GoLand, RubyMine, CLion, and the rest of the family because we only
        // use `com.intellij.modules.platform` APIs (see plugin.xml).
        create(
            providers.gradleProperty("platformType").get(),
            providers.gradleProperty("platformVersion").get(),
        )

        // Starting with IntelliJ Platform 2026.2, JCEF is exposed through its
        // own bundled plugin and must be present on the compile classpath.
        if (targetPlatformVersion.startsWith("2026.")) {
            bundledPlugin("com.intellij.modules.jcef")
        }

        // Test fixtures (IntelliJ Platform test framework + JUnit 5).
        testFramework(TestFrameworkType.Platform)
    }

    testImplementation(platform("org.junit:junit-bom:6.1.3"))
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
//   vscode-extension/dist/webview/*.js                      -> resources/webview/
//   visualstudio-extension/.../vscode-shim.js               -> resources/webview/
//   cli/dist/copilot-token-tracker.exe (+ sql-wasm.wasm)    -> resources/cli-bundle/win-x64/
//   cli/dist/copilot-token-tracker-macos-arm64              -> resources/cli-bundle/darwin-arm64/
//   cli/dist/copilot-token-tracker-macos-x64                -> resources/cli-bundle/darwin-x64/
//   cli/dist/copilot-token-tracker-linux                    -> resources/cli-bundle/linux-x64/
//
// The macOS/Linux binaries are produced by the CI pipeline (see jetbrains-publish.yml).
// Missing files are tolerated so the plugin can still build with only the OS bundles
// that are currently available — at runtime CliBridge surfaces a clear error if the
// user's OS isn't covered.
// ─────────────────────────────────────────────────────────────────────────────

// Writes the plugin version into a classpath resource so runtime code can read
// it without touching PluginManagerCore (flagged as internal API by the
// Marketplace verifier). A typed task keeps this configuration-cache safe.
abstract class GenerateVersionFileTask : DefaultTask() {
    @get:Input
    abstract val pluginVersion: Property<String>

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    @TaskAction
    fun generate() {
        val dir = outputDir.get().asFile
        dir.mkdirs()
        dir.resolve("plugin-version.txt").writeText(pluginVersion.get())
    }
}

val generatePluginVersionFile by tasks.registering(GenerateVersionFileTask::class) {
    pluginVersion.set(providers.gradleProperty("pluginVersion"))
    outputDir.set(layout.buildDirectory.dir("generated/plugin-version"))
}

val prepareBundledAssets by tasks.registering(Copy::class) {
    description = "Copy webview bundles, vscode-shim, and CLI binaries into plugin resources."
    group = "build"

    val repoRoot = rootProject.projectDir.parentFile

    // 1. Webview JS bundles produced by `npm run compile` in vscode-extension/.
    from("$repoRoot/vscode-extension/dist/webview") {
        include(
            "details.js", "chart.js", "usage.js", "diagnostics.js", "environmental.js", "maturity.js",
            "fluency-level-viewer.js",
            // Resolved webview string dictionaries, one per shipped locale. The bundles
            // only localize themselves if the host puts one in the panel payload, and
            // this plugin is Kotlin so it cannot build one from package.nls*.json itself.
            // esbuild writes these next to the bundles for exactly this reason.
            "localization.en.json", "localization.zh-cn.json",
        )
        into("webview")
    }

    // 1b. The Scoring Guide (fluency-level-viewer) reads its rubric straight from the shared
    //     source JSON; unlike the compiled bundles above it is not needed by the VS Code
    //     webviews at runtime, so esbuild does not stage it in dist/webview/ — copy it from
    //     src/ instead, alongside the bundles so WebviewResources can load it the same way
    //     (classpath resource under /webview/).
    from("$repoRoot/src") {
        include("fluencyLevelData.json")
        into("webview")
    }

    // 2. The vscode-shim that fakes acquireVsCodeApi() — same file the VS extension uses.
    from("$repoRoot/visualstudio-extension/src/AIEngineeringFluency/WebBridge") {
        include("vscode-shim.js")
        into("webview")
    }

    // 3. CLI binaries per OS. Each block silently skips if the file is missing,
    //    so partial builds (e.g. Windows-only on a dev machine) still succeed.
    from("$repoRoot/cli/dist") {
        include("copilot-token-tracker.exe", "sql-wasm.wasm")
        into("cli-bundle/win-x64")
    }
    // ARM64 macOS binary — built on an ARM64 runner (macos-15) by CI.
    from("$repoRoot/cli/dist") {
        include("copilot-token-tracker-macos-arm64", "sql-wasm.wasm")
        rename("copilot-token-tracker-macos-arm64", "copilot-token-tracker")
        into("cli-bundle/darwin-arm64")
    }
    // Intel x64 macOS binary — built on an x64 runner (macos-13) by CI.
    from("$repoRoot/cli/dist") {
        include("copilot-token-tracker-macos-x64", "sql-wasm.wasm")
        rename("copilot-token-tracker-macos-x64", "copilot-token-tracker")
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
            srcDir(generatePluginVersionFile)
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
