/**
 * Shared type definitions for the AI Engineering Fluency extension.
 * Extracted from extension.ts to reduce file size and improve reusability.
 */
import type { TaskCategory, TaskCategoryBreakdown, TaskClassificationResult } from './taskClassification';
import type { CacheBreakageResult, CacheBreakagePeriodStats } from './cacheBreakage';
import type { HydraFusionSummary } from './hydrafusion';

/**
 * Character-to-token ratio for a specific AI model.
 * The value is a multiplier applied to the character count to estimate token count
 * (e.g. 0.25 means ~4 characters per token).
 */
export type TokenEstimator = number;

export interface TokenUsageStats {
  todayTokens: number;
  monthTokens: number;
  lastUpdated: Date;
}

/**
 * A model identifier string as returned by the AI provider (e.g. "gpt-4o", "claude-sonnet-4-5").
 * May be "unknown" when the model could not be determined from the session data.
 */
export type ModelId = string;

export interface ModelUsage {
  [modelName: ModelId]: {
    inputTokens: number;    // total input tokens (uncached + cached reads + cache creation)
    outputTokens: number;
    cachedReadTokens?: number;     // portion of inputTokens that were cache reads (billed at reduced rate)
    cacheCreationTokens?: number;  // portion of inputTokens used to create cache entries (billed at higher rate)
    /**
     * Portion of cacheCreationTokens written under Anthropic's 1-hour cache TTL
     * (`cache_creation.ephemeral_1h_input_tokens`), billed at a higher rate than the
     * default 5-minute TTL. When present, calculateEstimatedCost() prices this portion
     * with `cacheCreation1hCostPerMillion` and the remainder of cacheCreationTokens with
     * the standard `cacheCreationCostPerMillion` (5-minute) rate.
     */
    cacheCreation1hTokens?: number;
    thinkingTokens?: number;
    /** Token subset from explicitly Auto-routed Copilot requests (not additional usage). */
    autoRouting?: Omit<ModelUsage[string], 'sessions' | 'autoRouting'>;
    /** Number of sessions that used this model in the aggregated period. */
    sessions: number;
  };
}

export interface CopilotLongContextPricing {
  inputCostPerMillion: number;
  outputCostPerMillion: number;
  cachedInputCostPerMillion?: number;
  cacheCreationCostPerMillion?: number;
  cacheCreation1hCostPerMillion?: number;
  threshold?: string;           // input-token threshold above which long-context rates apply (e.g. "> 200K")
}

export interface CopilotPricing {
  inputCostPerMillion: number;
  outputCostPerMillion: number;
  cachedInputCostPerMillion?: number;
  cacheCreationCostPerMillion?: number;
  cacheCreation1hCostPerMillion?: number;
  releaseStatus?: string;       // e.g. "GA" or "Public preview"
  category?: string;            // GitHub Copilot capability category (Lightweight / Versatile / Powerful)
  threshold?: string;           // input-token threshold for the Default tier, when the model is tiered
  /**
   * Optional Long-context tier rates for models that price differently above a
   * context-window threshold. The top-level fields above are the Default tier.
   * Additive — cost calculation uses the Default tier; consumers may opt in.
   */
  longContext?: CopilotLongContextPricing;
}

export interface ModelPricing {
  inputCostPerMillion: number;
  outputCostPerMillion: number;
  cachedInputCostPerMillion?: number;    // cost per million cache-read tokens (e.g. 0.30 for Claude Sonnet 4)
  cacheCreationCostPerMillion?: number;  // cost per million cache-creation tokens, 5-minute TTL (e.g. 3.75 for Claude Sonnet 4)
  cacheCreation1hCostPerMillion?: number; // cost per million cache-creation tokens, 1-hour TTL (e.g. 6.0 for Claude Sonnet 4)
  category?: string;
  tier?: "standard" | "premium" | "unknown";
  displayNames?: string[];
  /**
   * GitHub Copilot AI-Credit per-token pricing (1 credit = $0.01).
   * Source: https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing
   * When omitted the top-level provider/API rates are used as a fallback proxy.
   */
  copilotPricing?: CopilotPricing;
}

export interface EditorUsage {
  [editorType: string]: {
    tokens: number;
    sessions: number;
    /**
     * User-request turns for this editor on this day. Optional because older
     * in-memory stats (and fixtures) predate it; treat a missing value as 0
     * rather than as "unknown".
     */
    interactions?: number;
    linesAdded?: number;
    linesRemoved?: number;
  };
}

export interface RepositoryUsage {
  [repository: string]: {
    tokens: number;
    sessions: number;
    linesAdded?: number;
    linesRemoved?: number;
  };
}

export interface LanguageUsage {
  [extension: string]: {
    linesAdded: number;
    linesRemoved: number;
  };
}

export interface PeriodStats {
  tokens: number;
  thinkingTokens: number;
  estimatedTokens: number; // Text-based estimate (user messages + responses only)
  actualTokens: number; // Actual LLM API-reported tokens (0 when unavailable)
  sessions: number;
  avgInteractionsPerSession: number;
  avgTokensPerSession: number;
  modelUsage: ModelUsage;
  editorUsage: EditorUsage;
  co2: number;
  treesEquivalent: number;
  waterUsage: number;
  estimatedCost: number;
  /**
   * Estimated cost using GitHub Copilot AI-Credit per-token rates (when available
   * for a given model). Optional/additive so existing fixtures don't need updating.
   * Falls back to provider/API pricing for models without `copilotPricing`.
   */
  estimatedCostCopilot?: number;
  /** Sum of cache-read tokens across all interactions in this period (when available). */
  cachedTokens?: number;
  /**
   * Estimated cost per billing group for this period in USD.
   * Keys are billing group names (e.g. "GitHub Copilot", "Anthropic", "Google").
   * Uses Copilot AI-Credit pricing for the "GitHub Copilot" group; provider/API
   * rates for all others.
   */
  billingGroupCosts?: Record<string, number>;
  /**
   * Per-editor model usage breakdown for this period — mirrors `DailyTokenStats.editorModelUsage`.
   * Lets consumers (e.g. the Details webview) determine which billing group(s) an editor or
   * model belongs to, so the "Usage by Editor"/"Model Usage" lists can be filtered by provider.
   */
  editorModelUsage?: { [editor: string]: ModelUsage };
  /** Number of sessions in this period that delegated work to sub-agents (had 1+ sub-agent tool calls; see `SessionFileCache.subAgentCalls`). Absent when zero. */
  subAgentSessions?: number;
}

export interface DetailedStats {
  today: PeriodStats;
  month: PeriodStats;
  lastMonth: PeriodStats;
  last30Days: PeriodStats;
  lastUpdated: Date;
}

export interface DailyTokenStats {
  date: string; // YYYY-MM-DD format
  tokens: number;
  sessions: number;
  interactions: number;
  modelUsage: ModelUsage;
  editorUsage: EditorUsage;
  repositoryUsage: RepositoryUsage;
  taskCategoryTokens?: Partial<Record<TaskCategory, number>>;
  taskCategorySessions?: Partial<Record<TaskCategory, number>>;
  taskCategoryModelUsage?: Partial<Record<TaskCategory, ModelUsage>>;
  languageUsage?: LanguageUsage;
  linesAdded?: number;
  linesRemoved?: number;
  /**
   * Per-editor model usage breakdown — used to compute accurate cost-by-editor charts.
   * Each key is an editor display name (e.g. "VS Code", "Claude Code"); the value is the
   * model usage aggregated from all sessions of that editor type on that day.
   */
  editorModelUsage?: { [editor: string]: ModelUsage };
  /** Per-task-category token/session breakdown for this day, keyed by `TaskCategory` (e.g. "Coding", "Debugging"). */
  taskCategoryUsage?: { [category: string]: { tokens: number; sessions: number } };
  /**
   * Per-model efficiency counters for this day — the time-sliceable form of
   * {@link ModelEfficiencyUsage} that powers model-vs-model comparisons.
   * Absent when no session on this day carried per-model efficiency data.
   */
  modelEfficiency?: DailyModelEfficiency;
  /**
   * Per-editor split of {@link modelEfficiency}. Every session contributes to
   * exactly one editor, so merging all editors reproduces `modelEfficiency`
   * exactly — which is what lets the Efficiency view offer an editor filter
   * without a second, divergent aggregation path.
   */
  editorModelEfficiency?: { [editor: string]: DailyModelEfficiency };
}

/**
 * One model's efficiency counters for a single day, extending the per-session
 * {@link ModelEfficiencyCounters} with the session-level signals that have to be
 * *attributed* to a model rather than measured per model (duration, lines of
 * code, apply-button usage). For sessions that used several models these are
 * split by the model's share of the session's tokens.
 */
export interface DailyModelEfficiencyEntry extends ModelEfficiencyCounters {
  /** Sessions that used this model at all. A 2-model session adds 1 to both models. */
  sessions: number;
  /**
   * Token-weighted "session equivalents" — a 2-model session splits 1.0 between
   * its models. This is the honest denominator for per-session ratios, since
   * `sessions` deliberately over-counts multi-model sessions.
   */
  sessionShare: number;
  /** Net active session time attributed to this model (token-weighted), in ms. */
  activeDurationMs: number;
  /** Sessions that contributed to `activeDurationMs` (token-weighted). */
  durationSessionShare: number;
  /** Lines added attributed to this model (token-weighted). */
  linesAdded: number;
  /** Lines removed attributed to this model (token-weighted). */
  linesRemoved: number;
  /** Apply-button uses attributed to this model (token-weighted). */
  applies: number;
  /** Code blocks shown attributed to this model (token-weighted). */
  codeBlocks: number;
}

export interface DailyModelEfficiency {
  [modelName: string]: DailyModelEfficiencyEntry;
}

/** Time-window selector options available in the Chart view. */
export type ChartTimeWindow = 'today' | 'last7' | 'last30' | 'last90' | 'currentMonth' | 'allTime';

/** Aggregated data for one time window (day/week/month) in the chart. */
export interface ChartPeriodData {
  labels: string[];
  /** ISO date keys for each bar, used for time-window filtering. Day=YYYY-MM-DD, week=Monday YYYY-MM-DD, month=YYYY-MM. */
  periodKeys: string[];
  tokensData: number[];
  sessionsData: number[];
  modelDatasets: object[];
  editorDatasets: object[];
  repositoryDatasets: object[];
  /** Number of bars / data points in this period. */
  periodCount: number;
  totalTokens: number;
  totalSessions: number;
  /** Average tokens per bar (per day / per week / per month). */
  avgPerPeriod: number;
  /** Estimated cost per period entry in USD (provider/API rates). */
  costData: number[];
  /** Total estimated cost for this period in USD (provider/API rates). */
  totalCost: number;
  /** Average estimated cost per bar in USD (provider/API rates). Raw float, not rounded. */
  avgCostPerPeriod: number;
  locData?: number[];
  linesAddedData?: number[];
  linesRemovedData?: number[];
  languageDatasets?: object[];
  locEditorDatasets?: object[];
  locRepositoryDatasets?: object[];
  totalLinesAdded?: number;
  totalLinesRemoved?: number;
  avgLocPerPeriod?: number;
  /**
   * Cost datasets split by editor/hosting surface — one dataset per editor type.
   * Each dataset's `data` array aligns with `labels`; values are estimated costs in USD.
   * Computed from per-day `editorModelUsage` using the appropriate pricing source for each editor.
   */
  editorCostDatasets?: object[];
  /**
   * Cost datasets split by billing provider — one dataset per provider group.
   * Groups: "GitHub Copilot" (all Copilot surfaces), "Anthropic" (Claude Code, etc.),
   * "Google" (Gemini CLI, etc.), "Mistral AI", "OpenAI", etc.
   * Copilot group uses AI-Credit pricing; all others use direct provider pricing.
   */
  billingGroupCostDatasets?: object[];
  /** Token datasets split by task category (e.g. "Coding", "Debugging", "Testing") — one stacked-bar dataset per category. */
  taskCategoryDatasets?: object[];
  /** Task-token datasets split by category. */
  taskCategoryTokenDatasets?: object[];
  /** Task-session datasets split by category. */
  taskCategorySessionDatasets?: object[];
  /** Task-cost datasets split by category. */
  taskCategoryCostDatasets?: object[];
  /**
   * Cost datasets split by model — one dataset per top model (by total cost), plus an
   * "Other models" dataset for the remainder. Each model's usage is priced using the
   * correct pricing source per editor it was used from.
   */
  modelCostDatasets?: object[];
  /** Session-count datasets split by model — one stacked-bar dataset per model. */
  modelSessionsDatasets?: object[];
  /** Session-count datasets split by editor — one stacked-bar dataset per editor. */
  editorSessionsDatasets?: object[];
  /** Session-count datasets split by billing provider — one stacked-bar dataset per provider group. */
  providerSessionsDatasets?: object[];
  /** Token datasets split by billing provider — one stacked-bar dataset per provider group. */
  providerTokensDatasets?: object[];
}

/** Shape of the data payload sent to the chart webview (via window.__INITIAL_CHART__ or postMessage). */
export interface ChartDataPayload {
  labels: string[];
  tokensData: number[];
  sessionsData: number[];
  modelDatasets: object[];
  editorDatasets: object[];
  editorTotalsMap: Record<string, number>;
  repositoryDatasets: object[];
  repositoryTotalsMap: Record<string, number>;
  taskCategoryDatasets?: object[];
  dailyCount: number;
  totalTokens: number;
  avgTokensPerDay: number;
  totalSessions: number;
  lastUpdated: string;
  backendConfigured: boolean;
  compactNumbers?: boolean;
  /** Pre-computed data for Day / Week / Month period views. */
  periods: {
    day: ChartPeriodData;
    week: ChartPeriodData;
    month: ChartPeriodData;
  };
  /**
   * Whether the full-year data needed for Week and Month views is ready.
   * When false, the webview should indicate that those views are loading.
   */
  periodsReady?: boolean;
  hasLocData?: boolean;
}

/** Per-UTC-day token/interaction breakdown for a single session. Used for accurate daily stats. */
export interface DailyRollupEntry {
  tokens: number;
  actualTokens: number;
  thinkingTokens: number;
  cachedReadTokens?: number;
  interactions: number;
  modelUsage: ModelUsage;
  taskCategoryShares?: TaskCategoryBreakdown;
  primaryTaskCategory?: TaskCategory;
  /** Per-day share of the session's exact Copilot billing (in USD). Set when session has nanoAiu data. */
  copilotExactCostDollars?: number;
}

export interface SessionFileCache {
  tokens: number;
  interactions: number;
  modelUsage: ModelUsage;
  mtime: number; // file modification time as timestamp
  size?: number; // file size in bytes (optional for backward compatibility)
  /**
   * True for a placeholder written by the details-only parse (Details/Diagnostics) for a session
   * that was never fully analyzed: tokens/usageAnalysis are not real. getSessionFileDataCached()
   * treats it as a miss; the full analysis result replaces it (and never carries this flag).
   */
  detailsOnly?: true;
  usageAnalysis?: SessionUsageAnalysis; // New analysis data
  taskCategory?: TaskCategory;
  taskCategoryShares?: TaskCategoryBreakdown;
  firstInteraction?: string | null; // ISO timestamp of first interaction
  lastInteraction?: string | null; // ISO timestamp of last interaction
  title?: string; // Session title (customTitle from session file)
  repository?: string; // Git remote origin URL for the session's workspace
  /**
   * True once a full parse has attempted repository extraction for this cache entry.
   * `repository` can legitimately stay undefined afterward (e.g. no resolvable repo) —
   * this flag is what distinguishes "resolved to nothing" from "never attempted", so a
   * repo-less session doesn't get re-parsed on every single cache read forever.
   */
  repositoryResolved?: boolean;
  workspaceFolderPath?: string; // Full local path to the workspace folder (optional)
  thinkingTokens?: number; // Estimated thinking/reasoning tokens
  actualTokens?: number; // Actual token count from LLM API usage data (when available)
  cacheReadTokens?: number; // Cache-read token count from session.shutdown modelMetrics or ecosystem adapter API usage
  modelTurns?: number; // Number of LLM API calls in agent-mode sessions (from debug log)
  debugLogInputTokens?: number; // Input token total from debug log (sum across all llm_request events)
  debugLogOutputTokens?: number; // Output token total from debug log (sum across all llm_request events)
  debugLogChecked?: boolean; // Sentinel: true means we already looked for a debug log and found none
  /** Number of sub-agent/delegation tool calls in this session (Copilot CLI `task`/`read_agent`/`write_agent`/`list_agents`, Claude Code `Task`, `runSubagent`, `delegate_*`, …), via `countDelegationToolCalls()`. Absent when zero. */
  subAgentCalls?: number;
  /** Exact GitHub Copilot billing for this session in USD (from session.shutdown.totalNanoAiu or debug log copilotUsageNanoAiu). */
  copilotExactCostDollars?: number;
  /** Number of session.truncation events where messages were removed (breaking prompt cache). 0 or absent means no truncation. */
  truncationCount?: number;
  /** Total messages removed across all truncation events. Absent when truncationCount is 0 or unavailable. */
  messagesRemovedByTruncation?: number;
  /** Largest single-request prompt size (input incl. cached tokens) observed in this session. Used for long-context tier detection. */
  maxRequestInputTokens?: number;
  /** Copilot CLI context tier from session.start/resume/model_change events (e.g. "default"). */
  contextTier?: string;
  /** Per-UTC-day token/interaction breakdown (keyed by YYYY-MM-DD UTC). Used for consistent daily stats. */
  dailyRollups?: { [utcDayKey: string]: DailyRollupEntry };
  linesAdded?: number;
  linesRemoved?: number;
  languageUsage?: LanguageUsage;
}

// Local copy of customization file entry type (mirrors webview/shared/contextRefUtils.ts)
export interface CustomizationFileEntry {
path: string;
relativePath: string;
type: string;
icon: string;
label: string;
name: string;
lastModified: string | null;
isStale: boolean;
category?: 'copilot' | 'non-copilot';
}

// New interfaces for usage analysis
/** Per-level request counts for thinking effort (reasoning effort) tracking. */
export interface ThinkingEffortUsage {
  /** Number of requests submitted at each effort level, keyed by level name (e.g. "low", "medium", "high"). */
  byEffort: { [effort: string]: number };
  /** Number of times the effort level changed within this session. */
  switchCount: number;
  /** The effort level active at the start of the session, or null if not available. */
  defaultEffort: string | null;
}

export interface SessionUsageAnalysis {
  toolCalls: ToolCallUsage;
  modeUsage: ModeUsage;
  /** Per-interaction autonomy level (autopilot/auto vs supervised). Absent when no surface reported one. */
  autonomyUsage?: AutonomyUsage;
  contextReferences: ContextReferenceUsage;
  mcpTools: McpToolUsage;
  /** Agent-skill invocation counts for this session. See {@link SkillCallUsage}. */
  skillCalls?: SkillCallUsage;
  /**
   * Prompt-cache invalidations detected in this session, with the cause of each.
   * Absent for session formats that do not report per-turn cache token counts.
   */
  cacheBreakage?: CacheBreakageResult;
  /** Aggregated task-classification result for this session. */
  taskClassification: TaskClassificationResult;
  modelSwitching: {
    uniqueModels: string[];
    modelCount: number;
    switchCount: number;
    autoSessions: number;
    foundryWindowsSessions: number;
    unknownProviderSessions: number;
    selectedModelExtensions: string[];
    unknownProviderModels: string[];
    tiers: { standard: string[]; premium: string[]; unknown: string[] };
    hasMixedTiers: boolean;
    standardRequests: number;
    premiumRequests: number;
    unknownRequests: number;
    totalRequests: number;
    costBuckets: { low: string[]; medium: string[]; high: string[]; unknown: string[] };
    hasMixedCosts: boolean;
    lowCostRequests: number;
    mediumCostRequests: number;
    highCostRequests: number;
  };
  thinkingEffort?: ThinkingEffortUsage;
  editScope?: EditScopeUsage;
  applyUsage?: ApplyButtonUsage;
  sessionDuration?: SessionDurationData;
  conversationPatterns?: ConversationPatterns;
  agentTypes?: AgentTypeUsage;
  /**
   * Per-model efficiency counters derived from this session's structured tool-call
   * data. Absent when the session format carries no per-turn tool-call detail.
   * Token/cost fields are zero here — they are folded in at aggregation time.
   */
  modelEfficiency?: ModelEfficiencyUsage;
  /**
   * Correction moments detected in this session's conversation (see
   * src/correctionDetection.ts). Absent when the session format carries no
   * per-turn detail or no moments were found.
   */
  correctionMoments?: CorrectionMoment[];
  /** Complete correction counts; unlike correctionMoments, these are not detail-capped. */
  correctionCounts?: CorrectionCounts;
  /**
   * The session's first user prompt (truncated), captured for repeated-task
   * detection (see src/repeatedTasks.ts). Absent when the session format
   * carries no user-message text.
   */
  firstUserPrompt?: string;
}

/**
 * Additive, log-spaced latency histogram (see src/latencyHistogram.ts).
 * `buckets[i]` counts durations in `[2^i, 2^(i+1))` ms; the last bucket is overflow.
 * Stored as counts + sum (never averages) so it merges correctly across sessions,
 * cache entries and backend rollups.
 */
export interface LatencyHistogram {
  count: number;
  sumMs: number;
  buckets: number[];
}

export interface ToolCallUsage {
  total: number;
  byTool: { [toolName: string]: number };
  outputTokensByTool?: { [toolName: string]: number };
  /**
   * Calls whose session log recorded an explicit verdict (success or failure) on a
   * completion/result event matched to its start. This is the denominator for
   * `failuresByTool` and `outputTokensByTool`, which are only ever recorded for such
   * calls; unlike `byTool` it excludes orphaned starts, streaming re-logs, editors whose
   * format carries no completion events, and verdict-less completions (older Copilot CLI
   * schemas). `latencyByTool` is a *different* population — any matched completion with
   * usable timestamps, verdict or not — so its `count` may differ from this in either
   * direction; never divide one by the other. Absent when no format contributed
   * verdicts. MCP calls are counted under {@link McpToolUsage.completedByServer} instead.
   */
  completedByTool?: { [toolName: string]: number };
  /**
   * Calls whose session log explicitly flagged them as failed (Copilot CLI/JetBrains
   * `tool.execution_complete.success === false`, Claude Code `tool_result.is_error`).
   * A subset of `completedByTool`; absent when no failure was recorded.
   */
  failuresByTool?: { [toolName: string]: number };
  /**
   * Observed execution duration per tool, from the start→complete timestamp delta.
   * This includes permission-prompt and queueing time, not just tool runtime. Sampled
   * from every matched completion with usable timestamps, including verdict-less ones,
   * so `count` is its own population (see {@link completedByTool}). Absent when the
   * format carries no per-call timestamps.
   */
  latencyByTool?: { [toolName: string]: LatencyHistogram };
}

export interface ModeUsage {
  ask: number; // Regular chat mode
  edit: number; // Edit mode interactions
  agent: number; // Agent mode interactions (standard agent mode)
  plan: number; // Plan mode interactions (built-in plan agent)
  customAgent: number; // Custom agent mode interactions (.agent.md files)
  cli: number; // CLI tool interactions (Copilot CLI, Claude Code CLI, OpenCode, Crush, Mistral Vibe, Hermes, Pi, …)
  cliApp?: number; // Subset of CLI interactions: Copilot CLI sessions started via the Copilot desktop app (client_name: github/autopilot), broken out from `cli`
  claudeDesktop?: number; // Claude Code sessions launched from the standalone Claude Desktop app (entrypoint: 'claude-desktop'), broken out of `cli` so terminal usage isn't inflated by desktop-app usage
  claudeVsCode?: number; // Claude Code sessions running inside an IDE, e.g. the VS Code extension (entrypoint: 'claude-vscode' or any non-CLI/non-desktop value), broken out of `cli` for the same reason
}

/**
 * How much autonomy the user granted per interaction, independent of the chat mode (ask/edit/agent).
 * Sources: Copilot CLI `agentMode` on user.message, VS Code Copilot Chat `inputState.permissionLevel`,
 * Claude Code `permissionMode` on human user entries.
 */
export interface AutonomyUsage {
  autonomous: number; // Copilot "autopilot" / Claude Code "auto"
  supervised: number; // Copilot "interactive" / "default", Claude Code "default" / "acceptEdits"
  plan: number; // Plan mode
  other: number; // Recognised-but-unclassified values (e.g. Claude "bypassPermissions")
}

export interface ContextReferenceUsage {
  file: number; // #file references
  selection: number; // #selection references
  implicitSelection: number; // Implicit selections via inputState.selections
  symbol: number; // #symbol references
  codebase: number; // #codebase references
  workspace: number; // @workspace references
  terminal: number; // @terminal references
  vscode: number; // @vscode references
  terminalLastCommand: number; // #terminalLastCommand references
  terminalSelection: number; // #terminalSelection references
  clipboard: number; // #clipboard references
  changes: number; // #changes references
  outputPanel: number; // #outputPanel references
  problemsPanel: number; // #problemsPanel references
  pullRequest: number; // #pr / #pullRequest references (Copilot PR chat, April 2026)
  codeContextLines?: number; // Total lines of code referenced via #file: range selections
  // contentReferences tracking from session logs
  byKind: { [kind: string]: number }; // Count by reference kind
  copilotInstructions: number; // .github/copilot-instructions.md
  agentsMd: number; // agents.md in repo root
  byPath: { [path: string]: number }; // Count by unique file path
}

export interface McpToolUsage {
  total: number;
  byServer: { [serverName: string]: number };
  byTool: { [toolName: string]: number };
  /** MCP calls with a recorded outcome per server; see {@link ToolCallUsage.completedByTool}. */
  completedByServer?: { [serverName: string]: number };
  /** Failed MCP calls per server; same source and caveats as {@link ToolCallUsage.failuresByTool}. */
  failuresByServer?: { [serverName: string]: number };
  /** Observed MCP call duration per server; same source and caveats as {@link ToolCallUsage.latencyByTool}. */
  latencyByServer?: { [serverName: string]: LatencyHistogram };
}

/**
 * Agent-skill invocation counts (e.g. Claude Code's `Skill` tool unwrapped to the
 * actual skill name from `input.skill`). Adapter-agnostic — populated only by
 * adapters whose session format can resolve a specific skill name from a wrapper
 * tool call; absent/empty for adapters where skill/prompt invocation leaves no
 * distinguishable session-log signal.
 */
export interface SkillCallUsage {
  total: number;
  byName: { [skillName: string]: number };
}

/**
 * Per-model efficiency counters (issue #1649).
 *
 * Turn-derived counters (calls/editTurns/oneShotEditTurns/retries/selfCorrections)
 * are computed per session from structured tool-call data where available
 * (Copilot Chat JSON, Copilot CLI JSONL, and every ecosystem adapter with buildTurns).
 * Token/cost fields are folded in separately at aggregation time from each
 * session's ModelUsage so no extra session parsing is needed.
 *
 * A "call" is one user-request turn — the closest unit comparable across all
 * supported editors (one agentic turn may span multiple underlying API calls).
 */
export interface ModelEfficiencyCounters {
  /** User-request turns attributed to this model. */
  calls: number;
  /** Tool invocations across those turns. Used as the local equivalent of agent steps. */
  toolCalls?: number;
  /** Turns containing at least one file-edit tool call. */
  editTurns: number;
  /** Edit turns with no retries and no self-corrections. */
  oneShotEditTurns: number;
  /** Repeat edit calls immediately following an edit to the same file (failed edit retried). */
  retries: number;
  /** Repeat edits to a file already edited in the same turn with other tool calls in between (model checked, then corrected itself). */
  selfCorrections: number;
  /** Total file-edit tool calls attributed to this model. */
  editToolCalls: number;
  /** Total input tokens (incl. cache reads/creation). Folded in from ModelUsage at aggregation time. */
  inputTokens: number;
  /** Total output tokens. Folded in from ModelUsage at aggregation time. */
  outputTokens: number;
  /** Cache-read portion of inputTokens. Folded in from ModelUsage at aggregation time. */
  cachedReadTokens: number;
  /** Estimated cost in USD (provider/API rates). Folded in at aggregation time. */
  cost: number;
}

export interface ModelEfficiencyUsage {
  [modelName: string]: ModelEfficiencyCounters;
}

// ---------------------------------------------------------------------------
// Correction moments (see src/correctionDetection.ts)
// ---------------------------------------------------------------------------

/**
 * Kinds of correction moments detected in a session conversation:
 * - `user-correction`       — a user message correcting the agent ("no, that's wrong", "revert", ...)
 * - `edit-retry`            — a repeat edit to a file whose immediately preceding tool call was an
 *                             edit to the same file (failed edit retried right away)
 * - `edit-self-correction`  — a repeat edit to a file already edited in the same turn with other
 *                             tool calls in between (the model checked, then corrected itself)
 * - `tool-error`            — a tool call that failed (where the format records success/failure);
 *                             `retried` is true when the same tool was called again later
 * - `agent-self-correction` — an assistant message admitting or fixing a mistake ("my mistake",
 *                             "let me fix", "you're right", ...)
 */
export type CorrectionMomentType =
  | 'user-correction'
  | 'edit-retry'
  | 'edit-self-correction'
  | 'tool-error'
  | 'agent-self-correction';

/** One detected correction moment within a session. */
export interface CorrectionMoment {
  type: CorrectionMomentType;
  /** 1-based user-turn index within the session. */
  turnNumber: number;
  timestamp: string | null;
  /** Short excerpt (capped length) providing context for the moment. */
  snippet: string;
  /** Tool name for `tool-error` moments. */
  tool?: string;
  /** Target file for `edit-retry` / `edit-self-correction` moments. */
  file?: string;
  /** For `tool-error`: the same tool was called again later in the session. */
  retried?: boolean;
  /** Label of the heuristic pattern that matched (pattern-based types only). */
  matchedPattern?: string;
  /**
   * `user-correction` only: set when the message itself carries extra intensity cues
   * (ALL-CAPS emphasis, repeated `!`/`?`, "again"/"seriously"-style intensifiers) on top
   * of the base correction phrasing. A rough proxy for "the user sounds more frustrated
   * than a plain correction", not a verdict.
   */
  intensity?: 'strong';
  /**
   * `user-correction` only: set when this is the second (or later) user-correction
   * within a short rolling window of turns, i.e. corrections are clustering rather than
   * being one-off — the closest local proxy for rising frustration we can compute
   * without any external sentiment data.
   */
  escalated?: boolean;
  /**
   * `agent-self-correction` only: which nearby signal corroborated the phrase match.
   * `agent-self-correction` moments are only emitted when corroborated (see
   * correctionDetection.ts) — this records why, mainly for UI/debugging transparency.
   */
  corroboratedBy?: 'tool-error' | 'edit-retry' | 'user-correction';
}

/** Aggregated correction-moment counters (per session, repo, or period). */
export interface CorrectionCounts {
  userCorrections: number;
  editRetries: number;
  editSelfCorrections: number;
  toolErrors: number;
  toolErrorsRetried: number;
  agentSelfCorrections: number;
  /** Count of `user-correction` moments with `escalated: true` (see CorrectionMoment). */
  escalatedUserCorrections: number;
}

/** Period-level correction counters plus the number of sessions that had any moment. */
export interface CorrectionPeriodCounts extends CorrectionCounts {
  sessionsWithMoments: number;
  /** Sessions containing at least one user-correction moment. */
  sessionsWithUserCorrections?: number;
  /** Sessions containing at least one escalated user-correction moment. */
  sessionsWithEscalations?: number;
}

/** One session's entry in the correction report. */
export interface CorrectionSessionEntry {
  file: string;
  title?: string | null;
  lastInteraction?: string | null;
  moments: CorrectionMoment[];
  /** Complete count before correctionMoments is detail-capped. */
  totalMoments?: number;
}

/** Correction moments for one repository, over its most recent sessions. */
export interface CorrectionRepoGroup {
  repository: string;
  sessions: CorrectionSessionEntry[];
  counts: CorrectionCounts;
  sessionsWithMoments: number;
}

/**
 * Report of correction moments across repositories, each limited to its most
 * recent sessions (see `sessionsPerRepo`). Built from cached per-session
 * `SessionUsageAnalysis.correctionMoments`.
 */
export interface CorrectionReport {
  sessionsPerRepo: number;
  repos: CorrectionRepoGroup[];
  counts: CorrectionCounts;
  sessionsWithMoments: number;
}

// ---------------------------------------------------------------------------
// Repeated tasks (see src/repeatedTasks.ts)
// ---------------------------------------------------------------------------

/** Reference to one session in a repeated-task cluster. */
export interface RepeatedTaskSessionRef {
  file: string;
  title?: string | null;
  lastInteraction?: string | null;
  repository?: string;
}

/**
 * A group of sessions whose first user prompts are similar enough to describe
 * the same task — a candidate for a reusable skill, prompt file, or agent.
 */
export interface RepeatedTaskCluster {
  /** The cluster's most recent prompt, truncated for display. */
  representativePrompt: string;
  sessionCount: number;
  /** Repositories (short owner/repo names) the cluster's sessions belong to. */
  repositories: string[];
  /** Most recent session first. */
  sessions: RepeatedTaskSessionRef[];
  /** Tokens shared by every prompt in the cluster (display hint). */
  sharedKeywords: string[];
}

/** Repeated-task candidates across all scanned sessions. */
export interface RepeatedTaskReport {
  minClusterSize: number;
  /** Sessions whose first user prompt survived normalization and was clustered (see normalizePromptTokens). */
  sessionsScanned: number;
  clusters: RepeatedTaskCluster[];
}

export interface EditScopeUsage {
  singleFileEdits: number; // Edit sessions touching 1 file
  multiFileEdits: number; // Edit sessions touching 2+ files
  totalEditedFiles: number; // Total unique files edited
  avgFilesPerSession: number; // Average files per edit session
  linesAdded?: number;
  linesRemoved?: number;
  languageUsage?: LanguageUsage;
}

export interface ApplyButtonUsage {
  totalApplies: number; // Total Apply button uses
  totalCodeBlocks: number; // Total code blocks shown
  applyRate: number; // % of code blocks applied
}

export interface SessionDurationData {
  totalDurationMs: number; // Total session time (wall clock: last timestamp - first timestamp, includes idle gaps between turns)
  avgDurationMs: number; // Average session duration (wall clock)
  avgFirstProgressMs: number; // Average time to first response
  avgTotalElapsedMs: number; // Average total request time
  avgWaitTimeMs: number; // Average user wait time between interactions
  activeDurationMs: number; // Sum of merged [requestTimestamp, requestTimestamp+totalElapsed] windows: actual interactive + tool/agent wait time, excluding idle gaps between turns
}

export interface ConversationPatterns {
  multiTurnSessions: number; // Sessions with >1 request
  singleTurnSessions: number; // Sessions with 1 request
  avgTurnsPerSession: number; // Average requests per session
  maxTurnsInSession: number; // Longest conversation
}

export interface AgentTypeUsage {
  editsAgent: number; // github.copilot.editsAgent usage
  defaultAgent: number; // github.copilot.default usage
  workspaceAgent: number; // github.copilot.workspace usage
  other: number; // Other agents
}

export interface ModelSwitchingAnalysis {
  modelsPerSession: number[]; // Array of unique model counts per session
  totalSessions: number;
  averageModelsPerSession: number;
  maxModelsPerSession: number;
  minModelsPerSession: number;
  switchingFrequency: number; // % of sessions with >1 model
  autoSessions: number; // Sessions with an Auto-selected model
  foundryWindowsSessions: number; // Sessions using Microsoft Foundry on Windows / local models
  unknownProviderSessions: number; // Sessions with models from unknown providers
  standardModels: string[]; // Unique standard models used
  premiumModels: string[]; // Unique premium models used
  unknownModels: string[]; // Unique models with unknown tier
  mixedTierSessions: number; // Sessions using both standard and premium
  standardRequests: number; // Count of requests using standard models
  premiumRequests: number; // Count of requests using premium models
  unknownRequests: number; // Count of requests using unknown tier models
  totalRequests: number; // Total requests across all tiers
  lowCostModels: string[];
  mediumCostModels: string[];
  highCostModels: string[];
  mixedCostSessions: number;
  lowCostRequests: number;
  mediumCostRequests: number;
  highCostRequests: number;
  selectedModelExtensions: string[]; // Unique selectedModel metadata extensions observed
  unknownProviderModels: string[]; // Unique models whose provider could not be identified
}

export interface MissedPotentialWorkspace {
workspacePath: string;
workspaceName: string;
sessionCount: number;
interactionCount: number;
nonCopilotFiles: CustomizationFileEntry[];
}


/** Summary of a single session for the "Recent Sessions" tab. */
export interface TodaySessionSummary {
  title: string | null;
  filePath: string;
  interactions: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cachedTokens: number;
  totalTokens: number;
  estimatedCost: number;
  editor: string;
  models: string[];
  lastActivity: string;
  /** Number of truncation events where messages were removed in this session. 0 or absent means no truncation. */
  truncationCount?: number;
  /** Largest single-request prompt size (input incl. cached tokens) observed in this session. */
  maxRequestInputTokens?: number;
  /** Copilot CLI context tier for this session (e.g. "default"); absent when not recorded. */
  contextTier?: string;
  /** Selected input-token window limit (Copilot CLI, from data.db context_input_token_limit). */
  contextWindowLimit?: number;
  /** Last known context fill in tokens (Copilot CLI, from data.db context_current_tokens). */
  contextReachedTokens?: number;
  /** Wall-clock session duration in milliseconds (last interaction − first interaction), including idle gaps between turns. Absent when not derivable. Kept for reference/future use; prefer `activeDurationMs` for display. */
  durationMs?: number;
  /** Net ("active") session duration in milliseconds: sum of merged [requestTimestamp, requestTimestamp+totalElapsed] windows, excluding idle gaps between turns. This is the value shown as "Duration" in the Recent Sessions list. Absent when not derivable. */
  activeDurationMs?: number;
  /** Workspace/repository name the session belongs to. Absent when attribution is unavailable. */
  workspace?: string;
  /** Number of sub-agent/delegation tool calls detected in this session (see `SessionFileCache.subAgentCalls`). Absent when zero. */
  subAgentCalls?: number;
}

/**
 * How many of the Claude Desktop sessions Desktop itself lists are backed by a transcript on this
 * disk. The shortfall is expected, not data loss: Claude Code prunes old transcripts on its own
 * retention schedule, and cloud-run sessions never write one to this machine at all.
 */
export interface ClaudeDesktopCoverage {
  /** Claude Desktop session records found on this machine. */
  knownSessions: number;
  /** Records whose transcript is readable here, so they can be measured. */
  withTranscript: number;
  /** Records with no local transcript — listed by Desktop, invisible to a local scanner. */
  missingTranscript: number;
}

export interface UsageAnalysisStats {
today: UsageAnalysisPeriod;
last30Days: UsageAnalysisPeriod;
/** Current calendar month-to-date. */
month: UsageAnalysisPeriod;
/** Previous calendar month (full month). */
lastMonth: UsageAnalysisPeriod;
/**
 * Per-tool, per-editor call counts for the last 30 days (tool name -> editor display name -> calls).
 * Covers general tools, MCP tools and MCP server names; used to tell maintainers which editor an
 * unknown tool was seen in when reporting it.
 */
toolCallsByEditor?: { [toolName: string]: { [editorSource: string]: number } };
locale?: string;
lastUpdated: Date;
customizationMatrix?: WorkspaceCustomizationMatrix;
missedPotential?: MissedPotentialWorkspace[];
todaySessions?: TodaySessionSummary[];
/**
 * Per-period session summaries for the "Recent Sessions" lookback selector, bucketed from
 * the already-parsed sessions the main analysis walks. Lets the host serve last7/last30/
 * currentMonth instantly instead of re-parsing the whole session corpus per period switch.
 */
recentSessions?: { last7: TodaySessionSummary[]; last30: TodaySessionSummary[]; currentMonth: TodaySessionSummary[] };
/** Optional tool curation analysis (VS Code only; absent in CLI/VS/JetBrains). */
curationAnalysis?: ToolCurationAnalysis | null;
/** Automatic context compactions observed across recent Copilot CLI and Claude sessions. */
autoCompactionsLast7Days?: AutomaticCompactionStats;
/**
 * Daily-bucketed multi-agent/delegation usage over the trailing ~30 days, for the
 * "Multi-Agent Usage" sparkline on the Fluency dashboard. Absent when no sessions
 * with multi-agent signals were found in the window.
 */
agenticDailyTrend?: AgenticTrendPoint[];
/**
 * Correction moments per repository over its most recent sessions
 * (default 25). Absent when no moments were detected.
 */
correctionReport?: CorrectionReport;
/**
 * Repeated-task candidates: clusters of sessions whose first user prompts
 * describe the same task (see src/repeatedTasks.ts). Absent when no
 * cluster reached the minimum size.
 */
repeatedTasks?: RepeatedTaskReport;
/** Optional Copilot memory-files hygiene analysis (VS Code only; absent in CLI/VS/JetBrains). */
memoryFilesAnalysis?: MemoryFilesAnalysis | null;
/**
 * Optional Claude Desktop local-transcript coverage, used to explain why Claude Desktop's own
 * session list is longer than what a local-disk scanner can report. Absent when no Claude
 * Desktop session records exist on this machine.
 */
claudeDesktopCoverage?: ClaudeDesktopCoverage;
}

/** One day's worth of multi-agent/delegation signal, used to render a trend sparkline. */
export interface AgenticTrendPoint {
  /** UTC date key, e.g. "2024-06-01". */
  date: string;
  /** Sessions that day with 2+ direct children (data.db/Hermes hierarchy). */
  multiAgentParentSessions: number;
  /** Sessions that day classified as `Delegation` by `classifySessionTask()`. */
  delegationSessions: number;
}

/** Matrix types used for Usage Analysis customization matrix */
export type CustomizationTypeStatus = "✅" | "⚠️" | "❌";

export interface WorkspaceCustomizationRow {
  workspacePath: string;
  workspaceName: string;
  sessionCount: number;
  interactionCount: number;
  typeStatuses: { [typeId: string]: CustomizationTypeStatus };
}

export interface WorkspaceCustomizationMatrix {
  customizationTypes: Array<{ id: string; icon: string; label: string }>;
  workspaces: WorkspaceCustomizationRow[];
  totalWorkspaces: number;
  workspacesWithIssues: number;
}

// ── Dark Factory readiness ────────────────────────────────────────────────
//
// A per-repository readiness scan over the dark factory maturity ladder
// (see src/darkFactoryReadiness.ts). The unit of assessment is always a
// repository — a product line — and never a person. The scan reports which
// governance and evidence controls a repository has; it never certifies that
// a team is ready to run without humans.

/**
 * State of one control. `unknown` is a first-class outcome: it means the scan
 * could not determine the state (no GitHub token, a denied API call, or a
 * control whose absence is not observable), and it must never be collapsed
 * into either `present` or `absent`.
 */
export type DarkFactoryControlState = 'present' | 'absent' | 'unknown';

/** Where a control's state comes from. */
export type DarkFactoryControlTier =
  /** Observable from the checked-out files alone, no authentication needed. */
  | 'filesystem'
  /** Only observable through the GitHub API (rulesets, protection rules, enablement). */
  | 'api'
  /** Presence is observable from files, but absence is not — those resolve to `unknown`. */
  | 'hybrid'
  /** A written policy or decision; never machine-detectable. */
  | 'governance';

/** How much weight the detection of a control carries. */
export type DarkFactoryEvidenceKind =
  /** An unambiguous file or API fact. */
  | 'direct'
  /** A pattern match that produces a candidate, not a verdict. */
  | 'heuristic'
  /** Not detectable by any scan; always reported as unknown. */
  | 'not-scannable';

/** One control in the catalogue (`src/darkFactoryControls.json`). */
export interface DarkFactoryControlDefinition {
  id: string;
  /** Ladder stage this control belongs to (1–4). */
  stage: number;
  label: string;
  tier: DarkFactoryControlTier;
  evidence: DarkFactoryEvidenceKind;
  /** Why the control matters on the ladder. */
  why: string;
  /** What to do when it is absent. */
  remediation: string;
  /** When true, a missing filesystem signal resolves to `unknown` rather than `absent`. */
  unknownWhenAbsent?: boolean;
  /** Explains why absence is not observable for this control. */
  unknownReason?: string;
}

/** One stage of the ladder as described in the catalogue. */
export interface DarkFactoryStageDefinition {
  stage: number;
  name: string;
  summary: string;
}

/** A control's assessed state, with the detail needed to render it honestly. */
export interface DarkFactoryControlResult extends DarkFactoryControlDefinition {
  state: DarkFactoryControlState;
  /** Short human-readable justification, e.g. the path that matched. */
  detail?: string;
}

/** Whether a stage's controls are all satisfied, definitely not, or unverifiable. */
export type DarkFactoryStageVerdict =
  /** Every control is present. */
  | 'attained'
  /** At least one control is absent — this stage is not reached. */
  | 'blocked'
  /** No control is absent, but at least one could not be determined. */
  | 'indeterminate';

/** Per-stage assessment for one repository. */
export interface DarkFactoryStageResult {
  stage: number;
  name: string;
  summary: string;
  verdict: DarkFactoryStageVerdict;
  /** Control ids that are present. */
  present: string[];
  /** Control ids that are absent — the specific things blocking this stage. */
  missing: string[];
  /** Control ids whose state could not be determined. */
  unknown: string[];
}

/** An anti-pattern the scan detected in a repository. */
export interface DarkFactoryFinding {
  id: string;
  severity: 'high' | 'medium' | 'low';
  title: string;
  /** What was observed that triggered this finding. */
  detail: string;
}

/** The readiness report for a single repository. */
export interface DarkFactoryRepoReport {
  /** Display name for the repository (its folder name). */
  name: string;
  /** Absolute path scanned. */
  repoRoot: string;
  /** `owner/repo` when the origin remote could be resolved. */
  nameWithOwner?: string;
  /**
   * Highest stage whose controls are *all* confirmed present. This is a lower
   * bound: unknowns never lift it.
   */
  confirmedStage: number;
  /**
   * Highest stage that nothing observed rules out — unknowns treated
   * optimistically. This is an upper bound, never a claim.
   */
  ceilingStage: number;
  /** True when every control resolved to `present` or `absent`. */
  fullyEvidenced: boolean;
  /** Number of controls whose state could not be determined. */
  unknownCount: number;
  stages: DarkFactoryStageResult[];
  controls: DarkFactoryControlResult[];
  findings: DarkFactoryFinding[];
}

/** The readiness report across all scanned repositories. */
export interface DarkFactoryReport {
  /** ISO timestamp of the scan. */
  scannedAt: string;
  /** True when GitHub API signals were included; false when the API tier was skipped. */
  apiSignalsIncluded: boolean;
  /** Highest stage the ladder can assess at all — stage 5 is never awarded. */
  maxAssessableStage: number;
  repos: DarkFactoryRepoReport[];
  /** Repositories found but not scanned because the per-scan cap was reached. */
  skippedRepoCount: number;
}

/** Automatic context compactions grouped by the session format that recorded them. */
export interface AutomaticCompactionStats {
  total: number;
  bySource: {
    copilotCli: number;
    claude: number;
  };
}

export interface UsageAnalysisPeriod {
  sessions: number;
  toolCalls: ToolCallUsage;
  modeUsage: ModeUsage;
  /** Aggregated per-interaction autonomy level across the period's sessions. */
  autonomyUsage?: AutonomyUsage;
  contextReferences: ContextReferenceUsage;
  mcpTools: McpToolUsage;
  /** Aggregated agent-skill invocation counts across the period's sessions. See {@link SkillCallUsage}. */
  skillCalls?: SkillCallUsage;
  modelSwitching: ModelSwitchingAnalysis;
  repositories: string[]; // Unique repositories worked in during this period
  repositoriesWithCustomization: string[]; // Repos with copilot-instructions.md or agents.md
  editScope: EditScopeUsage;
  applyUsage: ApplyButtonUsage;
  sessionDuration: SessionDurationData;
  conversationPatterns: ConversationPatterns;
  agentTypes: AgentTypeUsage;
  /** Aggregated thinking effort (reasoning effort) usage across all sessions in this period. */
  thinkingEffortUsage?: {
    byEffort: { [effort: string]: number };
    sessionCount: number; // sessions with effort data
    switchCount: number;  // total effort switches across all sessions
  };
  /**
   * Number of sessions in this period that are parents of 2+ child workspaces,
   * indicating multi-agent orchestration. Populated from ~/.copilot/data.db;
   * absent (undefined) when data.db is not available.
   */
  multiAgentParentSessions?: number;
  /**
   * Number of sessions in this period classified as `Delegation` by `classifySessionTask()`
   * (tool calls matching subagent/delegate patterns — Copilot CLI/Claude Code Task tool,
   * Hermes subagent source, etc.). A second, adapter-agnostic signal for sub-agent usage,
   * complementary to `multiAgentParentSessions` (which requires data.db/JSONL hierarchy data).
   * Populated during session caching; absent (undefined) when no such sessions exist.
   */
  delegationSessions?: number;
  /**
   * Context-window usage aggregated across the period's sessions.
   * Absent when no session in the period carried context-size data.
   */
  contextWindow?: ContextWindowStats;
  /**
   * Per-session context-exhaustion counters for the period (compacted vs.
   * almost-full sessions). Absent when no session carried a context signal.
   */
  contextPressure?: ContextPressureStats;
  /** Weighted task-category session totals for the period. */
  taskCategoryPrimarySessions?: Partial<Record<TaskCategory, number>>;
  taskCategoryWeightedSessions?: Partial<Record<TaskCategory, number>>;
  /**
   * Per-model efficiency metrics aggregated across the period's sessions
   * (issue #1649). Absent when no session in the period carried
   * efficiency counters or per-model token usage.
   */
  modelEfficiency?: ModelEfficiencyUsage;
  /**
   * Aggregated correction-moment counters across the period's sessions
   * (folded in by mergeUsageAnalysis from each session's correctionMoments).
   * Absent when no session in the period carried moments.
   */
  corrections?: CorrectionPeriodCounts;
  /**
   * Aggregated prompt-cache breakage across the period's sessions (folded in by
   * mergeUsageAnalysis). Absent when no session in the period reported cache
   * token counts.
   */
  cacheBreakage?: CacheBreakagePeriodStats;
}

/** Aggregated context-window usage for one usage-analysis period. */
export interface ContextWindowStats {
  /** Largest single-request prompt (input incl. cached tokens) observed in the period. */
  maxRequestInputTokens: number;
  /** Models used by the session holding that largest request. */
  maxRequestModels: string[];
  /** Number of sessions per Copilot CLI context tier (e.g. { default: 3 }). */
  tierCounts: { [tier: string]: number };
  /** Highest data.db context fill among the period's CLI sessions. */
  maxReachedTokens?: number;
  /** Selected window limit of that fullest CLI session. */
  maxReachedWindowLimit?: number;
}

/** Fraction of a session's context window that counts as "almost full". */
export const CONTEXT_NEAR_LIMIT_RATIO = 0.8;

/**
 * How often a period's sessions ran out of context window, counted per
 * *session* rather than per compaction event. Absent when no session in the
 * period carried a usable context signal.
 */
export interface ContextPressureStats {
  /** Sessions in the period that carried any context-window signal at all (the denominator). */
  sessionsConsidered: number;
  /** Sessions whose history was automatically compacted/truncated at least once. */
  sessionsCompacted: number;
  /**
   * Sessions whose observed context fill reached at least
   * `CONTEXT_NEAR_LIMIT_RATIO` of their selected window without compacting.
   * Compacted sessions are excluded so the two counters never double-count.
   */
  sessionsNearLimit: number;
  /**
   * Sessions for which an actual window fill *and* limit were known (Copilot CLI
   * `data.db` only). This is the denominator for `sessionsNearLimit`, which is
   * narrower than `sessionsConsidered`.
   */
  sessionsWithFillData: number;
  /** Highest observed fill as a percentage of the session's window limit (0-100). */
  worstFillPercent?: number;
}

/** Parent/child session reference used in hierarchy info (Copilot CLI sessions). */
export interface SessionRelationRef {
  uuid: string;
  name: string;
  /** Resolved path to the related session file (undefined when outside the loaded set). */
  sessionFile?: string;
}

// Detailed session file information for diagnostics view
export interface SessionFileDetails {
  file: string;
  size: number;
  modified: string;
  interactions: number;
  tokens?: number; // estimated token count for the session
  contextReferences: ContextReferenceUsage;
  firstInteraction: string | null;
  lastInteraction: string | null;
  editorSource: string; // 'vscode', 'vscode-insiders', 'cursor', etc.
  editorRoot?: string; // top-level editor root path (for display in diagnostics)
  editorName?: string; // friendly editor name (e.g., 'VS Code')
  title?: string; // session title (customTitle from session file)
  repository?: string; // Git remote origin URL for the session's workspace
  workspacePath?: string; // absolute local cwd/workspace path the session ran in (from adapter getMeta)
  /** Parent session info (Copilot CLI and pi sessions; populated from data.db / JSONL parentSession field). */
  parentInfo?: SessionRelationRef | null;
  /** Direct child sessions (Copilot CLI and pi sessions; populated from data.db / JSONL parentSession field). */
  childInfo?: SessionRelationRef[];
  /**
   * Total child count — may exceed childInfo.length when some
   * children fall outside the loaded 14-day diagnostic window.
   */
  totalChildCount?: number;
  /** Number of sub-agent/delegation tool calls detected in this session (from cache; see `SessionFileCache.subAgentCalls`). Absent when zero/unknown. */
  subAgentCalls?: number;
  // Per-model input/output/cached token breakdown.
  // Populated for all sessions where cached ModelUsage is available; always
  // present for Windsurf (derived from trajectory steps via the gRPC API).
  modelUsage?: ModelUsage;
  cachedTokens?: number;   // session-level cache-read tokens
  toolCalls?: { total: number; byTool: { [tool: string]: number } }; // tool invocation breakdown
}

// Prompt token detail from actual LLM usage data
export interface PromptTokenDetail {
  category: string;
  label: string;
  percentageOfPrompt: number;
}

// Actual usage data from the LLM API (when available in JSONL)
export interface ActualUsage {
  completionTokens: number;
  promptTokens: number;
  promptTokenDetails?: PromptTokenDetail[];
  details?: string; // e.g. "Claude Opus 4.5 • 3x"
}

// Chat turn information for log viewer
export interface ChatTurn {
  turnNumber: number;
  timestamp: string | null;
  mode: "ask" | "edit" | "agent" | "plan" | "customAgent" | "cli";
  userMessage: string;
  assistantResponse: string;
  model: string | null;
  /** Explicit per-request Copilot Auto selection; never inferred from a session's final picker. */
  autoRouted?: boolean;
  toolCalls: { toolName: string; arguments?: string; result?: string; isSubAgent?: boolean; subAgentModel?: string; subAgentTokens?: { input: number; output: number }; subAgentCost?: number }[];
  contextReferences: ContextReferenceUsage;
  mcpTools: { server: string; tool: string }[];
  inputTokensEstimate: number;
  outputTokensEstimate: number;
  thinkingTokensEstimate: number;
  actualUsage?: ActualUsage;
  /** Thinking effort level active when this turn was submitted (e.g. "low", "medium", "high"). */
  thinkingEffort?: string;
  /**
   * Estimated USD cost of this turn's own model call (excludes sub-agent/child costs),
   * computed host-side via `calculateEstimatedCost()` from the turn's model + token
   * usage (actual when available, otherwise the text-based estimate). Absent when the
   * model is unknown or has no pricing entry.
   */
  estimatedCost?: number;
}

// Full session log data for the log viewer
export interface SessionLogData {
  file: string;
  title: string | null;
  editorSource: string;
  editorName: string;
  size: number;
  modified: string;
  interactions: number;
  contextReferences: ContextReferenceUsage;
  firstInteraction: string | null;
  lastInteraction: string | null;
  turns: ChatTurn[];
  usageAnalysis?: SessionUsageAnalysis;
  /** Session-level actual token count from LLM API (e.g. session.shutdown in CLI format). 0 when unavailable. */
  actualTokens?: number;
  /** Cache-read token count from session.shutdown modelMetrics (CLI sessions only). Absent when unavailable. */
  cachedTokens?: number;
  /** Number of distinct subagent sessions started (CLI format: from subagent.started events; pi: from child session count). */
  subAgentsStarted?: number;
  /** Parent session info (Copilot CLI and pi sessions; populated from data.db / JSONL parentSession field). */
  parentInfo?: SessionRelationRef | null;
  /** Direct child sessions (Copilot CLI and pi sessions; populated from data.db / JSONL parentSession field). */
  childInfo?: SessionRelationRef[];
  /** Total child count (may exceed childInfo.length when some children fall outside the loaded window). */
  totalChildCount?: number;
  /** Input token total from debug log (sum of all llm_request events). Present for VS Code Copilot Chat agent-mode sessions. */
  debugLogInputTokens?: number;
  /** Output token total from debug log (sum of all llm_request events). Present for VS Code Copilot Chat agent-mode sessions. */
  debugLogOutputTokens?: number;
  /** Number of LLM API calls made during the session (from debug log). >1 means agent-mode multi-call session. */
  modelTurns?: number;
  /** Number of session.truncation events where messages were removed (breaking prompt cache). 0 or absent means no truncation. */
  truncationCount?: number;
  /** Total messages removed across all truncation events. Absent when truncationCount is 0. */
  messagesRemovedByTruncation?: number;
  /**
   * Optional editor-specific note injected by the adapter/backend.
   * When present the log viewer renders an info panel at the top of the page
   * listing the items as bullet points alongside the editor name and icon.
   */
  editorNote?: { items: string[] };
  /**
   * Per-leg HydraFusion routing detail (Copilot CLI sessions that used the
   * `hydrafusion` model). Absent for every other session, including CLI sessions
   * that never routed through it. See `analyzeHydraFusionSession` in `hydrafusion.ts`.
   */
  hydraFusion?: HydraFusionSummary;
}

// ---------------------------------------------------------------------------
// GitHub Copilot Cloud Agent session stats
// ---------------------------------------------------------------------------

export type AgentSessionSource = 'cloud-agent' | 'cli-remote' | 'unknown';

/** Where a repository row came from: workspace git remotes, the account-wide task list, or both. */
export type AgentRepoDiscovery = 'workspace' | 'account' | 'both';

export interface AgentRepoSummary {
  owner: string;
  repo: string;
  /** Number of tasks that contained at least one cloud-agent session. */
  totalTasks: number;
  /** Total cloud-agent sessions across all scanned tasks. */
  totalSessions: number;
  /** Sum of session usage in whole AI credits for all cloud-agent sessions (0 when unavailable). */
  totalCredits: number;
  /** Sum of premium requests for sessions billed before the June 2026 switch to AI credits. */
  totalPremiumRequests: number;
  /** How many tasks we fetched full session details for. */
  tasksScanned: number;
  /** Total tasks found in the list API response (before the detail-fetch cap). */
  tasksTotal: number;
  /** True when the detail-fetch cap was reached — totals are conservative lower bounds. */
  partial: boolean;
  /** How this repo was found. `account`-only rows are not open in any workspace folder. */
  discovery: AgentRepoDiscovery;
  /** True for the synthetic bucket of account tasks the API reported without a repository. */
  unassigned?: boolean;
  error?: string;
}

export interface AgentSessionsResult {
  repos: AgentRepoSummary[];
  totalTasks: number;
  totalSessions: number;
  totalCredits: number;
  totalPremiumRequests: number;
  authenticated: boolean;
  since: string;
  /** When the snapshot was fetched from GitHub; empty string when it has never been fetched. */
  fetchedAt: string;
  /** True when the account-wide `/agents/tasks` listing succeeded (false → workspace repos only). */
  accountTasksAvailable: boolean;
  /** Why the account-wide listing was skipped or failed, when it was. */
  accountTasksError?: string;
  /** True when the task-detail budget was exhausted — totals are lower bounds. */
  partial: boolean;
  /** How often the snapshot is refreshed, so the UI can say when the next refresh is due. */
  refreshIntervalMs?: number;
}

// Local summary type for customization files (mirrors webview/shared/contextRefUtils.ts)
export interface WorkspaceCustomizationSummary {
  workspaces: {
    [workspacePath: string]: {
      name: string;
      files: CustomizationFileEntry[];
    };
  };
  totalFiles: number;
  staleFiles: number;
}

// ---------------------------------------------------------------------------
// Insights / Nudges framework
// ---------------------------------------------------------------------------

export type InsightCategory = 'context' | 'agentic' | 'customization' | 'consistency' | 'tools' | 'trend';
export type InsightSeverity = 'tip' | 'opportunity' | 'celebration';
export type InsightStatus = 'new' | 'seen' | 'dismissed' | 'snoozed' | 'done';

export interface InsightState {
  status: InsightStatus;
  firstSurfacedAt: string;   // ISO timestamp
  lastSurfacedAt: string;    // ISO timestamp
  snoozeUntil?: string;      // ISO timestamp; present when status === 'snoozed'
}

/** Persisted bag of per-insight state keyed by insight id. */
export type InsightStateBag = Record<string, InsightState>;

/** A fully evaluated, display-ready insight card. */
export interface EvaluatedInsight {
  id: string;
  category: InsightCategory;
  severity: InsightSeverity;
  title: string;
  body: string;
  actionLabel?: string;
  actionCommand?: string;
  status: InsightStatus;
  allowToast?: boolean;
}

// ---------------------------------------------------------------------------
// Tool Curation
// ---------------------------------------------------------------------------

/** A single tool entry from an enumerated "available tools" source. */
export interface AvailableToolEntry {
  /** Raw tool ID (e.g. `mcp__github__get_file_contents`). */
  name: string;
  /** Human-readable description. */
  description: string;
  /** Where this tool comes from. */
  source: 'builtin' | 'mcp' | 'extension' | 'skill';
  /** MCP server name when `source === 'mcp'`. */
  server?: string;
  /** VS Code extension ID when `source === 'extension'`. */
  extensionId?: string;
  /** Skill file path (relative) when `source === 'skill'`. */
  skillPath?: string;
  /** Agent-plugin name (from `installed.json`) when this skill comes from a VS Code agent plugin. */
  pluginName?: string;
  /** Absolute path(s) of the config or skill file(s) this entry was discovered from. */
  configFiles?: string[];
  /**
   * For extension-contributed MCP server entries: true when at least one tool from
   * the server is enabled in `vscode.lm.tools`, false when the user has disabled them
   * in the chat tool picker (or the server hasn't started). Undefined when not applicable.
   */
  enabled?: boolean;
  /** For extension-contributed entries: whether the contributing extension is currently activated. */
  extensionActive?: boolean;
}

/** One actionable recommendation produced by curation analysis. */
export interface ToolCurationRecommendation {
  type: 'disable-mcp-server' | 'disable-extension' | 'refine-skill' | 'remove-skill';
  /** Server name, extension ID, or skill name that the recommendation targets. */
  target: string;
  reason: string;
  /** Estimated context-window token savings per interaction (rough). */
  estimatedTokenSavings?: number;
}

/** Full result of a tool-curation analysis run. */
export interface ToolCurationAnalysis {
  /** Look-back window (days) used to determine "unused". */
  windowDays: number;
  /** All tools discovered from available sources. */
  availableTools: AvailableToolEntry[];
  /** Tools that were actually invoked within the window (name → call count). */
  usedTools: { name: string; count: number }[];
  /** Available tools with zero invocations in the window. */
  unusedTools: AvailableToolEntry[];
  /** MCP servers with partial or zero tool usage. */
  underusedMcpServers: { server: string; availableToolCount: number; usedToolCount: number; configFiles?: string[]; extensionId?: string; enabled?: boolean; extensionActive?: boolean }[];
  /** Agent plugins with skill usage counts for the window; sorted by usedSkillCount ascending. Includes all plugins (not just unused ones) so the UI can offer a "hide plugins with usage" toggle. */
  underusedAgentPlugins: { pluginName: string; availableSkillCount: number; usedSkillCount: number }[];
  /** Rough prompt-bloat estimate from unused tool descriptions. */
  estimatedPromptBloat: { totalTokens: number; byServer: Record<string, number> };
  /** Prioritised list of recommendations. */
  recommendations: ToolCurationRecommendation[];
}

// ---------------------------------------------------------------------------
// Copilot Memory Files
// ---------------------------------------------------------------------------

/** A single Copilot agent memory Markdown file discovered on disk. */
export interface MemoryFileEntry {
  /** Absolute path to the memory `.md` file. */
  path: string;
  /** Scope this file belongs to — see docs/features/COPILOT-MEMORY-FILES-INSIGHT.md. */
  scope: 'user' | 'repo' | 'session';
  /** The `workspaceStorage/<hash>` this file was discovered under. Undefined for `scope === 'user'`. */
  workspaceHash?: string;
  /** Resolved friendly workspace folder path, when recorded in `workspace.json`/`meta.json`. */
  workspaceName?: string;
  /** Decoded chat-session UUID when `scope === 'session'` (the folder name is `base64(sessionId)`). */
  sessionId?: string;
  /** File size in bytes. */
  sizeBytes: number;
  /** Last-modified time, in milliseconds since epoch. */
  mtimeMs: number;
  /** File name without extension, used as a display title (content is never read beyond this). */
  title: string;
}

/** Per-workspace rollup of discovered memory files, used by `MemoryFilesAnalysis.byWorkspace`. */
export interface MemoryFilesWorkspaceSummary {
  workspaceHash?: string;
  workspaceName?: string;
  repoCount: number;
  sessionCount: number;
  /** User (global)-scope files folded into this bucket — only ever non-zero for the `__user__` row. */
  userCount: number;
  totalBytes: number;
  newestMtimeMs: number | null;
  oldestMtimeMs: number | null;
  largestFile?: MemoryFileEntry;
  /** Files older than the analysis's `staleDays` threshold. */
  staleFiles: MemoryFileEntry[];
}

/** Full result of a Copilot memory-files hygiene analysis run. */
export interface MemoryFilesAnalysis {
  /** Look-back threshold (days) used to flag a file as stale. */
  staleDays: number;
  /** Size threshold (bytes) used to flag a file as unusually large. */
  largeFileBytes: number;
  /** Every discovered memory file (metadata only — content is never included). */
  files: MemoryFileEntry[];
  /** Rollup grouped by workspace (and one entry for the `user` global scope). */
  byWorkspace: MemoryFilesWorkspaceSummary[];
  totalFiles: number;
  totalBytes: number;
  staleFileCount: number;
  largeFileCount: number;
}

/**
 * Compact per-workspace rollup for {@link MemoryFilesAnalysisView} — the counts/rollup scalars
 * the Usage Analysis webview table renders, without the per-file `staleFiles`/`largestFile`
 * entries (absolute paths, session IDs) `MemoryFilesWorkspaceSummary` carries for the CLI/host.
 */
export interface MemoryFilesWorkspaceViewSummary {
  workspaceHash?: string;
  workspaceName?: string;
  repoCount: number;
  sessionCount: number;
  /** User (global)-scope files folded into this bucket — only ever non-zero for the `__user__` row. */
  userCount: number;
  totalBytes: number;
  newestMtimeMs: number | null;
  /** `MemoryFilesWorkspaceSummary.staleFiles.length` — the webview table only ever shows the count. */
  staleFileCount: number;
}

/**
 * Compact projection of {@link MemoryFilesAnalysis} sent to the Usage Analysis webview: counts
 * and rollup scalars only. Omits the full `files` list and each workspace's `staleFiles`/
 * `largestFile`/`oldestMtimeMs` — metadata (absolute paths, session IDs, per-file objects) the
 * webview UI never reads, but which inflates the IPC/HTML payload for a large memory store.
 * Produced by `toMemoryFilesAnalysisView()` in the VS Code extension host.
 */
export interface MemoryFilesAnalysisView {
  staleDays: number;
  largeFileBytes: number;
  byWorkspace: MemoryFilesWorkspaceViewSummary[];
  totalFiles: number;
  totalBytes: number;
  staleFileCount: number;
  largeFileCount: number;
}

/**
 * One memory from a repository's **server-side** Copilot memory store, as returned by
 * `GET /agents/swe/internal/memory/v0/{owner}/{repo}/recent`. See
 * `src/copilotServerMemories.ts` for the route contract.
 *
 * Distinct from {@link MemoryFileEntry}, which describes a *local* memory file's metadata
 * on this machine. This is the remote, per-repository store shared by everyone working on
 * the repository, and it carries content rather than metadata.
 *
 * Only `id`, `subject`, `fact` and `citations` are required — the rest of the payload comes
 * from an undocumented preview API and has already been observed to differ from what the
 * Copilot CLI writes (the CLI sends a `source.integrationId` that reads back absent), so
 * everything else is optional and additional fields are tolerated.
 */
export interface ServerMemory {
  id: string;
  /** Free-text 1-2 word topic, e.g. `graphify setup`. Not drawn from a fixed vocabulary. */
  subject: string;
  /** The learned fact itself; the agent is instructed to keep it under 200 characters. */
  fact: string;
  /** Where the fact came from: `path/file.ts:12-30` entries, or a `User input: ...` string. */
  citations: string[];
  /** Why the agent thought this was worth remembering. */
  reason?: string;
  /** Observed as `"repository"`; the API generation suggests other scopes may follow. */
  scope?: string;
  source?: {
    /** Tool-call id of the interaction that stored the memory. */
    interactionId?: string;
    /** Which agent stored it, e.g. `copilot-code-review`. */
    agent?: string;
    /** Model that stored it, e.g. `gpt-5.6-luna`. */
    baseModel?: string;
  };
  billingOrganizationId?: number;
  billingEnterpriseId?: number;
}

/**
 * A group of server memories on one subject that no member cites an instruction file for —
 * i.e. a fact the agent learned from code alone, and therefore a candidate for promotion
 * into `AGENTS.md` / `.github/copilot-instructions.md`.
 */
export interface ServerMemoryPromotionGroup {
  /** Normalized (lowercased, punctuation-collapsed) subject used for grouping. */
  subject: string;
  /** The first member's original subject text, for display. */
  displaySubject: string;
  /**
   * How many memories restate this subject. Greater than one means the agent re-learned
   * the same thing across separate runs, which is the strongest signal it belongs in a
   * checked-in instruction file.
   */
  repeatCount: number;
  /** The longest fact in the group — the fullest wording, used as the suggested text. */
  representativeFact: string;
  /** Every distinct citation across the group, sorted. */
  citations: string[];
  memoryIds: string[];
}

/** A server memory citing one or more files that no longer exist in the working tree. */
export interface ServerMemoryStaleCitation {
  id: string;
  subject: string;
  fact: string;
  missingPaths: string[];
  /** True when *every* checkable citation is missing — nothing in the tree backs this memory. */
  fullyStale: boolean;
}

/**
 * Full analysis of one repository's server-side memory store, produced by
 * `analyzeServerMemories()`. Consumed by the CLI report and the VS Code extension host;
 * the webview gets the smaller {@link ServerMemoriesAnalysisView} instead.
 */
export interface ServerMemoriesAnalysis {
  /** `owner/name` the store was read for. */
  repo: string;
  /** `undefined` means the enablement check itself failed, not that memory is off. */
  enabled: boolean | undefined;
  /** Why the read produced nothing, when it produced nothing. */
  error?: string;
  /**
   * The read filled its requested limit, so these numbers describe a prefix of the store
   * rather than all of it. The routes carry no pagination cursor, so there is no way to
   * fetch the remainder — the honest move is to say the figures are partial.
   */
  truncated: boolean;
  totalMemories: number;
  distinctSubjects: number;
  /** Memories citing an instruction/doc file — already written down somewhere agents read. */
  documentedCount: number;
  /** Total memories sitting inside a promotion group. */
  promotionCandidateCount: number;
  /** Promotion groups with more than one member, i.e. facts re-learned at least twice. */
  repeatedGroupCount: number;
  /** Ranked by `repeatCount` descending; the API returns no timestamps to rank by instead. */
  promotionGroups: ServerMemoryPromotionGroup[];
  /**
   * Memories with no citation naming a verifiable file in the repository — typically
   * `User input: ...`, i.e. something a person told the agent rather than something it
   * derived from code. Excluded from {@link promotionGroups}: the promotion pitch is that
   * the agent keeps re-deriving a fact from code, which is not true of these, and an
   * unverifiable claim does not belong in a file every agent reads on every run.
   */
  unverifiableCount: number;
  staleCitations: ServerMemoryStaleCitation[];
  fullyStaleCount: number;
  /** Memory counts keyed by storing agent. */
  byAgent: Record<string, number>;
  /** Memory counts keyed by storing model. */
  byModel: Record<string, number>;
}

/** One promotion group as the webview renders it — see {@link ServerMemoriesAnalysisView}. */
export interface ServerMemoryPromotionGroupView {
  displaySubject: string;
  repeatCount: number;
  representativeFact: string;
  citationCount: number;
}

/**
 * Compact projection of {@link ServerMemoriesAnalysis} sent to the Usage Analysis webview.
 *
 * Unlike {@link MemoryFilesAnalysisView} this keeps fact text, because for server memories the
 * fact is the finding — a promotion suggestion the user cannot read is not a suggestion. What
 * it drops is bulk: only the top few promotion groups travel, and the per-memory stale-citation
 * list stays on the host side.
 */
export interface ServerMemoriesAnalysisView {
  repo: string;
  enabled: boolean | undefined;
  error?: string;
  /** See {@link ServerMemoriesAnalysis.truncated}; the counts below are a prefix when true. */
  truncated: boolean;
  totalMemories: number;
  distinctSubjects: number;
  documentedCount: number;
  promotionCandidateCount: number;
  repeatedGroupCount: number;
  fullyStaleCount: number;
  topPromotionGroups: ServerMemoryPromotionGroupView[];
}
