using System;
using Microsoft.VisualStudio;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Shell.Interop;

namespace CopilotTokenTracker.Utilities
{
    /// <summary>
    /// Writes log messages to a custom pane in Visual Studio's Output window.
    /// </summary>
    public static class OutputLogger
    {
        private static IVsOutputWindowPane? _pane;
        private static readonly Guid PaneGuid = new Guid("A1B2C3D4-5E6F-7A8B-9C0D-1E2F3A4B5C6D");
        private const string PaneName = "AI Engineering Fluency";

        /// <summary>
        /// Initializes the output pane. Call this during package initialization.
        /// </summary>
        public static void Initialize(IServiceProvider serviceProvider)
        {
            ThreadHelper.ThrowIfNotOnUIThread();

            if (_pane != null) return;

            var outputWindow = serviceProvider.GetService(typeof(SVsOutputWindow)) as IVsOutputWindow;
            if (outputWindow == null)
            {
                return;
            }

            // Try to get existing pane or create a new one
            Guid paneGuid = PaneGuid;
            int hr = outputWindow.GetPane(ref paneGuid, out _pane);
            if (ErrorHandler.Failed(hr) || _pane == null)
            {
                paneGuid = PaneGuid;
                outputWindow.CreatePane(ref paneGuid, PaneName, fInitVisible: 1, fClearWithSolution: 0);
                paneGuid = PaneGuid;
                outputWindow.GetPane(ref paneGuid, out _pane);
            }

            _pane?.Activate();
        }

        /// <summary>
        /// Logs an informational message to the output pane.
        /// Thread-safe: can be called from any thread.
        /// </summary>
        public static void Log(string message)
        {
            WriteToPane($"[{DateTime.Now:HH:mm:ss}] {message}");
        }

        /// <summary>
        /// Logs an error message to the output pane.
        /// Thread-safe: can be called from any thread.
        /// </summary>
        public static void LogError(string message, Exception? ex = null)
        {
            var errorMsg = ex != null ? $"{message}: {ex.Message}" : message;
            WriteToPane($"[{DateTime.Now:HH:mm:ss}] ERROR: {errorMsg}");
        }

        /// <summary>
        /// Logs a warning message to the output pane.
        /// Thread-safe: can be called from any thread.
        /// </summary>
        public static void LogWarning(string message)
        {
            WriteToPane($"[{DateTime.Now:HH:mm:ss}] WARNING: {message}");
        }

        private static void WriteToPane(string message)
        {
            try
            {
                // OutputStringThreadSafe is already thread-safe, but we need to ensure _pane is not null
                _pane?.OutputStringThreadSafe(message + Environment.NewLine);
            }
            catch
            {
                // Silently fail if logging doesn't work - don't break the extension
            }
        }
    }
}
