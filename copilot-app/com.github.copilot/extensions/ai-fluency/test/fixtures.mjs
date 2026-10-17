// Synthetic data only - never copy real session names, paths or stats here.
export function samplePayload() {
    const period = (tokens, sessions) => ({
        tokens,
        thinkingTokens: 10,
        sessions,
        avgInteractionsPerSession: 3,
        avgTokensPerSession: sessions ? tokens / sessions : 0,
        modelUsage: {
            "model-small": { inputTokens: 100, outputTokens: 20, cachedReadTokens: 50 },
            "model-large": { inputTokens: tokens, outputTokens: 5 },
        },
        editorUsage: { "Editor A": { tokens, sessions } },
        co2: 1.5,
        waterUsage: 0.02,
        treesEquivalent: 0.0001,
        estimatedCost: 1.25,
        estimatedCostCopilot: 0.5,
    });
    const today = new Date().toISOString();
    const session = (filePath, extra = {}) => ({
        title: null,
        filePath,
        interactions: 4,
        toolCalls: 9,
        inputTokens: 900,
        outputTokens: 100,
        thinkingTokens: 0,
        cachedTokens: 400,
        totalTokens: 1000,
        estimatedCost: 0.1,
        editor: "Editor A",
        models: ["model-large"],
        lastActivity: today,
        durationMs: 0,
        activeDurationMs: 120000,
        ...extra,
    });
    return {
        details: { today: period(1000, 1), month: period(5000, 3), lastMonth: period(0, 0), last30Days: period(6000, 4) },
        chart: {
            labels: ["2026-01-01", "2026-01-02"],
            tokensData: [10, 20],
            sessionsData: [1, 2],
            modelDatasets: [
                { label: "model-small", data: [2, 5], backgroundColor: "ignored" },
                { label: "model-large", data: [8, 15] },
                { label: "model-unused", data: [0, 0] },
            ],
            periods: {
                day: { costData: [0.1, 0.23456], editorCostDatasets: [{ label: "Editor A", data: [0.1, 0.23456] }] },
                week: { labels: ["Dec 29–Jan 4"], tokensData: [30], sessionsData: [3], costData: [0.3], repositoryDatasets: [] },
            },
        },
        usage: {
            todaySessions: [session("/tmp/a.jsonl")],
            recentSessions: {
                last7: [session("/tmp/a.jsonl"), session("/tmp/b.jsonl", { totalTokens: 5000, lastActivity: "2026-01-01T00:00:00.000Z" })],
                last30: [session("/tmp/b.jsonl", { totalTokens: 5000, lastActivity: "2026-01-01T00:00:00.000Z" })],
                currentMonth: [],
            },
        },
        fluency: {
            overallStage: 3,
            overallLabel: "Stage 3: AI Collaborator",
            categories: [{ category: "Prompt Engineering", icon: "P", stage: 3, evidence: ["did things"], tips: ["do more"] }],
            period: { huge: "ignored" },
        },
        curation: { ignored: true },
    };
}

