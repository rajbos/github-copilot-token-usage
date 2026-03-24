using System;
using System.Runtime.InteropServices;
using System.Threading;
using Microsoft.VisualStudio;
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
    [ProvideAutoLoad(VSConstants.UICONTEXT.NoSolution_string, PackageAutoLoadFlags.BackgroundLoad)]
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

            try
            {
                // Initialize logging
                Utilities.OutputLogger.Initialize(this);
                Utilities.OutputLogger.Log("=== Copilot Token Tracker Extension Starting ===");
                Utilities.OutputLogger.Log($"Package GUID: {PackageGuidString}");
                Utilities.OutputLogger.Log($"Visual Studio Version: {this.ApplicationRegistryRoot}");

                // Initialize commands
                Utilities.OutputLogger.Log("Initializing commands...");
                await Commands.ShowTokenTrackerCommand.InitializeAsync(this);
                await Commands.ToolbarInfoCommand.InitializeAsync(this);
                Utilities.OutputLogger.Log("Commands initialized successfully");

                Utilities.OutputLogger.Log("=== Extension Initialized Successfully ===");

                // Don't auto-show the tool window during init — it can crash if
                // WebView2 isn't ready yet. Users open it via View > Copilot Token Tracker.
            }
            catch (Exception ex)
            {
                Utilities.OutputLogger.LogError("Failed to initialize extension", ex);
                throw;
            }
        }
    }
}
