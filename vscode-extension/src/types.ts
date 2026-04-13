/**
 * Shared type definitions for the Copilot Token Tracker extension.
 * Extracted from extension.ts to reduce file size and improve reusability.
 */

export interface TokenUsageStats {
  todayTokens: number;
  monthTokens: number;
  lastUpdated: Date;
}

export interface ModelUsage {
  [modelName: string]: {
    inputTokens: number;    // total input tokens (uncached + cached reads + cache creation)
    outputTokens: number;
    cachedReadTokens?: number;     // portion of inputTokens that were cache reads (billed at reduced rate)
    cacheCreationTokens?: number;  // portion of inputTokens used to create cache entries (billed at higher rate)
  };
}

export interface ModelPricing {
  inputCostPerMillion: number;
  outputCostPerMillion: number;
  cachedInputCostPerMillion?: number;    // cost per million cache-read tokens (e.g. 0.30 for Claude Sonnet 4)
  cacheCreationCostPerMillion?: number;  // cost per million cache-creation tokens (e.g. 3.75 for Claude Sonnet 4)
  category?: string;
  tier?: "standard" | "premium" | "unknown";
  multiplier?: number;
  displayNames?: string[];
}

export interface EditorUsage {
  [editorType: string]: {
    tokens: number;
    sessions: number;
  };
}

export interface RepositoryUsage {
  [repository: string]: {
    tokens: number;
    sessions: number;
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
}

/** Aggregated data for one time window (day/week/month) in the chart. */
export interface ChartPeriodData {
  labels: string[];
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
}

export interface SessionFileCache {
  tokens: number;
  interactions: number;
  modelUsage: ModelUsage;
  mtime: number; // file modification time as timestamp
  size?: number; // file size in bytes (optional for backward compatibility)
  usageAnalysis?: SessionUsageAnalysis; // New analysis data
  firstInteraction?: string | null; // ISO timestamp of first interaction
  lastInteraction?: string | null; // ISO timestamp of last interaction
  title?: string; // Session title (customTitle from session file)
  repository?: string; // Git remote origin URL for the session's workspace
  workspaceFolderPath?: string; // Full local path to the workspace folder (optional)
  thinkingTokens?: number; // Estimated thinking/reasoning tokens
  actualTokens?: number; // Actual token count from LLM API usage data (when available)
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
  contextReferences: ContextReferenceUsage;
  mcpTools: McpToolUsage;
  modelSwitching: {
    uniqueModels: string[];
    modelCount: number;
    switchCount: number;
    tiers: { standard: string[]; premium: string[]; unknown: string[] };
    hasMixedTiers: boolean;
    standardRequests: number;
    premiumRequests: number;
    unknownRequests: number;
    totalRequests: number;
  };
  thinkingEffort?: ThinkingEffortUsage;
  editScope?: EditScopeUsage;
  applyUsage?: ApplyButtonUsage;
  sessionDuration?: SessionDurationData;
  conversationPatterns?: ConversationPatterns;
  agentTypes?: AgentTypeUsage;
}

export interface ToolCallUsage {
  total: number;
  byTool: { [toolName: string]: number };
}

export interface ModeUsage {
  ask: number; // Regular chat mode
  edit: number; // Edit mode interactions
  agent: number; // Agent mode interactions (standard agent mode)
  plan: number; // Plan mode interactions (built-in plan agent)
  customAgent: number; // Custom agent mode interactions (.agent.md files)
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
}

export interface EditScopeUsage {
  singleFileEdits: number; // Edit sessions touching 1 file
  multiFileEdits: number; // Edit sessions touching 2+ files
  totalEditedFiles: number; // Total unique files edited
  avgFilesPerSession: number; // Average files per edit session
}

export interface ApplyButtonUsage {
  totalApplies: number; // Total Apply button uses
  totalCodeBlocks: number; // Total code blocks shown
  applyRate: number; // % of code blocks applied
}

export interface SessionDurationData {
  totalDurationMs: number; // Total session time
  avgDurationMs: number; // Average session duration
  avgFirstProgressMs: number; // Average time to first response
  avgTotalElapsedMs: number; // Average total request time
  avgWaitTimeMs: number; // Average user wait time between interactions
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
  standardModels: string[]; // Unique standard models used
  premiumModels: string[]; // Unique premium models used
  unknownModels: string[]; // Unique models with unknown tier
  mixedTierSessions: number; // Sessions using both standard and premium
  standardRequests: number; // Count of requests using standard models
  premiumRequests: number; // Count of requests using premium models
  unknownRequests: number; // Count of requests using unknown tier models
  totalRequests: number; // Total requests across all tiers
}

export interface MissedPotentialWorkspace {
workspacePath: string;
workspaceName: string;
sessionCount: number;
interactionCount: number;
nonCopilotFiles: CustomizationFileEntry[];
}


export interface UsageAnalysisStats {
today: UsageAnalysisPeriod;
last30Days: UsageAnalysisPeriod;
month: UsageAnalysisPeriod;
locale?: string;
lastUpdated: Date;
customizationMatrix?: WorkspaceCustomizationMatrix;
missedPotential?: MissedPotentialWorkspace[];
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

export interface UsageAnalysisPeriod {
  sessions: number;
  toolCalls: ToolCallUsage;
  modeUsage: ModeUsage;
  contextReferences: ContextReferenceUsage;
  mcpTools: McpToolUsage;
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
  mode: "ask" | "edit" | "agent" | "plan" | "customAgent";
  userMessage: string;
  assistantResponse: string;
  model: string | null;
  toolCalls: { toolName: string; arguments?: string; result?: string; isSubAgent?: boolean; subAgentModel?: string }[];
  contextReferences: ContextReferenceUsage;
  mcpTools: { server: string; tool: string }[];
  inputTokensEstimate: number;
  outputTokensEstimate: number;
  thinkingTokensEstimate: number;
  actualUsage?: ActualUsage;
  /** Thinking effort level active when this turn was submitted (e.g. "low", "medium", "high"). */
  thinkingEffort?: string;
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
