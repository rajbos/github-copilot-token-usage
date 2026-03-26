using System.Collections.Generic;
using System.Text.Json;
using CopilotTokenTracker.Data;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace CopilotTokenTracker.Tests
{
    [TestClass]
    public class ModelsTests
    {
        // ── DetailedStats ──────────────────────────────────────────────────

        [TestMethod]
        public void DetailedStats_DefaultValues_AreInitialized()
        {
            var stats = new DetailedStats();
            Assert.IsNotNull(stats.Today);
            Assert.IsNotNull(stats.Month);
            Assert.IsNotNull(stats.LastMonth);
            Assert.IsNotNull(stats.Last30Days);
            Assert.AreEqual(string.Empty, stats.LastUpdated);
            Assert.IsFalse(stats.BackendConfigured);
        }

        [TestMethod]
        public void DetailedStats_RoundTrip_JsonSerialization()
        {
            var stats = new DetailedStats
            {
                LastUpdated = "2025-01-15T10:30:00Z",
                BackendConfigured = true,
                Today = new PeriodStats { Tokens = 50_000, Sessions = 5 },
                Last30Days = new PeriodStats { Tokens = 1_200_000, Sessions = 120 },
            };

            var json = JsonSerializer.Serialize(stats);
            var opts = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
            var deserialized = JsonSerializer.Deserialize<DetailedStats>(json, opts);

            Assert.IsNotNull(deserialized);
            Assert.AreEqual("2025-01-15T10:30:00Z", deserialized!.LastUpdated);
            Assert.IsTrue(deserialized.BackendConfigured);
            Assert.AreEqual(50_000, deserialized.Today.Tokens);
            Assert.AreEqual(5, deserialized.Today.Sessions);
            Assert.AreEqual(1_200_000, deserialized.Last30Days.Tokens);
        }

        [TestMethod]
        public void DetailedStats_DeserializeFromCliJson()
        {
            // Simulates a JSON payload from the CLI
            var json = @"{
                ""today"": { ""tokens"": 42000, ""thinkingTokens"": 5000, ""sessions"": 3, ""estimatedCost"": 0.15, ""co2"": 0.002 },
                ""month"": { ""tokens"": 500000, ""sessions"": 50 },
                ""lastMonth"": { ""tokens"": 400000, ""sessions"": 40 },
                ""last30Days"": { ""tokens"": 950000, ""sessions"": 90, ""modelUsage"": { ""gpt-4o"": { ""inputTokens"": 300000, ""outputTokens"": 200000 } } },
                ""lastUpdated"": ""2025-03-15T12:00:00Z"",
                ""backendConfigured"": false
            }";

            var opts = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
            var stats = JsonSerializer.Deserialize<DetailedStats>(json, opts);

            Assert.IsNotNull(stats);
            Assert.AreEqual(42_000, stats!.Today.Tokens);
            Assert.AreEqual(5_000, stats.Today.ThinkingTokens);
            Assert.AreEqual(3, stats.Today.Sessions);
            Assert.AreEqual(0.15, stats.Today.EstimatedCost, 0.001);
            Assert.AreEqual(0.002, stats.Today.Co2, 0.0001);
            Assert.AreEqual(500_000, stats.Month.Tokens);
            Assert.AreEqual("2025-03-15T12:00:00Z", stats.LastUpdated);
            Assert.IsFalse(stats.BackendConfigured);

            // Model usage
            Assert.IsTrue(stats.Last30Days.ModelUsage.ContainsKey("gpt-4o"));
            Assert.AreEqual(300_000, stats.Last30Days.ModelUsage["gpt-4o"].InputTokens);
            Assert.AreEqual(200_000, stats.Last30Days.ModelUsage["gpt-4o"].OutputTokens);
        }

        // ── PeriodStats ────────────────────────────────────────────────────

        [TestMethod]
        public void PeriodStats_DefaultValues()
        {
            var period = new PeriodStats();
            Assert.AreEqual(0, period.Tokens);
            Assert.AreEqual(0, period.ThinkingTokens);
            Assert.AreEqual(0, period.EstimatedTokens);
            Assert.AreEqual(0, period.ActualTokens);
            Assert.AreEqual(0, period.Sessions);
            Assert.AreEqual(0.0, period.AvgInteractionsPerSession);
            Assert.AreEqual(0.0, period.AvgTokensPerSession);
            Assert.IsNotNull(period.ModelUsage);
            Assert.IsNotNull(period.EditorUsage);
            Assert.AreEqual(0.0, period.Co2);
            Assert.AreEqual(0.0, period.TreesEquivalent);
            Assert.AreEqual(0.0, period.WaterUsage);
            Assert.AreEqual(0.0, period.EstimatedCost);
        }

        [TestMethod]
        public void PeriodStats_WithEditorUsage_RoundTrip()
        {
            var period = new PeriodStats
            {
                Tokens = 100_000,
                EditorUsage = new Dictionary<string, EditorStats>
                {
                    ["vscode"] = new EditorStats { Tokens = 80_000, Sessions = 10 },
                    ["visualstudio"] = new EditorStats { Tokens = 20_000, Sessions = 3 },
                }
            };

            var json = JsonSerializer.Serialize(period);
            var opts = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
            var deserialized = JsonSerializer.Deserialize<PeriodStats>(json, opts);

            Assert.IsNotNull(deserialized);
            Assert.AreEqual(100_000, deserialized!.Tokens);
            Assert.AreEqual(2, deserialized.EditorUsage.Count);
            Assert.AreEqual(80_000, deserialized.EditorUsage["vscode"].Tokens);
            Assert.AreEqual(3, deserialized.EditorUsage["visualstudio"].Sessions);
        }

        // ── ModelStats ─────────────────────────────────────────────────────

        [TestMethod]
        public void ModelStats_RoundTrip()
        {
            var model = new ModelStats { InputTokens = 500_000, OutputTokens = 250_000 };

            var json = JsonSerializer.Serialize(model);
            var opts = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
            var deserialized = JsonSerializer.Deserialize<ModelStats>(json, opts);

            Assert.IsNotNull(deserialized);
            Assert.AreEqual(500_000, deserialized!.InputTokens);
            Assert.AreEqual(250_000, deserialized.OutputTokens);
        }

        // ── EditorStats ────────────────────────────────────────────────────

        [TestMethod]
        public void EditorStats_RoundTrip()
        {
            var editor = new EditorStats { Tokens = 75_000, Sessions = 8 };

            var json = JsonSerializer.Serialize(editor);
            var opts = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
            var deserialized = JsonSerializer.Deserialize<EditorStats>(json, opts);

            Assert.IsNotNull(deserialized);
            Assert.AreEqual(75_000, deserialized!.Tokens);
            Assert.AreEqual(8, deserialized.Sessions);
        }

        // ── EnvironmentalStats ─────────────────────────────────────────────

        [TestMethod]
        public void EnvironmentalStats_DefaultValues()
        {
            var env = new EnvironmentalStats();
            Assert.IsNotNull(env.Today);
            Assert.IsNotNull(env.Month);
            Assert.IsNotNull(env.LastMonth);
            Assert.IsNotNull(env.Last30Days);
            Assert.AreEqual(string.Empty, env.LastUpdated);
            Assert.IsFalse(env.BackendConfigured);
        }

        [TestMethod]
        public void EnvironmentalPeriod_RoundTrip()
        {
            var period = new EnvironmentalPeriod
            {
                Tokens = 200_000,
                Co2 = 0.05,
                TreesEquivalent = 0.003,
                WaterUsage = 1.2,
            };

            var json = JsonSerializer.Serialize(period);
            var opts = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
            var deserialized = JsonSerializer.Deserialize<EnvironmentalPeriod>(json, opts);

            Assert.IsNotNull(deserialized);
            Assert.AreEqual(200_000, deserialized!.Tokens);
            Assert.AreEqual(0.05, deserialized.Co2, 0.001);
            Assert.AreEqual(0.003, deserialized.TreesEquivalent, 0.0001);
            Assert.AreEqual(1.2, deserialized.WaterUsage, 0.01);
        }

        // ── MaturityData ───────────────────────────────────────────────────

        [TestMethod]
        public void MaturityData_DefaultValues()
        {
            var maturity = new MaturityData();
            Assert.AreEqual(0, maturity.OverallStage);
            Assert.AreEqual(string.Empty, maturity.OverallLabel);
            Assert.IsNotNull(maturity.Categories);
            Assert.IsNotNull(maturity.Period);
            Assert.AreEqual(string.Empty, maturity.LastUpdated);
            Assert.IsFalse(maturity.BackendConfigured);
        }

        [TestMethod]
        public void MaturityData_WithCategories_RoundTrip()
        {
            var maturity = new MaturityData
            {
                OverallStage = 3,
                OverallLabel = "Stage 3: Copilot Practitioner",
                Categories = new List<CategoryScore>
                {
                    new CategoryScore
                    {
                        Category = "Mode Usage",
                        Icon = "🎯",
                        Stage = 4,
                        Evidence = new List<string> { "Uses agent mode frequently" },
                        Tips = new List<string> { "Try custom agents" },
                    }
                },
                LastUpdated = "2025-03-15T10:00:00Z",
            };

            var json = JsonSerializer.Serialize(maturity);
            var opts = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
            var deserialized = JsonSerializer.Deserialize<MaturityData>(json, opts);

            Assert.IsNotNull(deserialized);
            Assert.AreEqual(3, deserialized!.OverallStage);
            Assert.AreEqual("Stage 3: Copilot Practitioner", deserialized.OverallLabel);
            Assert.AreEqual(1, deserialized.Categories.Count);
            Assert.AreEqual("Mode Usage", deserialized.Categories[0].Category);
            Assert.AreEqual(4, deserialized.Categories[0].Stage);
            Assert.AreEqual(1, deserialized.Categories[0].Evidence.Count);
            Assert.AreEqual(1, deserialized.Categories[0].Tips.Count);
        }

        [TestMethod]
        public void MaturityData_DeserializeFromCliJson()
        {
            var json = @"{
                ""overallStage"": 2,
                ""overallLabel"": ""Stage 2: Copilot Explorer"",
                ""categories"": [
                    { ""category"": ""Mode Usage"", ""icon"": ""🎯"", ""stage"": 3, ""evidence"": [""Uses ask and edit modes""], ""tips"": [""Try agent mode""] },
                    { ""category"": ""Tool Usage"", ""icon"": ""🔧"", ""stage"": 1, ""evidence"": [], ""tips"": [""Enable MCP tools""] }
                ],
                ""period"": {
                    ""sessions"": 25,
                    ""modeUsage"": { ""ask"": 15, ""edit"": 8, ""agent"": 2, ""plan"": 0, ""customAgent"": 0 },
                    ""toolCalls"": { ""total"": 10, ""byTool"": { ""readFile"": 5, ""writeFile"": 5 } },
                    ""mcpTools"": { ""total"": 0, ""byServer"": {}, ""byTool"": {} },
                    ""contextReferences"": { ""file"": 20, ""selection"": 5, ""codebase"": 0, ""workspace"": 0, ""terminal"": 2, ""vscode"": 0 }
                },
                ""lastUpdated"": ""2025-03-15T12:00:00Z"",
                ""backendConfigured"": false
            }";

            var opts = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
            var maturity = JsonSerializer.Deserialize<MaturityData>(json, opts);

            Assert.IsNotNull(maturity);
            Assert.AreEqual(2, maturity!.OverallStage);
            Assert.AreEqual(25, maturity.Period.Sessions);
            Assert.AreEqual(15, maturity.Period.ModeUsage.Ask);
            Assert.AreEqual(8, maturity.Period.ModeUsage.Edit);
            Assert.AreEqual(10, maturity.Period.ToolCalls.Total);
            Assert.AreEqual(20, maturity.Period.ContextReferences.File);
            Assert.AreEqual(2, maturity.Period.ContextReferences.Terminal);
        }

        // ── UsageAnalysisPeriod ────────────────────────────────────────────

        [TestMethod]
        public void UsageAnalysisPeriod_DefaultValues()
        {
            var period = new UsageAnalysisPeriod();
            Assert.AreEqual(0, period.Sessions);
            Assert.IsNotNull(period.ModeUsage);
            Assert.IsNotNull(period.ToolCalls);
            Assert.IsNotNull(period.McpTools);
            Assert.IsNotNull(period.ContextReferences);
            Assert.IsNotNull(period.Repositories);
            Assert.IsNotNull(period.RepositoriesWithCustomization);
        }

        // ── ModeUsage ──────────────────────────────────────────────────────

        [TestMethod]
        public void ModeUsage_RoundTrip()
        {
            var mode = new ModeUsage { Ask = 10, Edit = 5, Agent = 3, Plan = 1, CustomAgent = 0 };

            var json = JsonSerializer.Serialize(mode);
            var opts = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
            var deserialized = JsonSerializer.Deserialize<ModeUsage>(json, opts);

            Assert.IsNotNull(deserialized);
            Assert.AreEqual(10, deserialized!.Ask);
            Assert.AreEqual(5, deserialized.Edit);
            Assert.AreEqual(3, deserialized.Agent);
            Assert.AreEqual(1, deserialized.Plan);
            Assert.AreEqual(0, deserialized.CustomAgent);
        }

        // ── ToolCallUsage ──────────────────────────────────────────────────

        [TestMethod]
        public void ToolCallUsage_WithByTool_RoundTrip()
        {
            var toolCalls = new ToolCallUsage
            {
                Total = 15,
                ByTool = new Dictionary<string, int>
                {
                    ["readFile"] = 7,
                    ["writeFile"] = 5,
                    ["runCommand"] = 3,
                }
            };

            var json = JsonSerializer.Serialize(toolCalls);
            var opts = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
            var deserialized = JsonSerializer.Deserialize<ToolCallUsage>(json, opts);

            Assert.IsNotNull(deserialized);
            Assert.AreEqual(15, deserialized!.Total);
            Assert.AreEqual(3, deserialized.ByTool.Count);
            Assert.AreEqual(7, deserialized.ByTool["readFile"]);
        }

        // ── McpToolUsage ───────────────────────────────────────────────────

        [TestMethod]
        public void McpToolUsage_WithServersAndTools_RoundTrip()
        {
            var mcp = new McpToolUsage
            {
                Total = 8,
                ByServer = new Dictionary<string, int> { ["github"] = 5, ["custom-server"] = 3 },
                ByTool = new Dictionary<string, int> { ["search_code"] = 5, ["run_query"] = 3 },
            };

            var json = JsonSerializer.Serialize(mcp);
            var opts = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
            var deserialized = JsonSerializer.Deserialize<McpToolUsage>(json, opts);

            Assert.IsNotNull(deserialized);
            Assert.AreEqual(8, deserialized!.Total);
            Assert.AreEqual(2, deserialized.ByServer.Count);
            Assert.AreEqual(5, deserialized.ByServer["github"]);
            Assert.AreEqual(3, deserialized.ByTool["run_query"]);
        }

        // ── ContextReferenceUsage ──────────────────────────────────────────

        [TestMethod]
        public void ContextReferenceUsage_AllFields_RoundTrip()
        {
            var ctx = new ContextReferenceUsage
            {
                File = 20,
                Selection = 5,
                Codebase = 1,
                Workspace = 2,
                Terminal = 3,
                Vscode = 4,
            };

            var json = JsonSerializer.Serialize(ctx);
            var opts = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
            var deserialized = JsonSerializer.Deserialize<ContextReferenceUsage>(json, opts);

            Assert.IsNotNull(deserialized);
            Assert.AreEqual(20, deserialized!.File);
            Assert.AreEqual(5, deserialized.Selection);
            Assert.AreEqual(1, deserialized.Codebase);
            Assert.AreEqual(2, deserialized.Workspace);
            Assert.AreEqual(3, deserialized.Terminal);
            Assert.AreEqual(4, deserialized.Vscode);
        }

        // ── JSON property name casing ──────────────────────────────────────

        [TestMethod]
        public void DetailedStats_JsonPropertyNames_UseCamelCase()
        {
            var stats = new DetailedStats
            {
                LastUpdated = "2025-01-01T00:00:00Z",
                BackendConfigured = true,
            };

            var json = JsonSerializer.Serialize(stats);

            // Verify camelCase property names in JSON output
            Assert.IsTrue(json.Contains("\"lastUpdated\""), "Should use camelCase: lastUpdated");
            Assert.IsTrue(json.Contains("\"backendConfigured\""), "Should use camelCase: backendConfigured");
            Assert.IsTrue(json.Contains("\"today\""), "Should use camelCase: today");
            Assert.IsTrue(json.Contains("\"last30Days\""), "Should use camelCase: last30Days");
        }

        [TestMethod]
        public void PeriodStats_JsonPropertyNames_UseCamelCase()
        {
            var period = new PeriodStats { ThinkingTokens = 100, EstimatedTokens = 200 };
            var json = JsonSerializer.Serialize(period);
            Assert.IsTrue(json.Contains("\"thinkingTokens\""), "Should use camelCase: thinkingTokens");
            Assert.IsTrue(json.Contains("\"estimatedTokens\""), "Should use camelCase: estimatedTokens");
            Assert.IsTrue(json.Contains("\"modelUsage\""), "Should use camelCase: modelUsage");
            Assert.IsTrue(json.Contains("\"editorUsage\""), "Should use camelCase: editorUsage");
        }
    }
}
