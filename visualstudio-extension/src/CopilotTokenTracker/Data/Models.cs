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

    // ── Environmental stats payload ──────────────────────────────────────────────

    /// <summary>
    /// Projected to the environmental webview as <c>window.__INITIAL_ENVIRONMENTAL__</c>.
    /// Fields mirror the TypeScript <c>EnvironmentalStats</c> type.
    /// </summary>
    internal sealed class EnvironmentalStats
    {
        [JsonPropertyName("today")]
        public EnvironmentalPeriod Today { get; set; } = new EnvironmentalPeriod();

        [JsonPropertyName("month")]
        public EnvironmentalPeriod Month { get; set; } = new EnvironmentalPeriod();

        [JsonPropertyName("lastMonth")]
        public EnvironmentalPeriod LastMonth { get; set; } = new EnvironmentalPeriod();

        [JsonPropertyName("last30Days")]
        public EnvironmentalPeriod Last30Days { get; set; } = new EnvironmentalPeriod();

        [JsonPropertyName("lastUpdated")]
        public string LastUpdated { get; set; } = string.Empty;

        [JsonPropertyName("backendConfigured")]
        public bool BackendConfigured { get; set; }
    }

    internal sealed class EnvironmentalPeriod
    {
        [JsonPropertyName("tokens")]
        public long Tokens { get; set; }

        [JsonPropertyName("co2")]
        public double Co2 { get; set; }

        [JsonPropertyName("treesEquivalent")]
        public double TreesEquivalent { get; set; }

        [JsonPropertyName("waterUsage")]
        public double WaterUsage { get; set; }
    }

    // ── Maturity / Fluency Score payload ────────────────────────────────────────

    /// <summary>
    /// Projected to the maturity webview as <c>window.__INITIAL_MATURITY__</c>.
    /// Fields mirror the TypeScript <c>MaturityData</c> type.
    /// </summary>
    internal sealed class MaturityData
    {
        [JsonPropertyName("overallStage")]
        public int OverallStage { get; set; }

        [JsonPropertyName("overallLabel")]
        public string OverallLabel { get; set; } = string.Empty;

        [JsonPropertyName("categories")]
        public List<CategoryScore> Categories { get; set; } = new List<CategoryScore>();

        [JsonPropertyName("period")]
        public UsageAnalysisPeriod Period { get; set; } = new UsageAnalysisPeriod();

        [JsonPropertyName("lastUpdated")]
        public string LastUpdated { get; set; } = string.Empty;

        [JsonPropertyName("backendConfigured")]
        public bool BackendConfigured { get; set; }
    }

    internal sealed class CategoryScore
    {
        [JsonPropertyName("category")]
        public string Category { get; set; } = string.Empty;

        [JsonPropertyName("icon")]
        public string Icon { get; set; } = string.Empty;

        [JsonPropertyName("stage")]
        public int Stage { get; set; }

        [JsonPropertyName("evidence")]
        public List<string> Evidence { get; set; } = new List<string>();

        [JsonPropertyName("tips")]
        public List<string> Tips { get; set; } = new List<string>();
    }

    /// <summary>
    /// Minimal representation of <c>UsageAnalysisPeriod</c> needed by the maturity webview.
    /// Only the fields rendered by the webview are included.
    /// </summary>
    internal sealed class UsageAnalysisPeriod
    {
        [JsonPropertyName("sessions")]
        public int Sessions { get; set; }

        [JsonPropertyName("modeUsage")]
        public ModeUsage ModeUsage { get; set; } = new ModeUsage();

        [JsonPropertyName("toolCalls")]
        public ToolCallUsage ToolCalls { get; set; } = new ToolCallUsage();

        [JsonPropertyName("mcpTools")]
        public McpToolUsage McpTools { get; set; } = new McpToolUsage();

        [JsonPropertyName("contextReferences")]
        public ContextReferenceUsage ContextReferences { get; set; } = new ContextReferenceUsage();

        [JsonPropertyName("repositories")]
        public List<string> Repositories { get; set; } = new List<string>();

        [JsonPropertyName("repositoriesWithCustomization")]
        public List<string> RepositoriesWithCustomization { get; set; } = new List<string>();
    }

    internal sealed class ModeUsage
    {
        [JsonPropertyName("ask")]
        public int Ask { get; set; }

        [JsonPropertyName("edit")]
        public int Edit { get; set; }

        [JsonPropertyName("agent")]
        public int Agent { get; set; }

        [JsonPropertyName("plan")]
        public int Plan { get; set; }

        [JsonPropertyName("customAgent")]
        public int CustomAgent { get; set; }
    }

    internal sealed class ToolCallUsage
    {
        [JsonPropertyName("total")]
        public int Total { get; set; }

        [JsonPropertyName("byTool")]
        public Dictionary<string, int> ByTool { get; set; } = new Dictionary<string, int>();
    }

    internal sealed class McpToolUsage
    {
        [JsonPropertyName("total")]
        public int Total { get; set; }

        [JsonPropertyName("byServer")]
        public Dictionary<string, int> ByServer { get; set; } = new Dictionary<string, int>();

        [JsonPropertyName("byTool")]
        public Dictionary<string, int> ByTool { get; set; } = new Dictionary<string, int>();
    }

    internal sealed class ContextReferenceUsage
    {
        [JsonPropertyName("file")]
        public int File { get; set; }

        [JsonPropertyName("selection")]
        public int Selection { get; set; }

        [JsonPropertyName("codebase")]
        public int Codebase { get; set; }

        [JsonPropertyName("workspace")]
        public int Workspace { get; set; }

        [JsonPropertyName("terminal")]
        public int Terminal { get; set; }

        [JsonPropertyName("vscode")]
        public int Vscode { get; set; }
    }
}
