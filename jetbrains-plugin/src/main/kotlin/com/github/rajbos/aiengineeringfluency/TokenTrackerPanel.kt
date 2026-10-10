package com.github.rajbos.aiengineeringfluency

import com.intellij.ide.BrowserUtil
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.thisLogger
import com.intellij.openapi.project.Project
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefBrowserBase
import com.intellij.ui.jcef.JBCefJSQuery
import javax.swing.JComponent

/**
 * Methodology links the environmental view may ask to open, by id. Mirrors
 * `ENVIRONMENTAL_METHODOLOGY_SOURCES` in `src/environmentalImpact.ts`;
 * `environmentalImpact.test.ts` fails if the two drift apart.
 */
private val ENVIRONMENTAL_METHODOLOGY_SOURCES = mapOf(
    "paper" to "https://arxiv.org/abs/2505.09598",
    "neuland" to "https://github.com/neuland/tokendashboard-backend/blob/main/docs/co2-methodology.md",
)

/**
 * Hosts a single JCEF browser that renders one of the compiled webview bundles
 * shipped inside the plugin (`/webview/{view}.js`).
 *
 * Bridge model:
 *   webview JS  --(window.chrome.webview.postMessage / acquireVsCodeApi)-->  Kotlin
 *   Kotlin      --(executeJavaScript: window.postMessage(...))-->            webview JS
 *
 * This is intentionally identical to the WebView2 model used by the Visual
 * Studio extension so the same `vscode-shim.js` works without modification.
 *
 * The browser starts up showing the "details" view; future iterations will
 * surface a view picker matching the VS Code/VS extensions.
 */
class TokenTrackerPanel(
    private val project: Project,
    initialView: String = "details",
) : Disposable {

    private val log = thisLogger()
    private val browser: JBCefBrowser = JBCefBrowser()
    @Volatile private var initialLoadDone = false
    @Volatile private var currentView: String = initialView
    @Volatile private var currentChartPeriod: String = "day"

    /**
     * `JBCefJSQuery` is the JCEF-side equivalent of WebView2's
     * `WebMessageReceived` handler. We expose it to JS as the function
     * `window.__jbCefHostPost(payloadString)` via vscode-shim.js (see
     * the small bootstrap snippet appended to the shim below).
     */
    private val hostBridge: JBCefJSQuery = JBCefJSQuery.create(browser as JBCefBrowserBase)

    val component: JComponent get() = browser.component

    init {
        hostBridge.addHandler { rawMessage ->
            handleWebviewMessage(rawMessage)
            null
        }

        // Show spinner immediately, then kick off a background prefetch of ALL
        // CLI data (all --json + fluency --json in parallel). Once both are cached,
        // load the initial view with data pre-embedded — no second load needed.
        initialLoadDone = true // prevent onLoadEnd from triggering a redundant fetch
        browser.loadHTML(WebviewResources.buildHtml(currentView, hostBridgeInjectFunction = hostBridge.inject("payload")))
        prefetchAndLoadView(currentView)
    }

    /**
     * Prefetches all CLI data (all --json + fluency --json in parallel) on a
     * background thread, then reloads [view] with the data pre-embedded.
     * Subsequent navigations use the warm cache — no spinner needed.
     *
     * [onSuccess] is invoked on the EDT after a successful fetch, before loading the view.
     * [onFailure] is invoked on the EDT after a failed fetch, before showing the error.
     * Use these for cleanup such as persisting or resetting a timeout override.
     */
    private fun prefetchAndLoadView(
        view: String,
        onSuccess: (() -> Unit)? = null,
        onFailure: (() -> Unit)? = null,
    ) {
        ApplicationManager.getApplication().executeOnPooledThread {
            val result = runCatching { CliBridge.prefetchAll() }
            ApplicationManager.getApplication().invokeLater {
                result.fold(
                    onSuccess = {
                        onSuccess?.invoke()
                        // Cache is now warm — load the current view with data embedded
                        loadViewFromCache(currentView)
                    },
                    onFailure = { err ->
                        onFailure?.invoke()
                        log.warn("CLI prefetch failed", err)
                        showError(err.message ?: "Unknown error fetching stats")
                    },
                )
            }
        }
    }

    /**
     * Loads [view] HTML with data from cache pre-embedded. Cache must be warm.
     */
    private fun loadViewFromCache(view: String) {
        val result = runCatching {
            if (view == "fluency-level-viewer") {
                return@runCatching buildFluencyLevelJson()
            }
            val json = CliBridge.fetchStats(view)
            val jsonKey = CliBridge.viewToAllJsonKey(view)
            var initialJson = if (jsonKey != null) extractJsonKey(json, jsonKey) else json
            // For the chart view, inject the stored period preference so the chart
            // opens on the last-selected period rather than defaulting to "day"
            if (view == "chart" && currentChartPeriod != "day") {
                val trimmed = initialJson.trimEnd()
                if (trimmed.endsWith("}")) {
                    initialJson = trimmed.dropLast(1) + ",\"initialPeriod\":\"${currentChartPeriod}\"}"
                }
            }
            injectSettings(initialJson)
        }
        result.fold(
            onSuccess = { initialJson ->
                browser.loadHTML(
                    WebviewResources.buildHtml(
                        view,
                        hostBridgeInjectFunction = hostBridge.inject("payload"),
                        initialStatsJson = initialJson,
                    )
                )
            },
            onFailure = { err ->
                log.warn("Failed to load view $view from cache", err)
                showError(err.message ?: "Unknown error")
            },
        )
    }

    /**
     * Triggers a CLI run on a background thread and pushes the result into the
     * webview when complete. Invalidates the cache first so fresh data is fetched.
     * Errors are surfaced as an inline error overlay.
     */
    private fun refreshStatsAsync() {
        CliBridge.invalidateCache()
        val view = currentView
        ApplicationManager.getApplication().executeOnPooledThread {
            val result = runCatching { CliBridge.prefetchAll() }
            ApplicationManager.getApplication().invokeLater {
                result.fold(
                    onSuccess = {
                        val statsResult = runCatching {
                            if (view == "fluency-level-viewer") {
                                return@runCatching buildFluencyLevelJson()
                            }
                            val json = CliBridge.fetchStats(view)
                            val jsonKey = CliBridge.viewToAllJsonKey(view)
                            if (jsonKey != null) extractJsonKey(json, jsonKey) else json
                        }
                        statsResult.fold(
                            onSuccess = { json -> pushStatsToWebview(json) },
                            onFailure = { err ->
                                log.warn("CLI stats push failed", err)
                                showError(err.message ?: "Unknown error fetching stats")
                            },
                        )
                    },
                    onFailure = { err ->
                        log.warn("CLI refresh failed", err)
                        showError(err.message ?: "Unknown error fetching stats")
                    },
                )
            }
        }
    }

    private fun pushStatsToWebview(statsJson: String) {
        val view = currentView
        log.info("Pushing stats to webview: ${statsJson.length} chars, globalKey=${WebviewResources.viewToGlobalKey(view)}")
        val globalKey = WebviewResources.viewToGlobalKey(view)
        // statsJson is already the extracted view sub-object (done by refreshStatsAsync before calling here)
        val statsJsonWithSettings = injectSettings(statsJson)
        val escapedJson = statsJsonWithSettings
            .replace("\\", "\\\\")
            .replace("'", "\\'")
            .replace("\n", "\\n")
            .replace("\r", "\\r")
        val js = """
            (function() {
                try {
                    var data = JSON.parse('$escapedJson');
                    window.$globalKey = data;
                    // Hide loading overlay, show the data root
                    var overlay = document.getElementById('loading-overlay');
                    if (overlay) overlay.style.display = 'none';
                    var root = document.getElementById('root');
                    if (root) root.style.display = 'block';
                    window.dispatchEvent(new MessageEvent('message', {
                        data: { command: '${viewToUpdateCommand(view)}', data: data }
                    }));
                } catch (e) {
                    var overlay = document.getElementById('loading-overlay');
                    if (overlay) overlay.style.display = 'none';
                    var root = document.getElementById('root');
                    if (root) { root.style.display = 'block'; root.textContent = 'JS Error: ' + e.message; }
                }
            })();
        """.trimIndent()
        log.info("Executing JS update for view=$view (${js.length} chars)")
        browser.cefBrowser.executeJavaScript(js, browser.cefBrowser.url, 0)
    }

    private fun showError(message: String) {
        val isTimeout = message.contains("timed out", ignoreCase = true)
        val safe = message
            .replace("\\", "\\\\")
            .replace("'", "\\'")
            .replace("\n", "\\n")
            .replace("\r", "\\r")

        // When the error is a timeout, define a JS helper for the retry buttons and
        // render the buttons themselves inline in the overlay.
        val retrySetup = if (isTimeout) """
            window.__retryLoad = function(ext) {
                window.chrome.webview.postMessage(JSON.stringify(
                    ext ? {command:'retryWithExtendedTimeout'} : {command:'retry'}
                ));
            };
        """.trimIndent() else ""

        // Produces a JS string fragment ending with ' +' so it can be concatenated
        // into the innerHTML assignment below; empty when not a timeout.
        val retryBlock = if (isTimeout) """
            '<div style="margin-top:12px;display:flex;gap:8px;justify-content:center">' +
            '<button onclick="__retryLoad(false)" style="padding:6px 14px;background:#0e639c;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px">Retry</button>' +
            '<button onclick="__retryLoad(true)" style="padding:6px 14px;background:#3a3d41;color:#ccc;border:1px solid #555;border-radius:4px;cursor:pointer;font-size:12px">Wait longer (5 min)</button>' +
            '</div>' +
        """.trimIndent() else ""

        val js = """
            (function() {
                $retrySetup
                var overlay = document.getElementById('loading-overlay');
                if (overlay) {
                    overlay.innerHTML =
                        '<div style="width:100%;max-width:600px;background:var(--vscode-sideBar-background);border:1px solid var(--vscode-panel-border);border-radius:16px;padding:24px 28px;box-shadow:0 8px 32px rgba(0,0,0,0.3);text-align:center">' +
                            '<div style="font-size:32px;margin-bottom:8px">&#x26A0;</div>' +
                            '<div style="font-size:15px;font-weight:600;margin-bottom:8px">Error loading Copilot usage data</div>' +
                            '<div style="font-size:12px;color:#999;max-width:480px;margin:0 auto;white-space:pre-wrap;word-break:break-word;text-align:center">' +
                                '$safe' +
                            '</div>' +
                            $retryBlock
                            '<div style="margin-top:16px;font-size:12px">' +
                                'Something unexpected? <a href="https://github.com/rajbos/ai-engineering-fluency/issues" target="_blank" style="color:#4daafc;text-decoration:none">Report an issue</a>' +
                            '</div>' +
                        '</div>';
                }
            })();
        """.trimIndent()
        browser.cefBrowser.executeJavaScript(js, browser.cefBrowser.url, 0)
    }

    /**
     * Handles messages posted by the webview via the shim.
     * Mirrors the VS extension's `OnWebMessageReceived` switch.
     */
    private fun handleWebviewMessage(rawMessage: String) {
        log.info("webview -> host: $rawMessage")
        try {
            // Messages arrive as JSON strings: {"command":"showChart"} etc.
            // Use simple regex extraction to avoid external JSON library dependency.
            val command = """"command"\s*:\s*"([^"]+)"""".toRegex()
                .find(rawMessage)?.groupValues?.get(1) ?: return

            when (command) {
                "refresh" -> refreshStatsAsync()

                "retry" -> {
                    // Reload the spinner page and re-run the prefetch with the default timeout.
                    CliBridge.invalidateCache()
                    browser.loadHTML(WebviewResources.buildHtml(currentView, hostBridgeInjectFunction = hostBridge.inject("payload")))
                    prefetchAndLoadView(currentView)
                }

                "retryWithExtendedTimeout" -> {
                    // Use a 5-minute timeout for the next fetch. If it succeeds, persist it as the new default.
                    CliBridge.timeoutSeconds = 300L
                    CliBridge.invalidateCache()
                    browser.loadHTML(WebviewResources.buildHtml(currentView, hostBridgeInjectFunction = hostBridge.inject("payload")))
                    prefetchAndLoadView(
                        currentView,
                        onSuccess = { CliBridge.setPersistentTimeout(300L) },
                        onFailure = { CliBridge.resetTimeout() }
                    )
                }

                "showDetails" -> navigateToView("details")
                "showChart" -> navigateToView("chart")
                "showUsageAnalysis" -> navigateToView("usage")
                "showEnvironmental" -> navigateToView("environmental")
                "showMaturity" -> navigateToView("maturity")
                "showFluencyLevelViewer" -> navigateToView("fluency-level-viewer")
                "showDiagnostics" -> navigateToView("details") // not supported yet
                "showDashboard" -> navigateToView("details") // not supported yet

                "jsError" -> {
                    val msg = """"message"\s*:\s*"([^"]+)"""".toRegex()
                        .find(rawMessage)?.groupValues?.get(1) ?: "(no message)"
                    log.error("WebView JS error in view '$currentView': $msg")
                }

                "setPeriodPreference" -> {
                    val period = """"period"\s*:\s*"([^"]+)"""".toRegex()
                        .find(rawMessage)?.groupValues?.get(1)
                    if (period == "day" || period == "week" || period == "month") {
                        currentChartPeriod = period
                        log.info("Chart period preference updated to: $period")
                    }
                }

                "openMethodologySource" -> {
                    // Fixed id -> URL lookup: the webview never supplies the address itself.
                    val source = """"source"\s*:\s*"([^"]+)"""".toRegex()
                        .find(rawMessage)?.groupValues?.get(1)
                    ENVIRONMENTAL_METHODOLOGY_SOURCES[source]?.let { BrowserUtil.browse(it) }
                }

                else -> log.warn("Unknown webview command: $command")
            }
        } catch (e: Exception) {
            log.warn("Failed to parse webview message: ${e.message}")
        }
    }

    /**
     * Maps a view name to the message command the webview bundle listens for.
     * Each bundle has its own expected command name for live updates.
     */
    private fun viewToUpdateCommand(view: String): String = when (view) {
        "chart" -> "updateChartData"
        else -> "updateStats"
    }

    /**
     * Navigates to a different view by fetching CLI data first, then loading
     * the HTML with data pre-embedded so the bundle sees it at bootstrap.
     */
    private fun navigateToView(view: String) {
        if (view == currentView) {
            // Same view — for views with message listeners, dispatch an update.
            // For views without (maturity), reload with fresh data.
            if (viewHasMessageListener(view)) {
                refreshStatsAsync()
            } else {
                navigateWithFreshData(view)
            }
            return
        }
        currentView = view
        navigateWithFreshData(view)
    }

    private fun viewHasMessageListener(view: String): Boolean = when (view) {
        "details", "chart", "usage", "environmental" -> true
        else -> false // maturity, diagnostics have no live-update listener
    }

    /**
     * Navigates to [view] using cached data if available (instant, no spinner),
     * or fetches fresh data with a loading spinner if cache is cold.
     */
    private fun navigateWithFreshData(view: String) {
        if (CliBridge.prefetchDone) {
            // Cache is warm — load immediately, no spinner
            loadViewFromCache(view)
        } else {
            // Cache is cold — show spinner while fetching
            initialLoadDone = true
            browser.loadHTML(WebviewResources.buildHtml(view, hostBridgeInjectFunction = hostBridge.inject("payload")))
            prefetchAndLoadView(view)
        }
    }

    /**
     * Builds the Scoring Guide payload from the `fluencyLevelData.json` rubric
     * bundled with the plugin. The rubric is static reference data — the same
     * file the fluency scores are calculated against — so it needs no CLI
     * round trip; only `backendConfigured` (which gates the Team Dashboard nav
     * button) is derived from cached CLI stats.
     *
     * Returns the literal `"null"` when the rubric is missing or malformed, so
     * the webview renders "No data available." instead of throwing on an
     * empty category list — mirrors the Visual Studio host's degraded path.
     */
    private fun buildFluencyLevelJson(): String {
        val categories = WebviewResources.loadFluencyLevelRubric()
        if (categories == null) {
            log.warn("Scoring Guide: rubric missing or malformed")
            return "null"
        }
        val backendConfigured = extractBackendConfigured(CliBridge.cachedFluencyJson ?: CliBridge.cachedAllJson)
        return "{\"categories\":$categories,\"isDebugMode\":false,\"backendConfigured\":$backendConfigured}"
    }

    /** Regex-extracts the top-level `"backendConfigured"` boolean from a cached CLI JSON blob. */
    private fun extractBackendConfigured(json: String?): Boolean {
        if (json == null) return false
        return """"backendConfigured"\s*:\s*true""".toRegex().containsMatchIn(json)
    }

    /**
     * Appends the current plugin display settings (compactNumbers, use24HourTime)
     * to the JSON object that is sent to the webview, so the bundle can apply
     * the same formatting rules as the VS Code extension.
     */
    private fun injectSettings(json: String): String {
        val trimmed = json.trimEnd()
        if (!trimmed.endsWith("}")) return json
        val settings = PluginSettings.instance.state
        val fragment = ",\"compactNumbers\":${settings.compactNumbers},\"use24HourTime\":${settings.use24HourTime}" +
            (if (settings.monthlyCostBudget > 0.0) ",\"monthlyBudget\":${settings.monthlyCostBudget}" else "")
        return trimmed.dropLast(1) + fragment + "}"
    }

    /**
     * Extracts a top-level key from a JSON object string.
     * e.g. extractJsonKey('{"details":{...},"chart":{...}}', "details") -> '{...}'
     */
    private fun extractJsonKey(json: String, key: String): String {
        return try {
            // Use a simple approach: parse with built-in javax.script or regex
            // Since we just need one top-level key, use indexOf-based extraction
            val searchKey = "\"$key\""
            val keyIdx = json.indexOf(searchKey)
            if (keyIdx < 0) return json

            // Find the colon after the key
            val colonIdx = json.indexOf(':', keyIdx + searchKey.length)
            if (colonIdx < 0) return json

            // Find the start of the value (skip whitespace)
            var valueStart = colonIdx + 1
            while (valueStart < json.length && json[valueStart].isWhitespace()) valueStart++
            if (valueStart >= json.length) return json

            // If value starts with '{' or '[', find matching close bracket
            val startChar = json[valueStart]
            if (startChar == '{' || startChar == '[') {
                val endChar = if (startChar == '{') '}' else ']'
                var depth = 0
                var inString = false
                var escaped = false
                var i = valueStart
                while (i < json.length) {
                    val c = json[i]
                    if (escaped) { escaped = false; i++; continue }
                    if (c == '\\' && inString) { escaped = true; i++; continue }
                    if (c == '"') { inString = !inString; i++; continue }
                    if (!inString) {
                        if (c == startChar) depth++
                        else if (c == endChar) {
                            depth--
                            if (depth == 0) return json.substring(valueStart, i + 1)
                        }
                    }
                    i++
                }
            }
            json // fallback
        } catch (_: Exception) {
            json
        }
    }

    override fun dispose() {
        hostBridge.dispose()
        browser.dispose()
    }
}
