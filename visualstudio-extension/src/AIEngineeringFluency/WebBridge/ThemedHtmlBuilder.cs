using System;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Reflection;

namespace AIEngineeringFluency.WebBridge
{
    /// <summary>
    /// Builds the full HTML page that hosts a compiled webview bundle.
    ///
    /// Layout injected before the bundle script:
    ///   &lt;style&gt;  — VS theme colours mapped to --vscode-* CSS variables
    ///   &lt;script&gt; — vscode-shim.js (acquireVsCodeApi + WebView2 relay)
    ///   &lt;script&gt; — window.__INITIAL_{VIEW}__ = &lt;statsJson&gt;;
    ///
    /// The bundle is loaded from the virtual-host mapping:
    ///   https://copilot-tracker.local/{view}.js
    /// (mapped by TokenTrackerControl to the local webview/ install folder)
    /// </summary>
    internal static class ThemedHtmlBuilder
    {
        // ── Public API ─────────────────────────────────────────────────────────

        /// <summary>
        /// Returns a complete HTML document for <paramref name="view"/>.
        ///
        /// <paramref name="statsJson"/> must already be a serialised JSON string.
        /// </summary>
        public static string Build(string view, string statsJson)
        {
            var shim      = LoadShim();
            string themeCss;
            try   { themeCss = BuildThemeCss(); }
            catch { themeCss = BuildFallbackThemeCss(); }
            var globalKey  = ViewToGlobalKey(view);
            var vsHideJs   = BuildVsHideScript(view);
            var jsonGlobals = BuildJsonGlobalsScript();
            var localizationScript = BuildLocalizationScript(globalKey);

            // Prevent </script> injection in the JSON payload (OWASP XSS defence)
            var safeJson = statsJson.Replace("<", "\\u003c").Replace(">", "\\u003e");

            return $@"<!DOCTYPE html>
<html lang=""{LocalizationLocale()}"">
<head>
<meta charset=""UTF-8"">
<meta http-equiv=""Content-Security-Policy""
      content=""default-src 'none';
               script-src https://copilot-tracker.local 'unsafe-inline';
               style-src  'unsafe-inline';
               img-src    data: https:;
               connect-src 'none';"">
<style>
{themeCss}
html, body {{ margin: 0; padding: 0; height: 100%; overflow: auto; }}
/* Hide views not supported in Visual Studio */
#btn-diagnostics {{ display: none !important; }}
/* Chart: hide By Repository toggle (no repo data) */
#view-repository {{ display: none !important; }}
/* Maturity: hide VS Code Marketplace MCP discovery button (not available in Visual Studio) */
.mcp-discover-btn {{ display: none !important; }}
/* Maturity: social-share buttons and the repo create-an-issue link ARE supported in
   Visual Studio (handled by the C# host). Hide only the controls that need infrastructure
   we do not ship: the Export dropdown (image/PDF/PPTX) and Share-to-Issue (GitHub auth). */
#btn-export-toggle, .export-dropdown-container, #export-dropdown, #btn-share-issue {{ display: none !important; }}
</style>
<script>
{shim}
</script>
<script>
window.{globalKey} = {safeJson};
</script>
{localizationScript}
{jsonGlobals}
</head>
<body>
<div id=""root""></div>
<script src=""https://copilot-tracker.local/{view}.js""></script>
{vsHideJs}
<script>
// Relay unhandled JS errors back to the VS extension output window
(function(){{
  window.onerror = function(msg, src, line, col) {{
    if (window.chrome && window.chrome.webview) {{
      window.chrome.webview.postMessage({{ command: 'jsError', message: String(msg), source: String(src || ''), line: line || 0 }});
    }}
    return false;
  }};
  window.onunhandledrejection = function(e) {{
    if (window.chrome && window.chrome.webview) {{
      window.chrome.webview.postMessage({{ command: 'jsError', message: String(e.reason || 'unhandled rejection'), source: 'Promise', line: 0 }});
    }}
  }};
}})();
</script></body>
</html>";
        }

        /// <summary>
        /// Returns a small inline script that hides VS-unsupported sections after the
        /// bundle has rendered them into the DOM.  Uses a MutationObserver so it still
        /// works even when the bundle renders asynchronously.
        /// </summary>
        internal static string BuildVsHideScript(string view)
        {
            if (view == "maturity") { return BuildVsHideScriptMaturity(); }
            if (view != "usage") { return string.Empty; }

            // Hide the Customization Files section, the Missed Potential section, and the
            // Repository Hygiene section — none of which have data in Visual Studio.
            // Also hide the Workspace Health, Repository PRs, Cloud Agent, and Insights tabs
            // as those require GitHub auth / backend data not available in Visual Studio.
            return @"<script>
(function () {
  function hideUnsupportedSections() {
    // Hide the repo-hygiene-section by class (always present)
    document.querySelectorAll('.repo-hygiene-section').forEach(function(el) { el.style.display = 'none'; });

    // Hide the ""Copilot Customization Files"" section (class=""section"") and the
    // ""Missed Potential"" / ""No other AI tool configs"" inline divs by inspecting
    // heading text — these have no stable id or unique class.
    document.querySelectorAll('.section').forEach(function(el) {
      var title = el.querySelector('.section-title');
      if (title && title.textContent.includes('Copilot Customization Files')) {
        el.style.display = 'none';
      }
    });

    // Inline divs rendered by renderMissedPotential() — match only the *direct* heading child
    // so ancestor divs (whose accumulated textContent also contains the string) are NOT hidden.
    document.querySelectorAll('div').forEach(function(el) {
      var firstChild = el.firstElementChild;
      if (!firstChild) { return; }
      var headingText = firstChild.textContent || '';
      if ((headingText.includes('No other AI tool configs missing') || headingText.includes('Missed Potential: Non-Copilot')) &&
          el.style && el.parentElement) {
        el.style.display = 'none';
      }
    });

    // Hide tabs that require GitHub auth or backend data not available in Visual Studio:
    // Workspace Health, Repository PRs, Cloud Agent, Insights, Today's Sessions.
    ['health', 'repos', 'agent', 'insights', 'sessions'].forEach(function(tab) {
      var btn = document.querySelector('.tab-button[data-tab=""' + tab + '""]');
      if (btn) { btn.style.display = 'none'; }
      var panel = document.getElementById('tab-panel-' + tab);
      if (panel) { panel.style.display = 'none'; }
    });
  }

  // Run once the bundle has rendered (observe DOM mutations until stable)
  var observer = new MutationObserver(function() { hideUnsupportedSections(); });
  observer.observe(document.body, { childList: true, subtree: true });
  // Also run immediately in case the DOM is already populated
  hideUnsupportedSections();
})();
</script>";
        }

        /// <summary>
        /// Returns a JS block for the maturity view that rewrites VS Code-specific MCP
        /// registry links to IDE-neutral GitHub Copilot docs links.
        /// </summary>
        private static string BuildVsHideScriptMaturity()
        {
            // Replace "VS Code MCP registry" anchor text/hrefs with the GitHub Copilot MCP docs.
            // Done via MutationObserver so it runs after the bundle renders asynchronously.
            return @"<script>
(function () {
  var GITHUB_MCP_DOCS = 'https://docs.github.com/en/copilot/customizing-copilot/using-model-context-protocol-with-github-copilot';

  function fixMcpLinks() {
    document.querySelectorAll('a').forEach(function(a) {
      var href = a.getAttribute('href') || '';
      var text = a.textContent || '';
      // Rewrite VS Code MCP registry links to GitHub Copilot MCP docs
      if (href.indexOf('code.visualstudio.com') !== -1 && href.indexOf('mcp') !== -1) {
        a.setAttribute('href', GITHUB_MCP_DOCS);
        a.setAttribute('target', '_blank');
      }
      // Replace display text that mentions VS Code specifically
      if (text.indexOf('VS Code MCP registry') !== -1) {
        a.textContent = text.replace('VS Code MCP registry', 'GitHub Copilot MCP docs');
      }
    });
  }

  var observer = new MutationObserver(function() { fixMcpLinks(); });
  observer.observe(document.body, { childList: true, subtree: true });
  fixMcpLinks();
})();
</script>";
        }
        public static string BuildLoadingHtml(string view)
        {
            string themeCss;
            try   { themeCss = BuildThemeCss(); }
            catch { themeCss = BuildFallbackThemeCss(); }
            return $@"<!DOCTYPE html>
<html lang=""en"">
<head>
<meta charset=""UTF-8"">
<meta http-equiv=""Content-Security-Policy""
      content=""default-src 'none'; style-src 'unsafe-inline';"">
<style>
{themeCss}
html, body {{
    margin: 0; padding: 0; height: 100%; overflow: hidden;
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}}
.loading {{
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    height: 100vh; gap: 16px;
}}
.spinner {{
    width: 32px; height: 32px;
    border: 3px solid var(--vscode-panel-border);
    border-top-color: var(--vscode-button-background);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
}}
@keyframes spin {{ to {{ transform: rotate(360deg); }} }}
.message {{ color: var(--vscode-descriptionForeground); font-size: 13px; }}
</style>
</head>
<body>
<div class=""loading"">
  <div class=""spinner""></div>
  <div class=""message"">Loading Copilot usage data…</div>
</div>
</body>
</html>";
        }

        /// <summary>
        /// Returns a lightweight HTML page that displays an error message when data
        /// could not be loaded.
        /// </summary>
        public static string BuildErrorHtml(string message)
        {
            string themeCss;
            try   { themeCss = BuildThemeCss(); }
            catch { themeCss = BuildFallbackThemeCss(); }
            var safeMsg   = WebUtility.HtmlEncode(message);
            return $@"<!DOCTYPE html>
<html lang=""en"">
<head>
<meta charset=""UTF-8"">
<meta http-equiv=""Content-Security-Policy""
      content=""default-src 'none'; style-src 'unsafe-inline';"">
<style>
{themeCss}
html, body {{
    margin: 0; padding: 0; height: 100%; overflow: auto;
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}}
.error-container {{
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    height: 100vh; gap: 12px; padding: 24px; box-sizing: border-box;
    text-align: center;
}}
.error-icon  {{ font-size: 32px; }}
.error-title {{ font-size: 15px; font-weight: 600; }}
.error-detail {{
    font-size: 12px; color: var(--vscode-descriptionForeground);
    max-width: 480px; white-space: pre-wrap; word-break: break-word;
}}
</style>
</head>
<body>
<div class=""error-container"">
  <div class=""error-icon"">&#x26A0;</div>
  <div class=""error-title"">Error loading Copilot usage data</div>
  <div class=""error-detail"">{safeMsg}</div>
</div>
</body>
</html>";
        }

        // ── Private helpers ────────────────────────────────────────────────────

        internal static string ViewToGlobalKey(string view)
            => view switch
            {
                "details"       => "__INITIAL_DETAILS__",
                "chart"         => "__INITIAL_CHART__",
                "usage"         => "__INITIAL_USAGE__",
                "diagnostics"   => "__INITIAL_DIAGNOSTICS__",
                "environmental" => "__INITIAL_ENVIRONMENTAL__",
                "maturity"      => "__INITIAL_MATURITY__",
                "fluency-level-viewer" => "__INITIAL_FLUENCY_LEVEL_DATA__",
                _               => "__INITIAL_DETAILS__",
            };

        /// <summary>
        /// The locale whose webview strings this host will render.
        /// </summary>
        /// <remarks>
        /// Only locales we actually ship a dictionary for are returned. Declaring
        /// the raw UI culture would label English text as, say, French and send
        /// assistive technology down the wrong pronunciation rules — the exact
        /// mismatch <c>&lt;html lang&gt;</c> exists to prevent.
        /// </remarks>
        private static string LocalizationLocale()
        {
            foreach (var candidate in LocalizationCandidates())
            {
                if (File.Exists(LocalizationFilePath(candidate))) { return candidate; }
            }
            return "en";
        }

        /// <summary>
        /// Completes the panel payload with the webview string dictionary.
        /// </summary>
        /// <remarks>
        /// The webview bundles localize themselves from <c>initialData.localization</c>.
        /// Only the VS Code extension ever supplied that, so this extension — which
        /// redistributes the very same bundles — rendered their built-in English
        /// fallback regardless of the Visual Studio display language. The dictionaries
        /// are staged next to the bundles by vscode-extension/esbuild.js.
        ///
        /// Emitted as a guarded assignment rather than merged into the JSON so it is a
        /// no-op when there is no payload, instead of creating an empty object the
        /// bundle would mistake for real data. Returns an empty string (not a broken
        /// script) when the sidecar is missing, matching BuildJsonGlobalsScript's
        /// tolerance of a first run before the webview build has produced its files.
        /// </remarks>
        private static string BuildLocalizationScript(string globalKey)
        {
            try
            {
                foreach (var candidate in LocalizationCandidates())
                {
                    var filePath = LocalizationFilePath(candidate);
                    if (!File.Exists(filePath)) { continue; }
                    var dictionary = File.ReadAllText(filePath)
                        .Replace("<", "\\u003c")
                        .Replace(">", "\\u003e");
                    return "<script>" + Environment.NewLine
                         + "(function () { var d = window." + globalKey + ";"
                         + " if (d && typeof d === 'object') { d.localization = " + dictionary + "; } })();" + Environment.NewLine
                         + "</script>";
                }
            }
            catch { /* fall through: an unlocalized panel beats a broken one */ }
            return string.Empty;
        }

        /// <summary>
        /// Display-language candidates, most specific first, always ending in English.
        /// </summary>
        /// <remarks>
        /// The exact-tag-then-bare-language list this replaced sent <c>zh-Hans</c> and
        /// <c>zh-Hans-CN</c> to English even though a <c>zh-cn</c> sidecar ships, because
        /// neither is a prefix of it (raised in review on #2138). Script decides, not
        /// region: <c>zh-SG</c> is Simplified and should get the bundle, while
        /// <c>zh-TW</c>, <c>zh-HK</c> and <c>zh-MO</c> are Traditional and must not —
        /// serving Traditional readers Simplified text is worse than serving English.
        ///
        /// Mirrors resolveLocaleId() in vscode-extension/src/l10nCore.ts, which reaches
        /// the same answer through Intl.Locale.maximize().
        /// </remarks>
        private static string[] LocalizationCandidates()
        {
            var culture = CultureInfo.CurrentUICulture;
            var candidates = new System.Collections.Generic.List<string> { culture.Name.ToLowerInvariant() };
            if (IsSimplifiedChinese(culture)) { candidates.Add("zh-cn"); }
            candidates.Add("en");
            return candidates.Distinct().ToArray();
        }

        /// <summary>
        /// True for Chinese cultures written in Simplified script.
        /// </summary>
        /// <remarks>
        /// An explicit Hans/Hant script subtag wins. With no script, the region decides:
        /// Taiwan, Hong Kong and Macau are Traditional, everything else Simplified.
        /// </remarks>
        private static bool IsSimplifiedChinese(CultureInfo culture)
        {
            if (!string.Equals(culture.TwoLetterISOLanguageName, "zh", StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }
            var parts = culture.Name.Split('-');
            foreach (var part in parts)
            {
                if (string.Equals(part, "Hans", StringComparison.OrdinalIgnoreCase)) { return true; }
                if (string.Equals(part, "Hant", StringComparison.OrdinalIgnoreCase)) { return false; }
            }
            var region = parts.Length > 1 ? parts[parts.Length - 1].ToUpperInvariant() : string.Empty;
            return region != "TW" && region != "HK" && region != "MO";
        }

        private static string LocalizationFilePath(string locale)
        {
            return Path.Combine(
                Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location)!,
                "webview",
                "localization." + locale + ".json");
        }

        /// <summary>
        /// Reads the JSON config sidecar files from the installed webview directory and
        /// returns an inline &lt;script&gt; block that sets the corresponding window globals.
        /// The webview bundles read these globals instead of bundling the JSON inline.
        /// Falls back gracefully if any file is missing (e.g. first run before build).
        /// </summary>
        private static string BuildJsonGlobalsScript()
        {
            try
            {
                var webviewDir = Path.Combine(
                    Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location)!,
                    "webview");

                var entries = new (string file, string key)[]
                {
                    ("tokenEstimators.json", "__TOKEN_ESTIMATORS__"),
                    ("modelPricing.json",    "__MODEL_PRICING__"),
                    ("toolNames.json",       "__TOOL_NAMES__"),
                    ("automaticTools.json",  "__AUTOMATIC_TOOLS__"),
                };

                var sb = new System.Text.StringBuilder("<script>\n");
                foreach (var (file, key) in entries)
                {
                    var filePath = Path.Combine(webviewDir, file);
                    if (!File.Exists(filePath)) { continue; }
                    var content = File.ReadAllText(filePath)
                        .Replace("<", "\\u003c")
                        .Replace(">", "\\u003e");
                    sb.AppendLine($"window.{key} = {content};");
                }
                sb.Append("</script>");
                return sb.ToString();
            }
            catch
            {
                return "<!-- JSON config globals unavailable -->";
            }
        }

        private static string LoadShim()
        {
            var asm  = Assembly.GetExecutingAssembly();
            // Resource name = default namespace + relative path with '.' separators
            using var stream = asm.GetManifestResourceStream(
                "AIEngineeringFluency.WebBridge.vscode-shim.js");

            if (stream == null) { return "/* vscode-shim.js not found */"; }

            using var reader = new StreamReader(stream);
            return reader.ReadToEnd();
        }

        // ── Theme CSS ──────────────────────────────────────────────────────────

        /// <summary>
        /// Returns CSS using only hardcoded dark-theme fallback values.
        /// Used when the VS Shell assembly is not available (e.g. unit tests).
        /// </summary>
        private static string BuildFallbackThemeCss() => @":root {
    --vscode-editor-background:              #1e1e1e;
    --vscode-editor-foreground:              #d4d4d4;
    --vscode-sideBar-background:             #252526;
    --vscode-editorWidget-background:        #252526;
    --vscode-descriptionForeground:          #808080;
    --vscode-disabledForeground:             #6b6b6b;
    --vscode-panel-border:                   #3f3f46;
    --vscode-widget-border:                  #3f3f46;
    --vscode-button-background:              #0e639c;
    --vscode-button-foreground:              #ffffff;
    --vscode-button-hoverBackground:         #1177bb;
    --vscode-button-secondaryBackground:     #3a3d41;
    --vscode-button-secondaryForeground:     #d4d4d4;
    --vscode-button-secondaryHoverBackground:#45494e;
    --vscode-badge-background:               #0e639c;
    --vscode-badge-foreground:               #ffffff;
    --vscode-focusBorder:                    #0e639c;
    --vscode-list-hoverBackground:           #2a2d2e;
    --vscode-list-activeSelectionBackground: #094771;
    --vscode-list-activeSelectionForeground: #ffffff;
    --vscode-textLink-foreground:            #4fc3f7;
    --vscode-textLink-activeForeground:      #4fc3f7;
    --vscode-charts-foreground:              #d4d4d4;
    --vscode-charts-lines:                   #3f3f46;
    --vscode-charts-red:    #f48771;
    --vscode-charts-blue:   #75beff;
    --vscode-charts-yellow: #cca700;
    --vscode-charts-orange: #d18616;
    --vscode-charts-green:  #89d185;
    --vscode-charts-purple: #b180d7;
}";

        private static string BuildThemeCss()
        {
            // Attempt to read VS environment colours via the PlatformUI API.
            // Fall back to sensible dark-theme defaults on any failure.
            var bg        = TryGetVsColor(
                                Microsoft.VisualStudio.PlatformUI.EnvironmentColors.ToolWindowBackgroundColorKey,
                                "#1e1e1e");
            var fg        = TryGetVsColor(
                                Microsoft.VisualStudio.PlatformUI.EnvironmentColors.ToolWindowTextColorKey,
                                "#d4d4d4");
            var sidebarBg = TryGetVsColor(
                                Microsoft.VisualStudio.PlatformUI.EnvironmentColors.EnvironmentBackgroundColorKey,
                                "#252526");
            var border    = TryGetVsColor(
                                Microsoft.VisualStudio.PlatformUI.EnvironmentColors.PanelBorderColorKey,
                                "#3f3f46");
            var btnBg     = TryGetVsColor(
                                Microsoft.VisualStudio.PlatformUI.EnvironmentColors.CommandBarMouseOverBackgroundBeginColorKey,
                                "#0e639c");

            return $@":root {{
    --vscode-editor-background:              {bg};
    --vscode-editor-foreground:              {fg};
    --vscode-sideBar-background:             {sidebarBg};
    --vscode-editorWidget-background:        {sidebarBg};
    --vscode-descriptionForeground:          #808080;
    --vscode-disabledForeground:             #6b6b6b;
    --vscode-panel-border:                   {border};
    --vscode-widget-border:                  {border};
    --vscode-button-background:              {btnBg};
    --vscode-button-foreground:              #ffffff;
    --vscode-button-hoverBackground:         #1177bb;
    --vscode-button-secondaryBackground:     #3a3d41;
    --vscode-button-secondaryForeground:     {fg};
    --vscode-button-secondaryHoverBackground:#45494e;
    --vscode-badge-background:               {btnBg};
    --vscode-badge-foreground:               #ffffff;
    --vscode-focusBorder:                    {btnBg};
    --vscode-list-hoverBackground:           #2a2d2e;
    --vscode-list-activeSelectionBackground: #094771;
    --vscode-list-activeSelectionForeground: #ffffff;
    --vscode-textLink-foreground:            #4fc3f7;
    --vscode-textLink-activeForeground:      #4fc3f7;
    --vscode-charts-foreground:              {fg};
    --vscode-charts-lines:                   {border};
    --vscode-charts-red:    #f48771;
    --vscode-charts-blue:   #75beff;
    --vscode-charts-yellow: #cca700;
    --vscode-charts-orange: #d18616;
    --vscode-charts-green:  #89d185;
    --vscode-charts-purple: #b180d7;
}}";
        }

        /// <summary>
        /// Queries the VS theme service for a colour, returns <paramref name="fallback"/> on failure.
        /// Must be called on the UI thread (or will simply fall back).
        /// </summary>
        private static string TryGetVsColor(Microsoft.VisualStudio.Shell.ThemeResourceKey colorKey, string fallback)
        {
            try
            {
                var color = Microsoft.VisualStudio.PlatformUI.VSColorTheme.GetThemedColor(colorKey);
                return $"#{color.R:X2}{color.G:X2}{color.B:X2}";
            }
            catch
            {
                return fallback;
            }
        }
    }
}
