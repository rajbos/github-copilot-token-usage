using System;
using System.ComponentModel.Design;
using System.Globalization;
using System.Threading;
using CopilotTokenTracker.Data;
using Microsoft.VisualStudio.Shell;
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

        private static readonly TimeSpan StatsRefreshInterval      = TimeSpan.FromMinutes(5);
        private static readonly TimeSpan StatsRetryInterval        = TimeSpan.FromSeconds(30);

        private readonly AsyncPackage _package;
        private readonly OleMenuCommand _menuCommand;
        private Timer? _statsTimer;

        private ToolbarInfoCommand(AsyncPackage package, OleMenuCommandService commandService)
        {
            _package = package ?? throw new ArgumentNullException(nameof(package));

            var id = new CommandID(CommandSet, CommandId);
            _menuCommand = new OleMenuCommand(OnClick, id);
            _menuCommand.BeforeQueryStatus += OnBeforeQueryStatus;
            _menuCommand.Enabled = true;
            _menuCommand.Visible = true;
            _menuCommand.Supported = true;
            commandService.AddCommand(_menuCommand);

            // Fetch stats after a short delay, then every 5 minutes
            _statsTimer = new Timer(
                _ => _package.JoinableTaskFactory.RunAsync(async () => await RefreshStatsAsync()),
                null,
                TimeSpan.FromSeconds(3),
                StatsRefreshInterval);
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

        /// <summary>Fetch fresh stats and update the toolbar button text and tooltip.</summary>
        private async Task RefreshStatsAsync()
        {
            try
            {
                var stats = await StatsBuilder.BuildAsync();
                string text;
                string tooltip;
                if (stats == null)
                {
                    text    = "AI Engineering Fluency: ? | ?";
                    tooltip = "AI Engineering Fluency — today's tokens | last 30 days tokens";
                    // Retry sooner rather than waiting the full 5-minute interval
                    _statsTimer?.Change(StatsRetryInterval, StatsRefreshInterval);
                }
                else
                {
                    var today  = FormatTokenCount(stats.Today.Tokens);
                    var last30 = FormatTokenCount(stats.Last30Days.Tokens);
                    text    = $"AI Engineering Fluency: {today} | {last30}";
                    tooltip = $"AI Engineering Fluency\n" +
                              $"Today:       {stats.Today.Tokens:N0} tokens ({today})\n" +
                              $"Last 30 days: {stats.Last30Days.Tokens:N0} tokens ({last30})\n" +
                              $"Click to open the dashboard";
                }

                await _package.JoinableTaskFactory.SwitchToMainThreadAsync(_package.DisposalToken);
                _menuCommand.Text        = text;
                _menuCommand.ToolTipText = tooltip;
            }
            catch
            {
                try
                {
                    await _package.JoinableTaskFactory.SwitchToMainThreadAsync(_package.DisposalToken);
                    _menuCommand.Text        = "AI Engineering Fluency: error";
                    _menuCommand.ToolTipText = "AI Engineering Fluency — failed to load stats";
                }
                catch { /* package may be disposed */ }
            }
        }

        internal static string FormatTokenCount(long tokens)
        {
            if (tokens >= 1_000_000)
                return (tokens / 1_000_000.0).ToString("0.#", CultureInfo.InvariantCulture) + "M";
            if (tokens >= 1_000)
                return (tokens / 1_000.0).ToString("0.#", CultureInfo.InvariantCulture) + "K";
            return tokens.ToString("N0", CultureInfo.InvariantCulture);
        }

        private void OnBeforeQueryStatus(object sender, EventArgs e)
        {
            if (sender is OleMenuCommand cmd)
            {
                cmd.Enabled = true;
                cmd.Visible = true;
            }
        }

        private void OnClick(object sender, EventArgs e)
        {
            _ = _package.JoinableTaskFactory.RunAsync(async () =>
            {
                try
                {
                    Utilities.OutputLogger.Log("Toolbar click - opening tool window");

                    // ShowToolWindowAsync creates/shows the frame; FindToolWindow returns the pane
                    await _package.ShowToolWindowAsync(
                        typeof(ToolWindow.TokenTrackerToolWindow),
                        id: 0,
                        create: true,
                        cancellationToken: _package.DisposalToken);

                    await _package.JoinableTaskFactory.SwitchToMainThreadAsync(_package.DisposalToken);
                    var pane = _package.FindToolWindow(
                        typeof(ToolWindow.TokenTrackerToolWindow), 0, false);

                    if (pane is ToolWindow.TokenTrackerToolWindow trackerWindow)
                    {
                        Utilities.OutputLogger.Log("Tool window found, resetting to details view...");
                        await trackerWindow.ResetViewAsync();
                        // The view fetch may have populated the CLI cache; sync toolbar text now.
                        await RefreshStatsAsync();
                    }
                    else
                    {
                        Utilities.OutputLogger.LogWarning("Tool window pane not found after show");
                    }
                }
                catch (Exception ex)
                {
                    Utilities.OutputLogger.LogError("Toolbar click failed", ex);
                }
            });
        }
    }
}
