package com.github.rajbos.aiengineeringfluency

import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.thisLogger
import com.intellij.openapi.project.Project
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefBrowserBase
import com.intellij.ui.jcef.JBCefJSQuery
import org.cef.browser.CefBrowser
import org.cef.browser.CefFrame
import org.cef.handler.CefLoadHandlerAdapter
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
    private val view: String = "details",
) : Disposable {

    private val log = thisLogger()
    private val browser: JBCefBrowser = JBCefBrowser()
    @Volatile private var initialLoadDone = false

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
            // Returning a successful empty response keeps the JS Promise resolved
            // so the shim doesn't accumulate pending callbacks.
            null
        }

        // After every successful page load, run the stats refresh and push the
        // resulting JSON into the page using the same global key the VS
        // extension uses (window.__INITIAL_<VIEW>__ = ...).
        browser.jbCefClient.addLoadHandler(object : CefLoadHandlerAdapter() {
            override fun onLoadEnd(b: CefBrowser, frame: CefFrame, httpStatusCode: Int) {
                if (frame.isMain && !initialLoadDone) {
                    initialLoadDone = true
                    refreshStatsAsync()
                }
            }
        }, browser.cefBrowser)

        browser.loadHTML(WebviewResources.buildHtml(view, hostBridgeInjectFunction = hostBridge.inject("payload")))
    }

    /**
     * Triggers a CLI run on a background thread and pushes the result into the
     * webview when complete. Errors are surfaced as an inline error overlay.
     */
    private fun refreshStatsAsync() {
        ApplicationManager.getApplication().executeOnPooledThread {
            val result = runCatching { CliBridge.fetchStats(view) }
            ApplicationManager.getApplication().invokeLater {
                result.fold(
                    onSuccess = { json -> pushStatsToWebview(json) },
                    onFailure = { err ->
                        log.warn("CLI stats fetch failed", err)
                        showError(err.message ?: "Unknown error fetching stats")
                    },
                )
            }
        }
    }

    private fun pushStatsToWebview(statsJson: String) {
        log.info("Pushing stats to webview: ${statsJson.length} chars, globalKey=${WebviewResources.viewToGlobalKey(view)}")
        val globalKey = WebviewResources.viewToGlobalKey(view)
        val jsonKey = CliBridge.viewToAllJsonKey(view)
        val escapedJson = statsJson
            .replace("\\", "\\\\")
            .replace("'", "\\'")
            .replace("\n", "\\n")
            .replace("\r", "\\r")
        // Extract the sub-key when using the 'all' command (e.g., data.details for details view)
        val extractExpr = if (jsonKey != null) "data['$jsonKey']" else "data"
        val js = """
            (function() {
                try {
                    var data = JSON.parse('$escapedJson');
                    var viewData = $extractExpr;
                    window.$globalKey = viewData;
                    // Hide loading overlay, show the data root
                    var overlay = document.getElementById('loading-overlay');
                    if (overlay) overlay.style.display = 'none';
                    var root = document.getElementById('root');
                    if (root) root.style.display = 'block';
                    window.dispatchEvent(new MessageEvent('message', {
                        data: { command: 'updateStats', data: viewData }
                    }));
                } catch (e) {
                    var overlay = document.getElementById('loading-overlay');
                    if (overlay) overlay.style.display = 'none';
                    var root = document.getElementById('root');
                    if (root) { root.style.display = 'block'; root.textContent = 'JS Error: ' + e.message; }
                }
            })();
        """.trimIndent()
        log.info("Executing JS with jsonKey=$jsonKey (${js.length} chars)")
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
     * For now we only log — future commands (e.g. `openExternal`, `refresh`)
     * mirror the VS extension's `WebView_WebMessageReceived` switch.
     */
    private fun handleWebviewMessage(rawMessage: String) {
        log.debug("webview -> host: $rawMessage")
    }

    override fun dispose() {
        hostBridge.dispose()
        browser.dispose()
    }
}
