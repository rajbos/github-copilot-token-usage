package com.github.rajbos.aiengineeringfluency

import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.thisLogger
import com.intellij.openapi.project.Project
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefBrowserBase
import com.intellij.ui.jcef.JBCefJSQuery
import javax.swing.JComponent

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
     */
    private fun prefetchAndLoadView(view: String) {
        ApplicationManager.getApplication().executeOnPooledThread {
            val result = runCatching { CliBridge.prefetchAll() }
            ApplicationManager.getApplication().invokeLater {
                result.fold(
                    onSuccess = {
                        // Cache is now warm — load the current view with data embedded
                        loadViewFromCache(currentView)
                    },
                    onFailure = { err ->
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
            initialJson
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
        val escapedJson = statsJson
            .replace("\\", "\\\\")
            .replace("'", "\\'")
            .replace("\n", "\\n")
            .replace("\r", "\\r")
        // statsJson is already the extracted view sub-object (done by refreshStatsAsync before calling here)
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
        val safe = message
            .replace("\\", "\\\\")
            .replace("'", "\\'")
            .replace("\n", "\\n")
            .replace("\r", "\\r")
        val js = """
            (function() {
                var overlay = document.getElementById('loading-overlay');
                if (overlay) {
                    overlay.innerHTML =
                        '<div style="font-size:32px">&#x26A0;</div>' +
                        '<div style="font-size:15px;font-weight:600;margin:8px 0">Error loading Copilot usage data</div>' +
                        '<div style="font-size:12px;color:#999;max-width:480px;white-space:pre-wrap;word-break:break-word">' +
                            '$safe' +
                        '</div>' +
                        '<div style="margin-top:16px;font-size:12px">' +
                            'Something unexpected? <a href="https://github.com/rajbos/ai-engineering-fluency/issues" target="_blank" style="color:#4daafc;text-decoration:none">Report an issue</a>' +
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

                "showDetails" -> navigateToView("details")
                "showChart" -> navigateToView("chart")
                "showUsageAnalysis" -> navigateToView("usage")
                "showEnvironmental" -> navigateToView("environmental")
                "showMaturity" -> navigateToView("maturity")
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
