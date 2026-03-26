using System;
using System.ComponentModel.Design;
using Microsoft.VisualStudio.Shell;
using Task = System.Threading.Tasks.Task;

namespace CopilotTokenTracker.Commands
{
    /// <summary>
    /// "View > AI Engineering Fluency" menu command.
    /// Shows (or focuses) the TokenTrackerToolWindow and triggers a data refresh.
    /// </summary>
    internal sealed class ShowTokenTrackerCommand
    {
        /// <summary>Command set GUID — must match .vsct guidCopilotTokenTrackerCmdSet.</summary>
        public const string CommandSetGuidString = "B1C2D3E4-F5A6-B7C8-D9E0-F1A2B3C4D5E6";
        public static readonly Guid CommandSet = new Guid(CommandSetGuidString);

        /// <summary>Command ID — must match .vsct ShowTokenTrackerCommandId.</summary>
        public const int CommandId = 0x0100;

        private readonly AsyncPackage _package;

        private ShowTokenTrackerCommand(AsyncPackage package, OleMenuCommandService commandService)
        {
            _package = package ?? throw new ArgumentNullException(nameof(package));
            var id   = new CommandID(CommandSet, CommandId);
            commandService.AddCommand(new MenuCommand(Execute, id));
        }

        public static async Task InitializeAsync(AsyncPackage package)
        {
            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync(package.DisposalToken);
            var svc = await package.GetServiceAsync(typeof(IMenuCommandService)) as OleMenuCommandService
                      ?? throw new InvalidOperationException("IMenuCommandService unavailable.");
            _ = new ShowTokenTrackerCommand(package, svc);
        }

        private void Execute(object sender, EventArgs e)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            Utilities.OutputLogger.Log("ShowTokenTrackerCommand executed - opening tool window");

            _ = _package.JoinableTaskFactory.RunAsync(async () =>
            {
                try
                {
                    await _package.ShowToolWindowAsync(
                        typeof(ToolWindow.TokenTrackerToolWindow),
                        id:         0,
                        create:     true,
                        cancellationToken: _package.DisposalToken);

                    await _package.JoinableTaskFactory.SwitchToMainThreadAsync(_package.DisposalToken);
                    var pane = _package.FindToolWindow(
                        typeof(ToolWindow.TokenTrackerToolWindow), 0, false);

                    if (pane is ToolWindow.TokenTrackerToolWindow trackerWindow)
                    {
                        Utilities.OutputLogger.Log("Tool window opened, refreshing data...");
                        await trackerWindow.RefreshAsync();
                        Utilities.OutputLogger.Log("Data refresh completed");
                    }
                    else
                    {
                        Utilities.OutputLogger.LogWarning("Tool window pane not found after show");
                    }
                }
                catch (Exception ex)
                {
                    Utilities.OutputLogger.LogError("ShowTokenTrackerCommand failed", ex);
                }
            });
        }
    }
}
