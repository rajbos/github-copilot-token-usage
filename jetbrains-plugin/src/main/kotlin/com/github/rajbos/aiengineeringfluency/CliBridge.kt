package com.github.rajbos.aiengineeringfluency

import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.util.SystemInfo
import com.intellij.util.io.createDirectories
import java.io.IOException
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.util.concurrent.TimeUnit

/**
 * Spawns the bundled `copilot-token-tracker` CLI for a given view and returns
 * its JSON stdout as a string ready to splice into the webview.
 *
 * Direct port of `visualstudio-extension/.../Data/CliBridge.cs`; the JSON
 * contract on stdout is identical so the shared webview bundles consume both
 * outputs unchanged.
 *
 * The CLI is shipped inside the plugin jar as
 *   /cli-bundle/<os-id>/copilot-token-tracker[.exe]
 *   /cli-bundle/<os-id>/sql-wasm.wasm
 *
 * On first use we extract the OS-appropriate copy to the IDE's temp dir,
 * mark it executable, and re-use that path for subsequent calls.
 */
object CliBridge {

    private val log = Logger.getInstance(CliBridge::class.java)
    private const val CLI_TIMEOUT_SECONDS = 60L

    @Volatile private var cachedExePath: Path? = null

    /**
     * Runs the CLI for [view] and returns the parsed JSON string from stdout.
     *
     * @throws IllegalStateException if the OS is unsupported or the CLI
     *         binary failed to extract / execute.
     */
    @Throws(IOException::class)
    fun fetchStats(view: String): String {
        val exe = ensureExtracted()
        val cmd = listOf(exe.toString(), viewToCommand(view), "--json")

        log.info("Running CLI: ${cmd.joinToString(" ")}")
        val process = ProcessBuilder(cmd)
            .redirectErrorStream(false)
            .start()

        val finished = process.waitFor(CLI_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        if (!finished) {
            process.destroyForcibly()
            throw IOException("CLI timed out after ${CLI_TIMEOUT_SECONDS}s")
        }

        val stdout = process.inputStream.bufferedReader().use { it.readText() }
        val stderr = process.errorStream.bufferedReader().use { it.readText() }
        if (process.exitValue() != 0) {
            throw IOException("CLI exited ${process.exitValue()}: $stderr")
        }
        if (stderr.isNotBlank()) log.debug("CLI stderr: $stderr")
        return stdout.trim().ifEmpty { "{}" }
    }

    /**
     * Returns the path to the extracted CLI binary, extracting it on first use.
     * Cached for the lifetime of the IDE so repeated calls are cheap.
     */
    private fun ensureExtracted(): Path {
        cachedExePath?.let { return it }
        synchronized(this) {
            cachedExePath?.let { return it }

            val osDir = osBundleDir()
            val exeName = if (SystemInfo.isWindows) "copilot-token-tracker.exe" else "copilot-token-tracker"
            val resourcePrefix = "/cli-bundle/$osDir"

            val targetDir = Path.of(System.getProperty("java.io.tmpdir"), "ai-engineering-fluency", osDir)
            targetDir.createDirectories()

            val exePath = copyResource("$resourcePrefix/$exeName", targetDir.resolve(exeName))
            // sql-wasm.wasm sits next to the binary; loaded at runtime by the CLI.
            copyResourceIfPresent("$resourcePrefix/sql-wasm.wasm", targetDir.resolve("sql-wasm.wasm"))

            if (!SystemInfo.isWindows) {
                exePath.toFile().setExecutable(true, /* ownerOnly = */ false)
            }

            cachedExePath = exePath
            return exePath
        }
    }

    private fun copyResource(resourcePath: String, target: Path): Path {
        val stream = CliBridge::class.java.getResourceAsStream(resourcePath)
            ?: throw IllegalStateException(
                "Bundled CLI not found at classpath:$resourcePath — " +
                    "this OS may not be supported by this build of the plugin."
            )
        stream.use {
            Files.copy(it, target, StandardCopyOption.REPLACE_EXISTING)
        }
        return target
    }

    private fun copyResourceIfPresent(resourcePath: String, target: Path) {
        CliBridge::class.java.getResourceAsStream(resourcePath)?.use {
            Files.copy(it, target, StandardCopyOption.REPLACE_EXISTING)
        }
    }

    private fun osBundleDir(): String = when {
        SystemInfo.isWindows -> "win-x64"
        SystemInfo.isMac -> "darwin-x64"   // x64 binary runs on Apple Silicon under Rosetta until we ship arm64
        SystemInfo.isLinux -> "linux-x64"
        else -> throw IllegalStateException("Unsupported OS: ${SystemInfo.OS_NAME}")
    }

    /**
     * Maps the webview id to the CLI sub-command that produces its data.
     * Keep in sync with [WebviewResources.viewToGlobalKey] and the VS
     * extension's `CliBridge.cs`.
     */
    private fun viewToCommand(view: String): String = when (view) {
        "details" -> "all"
        "chart" -> "chart"
        "usage" -> "usage"
        "diagnostics" -> "all"
        "environmental" -> "all"
        "maturity" -> "fluency"
        else -> "all"
    }
}
