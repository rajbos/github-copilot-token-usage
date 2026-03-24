using System;
using System.ComponentModel.Design;
using System.Globalization;
using System.Threading;
using CopilotTokenTracker.Data;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Shell.Interop;
using Task = System.Threading.Tasks.Task;

namespace CopilotTokenTracker.Commands
{
    /// <summary>
    /// Shows token usage in both the VS status bar (bottom) and the custom toolbar.
    ///
    /// The status bar text is re-applied every 10 seconds because VS frequently
    /// overwrites it with "Ready". Stats are fetched every 5 minutes; the cached
    /// text is written to the status bar on the faster cadence.
    /// </summary>
    internal sealed class ToolbarInfoCommand
    {
        public static readonly Guid CommandSet = new Guid(ShowTokenTrackerCommand.CommandSetGuidString);
        public const int CommandId = 0x0200;

        private static readonly TimeSpan StatsRefreshInterval = TimeSpan.FromMinutes(5);
        private static readonly TimeSpan StatusBarTickInterval = TimeSpan.FromSeconds(10);

        private readonly AsyncPackage _package;
        private readonly OleMenuCommand _menuCommand;
        private Timer? _statsTimer;
        private Timer? _statusBarTimer;

        /// <summary>Cached text written to the status bar on every tick.</summary>
        private volatile string _statusText = "Copilot: loading\u2026";

        private ToolbarInfoCommand(AsyncPackage package, OleMenuCommandService commandService)
        {
            _package = package ?? throw new ArgumentNullException(nameof(package));

            var id = new CommandID(CommandSet, CommandId);
            _menuCommand = new OleMenuCommand(OnClick, id);
            commandService.AddCommand(_menuCommand);

            // Fetch stats after a short delay, then every 5 minutes
            _statsTimer = new Timer(
                _ => _package.JoinableTaskFactory.RunAsync(async () => await RefreshStatsAsync()),
                null,
                TimeSpan.FromSeconds(3),
                StatsRefreshInterval);

            // Re-apply cached text to the status bar every 10 seconds
            _statusBarTimer = new Timer(
                _ => _package.JoinableTaskFactory.RunAsync(async () => await WriteStatusBarAsync()),
                null,
                TimeSpan.FromSeconds(5),
                StatusBarTickInterval);
        }

        public static async Task InitializeAsync(AsyncPackage package)
        {
            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync(package.DisposalToken);
            Utilities.OutputLogger.Log("Initializing ToolbarInfoCommand...");
            var svc = await package.GetServiceAsync(typeof(IMenuCommandService)) as OleMenuCommandService
                      ?? throw new InvalidOperationException("IMenuCommandService unavailable.");
            _ = new ToolbarInfoCommand(package, svc);
            Utilities.OutputLogger.Log("ToolbarInfoCommand initialized - timers started");
        }

        /// <summary>Fetch fresh stats and update both toolbar button and cached status text.</summary>
        private async Task RefreshStatsAsync()
        {
            try
            {
                var stats = await StatsBuilder.BuildAsync();
                var today  = FormatTokenCount(stats.Today.Tokens);
                var last30 = FormatTokenCount(stats.Last30Days.Tokens);
                var text   = $"Copilot: {today} | {last30}";

                _statusText = text;

                await _package.JoinableTaskFactory.SwitchToMainThreadAsync(_package.DisposalToken);
                _menuCommand.Text = text;
            }
            catch
            {
                _statusText = "Copilot: error";
                try
                {
                    await _package.JoinableTaskFactory.SwitchToMainThreadAsync(_package.DisposalToken);
                    _menuCommand.Text = _statusText;
                }
                catch { /* package may be disposed */ }
            }
        }

        /// <summary>Write the cached status text to the VS status bar.</summary>
        private async Task WriteStatusBarAsync()
        {
            try
            {
                await _package.JoinableTaskFactory.SwitchToMainThreadAsync(_package.DisposalToken);
                if (await _package.GetServiceAsync(typeof(SVsStatusbar)) is IVsStatusbar statusBar)
                {
                    statusBar.SetText(_statusText);
                }
            }
            catch { /* ignore — VS may be shutting down or package disposed */ }
        }

        private static string FormatTokenCount(long tokens)
        {
            if (tokens >= 1_000_000)
                return (tokens / 1_000_000.0).ToString("0.#", CultureInfo.InvariantCulture) + "M";
            if (tokens >= 1_000)
                return (tokens / 1_000.0).ToString("0.#", CultureInfo.InvariantCulture) + "K";
            return tokens.ToString("N0", CultureInfo.InvariantCulture);
        }

        private void OnClick(object sender, EventArgs e)
        {
            _ = _package.JoinableTaskFactory.RunAsync(async () =>
            {
                var window = await _package.ShowToolWindowAsync(
                    typeof(ToolWindow.TokenTrackerToolWindow),
                    id: 0,
                    create: true,
                    cancellationToken: _package.DisposalToken);

                if (window is ToolWindow.TokenTrackerToolWindow trackerWindow)
                {
                    await trackerWindow.RefreshAsync();
                }
            });
        }
    }
}
