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
        public static async Task<DetailedStats?> BuildAsync()
        {
            var stats = await CliBridge.GetUsageStatsAsync();
            if (stats != null) { return stats; }

            Utilities.OutputLogger.LogWarning("CLI bridge returned no data — is the bundled CLI exe present?");
            return null;
        }

        /// <summary>
        /// Builds the <see cref="EnvironmentalStats"/> payload for the environmental view
        /// by mapping the period-level co2/water/tree data from the usage stats.
        /// </summary>
        public static async Task<EnvironmentalStats> BuildEnvironmentalAsync()
        {
            var usage = await BuildAsync();
            if (usage == null)
            {
                return new EnvironmentalStats
                {
                    LastUpdated = DateTime.UtcNow.ToString("o"),
                };
            }
            return new EnvironmentalStats
            {
                LastUpdated     = usage.LastUpdated,
                BackendConfigured = usage.BackendConfigured,
                Today     = MapEnvironmentalPeriod(usage.Today),
                Month     = MapEnvironmentalPeriod(usage.Month),
                LastMonth = MapEnvironmentalPeriod(usage.LastMonth),
                Last30Days = MapEnvironmentalPeriod(usage.Last30Days),
            };
        }

        /// <summary>
        /// Builds the <see cref="MaturityData"/> payload for the maturity/fluency-score view
        /// by calling the CLI <c>fluency --json</c> command.
        /// </summary>
        public static async Task<MaturityData> BuildMaturityAsync()
        {
            var maturity = await CliBridge.GetMaturityAsync();
            if (maturity != null) { return maturity; }

            Utilities.OutputLogger.LogWarning("Fluency data unavailable — returning empty maturity data");
            return new MaturityData
            {
                OverallStage = 1,
                OverallLabel = "Stage 1: Copilot Skeptic",
                LastUpdated  = DateTime.UtcNow.ToString("o"),
            };
        }

        // ── Helpers ──────────────────────────────────────────────────────────────

        internal static EnvironmentalPeriod MapEnvironmentalPeriod(PeriodStats p)
            => new EnvironmentalPeriod
            {
                Tokens          = p.Tokens,
                Co2             = p.Co2,
                TreesEquivalent = p.TreesEquivalent,
                WaterUsage      = p.WaterUsage,
            };
    }
}
