using System;
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

                await RefreshAsync();
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

            FallbackText.Text       = "Refreshing data…";
            FallbackText.Visibility = Visibility.Visible;

            try
            {
                var stats    = await StatsBuilder.BuildAsync();
                var statsJson = JsonSerializer.Serialize(stats, new JsonSerializerOptions
                {
                    PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
                });

                var html = ThemedHtmlBuilder.Build(_currentView, statsJson);
                WebView.CoreWebView2.NavigateToString(html);

                FallbackText.Visibility = Visibility.Collapsed;
            }
            catch (Exception ex)
            {
                FallbackText.Text = $"Error loading token data:\n{ex.Message}";
            }
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
                    switch (cmdProp.GetString())
                    {
                        case "refresh":
                            await RefreshAsync();
                            break;

                        case "showDetails":
                            _currentView = "details";
                            await RefreshAsync();
                            break;

                        case "showChart":
                            _currentView = "chart";
                            await RefreshAsync();
                            break;

                        case "showUsageAnalysis":
                            _currentView = "usage";
                            await RefreshAsync();
                            break;

                        case "showDiagnostics":
                            _currentView = "diagnostics";
                            await RefreshAsync();
                            break;
                    }
                });
            }
            catch { /* ignore malformed messages */ }
        }
    }
}
