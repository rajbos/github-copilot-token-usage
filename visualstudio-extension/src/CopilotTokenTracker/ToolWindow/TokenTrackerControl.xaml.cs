using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using CopilotTokenTracker.Data;
using CopilotTokenTracker.WebBridge;
using Microsoft.VisualStudio.Shell;
using Microsoft.Web.WebView2.Core;

namespace CopilotTokenTracker.ToolWindow
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
                    "CopilotTokenTracker-WebView2");
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

                _webViewReady       = true;
                WebView.Visibility  = Visibility.Visible;
                FallbackText.Visibility = Visibility.Collapsed;

                // Pre-load all view data with a single CLI call to eliminate per-view spinners
                await PrewarmAllViewsAsync();

                // Navigate to the initial view — served instantly from the prewarmed cache
                _currentView = "details";
                if (_viewHtmlCache.TryGetValue("details", out var initialHtml))
                {
                    await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
                    WebView.CoreWebView2.NavigateToString(initialHtml);
                    Utilities.OutputLogger.Log("Initial view loaded from prewarmed cache");
                }
                else
                {
                    // Fallback: prewarming failed, load the details view individually
                    await RefreshAsync();
                }
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
        }

        // ── Data fetching ──────────────────────────────────────────────────────

        /// <summary>
        /// Fetches all view data in a single CLI call and pre-populates <see cref="_viewHtmlCache"/>
        /// for every view. After this completes, navigating between views is instant —
        /// no per-view spinner is shown.
        /// </summary>
        private async Task PrewarmAllViewsAsync()
        {
            Utilities.OutputLogger.Log("Prewarming all views with a single CLI call…");

            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
            FallbackText.Text       = "Loading…";
            FallbackText.Visibility = Visibility.Visible;

            try
            {
                // One CLI invocation fetches data for every view and populates all caches
                await CliBridge.GetAllDataAsync();

                // Build and cache the HTML for each view using the freshly populated caches
                var views = new[] { "details", "chart", "usage", "environmental", "maturity" };
                foreach (var view in views)
                {
                    try
                    {
                        var statsJson = await FetchStatsJsonAsync(view);
                        _viewHtmlCache[view] = ThemedHtmlBuilder.Build(view, statsJson);
                        Utilities.OutputLogger.Log($"Prewarmed view: {view}");
                    }
                    catch (Exception ex)
                    {
                        Utilities.OutputLogger.LogWarning($"Failed to prewarm view '{view}': {ex.Message}");
                    }
                }

                await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
                FallbackText.Visibility = Visibility.Collapsed;
                Utilities.OutputLogger.Log("All views prewarmed successfully");
            }
            catch (Exception ex)
            {
                Utilities.OutputLogger.LogError("PrewarmAllViewsAsync: failed", ex);
                await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
                FallbackText.Text = $"Error loading token data:\n{ex.Message}";
            }
        }

        private static async Task<string> FetchStatsJsonAsync(string view)
        {
            var serOpts = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

            switch (view)
            {
                case "chart":
                {
                    var raw = await CliBridge.GetChartDataJsonAsync();
                    if (!string.IsNullOrWhiteSpace(raw)) { return raw!; }
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
                        locale = "en-US",
                        lastUpdated = DateTime.UtcNow.ToString("o"),
                        backendConfigured = false,
                    }, serOpts);
                }
                case "environmental":
                {
                    var envStats = await StatsBuilder.BuildEnvironmentalAsync();
                    return JsonSerializer.Serialize(envStats, serOpts);
                }
                case "maturity":
                {
                    var maturity = await StatsBuilder.BuildMaturityAsync();
                    return JsonSerializer.Serialize(maturity, serOpts);
                }
                default:
                {
                    var stats = await StatsBuilder.BuildAsync() ?? new DetailedStats
                    {
                        LastUpdated = DateTime.UtcNow.ToString("o"),
                    };
                    return JsonSerializer.Serialize(stats, serOpts);
                }
            }
        }

        // ── Loading overlay & navigation ──────────────────────────────────────

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

                        default:
                            Utilities.OutputLogger.LogWarning($"Unknown WebMessage command: {cmd}");
                            break;
                    }
                });
            }
            catch (Exception parseEx) { Utilities.OutputLogger.LogWarning($"OnWebMessageReceived: malformed message — {parseEx.Message}"); }
        }
    }
}
