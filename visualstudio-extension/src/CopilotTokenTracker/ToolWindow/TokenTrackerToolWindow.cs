using System;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using Microsoft.VisualStudio.Shell;

namespace CopilotTokenTracker.ToolWindow
{
    /// <summary>
    /// The "AI Engineering Fluency" tool window that hosts the WebView2-based dashboard.
    /// </summary>
    [Guid(ToolWindowGuidString)]
    public sealed class TokenTrackerToolWindow : ToolWindowPane
    {
        public const string ToolWindowGuidString = "A2B3C4D5-E6F7-A8B9-C0D1-E2F3A4B5C6D7";

        private TokenTrackerControl? _control;

        public TokenTrackerToolWindow() : base(null)
        {
            Caption = "AI Engineering Fluency";
        }

        protected override void OnCreate()
        {
            base.OnCreate();
            _control = new TokenTrackerControl();
            Content  = _control;
        }

        /// <summary>Triggers a data refresh of the embedded webview.</summary>
        public Task RefreshAsync()
        {
            if (_control == null) { return Task.CompletedTask; }
            return _control.RefreshAsync();
        }

        /// <summary>
        /// Resets the current view to the default (details) and refreshes.
        /// Use this when a view is stuck or rendering incorrectly.
        /// </summary>
        public Task ResetViewAsync()
        {
            if (_control == null) { return Task.CompletedTask; }
            return _control.ResetViewAsync();
        }
    }
}
