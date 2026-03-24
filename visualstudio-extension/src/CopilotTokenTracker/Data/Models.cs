using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace CopilotTokenTracker.Data
{
    // ── Top-level payload sent to the webview ───────────────────────────────────

    internal sealed class DetailedStats
    {
        [JsonPropertyName("today")]
        public PeriodStats Today { get; set; } = new PeriodStats();

        [JsonPropertyName("month")]
        public PeriodStats Month { get; set; } = new PeriodStats();

        [JsonPropertyName("lastMonth")]
        public PeriodStats LastMonth { get; set; } = new PeriodStats();

        [JsonPropertyName("last30Days")]
        public PeriodStats Last30Days { get; set; } = new PeriodStats();

        [JsonPropertyName("lastUpdated")]
        public string LastUpdated { get; set; } = string.Empty;

        [JsonPropertyName("backendConfigured")]
        public bool BackendConfigured { get; set; }
    }

    // ── Per-period aggregated statistics ────────────────────────────────────────

    internal sealed class PeriodStats
    {
        [JsonPropertyName("tokens")]
        public long Tokens { get; set; }

        [JsonPropertyName("thinkingTokens")]
        public long ThinkingTokens { get; set; }

        [JsonPropertyName("estimatedTokens")]
        public long EstimatedTokens { get; set; }

        [JsonPropertyName("actualTokens")]
        public long ActualTokens { get; set; }

        [JsonPropertyName("sessions")]
        public int Sessions { get; set; }

        [JsonPropertyName("avgInteractionsPerSession")]
        public double AvgInteractionsPerSession { get; set; }

        [JsonPropertyName("avgTokensPerSession")]
        public double AvgTokensPerSession { get; set; }

        [JsonPropertyName("modelUsage")]
        public Dictionary<string, ModelStats> ModelUsage { get; set; } = new Dictionary<string, ModelStats>();

        [JsonPropertyName("editorUsage")]
        public Dictionary<string, EditorStats> EditorUsage { get; set; } = new Dictionary<string, EditorStats>();

        [JsonPropertyName("co2")]
        public double Co2 { get; set; }

        [JsonPropertyName("treesEquivalent")]
        public double TreesEquivalent { get; set; }

        [JsonPropertyName("waterUsage")]
        public double WaterUsage { get; set; }

        [JsonPropertyName("estimatedCost")]
        public double EstimatedCost { get; set; }
    }

    // ── Per-model token breakdown ────────────────────────────────────────────────

    internal sealed class ModelStats
    {
        [JsonPropertyName("inputTokens")]
        public long InputTokens { get; set; }

        [JsonPropertyName("outputTokens")]
        public long OutputTokens { get; set; }
    }

    // ── Per-editor token breakdown ───────────────────────────────────────────────

    internal sealed class EditorStats
    {
        [JsonPropertyName("tokens")]
        public long Tokens { get; set; }

        [JsonPropertyName("sessions")]
        public int Sessions { get; set; }
    }
}
