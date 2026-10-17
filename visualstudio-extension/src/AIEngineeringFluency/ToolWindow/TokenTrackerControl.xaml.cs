using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using AIEngineeringFluency.Data;
using AIEngineeringFluency.WebBridge;
using Microsoft.VisualStudio.Shell;
using Microsoft.Web.WebView2.Core;

namespace AIEngineeringFluency.ToolWindow
{
    public partial class TokenTrackerControl : UserControl
    {
        private bool   _webViewReady;
        private string _currentView = "details";

        /// <summary>
        /// Last rendered HTML per view name.  Populated by <see cref="RefreshAsync"/>;
        /// served instantly on navigation so the user never waits for a redundant CLI call.
        /// </summary>
        private readonly Dictionary<string, string> _viewHtmlCache = new Dictionary<string, string>();

        public TokenTrackerControl()
        {
            InitializeComponent();
            Loaded += OnLoaded;
        }

        // ── Initialisation ──────────────────────────────────────────────────────

        private void OnLoaded(object sender, RoutedEventArgs e)
        {
            Loaded -= OnLoaded;
            // Use JoinableTaskFactory.RunAsync (VS threading best practice, avoids VSTHRD100/VSTHRD001)
            _ = ThreadHelper.JoinableTaskFactory.RunAsync(async () =>
            {
                try   { await InitWebViewAsync(); }
                catch (Exception ex) { FallbackText.Text = $"WebView2 initialisation failed:\n{ex.Message}"; }
            });
        }

        private async Task InitWebViewAsync()
        {
            try
            {
                // Use a writable user-data folder so WebView2 works inside the
                // VS experimental instance (the default location is often denied).
                var userDataFolder = Path.Combine(
                    Path.GetTempPath(),
                    "AIEngineeringFluency-WebView2");
                var env = await CoreWebView2Environment.CreateAsync(
                    userDataFolder: userDataFolder);

                await WebView.EnsureCoreWebView2Async(env);

                // Disable unnecessary browser chrome
                WebView.CoreWebView2.Settings.IsStatusBarEnabled          = false;
                WebView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
                WebView.CoreWebView2.Settings.AreDevToolsEnabled           = true; // useful while developing

                // Map virtual host → folder containing the bundled .js files
                var webviewDir = Path.Combine(
                    Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location)!,
                    "webview");

                if (Directory.Exists(webviewDir))
                {
                    WebView.CoreWebView2.SetVirtualHostNameToFolderMapping(
                        "copilot-tracker.local",
                        webviewDir,
                        CoreWebView2HostResourceAccessKind.Allow);
                }

                // Handle navigation commands posted by JS (e.g. tab switches)
                WebView.CoreWebView2.WebMessageReceived += OnWebMessageReceived;

                // Open external http(s) links (e.g. the "create an issue" repo link and
                // social-share targets) in the user's system browser instead of inside the
                // tool window. Covers both target=_blank/window.open (NewWindowRequested) and
                // plain top-level anchor navigations (NavigationStarting).
                WebView.CoreWebView2.NewWindowRequested   += OnNewWindowRequested;
                WebView.CoreWebView2.NavigationStarting   += OnNavigationStarting;

                _webViewReady       = true;
                WebView.Visibility  = Visibility.Visible;
                FallbackText.Visibility = Visibility.Collapsed;

                // Warm all CLI caches in one shot via `all --json` before loading any view.
                // Individual view calls that follow will return from in-memory cache.
                await CliBridge.GetAllDataAsync();

                // Show the details view as soon as usage stats are available (may use the
                // in-memory cache from the toolbar timer that fires 3 s after extension load).
                _currentView = "details";
                await RefreshAsync();

                // Kick off sequential background preloading of all other views so they
                // are cached and spinner-free by the time the user navigates to them.
                _ = ThreadHelper.JoinableTaskFactory.RunAsync(() => BackgroundPreloadOtherViewsAsync());
            }
            catch (Exception ex)
            {
                FallbackText.Text = $"WebView2 initialisation failed:\n{ex.Message}\n\n"
                                  + "Make sure the WebView2 Runtime is installed.";
            }
        }

        // ── Public API ─────────────────────────────────────────────────────────

        public async Task RefreshAsync()
        {
            if (!_webViewReady) { return; }

            Utilities.OutputLogger.Log($"Loading view: {_currentView}");

            // Show a text overlay while data is loading.  We deliberately avoid
            // calling NavigateToString here so we don't trigger a navigation that
            // immediately gets cancelled, which leaves WebView2 in a black state.
            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
            FallbackText.Text       = "Loading…";
            FallbackText.Visibility = Visibility.Visible;

            try
            {
                var statsJson = await FetchStatsJsonAsync(_currentView);
                var html      = ThemedHtmlBuilder.Build(_currentView, statsJson);

                // Store in cache so subsequent navigations to this view are instant
                _viewHtmlCache[_currentView] = html;

                await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
                WebView.CoreWebView2.NavigateToString(html);
                FallbackText.Visibility = Visibility.Collapsed;
                Utilities.OutputLogger.Log($"View loaded: {_currentView}");
            }
            catch (Exception ex)
            {
                Utilities.OutputLogger.LogError($"RefreshAsync: failed to load view '{_currentView}'", ex);
                await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
                FallbackText.Text = $"Error loading token data:\n{ex.Message}";
            }
        }

        /// <summary>
        /// Resets the current view back to the default (details) and refreshes.
        /// Use this when a view is stuck or rendering incorrectly.
        /// </summary>
        public async Task ResetViewAsync()
        {
            Utilities.OutputLogger.Log($"Resetting view (was: {_currentView}) → details");
            _viewHtmlCache.Clear(); // discard all cached HTML so next navigation fetches fresh data
            _currentView = "details";
            await RefreshAsync();

            // Restart background preloading so all tabs are warm after the reset
            _ = ThreadHelper.JoinableTaskFactory.RunAsync(() => BackgroundPreloadOtherViewsAsync());
        }

        // ── Data fetching ──────────────────────────────────────────────────────

        /// <summary>
        /// Runs after the initial details view is shown. Loads the remaining views one by one
        /// in the background so they are cached and spinner-free when the user navigates to them.
        /// The CLI's on-disk session cache is already warm from the initial <c>usage --json</c>
        /// call, so each subsequent command completes much faster than the first run.
        /// </summary>
        private async Task BackgroundPreloadOtherViewsAsync()
        {
            // Order matches most-likely navigation order: usage → chart → maturity → environmental
            var views = new[] { "usage", "chart", "maturity", "environmental" };
            foreach (var view in views)
            {
                if (_viewHtmlCache.ContainsKey(view)) { continue; }
                try
                {
                    Utilities.OutputLogger.Log($"Background preloading view: {view}");
                    var statsJson = await FetchStatsJsonAsync(view);
                    _viewHtmlCache[view] = ThemedHtmlBuilder.Build(view, statsJson);
                    Utilities.OutputLogger.Log($"Background preloaded view: {view}");
                }
                catch (Exception ex)
                {
                    Utilities.OutputLogger.LogWarning($"BackgroundPreload: failed to preload view '{view}': {ex.Message}");
                }
            }
            Utilities.OutputLogger.Log("Background preloading complete — all views cached");
        }

        private static async Task<string> FetchStatsJsonAsync(string view)
        {
            var serOpts = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

            switch (view)
            {
                case "chart":
                {
                    var raw = await CliBridge.GetChartDataJsonAsync();
                    if (!string.IsNullOrWhiteSpace(raw)) { return InjectCompactNumbers(raw!); }
                    // Fallback: empty chart payload
                    return JsonSerializer.Serialize(new
                    {
                        labels = Array.Empty<string>(),
                        tokensData = Array.Empty<int>(),
                        sessionsData = Array.Empty<int>(),
                        modelDatasets = Array.Empty<object>(),
                        editorDatasets = Array.Empty<object>(),
                        editorTotalsMap = new { },
                        repositoryDatasets = Array.Empty<object>(),
                        repositoryTotalsMap = new { },
                        dailyCount = 0,
                        totalTokens = 0,
                        avgTokensPerDay = 0,
                        totalSessions = 0,
                        lastUpdated = DateTime.UtcNow.ToString("o"),
                        backendConfigured = false,
                    }, serOpts);
                }
                case "usage":
                {
                    var raw = await CliBridge.GetUsageAnalysisJsonAsync();
                    if (!string.IsNullOrWhiteSpace(raw)) { return raw!; }
                    // Fallback: empty usage payload
                    return JsonSerializer.Serialize(new
                    {
                        today = new { },
                        last30Days = new { },
                        month = new { },
                        lastMonth = new { },
                        locale = "en-US",
                        lastUpdated = DateTime.UtcNow.ToString("o"),
                        backendConfigured = false,
                    }, serOpts);
                }
                case "environmental":
                {
                    var envStats = await StatsBuilder.BuildEnvironmentalAsync();
                    envStats.CompactNumbers = Options.ExtensionSettings.CompactNumbers;
                    return JsonSerializer.Serialize(envStats, serOpts);
                }
                case "maturity":
                {
                    var maturity = await StatsBuilder.BuildMaturityAsync();
                    return JsonSerializer.Serialize(maturity, serOpts);
                }
                case "fluency-level-viewer":
                {
                    return BuildFluencyLevelJson();
                }
                default:
                {
                    var stats = await StatsBuilder.BuildAsync() ?? new DetailedStats
                    {
                        LastUpdated = DateTime.UtcNow.ToString("o"),
                    };
                    stats.CompactNumbers = Options.ExtensionSettings.CompactNumbers;
                    return JsonSerializer.Serialize(stats, serOpts);
                }
            }
        }

        /// <summary>
        /// Builds the Scoring Guide payload from the <c>fluencyLevelData.json</c> rubric
        /// staged next to the assembly. The rubric is static reference data — the same file
        /// the fluency scores are calculated against — so it needs no CLI round trip; only
        /// the <c>backendConfigured</c> flag (which gates the Team Dashboard nav button)
        /// comes from the cached stats.
        /// </summary>
        /// <returns>
        /// The view's initial JSON, or the literal <c>null</c> when the rubric file is
        /// missing or malformed — the webview renders "No data available." for that rather
        /// than throwing on an empty category list.
        /// </returns>
        private static string BuildFluencyLevelJson()
        {
            try
            {
                var rubricPath = Path.Combine(
                    Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location)!,
                    "webview",
                    "fluencyLevelData.json");

                if (!File.Exists(rubricPath))
                {
                    Utilities.OutputLogger.LogWarning($"Scoring Guide: rubric not found at {rubricPath}");
                    return "null";
                }

                if (JsonNode.Parse(File.ReadAllText(rubricPath)) is not JsonArray categories)
                {
                    Utilities.OutputLogger.LogWarning("Scoring Guide: rubric is not a JSON array");
                    return "null";
                }

                return new JsonObject
                {
                    ["categories"]        = categories,
                    ["isDebugMode"]       = false,
                    ["backendConfigured"] = CliBridge.GetCachedStats()?.BackendConfigured ?? false,
                }.ToJsonString();
            }
            catch (Exception ex)
            {
                Utilities.OutputLogger.LogError($"Scoring Guide: failed to build payload: {ex.Message}");
                return "null";
            }
        }

        // ── Loading overlay & navigation ──────────────────────────────────────

        /// <summary>
        /// Adds (or overrides) the top-level <c>compactNumbers</c> flag on a raw JSON object
        /// string emitted by the CLI, so settings honour the user's preference for views whose
        /// payload is passed through verbatim (e.g. chart). Falls back to the original string
        /// when the JSON cannot be parsed.
        /// </summary>
        private static string InjectCompactNumbers(string rawJson)
        {
            try
            {
                if (JsonNode.Parse(rawJson) is JsonObject obj)
                {
                    obj["compactNumbers"] = Options.ExtensionSettings.CompactNumbers;
                    return obj.ToJsonString();
                }
            }
            catch (JsonException)
            {
                // Malformed JSON — return as-is so the webview still renders something.
            }
            return rawJson;
        }


        /// <summary>
        /// Injects a full-page spinner overlay into the currently visible WebView page.
        /// The overlay disappears naturally when NavigateToString replaces the page.
        /// </summary>
        private async Task ShowLoadingOverlayAsync()
        {
            if (!_webViewReady) { return; }
            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
            await WebView.CoreWebView2.ExecuteScriptAsync(
                "(function(){" +
                "  if(document.getElementById('__vs-loading-overlay__')){return;}" +
                "  var s=document.createElement('style');" +
                "  s.textContent='@keyframes __vs-spin__{to{transform:rotate(360deg)}}';" +
                "  document.head.appendChild(s);" +
                "  var o=document.createElement('div');" +
                "  o.id='__vs-loading-overlay__';" +
                "  o.style.cssText='position:fixed;inset:0;background:rgba(20,20,20,0.82);display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:99999;pointer-events:none;';" +
                "  o.innerHTML='<div style=\"width:28px;height:28px;border:3px solid #555;border-top-color:#ccc;border-radius:50%;animation:__vs-spin__ 0.7s linear infinite;\"></div>" +
                "<div style=\"margin-top:10px;font-size:13px;color:#bbb;font-family:sans-serif;\">Loading\u2026</div>';" +
                "  document.body.appendChild(o);" +
                "})();");
        }

        /// <summary>Shows loading overlay, changes the current view, then refreshes.</summary>
        private async Task NavigateToViewAsync(string view)
        {
            _currentView = view;

            // If we have cached HTML for this view, render it instantly without hitting the CLI
            if (_viewHtmlCache.TryGetValue(view, out var cachedHtml))
            {
                Utilities.OutputLogger.Log($"Serving cached HTML for view: {view}");
                await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
                WebView.CoreWebView2.NavigateToString(cachedHtml);
                return;
            }

            // First visit — show spinner and fetch fresh data
            await ShowLoadingOverlayAsync();
            await RefreshAsync();
        }

        // ── Incoming messages from JS ──────────────────────────────────────────

        /// <summary>Virtual host the bundled webview assets are served from.</summary>
        private const string VirtualHost = "copilot-tracker.local";

        /// <summary>
        /// Opens target=_blank / window.open links in the system browser rather than a popup.
        /// </summary>
        private void OnNewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs e)
        {
            e.Handled = true;
            OpenInBrowser(e.Uri);
        }

        /// <summary>
        /// Intercepts top-level anchor navigations to external pages and opens them in the
        /// system browser, keeping the tool window on the dashboard. Navigations to the bundled
        /// virtual host (and non-http schemes used by NavigateToString) are allowed through.
        /// </summary>
        private void OnNavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)
        {
            var uri = e.Uri ?? string.Empty;
            if (!uri.StartsWith("http://", StringComparison.OrdinalIgnoreCase) &&
                !uri.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
            {
                return; // about:, data:, etc. — let WebView2 handle it
            }
            if (uri.IndexOf(VirtualHost, StringComparison.OrdinalIgnoreCase) >= 0)
            {
                return; // our own bundle assets
            }
            e.Cancel = true;
            OpenInBrowser(uri);
        }

        /// <summary>
        /// Methodology links the environmental view may ask to open, by id. Mirrors
        /// <c>ENVIRONMENTAL_METHODOLOGY_SOURCES</c> in <c>src/environmentalImpact.ts</c>;
        /// <c>environmentalImpact.test.ts</c> fails if the two drift apart.
        /// </summary>
        private static readonly System.Collections.Generic.IReadOnlyDictionary<string, string> EnvironmentalMethodologySources =
            new System.Collections.Generic.Dictionary<string, string>
            {
                ["paper"] = "https://arxiv.org/abs/2505.09598",
                ["neuland"] = "https://github.com/neuland/tokendashboard-backend/blob/main/docs/co2-methodology.md",
            };

        /// <summary>Launches <paramref name="url"/> in the default system browser.</summary>
        private static void OpenInBrowser(string url)
        {
            if (string.IsNullOrWhiteSpace(url)) { return; }
            try
            {
                System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(url)
                {
                    UseShellExecute = true,
                });
                Utilities.OutputLogger.Log($"Opened external link: {url}");
            }
            catch (Exception ex)
            {
                Utilities.OutputLogger.LogWarning($"Failed to open external link '{url}': {ex.Message}");
            }
        }

        private void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            try
            {
                using var doc  = JsonDocument.Parse(e.WebMessageAsJson);
                var root = doc.RootElement;

                if (!root.TryGetProperty("command", out var cmdProp)) { return; }

                _ = ThreadHelper.JoinableTaskFactory.RunAsync(async () =>
                {
                    var cmd = cmdProp.GetString();
                    Utilities.OutputLogger.Log($"WebMessage received: {cmd} (current view: {_currentView})");

                    switch (cmd)
                    {
                        case "refresh":
                            await RefreshAsync();
                            break;

                        case "showDetails":
                            await NavigateToViewAsync("details");
                            break;

                        case "showChart":
                            await NavigateToViewAsync("chart");
                            break;

                        case "showUsageAnalysis":
                            await NavigateToViewAsync("usage");
                            break;

                        case "showDiagnostics":
                            // Diagnostics view is not supported in Visual Studio — redirect to details
                            Utilities.OutputLogger.LogWarning("Diagnostics view is not supported in Visual Studio; redirecting to details");
                            await NavigateToViewAsync("details");
                            break;

                        case "showEnvironmental":
                            await NavigateToViewAsync("environmental");
                            break;

                        case "showMaturity":
                            await NavigateToViewAsync("maturity");
                            break;

                        case "showFluencyLevelViewer":
                            await NavigateToViewAsync("fluency-level-viewer");
                            break;

                        case "shareToLinkedIn":
                            await ShareFluencyScoreAsync("linkedin");
                            break;

                        case "shareToBluesky":
                            await ShareFluencyScoreAsync("bluesky");
                            break;

                        case "shareToMastodon":
                            await ShareFluencyScoreAsync("mastodon");
                            break;

                        case "showDashboard":
                            // Dashboard view not yet implemented — fall back to details
                            await NavigateToViewAsync("details");
                            break;

                        case "jsError":
                        {
                            var jsMsg = root.TryGetProperty("message", out var jsMsgProp) ? jsMsgProp.GetString() : "(no message)";
                            var jsSrc = root.TryGetProperty("source",  out var jsSrcProp)  ? jsSrcProp.GetString()  : "";
                            var jsLine = root.TryGetProperty("line",   out var jsLineProp) ? jsLineProp.GetInt32()  : 0;
                            Utilities.OutputLogger.LogError($"WebView JS error in view '{_currentView}': {jsMsg} at {jsSrc}:{jsLine}");
                            break;
                        }

                        case "openMethodologySource":
                        {
                            // Fixed id -> URL lookup: the webview never supplies the address itself.
                            var source = root.TryGetProperty("source", out var sourceProp) ? sourceProp.GetString() : null;
                            if (source != null && EnvironmentalMethodologySources.TryGetValue(source, out var sourceUrl))
                            {
                                OpenInBrowser(sourceUrl);
                            }
                            break;
                        }

                        // Diagnostic/handshake-only messages posted by the shared VS Code webview bundles.
                        // The VS Code host consumes these (readiness signalling, extension-point telemetry);
                        // the Visual Studio host has no equivalent surface, so they are intentionally no-ops
                        // here rather than falling through to the "unknown command" warning below.
                        case "usageWebviewReady":
                        case "usageWebviewTrace":
                        case "extensionPointAction":
                            break;

                        default:
                            Utilities.OutputLogger.LogWarning($"Unknown WebMessage command: {cmd}");
                            break;
                    }
                });
            }
            catch (Exception parseEx) { Utilities.OutputLogger.LogWarning($"OnWebMessageReceived: malformed message — {parseEx.Message}"); }
        }

        /// <summary>
        /// Replicates the VS Code "share fluency score" flow: builds a summary from the cached
        /// maturity data, copies it to the clipboard, and opens the target platform's compose /
        /// share page in the system browser for the user to paste into.
        /// </summary>
        private async Task ShareFluencyScoreAsync(string platform)
        {
            const string marketplaceUrl = "https://marketplace.visualstudio.com/items?itemName=RobBos.ai-engineering-fluency";
            const string hashtag = "#CopilotFluencyScore";

            var maturity = await CliBridge.GetMaturityAsync();
            var overall  = string.IsNullOrEmpty(maturity?.OverallLabel) ? "Stage 1: AI Skeptic" : maturity!.OverallLabel;
            var categoryScores = maturity?.Categories != null
                ? string.Join("\n", maturity.Categories.Select(c => $"{c.Icon} {c.Category}: Stage {c.Stage}"))
                : string.Empty;

            var shareText =
                "🎯 My AI Engineering Fluency Score\n\n" +
                $"Overall: {overall}\n\n" +
                (string.IsNullOrEmpty(categoryScores) ? string.Empty : categoryScores + "\n\n") +
                "Track your Copilot usage and level up your AI-assisted development skills!\n\n" +
                $"Get the extension: {marketplaceUrl}\n\n" +
                hashtag;

            string shareUrl;
            string platformName;
            switch (platform)
            {
                case "linkedin":
                    shareUrl     = $"https://www.linkedin.com/sharing/share-offsite/?url={Uri.EscapeDataString(marketplaceUrl)}";
                    platformName = "LinkedIn";
                    break;
                case "bluesky":
                    shareUrl     = "https://bsky.app/intent/compose";
                    platformName = "Bluesky";
                    break;
                case "mastodon":
                    shareUrl     = "https://mastodon.social/share";
                    platformName = "Mastodon";
                    break;
                default:
                    return;
            }

            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
            try { System.Windows.Clipboard.SetText(shareText); }
            catch (Exception ex) { Utilities.OutputLogger.LogWarning($"Clipboard copy failed: {ex.Message}"); }

            OpenInBrowser(shareUrl);
            Utilities.OutputLogger.Log($"Shared fluency score to {platformName} (text copied to clipboard)");
        }
    }
}
