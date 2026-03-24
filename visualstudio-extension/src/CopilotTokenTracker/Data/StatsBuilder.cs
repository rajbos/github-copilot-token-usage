using System;
using System.Threading.Tasks;

namespace CopilotTokenTracker.Data
{
    /// <summary>
    /// Delegates token usage stats to the bundled CLI executable.
    /// All session discovery, parsing, and aggregation live in the shared TypeScript codebase.
    /// </summary>
    internal static class StatsBuilder
    {
        public static async Task<DetailedStats> BuildAsync()
        {
            var stats = await CliBridge.GetUsageStatsAsync();
            if (stats != null) { return stats; }

            Utilities.OutputLogger.LogWarning("CLI bridge returned no data — is the bundled CLI exe present?");
            return new DetailedStats
            {
                LastUpdated = DateTime.UtcNow.ToString("o"),
            };
        }
    }
}
