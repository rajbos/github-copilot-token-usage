using System;
using System.IO;
using System.Net;
using System.Reflection;

namespace CopilotTokenTracker.WebBridge
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
            var themeCss  = BuildThemeCss();
            var globalKey = ViewToGlobalKey(view);

            // Prevent </script> injection in the JSON payload (OWASP XSS defence)
            var safeJson = statsJson.Replace("<", "\\u003c").Replace(">", "\\u003e");

            return $@"<!DOCTYPE html>
<html lang=""en"">
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
</style>
<script>
{shim}
</script>
<script>
window.{globalKey} = {safeJson};
</script>
</head>
<body>
<div id=""root""></div>
<script src=""https://copilot-tracker.local/{view}.js""></script>
</body>
</html>";
        }

        /// <summary>
        /// Returns a lightweight HTML page that shows a spinner while data is loading.
        /// No external scripts are required, so it renders instantly.
        /// </summary>
        public static string BuildLoadingHtml(string view)
        {
            var themeCss = BuildThemeCss();
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
            var themeCss  = BuildThemeCss();
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

        private static string ViewToGlobalKey(string view)
            => view switch
            {
                "details"       => "__INITIAL_DETAILS__",
                "chart"         => "__INITIAL_CHART__",
                "usage"         => "__INITIAL_USAGE__",
                "diagnostics"   => "__INITIAL_DIAGNOSTICS__",
                "environmental" => "__INITIAL_ENVIRONMENTAL__",
                "maturity"      => "__INITIAL_MATURITY__",
                _               => "__INITIAL_DETAILS__",
            };

        private static string LoadShim()
        {
            var asm  = Assembly.GetExecutingAssembly();
            // Resource name = default namespace + relative path with '.' separators
            using var stream = asm.GetManifestResourceStream(
                "CopilotTokenTracker.WebBridge.vscode-shim.js");

            if (stream == null) { return "/* vscode-shim.js not found */"; }

            using var reader = new StreamReader(stream);
            return reader.ReadToEnd();
        }

        // ── Theme CSS ──────────────────────────────────────────────────────────

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
