using System;

namespace CopilotTokenTrackerRunner
{
    internal static class Program
    {
        private static int Main(string[] args)
        {
            Console.WriteLine(
                "CopilotTokenTracker is a Visual Studio extension (VSIX)." + Environment.NewLine +
                "Build the solution, then run/debug the extension via Visual Studio experimental instance." + Environment.NewLine +
                "This runner project exists only so the solution can be started without errors.");

            return 0;
        }
    }
}
