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

        // The webview bundles localize themselves from `initialData.localization`.
        // Only the VS Code extension used to supply that, so this plugin — which
        // redistributes the very same bundles — rendered their built-in English
        // fallback no matter what language the IDE was running in. The dictionary
        // is staged next to the bundles by esbuild (see the localization sidecar
        // block in vscode-extension/esbuild.js); we pick the one matching the IDE
        // locale and complete the payload rather than rebuilding it in Kotlin.
        //
        // Written as a guarded assignment instead of being merged into the JSON so
        // it is a no-op when there is no initial payload yet, rather than creating
        // an empty object the bundle would mistake for real data.
        val localizationScript = loadWebviewLocalization()
            ?.let { dictionary ->
                """
                (function () {
                    var data = window.$globalKey;
                    if (data && typeof data === 'object') { data.localization = ${dictionary.replace("</", "<\\/")}; }
                })();
                """.trimIndent()
            }
            ?: "/* webview localization dictionary missing from plugin resources */"

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
        val overlayDisplayStyle = if (initialStatsJson != null) "display: none"
            else "display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: calc(100vh - 32px); padding: 20px; box-sizing: border-box"
        val rootStyle = if (initialStatsJson != null) "" else "display: none"

        return """
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <style>
                    html, body { margin: 0; padding: 0; height: 100%; background: #1e1e1e; color: #d4d4d4;
                                 font-family: -apple-system, 'Segoe UI', sans-serif; }
                    /* Buttons/sections not supported in JetBrains. Loosely mirrors — but does
                       not exactly match — ThemedHtmlBuilder.cs in the VS extension: each host
                       hides only what its own build doesn't ship, and the two feature sets
                       differ (e.g. JetBrains still hides #btn-level-viewer / .share-section /
                       .beta-footer that VS ships, while VS hides Export/Share-to-Issue that
                       JetBrains doesn't address here). */
                    #btn-diagnostics,
                    #btn-level-viewer,
                    #view-repository,
                    .share-section,
                    .beta-footer,
                    .mcp-discover-btn { display: none !important; }
                    /* Usage view: hide Workspace Health and Repository PRs tabs (no data source in JetBrains) */
                    .tab-button[data-tab="health"],
                    .tab-button[data-tab="repos"],
                    #tab-panel-health,
                    #tab-panel-repos { display: none !important; }
                    #loading-overlay { $overlayDisplayStyle; }
                    #root { $rootStyle; }
                    /* Loading card — mirrors VS Code's getLoadingHtml card design */
                    .loading-card { width: 100%; max-width: 600px; background: var(--vscode-sideBar-background);
                                    border: 1px solid var(--vscode-panel-border); border-radius: 16px;
                                    padding: 24px 28px; box-shadow: 0 8px 32px rgba(0,0,0,0.3); }
                    .loading-header-row { display: flex; justify-content: space-between; align-items: flex-start;
                                         margin-bottom: 16px; gap: 16px; }
                    .loading-badge-label { font-size: 11px; font-weight: 700; letter-spacing: 0.12em;
                                           text-transform: uppercase; color: var(--vscode-textLink-foreground);
                                           margin-bottom: 4px; }
                    .loading-title { font-size: 20px; font-weight: 700; color: var(--vscode-editor-foreground);
                                     margin-bottom: 4px; }
                    .loading-subtitle { font-size: 12px; color: var(--vscode-descriptionForeground);
                                        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                    .loading-elapsed { font-size: 28px; font-weight: 800; color: var(--vscode-editor-foreground);
                                       line-height: 1; font-variant-numeric: tabular-nums; flex-shrink: 0; }
                    .loading-progress-wrap { margin-bottom: 16px; }
                    .loading-progress-track { height: 6px; background: var(--vscode-panel-border);
                                              border-radius: 3px; overflow: hidden; }
                    .loading-progress-fill { height: 100%; border-radius: 3px; width: 25%; position: relative;
                                             animation: loading-shimmer 1.8s ease-in-out infinite;
                                             background: linear-gradient(90deg, transparent,
                                               var(--vscode-textLink-foreground),
                                               var(--vscode-terminal-ansiGreen), transparent); }
                    @keyframes loading-shimmer { 0% { margin-left: -30%; } 100% { margin-left: 110%; } }
                    .loading-steps-box { background: var(--vscode-editorWidget-background);
                                         border: 1px solid var(--vscode-panel-border);
                                         border-radius: 10px; padding: 14px 16px; margin-bottom: 14px; }
                    .loading-step { display: flex; align-items: center; gap: 10px; padding: 5px 0;
                                    color: var(--vscode-descriptionForeground); font-size: 13px; transition: color 0.25s; }
                    .loading-step.step-done { color: var(--vscode-terminal-ansiGreen); }
                    .loading-step.step-active { color: var(--vscode-textLink-foreground); font-weight: 600; }
                    .loading-step-ico { width: 18px; text-align: center; flex-shrink: 0; font-style: normal; }
                    .loading-spin-ico { display: inline-block; animation: spin 0.75s linear infinite; }
                    @keyframes spin { to { transform: rotate(360deg); } }
                    .loading-hint { font-size: 12px; color: var(--vscode-descriptionForeground); text-align: center; }
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
                <script>$bridgeBootstrap</script>
                <script>$shim</script>
                <script>window.$globalKey = $safeInitialData;</script>
                <script>$localizationScript</script>
            </head>
            <body>
                <div id="loading-overlay">
                    <div class="loading-card">
                        <div class="loading-header-row">
                            <div>
                                <div class="loading-badge-label">&#x1F916; Analyzing Your AI Activity</div>
                                <div class="loading-title">Building Activity Index</div>
                                <div class="loading-subtitle" id="loading-subtitle">Discovering session files&hellip;</div>
                            </div>
                            <div class="loading-elapsed" id="loading-elapsed">0s</div>
                        </div>
                        <div class="loading-progress-wrap">
                            <div class="loading-progress-track">
                                <div class="loading-progress-fill" id="loading-prog-fill"></div>
                            </div>
                        </div>
                        <div class="loading-steps-box">
                            <div class="loading-step step-active" id="ls-discover">
                                <i class="loading-step-ico"><span class="loading-spin-ico">&#x21BB;</span></i>
                                <span>Discovering session files</span>
                            </div>
                            <div class="loading-step" id="ls-parse">
                                <i class="loading-step-ico">&#x25CB;</i>
                                <span>Parsing session logs</span>
                            </div>
                            <div class="loading-step" id="ls-compute">
                                <i class="loading-step-ico">&#x25CB;</i>
                                <span>Computing statistics</span>
                            </div>
                            <div class="loading-step" id="ls-ready">
                                <i class="loading-step-ico">&#x25CB;</i>
                                <span>Ready!</span>
                            </div>
                        </div>
                        <div class="loading-hint">This may take up to 2 minutes on the first run.</div>
                    </div>
                </div>
                <script>
                (function () {
                    var t0 = Date.now();
                    setInterval(function () {
                        var s = Math.floor((Date.now() - t0) / 1000);
                        var el = document.getElementById('loading-elapsed');
                        if (!el) return;
                        el.textContent = s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's';
                    }, 1000);
                    function setDone(id) {
                        var el = document.getElementById(id); if (!el) return;
                        el.classList.remove('step-active'); el.classList.add('step-done');
                        var ico = el.querySelector('.loading-step-ico'); if (ico) ico.innerHTML = '&#x2713;';
                    }
                    function setActive(id, text) {
                        var el = document.getElementById(id); if (!el) return;
                        el.classList.remove('step-done'); el.classList.add('step-active');
                        var ico = el.querySelector('.loading-step-ico');
                        if (ico) ico.innerHTML = '<span class="loading-spin-ico">&#x21BB;</span>';
                        var sub = document.getElementById('loading-subtitle');
                        if (sub && text) sub.textContent = text;
                    }
                    setTimeout(function () { setDone('ls-discover'); setActive('ls-parse', 'Parsing session logs\u2026'); }, 3000);
                    setTimeout(function () { setDone('ls-parse'); setActive('ls-compute', 'Computing statistics\u2026'); }, 18000);
                })();
                </script>
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
                .detail { font-size: 12px; color: #999; max-width: 480px; white-space: pre-wrap; word-break: break-word; text-align: center;}
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
        "fluency-level-viewer" -> "__INITIAL_FLUENCY_LEVEL_DATA__"
        else -> "__INITIAL_DETAILS__"
    }

    /**
     * The webview string dictionary for the IDE's display language, as raw JSON.
     *
     * Tries the exact tag first, then falls back to the shipped Simplified
     * Chinese bundle for any Simplified locale, then English.
     *
     * The exact-tag-then-bare-language lookup this replaced sent `zh-Hans` and
     * `zh-Hans-CN` to English even though a `zh-cn` sidecar ships, because
     * neither is a prefix of it (raised in review on #2138). Script is what
     * decides, not region: `zh-SG` is Simplified and should get the bundle,
     * while `zh-TW`, `zh-HK` and `zh-MO` are Traditional and must not — serving
     * Traditional readers Simplified text is worse than serving them English.
     *
     * Mirrors `resolveLocaleId()` in vscode-extension/src/l10nCore.ts, which
     * gets the same answer via `Intl.Locale.maximize()`. The JVM has no
     * equivalent in `java.util.Locale`, so the rule is spelled out here rather
     * than pulling ICU onto the classpath for one comparison.
     *
     * Returning English on a miss is deliberate: every locale file is complete
     * (esbuild fills untranslated keys with their English text), so a partially
     * populated dictionary can never reach a bundle.
     */
    private fun loadWebviewLocalization(): String? {
        val ideLocale = java.util.Locale.getDefault()
        loadResource("/webview/localization.${ideLocale.toLanguageTag().lowercase()}.json")
            ?.let { return it.trim() }
        if (isSimplifiedChinese(ideLocale)) {
            loadResource("/webview/localization.zh-cn.json")?.let { return it.trim() }
        }
        return loadResource("/webview/localization.en.json")?.trim()
    }

    /**
     * True for Chinese locales written in Simplified script.
     *
     * An explicit `Hans`/`Hant` script wins. With no script, the region decides:
     * Taiwan, Hong Kong and Macau are Traditional, everything else Simplified —
     * which is also what `Intl.Locale.maximize()` concludes.
     */
    private fun isSimplifiedChinese(locale: java.util.Locale): Boolean {
        if (!locale.language.equals("zh", ignoreCase = true)) { return false }
        return when {
            locale.script.equals("Hans", ignoreCase = true) -> true
            locale.script.equals("Hant", ignoreCase = true) -> false
            else -> locale.country.uppercase() !in setOf("TW", "HK", "MO")
        }
    }

    private fun loadResource(path: String): String? =
        WebviewResources::class.java.getResourceAsStream(path)?.bufferedReader()?.use { it.readText() }

    /**
     * Returns the raw JSON array contents of the Scoring Guide rubric
     * (`fluencyLevelData.json`, staged next to the webview bundles by
     * `prepareBundledAssets`), or null when it is missing or not a JSON array.
     * The rubric is static reference data — the same file the fluency scores
     * are calculated against — so callers combine it with `backendConfigured`
     * from cached CLI stats rather than fetching it from the CLI.
     */
    fun loadFluencyLevelRubric(): String? {
        val raw = loadResource("/webview/fluencyLevelData.json")?.trim() ?: return null
        return raw.takeIf { it.startsWith("[") && it.endsWith("]") }
    }

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
