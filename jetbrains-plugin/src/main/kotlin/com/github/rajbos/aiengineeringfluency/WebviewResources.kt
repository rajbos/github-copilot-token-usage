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
    fun buildHtml(view: String, hostBridgeInjectFunction: String, initialStatsJson: String? = null): String {
        val shim = loadResource("/webview/vscode-shim.js")
            ?: "/* vscode-shim.js missing from plugin resources */"
        val bundle = loadResource("/webview/$view.js")
            ?: "/* webview bundle $view.js missing from plugin resources */"
        val globalKey = viewToGlobalKey(view)

        // Escape JSON for safe inline <script> embedding:
        // "</script>" in a JSON value would prematurely close the tag.
        val safeInitialData = initialStatsJson
            ?.replace("</", "<\\/")
            ?: "undefined"

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
        // When initial data is provided, hide the loading overlay and show root immediately
        val overlayStyle = if (initialStatsJson != null) "display: none" else
            "display: flex; flex-direction: column; align-items: center; justify-content: center; height: calc(100vh - 32px); text-align: center"
        val rootStyle = if (initialStatsJson != null) "" else "display: none"

        return """
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <style>
                    html, body { margin: 0; padding: 0; height: 100%; background: #1e1e1e; color: #d4d4d4;
                                 font-family: -apple-system, 'Segoe UI', sans-serif; }
                    /* Buttons/sections not supported in JetBrains — mirrors ThemedHtmlBuilder.cs in VS extension */
                    #btn-diagnostics,
                    #btn-level-viewer,
                    #btn-level-viewer-inline,
                    #view-repository,
                    .share-section,
                    .beta-footer,
                    .mcp-discover-btn { display: none !important; }
                    #loading-overlay { $overlayStyle; }
                    #root { $rootStyle; }
                    .spinner { width: 32px; height: 32px; border: 3px solid #333; border-top: 3px solid #0078d4;
                               border-radius: 50%; animation: spin 1s linear infinite; margin-bottom: 16px; }
                    @keyframes spin { to { transform: rotate(360deg); } }
                    .loading-title { font-size: 14px; font-weight: 600; margin-bottom: 6px; }
                    .loading-detail { font-size: 12px; color: #999; }
                    .repo-footer { position: fixed; bottom: 0; left: 0; right: 0; padding: 6px 16px;
                                   font-size: 11px; color: #666; text-align: center; background: #1e1e1e;
                                   border-top: 1px solid #333; }
                    .repo-footer a { color: #4daafc; text-decoration: none; }
                    .repo-footer a:hover { text-decoration: underline; }
                </style>
                <style>
                    /* Dark theme values for VS Code CSS variables — all bundles rely on these */
                    :root {
                        --vscode-editor-background: #1e1e1e;
                        --vscode-editor-foreground: #d4d4d4;
                        --vscode-sideBar-background: #252526;
                        --vscode-editorWidget-background: #2d2d30;
                        --vscode-descriptionForeground: #9d9d9d;
                        --vscode-disabledForeground: #808080;
                        --vscode-panel-border: #444444;
                        --vscode-widget-border: #454545;
                        --vscode-button-background: #0e639c;
                        --vscode-button-foreground: #ffffff;
                        --vscode-button-hoverBackground: #1177bb;
                        --vscode-button-secondaryBackground: #3a3d41;
                        --vscode-button-secondaryForeground: #cccccc;
                        --vscode-button-secondaryHoverBackground: #45494e;
                        --vscode-input-background: #3c3c3c;
                        --vscode-input-foreground: #cccccc;
                        --vscode-input-border: #3c3c3c;
                        --vscode-list-hoverBackground: #2a2d2e;
                        --vscode-list-activeSelectionBackground: #094771;
                        --vscode-list-activeSelectionForeground: #ffffff;
                        --vscode-list-inactiveSelectionBackground: #37373d;
                        --vscode-badge-background: #4d5666;
                        --vscode-badge-foreground: #ffffff;
                        --vscode-focusBorder: #007fd4;
                        --vscode-textLink-foreground: #4daafc;
                        --vscode-textLink-activeForeground: #4daafc;
                        --vscode-errorForeground: #f48771;
                        --vscode-editorWarning-foreground: #f5c942;
                        --vscode-terminal-ansiGreen: #89d185;
                        --vscode-contrastBorder: #6fc3df;
                    }
                </style>
                <script>$shim</script>
                <script>window.$globalKey = $safeInitialData;</script>
            </head>
            <body>
                <div id="loading-overlay">
                    <div class="spinner"></div>
                    <div class="loading-title">Loading Copilot usage data&hellip;</div>
                    <div class="loading-detail">Scanning session logs &mdash; this may take up to 2 minutes on the first run.</div>
                </div>
                <div id="root"></div>
                <div class="repo-footer">
                    <a href="https://github.com/rajbos/ai-engineering-fluency" target="_blank">AI Engineering Fluency</a>
                    &nbsp;&middot;&nbsp; Questions or issues?
                    <a href="https://github.com/rajbos/ai-engineering-fluency/issues" target="_blank">Open an issue</a>
                </div>
                <script>$bundle</script>
                ${buildJbHideScript(view)}
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
                .repo-link { margin-top: 16px; font-size: 12px; }
                .repo-link a { color: #4daafc; text-decoration: none; }
                .repo-link a:hover { text-decoration: underline; }
            </style></head>
            <body>
                <div class="icon">&#x26A0;</div>
                <div class="title">Error loading Copilot usage data</div>
                <div class="detail">$safe</div>
                <div class="repo-link">
                    Something unexpected? <a href="https://github.com/rajbos/ai-engineering-fluency/issues" target="_blank">Report an issue</a>
                </div>
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

    /**
     * Returns a view-specific JS block injected after the bundle, mirroring
     * `ThemedHtmlBuilder.BuildVsHideScript` in the Visual Studio extension.
     */
    private fun buildJbHideScript(view: String): String = when (view) {
        "usage" -> """
            <script>
            (function () {
              function hideUnsupportedSections() {
                document.querySelectorAll('.repo-hygiene-section').forEach(function(el) { el.style.display = 'none'; });
                document.querySelectorAll('.section').forEach(function(el) {
                  var title = el.querySelector('.section-title');
                  if (title && title.textContent.includes('Copilot Customization Files')) { el.style.display = 'none'; }
                });
                document.querySelectorAll('div').forEach(function(el) {
                  var firstChild = el.firstElementChild;
                  if (!firstChild) { return; }
                  var headingText = firstChild.textContent || '';
                  if ((headingText.includes('No other AI tool configs missing') || headingText.includes('Missed Potential: Non-Copilot')) &&
                      el.style && el.parentElement) { el.style.display = 'none'; }
                });
              }
              var observer = new MutationObserver(function() { hideUnsupportedSections(); });
              observer.observe(document.body, { childList: true, subtree: true });
              hideUnsupportedSections();
            })();
            </script>
        """.trimIndent()

        "maturity" -> """
            <script>
            (function () {
              var GITHUB_MCP_DOCS = 'https://docs.github.com/en/copilot/customizing-copilot/using-model-context-protocol-with-github-copilot';
              function fixMcpLinks() {
                document.querySelectorAll('a').forEach(function(a) {
                  var href = a.getAttribute('href') || '';
                  var text = a.textContent || '';
                  if (href.indexOf('code.visualstudio.com') !== -1 && href.indexOf('mcp') !== -1) {
                    a.setAttribute('href', GITHUB_MCP_DOCS);
                    a.setAttribute('target', '_blank');
                  }
                  if (text.indexOf('VS Code MCP registry') !== -1) {
                    a.textContent = text.replace('VS Code MCP registry', 'GitHub Copilot MCP docs');
                  }
                });
              }
              var observer = new MutationObserver(function() { fixMcpLinks(); });
              observer.observe(document.body, { childList: true, subtree: true });
              fixMcpLinks();
            })();
            </script>
        """.trimIndent()

        else -> ""
    }
}
