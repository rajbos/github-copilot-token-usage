using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;

namespace CopilotTokenTracker.Data
{
    /// <summary>
    /// Discovers all local VS Copilot Chat sessions, parses them, and aggregates the
    /// token usage into a <see cref="DetailedStats"/> object ready for the webview.
    /// </summary>
    internal static class StatsBuilder
    {
        // Environmental-impact constants (kept consistent with the VS Code extension)
        private const double Co2GramsPerThousandTokens      = 0.2;
        private const double WaterMlPerThousandTokens        = 0.3;
        private const double Co2GramsAbsorbedPerTreePerYear  = 21_000.0;

        // ── Public API ─────────────────────────────────────────────────────────

        public static Task<DetailedStats> BuildAsync()
            => Task.Run(Build);

        // ── Core build logic ───────────────────────────────────────────────────

        private static DetailedStats Build()
        {
            var sessionFiles = SessionDiscovery.DiscoverSessions();

            // Parse in parallel for speed; null = unreadable / no data
            var sessions = sessionFiles
                .AsParallel()
                .Select(ParseSession)
                .Where(s => s != null)
                .ToList();

            var now          = DateTime.UtcNow;
            var todayStart   = now.Date;
            var monthStart   = new DateTime(now.Year, now.Month, 1, 0, 0, 0, DateTimeKind.Utc);
            var lastMonStart = monthStart.AddMonths(-1);
            var minus30Days  = now.AddDays(-30);

            return new DetailedStats
            {
                Today      = Aggregate(sessions, todayStart,   now),
                Month      = Aggregate(sessions, monthStart,   now),
                LastMonth  = Aggregate(sessions, lastMonStart, monthStart),
                Last30Days = Aggregate(sessions, minus30Days,  now),
                LastUpdated     = now.ToString("o"),
                BackendConfigured = false,
            };
        }

        // ── Session parsing ────────────────────────────────────────────────────

        private static ParsedSession? ParseSession(string filePath)
        {
            try
            {
                var objects = SessionParser.DecodeSessionFile(filePath);
                if (objects.Count == 0) { return null; }

                var (created, _) = SessionParser.GetTimestamps(objects);
                if (created == null) { return null; }

                if (!DateTime.TryParse(created, null,
                    System.Globalization.DateTimeStyles.RoundtripKind, out var sessionDate))
                {
                    return null;
                }

                var modelUsage   = new Dictionary<string, (long Input, long Output)>(StringComparer.OrdinalIgnoreCase);
                var totalTokens  = 0L;
                var interactions = 0;

                for (var i = 1; i < objects.Count; i++)
                {
                    var msgData = SessionParser.GetMessageData(objects[i]);
                    if (msgData == null) { continue; }

                    var isRequest = i % 2 == 1;
                    if (isRequest) { interactions++; }

                    _ = msgData.TryGetValue("Content", out var contentObj);
                    var text  = SessionParser.ExtractText(contentObj);
                    if (string.IsNullOrEmpty(text)) { continue; }

                    var model  = SessionParser.GetModelId(msgData, isRequest) ?? "unknown";
                    var tokens = TokenEstimator.Estimate(text, model);
                    totalTokens += tokens;

                    if (!modelUsage.TryGetValue(model, out var existing))
                    {
                        existing = (0L, 0L);
                    }

                    modelUsage[model] = isRequest
                        ? (existing.Input + tokens,  existing.Output)
                        : (existing.Input,            existing.Output + tokens);
                }

                return new ParsedSession
                {
                    FilePath     = filePath,
                    Date         = sessionDate,
                    Tokens       = totalTokens,
                    Interactions = interactions,
                    ModelUsage   = modelUsage,
                };
            }
            catch
            {
                return null;
            }
        }

        // ── Aggregation ────────────────────────────────────────────────────────

        private static PeriodStats Aggregate(
            List<ParsedSession?> sessions, DateTime from, DateTime to)
        {
            var inPeriod = sessions
                .Where(s => s != null && s!.Date >= from && s.Date < to)
                .ToList();

            var totalTokens      = inPeriod.Sum(s => s!.Tokens);
            var totalInteractions = inPeriod.Sum(s => s!.Interactions);
            var totalSessions    = inPeriod.Count;

            // Merge per-model usage across all sessions in the period
            var merged = new Dictionary<string, (long Input, long Output)>(StringComparer.OrdinalIgnoreCase);

            foreach (var s in inPeriod)
            {
                foreach (var kvp in s!.ModelUsage)
                {
                    if (!merged.TryGetValue(kvp.Key, out var existing))
                    {
                        existing = (0L, 0L);
                    }
                    merged[kvp.Key] = (existing.Input + kvp.Value.Input,
                                       existing.Output + kvp.Value.Output);
                }
            }

            var co2  = totalTokens / 1_000.0 * Co2GramsPerThousandTokens;
            var water = totalTokens / 1_000.0 * WaterMlPerThousandTokens;

            return new PeriodStats
            {
                Tokens                   = totalTokens,
                ThinkingTokens           = 0L,
                EstimatedTokens          = totalTokens,
                ActualTokens             = 0L,
                Sessions                 = totalSessions,
                AvgInteractionsPerSession = totalSessions > 0
                    ? (double)totalInteractions / totalSessions
                    : 0.0,
                AvgTokensPerSession = totalSessions > 0
                    ? (double)totalTokens / totalSessions
                    : 0.0,
                ModelUsage = BuildModelUsageDict(merged),
                EditorUsage = new Dictionary<string, EditorStats>
                {
                    ["Visual Studio"] = new EditorStats
                    {
                        Tokens   = totalTokens,
                        Sessions = totalSessions,
                    },
                },
                Co2             = co2,
                TreesEquivalent = co2 / Co2GramsAbsorbedPerTreePerYear,
                WaterUsage      = water,
                EstimatedCost   = 0.0,
            };
        }

        private static Dictionary<string, ModelStats> BuildModelUsageDict(
            Dictionary<string, (long Input, long Output)> merged)
        {
            var dict = new Dictionary<string, ModelStats>(merged.Count, StringComparer.OrdinalIgnoreCase);

            foreach (var kvp in merged)
            {
                dict[kvp.Key] = new ModelStats
                {
                    InputTokens  = kvp.Value.Input,
                    OutputTokens = kvp.Value.Output,
                };
            }

            return dict;
        }
    }
}
