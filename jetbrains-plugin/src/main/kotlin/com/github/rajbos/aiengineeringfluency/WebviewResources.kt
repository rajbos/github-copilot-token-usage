package com.github.rajbos.aiengineeringfluency

/**
 * Builds the HTML document hosted inside the JCEF browser.
 *
 * Direct counterpart of `visualstudio-extension/.../WebBridge/ThemedHtmlBuilder.cs`,
 * but using a JBCefJSQuery for the host bridge instead of WebView2's
 * `window.chrome.webview`. The shim is shimmed (yes) by appending a tiny
 * adapter that exposes `window.chrome.webview.postMessage` so the existing
 * `vscode-shim.js` continues to work without modification.
 *
 * The compiled webview bundle is loaded via `<script src="webview/<view>.js">`.
 * JCEF resolves that URL against the `data:` document origin we serve, so we
 * inline the bundle source rather than relying on a virtual host (simpler than
 * WebView2's `SetVirtualHostNameToFolderMapping`).
 */
object WebviewResources {

    /**
     * Returns a complete HTML document for [view], with the bundle, shim, and
     * host-bridge bootstrap inlined. [hostBridgeInjectFunction] is the JS
     * snippet produced by `JBCefJSQuery.inject("payload")` — calling it sends
     * the value of the `payload` variable to the Kotlin handler.
     */
    fun buildHtml(view: String, hostBridgeInjectFunction: String): String {
        val shim = loadResource("/webview/vscode-shim.js")
            ?: "/* vscode-shim.js missing from plugin resources */"
        val bundle = loadResource("/webview/$view.js")
            ?: "/* webview bundle $view.js missing from plugin resources */"
        val globalKey = viewToGlobalKey(view)

        // Bridge bootstrap:
        //   * defines window.chrome.webview.postMessage(...) which forwards
        //     to the JBCefJSQuery via the inject() snippet
        //   * provides a no-op addEventListener so the shim's listener
        //     installation doesn't blow up
        // The shim itself listens to 'message' events on the window for the
        // host -> webview direction; pushStatsToWebview() in TokenTrackerPanel
        // dispatches those via window.postMessage().
        val bridgeBootstrap = """
            (function () {
                window.chrome = window.chrome || {};
                window.chrome.webview = window.chrome.webview || {
                    postMessage: function (msg) {
                        try {
                            var payload = (typeof msg === 'string') ? msg : JSON.stringify(msg);
                            $hostBridgeInjectFunction;
                        } catch (e) { console.error('host bridge post failed:', e); }
                    },
                    addEventListener: function () { /* host->webview uses window.postMessage */ }
                };
            })();
        """.trimIndent()

        // Initial stats are an empty object; TokenTrackerPanel.refreshStatsAsync()
        // assigns the real value as soon as the CLI returns.
        return """
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <style>
                    html, body { margin: 0; padding: 0; height: 100%; background: #1e1e1e; color: #d4d4d4;
                                 font-family: -apple-system, 'Segoe UI', sans-serif; }
                </style>
                <script>$bridgeBootstrap</script>
                <script>$shim</script>
                <script>window.$globalKey = {};</script>
            </head>
            <body>
                <div id="root"></div>
                <script>$bundle</script>
            </body>
            </html>
        """.trimIndent()
    }

    /**
     * Returns a small error page rendered in the JCEF browser when the CLI
     * fails. Mirrors `ThemedHtmlBuilder.BuildErrorHtml`.
     */
    fun buildErrorHtml(message: String): String {
        val safe = message.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        return """
            <!DOCTYPE html>
            <html><head><meta charset="UTF-8">
            <style>
                body { background: #1e1e1e; color: #d4d4d4; font-family: -apple-system, 'Segoe UI', sans-serif;
                       display: flex; flex-direction: column; align-items: center; justify-content: center;
                       height: 100vh; margin: 0; padding: 24px; box-sizing: border-box; text-align: center; }
                .icon { font-size: 32px; }
                .title { font-size: 15px; font-weight: 600; margin: 8px 0; }
                .detail { font-size: 12px; color: #999; max-width: 480px; white-space: pre-wrap; word-break: break-word; }
            </style></head>
            <body>
                <div class="icon">&#x26A0;</div>
                <div class="title">Error loading Copilot usage data</div>
                <div class="detail">$safe</div>
            </body></html>
        """.trimIndent()
    }

    fun viewToGlobalKey(view: String): String = when (view) {
        "details" -> "__INITIAL_DETAILS__"
        "chart" -> "__INITIAL_CHART__"
        "usage" -> "__INITIAL_USAGE__"
        "diagnostics" -> "__INITIAL_DIAGNOSTICS__"
        "environmental" -> "__INITIAL_ENVIRONMENTAL__"
        "maturity" -> "__INITIAL_MATURITY__"
        else -> "__INITIAL_DETAILS__"
    }

    private fun loadResource(path: String): String? =
        WebviewResources::class.java.getResourceAsStream(path)?.bufferedReader()?.use { it.readText() }
}
