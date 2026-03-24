using System;
using System.Runtime.InteropServices;
using System.Threading;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Shell.Interop;
using Task = System.Threading.Tasks.Task;

namespace CopilotTokenTracker
{
    /// <summary>
    /// Main VS package for Copilot Token Tracker.
    ///
    /// Registers the tool window and the Show command, and initialises the
    /// session-discovery background refresh on IDE startup.
    /// </summary>
    [PackageRegistration(UseManagedResourcesOnly = true, AllowsBackgroundLoading = true)]
    [Guid(PackageGuidString)]
    [ProvideMenuResource("Menus.ctmenu", 1)]
    [ProvideToolWindow(
        typeof(ToolWindow.TokenTrackerToolWindow),
        Style           = VsDockStyle.Tabbed,
        Window          = ToolWindowGuids80.SolutionExplorer,
        Orientation     = ToolWindowOrientation.Right,
        Transient       = false)]
    [ProvideAutoLoad(UIContextGuids80.SolutionExists, PackageAutoLoadFlags.BackgroundLoad)]
    public sealed class CopilotTokenTrackerPackage : AsyncPackage
    {
        /// <summary>Package identity GUID — must match source.extension.vsixmanifest and .vsct.</summary>
        public const string PackageGuidString = "6B8CA5B3-1A9F-4C2E-8F3D-7E2A1B4C9D0F";

        protected override async Task InitializeAsync(
            CancellationToken cancellationToken,
            IProgress<ServiceProgressData> progress)
        {
            await this.JoinableTaskFactory.SwitchToMainThreadAsync(cancellationToken);
            await Commands.ShowTokenTrackerCommand.InitializeAsync(this);

            await this.ShowToolWindowAsync(
                typeof(ToolWindow.TokenTrackerToolWindow),
                id: 0,
                create: true,
                cancellationToken: cancellationToken);
        }
    }
}
