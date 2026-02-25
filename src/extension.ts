import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import initSqlJs from 'sql.js';
import tokenEstimatorsData from './tokenEstimators.json';
import modelPricingData from './modelPricing.json';
import toolNamesData from './toolNames.json';
import customizationPatternsData from './customizationPatterns.json';
import { BackendFacade } from './backend/facade';
import { BackendCommandHandler } from './backend/commands';
import * as packageJson from '../package.json';
import { getModelDisplayName } from './webview/shared/modelUtils';

interface TokenUsageStats {
	todayTokens: number;
	monthTokens: number;
	lastUpdated: Date;
}

interface ModelUsage {
	[modelName: string]: {
		inputTokens: number;
		outputTokens: number;
	};
}

interface ModelPricing {
	inputCostPerMillion: number;
	outputCostPerMillion: number;
	category?: string;
	tier?: 'standard' | 'premium' | 'unknown';
	multiplier?: number;
	displayNames?: string[];
}

interface EditorUsage {
	[editorType: string]: {
		tokens: number;
		sessions: number;
	};
}

interface RepositoryUsage {
	[repository: string]: {
		tokens: number;
		sessions: number;
	};
}

interface PeriodStats {
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

interface DetailedStats {
	today: PeriodStats;
	month: PeriodStats;
	lastMonth: PeriodStats;
	last30Days: PeriodStats;
	lastUpdated: Date;
}

interface DailyTokenStats {
	date: string; // YYYY-MM-DD format
	tokens: number;
	sessions: number;
	interactions: number;
	modelUsage: ModelUsage;
	editorUsage: EditorUsage;
	repositoryUsage: RepositoryUsage;
}

interface SessionFileCache {
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
interface CustomizationFileEntry {
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
interface SessionUsageAnalysis {
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
	editScope?: EditScopeUsage;
	applyUsage?: ApplyButtonUsage;
	sessionDuration?: SessionDurationData;
	conversationPatterns?: ConversationPatterns;
	agentTypes?: AgentTypeUsage;
}

interface ToolCallUsage {
	total: number;
	byTool: { [toolName: string]: number };
}

interface ModeUsage {
	ask: number;         // Regular chat mode
	edit: number;        // Edit mode interactions
	agent: number;       // Agent mode interactions (standard agent mode)
	plan: number;        // Plan mode interactions (built-in plan agent)
	customAgent: number; // Custom agent mode interactions (.agent.md files)
}

interface ContextReferenceUsage {
	file: number;              // #file references
	selection: number;         // #selection references
	implicitSelection: number; // Implicit selections via inputState.selections
	symbol: number;            // #symbol references
	codebase: number;          // #codebase references
	workspace: number;         // @workspace references
	terminal: number;          // @terminal references
	vscode: number;            // @vscode references
	terminalLastCommand: number;  // #terminalLastCommand references
	terminalSelection: number;    // #terminalSelection references
	clipboard: number;            // #clipboard references
	changes: number;              // #changes references
	outputPanel: number;          // #outputPanel references
	problemsPanel: number;        // #problemsPanel references
	// contentReferences tracking from session logs
	byKind: { [kind: string]: number };           // Count by reference kind
	copilotInstructions: number;                  // .github/copilot-instructions.md
	agentsMd: number;                             // agents.md in repo root
	byPath: { [path: string]: number };           // Count by unique file path
}

interface McpToolUsage {
	total: number;
	byServer: { [serverName: string]: number };
	byTool: { [toolName: string]: number };
}

interface EditScopeUsage {
	singleFileEdits: number;   // Edit sessions touching 1 file
	multiFileEdits: number;    // Edit sessions touching 2+ files
	totalEditedFiles: number;  // Total unique files edited
	avgFilesPerSession: number; // Average files per edit session
}

interface ApplyButtonUsage {
	totalApplies: number;      // Total Apply button uses
	totalCodeBlocks: number;   // Total code blocks shown
	applyRate: number;         // % of code blocks applied
}

interface SessionDurationData {
	totalDurationMs: number;       // Total session time
	avgDurationMs: number;         // Average session duration
	avgFirstProgressMs: number;    // Average time to first response
	avgTotalElapsedMs: number;     // Average total request time
	avgWaitTimeMs: number;         // Average user wait time between interactions
}

interface ConversationPatterns {
	multiTurnSessions: number;     // Sessions with >1 request
	singleTurnSessions: number;    // Sessions with 1 request
	avgTurnsPerSession: number;    // Average requests per session
	maxTurnsInSession: number;     // Longest conversation
}

interface AgentTypeUsage {
	editsAgent: number;            // github.copilot.editsAgent usage
	defaultAgent: number;          // github.copilot.default usage
	workspaceAgent: number;        // github.copilot.workspace usage
	other: number;                 // Other agents
}

interface ModelSwitchingAnalysis {
	modelsPerSession: number[];  // Array of unique model counts per session
	totalSessions: number;
	averageModelsPerSession: number;
	maxModelsPerSession: number;
	minModelsPerSession: number;
	switchingFrequency: number;  // % of sessions with >1 model
	standardModels: string[];    // Unique standard models used
	premiumModels: string[];     // Unique premium models used
	unknownModels: string[];     // Unique models with unknown tier
	mixedTierSessions: number;   // Sessions using both standard and premium
	standardRequests: number;    // Count of requests using standard models
	premiumRequests: number;     // Count of requests using premium models
	unknownRequests: number;     // Count of requests using unknown tier models
	totalRequests: number;       // Total requests across all tiers
}

interface MissedPotentialWorkspace {
	workspacePath: string;
	workspaceName: string;
	sessionCount: number;
	interactionCount: number;
	nonCopilotFiles: CustomizationFileEntry[];
}

interface UsageAnalysisStats {
	today: UsageAnalysisPeriod;
	last30Days: UsageAnalysisPeriod;
	month: UsageAnalysisPeriod;
	locale?: string;
	lastUpdated: Date;
	customizationMatrix?: WorkspaceCustomizationMatrix;
	missedPotential?: MissedPotentialWorkspace[];
}

/** Matrix types used for Usage Analysis customization matrix */
type CustomizationTypeStatus = '✅' | '⚠️' | '❌';

interface WorkspaceCustomizationRow {
	workspacePath: string;
	workspaceName: string;
	sessionCount: number;
	interactionCount: number;
	typeStatuses: { [typeId: string]: CustomizationTypeStatus };
}

interface WorkspaceCustomizationMatrix {
	customizationTypes: Array<{ id: string; icon: string; label: string }>;
	workspaces: WorkspaceCustomizationRow[];
	totalWorkspaces: number;
	workspacesWithIssues: number;
}

interface UsageAnalysisPeriod {
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
}

// Detailed session file information for diagnostics view
interface SessionFileDetails {
	file: string;
	size: number;
	modified: string;
	interactions: number;
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
interface PromptTokenDetail {
	category: string;
	label: string;
	percentageOfPrompt: number;
}

// Actual usage data from the LLM API (when available in JSONL)
interface ActualUsage {
	completionTokens: number;
	promptTokens: number;
	promptTokenDetails?: PromptTokenDetail[];
	details?: string; // e.g. "Claude Opus 4.5 • 3x"
}

// Chat turn information for log viewer
interface ChatTurn {
	turnNumber: number;
	timestamp: string | null;
	mode: 'ask' | 'edit' | 'agent' | 'plan' | 'customAgent';
	userMessage: string;
	assistantResponse: string;
	model: string | null;
	toolCalls: { toolName: string; arguments?: string; result?: string }[];
	contextReferences: ContextReferenceUsage;
	mcpTools: { server: string; tool: string }[];
	inputTokensEstimate: number;
	outputTokensEstimate: number;
	thinkingTokensEstimate: number;
	actualUsage?: ActualUsage;
}

// Full session log data for the log viewer
interface SessionLogData {
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
}

// Local summary type for customization files (mirrors webview/shared/contextRefUtils.ts)
interface WorkspaceCustomizationSummary {
	workspaces: {
		[workspacePath: string]: {
			name: string;
			files: CustomizationFileEntry[];
		};
	};
	totalFiles: number;
	staleFiles: number;
}

class CopilotTokenTracker implements vscode.Disposable {
	// Cache version - increment this when making changes that require cache invalidation
	private static readonly CACHE_VERSION = 23; // Cache key format changed: per-edition file lock instead of per-session keys
	// Maximum length for displaying workspace IDs in diagnostics/customization matrix
	private static readonly WORKSPACE_ID_DISPLAY_LENGTH = 8;

	private diagnosticsPanel?: vscode.WebviewPanel;
	// Tracks whether the diagnostics panel has already received its session files
	private diagnosticsHasLoadedFiles: boolean = false;
	// Cache of the last loaded detailed session files for diagnostics view
	private diagnosticsCachedFiles: SessionFileDetails[] = [];
	// Cache of the last diagnostic report text for copy/issue operations
	private lastDiagnosticReport: string = '';
	private logViewerPanel?: vscode.WebviewPanel;
	private statusBarItem: vscode.StatusBarItem;
	private readonly extensionUri: vscode.Uri;
	private readonly context: vscode.ExtensionContext;

	// Helper method to get total tokens from ModelUsage
	private getTotalTokensFromModelUsage(modelUsage: ModelUsage): number {
		return Object.values(modelUsage).reduce((sum, usage) => sum + usage.inputTokens + usage.outputTokens, 0);
	}

	/**
	 * Resolve the workspace folder full path from a session file path.
	 * Looks for a `workspaceStorage/<id>/` segment and reads `workspace.json` or `meta.json`.
	 * Synchronous by design to keep the analysis flow simple and cached.
	 */
	// Helper: read a workspaceStorage JSON file and extract a candidate folder path from configured keys
	private parseWorkspaceStorageJsonFile(jsonPath: string, candidateKeys: string[]): string | undefined {
		try {
			const raw = fs.readFileSync(jsonPath, 'utf8');
			const obj = JSON.parse(raw);
			for (const key of candidateKeys) {
				const candidate = obj[key];
				if (typeof candidate !== 'string') { continue; }
				const pathCandidate = candidate.replace(/^file:\/\//, '');
				// Prefer vscode.Uri.parse -> fsPath when possible
				try {
					const uri = vscode.Uri.parse(candidate);
					if (uri.fsPath && uri.fsPath.length > 0) {
						return uri.fsPath;
					}
				} catch { }
				try {
					return decodeURIComponent(pathCandidate);
				} catch {
					return pathCandidate;
				}
			}
		} catch {
			// ignore parse/read errors
		}
		return undefined;
	}

	/**
	 * Extract workspace ID from a session file path, if it's workspace-scoped.
	 * Returns the workspace ID or undefined if not a workspace-scoped session.
	 */
	private extractWorkspaceIdFromSessionPath(sessionFilePath: string): string | undefined {
		try {
			const normalized = sessionFilePath.replace(/\\/g, '/');
			const parts = normalized.split('/').filter(p => p.length > 0);
			const idx = parts.findIndex(p => p.toLowerCase() === 'workspacestorage');
			if (idx === -1 || idx + 1 >= parts.length) {
				return undefined; // Not a workspace-scoped session file
			}
			return parts[idx + 1];
		} catch {
			return undefined;
		}
	}

	private resolveWorkspaceFolderFromSessionPath(sessionFilePath: string): string | undefined {
		try {
			// Normalize and split path into segments
			const normalized = sessionFilePath.replace(/\\/g, '/');
			const parts = normalized.split('/').filter(p => p.length > 0);
			const idx = parts.findIndex(p => p.toLowerCase() === 'workspacestorage');
			if (idx === -1 || idx + 1 >= parts.length) {
				return undefined; // Not a workspace-scoped session file
			}

			const workspaceId = parts[idx + 1];
			// Return cached value if present
			if (this._workspaceIdToFolderCache.has(workspaceId)) {
				return this._workspaceIdToFolderCache.get(workspaceId);
			}

			// Construct the workspaceStorage folder path by slicing the original normalized path
			// This preserves absolute-root semantics on both Windows and Unix.
			const workspaceSegment = `workspaceStorage/${workspaceId}`;
			const lowerNormalized = normalized.toLowerCase();
			const segmentIndex = lowerNormalized.indexOf(workspaceSegment.toLowerCase());
			if (segmentIndex === -1) {
				// Should not happen if parts detection succeeded, but guard just in case
				this._workspaceIdToFolderCache.set(workspaceId, undefined);
				return undefined;
			}
			const folderPathNormalized = normalized.substring(0, segmentIndex + workspaceSegment.length);
			const workspaceStorageFolder = path.normalize(folderPathNormalized);

			const workspaceJsonPath = path.join(workspaceStorageFolder, 'workspace.json');
			const metaJsonPath = path.join(workspaceStorageFolder, 'meta.json');

			let folderFsPath: string | undefined;

			if (fs.existsSync(workspaceJsonPath)) {
				folderFsPath = this.parseWorkspaceStorageJsonFile(workspaceJsonPath, ['folder', 'workspace', 'configuration', 'uri', 'path']);
			} else if (fs.existsSync(metaJsonPath)) {
				folderFsPath = this.parseWorkspaceStorageJsonFile(metaJsonPath, ['folder', 'uri', 'workspace', 'path']);
			}

			// Normalize to undefined if folderFsPath is falsy
			if (!folderFsPath || folderFsPath.length === 0) {
				this._workspaceIdToFolderCache.set(workspaceId, undefined);
				return undefined;
			}

			this._workspaceIdToFolderCache.set(workspaceId, folderFsPath);
			return folderFsPath;
		} catch (err) {
			// On any error, cache undefined to avoid repeated failures
			try {
				const parts = sessionFilePath.replace(/\\/g, '/').split('/').filter(p => p.length > 0);
				const idx = parts.findIndex(p => p.toLowerCase() === 'workspacestorage');
				if (idx !== -1 && idx + 1 < parts.length) {
					this._workspaceIdToFolderCache.set(parts[idx + 1], undefined);
				}
			} catch { }
			return undefined;
		}
	}

	/**
	 * Convert a simple glob pattern to a RegExp.
	 * Supports: ** (match multiple path segments), * (match within a segment), ?.
	 */
	private globToRegExp(glob: string, caseInsensitive: boolean = false): RegExp {
		// Normalize to posix-style
		let pattern = glob.replace(/\\/g, '/');
		// Escape regex special chars
		pattern = pattern.replace(/([.+^=!:${}()|[\]\\])/g, '\\$1');
		// Replace /**/ or ** with placeholder
		pattern = pattern.replace(/(^|\/)\*\*\/(?!$)/g, '$1__GLOBSTAR__/');
		pattern = pattern.replace(/\*\*/g, '__GLOBSTAR__');
		// Replace single * with [^/]* and ? with .
		pattern = pattern.replace(/\*/g, '[^/]*').replace(/\?/g, '.');
		// Replace globstar placeholder with .* (allow path separators)
		pattern = pattern.replace(/__GLOBSTAR__\//g, '(?:.*?/?)').replace(/__GLOBSTAR__/g, '.*');
		// Anchor
		const flags = caseInsensitive ? 'i' : '';
		return new RegExp('^' + pattern + '$', flags);
	}

	/**
	 * Scan a workspace folder for customization files according to `customizationPatterns.json`.
	 */
	private scanWorkspaceCustomizationFiles(workspaceFolderPath: string): CustomizationFileEntry[] {
		const results: CustomizationFileEntry[] = [];
		if (!workspaceFolderPath || !fs.existsSync(workspaceFolderPath)) { return results; }

		const cfg = customizationPatternsData as any;
		const stalenessDays = typeof cfg.stalenessThresholdDays === 'number' ? cfg.stalenessThresholdDays : 90;
		const excludeDirs: string[] = Array.isArray(cfg.excludeDirs) ? cfg.excludeDirs : [];

		for (const pattern of (cfg.patterns || [])) {
			try {
				const scanMode = pattern.scanMode || 'exact';
				const relativePattern = pattern.path as string;
				if (scanMode === 'exact') {
					const absPath = path.join(workspaceFolderPath, relativePattern);
					if (fs.existsSync(absPath)) {
						const stat = fs.statSync(absPath);
						results.push({
							path: absPath,
							relativePath: path.relative(workspaceFolderPath, absPath).replace(/\\/g, '/'),
							type: pattern.type || 'unknown',
							icon: pattern.icon || '',
							label: pattern.label || path.basename(absPath),
							name: path.basename(absPath),
							lastModified: stat.mtime.toISOString(),
							isStale: (Date.now() - stat.mtime.getTime()) > stalenessDays * 24 * 60 * 60 * 1000,
							category: pattern.category as 'copilot' | 'non-copilot' | undefined
						});
					}
				} else if (scanMode === 'oneLevel') {
					// Split at the first '*' wildcard to find base directory and remaining path
					// e.g., ".github/skills/*/SKILL.md" -> base: ".github/skills/", remaining: "/SKILL.md"
					const normalizedPattern = relativePattern.replace(/\\/g, '/');
					const starIndex = normalizedPattern.indexOf('*');
					if (starIndex === -1) { continue; } // No wildcard, skip

					// Split the pattern at the '*'
					const beforeStar = normalizedPattern.substring(0, starIndex);
					const afterStar = normalizedPattern.substring(starIndex + 1);

					// The base directory is everything before the '*' (trim trailing slash)
					const baseDirPath = beforeStar.replace(/\/$/, '');
					const baseDir = baseDirPath ? path.join(workspaceFolderPath, baseDirPath) : workspaceFolderPath;

					if (!fs.existsSync(baseDir)) { continue; }
					const baseStat = fs.statSync(baseDir);
					if (!baseStat.isDirectory()) { continue; }

					// Enumerate directories in the base directory
					const entries = fs.readdirSync(baseDir, { withFileTypes: true });
					const fullPattern = afterStar.startsWith('/') ? afterStar.substring(1) : afterStar;
					for (const entry of entries) {
						// Only consider directories at this level (unless afterStar is just a filename)
						if (excludeDirs.includes(entry.name)) { continue; }

						// Construct the full path with this entry replacing the '*'
						const candidatePath = path.join(baseDir, entry.name, fullPattern);

						// Check if this path exists
						if (fs.existsSync(candidatePath)) {
							const stat = fs.statSync(candidatePath);
							if (stat.isFile()) {
								// For skills, use the directory name (parent of SKILL.md) as the display name
								const displayName = pattern.type === 'skill' ? entry.name : path.basename(candidatePath);

								results.push({
									path: candidatePath,
									relativePath: path.relative(workspaceFolderPath, candidatePath).replace(/\\/g, '/'),
									type: pattern.type || 'unknown',
									icon: pattern.icon || '',
									label: pattern.label || displayName,
									name: displayName,
									lastModified: stat.mtime.toISOString(),
									category: pattern.category as 'copilot' | 'non-copilot' | undefined,
									isStale: (Date.now() - stat.mtime.getTime()) > stalenessDays * 24 * 60 * 60 * 1000
								});
							}
						}
					}
				} else if (scanMode === 'recursive') {
					const maxDepth = typeof pattern.maxDepth === 'number' ? pattern.maxDepth : 6;
					const caseInsensitive = !!pattern.caseInsensitive;
					const regex = this.globToRegExp(relativePattern, caseInsensitive);
					// Walk recursively
					const walk = (dir: string, depth: number) => {
						if (depth < 0) { return; }
						let children: fs.Dirent[] = [];
						try { children = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
						for (const child of children) {
							const name = child.name;
							if (child.isDirectory()) {
								if (excludeDirs.includes(name)) { continue; }
								walk(path.join(dir, name), depth - 1);
							} else if (child.isFile()) {
								const rel = path.relative(workspaceFolderPath, path.join(dir, name)).replace(/\\/g, '/');
								if (regex.test(rel)) {
									const abs = path.join(dir, name);
									const stat = fs.statSync(abs);
									results.push({
										path: abs,
										relativePath: rel,
										type: pattern.type || 'unknown',
										icon: pattern.icon || '',
										label: pattern.label || path.basename(abs),
										name: path.basename(abs),
										lastModified: stat.mtime.toISOString(),
										isStale: (Date.now() - stat.mtime.getTime()) > stalenessDays * 24 * 60 * 60 * 1000,
										category: pattern.category as 'copilot' | 'non-copilot' | undefined
									});
								}
							}
						}
					};
					walk(workspaceFolderPath, maxDepth);
				}
			} catch (e) {
				// ignore per-pattern errors
			}
		}

		// Deduplicate by absolute path
		const uniq: { [p: string]: CustomizationFileEntry } = {};
		for (const r of results) { uniq[path.normalize(r.path)] = r; }
		return Object.values(uniq);
	}
	private updateInterval: NodeJS.Timeout | undefined;
	private initialDelayTimeout: NodeJS.Timeout | undefined;
	private detailsPanel: vscode.WebviewPanel | undefined;
	private chartPanel: vscode.WebviewPanel | undefined;
	private analysisPanel: vscode.WebviewPanel | undefined;
	private maturityPanel: vscode.WebviewPanel | undefined;
	private dashboardPanel: vscode.WebviewPanel | undefined;
	private fluencyLevelViewerPanel: vscode.WebviewPanel | undefined;
	private outputChannel: vscode.OutputChannel;
	private sessionFileCache: Map<string, SessionFileCache> = new Map();
	private lastDetailedStats: DetailedStats | undefined;
	private lastUsageAnalysisStats: UsageAnalysisStats | undefined;
	private tokenEstimators: { [key: string]: number } = tokenEstimatorsData.estimators;
	private co2Per1kTokens = 0.2; // gCO2e per 1000 tokens, a rough estimate
	private co2AbsorptionPerTreePerYear = 21000; // grams of CO2 per tree per year
	private waterUsagePer1kTokens = 0.3; // liters of water per 1000 tokens, based on data center usage estimates
	private _cacheHits = 0; // Counter for cache hits during usage analysis
	private _cacheMisses = 0; // Counter for cache misses during usage analysis
	// Short-term cache to avoid rescanning filesystem during rapid successive calls (e.g., diagnostics load)
	private _sessionFilesCache: string[] | null = null;
	private _sessionFilesCacheTime: number = 0;
	private static readonly SESSION_FILES_CACHE_TTL = 60000; // Cache for 60 seconds

	// Cached sql.js SQL module (lazy initialized)
	private _sqlJsModule: any = null;

	// Cache mapping workspaceStorageId -> resolved workspace folder path (or undefined if not resolvable)
	private _workspaceIdToFolderCache: Map<string, string | undefined> = new Map();

	// Cache mapping workspaceFolderPath -> found customization files (avoid re-scanning)
	private _customizationFilesCache: Map<string, CustomizationFileEntry[]> = new Map();

	// Last computed customization matrix for usage analysis (typed)
	private _lastCustomizationMatrix?: WorkspaceCustomizationMatrix;
	private _lastMissedPotential?: MissedPotentialWorkspace[];

	// Model pricing data - loaded from modelPricing.json
	// Reference: OpenAI API Pricing (https://openai.com/api/pricing/) - Retrieved December 2025
	// Reference: Anthropic Claude Pricing (https://www.anthropic.com/pricing) - Standard rates
	// Note: GitHub Copilot uses these models but pricing may differ from direct API usage
	// These are reference prices for cost estimation purposes only
	private modelPricing: { [key: string]: ModelPricing } = modelPricingData.pricing as { [key: string]: ModelPricing };

	// Tool name mapping - loaded from toolNames.json for friendly display names
	private toolNameMap: { [key: string]: string } = toolNamesData as { [key: string]: string };

	// Backend facade instance for accessing table storage data
	private backend: BackendFacade | undefined;

	// Helper method to get repository URL from package.json
	private getRepositoryUrl(): string {
		const repoUrl = packageJson.repository?.url?.replace(/^git\+/, '').replace(/\.git$/, '');
		return repoUrl || 'https://github.com/rajbos/github-copilot-token-usage';
	}

	/**
	 * Determine the editor type from a session file path
	 * Returns: 'VS Code', 'VS Code Insiders', 'VSCodium', 'Cursor', 'Copilot CLI', or 'Unknown'
	 */
	/**
	 * Detect the actual mode type from inputState.mode object.
	 * Returns 'ask', 'edit', 'agent', 'plan', or 'customAgent'.
	 */
	private getModeType(mode: any): 'ask' | 'edit' | 'agent' | 'plan' | 'customAgent' {
		if (!mode || !mode.kind) {
			return 'ask';
		}

		// Check kind first - edit and ask are straightforward
		if (mode.kind === 'edit') { return 'edit'; }
		if (mode.kind === 'ask') { return 'ask'; }

		// For agent kind, check the mode.id to differentiate
		if (mode.kind === 'agent') {
			if (!mode.id || mode.id === 'agent') {
				// Standard agent mode (no special id or id='agent')
				return 'agent';
			}

			// Check for plan mode (vscode-userdata:/.../plan-agent/Plan.agent.md)
			if (typeof mode.id === 'string' && mode.id.includes('plan-agent/Plan.agent.md')) {
				return 'plan';
			}

			// Check for custom agent (file:// URI to .agent.md)
			if (typeof mode.id === 'string' && mode.id.includes('.agent.md')) {
				return 'customAgent';
			}

			// Fallback to standard agent for any other agent kind
			return 'agent';
		}

		// Default to ask for unknown modes
		return 'ask';
	}

	/**
	 * Extract custom agent name from a file:// URI pointing to a .agent.md file.
	 * Returns the filename without the .agent.md extension.
	 */
	private extractCustomAgentName(modeId: string): string | null {
		if (!modeId || !modeId.includes('.agent.md')) {
			return null;
		}

		try {
			// Handle both file:/// URIs and regular paths
			const cleanPath = modeId.replace('file:///', '').replace('file://', '');
			const decodedPath = decodeURIComponent(cleanPath);
			const parts = decodedPath.split(/[\\/]/);
			const filename = parts[parts.length - 1];

			// Remove .agent.md extension
			if (filename.endsWith('.agent.md')) {
				return filename.slice(0, -10); // Remove '.agent.md'
			}
			if (filename.endsWith('.md.agent.md')) {
				// Handle case like TestEngineerAgent.md.agent.md
				return filename.slice(0, -10).replace('.md', '');
			}
		} catch (e) {
			return null;
		}

		return null;
	}

	/**
	 * Get the OpenCode data directory path.
	 * OpenCode follows XDG Base Directory Specification:
	 * - Windows: %USERPROFILE%\.local\share\opencode\
	 * - Linux/macOS: ~/.local/share/opencode/
	 */
	private getOpenCodeDataDir(): string {
		const platform = os.platform();
		const homedir = os.homedir();
		if (platform === 'win32') {
			return path.join(homedir, '.local', 'share', 'opencode');
		}
		const xdgDataHome = process.env.XDG_DATA_HOME || path.join(homedir, '.local', 'share');
		return path.join(xdgDataHome, 'opencode');
	}

	/**
	 * Check if a session file is an OpenCode session file.
	 * OpenCode sessions are stored in ~/.local/share/opencode/storage/session/ (JSON)
	 * or referenced via virtual paths like opencode.db#ses_<id> (SQLite).
	 */
	private isOpenCodeSessionFile(filePath: string): boolean {
		const normalized = filePath.toLowerCase().replace(/\\/g, '/');
		return normalized.includes('/opencode/storage/session/') || normalized.includes('/opencode/opencode.db#ses_');
	}

	/**
	 * Check if a session is stored in the OpenCode SQLite database.
	 * Virtual path format: <opencode_dir>/opencode.db#ses_<id>
	 */
	private isOpenCodeDbSession(filePath: string): boolean {
		return filePath.includes('opencode.db#ses_');
	}

	/**
	 * Lazily initialize and return the sql.js SQL module.
	 */
	private async initSqlJs(): Promise<any> {
		if (this._sqlJsModule) { return this._sqlJsModule; }
		const wasmPath = path.join(__dirname, 'sql-wasm.wasm');
		let wasmBinary: Uint8Array | undefined;
		if (fs.existsSync(wasmPath)) {
			wasmBinary = fs.readFileSync(wasmPath);
		}
		this._sqlJsModule = await initSqlJs(wasmBinary ? { wasmBinary } : undefined);
		return this._sqlJsModule;
	}

	/**
	 * Read session metadata from the OpenCode SQLite database.
	 */
	private async readOpenCodeDbSession(sessionId: string): Promise<any | null> {
		const dbPath = path.join(this.getOpenCodeDataDir(), 'opencode.db');
		if (!fs.existsSync(dbPath)) { return null; }
		try {
			const SQL = await this.initSqlJs();
			const buffer = fs.readFileSync(dbPath);
			const db = new SQL.Database(buffer);
			try {
				const result = db.exec('SELECT id, slug, title, time_created, time_updated, project_id, directory FROM session WHERE id = ?', [sessionId]);
				if (result.length === 0 || result[0].values.length === 0) { return null; }
				const row = result[0].values[0];
				const cols = result[0].columns;
				const obj: any = {};
				for (let i = 0; i < cols.length; i++) { obj[cols[i]] = row[i]; }
				return {
					id: obj.id,
					slug: obj.slug,
					title: obj.title,
					projectID: obj.project_id,
					directory: obj.directory,
					time: { created: obj.time_created, updated: obj.time_updated }
				};
			} finally {
				db.close();
			}
		} catch {
			return null;
		}
	}

	/**
	 * Read all OpenCode messages from the SQLite database for a given session.
	 */
	private async readOpenCodeDbMessages(sessionId: string): Promise<any[]> {
		const dbPath = path.join(this.getOpenCodeDataDir(), 'opencode.db');
		if (!fs.existsSync(dbPath)) { return []; }
		try {
			const SQL = await this.initSqlJs();
			const buffer = fs.readFileSync(dbPath);
			const db = new SQL.Database(buffer);
			try {
				const result = db.exec('SELECT id, data, time_created FROM message WHERE session_id = ? ORDER BY time_created ASC', [sessionId]);
				if (result.length === 0) { return []; }
				return result[0].values.map((row: unknown[]) => {
					const data = JSON.parse(row[1] as string);
					data.id = row[0];
					data.time = data.time || {};
					data.time.created = data.time.created || row[2];
					return data;
				});
			} finally {
				db.close();
			}
		} catch {
			return [];
		}
	}

	/**
	 * Read all OpenCode parts from the SQLite database for a given message.
	 */
	private async readOpenCodeDbParts(messageId: string): Promise<any[]> {
		const dbPath = path.join(this.getOpenCodeDataDir(), 'opencode.db');
		if (!fs.existsSync(dbPath)) { return []; }
		try {
			const SQL = await this.initSqlJs();
			const buffer = fs.readFileSync(dbPath);
			const db = new SQL.Database(buffer);
			try {
				const result = db.exec('SELECT id, data, time_created FROM part WHERE message_id = ? ORDER BY time_created ASC', [messageId]);
				if (result.length === 0) { return []; }
				return result[0].values.map((row: unknown[]) => {
					const data = JSON.parse(row[1] as string);
					data.id = row[0];
					data.time = data.time || {};
					data.time.created = data.time.created || row[2];
					return data;
				});
			} finally {
				db.close();
			}
		} catch {
			return [];
		}
	}

	/**
	 * Discover all session IDs from the OpenCode SQLite database.
	 */
	private async discoverOpenCodeDbSessions(): Promise<string[]> {
		const dbPath = path.join(this.getOpenCodeDataDir(), 'opencode.db');
		if (!fs.existsSync(dbPath)) { return []; }
		try {
			const SQL = await this.initSqlJs();
			const buffer = fs.readFileSync(dbPath);
			const db = new SQL.Database(buffer);
			try {
				const result = db.exec('SELECT id FROM session');
				if (result.length === 0) { return []; }
				return result[0].values.map((row: unknown[]) => row[0] as string);
			} finally {
				db.close();
			}
		} catch {
			return [];
		}
	}

	/**
	 * Get file stats for a session, handling OpenCode DB virtual paths.
	 * For DB sessions, returns the stat of the opencode.db file itself.
	 */
	private async statSessionFile(sessionFile: string): Promise<fs.Stats> {
		if (this.isOpenCodeDbSession(sessionFile)) {
			const dbPath = path.join(this.getOpenCodeDataDir(), 'opencode.db');
			return fs.promises.stat(dbPath);
		}
		return fs.promises.stat(sessionFile);
	}

	/**
	 * Read all OpenCode message files for a given session.
	 * Messages are stored in ~/.local/share/opencode/storage/message/ses_<id>/
	 * Returns an array of parsed message objects sorted by creation time.
	 */
	private readOpenCodeMessages(sessionId: string): any[] {
		const dataDir = this.getOpenCodeDataDir();
		const messageDir = path.join(dataDir, 'storage', 'message', sessionId);
		const messages: any[] = [];
		try {
			if (!fs.existsSync(messageDir)) { return messages; }
			const entries = fs.readdirSync(messageDir, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isFile() || !entry.name.endsWith('.json')) { continue; }
				try {
					const content = fs.readFileSync(path.join(messageDir, entry.name), 'utf8');
					const msg = JSON.parse(content);
					messages.push(msg);
				} catch {
					// Skip unreadable message files
				}
			}
		} catch {
			// Directory not accessible
		}
		// Sort by creation time
		messages.sort((a, b) => ((a.time?.created || 0) - (b.time?.created || 0)));
		return messages;
	}

	/**
	 * Read all OpenCode part files for a given message.
	 * Parts are stored in ~/.local/share/opencode/storage/part/msg_<id>/
	 * Returns an array of parsed part objects sorted by creation/start time.
	 */
	private readOpenCodeParts(messageId: string): any[] {
		const dataDir = this.getOpenCodeDataDir();
		const partDir = path.join(dataDir, 'storage', 'part', messageId);
		const parts: any[] = [];
		try {
			if (!fs.existsSync(partDir)) { return parts; }
			const entries = fs.readdirSync(partDir, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isFile() || !entry.name.endsWith('.json')) { continue; }
				try {
					const content = fs.readFileSync(path.join(partDir, entry.name), 'utf8');
					const part = JSON.parse(content);
					parts.push(part);
				} catch {
					// Skip unreadable part files
				}
			}
		} catch {
			// Directory not accessible
		}
		// Sort by start time if available, otherwise by ID
		parts.sort((a, b) => ((a.time?.start || 0) - (b.time?.start || 0)));
		return parts;
	}

	private getEditorTypeFromPath(filePath: string): string {
		const normalizedPath = filePath.toLowerCase().replace(/\\/g, '/');

		if (normalizedPath.includes('/.copilot/session-state/')) {
			return 'Copilot CLI';
		}
		if (this.isOpenCodeSessionFile(filePath)) {
			return 'OpenCode';
		}
		if (normalizedPath.includes('/code - insiders/') || normalizedPath.includes('/code%20-%20insiders/')) {
			return 'VS Code Insiders';
		}
		if (normalizedPath.includes('/code - exploration/') || normalizedPath.includes('/code%20-%20exploration/')) {
			return 'VS Code Exploration';
		}
		if (normalizedPath.includes('/vscodium/')) {
			return 'VSCodium';
		}
		if (normalizedPath.includes('/cursor/')) {
			return 'Cursor';
		}
		if (normalizedPath.includes('.vscode-server-insiders/')) {
			return 'VS Code Server (Insiders)';
		}
		if (normalizedPath.includes('.vscode-server/') || normalizedPath.includes('.vscode-remote/')) {
			return 'VS Code Server';
		}
		if (normalizedPath.includes('/code/')) {
			return 'VS Code';
		}

		return 'Unknown';
	}

	/**
	 * Determine a friendly editor name from an editor root path (folder name)
	 * e.g. 'C:\...\AppData\Roaming\Code' -> 'VS Code'
	 */
	private getEditorNameFromRoot(rootPath: string): string {
		if (!rootPath) { return 'Unknown'; }
		const lower = rootPath.toLowerCase();
		// Check obvious markers first
		if (lower.includes('.copilot') || lower.includes('copilot')) { return 'Copilot CLI'; }
		if (lower.includes('opencode')) { return 'OpenCode'; }
		if (lower.includes('code - insiders') || lower.includes('code-insiders') || lower.includes('insiders')) { return 'VS Code Insiders'; }
		if (lower.includes('code - exploration') || lower.includes('code%20-%20exploration')) { return 'VS Code Exploration'; }
		if (lower.includes('vscodium')) { return 'VSCodium'; }
		if (lower.includes('cursor')) { return 'Cursor'; }
		// Generic 'code' match (catch AppData\Roaming\Code)
		if (lower.endsWith('code') || lower.includes(path.sep + 'code' + path.sep) || lower.includes('/code/')) { return 'VS Code'; }
		return 'Unknown';
	}

	/**
	 * Extract a friendly display name from a repository URL.
	 * Supports HTTPS, SSH, and git:// URLs.
	 * @param repoUrl The full repository URL
	 * @returns A shortened display name like "owner/repo"
	 */
	private getRepoDisplayName(repoUrl: string): string {
		if (!repoUrl || repoUrl === 'Unknown') { return 'Unknown'; }

		// Remove .git suffix if present
		let url = repoUrl.replace(/\.git$/, '');

		// Handle SSH URLs like git@github.com:owner/repo
		if (url.includes('@') && url.includes(':')) {
			const colonIndex = url.lastIndexOf(':');
			const atIndex = url.lastIndexOf('@');
			if (colonIndex > atIndex) {
				return url.substring(colonIndex + 1);
			}
		}

		// Handle HTTPS/git URLs - extract path after the host
		try {
			if (url.includes('://')) {
				const urlObj = new URL(url);
				const pathParts = urlObj.pathname.split('/').filter(p => p);
				if (pathParts.length >= 2) {
					return `${pathParts[pathParts.length - 2]}/${pathParts[pathParts.length - 1]}`;
				}
				return urlObj.pathname.replace(/^\//, '');
			}
		} catch {
			// URL parsing failed, continue to fallback
		}

		// Fallback: return the last part of the path
		const parts = url.split('/').filter(p => p);
		if (parts.length >= 2) {
			return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
		}
		return url;
	}

	// Logging methods
	public log(message: string): void {
		const timestamp = new Date().toLocaleTimeString();
		this.outputChannel.appendLine(`[${timestamp}] ${message}`);
	}

	private warn(message: string): void {
		const timestamp = new Date().toLocaleTimeString();
		this.outputChannel.appendLine(`[${timestamp}] WARNING: ${message}`);
	}

	private error(message: string, error?: any): void {
		const timestamp = new Date().toLocaleTimeString();
		this.outputChannel.appendLine(`[${timestamp}] ERROR: ${message}`);
		if (error) {
			this.outputChannel.appendLine(`[${timestamp}] ${error}`);
		}
	}

	// Cache management methods
	/**
	 * Checks if the cache is valid for a file by comparing mtime and size.
	 * If the cache entry is missing size (old format), treat as invalid so it will be upgraded.
	 */
	private isCacheValid(filePath: string, currentMtime: number, currentSize: number): boolean {
		const cached = this.sessionFileCache.get(filePath);
		if (!cached) {
			return false;
		}
		// If size is missing (old cache), treat as invalid so it will be upgraded
		if (typeof cached.size !== 'number') {
			return false;
		}
		return cached.mtime === currentMtime && cached.size === currentSize;
	}

	private getCachedSessionData(filePath: string): SessionFileCache | undefined {
		return this.sessionFileCache.get(filePath);
	}

	/**
	 * Sets the cache entry for a session file, including file size.
	 */
	private setCachedSessionData(filePath: string, data: SessionFileCache, fileSize?: number): void {
		if (typeof fileSize === 'number') {
			data.size = fileSize;
		}
		this.sessionFileCache.set(filePath, data);

		// Limit cache size to prevent memory issues (keep last 1000 files)
		// Only trigger cleanup when size exceeds limit by 100 to avoid frequent operations
		if (this.sessionFileCache.size > 1100) {
			// Remove 100 oldest entries to bring size back to 1000
			// Maps maintain insertion order, so the first entries are the oldest
			const keysToDelete: string[] = [];
			let count = 0;
			for (const key of this.sessionFileCache.keys()) {
				keysToDelete.push(key);
				count++;
				if (count >= 100) {
					break;
				}
			}
			for (const key of keysToDelete) {
				this.sessionFileCache.delete(key);
			}
			this.log(`Cache size limit reached, removed ${keysToDelete.length} oldest entries. Current size: ${this.sessionFileCache.size}`);
		}
	}

	private clearExpiredCache(): void {
		// Remove cache entries for files that no longer exist
		const filesToCheck = Array.from(this.sessionFileCache.keys());
		for (const filePath of filesToCheck) {
			try {
				if (!fs.existsSync(filePath)) {
					this.sessionFileCache.delete(filePath);
				}
			} catch (error) {
				// File access error, remove from cache
				this.sessionFileCache.delete(filePath);
			}
		}
	}

	/**
	 * Generate a cache identifier based on VS Code extension mode.
	 * VS Code editions (stable vs insiders) already have separate globalState storage,
	 * so we only need to distinguish between production and development (debug) mode.
	 */
	private getCacheIdentifier(): string {
		return this.context.extensionMode === vscode.ExtensionMode.Development ? 'dev' : 'prod';
	}

	/**
	 * Get the path for the cache lock file.
	 * Uses globalStorageUri which is already scoped per VS Code edition.
	 */
	private getCacheLockPath(): string {
		const cacheId = this.getCacheIdentifier();
		return path.join(this.context.globalStorageUri.fsPath, `cache_${cacheId}.lock`);
	}

	/**
	 * Acquire an exclusive file lock for cache writes.
	 * Uses atomic file creation (O_EXCL / CREATE_NEW) to prevent concurrent writes
	 * across multiple VS Code windows of the same edition.
	 * Returns true if lock acquired, false if another instance holds it.
	 */
	private async acquireCacheLock(): Promise<boolean> {
		const lockPath = this.getCacheLockPath();
		try {
			// Ensure the directory exists
			await fs.promises.mkdir(path.dirname(lockPath), { recursive: true });

			// Atomic exclusive create — fails if lock file already exists
			const fd = await fs.promises.open(lockPath, 'wx');
			await fd.writeFile(JSON.stringify({
				sessionId: vscode.env.sessionId,
				timestamp: Date.now()
			}));
			await fd.close();
			return true;
		} catch (err: any) {
			if (err.code !== 'EEXIST') {
				// Unexpected error (permissions, disk full, etc.)
				this.warn(`Unexpected error acquiring cache lock: ${err.message}`);
				return false;
			}

			// Lock file exists — check if it's stale (owner crashed)
			try {
				const content = await fs.promises.readFile(lockPath, 'utf-8');
				const lock = JSON.parse(content);
				const staleThreshold = 5 * 60 * 1000; // 5 minutes (matches update interval)

				if (Date.now() - lock.timestamp > staleThreshold) {
					// Stale lock — break it and retry once
					this.log('Breaking stale cache lock');
					await fs.promises.unlink(lockPath);
					try {
						const fd = await fs.promises.open(lockPath, 'wx');
						await fd.writeFile(JSON.stringify({
							sessionId: vscode.env.sessionId,
							timestamp: Date.now()
						}));
						await fd.close();
						return true;
					} catch {
						return false; // Another instance beat us to it
					}
				}
			} catch {
				// Can't read lock file — might have been deleted by the owner already
			}
			return false;
		}
	}

	/**
	 * Release the cache lock file, but only if we own it.
	 */
	private async releaseCacheLock(): Promise<void> {
		const lockPath = this.getCacheLockPath();
		try {
			const content = await fs.promises.readFile(lockPath, 'utf-8');
			const lock = JSON.parse(content);
			if (lock.sessionId === vscode.env.sessionId) {
				await fs.promises.unlink(lockPath);
			}
		} catch {
			// Lock file already gone or unreadable — nothing to do
		}
	}

	// Persistent cache storage methods
	private loadCacheFromStorage(): void {
		try {
			const cacheId = this.getCacheIdentifier();
			const versionKey = `sessionFileCacheVersion_${cacheId}`;
			const cacheKey = `sessionFileCache_${cacheId}`;
			
			// One-time migration: clean up old per-session cache keys from previous versions
			this.migrateOldCacheKeys(cacheId);
			
			// Check cache version first
			const storedVersion = this.context.globalState.get<number>(versionKey);
			if (storedVersion !== CopilotTokenTracker.CACHE_VERSION) {
				this.log(`Cache version mismatch (stored: ${storedVersion}, current: ${CopilotTokenTracker.CACHE_VERSION}) for ${cacheId}. Clearing cache.`);
				this.sessionFileCache = new Map();
				return;
			}

			const cacheData = this.context.globalState.get<Record<string, SessionFileCache>>(cacheKey);
			if (cacheData) {
				this.sessionFileCache = new Map(Object.entries(cacheData));
				this.log(`Loaded ${this.sessionFileCache.size} cached session files from storage (${cacheId})`);
			} else {
				this.log(`No cached session files found in storage for ${cacheId}`);
			}
		} catch (error) {
			this.error('Error loading cache from storage:', error);
			// Start with empty cache on error
			this.sessionFileCache = new Map();
		}
	}

	/**
	 * One-time migration: remove old per-session cache keys that were created by
	 * earlier versions of the extension (keys containing sessionId or timestamp).
	 * Also removes the legacy unscoped keys ('sessionFileCache', 'sessionFileCacheVersion').
	 */
	private migrateOldCacheKeys(currentCacheId: string): void {
		try {
			const allKeys = this.context.globalState.keys();
			const currentCacheKey = `sessionFileCache_${currentCacheId}`;
			const currentVersionKey = `sessionFileCacheVersion_${currentCacheId}`;
			
			let removedCount = 0;
			for (const key of allKeys) {
				// Remove old timestamp keys (no longer used)
				if (key.startsWith('sessionFileCacheTimestamp_')) {
					this.context.globalState.update(key, undefined);
					removedCount++;
					continue;
				}
				// Remove old per-session cache keys that have session IDs embedded
				// (they contain more than one underscore-separated segment after the prefix)
				if (key.startsWith('sessionFileCache_') && key !== currentCacheKey) {
					const suffix = key.replace('sessionFileCache_', '');
					if (suffix !== 'dev' && suffix !== 'prod') {
						this.context.globalState.update(key, undefined);
						removedCount++;
					}
				}
				if (key.startsWith('sessionFileCacheVersion_') && key !== currentVersionKey) {
					const suffix = key.replace('sessionFileCacheVersion_', '');
					if (suffix !== 'dev' && suffix !== 'prod') {
						this.context.globalState.update(key, undefined);
						removedCount++;
					}
				}
				// Remove legacy unscoped keys from the original code
				if (key === 'sessionFileCache' || key === 'sessionFileCacheVersion') {
					this.context.globalState.update(key, undefined);
					removedCount++;
				}
			}
			
			if (removedCount > 0) {
				this.log(`Migrated: removed ${removedCount} old cache keys from globalState`);
			}
		} catch (error) {
			this.error('Error migrating old cache keys:', error);
		}
	}

	private async saveCacheToStorage(): Promise<void> {
		const acquired = await this.acquireCacheLock();
		if (!acquired) {
			this.log('Cache lock held by another VS Code window, skipping save');
			return;
		}
		try {
			const cacheId = this.getCacheIdentifier();
			const versionKey = `sessionFileCacheVersion_${cacheId}`;
			const cacheKey = `sessionFileCache_${cacheId}`;
			
			// Convert Map to plain object for storage
			const cacheData = Object.fromEntries(this.sessionFileCache);
			await this.context.globalState.update(cacheKey, cacheData);
			await this.context.globalState.update(versionKey, CopilotTokenTracker.CACHE_VERSION);
			this.log(`Saved ${this.sessionFileCache.size} cached session files to storage (version ${CopilotTokenTracker.CACHE_VERSION}, ${cacheId})`);
		} catch (error) {
			this.error('Error saving cache to storage:', error);
		} finally {
			await this.releaseCacheLock();
		}
	}

	public async clearCache(): Promise<void> {
		try {
			// Show the output channel so users can see what's happening
			this.outputChannel.show(true);
			this.log('Clearing session file cache...');

				const cacheId = this.getCacheIdentifier();
			const cacheKey = `sessionFileCache_${cacheId}`;
			const versionKey = `sessionFileCacheVersion_${cacheId}`;
			
			const cacheSize = this.sessionFileCache.size;
			this.sessionFileCache.clear();
			await this.context.globalState.update(cacheKey, undefined);
			await this.context.globalState.update(versionKey, undefined);
			// Reset diagnostics loaded flag so the diagnostics view will reload files
			this.diagnosticsHasLoadedFiles = false;
			this.diagnosticsCachedFiles = [];
			// Clear cached computed stats so details panel doesn't show stale data
			this.lastDetailedStats = undefined;
			this.lastUsageAnalysisStats = undefined;

			this.log(`Cache cleared successfully. Removed ${cacheSize} entries.`);
			vscode.window.showInformationMessage('Cache cleared successfully. Reloading statistics...');

			// Trigger a refresh after clearing the cache
			this.log('Reloading token statistics...');
			await this.updateTokenStats();
			this.log('Token statistics reloaded successfully.');
		} catch (error) {
			this.error('Error clearing cache:', error);
			vscode.window.showErrorMessage('Failed to clear cache: ' + error);
		}
	}

	constructor(extensionUri: vscode.Uri, context: vscode.ExtensionContext) {
		this.extensionUri = extensionUri;
		this.context = context;
		// Create output channel for extension logs
		this.outputChannel = vscode.window.createOutputChannel('GitHub Copilot Token Tracker');
		// CRITICAL: Add output channel to context.subscriptions so VS Code doesn't dispose it
		context.subscriptions.push(this.outputChannel);
		this.log('Constructor called');

		// Load persisted cache from storage
		this.loadCacheFromStorage();

		// Check GitHub Copilot extension status
		this.checkCopilotExtension();

		// Create status bar item
		this.statusBarItem = vscode.window.createStatusBarItem(
			'copilot-token-tracker',
			vscode.StatusBarAlignment.Right,
			100
		);
		this.statusBarItem.name = "GitHub Copilot Token Usage";
		this.statusBarItem.text = "$(loading~spin) Copilot Tokens: Loading...";
		this.statusBarItem.tooltip = "Daily and 30-day GitHub Copilot token usage - Click to open details";
		this.statusBarItem.command = 'copilot-token-tracker.showDetails';
		this.statusBarItem.show();

		this.log('Status bar item created and shown');

		// Smart initial update with delay for extension loading
		this.scheduleInitialUpdate();

		// Update every 5 minutes (cache is saved automatically after each update)
		this.updateInterval = setInterval(() => {
			this.updateTokenStats(true); // Silent update from timer
		}, 5 * 60 * 1000);
	}

	private scheduleInitialUpdate(): void {
		const copilotExtension = vscode.extensions.getExtension('GitHub.copilot');
		const copilotChatExtension = vscode.extensions.getExtension('GitHub.copilot-chat');

		// Check if Copilot extensions exist but are not active (likely still loading)
		const extensionsExistButInactive =
			(copilotExtension && !copilotExtension.isActive) ||
			(copilotChatExtension && !copilotChatExtension.isActive);

		if (extensionsExistButInactive) {
			// Use shorter delay for testing in Codespaces
			const delaySeconds = process.env.CODESPACES === 'true' ? 5 : 2;
			this.log(`⏳ Waiting for Copilot Extension to start (${delaySeconds}s delay)`);

			this.initialDelayTimeout = setTimeout(async () => {
				try {
					this.log('🚀 Starting token usage analysis...');
					this.recheckCopilotExtensionsAfterDelay();
					await this.updateTokenStats();
					this.startBackendSyncAfterInitialAnalysis();
				} catch (error) {
					this.error('Error in delayed initial update:', error);
				}
			}, delaySeconds * 1000);
		} else if (!copilotExtension && !copilotChatExtension) {
			this.log('⚠️ No Copilot extensions found - starting analysis anyway');
			setTimeout(async () => {
				await this.updateTokenStats();
				this.startBackendSyncAfterInitialAnalysis();
			}, 100);
		} else {
			this.log('✅ Copilot extensions are active - starting token analysis');
			setTimeout(async () => {
				await this.updateTokenStats();
				this.startBackendSyncAfterInitialAnalysis();
			}, 100);
		}
	}

	private recheckCopilotExtensionsAfterDelay(): void {
		const copilotExtension = vscode.extensions.getExtension('GitHub.copilot');
		const copilotChatExtension = vscode.extensions.getExtension('GitHub.copilot-chat');

		const copilotActive = copilotExtension?.isActive;
		const chatActive = copilotChatExtension?.isActive;

		if (copilotActive && chatActive) {
			this.log('✅ Copilot extensions are now active');
		} else {
			this.warn('⚠️ Some Copilot extensions still inactive after delay');
		}
	}

	/**
	 * Start backend sync timer after initial token analysis completes.
	 * This avoids resource contention during extension startup.
	 */
	private startBackendSyncAfterInitialAnalysis(): void {
		try {
			const backend = (this as any).backend;
			if (backend && typeof backend.startTimerIfEnabled === 'function') {
				backend.startTimerIfEnabled();
			}
		} catch (error) {
			this.warn('Failed to start backend sync timer: ' + error);
		}
	}

	public async updateTokenStats(silent: boolean = false): Promise<DetailedStats | undefined> {
		try {
			this.log('Updating token stats...');
			const detailedStats = await this.calculateDetailedStats(silent ? undefined : (completed, total) => {
				const percentage = Math.round((completed / total) * 100);
				this.statusBarItem.text = `$(loading~spin) Analyzing Logs: ${percentage}%`;
			});

			this.statusBarItem.text = `$(symbol-numeric) ${detailedStats.today.tokens.toLocaleString()} | ${detailedStats.last30Days.tokens.toLocaleString()}`;

			// Create detailed tooltip with improved style
			const tooltip = new vscode.MarkdownString();
			tooltip.isTrusted = false;
			// Title
			tooltip.appendMarkdown('#### 🤖 GitHub Copilot Token Usage');
			tooltip.appendMarkdown('\n---\n');
			// Table layout for Today
			tooltip.appendMarkdown(`📅 Today  \n`);
			tooltip.appendMarkdown(`|                 |  |\n|-----------------------|-------|\n`);
			tooltip.appendMarkdown(`| Tokens :                | ${detailedStats.today.tokens.toLocaleString()} |\n`);
			tooltip.appendMarkdown(`| Estimated cost :             | $ ${detailedStats.today.estimatedCost.toFixed(4)} |\n`);
			tooltip.appendMarkdown(`| CO₂ estimated :              | ${detailedStats.today.co2.toFixed(2)} grams |\n`);
			tooltip.appendMarkdown(`| Water estimated :           | ${detailedStats.today.waterUsage.toFixed(3)} liters |\n`);
			tooltip.appendMarkdown(`| Sessions :             | ${detailedStats.today.sessions} |\n`);
			tooltip.appendMarkdown(`| Average interactions/session :     | ${detailedStats.today.avgInteractionsPerSession} |\n`);
			tooltip.appendMarkdown(`| Average tokens/session :            | ${detailedStats.today.avgTokensPerSession.toLocaleString()} |\n`);

			tooltip.appendMarkdown('\n---\n');

			// Table layout for Last 30 Days
			tooltip.appendMarkdown(`📊 Last 30 Days  \n`);
			tooltip.appendMarkdown(`|                 |  |\n|-----------------------|-------|\n`);
			tooltip.appendMarkdown(`| Tokens :                | ${detailedStats.last30Days.tokens.toLocaleString()} |\n`);
			tooltip.appendMarkdown(`| Estimated cost :             | $ ${detailedStats.last30Days.estimatedCost.toFixed(4)} |\n`);
			tooltip.appendMarkdown(`| CO₂ estimated :              | ${detailedStats.last30Days.co2.toFixed(2)} grams |\n`);
			tooltip.appendMarkdown(`| Water estimated :           | ${detailedStats.last30Days.waterUsage.toFixed(3)} liters |\n`);
			tooltip.appendMarkdown(`| Sessions :             | ${detailedStats.last30Days.sessions} |\n`);
			tooltip.appendMarkdown(`| Average interactions/session :      | ${detailedStats.last30Days.avgInteractionsPerSession} |\n`);
			tooltip.appendMarkdown(`| Average tokens/session :            | ${detailedStats.last30Days.avgTokensPerSession.toLocaleString()} |\n`);
			// Footer
			tooltip.appendMarkdown('\n---\n');
			tooltip.appendMarkdown('*Cost estimates based on actual input/output token ratios.*  \n');
			tooltip.appendMarkdown('*Updates automatically every 5 minutes.*');

			this.statusBarItem.tooltip = tooltip;

			// If the details panel is open, update its content
			if (this.detailsPanel) {
				this.detailsPanel.webview.html = this.getDetailsHtml(this.detailsPanel.webview, detailedStats);
			}

			// If the chart panel is open, update its content
			if (this.chartPanel) {
				const dailyStats = await this.calculateDailyStats();
				this.chartPanel.webview.html = this.getChartHtml(this.chartPanel.webview, dailyStats);
			}

			// If the analysis panel is open, update its content
			if (this.analysisPanel) {
				const analysisStats = await this.calculateUsageAnalysisStats(false); // Force recalculation on refresh
				this.analysisPanel.webview.html = this.getUsageAnalysisHtml(this.analysisPanel.webview, analysisStats);
			} else {
				// Pre-populate the cache even when panel isn't open, so first open is fast
				await this.calculateUsageAnalysisStats(false);
			}

			// If the maturity panel is open, update its content
			if (this.maturityPanel) {
				const maturityData = await this.calculateMaturityScores(false); // Force recalculation on refresh
				this.maturityPanel.webview.html = this.getMaturityHtml(this.maturityPanel.webview, maturityData);
			}

			this.log(`Updated stats - Today: ${detailedStats.today.tokens}, Last 30 Days: ${detailedStats.last30Days.tokens}`);
			// Store the stats for reuse without recalculation
			this.lastDetailedStats = detailedStats;

			// Save cache to ensure it's persisted for next run (don't await to avoid blocking UI)
			this.saveCacheToStorage().catch(err => {
				this.warn(`Failed to save cache: ${err}`);
			});

			return detailedStats;
		} catch (error) {
			this.error('Error updating token stats:', error);
			this.statusBarItem.text = '$(error) Token Error';
			this.statusBarItem.tooltip = 'Error calculating token usage';
			return undefined;
		}
	}

	private async calculateTokenUsage(): Promise<Pick<TokenUsageStats, 'todayTokens' | 'monthTokens'>> {
		const now = new Date();
		const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
		const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

		let todayTokens = 0;
		let monthTokens = 0;

		try {
			// Get session files from both workspace and global storage
			const sessionFiles = await this.getCopilotSessionFiles();

			for (const sessionFile of sessionFiles) {
				try {
					// OPTIMIZATION: Check cache first to avoid unnecessary stat calls
					const cachedData = this.getCachedSessionData(sessionFile);
					let mtime: number;
					let fileSize: number;

					if (cachedData && typeof cachedData.mtime === 'number' && typeof cachedData.size === 'number') {
						// Use cached mtime/size - avoid stat call
						mtime = cachedData.mtime;
						fileSize = cachedData.size;
					} else {
						// Not in cache - need to stat the file
						const fileStats = await this.statSessionFile(sessionFile);
						mtime = fileStats.mtime.getTime();
						fileSize = fileStats.size;
					}

					// Only process files modified in the current month
					if (mtime >= monthStart.getTime()) {
						const tokens = await this.estimateTokensFromSessionCached(sessionFile, mtime, fileSize);

						monthTokens += tokens;

						// If modified today, add to today's count
						if (mtime >= todayStart.getTime()) {
							todayTokens += tokens;
						}
					}
				} catch (fileError) {
					this.warn(`Error processing session file ${sessionFile}: ${fileError}`);
				}
			}
		} catch (error) {
			this.error('Error calculating token usage:', error);
		}

		return {
			todayTokens,
			monthTokens
		};
	}

	private async calculateDetailedStats(progressCallback?: (completed: number, total: number) => void): Promise<DetailedStats> {
		const now = new Date();
		const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
		const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
		// Calculate last month boundaries
		const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999); // Last day of previous month
		const lastMonthStart = new Date(lastMonthEnd.getFullYear(), lastMonthEnd.getMonth(), 1);
		// Calculate last 30 days boundary
		const last30DaysStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

		const todayStats = { tokens: 0, thinkingTokens: 0, estimatedTokens: 0, actualTokens: 0, sessions: 0, interactions: 0, modelUsage: {} as ModelUsage, editorUsage: {} as EditorUsage };
		const monthStats = { tokens: 0, thinkingTokens: 0, estimatedTokens: 0, actualTokens: 0, sessions: 0, interactions: 0, modelUsage: {} as ModelUsage, editorUsage: {} as EditorUsage };
		const lastMonthStats = { tokens: 0, thinkingTokens: 0, estimatedTokens: 0, actualTokens: 0, sessions: 0, interactions: 0, modelUsage: {} as ModelUsage, editorUsage: {} as EditorUsage };
		const last30DaysStats = { tokens: 0, thinkingTokens: 0, estimatedTokens: 0, actualTokens: 0, sessions: 0, interactions: 0, modelUsage: {} as ModelUsage, editorUsage: {} as EditorUsage };

		try {
			// Clean expired cache entries
			this.clearExpiredCache();

			const sessionFiles = await this.getCopilotSessionFiles();
			this.log(`📊 Analyzing ${sessionFiles.length} session file(s)...`);

			if (sessionFiles.length === 0) {
				this.warn('⚠️ No session files found - Have you used GitHub Copilot Chat yet?');
			}

			let cacheHits = 0;
			let cacheMisses = 0;
			let skippedFiles = 0;

			for (let i = 0; i < sessionFiles.length; i++) {
				const sessionFile = sessionFiles[i];

				if (progressCallback) {
					progressCallback(i + 1, sessionFiles.length);
				}

				try {
					// OPTIMIZATION: Check cache first to avoid unnecessary stat calls
					const cachedData = this.getCachedSessionData(sessionFile);
					let mtime: number;
					let fileSize: number;
					let wasCached: boolean;

					if (cachedData && typeof cachedData.mtime === 'number' && typeof cachedData.size === 'number') {
						// Use cached mtime/size - avoid stat call
						mtime = cachedData.mtime;
						fileSize = cachedData.size;
						wasCached = true;
					} else {
						// Not in cache - need to stat the file
						const fileStats = await this.statSessionFile(sessionFile);
						mtime = fileStats.mtime.getTime();
						fileSize = fileStats.size;
						wasCached = false;
					}

					// Skip files modified before last 30 days (quick filter)
					// This is the main performance optimization - filters out old sessions without reading file content
					if (mtime < last30DaysStart.getTime()) {
						skippedFiles++;
						continue;
					}

					// Get all session data in one call to avoid multiple cache lookups
					const sessionData = await this.getSessionFileDataCached(sessionFile, mtime, fileSize);
					const interactions = sessionData.interactions;
					// Skip empty sessions (no interactions = just opened chat panel, no messages sent)
					if (interactions === 0) {
						skippedFiles++;
						continue;
					}

					// Extract remaining data from the cached session
					const estimatedTokens = sessionData.tokens; // Text-based estimate (user content only)
					const actualTokens = sessionData.actualTokens || 0; // Actual LLM API tokens (when available)
					const tokens = actualTokens > 0 ? actualTokens : estimatedTokens; // Best available
					const modelUsage = sessionData.modelUsage;
					const editorType = this.getEditorTypeFromPath(sessionFile);

					// For date filtering, get lastInteraction from session details
					const details = await this.getSessionFileDetails(sessionFile);
					const lastActivity = details.lastInteraction
						? new Date(details.lastInteraction)
						: new Date(details.modified);

					// Update cache statistics (do this once per file)
					if (wasCached) {
						cacheHits++;
					} else {
						cacheMisses++;
					}

					// Check if activity is within last 30 days
					if (lastActivity >= last30DaysStart) {
						last30DaysStats.tokens += tokens;
						last30DaysStats.estimatedTokens += estimatedTokens;
						last30DaysStats.actualTokens += actualTokens;
						last30DaysStats.thinkingTokens += (sessionData.thinkingTokens || 0);
						last30DaysStats.sessions += 1;
						last30DaysStats.interactions += interactions;

						// Add editor usage to last 30 days stats
						if (!last30DaysStats.editorUsage[editorType]) {
							last30DaysStats.editorUsage[editorType] = { tokens: 0, sessions: 0 };
						}
						last30DaysStats.editorUsage[editorType].tokens += tokens;
						last30DaysStats.editorUsage[editorType].sessions += 1;

						// Add model usage to last 30 days stats
						for (const [model, usage] of Object.entries(modelUsage)) {
							if (!last30DaysStats.modelUsage[model]) {
								last30DaysStats.modelUsage[model] = { inputTokens: 0, outputTokens: 0 };
							}
							last30DaysStats.modelUsage[model].inputTokens += usage.inputTokens;
							last30DaysStats.modelUsage[model].outputTokens += usage.outputTokens;
						}
					}

					if (lastActivity >= monthStart) {
						monthStats.tokens += tokens;
						monthStats.estimatedTokens += estimatedTokens;
						monthStats.actualTokens += actualTokens;
						monthStats.thinkingTokens += (sessionData.thinkingTokens || 0);
						monthStats.sessions += 1;
						monthStats.interactions += interactions;

						// Add editor usage to month stats
						if (!monthStats.editorUsage[editorType]) {
							monthStats.editorUsage[editorType] = { tokens: 0, sessions: 0 };
						}
						monthStats.editorUsage[editorType].tokens += tokens;
						monthStats.editorUsage[editorType].sessions += 1;

						// Add model usage to month stats
						for (const [model, usage] of Object.entries(modelUsage)) {
							if (!monthStats.modelUsage[model]) {
								monthStats.modelUsage[model] = { inputTokens: 0, outputTokens: 0 };
							}
							monthStats.modelUsage[model].inputTokens += usage.inputTokens;
							monthStats.modelUsage[model].outputTokens += usage.outputTokens;
						}

						if (lastActivity >= todayStart) {
							todayStats.tokens += tokens;
							todayStats.estimatedTokens += estimatedTokens;
							todayStats.actualTokens += actualTokens;
							todayStats.thinkingTokens += (sessionData.thinkingTokens || 0);
							todayStats.sessions += 1;
							todayStats.interactions += interactions;

							// Add editor usage to today stats
							if (!todayStats.editorUsage[editorType]) {
								todayStats.editorUsage[editorType] = { tokens: 0, sessions: 0 };
							}
							todayStats.editorUsage[editorType].tokens += tokens;
							todayStats.editorUsage[editorType].sessions += 1;

							// Add model usage to today stats
							for (const [model, usage] of Object.entries(modelUsage)) {
								if (!todayStats.modelUsage[model]) {
									todayStats.modelUsage[model] = { inputTokens: 0, outputTokens: 0 };
								}
								todayStats.modelUsage[model].inputTokens += usage.inputTokens;
								todayStats.modelUsage[model].outputTokens += usage.outputTokens;
							}
						}
					}
					else if (lastActivity >= lastMonthStart && lastActivity <= lastMonthEnd) {
						// Session is from last month - only track lastMonth stats
						lastMonthStats.tokens += tokens;
						lastMonthStats.estimatedTokens += estimatedTokens;
						lastMonthStats.actualTokens += actualTokens;
						lastMonthStats.thinkingTokens += (sessionData.thinkingTokens || 0);
						lastMonthStats.sessions += 1;
						lastMonthStats.interactions += interactions;

						// Add editor usage to last month stats
						if (!lastMonthStats.editorUsage[editorType]) {
							lastMonthStats.editorUsage[editorType] = { tokens: 0, sessions: 0 };
						}
						lastMonthStats.editorUsage[editorType].tokens += tokens;
						lastMonthStats.editorUsage[editorType].sessions += 1;

						// Add model usage to last month stats
						for (const [model, usage] of Object.entries(modelUsage)) {
							if (!lastMonthStats.modelUsage[model]) {
								lastMonthStats.modelUsage[model] = { inputTokens: 0, outputTokens: 0 };
							}
							lastMonthStats.modelUsage[model].inputTokens += usage.inputTokens;
							lastMonthStats.modelUsage[model].outputTokens += usage.outputTokens;
						}
					}
					else {
						// Session is too old (no activity in last 30 days), skip it
						skippedFiles++;
					}
				} catch (fileError) {
					this.warn(`Error processing session file ${sessionFile}: ${fileError}`);
				}
			}

			this.log(`✅ Analysis complete: Today ${todayStats.sessions} sessions, Month ${monthStats.sessions} sessions, Last 30 Days ${last30DaysStats.sessions} sessions, Last Month ${lastMonthStats.sessions} sessions`);
			if (skippedFiles > 0) {
				this.log(`⏭️ Skipped ${skippedFiles} session file(s) (empty or no activity in recent months)`);
			}
			const totalCacheAccesses = cacheHits + cacheMisses;
			this.log(`💾 Cache performance: ${cacheHits} hits, ${cacheMisses} misses (${totalCacheAccesses > 0 ? ((cacheHits / totalCacheAccesses) * 100).toFixed(1) : 0}% hit rate)`);
		} catch (error) {
			this.error('Error calculating detailed stats:', error);
		}

		const todayCo2 = (todayStats.tokens / 1000) * this.co2Per1kTokens;
		const monthCo2 = (monthStats.tokens / 1000) * this.co2Per1kTokens;
		const lastMonthCo2 = (lastMonthStats.tokens / 1000) * this.co2Per1kTokens;
		const last30DaysCo2 = (last30DaysStats.tokens / 1000) * this.co2Per1kTokens;

		const todayWater = (todayStats.tokens / 1000) * this.waterUsagePer1kTokens;
		const monthWater = (monthStats.tokens / 1000) * this.waterUsagePer1kTokens;
		const lastMonthWater = (lastMonthStats.tokens / 1000) * this.waterUsagePer1kTokens;
		const last30DaysWater = (last30DaysStats.tokens / 1000) * this.waterUsagePer1kTokens;

		const todayCost = this.calculateEstimatedCost(todayStats.modelUsage);
		const monthCost = this.calculateEstimatedCost(monthStats.modelUsage);
		const lastMonthCost = this.calculateEstimatedCost(lastMonthStats.modelUsage);
		const last30DaysCost = this.calculateEstimatedCost(last30DaysStats.modelUsage);

		const result: DetailedStats = {
			today: {
				tokens: todayStats.tokens,
				thinkingTokens: todayStats.thinkingTokens,
				estimatedTokens: todayStats.estimatedTokens,
				actualTokens: todayStats.actualTokens,
				sessions: todayStats.sessions,
				avgInteractionsPerSession: todayStats.sessions > 0 ? Math.round(todayStats.interactions / todayStats.sessions) : 0,
				avgTokensPerSession: todayStats.sessions > 0 ? Math.round(todayStats.tokens / todayStats.sessions) : 0,
				modelUsage: todayStats.modelUsage,
				editorUsage: todayStats.editorUsage,
				co2: todayCo2,
				treesEquivalent: todayCo2 / this.co2AbsorptionPerTreePerYear,
				waterUsage: todayWater,
				estimatedCost: todayCost
			},
			month: {
				tokens: monthStats.tokens,
				thinkingTokens: monthStats.thinkingTokens,
				estimatedTokens: monthStats.estimatedTokens,
				actualTokens: monthStats.actualTokens,
				sessions: monthStats.sessions,
				avgInteractionsPerSession: monthStats.sessions > 0 ? Math.round(monthStats.interactions / monthStats.sessions) : 0,
				avgTokensPerSession: monthStats.sessions > 0 ? Math.round(monthStats.tokens / monthStats.sessions) : 0,
				modelUsage: monthStats.modelUsage,
				editorUsage: monthStats.editorUsage,
				co2: monthCo2,
				treesEquivalent: monthCo2 / this.co2AbsorptionPerTreePerYear,
				waterUsage: monthWater,
				estimatedCost: monthCost
			},
			lastMonth: {
				tokens: lastMonthStats.tokens,
				thinkingTokens: lastMonthStats.thinkingTokens,
				estimatedTokens: lastMonthStats.estimatedTokens,
				actualTokens: lastMonthStats.actualTokens,
				sessions: lastMonthStats.sessions,
				avgInteractionsPerSession: lastMonthStats.sessions > 0 ? Math.round(lastMonthStats.interactions / lastMonthStats.sessions) : 0,
				avgTokensPerSession: lastMonthStats.sessions > 0 ? Math.round(lastMonthStats.tokens / lastMonthStats.sessions) : 0,
				modelUsage: lastMonthStats.modelUsage,
				editorUsage: lastMonthStats.editorUsage,
				co2: lastMonthCo2,
				treesEquivalent: lastMonthCo2 / this.co2AbsorptionPerTreePerYear,
				waterUsage: lastMonthWater,
				estimatedCost: lastMonthCost
			},
			last30Days: {
				tokens: last30DaysStats.tokens,
				thinkingTokens: last30DaysStats.thinkingTokens,
				estimatedTokens: last30DaysStats.estimatedTokens,
				actualTokens: last30DaysStats.actualTokens,
				sessions: last30DaysStats.sessions,
				avgInteractionsPerSession: last30DaysStats.sessions > 0 ? Math.round(last30DaysStats.interactions / last30DaysStats.sessions) : 0,
				avgTokensPerSession: last30DaysStats.sessions > 0 ? Math.round(last30DaysStats.tokens / last30DaysStats.sessions) : 0,
				modelUsage: last30DaysStats.modelUsage,
				editorUsage: last30DaysStats.editorUsage,
				co2: last30DaysCo2,
				treesEquivalent: last30DaysCo2 / this.co2AbsorptionPerTreePerYear,
				waterUsage: last30DaysWater,
				estimatedCost: last30DaysCost
			},
			lastUpdated: now
		};

		return result;
	}

	private formatDateKey(date: Date): string {
		return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
	}

	private async calculateDailyStats(): Promise<DailyTokenStats[]> {
		const now = new Date();
		// Use last 30 days instead of current month for better chart visibility
		const thirtyDaysAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30);

		// Map to store daily stats by date string (YYYY-MM-DD)
		const dailyStatsMap = new Map<string, DailyTokenStats>();

		try {
			const sessionFiles = await this.getCopilotSessionFiles();
			this.log(`📈 Preparing chart data from ${sessionFiles.length} session file(s)...`);

			for (const sessionFile of sessionFiles) {
				try {
					// OPTIMIZATION: Check cache first to avoid unnecessary stat calls
					// The cache contains mtime and size, so we can skip stat if cached
					const cachedData = this.getCachedSessionData(sessionFile);
					let mtime: number;
					let fileSize: number;
					let fileStats: fs.Stats | undefined;

					if (cachedData && typeof cachedData.mtime === 'number' && typeof cachedData.size === 'number') {
						// Use cached mtime/size - avoid stat call (major performance win)
						mtime = cachedData.mtime;
						fileSize = cachedData.size;
					} else {
						// Not in cache - need to stat the file
						fileStats = await this.statSessionFile(sessionFile);
						mtime = fileStats.mtime.getTime();
						fileSize = fileStats.size;
					}

					// Only process files modified in the last 30 days
					if (mtime >= thirtyDaysAgo.getTime()) {
						// Get all session data in one call to avoid multiple cache lookups
						const sessionData = await this.getSessionFileDataCached(sessionFile, mtime, fileSize);
						const tokens = sessionData.tokens;
						const interactions = sessionData.interactions;
						const modelUsage = sessionData.modelUsage;
						const editorType = this.getEditorTypeFromPath(sessionFile);

						// Repository was already retrieved from cache above (cachedData)
						const repository = cachedData?.repository || 'Unknown';

						// Get the date in YYYY-MM-DD format
						const dateKey = this.formatDateKey(new Date(mtime));

						// Initialize or update the daily stats
						if (!dailyStatsMap.has(dateKey)) {
							dailyStatsMap.set(dateKey, {
								date: dateKey,
								tokens: 0,
								sessions: 0,
								interactions: 0,
								modelUsage: {},
								editorUsage: {},
								repositoryUsage: {}
							});
						}

						const dailyStats = dailyStatsMap.get(dateKey)!;
						dailyStats.tokens += tokens;
						dailyStats.sessions += 1;
						dailyStats.interactions += interactions;

						// Merge editor usage
						if (!dailyStats.editorUsage[editorType]) {
							dailyStats.editorUsage[editorType] = { tokens: 0, sessions: 0 };
						}
						dailyStats.editorUsage[editorType].tokens += tokens;
						dailyStats.editorUsage[editorType].sessions += 1;

						// Merge repository usage
						if (!dailyStats.repositoryUsage[repository]) {
							dailyStats.repositoryUsage[repository] = { tokens: 0, sessions: 0 };
						}
						dailyStats.repositoryUsage[repository].tokens += tokens;
						dailyStats.repositoryUsage[repository].sessions += 1;

						// Merge model usage
						for (const [model, usage] of Object.entries(modelUsage)) {
							if (!dailyStats.modelUsage[model]) {
								dailyStats.modelUsage[model] = { inputTokens: 0, outputTokens: 0 };
							}
							dailyStats.modelUsage[model].inputTokens += usage.inputTokens;
							dailyStats.modelUsage[model].outputTokens += usage.outputTokens;
						}
					}
				} catch (fileError) {
					this.warn(`Error processing session file ${sessionFile} for daily stats: ${fileError}`);
				}
			}
		} catch (error) {
			this.error('Error calculating daily stats:', error);
		}

		// Convert map to array and sort by date
		let dailyStatsArray = Array.from(dailyStatsMap.values()).sort((a, b) => a.date.localeCompare(b.date));

		// Always fill in all 30 days to show complete chart
		const today = new Date();

		// Create a set of existing dates for quick lookup
		const existingDates = new Set(dailyStatsArray.map(s => s.date));

		// Generate all dates from 30 days ago to today
		const allDates: string[] = [];
		const currentDate = new Date(thirtyDaysAgo);

		while (currentDate <= today) {
			const dateKey = this.formatDateKey(currentDate);
			allDates.push(dateKey);
			currentDate.setDate(currentDate.getDate() + 1);
		}

		// Add missing dates with zero values
		for (const dateKey of allDates) {
			if (!existingDates.has(dateKey)) {
				dailyStatsMap.set(dateKey, {
					date: dateKey,
					tokens: 0,
					sessions: 0,
					interactions: 0,
					modelUsage: {},
					editorUsage: {},
					repositoryUsage: {}
				});
			}
		}

		// Re-convert map to array and sort by date
		dailyStatsArray = Array.from(dailyStatsMap.values()).sort((a, b) => a.date.localeCompare(b.date));

		return dailyStatsArray;
	}

	private detectMissedPotential(
		workspaceSessionCounts: Map<string, number>,
		workspaceInteractionCounts: Map<string, number>
	): MissedPotentialWorkspace[] {
		const missedPotential: MissedPotentialWorkspace[] = [];

		for (const [workspacePath, sessionCount] of workspaceSessionCounts) {
			const files = this._customizationFilesCache.get(workspacePath) || [];
			
			// Check for Copilot files (category "copilot" or undefined for backward compatibility)
			const hasCopilotFiles = files.some(f => !f.category || f.category === 'copilot');
			
			// Check for non-Copilot files (must be explicitly "non-copilot")
			const nonCopilotFiles = files.filter(f => f.category === 'non-copilot');
			
			// Missed potential = has non-Copilot files AND NO Copilot files
			if (nonCopilotFiles.length > 0 && !hasCopilotFiles) {
				missedPotential.push({
					workspacePath,
					workspaceName: path.basename(workspacePath),
					sessionCount,
					interactionCount: workspaceInteractionCounts.get(workspacePath) || 0,
					nonCopilotFiles
				});
			}
		}

		// Sort by interaction count (descending) so most active "missed" repos are first
		missedPotential.sort((a, b) => b.interactionCount - a.interactionCount);

		return missedPotential;
	}

	/**
	 * Calculate usage analysis statistics for today and last 30 days
	 * @param useCache If true, return cached stats if available. If false, force recalculation.
	 */
	private async calculateUsageAnalysisStats(useCache = true): Promise<UsageAnalysisStats> {
		// Return cached stats if available and cache is allowed
		if (useCache && this.lastUsageAnalysisStats) {
			this.log('🔍 [Usage Analysis] Using cached stats');
			return this.lastUsageAnalysisStats;
		}

		const now = new Date();
		const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
		const last30DaysStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
		const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

		this.log('🔍 [Usage Analysis] Starting calculation...');
		this._cacheHits = 0; // Reset cache hit counter
		this._cacheMisses = 0; // Reset cache miss counter

		const emptyPeriod = (): UsageAnalysisPeriod => ({
			sessions: 0,
			toolCalls: { total: 0, byTool: {} },
			modeUsage: { ask: 0, edit: 0, agent: 0, plan: 0, customAgent: 0 },
			contextReferences: {
				file: 0,
				selection: 0,
				implicitSelection: 0,
				symbol: 0,
				codebase: 0,
				workspace: 0,
				terminal: 0,
				vscode: 0,
				terminalLastCommand: 0,
				terminalSelection: 0,
				clipboard: 0,
				changes: 0,
				outputPanel: 0,
				problemsPanel: 0,
				byKind: {},
				copilotInstructions: 0,
				agentsMd: 0,
				byPath: {}
			},
			mcpTools: { total: 0, byServer: {}, byTool: {} },
			modelSwitching: {
				modelsPerSession: [],
				totalSessions: 0,
				averageModelsPerSession: 0,
				maxModelsPerSession: 0,
				minModelsPerSession: 0,
				switchingFrequency: 0,
				standardModels: [],
				premiumModels: [],
				unknownModels: [],
				mixedTierSessions: 0,
				standardRequests: 0,
				premiumRequests: 0,
				unknownRequests: 0,
				totalRequests: 0
			},
			repositories: [],
			repositoriesWithCustomization: [],
			editScope: {
				singleFileEdits: 0,
				multiFileEdits: 0,
				totalEditedFiles: 0,
				avgFilesPerSession: 0
			},
			applyUsage: {
				totalApplies: 0,
				totalCodeBlocks: 0,
				applyRate: 0
			},
			sessionDuration: {
				totalDurationMs: 0,
				avgDurationMs: 0,
				avgFirstProgressMs: 0,
				avgTotalElapsedMs: 0,
				avgWaitTimeMs: 0
			},
			conversationPatterns: {
				multiTurnSessions: 0,
				singleTurnSessions: 0,
				avgTurnsPerSession: 0,
				maxTurnsInSession: 0
			},
			agentTypes: {
				editsAgent: 0,
				defaultAgent: 0,
				workspaceAgent: 0,
				other: 0
			}
		});

		const todayStats = emptyPeriod();
		const last30DaysStats = emptyPeriod();
		const monthStats = emptyPeriod();

		// Track session counts per resolved workspace (workspaces with activity in last 30 days)
		const workspaceSessionCounts = new Map<string, number>();
		// Track interaction counts per resolved workspace (for prioritization)
		const workspaceInteractionCounts = new Map<string, number>();
		// Track unresolved workspace IDs (failed resolution or no workspace)
		const unresolvedWorkspaceIds = new Set<string>();
		// Track interaction counts for unresolved workspace IDs
		const unresolvedWorkspaceInteractionCounts = new Map<string, number>();

		// Clear short-lived caches for this analysis run
		this._workspaceIdToFolderCache.clear();
		this._customizationFilesCache.clear();

		try {
			const sessionFiles = await this.getCopilotSessionFiles();
			this.log(`🔍 [Usage Analysis] Processing ${sessionFiles.length} session files`);

			let processed = 0;
			const progressInterval = Math.max(1, Math.floor(sessionFiles.length / 20)); // Log every 5%

			for (const sessionFile of sessionFiles) {
				try {
					// OPTIMIZATION: Check cache first to avoid unnecessary stat calls
					const cachedData = this.getCachedSessionData(sessionFile);
					let mtime: number;
					let fileSize: number;

					if (cachedData && typeof cachedData.mtime === 'number' && typeof cachedData.size === 'number') {
						// Use cached mtime/size - avoid stat call
						mtime = cachedData.mtime;
						fileSize = cachedData.size;
					} else {
						// Not in cache - need to stat the file
						const fileStats = await this.statSessionFile(sessionFile);
						mtime = fileStats.mtime.getTime();
						fileSize = fileStats.size;
					}

					// Check if file is within the last 30 days (widest range)
					if (mtime >= last30DaysStart.getTime()) {
						
						// Get all session data in one call to avoid multiple cache lookups
						const sessionData = await this.getSessionFileDataCached(sessionFile, mtime, fileSize);
						const interactions = sessionData.interactions;
						const analysis = sessionData.usageAnalysis || {
							toolCalls: { total: 0, byTool: {} },
							modeUsage: { ask: 0, edit: 0, agent: 0, plan: 0, customAgent: 0 },
							contextReferences: {
								file: 0,
								selection: 0,
								implicitSelection: 0,
								symbol: 0,
								codebase: 0,
								workspace: 0,
								terminal: 0,
								vscode: 0,
								terminalLastCommand: 0,
								terminalSelection: 0,
								clipboard: 0,
								changes: 0,
								outputPanel: 0,
								problemsPanel: 0,
								byKind: {},
								copilotInstructions: 0,
								agentsMd: 0,
								byPath: {}
							},
							mcpTools: { total: 0, byServer: {}, byTool: {} },
							modelSwitching: {
								uniqueModels: [],
								modelCount: 0,
								switchCount: 0,
								tiers: { standard: [], premium: [], unknown: [] },
								hasMixedTiers: false,
								standardRequests: 0,
								premiumRequests: 0,
								unknownRequests: 0,
								totalRequests: 0
							}
						};

						// Exclude empty sessions (no interactions) from usage analysis
						if (interactions === 0) {
							// Skip counting this session as it contains no user interactions
							processed++;
							if (processed % progressInterval === 0) {
								this.log(`🔍 [Usage Analysis] Progress: ${processed}/${sessionFiles.length} files (${Math.round(processed / sessionFiles.length * 100)}%)`);
							}
							continue;
						}

						// Add to last 30 days stats
						last30DaysStats.sessions++;
						this.mergeUsageAnalysis(last30DaysStats, analysis);

						// Resolve workspace folder and track session counts; also pre-scan customization files for this workspace
						// Extract workspace ID first (this operation should be safe and not throw)
						const workspaceId = this.extractWorkspaceIdFromSessionPath(sessionFile);
						try {
							const workspaceFolder = this.resolveWorkspaceFolderFromSessionPath(sessionFile);
							if (workspaceFolder) {
								const norm = path.normalize(workspaceFolder);
								workspaceSessionCounts.set(norm, (workspaceSessionCounts.get(norm) || 0) + 1);
								workspaceInteractionCounts.set(norm, (workspaceInteractionCounts.get(norm) || 0) + interactions);
								if (!this._customizationFilesCache.has(norm)) {
									try {
										const files = this.scanWorkspaceCustomizationFiles(norm);
										this._customizationFilesCache.set(norm, files);
									} catch (e) {
										// ignore scan errors per workspace
									}
								}
							} else if (workspaceId) {
								// Workspace resolution failed but we have a workspace ID
								// Track it as unresolved so it counts toward total repos
								unresolvedWorkspaceIds.add(workspaceId);
								unresolvedWorkspaceInteractionCounts.set(workspaceId, (unresolvedWorkspaceInteractionCounts.get(workspaceId) || 0) + interactions);
							}
						} catch (e) {
							// Resolution threw an exception; track as unresolved if we have a workspace ID
							if (workspaceId) {
								unresolvedWorkspaceIds.add(workspaceId);
								unresolvedWorkspaceInteractionCounts.set(workspaceId, (unresolvedWorkspaceInteractionCounts.get(workspaceId) || 0) + interactions);
							}
						}

						// Add to month stats if modified this calendar month
						if (mtime >= monthStart.getTime()) {
							monthStats.sessions++;
							this.mergeUsageAnalysis(monthStats, analysis);
						}

						// Add to today stats if modified today
						if (mtime >= todayStart.getTime()) {
							todayStats.sessions++;
							this.mergeUsageAnalysis(todayStats, analysis);
						}
					}

					processed++;
					if (processed % progressInterval === 0) {
						this.log(`🔍 [Usage Analysis] Progress: ${processed}/${sessionFiles.length} files (${Math.round(processed / sessionFiles.length * 100)}%)`);
					}
				} catch (fileError) {
					this.warn(`Error processing session file ${sessionFile} for usage analysis: ${fileError}`);
					processed++;
				}
			}

			// Build the customization matrix using scanned workspace data and session counts
			try {
				// Unique customization types based on Copilot patterns only
				const uniqueTypes = new Map<string, { icon: string; label: string }>();
				for (const pattern of (customizationPatternsData as any).patterns || []) {
					if (pattern.category && pattern.category !== 'copilot') {
						continue;
					}
					if (!uniqueTypes.has(pattern.type)) {
						uniqueTypes.set(pattern.type, { icon: pattern.icon || '', label: pattern.label || pattern.type });
					}
				}

				const customizationTypes = Array.from(uniqueTypes.entries()).map(([id, v]) => ({ id, icon: v.icon, label: v.label }));

				const matrixRows: WorkspaceCustomizationRow[] = [];
				let workspacesWithIssues = 0;

				for (const [folderPath, sessionCount] of workspaceSessionCounts) {
					const files = this._customizationFilesCache.get(folderPath) || [];
					const typeStatuses: { [typeId: string]: CustomizationTypeStatus } = {};
					for (const type of customizationTypes) {
						const filesOfType = files.filter(f => f.type === type.id);
						if (filesOfType.length === 0) {
							typeStatuses[type.id] = '❌';
						} else if (filesOfType.some(f => f.isStale)) {
							typeStatuses[type.id] = '⚠️';
						} else {
							typeStatuses[type.id] = '✅';
						}
					}

					// Count workspaces that have NO customization files present at all
					const hasNoCustomizationFiles = customizationTypes.every(t => typeStatuses[t.id] === '❌');
					if (hasNoCustomizationFiles) { workspacesWithIssues++; }

					matrixRows.push({
						workspacePath: folderPath,
						workspaceName: path.basename(folderPath),
						sessionCount,
						interactionCount: workspaceInteractionCounts.get(folderPath) || 0,
						typeStatuses
					});
				}

				// Add unresolved workspaces as rows with all customization types marked as ❌
				// This ensures they count toward total repos and are assumed to have NO customizations
				for (const workspaceId of unresolvedWorkspaceIds) {
					const typeStatuses: { [typeId: string]: CustomizationTypeStatus } = {};
					for (const type of customizationTypes) {
						typeStatuses[type.id] = '❌';
					}
					workspacesWithIssues++; // Unresolved workspaces are counted as having no customization
					
					// Generate display name with smart truncation
					const displayId = workspaceId.length > CopilotTokenTracker.WORKSPACE_ID_DISPLAY_LENGTH
						? `${workspaceId.substring(0, CopilotTokenTracker.WORKSPACE_ID_DISPLAY_LENGTH)}...`
						: workspaceId;
					
					matrixRows.push({
						workspacePath: `<unresolved:${workspaceId}>`,
						workspaceName: `Unresolved (${displayId})`,
						// Session count is 0 because we only track counts in workspaceSessionCounts for successfully resolved workspaces.
						// The presence of this workspace in unresolvedWorkspaceIds means we encountered session files for it,
						// but couldn't resolve its folder path, so we couldn't increment a count in workspaceSessionCounts.
						sessionCount: 0,
						interactionCount: unresolvedWorkspaceInteractionCounts.get(workspaceId) || 0,
						typeStatuses
					});
				}

				matrixRows.sort((a, b) => {
					if (b.interactionCount !== a.interactionCount) {
						return b.interactionCount - a.interactionCount;
					}
					return b.sessionCount - a.sessionCount;
				});

				const customizationMatrix: WorkspaceCustomizationMatrix = {
					customizationTypes,
					workspaces: matrixRows,
					totalWorkspaces: matrixRows.length,
					workspacesWithIssues
				};

				this._lastCustomizationMatrix = customizationMatrix;
				
				// Calculate missed potential (workspaces with non-Copilot instruction files but no Copilot files)
				this._lastMissedPotential = this.detectMissedPotential(workspaceSessionCounts, workspaceInteractionCounts);
			} catch (e) {
				// ignore overall customization scanning errors
			}
		} catch (error) {
			this.error('Error calculating usage analysis stats:', error);
		}

		// Log cache statistics
		this.log(`🔍 [Usage Analysis] Cache stats: ${this._cacheHits} hits, ${this._cacheMisses} misses`);

		const stats: UsageAnalysisStats = {
			today: todayStats,
			last30Days: last30DaysStats,
			month: monthStats,
			locale: Intl.DateTimeFormat().resolvedOptions().locale,
			lastUpdated: now,
			customizationMatrix: this._lastCustomizationMatrix,
			missedPotential: this._lastMissedPotential || []
		};

		// Cache the result for future use
		this.lastUsageAnalysisStats = stats;

		return stats;
	}

	/**
	 * Merge usage analysis data into period stats
	 */
	private mergeUsageAnalysis(period: UsageAnalysisPeriod, analysis: SessionUsageAnalysis): void {
		// Merge tool calls
		period.toolCalls.total += analysis.toolCalls.total;
		for (const [tool, count] of Object.entries(analysis.toolCalls.byTool)) {
			period.toolCalls.byTool[tool] = (period.toolCalls.byTool[tool] || 0) + count;
		}

		// Merge mode usage
		period.modeUsage.ask += analysis.modeUsage.ask;
		period.modeUsage.edit += analysis.modeUsage.edit;
		period.modeUsage.agent += analysis.modeUsage.agent;
		period.modeUsage.plan += analysis.modeUsage.plan;
		period.modeUsage.customAgent += analysis.modeUsage.customAgent;

		// Merge context references
		period.contextReferences.file += analysis.contextReferences.file;
		period.contextReferences.selection += analysis.contextReferences.selection;
		period.contextReferences.implicitSelection += analysis.contextReferences.implicitSelection || 0;
		period.contextReferences.symbol += analysis.contextReferences.symbol;
		period.contextReferences.codebase += analysis.contextReferences.codebase;
		period.contextReferences.workspace += analysis.contextReferences.workspace;
		period.contextReferences.terminal += analysis.contextReferences.terminal;
		period.contextReferences.vscode += analysis.contextReferences.vscode;
		period.contextReferences.terminalLastCommand += analysis.contextReferences.terminalLastCommand || 0;
		period.contextReferences.terminalSelection += analysis.contextReferences.terminalSelection || 0;
		period.contextReferences.clipboard += analysis.contextReferences.clipboard || 0;
		period.contextReferences.changes += analysis.contextReferences.changes || 0;
		period.contextReferences.outputPanel += analysis.contextReferences.outputPanel || 0;
		period.contextReferences.problemsPanel += analysis.contextReferences.problemsPanel || 0;

		// Merge contentReferences counts
		period.contextReferences.copilotInstructions += analysis.contextReferences.copilotInstructions || 0;
		period.contextReferences.agentsMd += analysis.contextReferences.agentsMd || 0;

		// Merge byKind tracking
		for (const [kind, count] of Object.entries(analysis.contextReferences.byKind || {})) {
			period.contextReferences.byKind[kind] = (period.contextReferences.byKind[kind] || 0) + count;
		}

		// Merge byPath tracking
		for (const [path, count] of Object.entries(analysis.contextReferences.byPath || {})) {
			period.contextReferences.byPath[path] = (period.contextReferences.byPath[path] || 0) + count;
		}

		// Merge MCP tools
		period.mcpTools.total += analysis.mcpTools.total;
		for (const [server, count] of Object.entries(analysis.mcpTools.byServer)) {
			period.mcpTools.byServer[server] = (period.mcpTools.byServer[server] || 0) + count;
		}
		for (const [tool, count] of Object.entries(analysis.mcpTools.byTool)) {
			period.mcpTools.byTool[tool] = (period.mcpTools.byTool[tool] || 0) + count;
		}

		// Merge model switching data
		// Ensure modelSwitching exists (backward compatibility with old cache)
		if (!analysis.modelSwitching) {
			analysis.modelSwitching = {
				uniqueModels: [],
				modelCount: 0,
				switchCount: 0,
				tiers: { standard: [], premium: [], unknown: [] },
				hasMixedTiers: false,
				standardRequests: 0,
				premiumRequests: 0,
				unknownRequests: 0,
				totalRequests: 0
			};
		}

		// Only count sessions with at least 1 model detected for model switching stats
		// Sessions without detected models (modelCount === 0) should not affect the average
		if (analysis.modelSwitching.modelCount > 0) {
			period.modelSwitching.totalSessions++;
			period.modelSwitching.modelsPerSession.push(analysis.modelSwitching.modelCount);

			// Track unique models by tier
			for (const model of analysis.modelSwitching.tiers.standard) {
				if (!period.modelSwitching.standardModels.includes(model)) {
					period.modelSwitching.standardModels.push(model);
				}
			}
			for (const model of analysis.modelSwitching.tiers.premium) {
				if (!period.modelSwitching.premiumModels.includes(model)) {
					period.modelSwitching.premiumModels.push(model);
				}
			}
			for (const model of analysis.modelSwitching.tiers.unknown) {
				if (!period.modelSwitching.unknownModels.includes(model)) {
					period.modelSwitching.unknownModels.push(model);
				}
			}

			// Count sessions with mixed tiers
			if (analysis.modelSwitching.hasMixedTiers) {
				period.modelSwitching.mixedTierSessions++;
			}

			// Aggregate request counts per tier
			period.modelSwitching.standardRequests += analysis.modelSwitching.standardRequests || 0;
			period.modelSwitching.premiumRequests += analysis.modelSwitching.premiumRequests || 0;
			period.modelSwitching.unknownRequests += analysis.modelSwitching.unknownRequests || 0;
			period.modelSwitching.totalRequests += analysis.modelSwitching.totalRequests || 0;

			// Calculate aggregate statistics
			if (period.modelSwitching.modelsPerSession.length > 0) {
				const counts = period.modelSwitching.modelsPerSession;
				period.modelSwitching.averageModelsPerSession = counts.reduce((a, b) => a + b, 0) / counts.length;
				period.modelSwitching.maxModelsPerSession = Math.max(...counts);
				period.modelSwitching.minModelsPerSession = Math.min(...counts);
				period.modelSwitching.switchingFrequency = (counts.filter(c => c > 1).length / counts.length) * 100;
			}
		}
		
		// Merge new enhanced metrics
		if (analysis.editScope) {
			period.editScope.singleFileEdits += analysis.editScope.singleFileEdits;
			period.editScope.multiFileEdits += analysis.editScope.multiFileEdits;
			period.editScope.totalEditedFiles += analysis.editScope.totalEditedFiles;
			// Recalculate average
			const editSessions = period.editScope.singleFileEdits + period.editScope.multiFileEdits;
			period.editScope.avgFilesPerSession = editSessions > 0 
				? period.editScope.totalEditedFiles / editSessions 
				: 0;
		}
		
		if (analysis.applyUsage) {
			period.applyUsage.totalApplies += analysis.applyUsage.totalApplies;
			period.applyUsage.totalCodeBlocks += analysis.applyUsage.totalCodeBlocks;
			// Recalculate apply rate
			period.applyUsage.applyRate = period.applyUsage.totalCodeBlocks > 0
				? (period.applyUsage.totalApplies / period.applyUsage.totalCodeBlocks) * 100
				: 0;
		}
		
		if (analysis.sessionDuration) {
			period.sessionDuration.totalDurationMs += analysis.sessionDuration.totalDurationMs;
			// Calculate avgDurationMs as total / sessionCount
			const sessionCount = period.sessions;
			if (sessionCount > 0) {
				period.sessionDuration.avgDurationMs = period.sessionDuration.totalDurationMs / sessionCount;
				
				// For other timing metrics, use weighted averaging (approximation across per-session averages)
				const prevAvgFirstProgress = period.sessionDuration.avgFirstProgressMs * (sessionCount - 1);
				period.sessionDuration.avgFirstProgressMs = (prevAvgFirstProgress + analysis.sessionDuration.avgFirstProgressMs) / sessionCount;
				
				const prevAvgTotalElapsed = period.sessionDuration.avgTotalElapsedMs * (sessionCount - 1);
				period.sessionDuration.avgTotalElapsedMs = (prevAvgTotalElapsed + analysis.sessionDuration.avgTotalElapsedMs) / sessionCount;
				
				const prevAvgWaitTime = period.sessionDuration.avgWaitTimeMs * (sessionCount - 1);
				period.sessionDuration.avgWaitTimeMs = (prevAvgWaitTime + analysis.sessionDuration.avgWaitTimeMs) / sessionCount;
			}
		}
		
		if (analysis.conversationPatterns) {
			period.conversationPatterns.multiTurnSessions += analysis.conversationPatterns.multiTurnSessions;
			period.conversationPatterns.singleTurnSessions += analysis.conversationPatterns.singleTurnSessions;
			period.conversationPatterns.maxTurnsInSession = Math.max(
				period.conversationPatterns.maxTurnsInSession,
				analysis.conversationPatterns.maxTurnsInSession
			);
			// Calculate average turns by summing total turns across all sessions
			const totalSessions = period.conversationPatterns.multiTurnSessions + period.conversationPatterns.singleTurnSessions;
			if (totalSessions > 0) {
				// Reconstruct previous total turns from previous average
				const prevTotalTurns = period.conversationPatterns.avgTurnsPerSession * (totalSessions - 1);
				// Add current session's turn count (which is stored in avgTurnsPerSession for single session)
				const newTotalTurns = prevTotalTurns + analysis.conversationPatterns.avgTurnsPerSession;
				// Calculate true average
				period.conversationPatterns.avgTurnsPerSession = newTotalTurns / totalSessions;
			}
		}
		
		if (analysis.agentTypes) {
			period.agentTypes.editsAgent += analysis.agentTypes.editsAgent;
			period.agentTypes.defaultAgent += analysis.agentTypes.defaultAgent;
			period.agentTypes.workspaceAgent += analysis.agentTypes.workspaceAgent;
			period.agentTypes.other += analysis.agentTypes.other;
		}
	}

	private async countInteractionsInSession(sessionFile: string): Promise<number> {
		try {
			// Handle OpenCode sessions
			if (this.isOpenCodeSessionFile(sessionFile)) {
				return await this.countOpenCodeInteractions(sessionFile);
			}

			const fileContent = await fs.promises.readFile(sessionFile, 'utf8');

			// Check if this is a UUID-only file (new Copilot CLI format)
			if (this.isUuidPointerFile(fileContent)) {
				return 0; // No interactions to count in pointer files
			}

			// Handle .jsonl files OR .json files with JSONL content (Copilot CLI format and VS Code incremental format)
			const isJsonlContent = sessionFile.endsWith('.jsonl') || this.isJsonlContent(fileContent);
			if (isJsonlContent) {
				const lines = fileContent.trim().split('\n');
				let interactions = 0;
				for (const line of lines) {
					if (!line.trim()) { continue; }
					try {
						const event = JSON.parse(line);
						// Handle Copilot CLI format
						if (event.type === 'user.message') {
							interactions++;
						}
						// Handle VS Code incremental format (kind: 2 with requests array)
						if (event.kind === 2 && event.k?.[0] === 'requests' && Array.isArray(event.v)) {
							for (const request of event.v) {
								if (request.requestId) {
									interactions++;
								}
							}
						}
					} catch (e) {
						// Skip malformed lines
					}
				}
				return interactions;
			}

			// Handle regular .json files
			const sessionContent = JSON.parse(fileContent);

			// Count the number of requests as interactions
			if (sessionContent.requests && Array.isArray(sessionContent.requests)) {
				// Each request in the array represents one user interaction
				return sessionContent.requests.length;
			}

			return 0;
		} catch (error) {
			this.warn(`Error counting interactions in ${sessionFile}: ${error}`);
			return 0;
		}
	}

	private async getModelUsageFromSession(sessionFile: string): Promise<ModelUsage> {
		const modelUsage: ModelUsage = {};

		// Handle OpenCode sessions
		if (this.isOpenCodeSessionFile(sessionFile)) {
			return await this.getOpenCodeModelUsage(sessionFile);
		}

		const fileName = sessionFile.split(/[/\\]/).pop() || sessionFile;

		try {
			const fileContent = await fs.promises.readFile(sessionFile, 'utf8');

			// Check if this is a UUID-only file (new Copilot CLI format)
			if (this.isUuidPointerFile(fileContent)) {
				return modelUsage; // Empty model usage for pointer files
			}

			// Detect JSONL content: either by extension or by content analysis
			const isJsonlContent = sessionFile.endsWith('.jsonl') || this.isJsonlContent(fileContent);

			// Handle .jsonl files OR .json files with JSONL content (Copilot CLI format and VS Code incremental format)
			if (isJsonlContent) {
				const lines = fileContent.trim().split('\n');
				// Default model for CLI sessions - they may not specify the model per event
				let defaultModel = 'gpt-4o';

				// For delta-based formats, reconstruct state to extract actual usage
				let sessionState: any = {};
				let isDeltaBased = false;

				for (const line of lines) {
					if (!line.trim()) { continue; }
					try {
						const event = JSON.parse(line);

						// Detect and reconstruct delta-based format
						if (typeof event.kind === 'number') {
							isDeltaBased = true;
							sessionState = this.applyDelta(sessionState, event);
						}

						// Handle VS Code incremental format - extract model from session header (kind: 0)
						// The schema has v.selectedModel.identifier or v.selectedModel.metadata.id
						if (event.kind === 0) {
							const modelId = event.v?.selectedModel?.identifier ||
								event.v?.selectedModel?.metadata?.id ||
								// Legacy fallback: older Copilot Chat session logs stored selectedModel under v.inputState.
								// This is kept for backward compatibility so we can still read existing logs from those versions.
								event.v?.inputState?.selectedModel?.metadata?.id;
							if (modelId) {
								defaultModel = modelId.replace(/^copilot\//, '');
							}
						}

						// Handle model changes (kind: 2 with selectedModel update, NOT kind: 1 which is delete)
						if (event.kind === 2 && event.k?.[0] === 'selectedModel') {
							const modelId = event.v?.identifier || event.v?.metadata?.id;
							if (modelId) {
								defaultModel = modelId.replace(/^copilot\//, '');
							}
						}

						const model = event.model || defaultModel;

						if (!modelUsage[model]) {
							modelUsage[model] = { inputTokens: 0, outputTokens: 0 };
						}

						// For non-delta formats, estimate from event text (CLI format)
						if (!isDeltaBased) {
							// Handle Copilot CLI format
							if (event.type === 'user.message' && event.data?.content) {
								modelUsage[model].inputTokens += this.estimateTokensFromText(event.data.content, model);
							} else if (event.type === 'assistant.message' && event.data?.content) {
								modelUsage[model].outputTokens += this.estimateTokensFromText(event.data.content, model);
							} else if (event.type === 'tool.result' && event.data?.output) {
								// Tool outputs are typically input context
								modelUsage[model].inputTokens += this.estimateTokensFromText(event.data.output, model);
							}
						}
					} catch (e) {
						// Skip malformed lines
					}
				}

				// For delta-based formats, extract actual usage from reconstructed state
				if (isDeltaBased && sessionState.requests && Array.isArray(sessionState.requests)) {
					for (const request of sessionState.requests) {
						if (!request || !request.requestId) { continue; }

						// Extract request-level modelId
						let requestModel = defaultModel;
						if (request.modelId) {
							requestModel = request.modelId.replace(/^copilot\//, '');
						} else if (request.result?.metadata?.modelId) {
							requestModel = request.result.metadata.modelId.replace(/^copilot\//, '');
						} else if (request.result?.details) {
							requestModel = this.getModelFromRequest(request);
						}

						if (!modelUsage[requestModel]) {
							modelUsage[requestModel] = { inputTokens: 0, outputTokens: 0 };
						}

						// Use actual usage if available, otherwise estimate from text
						if (request.result?.usage) {
							const u = request.result.usage;
							modelUsage[requestModel].inputTokens += typeof u.promptTokens === 'number' ? u.promptTokens : 0;
							modelUsage[requestModel].outputTokens += typeof u.completionTokens === 'number' ? u.completionTokens : 0;
						} else {
							// Fallback to text-based estimation
							if (request.message?.text) {
								modelUsage[requestModel].inputTokens += this.estimateTokensFromText(request.message.text, requestModel);
							}
							if (request.response && Array.isArray(request.response)) {
								for (const responseItem of request.response) {
									if (responseItem.value) {
										modelUsage[requestModel].outputTokens += this.estimateTokensFromText(responseItem.value, requestModel);
									}
								}
							}
						}
					}
				}

				return modelUsage;
			}

			// Handle regular .json files
			const sessionContent = JSON.parse(fileContent);

			if (sessionContent.requests && Array.isArray(sessionContent.requests)) {
				for (const request of sessionContent.requests) {
					// Get model for this request
					const model = this.getModelFromRequest(request);

					// Initialize model if not exists
					if (!modelUsage[model]) {
						modelUsage[model] = { inputTokens: 0, outputTokens: 0 };
					}

					// Use actual usage if available, otherwise estimate from text
					if (request.result?.usage) {
						const u = request.result.usage;
						modelUsage[model].inputTokens += typeof u.promptTokens === 'number' ? u.promptTokens : 0;
						modelUsage[model].outputTokens += typeof u.completionTokens === 'number' ? u.completionTokens : 0;
					} else {
						// Fallback to text-based estimation
						// Estimate tokens from user message (input)
						if (request.message && request.message.parts) {
							for (const part of request.message.parts) {
								if (part.text) {
									const tokens = this.estimateTokensFromText(part.text, model);
									modelUsage[model].inputTokens += tokens;
								}
							}
						}

						// Estimate tokens from assistant response (output)
						if (request.response && Array.isArray(request.response)) {
							for (const responseItem of request.response) {
								if (responseItem.value) {
									const tokens = this.estimateTokensFromText(responseItem.value, model);
									modelUsage[model].outputTokens += tokens;
								}
							}
						}
					}
				}
			}
		} catch (error) {
			this.warn(`Error getting model usage from ${sessionFile}: ${error}`);
		}

		return modelUsage;
	}

	/**
	 * Analyze a session file for usage patterns (tool calls, modes, context references, MCP tools)
	 */
	private async analyzeSessionUsage(sessionFile: string): Promise<SessionUsageAnalysis> {
		const analysis: SessionUsageAnalysis = {
			toolCalls: { total: 0, byTool: {} },
			modeUsage: { ask: 0, edit: 0, agent: 0, plan: 0, customAgent: 0 },
			contextReferences: {
				file: 0,
				selection: 0,
				implicitSelection: 0,
				symbol: 0,
				codebase: 0,
				workspace: 0,
				terminal: 0,
				vscode: 0,
				terminalLastCommand: 0,
				terminalSelection: 0,
				clipboard: 0,
				changes: 0,
				outputPanel: 0,
				problemsPanel: 0,
				byKind: {},
				copilotInstructions: 0,
				agentsMd: 0,
				byPath: {}
			},
			mcpTools: { total: 0, byServer: {}, byTool: {} },
			modelSwitching: {
				uniqueModels: [],
				modelCount: 0,
				switchCount: 0,
				tiers: { standard: [], premium: [], unknown: [] },
				hasMixedTiers: false,
				standardRequests: 0,
				premiumRequests: 0,
				unknownRequests: 0,
				totalRequests: 0
			}
		};

		try {
			// Handle OpenCode sessions
			if (this.isOpenCodeSessionFile(sessionFile)) {
				const messages = await this.getOpenCodeMessagesForSession(sessionFile);
				if (messages.length > 0) {
					const models: string[] = [];
					for (const msg of messages) {
						if (msg.role === 'user') {
							// OpenCode uses agent/mode field for mode type
							const mode = msg.agent || 'agent';
							if (mode === 'build' || mode === 'agent') {
								analysis.modeUsage.agent++;
							} else if (mode === 'ask') {
								analysis.modeUsage.ask++;
							} else if (mode === 'edit') {
								analysis.modeUsage.edit++;
							} else {
								analysis.modeUsage.agent++;
							}
						}
						if (msg.role === 'assistant') {
							const model = msg.modelID || 'unknown';
							models.push(model);
							// Check parts for tool calls
							const parts = await this.getOpenCodePartsForMessage(msg.id);
							for (const part of parts) {
								if (part.type === 'tool' && part.tool) {
									analysis.toolCalls.total++;
									const toolName = part.tool;
									analysis.toolCalls.byTool[toolName] = (analysis.toolCalls.byTool[toolName] || 0) + 1;
								}
							}
						}
					}
					// Model switching analysis
					const uniqueModels = [...new Set(models)];
					analysis.modelSwitching.uniqueModels = uniqueModels;
					analysis.modelSwitching.modelCount = uniqueModels.length;
					analysis.modelSwitching.totalRequests = models.length;
					let switchCount = 0;
					for (let i = 1; i < models.length; i++) {
						if (models[i] !== models[i - 1]) { switchCount++; }
					}
					analysis.modelSwitching.switchCount = switchCount;
				}
				return analysis;
			}

			const fileContent = await fs.promises.readFile(sessionFile, 'utf8');

			// Handle .jsonl files OR .json files with JSONL content (Copilot CLI format and VS Code incremental format)
			const isJsonlContent = sessionFile.endsWith('.jsonl') || this.isJsonlContent(fileContent);
			if (isJsonlContent) {
				const lines = fileContent.trim().split('\n').filter(l => l.trim());

				// Detect if this is delta-based format (VS Code incremental)
				let isDeltaBased = false;
				if (lines.length > 0) {
					try {
						const firstLine = JSON.parse(lines[0]);
						if (firstLine && typeof firstLine.kind === 'number') {
							isDeltaBased = true;
						}
					} catch {
						// Not delta format
					}
				}

				if (isDeltaBased) {
					// Delta-based format: reconstruct full state first, then process
					let sessionState: any = {};
					for (const line of lines) {
						try {
							const delta = JSON.parse(line);
							sessionState = this.applyDelta(sessionState, delta);
						} catch {
							// Skip invalid lines
						}
					}

					// Extract session mode from reconstructed state
					const sessionModeType = sessionState.inputState?.mode 
						? this.getModeType(sessionState.inputState.mode)
						: 'ask';

					// Detect implicit selections
					if (sessionState.inputState?.selections && Array.isArray(sessionState.inputState.selections)) {
						for (const sel of sessionState.inputState.selections) {
							if (sel && (sel.startLineNumber !== sel.endLineNumber || sel.startColumn !== sel.endColumn)) {
								analysis.contextReferences.implicitSelection++;
								break;
							}
						}
					}

					// Process reconstructed requests array
					const requests = sessionState.requests || [];
					for (const request of requests) {
						if (!request || !request.requestId) { continue; }

						// Count by mode type
						if (sessionModeType === 'agent') {
							analysis.modeUsage.agent++;
						} else if (sessionModeType === 'edit') {
							analysis.modeUsage.edit++;
						} else if (sessionModeType === 'plan') {
							analysis.modeUsage.plan++;
						} else if (sessionModeType === 'customAgent') {
							analysis.modeUsage.customAgent++;
						} else {
							analysis.modeUsage.ask++;
						}

						// Check for agent in request
						if (request.agent?.id) {
							const toolName = request.agent.id;
							analysis.toolCalls.total++;
							analysis.toolCalls.byTool[toolName] = (analysis.toolCalls.byTool[toolName] || 0) + 1;
						}

						// Analyze all context references from this request
						this.analyzeRequestContext(request, analysis.contextReferences);

						// Extract tool calls and MCP tools from request.response array
						if (request.response && Array.isArray(request.response)) {
							for (const responseItem of request.response) {
								if (responseItem.kind === 'toolInvocationSerialized' || responseItem.kind === 'prepareToolInvocation') {
									const toolName = responseItem.toolId || responseItem.toolName || responseItem.invocationMessage?.toolName || responseItem.toolSpecificData?.kind || 'unknown';

									// Check if this is an MCP tool by name pattern
									if (this.isMcpTool(toolName)) {
										analysis.mcpTools.total++;
										const serverName = this.extractMcpServerName(toolName);
										analysis.mcpTools.byServer[serverName] = (analysis.mcpTools.byServer[serverName] || 0) + 1;
										const normalizedTool = this.normalizeMcpToolName(toolName);
										analysis.mcpTools.byTool[normalizedTool] = (analysis.mcpTools.byTool[normalizedTool] || 0) + 1;
									} else {
										analysis.toolCalls.total++;
										analysis.toolCalls.byTool[toolName] = (analysis.toolCalls.byTool[toolName] || 0) + 1;
									}
								}
							}
						}
					}

					// Calculate model switching for delta-based JSONL files
					await this.calculateModelSwitching(sessionFile, analysis);

					// Derive conversation patterns from mode usage before returning
					this.deriveConversationPatterns(analysis);

					return analysis;
				}

				// Non-delta JSONL (Copilot CLI format) - process line-by-line
				let sessionMode = 'ask';
				for (const line of lines) {
					if (!line.trim()) { continue; }
					try {
						const event = JSON.parse(line);

						// Handle VS Code incremental format - detect mode from session header
						if (event.kind === 0 && event.v?.inputState?.mode) {
							sessionMode = this.getModeType(event.v.inputState.mode);

							// Detect implicit selections in initial state (only if there's an actual range)
							if (event.v?.inputState?.selections && Array.isArray(event.v.inputState.selections)) {
								for (const sel of event.v.inputState.selections) {
									// Only count if it's an actual selection (not just a cursor position)
									if (sel.startLineNumber !== sel.endLineNumber || sel.startColumn !== sel.endColumn) {
										analysis.contextReferences.implicitSelection++;
										break; // Count once per session
									}
								}
							}
						}

						// Handle mode changes (kind: 1 with mode update)
						if (event.kind === 1 && event.k?.includes('mode') && event.v) {
							sessionMode = this.getModeType(event.v);
						}

						// Detect implicit selections in updates to inputState.selections
						if (event.kind === 1 && event.k?.includes('selections') && Array.isArray(event.v)) {
							for (const sel of event.v) {
								// Only count if it's an actual selection (not just a cursor position)
								if (sel && (sel.startLineNumber !== sel.endLineNumber || sel.startColumn !== sel.endColumn)) {
									analysis.contextReferences.implicitSelection++;
									break; // Count once per update
								}
							}
						}

						// Handle contentReferences updates (kind: 1 with contentReferences update)
						if (event.kind === 1 && event.k?.includes('contentReferences') && Array.isArray(event.v)) {
							this.analyzeContentReferences(event.v, analysis.contextReferences);
						}

						// Handle variableData updates (kind: 1 with variableData update)
						if (event.kind === 1 && event.k?.includes('variableData') && event.v) {
							this.analyzeVariableData(event.v, analysis.contextReferences);
						}

						// Handle VS Code incremental format - count requests as interactions
						if (event.kind === 2 && event.k?.[0] === 'requests' && Array.isArray(event.v)) {
							for (const request of event.v) {
								if (request.requestId) {
									// Count by mode type
									if (sessionMode === 'agent') {
										analysis.modeUsage.agent++;
									} else if (sessionMode === 'edit') {
										analysis.modeUsage.edit++;
									} else if (sessionMode === 'plan') {
										analysis.modeUsage.plan++;
									} else if (sessionMode === 'customAgent') {
										analysis.modeUsage.customAgent++;
									} else {
										analysis.modeUsage.ask++;
									}
								}
								// Check for agent in request
								if (request.agent?.id) {
									const toolName = request.agent.id;
									analysis.toolCalls.total++;
									analysis.toolCalls.byTool[toolName] = (analysis.toolCalls.byTool[toolName] || 0) + 1;
								}

								// Analyze all context references from this request
								this.analyzeRequestContext(request, analysis.contextReferences);

								// Extract tool calls from request.response array (when full request is added)
								if (request.response && Array.isArray(request.response)) {
									for (const responseItem of request.response) {
										if (responseItem.kind === 'toolInvocationSerialized' || responseItem.kind === 'prepareToolInvocation') {
											analysis.toolCalls.total++;
											const toolName = responseItem.toolId || responseItem.toolName || responseItem.invocationMessage?.toolName || responseItem.toolSpecificData?.kind || 'unknown';
											analysis.toolCalls.byTool[toolName] = (analysis.toolCalls.byTool[toolName] || 0) + 1;
										}
									}
								}
							}
						}

						// Handle VS Code incremental format - tool invocations in responses
						if (event.kind === 2 && event.k?.includes('response') && Array.isArray(event.v)) {
							for (const responseItem of event.v) {
								if (responseItem.kind === 'toolInvocationSerialized') {
									analysis.toolCalls.total++;
									const toolName = responseItem.toolId || responseItem.toolName || responseItem.invocationMessage?.toolName || responseItem.toolSpecificData?.kind || 'unknown';
									analysis.toolCalls.byTool[toolName] = (analysis.toolCalls.byTool[toolName] || 0) + 1;
								}
							}
						}

						// Handle Copilot CLI format
						// Detect mode from event type - CLI can be chat or agent mode
						if (event.type === 'user.message') {
							analysis.modeUsage.ask++;
						}

						// If we see tool calls, upgrade to agent mode for this session
						if (event.type === 'tool.call' || event.type === 'tool.result') {
							// Tool usage indicates agent mode - adjust if we counted this as ask
							if (analysis.modeUsage.ask > 0) {
								analysis.modeUsage.ask--;
								analysis.modeUsage.agent++;
							}
						}

						// Detect tool calls from Copilot CLI
						if (event.type === 'tool.call' || event.type === 'tool.result') {
							const toolName = event.data?.toolName || event.toolName || 'unknown';

							// Check if this is an MCP tool by name pattern
							if (this.isMcpTool(toolName)) {
								// Count as MCP tool
								analysis.mcpTools.total++;
								const serverName = this.extractMcpServerName(toolName);
								analysis.mcpTools.byServer[serverName] = (analysis.mcpTools.byServer[serverName] || 0) + 1;
								const normalizedTool = this.normalizeMcpToolName(toolName);
								analysis.mcpTools.byTool[normalizedTool] = (analysis.mcpTools.byTool[normalizedTool] || 0) + 1;
							} else {
								// Count as regular tool call
								analysis.toolCalls.total++;
								analysis.toolCalls.byTool[toolName] = (analysis.toolCalls.byTool[toolName] || 0) + 1;
							}
						}

						// Detect MCP tools from explicit MCP events
						if (event.type === 'mcp.tool.call' || (event.data?.mcpServer)) {
							analysis.mcpTools.total++;
							const serverName = event.data?.mcpServer || 'unknown';
							const mcpToolName = event.data?.toolName || event.toolName || 'unknown';
							analysis.mcpTools.byServer[serverName] = (analysis.mcpTools.byServer[serverName] || 0) + 1;
							const normalizedMcpTool = this.normalizeMcpToolName(mcpToolName);
							analysis.mcpTools.byTool[normalizedMcpTool] = (analysis.mcpTools.byTool[normalizedMcpTool] || 0) + 1;
						}
					} catch (e) {
						// Skip malformed lines
					}
				}
				// Calculate model switching for JSONL files before returning
				await this.calculateModelSwitching(sessionFile, analysis);

				// Derive conversation patterns from mode usage before returning
				this.deriveConversationPatterns(analysis);

				return analysis;
			}

			// Handle regular .json files
			const sessionContent = JSON.parse(fileContent);

			// Detect session mode and count interactions per request
			if (sessionContent.requests && Array.isArray(sessionContent.requests)) {
				for (const request of sessionContent.requests) {
					// Determine mode for each individual request
					let requestMode = 'ask'; // default

					// Check request-level agent ID first (more specific)
					if (request.agent?.id) {
						const agentId = request.agent.id.toLowerCase();
						if (agentId.includes('edit')) {
							requestMode = 'edit';
						} else if (agentId.includes('agent')) {
							requestMode = 'agent';
						}
					}
					// Fall back to session-level mode if no request-specific agent
					else if (sessionContent.mode?.id) {
						const modeId = sessionContent.mode.id.toLowerCase();
						if (modeId.includes('agent')) {
							requestMode = 'agent';
						} else if (modeId.includes('edit')) {
							requestMode = 'edit';
						}
					}

					// Count this request in the appropriate mode
					if (requestMode === 'agent') {
						analysis.modeUsage.agent++;
					} else if (requestMode === 'edit') {
						analysis.modeUsage.edit++;
					} else {
						analysis.modeUsage.ask++;
					}

					// Analyze all context references from this request
					this.analyzeRequestContext(request, analysis.contextReferences);

					// Analyze response for tool calls and MCP tools
					if (request.response && Array.isArray(request.response)) {
						for (const responseItem of request.response) {
							// Detect tool invocations
							if (responseItem.kind === 'toolInvocationSerialized' ||
								responseItem.kind === 'prepareToolInvocation') {
								const toolName = responseItem.toolId ||
									responseItem.toolName ||
									responseItem.invocationMessage?.toolName ||
									'unknown';

								// Check if this is an MCP tool by name pattern
								if (this.isMcpTool(toolName)) {
									// Count as MCP tool
									analysis.mcpTools.total++;
									const serverName = this.extractMcpServerName(toolName);
									analysis.mcpTools.byServer[serverName] = (analysis.mcpTools.byServer[serverName] || 0) + 1;
									const normalizedTool = this.normalizeMcpToolName(toolName);
									analysis.mcpTools.byTool[normalizedTool] = (analysis.mcpTools.byTool[normalizedTool] || 0) + 1;
								} else {
									// Count as regular tool call
									analysis.toolCalls.total++;
									analysis.toolCalls.byTool[toolName] = (analysis.toolCalls.byTool[toolName] || 0) + 1;
								}
							}

							// Detect MCP servers starting
							if (responseItem.kind === 'mcpServersStarting' && responseItem.didStartServerIds) {
								for (const serverId of responseItem.didStartServerIds) {
									analysis.mcpTools.total++;
									analysis.mcpTools.byServer[serverId] = (analysis.mcpTools.byServer[serverId] || 0) + 1;
								}
							}

							// Detect inline references in response items
							if (responseItem.kind === 'inlineReference' && responseItem.inlineReference) {
								// Treat response inlineReferences as contentReferences
								this.analyzeContentReferences([responseItem], analysis.contextReferences);
							}
						}
					}
				}
			}
		} catch (error) {
			this.warn(`Error analyzing session usage from ${sessionFile}: ${error}`);
		}

		// Calculate model switching statistics from session
		await this.calculateModelSwitching(sessionFile, analysis);

		// Track new metrics: edit scope, apply usage, session duration, conversation patterns, agent types
		await this.trackEnhancedMetrics(sessionFile, analysis);

		return analysis;
	}

	/**
	 * Calculate model switching statistics for a session file.
	 * This method updates the analysis.modelSwitching field in place.
	 */
	private async calculateModelSwitching(sessionFile: string, analysis: SessionUsageAnalysis): Promise<void> {
		try {
			// Use non-cached method to avoid circular dependency
			// (getSessionFileDataCached -> analyzeSessionUsage -> getModelUsageFromSessionCached -> getSessionFileDataCached)
			const modelUsage = await this.getModelUsageFromSession(sessionFile);
			const modelCount = modelUsage ? Object.keys(modelUsage).length : 0;

			// Skip if modelUsage is undefined or empty (not a valid session file)
			if (!modelUsage || modelCount === 0) {
				return;
			}

			// Get unique models from this session
			const uniqueModels = Object.keys(modelUsage);
			analysis.modelSwitching.uniqueModels = uniqueModels;
			analysis.modelSwitching.modelCount = uniqueModels.length;

			// Classify models by tier
			const standardModels: string[] = [];
			const premiumModels: string[] = [];
			const unknownModels: string[] = [];

			for (const model of uniqueModels) {
				const tier = this.getModelTier(model);
				if (tier === 'standard') {
					standardModels.push(model);
				} else if (tier === 'premium') {
					premiumModels.push(model);
				} else {
					unknownModels.push(model);
				}
			}

			analysis.modelSwitching.tiers = { standard: standardModels, premium: premiumModels, unknown: unknownModels };
			analysis.modelSwitching.hasMixedTiers = standardModels.length > 0 && premiumModels.length > 0;

			// Count requests per tier and model switches by examining request sequence
			const fileContent = await fs.promises.readFile(sessionFile, 'utf8');
			// Check if this is a UUID-only file (new Copilot CLI format)
			if (this.isUuidPointerFile(fileContent)) {
				return;
			}
			const isJsonlContent = sessionFile.endsWith('.jsonl') || this.isJsonlContent(fileContent);
			if (!isJsonlContent) {
				const sessionContent = JSON.parse(fileContent);
				if (sessionContent.requests && Array.isArray(sessionContent.requests)) {
					let previousModel: string | null = null;
					let switchCount = 0;
					const tierCounts = { standard: 0, premium: 0, unknown: 0 };

					for (const request of sessionContent.requests) {
						const currentModel = this.getModelFromRequest(request);
						
						// Count model switches
						if (previousModel && currentModel !== previousModel) {
							switchCount++;
						}
						previousModel = currentModel;

						// Count requests per tier
						const tier = this.getModelTier(currentModel);
						if (tier === 'standard') {
							tierCounts.standard++;
						} else if (tier === 'premium') {
							tierCounts.premium++;
						} else {
							tierCounts.unknown++;
						}
					}

					analysis.modelSwitching.switchCount = switchCount;
					analysis.modelSwitching.standardRequests = tierCounts.standard;
					analysis.modelSwitching.premiumRequests = tierCounts.premium;
					analysis.modelSwitching.unknownRequests = tierCounts.unknown;
					analysis.modelSwitching.totalRequests = tierCounts.standard + tierCounts.premium + tierCounts.unknown;
				}
			} else {
				// For JSONL files, we need to count requests differently
				// Count user messages as requests (type === 'user.message' or kind: 2 with requests)
				const lines = fileContent.trim().split('\n');
				const tierCounts = { standard: 0, premium: 0, unknown: 0 };
				let defaultModel = 'gpt-4o';

				for (const line of lines) {
					if (!line.trim()) { continue; }
					try {
						const event = JSON.parse(line);

						// Track model changes
						if (event.kind === 0) {
							const modelId = event.v?.selectedModel?.identifier ||
								event.v?.selectedModel?.metadata?.id ||
								event.v?.inputState?.selectedModel?.metadata?.id;
							if (modelId) {
								defaultModel = modelId.replace(/^copilot\//, '');
							}
						}

						if (event.kind === 2 && event.k?.[0] === 'selectedModel') {
							const modelId = event.v?.identifier || event.v?.metadata?.id;
							if (modelId) {
								defaultModel = modelId.replace(/^copilot\//, '');
							}
						}

						// Count user messages (requests)
						if (event.type === 'user.message') {
							const model = event.model || defaultModel;
							const tier = this.getModelTier(model);
							if (tier === 'standard') {
								tierCounts.standard++;
							} else if (tier === 'premium') {
								tierCounts.premium++;
							} else {
								tierCounts.unknown++;
							}
						}

						// Count VS Code incremental format requests (kind: 2 with requests array)
						if (event.kind === 2 && event.k?.[0] === 'requests' && Array.isArray(event.v)) {
							for (const request of event.v) {
								let requestModel = defaultModel;
								if (request.modelId) {
									requestModel = request.modelId.replace(/^copilot\//, '');
								} else if (request.result?.metadata?.modelId) {
									requestModel = request.result.metadata.modelId.replace(/^copilot\//, '');
								} else if (request.result?.details) {
									requestModel = this.getModelFromRequest(request);
								}

								const tier = this.getModelTier(requestModel);
								if (tier === 'standard') {
									tierCounts.standard++;
								} else if (tier === 'premium') {
									tierCounts.premium++;
								} else {
									tierCounts.unknown++;
								}
							}
						}
					} catch (e) {
						// Skip malformed lines
					}
				}

				analysis.modelSwitching.standardRequests = tierCounts.standard;
				analysis.modelSwitching.premiumRequests = tierCounts.premium;
				analysis.modelSwitching.unknownRequests = tierCounts.unknown;
				analysis.modelSwitching.totalRequests = tierCounts.standard + tierCounts.premium + tierCounts.unknown;
			}
		} catch (error) {
			this.warn(`Error calculating model switching for ${sessionFile}: ${error}`);
		}
	}

	/**
	 * Check if a tool name indicates it's an MCP (Model Context Protocol) tool.
	 * MCP tools are identified by names starting with "mcp." or "mcp_"
	 */
	private isMcpTool(toolName: string): boolean {
		return toolName.startsWith('mcp.') || toolName.startsWith('mcp_');
	}

	/**
	 * Normalize an MCP tool name so that equivalent tools from different servers
	 * (local stdio vs remote) are counted under a single canonical key in "By Tool" views.
	 * Maps mcp_github_github_<action> → mcp_io_github_git_<action>.
	 */
	private normalizeMcpToolName(toolName: string): string {
		if (toolName.startsWith('mcp_github_github_')) {
			return 'mcp_io_github_git_' + toolName.substring('mcp_github_github_'.length);
		}
		if (toolName.startsWith('mcp.github.github.')) {
			return 'mcp.io.github.git.' + toolName.substring('mcp.github.github.'.length);
		}
		return toolName;
	}

	/**
	 * Extract server name from an MCP tool name.
	 * MCP tool names follow the format: mcp.server.tool or mcp_server_tool
	 * For example: "mcp.io.github.git.assign_copilot_to_issue" → "GitHub MCP"
	 * Uses the display name from toolNames.json (the part before the colon).
	 * Falls back to extracting the second segment if no mapping exists.
	 */
	private extractMcpServerName(toolName: string): string {
		// First, try to get the display name from toolNames.json and extract the server part
		const displayName = this.toolNameMap[toolName];
		if (displayName && displayName.includes(':')) {
			// Extract the part before the colon (e.g., "GitHub MCP" from "GitHub MCP: Issue Read")
			return displayName.split(':')[0].trim();
		}

		// Fallback: recognize known MCP server prefixes for unlisted tools
		if (toolName.startsWith('mcp_io_github_git_') || toolName.startsWith('mcp.io.github.git.')) {
			return 'GitHub MCP (Local)';
		}
		if (toolName.startsWith('mcp_github_github_') || toolName.startsWith('mcp.github.github.')) {
			return 'GitHub MCP (Remote)';
		}

		// Generic fallback: extract from tool name structure
		const withoutPrefix = toolName.replace(/^mcp[._]/, '');
		const parts = withoutPrefix.split(/[._]/);
		return parts[0] || 'unknown';
	}

	/**
	 * Derive conversation patterns from already-computed mode usage.
	 * Called before every return in analyzeSessionUsage to ensure all file formats get patterns.
	 */
	private deriveConversationPatterns(analysis: SessionUsageAnalysis): void {
		const totalRequests = analysis.modeUsage.ask + analysis.modeUsage.edit + analysis.modeUsage.agent;
		analysis.conversationPatterns = {
			multiTurnSessions: totalRequests > 1 ? 1 : 0,
			singleTurnSessions: totalRequests === 1 ? 1 : 0,
			avgTurnsPerSession: totalRequests,
			maxTurnsInSession: totalRequests
		};
	}

	/**
	 * Track enhanced metrics from session files:
	 * - Edit scope (single vs multi-file edits)
	 * - Apply button usage (codeblockUri with isEdit flag)
	 * - Session duration data
	 * - Conversation patterns (multi-turn sessions)
	 * - Agent type usage
	 */
	private async trackEnhancedMetrics(sessionFile: string, analysis: SessionUsageAnalysis): Promise<void> {
		try {
			const fileContent = await fs.promises.readFile(sessionFile, 'utf8');

			// Check if this is a UUID-only file (new Copilot CLI format)
			if (this.isUuidPointerFile(fileContent)) {
				return; // No metrics to track in pointer files
			}

			const isJsonlContent = sessionFile.endsWith('.jsonl') || this.isJsonlContent(fileContent);
			
			// Initialize tracking structures
			const editedFiles = new Set<string>();
			let totalApplies = 0;
			let totalCodeBlocks = 0;
			const timestamps: number[] = [];
			const timingsData: { firstProgress: number; totalElapsed: number; }[] = [];
			const waitTimes: number[] = [];
			const agentCounts = {
				editsAgent: 0,
				defaultAgent: 0,
				workspaceAgent: 0,
				other: 0
			};
			
			if (isJsonlContent) {
				// Handle delta-based JSONL format
				const lines = fileContent.trim().split('\n').filter(l => l.trim());
				let isDeltaBased = false;
				if (lines.length > 0) {
					try {
						const firstLine = JSON.parse(lines[0]);
						if (firstLine && typeof firstLine.kind === 'number') {
							isDeltaBased = true;
						}
					} catch {
						// Not delta format
					}
				}
				
				if (isDeltaBased) {
					// Reconstruct full state
					let sessionState: any = {};
					for (const line of lines) {
						try {
							const delta = JSON.parse(line);
							sessionState = this.applyDelta(sessionState, delta);
						} catch {
							// Skip invalid lines
						}
					}
					
					// Extract timestamps
					if (sessionState.creationDate) { timestamps.push(sessionState.creationDate); }
					if (sessionState.lastMessageDate) { timestamps.push(sessionState.lastMessageDate); }
					
					// Process requests
					const requests = sessionState.requests || [];
					
					for (const request of requests) {
						if (!request) { continue; }
						
						// Track timestamps
						if (request.timestamp) { timestamps.push(request.timestamp); }
						
						// Track timings
						if (request.result?.timings) {
							timingsData.push(request.result.timings);
						}
						
						// Track wait times
						if (request.timeSpentWaiting !== undefined) {
							waitTimes.push(request.timeSpentWaiting);
						}
						
						// Track agent types
						if (request.agent?.id) {
							const agentId = request.agent.id;
							if (agentId.includes('edit')) {
								agentCounts.editsAgent++;
							} else if (agentId.includes('default')) {
								agentCounts.defaultAgent++;
							} else if (agentId.includes('workspace')) {
								agentCounts.workspaceAgent++;
							} else {
								agentCounts.other++;
							}
						}
						
						// Track edit scope and apply usage
						if (request.response && Array.isArray(request.response)) {
							for (const resp of request.response) {
								if (resp.kind === 'textEditGroup' && resp.uri) {
									const filePath = resp.uri.path || JSON.stringify(resp.uri);
									editedFiles.add(filePath);
								}
								if (resp.kind === 'codeblockUri') {
									totalCodeBlocks++;
									if (resp.isEdit === true) {
										totalApplies++;
									}
								}
							}
						}
					}
				}
			} else {
				// Handle regular JSON files
				const sessionContent = JSON.parse(fileContent);
				
				// Extract timestamps
				if (sessionContent.creationDate) { timestamps.push(sessionContent.creationDate); }
				if (sessionContent.lastMessageDate) { timestamps.push(sessionContent.lastMessageDate); }
				
				// Process requests
				if (sessionContent.requests && Array.isArray(sessionContent.requests)) {
					for (const request of sessionContent.requests) {
						// Track timestamps
						if (request.timestamp) { timestamps.push(request.timestamp); }
						
						// Track timings
						if (request.result?.timings) {
							timingsData.push(request.result.timings);
						}
						
						// Track wait times
						if (request.timeSpentWaiting !== undefined) {
							waitTimes.push(request.timeSpentWaiting);
						}
						
						// Track agent types
						if (request.agent?.id) {
							const agentId = request.agent.id;
							if (agentId.includes('edit')) {
								agentCounts.editsAgent++;
							} else if (agentId.includes('default')) {
								agentCounts.defaultAgent++;
							} else if (agentId.includes('workspace')) {
								agentCounts.workspaceAgent++;
							} else {
								agentCounts.other++;
							}
						}
						
						// Track edit scope and apply usage
						if (request.response && Array.isArray(request.response)) {
							for (const resp of request.response) {
								if (resp.kind === 'textEditGroup' && resp.uri) {
									const filePath = resp.uri.path || JSON.stringify(resp.uri);
									editedFiles.add(filePath);
								}
								if (resp.kind === 'codeblockUri') {
									totalCodeBlocks++;
									if (resp.isEdit === true) {
										totalApplies++;
									}
								}
							}
						}
					}
				}
			}
			
			// Store edit scope data
			const editSessionCount = editedFiles.size > 0 ? 1 : 0;
			analysis.editScope = {
				singleFileEdits: editedFiles.size === 1 ? 1 : 0,
				multiFileEdits: editedFiles.size > 1 ? 1 : 0,
				totalEditedFiles: editedFiles.size,
				avgFilesPerSession: editSessionCount > 0 ? editedFiles.size / editSessionCount : 0
			};
			
			// Store apply button usage
			analysis.applyUsage = {
				totalApplies,
				totalCodeBlocks,
				applyRate: totalCodeBlocks > 0 ? (totalApplies / totalCodeBlocks) * 100 : 0
			};
			
			// Calculate session duration
			const totalDurationMs = timestamps.length >= 2 
				? Math.max(...timestamps) - Math.min(...timestamps)
				: 0;
			const avgFirstProgressMs = timingsData.length > 0
				? timingsData.reduce((sum, t) => sum + (t.firstProgress || 0), 0) / timingsData.length
				: 0;
			const avgTotalElapsedMs = timingsData.length > 0
				? timingsData.reduce((sum, t) => sum + (t.totalElapsed || 0), 0) / timingsData.length
				: 0;
			const avgWaitTimeMs = waitTimes.length > 0
				? waitTimes.reduce((sum, w) => sum + w, 0) / waitTimes.length
				: 0;
			
			analysis.sessionDuration = {
				totalDurationMs,
				avgDurationMs: totalDurationMs,
				avgFirstProgressMs,
				avgTotalElapsedMs,
				avgWaitTimeMs
			};
			
			// Store conversation patterns
			this.deriveConversationPatterns(analysis);
			
			// Store agent type usage
			analysis.agentTypes = agentCounts;
			
		} catch (error) {
			this.warn(`Error tracking enhanced metrics from ${sessionFile}: ${error}`);
		}
	}

	/**
	 * Analyze a request object for all context references.
	 * This is the unified method that processes text, contentReferences, and variableData.
	 */
	private analyzeRequestContext(request: any, refs: ContextReferenceUsage): void {
		// Analyze user message text for context references
		if (request.message) {
			if (request.message.text) {
				this.analyzeContextReferences(request.message.text, refs);
			}
			if (request.message.parts) {
				for (const part of request.message.parts) {
					if (part.text) {
						this.analyzeContextReferences(part.text, refs);
					}
				}
			}
		}

		// Analyze contentReferences if present
		if (request.contentReferences && Array.isArray(request.contentReferences)) {
			this.analyzeContentReferences(request.contentReferences, refs);
		}

		// Analyze variableData if present
		if (request.variableData) {
			this.analyzeVariableData(request.variableData, refs);
		}
	}

	/**
	 * Analyze text for context references like #file, #selection, @workspace
	 */
	private analyzeContextReferences(text: string, refs: ContextReferenceUsage): void {
		// Count #file references
		const fileMatches = text.match(/#file/gi);
		if (fileMatches) {
			refs.file += fileMatches.length;
		}

		// Count #selection references
		const selectionMatches = text.match(/#selection/gi);
		if (selectionMatches) {
			refs.selection += selectionMatches.length;
		}

		// Count #symbol and #sym references (both aliases)
		// Note: #sym:symbolName format is handled via variableData, not text matching
		const symbolMatches = text.match(/#symbol/gi);
		const symMatches = text.match(/#sym(?![:\w])/gi);  // Negative lookahead: don't match #symbol or #sym:
		if (symbolMatches) {
			refs.symbol += symbolMatches.length;
		}
		if (symMatches) {
			refs.symbol += symMatches.length;
		}

		// Count #codebase references
		const codebaseMatches = text.match(/#codebase/gi);
		if (codebaseMatches) {
			refs.codebase += codebaseMatches.length;
		}

		// Count #terminalLastCommand references
		const terminalLastCommandMatches = text.match(/#terminalLastCommand/gi);
		if (terminalLastCommandMatches) {
			refs.terminalLastCommand += terminalLastCommandMatches.length;
		}

		// Count #terminalSelection references
		const terminalSelectionMatches = text.match(/#terminalSelection/gi);
		if (terminalSelectionMatches) {
			refs.terminalSelection += terminalSelectionMatches.length;
		}

		// Count #clipboard references
		const clipboardMatches = text.match(/#clipboard/gi);
		if (clipboardMatches) {
			refs.clipboard += clipboardMatches.length;
		}

		// Count #changes references
		const changesMatches = text.match(/#changes/gi);
		if (changesMatches) {
			refs.changes += changesMatches.length;
		}

		// Count #outputPanel references
		const outputPanelMatches = text.match(/#outputPanel/gi);
		if (outputPanelMatches) {
			refs.outputPanel += outputPanelMatches.length;
		}

		// Count #problemsPanel references
		const problemsPanelMatches = text.match(/#problemsPanel/gi);
		if (problemsPanelMatches) {
			refs.problemsPanel += problemsPanelMatches.length;
		}

		// Count @workspace references
		const workspaceMatches = text.match(/@workspace/gi);
		if (workspaceMatches) {
			refs.workspace += workspaceMatches.length;
		}

		// Count @terminal references
		const terminalMatches = text.match(/@terminal/gi);
		if (terminalMatches) {
			refs.terminal += terminalMatches.length;
		}

		// Count @vscode references
		const vscodeMatches = text.match(/@vscode/gi);
		if (vscodeMatches) {
			refs.vscode += vscodeMatches.length;
		}
	}

	/**
	 * Analyze contentReferences from session log data to track specific file attachments.
	 * Looks for kind: "reference" entries and tracks by kind, path patterns.
	 * Also increments specific category counters like refs.file when appropriate.
	 */
	private analyzeContentReferences(contentReferences: any[], refs: ContextReferenceUsage): void {
		if (!Array.isArray(contentReferences)) {
			return;
		}

		for (const contentRef of contentReferences) {
			if (!contentRef || typeof contentRef !== 'object') {
				continue;
			}

			// Track by kind
			const kind = contentRef.kind;
			if (typeof kind === 'string') {
				refs.byKind[kind] = (refs.byKind[kind] || 0) + 1;
			}

			// Extract reference object based on kind
			let reference = null;

			// Handle different reference structures
			if (kind === 'reference' && contentRef.reference) {
				reference = contentRef.reference;
			} else if (kind === 'inlineReference' && contentRef.inlineReference) {
				reference = contentRef.inlineReference;
			}

			// Process the reference if found
			if (reference) {
				// Try to extract file path from various possible fields
				const fsPath = reference.fsPath || reference.path;
				if (typeof fsPath === 'string') {
					// Normalize path separators for pattern matching
					const normalizedPath = fsPath.replace(/\\/g, '/').toLowerCase();

					// Track specific patterns - these are auto-attached, not user-explicit #file refs
					if (normalizedPath.endsWith('/.github/copilot-instructions.md') ||
						normalizedPath.includes('.github/copilot-instructions.md')) {
						refs.copilotInstructions++;
					} else if (normalizedPath.endsWith('/agents.md') ||
						normalizedPath.match(/\/agents\.md$/i)) {
						refs.agentsMd++;
					} else if (normalizedPath.endsWith('.instructions.md') ||
						normalizedPath.includes('.instructions.md')) {
						// Other instruction files (e.g., github-actions.instructions.md) are auto-attached
						// Track as copilotInstructions since they're part of the instructions system
						refs.copilotInstructions++;
					} else {
						// For other files, increment the general file counter
						// This makes actual file attachments show up in context ref counts
						refs.file++;
					}

					// Track by full path (limit to last 100 chars for display)
					const pathKey = fsPath.length > 100 ? '...' + fsPath.substring(fsPath.length - 97) : fsPath;
					refs.byPath[pathKey] = (refs.byPath[pathKey] || 0) + 1;
				}

				// Handle symbol references (e.g., #sym:functionName)
				// Symbol references have a 'name' field instead of fsPath
				const symbolName = reference.name;
				if (typeof symbolName === 'string' && kind === 'reference') {
					// This is a symbol reference, track it
					refs.symbol++;
					// Track symbol by name for display (use 'name' as path)
					const symbolKey = `#sym:${symbolName}`;
					refs.byPath[symbolKey] = (refs.byPath[symbolKey] || 0) + 1;
				}
			}
		}
	}

	/**
	 * Analyze variableData to track prompt file attachments and other variable-based context.
	 * This captures automatic attachments like copilot-instructions.md via variable system.
	 */
	private analyzeVariableData(variableData: any, refs: ContextReferenceUsage): void {
		if (!variableData || !Array.isArray(variableData.variables)) {
			return;
		}

		for (const variable of variableData.variables) {
			if (!variable || typeof variable !== 'object') {
				continue;
			}

			// Track by kind from variableData
			const kind = variable.kind;
			if (typeof kind === 'string') {
				refs.byKind[kind] = (refs.byKind[kind] || 0) + 1;
			}

			// Handle symbol references (e.g., #sym:functionName)
			// These appear as kind="generic" with name starting with "sym:"
			if (kind === 'generic' && typeof variable.name === 'string' && variable.name.startsWith('sym:')) {
				refs.symbol++;
				// Track symbol by name for display
				const symbolKey = `#${variable.name}`;
				refs.byPath[symbolKey] = (refs.byPath[symbolKey] || 0) + 1;
			}

			// Process promptFile variables that contain file references
			if (kind === 'promptFile' && variable.value) {
				const value = variable.value;
				const fsPath = value.fsPath || value.path || value.external;

				if (typeof fsPath === 'string') {
					const normalizedPath = fsPath.replace(/\\/g, '/').toLowerCase();

					// Track specific patterns (but don't double-count if already in contentReferences)
					if (normalizedPath.endsWith('/.github/copilot-instructions.md') ||
						normalizedPath.includes('.github/copilot-instructions.md')) {
						// copilotInstructions - tracked via contentReferences, skip here to avoid double counting
					} else if (normalizedPath.endsWith('/agents.md') ||
						normalizedPath.match(/\/agents\.md$/i)) {
						// agents.md - tracked via contentReferences, skip here  to avoid double counting
					}
					// Note: We don't add to byPath here as these are automatic attachments,
					// not explicit user file selections
				}
			}
		}
	}

	/**
	 * Extract repository remote URL from file paths found in contentReferences.
	 * Looks for .git/config file in the workspace root to get the origin remote URL.
	 * @param contentReferences Array of content reference objects from session data
	 * @returns The repository remote URL if found, undefined otherwise
	 */
	private async extractRepositoryFromContentReferences(contentReferences: any[]): Promise<string | undefined> {
		if (!Array.isArray(contentReferences)) {
			return undefined;
		}

		const filePaths: string[] = [];

		// Collect all file paths from contentReferences
		for (const contentRef of contentReferences) {
			if (!contentRef || typeof contentRef !== 'object') {
				continue;
			}

			let reference = null;
			const kind = contentRef.kind;

			if (kind === 'reference' && contentRef.reference) {
				reference = contentRef.reference;
			} else if (kind === 'inlineReference' && contentRef.inlineReference) {
				reference = contentRef.inlineReference;
			}

			if (reference) {
				// Prefer fsPath (native format) over path (URI format)
				const rawPath = reference.fsPath || reference.path;
				if (typeof rawPath === 'string' && rawPath.length > 0) {
					// Convert VS Code URI path format to native path on Windows
					// URI paths look like "/c:/Users/..." but should be "c:/Users/..." on Windows
					let normalizedPath = rawPath;
					if (process.platform === 'win32' && normalizedPath.match(/^\/[a-zA-Z]:/)) {
						normalizedPath = normalizedPath.substring(1); // Remove leading slash
					}
					filePaths.push(normalizedPath);
				}
			}
		}

		if (filePaths.length === 0) {
			return undefined;
		}

		// Find the most likely workspace root by looking for common parent directories
		// Try each file path and look for a .git/config file in parent directories
		const checkedRoots = new Set<string>();

		for (const filePath of filePaths) {
			// Normalize path separators to forward slashes for consistent splitting
			const normalizedPath = filePath.replace(/\\/g, '/');
			const pathParts = normalizedPath.split('/').filter(p => p.length > 0);

			// Walk up the directory tree looking for .git/config
			for (let i = pathParts.length - 1; i >= 1; i--) {
				// Reconstruct path - on Windows, first part is drive letter (e.g., "c:")
				let potentialRoot = pathParts.slice(0, i).join('/');

				// On Windows, ensure we have a valid absolute path
				if (process.platform === 'win32' && pathParts[0].match(/^[a-zA-Z]:$/)) {
					// Path starts with drive letter, already valid
				} else if (process.platform !== 'win32' && !potentialRoot.startsWith('/')) {
					// On Unix, prepend / for absolute path
					potentialRoot = '/' + potentialRoot;
				}

				// Skip if we've already checked this root
				if (checkedRoots.has(potentialRoot)) {
					continue;
				}
				checkedRoots.add(potentialRoot);

				const gitConfigPath = path.join(potentialRoot, '.git', 'config');
				try {
					const gitConfig = await fs.promises.readFile(gitConfigPath, 'utf8');
					const remoteUrl = this.parseGitRemoteUrl(gitConfig);
					if (remoteUrl) {
						return remoteUrl;
					}
				} catch {
					// No .git/config at this level, continue up the tree
				}
			}
		}

		return undefined;
	}

	/**
	 * Parse the remote origin URL from a .git/config file content.
	 * Looks for [remote "origin"] section and extracts the url value.
	 * @param gitConfigContent The content of a .git/config file
	 * @returns The remote origin URL if found, undefined otherwise
	 */
	private parseGitRemoteUrl(gitConfigContent: string): string | undefined {
		// Look for [remote "origin"] section and extract url
		const lines = gitConfigContent.split('\n');
		let inOriginSection = false;

		for (const line of lines) {
			const trimmed = line.trim();

			// Check if we're entering the [remote "origin"] section
			if (trimmed.match(/^\[remote\s+"origin"\]$/i)) {
				inOriginSection = true;
				continue;
			}

			// Check if we're leaving the section (new section starts)
			if (inOriginSection && trimmed.startsWith('[')) {
				inOriginSection = false;
				continue;
			}

			// Look for url = ... in the origin section
			if (inOriginSection) {
				const urlMatch = trimmed.match(/^url\s*=\s*(.+)$/i);
				if (urlMatch) {
					return urlMatch[1].trim();
				}
			}
		}

		return undefined;
	}

	/**
	 * Extract session metadata (title, timestamps) from a session file.
	 * Used to populate cache with information needed for session file details.
	 */
	private async extractSessionMetadata(sessionFile: string): Promise<{
		title: string | undefined;
		firstInteraction: string | null;
		lastInteraction: string | null;
	}> {
		let title: string | undefined;
		const timestamps: number[] = [];

		try {
			// Handle OpenCode sessions
			if (this.isOpenCodeSessionFile(sessionFile)) {
				// Read session metadata from DB or JSON file
				let session: any = null;
				const sessionId = this.getOpenCodeSessionId(sessionFile);
				if (this.isOpenCodeDbSession(sessionFile) && sessionId) {
					session = await this.readOpenCodeDbSession(sessionId);
				} else {
					const fileContent = await fs.promises.readFile(sessionFile, 'utf8');
					session = JSON.parse(fileContent);
				}
				if (session) {
					title = session.title || session.slug;
					if (session.time?.created) { timestamps.push(session.time.created); }
					if (session.time?.updated) { timestamps.push(session.time.updated); }
				}
				// Also check message timestamps for more precision
				const messages = await this.getOpenCodeMessagesForSession(sessionFile);
				for (const msg of messages) {
					if (msg.time?.created) { timestamps.push(msg.time.created); }
					if (msg.time?.completed) { timestamps.push(msg.time.completed); }
				}
				let firstInteraction: string | null = null;
				let lastInteraction: string | null = null;
				if (timestamps.length > 0) {
					timestamps.sort((a, b) => a - b);
					firstInteraction = new Date(timestamps[0]).toISOString();
					lastInteraction = new Date(timestamps[timestamps.length - 1]).toISOString();
				}
				return { title, firstInteraction, lastInteraction };
			}

			const fileContent = await fs.promises.readFile(sessionFile, 'utf8');

			// Check if this is a UUID-only file (new Copilot CLI format)
			if (this.isUuidPointerFile(fileContent)) {
				return { title, firstInteraction: null, lastInteraction: null };
			}

			const isJsonlContent = sessionFile.endsWith('.jsonl') || this.isJsonlContent(fileContent);

			if (isJsonlContent) {
				const lines = fileContent.trim().split('\n');
				for (const line of lines) {
					if (!line.trim()) { continue; }
					try {
						const event = JSON.parse(line);

						// Handle Copilot CLI format
						if (event.type === 'user.message') {
							const ts = event.timestamp || event.ts || event.data?.timestamp;
							if (ts) { timestamps.push(new Date(ts).getTime()); }
						}

						// Handle VS Code incremental .jsonl format
						if (event.kind === 0 && event.v) {
							if (event.v.creationDate) { timestamps.push(event.v.creationDate); }
							// Always update title - we want the LAST title in the file (matches VS Code UI)
							if (event.v.customTitle) { title = event.v.customTitle; }
						}

						// Handle kind: 2 events (requests array with timestamps)
						if (event.kind === 2 && event.k?.[0] === 'requests' && Array.isArray(event.v)) {
							for (const request of event.v) {
								if (request.timestamp) {
									timestamps.push(request.timestamp);
								}
							}
						}

						// Check kind: 1 (value updates) for title changes
						if (event.kind === 1 && event.k?.includes('customTitle') && event.v) {
							title = event.v;
						}
					} catch {
						// Skip malformed lines
					}
				}
			} else {
				// JSON format - try to parse
				try {
					const parsed = JSON.parse(fileContent);
					if (parsed.customTitle) { title = parsed.customTitle; }
					if (parsed.creationDate) { timestamps.push(parsed.creationDate); }
					// Extract timestamps from requests array (like getSessionFileDetails does)
					if (parsed.requests && Array.isArray(parsed.requests)) {
						for (const request of parsed.requests) {
							if (request.timestamp || request.ts || request.result?.timestamp) {
								const ts = request.timestamp || request.ts || request.result?.timestamp;
								timestamps.push(new Date(ts).getTime());
							}
						}
					}
				} catch {
					// Unable to parse
				}
			}
		} catch {
			// File read error
		}

		let firstInteraction: string | null = null;
		let lastInteraction: string | null = null;
		if (timestamps.length > 0) {
			timestamps.sort((a, b) => a - b);
			firstInteraction = new Date(timestamps[0]).toISOString();
			lastInteraction = new Date(timestamps[timestamps.length - 1]).toISOString();
		}

		return { title, firstInteraction, lastInteraction };
	}

	// Cached versions of session file reading methods
	private async getSessionFileDataCached(sessionFilePath: string, mtime: number, fileSize: number): Promise<SessionFileCache> {
		// Check if we have valid cached data
		const cached = this.getCachedSessionData(sessionFilePath);
		if (cached && cached.mtime === mtime && cached.size === fileSize) {
			this._cacheHits++;
			return cached;
		}

		this._cacheMisses++;
		// Cache miss - read and process the file once to get all data
		const tokenResult = await this.estimateTokensFromSession(sessionFilePath);
		const interactions = await this.countInteractionsInSession(sessionFilePath);
		const modelUsage = await this.getModelUsageFromSession(sessionFilePath);
		const usageAnalysis = await this.analyzeSessionUsage(sessionFilePath);

		// Extract title and timestamps from the session file
		const sessionMeta = await this.extractSessionMetadata(sessionFilePath);

		const sessionData: SessionFileCache = {
			tokens: tokenResult.tokens,
			interactions,
			modelUsage,
			mtime,
			size: fileSize,
			usageAnalysis,
			title: sessionMeta.title,
			firstInteraction: sessionMeta.firstInteraction,
			lastInteraction: sessionMeta.lastInteraction,
			thinkingTokens: tokenResult.thinkingTokens,
			actualTokens: tokenResult.actualTokens
		};

		this.setCachedSessionData(sessionFilePath, sessionData, fileSize);
		return sessionData;
	}

	private async estimateTokensFromSessionCached(sessionFilePath: string, mtime: number, fileSize: number): Promise<number> {
		const sessionData = await this.getSessionFileDataCached(sessionFilePath, mtime, fileSize);
		return sessionData.tokens;
	}

	private async countInteractionsInSessionCached(sessionFile: string, mtime: number, fileSize: number): Promise<number> {
		const sessionData = await this.getSessionFileDataCached(sessionFile, mtime, fileSize);
		return sessionData.interactions;
	}

	private async getModelUsageFromSessionCached(sessionFile: string, mtime: number, fileSize: number): Promise<ModelUsage> {
		const sessionData = await this.getSessionFileDataCached(sessionFile, mtime, fileSize);
		return sessionData.modelUsage;
	}

	private async getUsageAnalysisFromSessionCached(sessionFile: string, mtime: number, fileSize: number): Promise<SessionUsageAnalysis> {
		const sessionData = await this.getSessionFileDataCached(sessionFile, mtime, fileSize);
		const analysis = sessionData.usageAnalysis || {
			toolCalls: { total: 0, byTool: {} },
			modeUsage: { ask: 0, edit: 0, agent: 0, plan: 0, customAgent: 0 },
			contextReferences: {
				file: 0,
				selection: 0,
				implicitSelection: 0,
				symbol: 0,
				codebase: 0,
				workspace: 0,
				terminal: 0,
				vscode: 0,
				terminalLastCommand: 0,
				terminalSelection: 0,
				clipboard: 0,
				changes: 0,
				outputPanel: 0,
				problemsPanel: 0,
				byKind: {},
				copilotInstructions: 0,
				agentsMd: 0,
				byPath: {}
			},
			mcpTools: { total: 0, byServer: {}, byTool: {} },
			modelSwitching: {
				uniqueModels: [],
				modelCount: 0,
				switchCount: 0,
				tiers: { standard: [], premium: [], unknown: [] },
				hasMixedTiers: false,
				standardRequests: 0,
				premiumRequests: 0,
				unknownRequests: 0,
				totalRequests: 0
			}
		};

		// Ensure modelSwitching field exists for backward compatibility with old cache
		if (!analysis.modelSwitching) {
			analysis.modelSwitching = {
				uniqueModels: [],
				modelCount: 0,
				switchCount: 0,
				tiers: { standard: [], premium: [], unknown: [] },
				hasMixedTiers: false,
				standardRequests: 0,
				premiumRequests: 0,
				unknownRequests: 0,
				totalRequests: 0
			};
		}

		return analysis;
	}

	/**
	 * Add editor root and name information to session file details.
	 * Enriches the details object with editorRoot and editorName properties.
	 */
	private enrichDetailsWithEditorInfo(sessionFile: string, details: SessionFileDetails): void {
		try {
			const parts = sessionFile.split(/[/\\]/);
			const userIdx = parts.findIndex(p => p.toLowerCase() === 'user');
			if (userIdx > 0) {
				details.editorRoot = parts.slice(0, userIdx).join(require('path').sep);
			} else {
				details.editorRoot = require('path').dirname(sessionFile);
			}
			details.editorName = this.getEditorNameFromRoot(details.editorRoot || '');
		} catch (e) {
			details.editorRoot = require('path').dirname(sessionFile);
			details.editorName = this.getEditorNameFromRoot(details.editorRoot || '');
		}
	}

	/**
	 * Reconstruct SessionFileDetails from cached data without reading the file.
	 * Returns undefined if cache is not valid or doesn't have all required data.
	 */
	private async getSessionFileDetailsFromCache(sessionFile: string, stat: fs.Stats): Promise<SessionFileDetails | undefined> {
		const cached = this.getCachedSessionData(sessionFile);

		// Validate cache against file stats
		if (!cached || cached.mtime !== stat.mtime.getTime() || cached.size !== stat.size) {
			return undefined;
		}

		// Check if cache has the required fields (for backward compatibility with old cache)
		if (!cached.usageAnalysis?.contextReferences || typeof cached.interactions !== 'number' || cached.interactions < 0) {
			return undefined;
		}

		// Determine lastInteraction: use the more recent of cached timestamp or file mtime
		// This handles cases where file was modified but content timestamps are older
		let lastInteraction: string | null = cached.lastInteraction || null;
		if (lastInteraction) {
			const cachedLastInteraction = new Date(lastInteraction);
			if (stat.mtime > cachedLastInteraction) {
				lastInteraction = stat.mtime.toISOString();
			}
		} else {
			// No cached lastInteraction, use file mtime
			lastInteraction = stat.mtime.toISOString();
		}

		// Reconstruct SessionFileDetails from cache
		const details: SessionFileDetails = {
			file: sessionFile,
			size: cached.size || stat.size,
			modified: stat.mtime.toISOString(),
			interactions: cached.interactions,
			contextReferences: cached.usageAnalysis.contextReferences,
			firstInteraction: cached.firstInteraction || null,
			lastInteraction: lastInteraction,
			editorSource: this.detectEditorSource(sessionFile),
			title: cached.title,
			repository: cached.repository
		};

		// Add editor root and name
		this.enrichDetailsWithEditorInfo(sessionFile, details);

		return details;
	}

	/**
	 * Update or create cache entry with session file details.
	 * Merges new detail fields with existing cached data if available.
	 */
	private async updateCacheWithSessionDetails(
		sessionFile: string,
		stat: fs.Stats,
		details: SessionFileDetails
	): Promise<void> {
		// Get existing cache entry if available
		const existingCache = this.getCachedSessionData(sessionFile);

		// Create or update cache entry
		const cacheEntry: SessionFileCache = {
			tokens: existingCache?.tokens || 0,
			interactions: details.interactions,
			modelUsage: existingCache?.modelUsage || {},
			mtime: stat.mtime.getTime(),
			size: stat.size,
			usageAnalysis: existingCache?.usageAnalysis || {
				toolCalls: { total: 0, byTool: {} },
				modeUsage: { ask: 0, edit: 0, agent: 0, plan: 0, customAgent: 0 },
				contextReferences: {
					file: 0, selection: 0, implicitSelection: 0, symbol: 0, codebase: 0,
					workspace: 0, terminal: 0, vscode: 0,
					terminalLastCommand: 0, terminalSelection: 0, clipboard: 0, changes: 0, outputPanel: 0, problemsPanel: 0,
					// Extended fields expected by SessionUsageAnalysis in the webview
					byKind: {}, copilotInstructions: 0, agentsMd: 0, byPath: {}
				},
				mcpTools: { total: 0, byServer: {}, byTool: {} },
				modelSwitching: {
					uniqueModels: [],
					modelCount: 0,
					switchCount: 0,
					tiers: { standard: [], premium: [], unknown: [] },
					hasMixedTiers: false,
					standardRequests: 0,
					premiumRequests: 0,
					unknownRequests: 0,
					totalRequests: 0
				}
			},
			firstInteraction: details.firstInteraction,
			lastInteraction: details.lastInteraction,
			title: details.title,
			repository: details.repository
		};

		// Update the contextReferences in usageAnalysis with the current data
		// usageAnalysis is guaranteed to exist here since we always initialize it above
		cacheEntry.usageAnalysis!.contextReferences = details.contextReferences;

		this.setCachedSessionData(sessionFile, cacheEntry, stat.size);
	}

	/**
	 * Get detailed session file information for diagnostics view.
	 * Analyzes session files to extract interactions, context references, and timestamps.
	 * Uses cached data when available to avoid re-reading files.
	 */
	private async getSessionFileDetails(sessionFile: string): Promise<SessionFileDetails> {
		const stat = await this.statSessionFile(sessionFile);

		// Try to get details from cache first
		const cachedDetails = await this.getSessionFileDetailsFromCache(sessionFile, stat);
		if (cachedDetails) {
			// Invalidate cache if repository field is missing (needed for new repository extraction feature)
			// Only re-parse JSONL files since they're likely to have contentReferences
			if (cachedDetails.repository === undefined && sessionFile.endsWith('.jsonl')) {
				// Fall through to re-parse
			} else {
				this._cacheHits++;
				return cachedDetails;
			}
		}

		this._cacheMisses++;

		const details: SessionFileDetails = {
			file: sessionFile,
			size: stat.size,
			modified: stat.mtime.toISOString(),
			interactions: 0,
			contextReferences: {
				file: 0, selection: 0, implicitSelection: 0, symbol: 0, codebase: 0,
				workspace: 0, terminal: 0, vscode: 0,
				terminalLastCommand: 0, terminalSelection: 0, clipboard: 0, changes: 0, outputPanel: 0, problemsPanel: 0,
				byKind: {}, copilotInstructions: 0, agentsMd: 0, byPath: {}
			},
			firstInteraction: null,
			lastInteraction: null,
			editorSource: this.detectEditorSource(sessionFile)
		};

		// Determine top-level editor root path for this session file (up to the folder before 'User')
		this.enrichDetailsWithEditorInfo(sessionFile, details);

		try {
			// Handle OpenCode sessions
			if (this.isOpenCodeSessionFile(sessionFile)) {
				// Read session metadata from DB or JSON file
				let session: any = null;
				const sessionId = this.getOpenCodeSessionId(sessionFile);
				if (this.isOpenCodeDbSession(sessionFile) && sessionId) {
					session = await this.readOpenCodeDbSession(sessionId);
				} else {
					const fileContent = await fs.promises.readFile(sessionFile, 'utf8');
					session = JSON.parse(fileContent);
				}
				if (session) {
					details.title = session.title || session.slug;
				}
				details.interactions = await this.countOpenCodeInteractions(sessionFile);
				const timestamps: number[] = [];
				if (session?.time?.created) { timestamps.push(session.time.created); }
				if (session?.time?.updated) { timestamps.push(session.time.updated); }
				const messages = await this.getOpenCodeMessagesForSession(sessionFile);
				for (const msg of messages) {
					if (msg.time?.created) { timestamps.push(msg.time.created); }
					if (msg.time?.completed) { timestamps.push(msg.time.completed); }
				}
				if (timestamps.length > 0) {
					timestamps.sort((a, b) => a - b);
					details.firstInteraction = new Date(timestamps[0]).toISOString();
					details.lastInteraction = new Date(timestamps[timestamps.length - 1]).toISOString();
				}
				// Set editor info for OpenCode
				details.editorRoot = this.getOpenCodeDataDir();
				details.editorName = 'OpenCode';
				await this.updateCacheWithSessionDetails(sessionFile, stat, details);
				return details;
			}

			const fileContent = await fs.promises.readFile(sessionFile, 'utf8');

			// Check if this is a UUID-only file (new Copilot CLI format where the file contains just a session ID)
			// These files act as session pointers, with actual data stored elsewhere
			if (this.isUuidPointerFile(fileContent)) {
				// This is a session ID pointer file, not actual session data
				// Skip parsing and return empty details (no interactions to count)
				await this.updateCacheWithSessionDetails(sessionFile, stat, details);
				return details;
			}

			// Handle .jsonl files OR .json files with JSONL content (Copilot CLI format and VS Code incremental format)
			const isJsonlContent = sessionFile.endsWith('.jsonl') || this.isJsonlContent(fileContent);
			if (isJsonlContent) {
				const lines = fileContent.trim().split('\n').filter(l => l.trim());
				const timestamps: number[] = [];
				const allContentReferences: any[] = []; // Collect for repository extraction

				// Detect if this is delta-based format (VS Code incremental)
				let isDeltaBased = false;
				if (lines.length > 0) {
					try {
						const firstLine = JSON.parse(lines[0]);
						if (firstLine && typeof firstLine.kind === 'number') {
							isDeltaBased = true;
						}
					} catch {
						// Not delta format
					}
				}

				if (isDeltaBased) {
					// Delta-based format: reconstruct full state first, then extract details
					let sessionState: any = {};
					for (const line of lines) {
						try {
							const delta = JSON.parse(line);
							sessionState = this.applyDelta(sessionState, delta);
						} catch {
							// Skip invalid lines
						}
					}

					// Extract session metadata from reconstructed state
					if (sessionState.creationDate) {
						timestamps.push(sessionState.creationDate);
					}
					if (sessionState.customTitle) {
						details.title = sessionState.customTitle;
					}

					// Process reconstructed requests array
					const requests = sessionState.requests || [];
					details.interactions = requests.length;

					for (const request of requests) {
						if (!request) { continue; }

						if (request.timestamp) {
							timestamps.push(request.timestamp);
						}

						// Analyze all context references from this request (unified method)
						this.analyzeRequestContext(request, details.contextReferences);

						// Collect contentReferences for repository extraction
						if (request.contentReferences && Array.isArray(request.contentReferences)) {
							allContentReferences.push(...request.contentReferences);
						}
					}

					if (timestamps.length > 0) {
						timestamps.sort((a, b) => a - b);
						details.firstInteraction = new Date(timestamps[0]).toISOString();
						const lastTimestamp = new Date(timestamps[timestamps.length - 1]);
						details.lastInteraction = lastTimestamp > stat.mtime
							? lastTimestamp.toISOString()
							: stat.mtime.toISOString();
					} else {
						details.lastInteraction = stat.mtime.toISOString();
					}

					// Extract repository from collected contentReferences
					if (allContentReferences.length > 0) {
						details.repository = await this.extractRepositoryFromContentReferences(allContentReferences);
					}

					// Update cache with the details we just collected
					await this.updateCacheWithSessionDetails(sessionFile, stat, details);

					return details;
				}

				// Non-delta JSONL (Copilot CLI format) - process line-by-line
				for (const line of lines) {
					if (!line.trim()) { continue; }
					try {
						const event = JSON.parse(line);

						// Handle Copilot CLI format (type: 'user.message')
						if (event.type === 'user.message') {
							details.interactions++;
							if (event.timestamp || event.ts || event.data?.timestamp) {
								const ts = event.timestamp || event.ts || event.data?.timestamp;
								timestamps.push(new Date(ts).getTime());
							}
							if (event.data?.content) {
								this.analyzeContextReferences(event.data.content, details.contextReferences);
							}
						}
					} catch {
						// Skip malformed lines
					}
				}

				if (timestamps.length > 0) {
					timestamps.sort((a, b) => a - b);
					details.firstInteraction = new Date(timestamps[0]).toISOString();
					// Use the more recent of: extracted last timestamp OR file modification time
					// This handles cases where new requests are added without timestamp fields
					const lastTimestamp = new Date(timestamps[timestamps.length - 1]);
					details.lastInteraction = lastTimestamp > stat.mtime
						? lastTimestamp.toISOString()
						: stat.mtime.toISOString();
				} else {
					// Fallback to file modification time if no timestamps in content
					details.lastInteraction = stat.mtime.toISOString();
				}

				// Extract repository from collected contentReferences
				if (allContentReferences.length > 0) {
					details.repository = await this.extractRepositoryFromContentReferences(allContentReferences);
				}

				// Update cache with the details we just collected
				await this.updateCacheWithSessionDetails(sessionFile, stat, details);

				return details;
			}

			// Handle regular .json files
			const sessionContent = JSON.parse(fileContent);

			// Extract session title if available
			if (sessionContent.customTitle) {
				details.title = sessionContent.customTitle;
			}

			const hasRequests = sessionContent.requests && Array.isArray(sessionContent.requests);

			if (hasRequests) {
				details.interactions = sessionContent.requests.length;
				const timestamps: number[] = [];
				const allContentReferences: any[] = []; // Collect for repository extraction

				for (const request of sessionContent.requests) {
					// Extract timestamps from requests
					if (request.timestamp || request.ts || request.result?.timestamp) {
						const ts = request.timestamp || request.ts || request.result?.timestamp;
						timestamps.push(new Date(ts).getTime());
					}

					// Analyze all context references from this request
					this.analyzeRequestContext(request, details.contextReferences);
					// Analyze context references
					if (request.message?.text) {
						this.analyzeContextReferences(request.message.text, details.contextReferences);
					}
					if (request.message?.parts) {
						for (const part of request.message.parts) {
							if (part.text) {
								this.analyzeContextReferences(part.text, details.contextReferences);
							}
						}
					}

					// Collect contentReferences for repository extraction
					if (request.contentReferences && Array.isArray(request.contentReferences)) {
						allContentReferences.push(...request.contentReferences);
					}

					// Check variableData for @workspace, @terminal, @vscode references
					if (request.variableData) {
						const varDataStr = JSON.stringify(request.variableData).toLowerCase();
						if (varDataStr.includes('workspace')) { details.contextReferences.workspace++; }
						if (varDataStr.includes('terminal')) { details.contextReferences.terminal++; }
						if (varDataStr.includes('vscode')) { details.contextReferences.vscode++; }
					}
				}

				if (timestamps.length > 0) {
					timestamps.sort((a, b) => a - b);
					details.firstInteraction = new Date(timestamps[0]).toISOString();
					// Use the more recent of: extracted last timestamp OR file modification time
					// This handles cases where new requests are added without timestamp fields
					const lastTimestamp = new Date(timestamps[timestamps.length - 1]);
					details.lastInteraction = lastTimestamp > stat.mtime
						? lastTimestamp.toISOString()
						: stat.mtime.toISOString();
				} else {
					// Fallback to file modification time if no timestamps in content
					details.lastInteraction = stat.mtime.toISOString();
				}

				// Extract repository from collected contentReferences
				if (allContentReferences.length > 0) {
					details.repository = await this.extractRepositoryFromContentReferences(allContentReferences);
				}
			}

			// Update cache with the details we just collected
			await this.updateCacheWithSessionDetails(sessionFile, stat, details);
		} catch (error) {
			this.warn(`Error analyzing session file details for ${sessionFile}: ${error}`);
		}

		return details;
	}

	/**
	 * Detect which editor the session file belongs to based on its path.
	 */
	private detectEditorSource(filePath: string): string {
		const lowerPath = filePath.toLowerCase().replace(/\\/g, '/');
		if (lowerPath.includes('/.copilot/session-state/')) { return 'Copilot CLI'; }
		if (this.isOpenCodeSessionFile(filePath)) { return 'OpenCode'; }
		if (lowerPath.includes('cursor')) { return 'Cursor'; }
		if (lowerPath.includes('code - insiders') || lowerPath.includes('code-insiders')) { return 'VS Code Insiders'; }
		if (lowerPath.includes('vscodium')) { return 'VSCodium'; }
		if (lowerPath.includes('windsurf')) { return 'Windsurf'; }
		if (lowerPath.includes('code')) { return 'VS Code'; }
		return 'Unknown';
	}

	/**
	 * Extract full session log data including chat turns for the log viewer.
	 */
	private async getSessionLogData(sessionFile: string): Promise<SessionLogData> {
		const details = await this.getSessionFileDetails(sessionFile);
		const turns: ChatTurn[] = [];

		try {
			// Handle OpenCode sessions
			if (this.isOpenCodeSessionFile(sessionFile)) {
				const messages = await this.getOpenCodeMessagesForSession(sessionFile);
				if (messages.length > 0) {
					let turnNumber = 0;
					let prevCumulativeTotal = 0; // track cumulative total to compute per-turn deltas
					for (let i = 0; i < messages.length; i++) {
						const msg = messages[i];
						if (msg.role !== 'user') { continue; }
						turnNumber++;
						// Collect ALL assistant messages for this turn (agentic tool-use loops produce multiple)
						const turnAssistantMsgs = messages.filter((m, idx) => idx > i && m.role === 'assistant' && m.parentID === msg.id);
						const userParts = await this.getOpenCodePartsForMessage(msg.id);
						const userText = userParts.filter(p => p.type === 'text').map(p => p.text || '').join('\n');
						let assistantText = '';
						let thinkingText = '';
						const toolCalls: { toolName: string; arguments?: string; result?: string }[] = [];
						let model: string | null = null;
						let thinkingTokens = 0;

						// Process all assistant messages in this turn to collect text, tool calls, and token totals
						let turnCumulativeTotal = prevCumulativeTotal;
						for (const assistantMsg of turnAssistantMsgs) {
							if (!model) {
								model = assistantMsg.modelID || null;
							}
							thinkingTokens += assistantMsg.tokens?.reasoning || 0;
							// Track the cumulative total — the last assistant message has the highest value
							if (typeof assistantMsg.tokens?.total === 'number') {
								turnCumulativeTotal = Math.max(turnCumulativeTotal, assistantMsg.tokens.total);
							}
							const assistantParts = await this.getOpenCodePartsForMessage(assistantMsg.id);
							for (const part of assistantParts) {
								if (part.type === 'text' && part.text) {
									assistantText += part.text;
								} else if (part.type === 'reasoning' && part.text) {
									thinkingText += part.text;
								} else if (part.type === 'tool' && part.tool) {
									toolCalls.push({
										toolName: part.tool,
										arguments: part.state?.input ? JSON.stringify(part.state.input) : undefined,
										result: part.state?.output || undefined
									});
								}
							}
						}

						// Per-turn tokens = delta of cumulative total between this turn and previous
						const turnTokens = turnCumulativeTotal - prevCumulativeTotal;
						// Split proportionally: output+thinking are known, remainder is input
						const turnOutputAndThinking = turnAssistantMsgs.reduce((sum, m) => sum + (m.tokens?.output || 0) + (m.tokens?.reasoning || 0), 0);
						const turnInputTokens = Math.max(0, turnTokens - turnOutputAndThinking);

						turns.push({
							turnNumber,
							timestamp: msg.time?.created ? new Date(msg.time.created).toISOString() : null,
							mode: (msg.agent === 'build' || msg.agent === 'agent') ? 'agent' : (msg.agent === 'ask' ? 'ask' : 'agent'),
							userMessage: userText,
							assistantResponse: assistantText,
							model,
							toolCalls,
							contextReferences: {
								file: 0, selection: 0, implicitSelection: 0, symbol: 0, codebase: 0,
								workspace: 0, terminal: 0, vscode: 0,
								terminalLastCommand: 0, terminalSelection: 0, clipboard: 0, changes: 0,
								outputPanel: 0, problemsPanel: 0, byKind: {}, copilotInstructions: 0, agentsMd: 0, byPath: {}
							},
							mcpTools: [],
							inputTokensEstimate: turnInputTokens,
							outputTokensEstimate: turnOutputAndThinking - thinkingTokens,
							thinkingTokensEstimate: thinkingTokens
						});

						prevCumulativeTotal = turnCumulativeTotal;
					}
				}
				return {
					file: details.file,
					title: details.title || null,
					editorSource: details.editorSource,
					editorName: details.editorName || 'OpenCode',
					size: details.size,
					modified: details.modified,
					interactions: details.interactions,
					contextReferences: details.contextReferences,
					firstInteraction: details.firstInteraction,
					lastInteraction: details.lastInteraction,
					turns,
					usageAnalysis: undefined
				};
			}

			const fileContent = await fs.promises.readFile(sessionFile, 'utf8');

			// Check if this is a UUID-only file (new Copilot CLI format)
			if (this.isUuidPointerFile(fileContent)) {
				// This is a session ID pointer file with no actual conversation data
				return {
					file: details.file,
					title: details.title || null,
					editorSource: details.editorSource,
					editorName: details.editorName || details.editorSource,
					size: details.size,
					modified: details.modified,
					interactions: details.interactions,
					contextReferences: details.contextReferences,
					firstInteraction: details.firstInteraction,
					lastInteraction: details.lastInteraction,
					turns,
					usageAnalysis: undefined
				};
			}

			// Check for JSONL content (either by extension or content detection)
			const isJsonlContent = sessionFile.endsWith('.jsonl') || this.isJsonlContent(fileContent);

			if (isJsonlContent) {
				// Handle JSONL formats (CLI and VS Code incremental/delta-based)
				const lines = fileContent.trim().split('\n').filter(l => l.trim());

				// Detect if this is delta-based format (VS Code incremental)
				let isDeltaBased = false;
				if (lines.length > 0) {
					try {
						const firstLine = JSON.parse(lines[0]);
						if (firstLine && typeof firstLine.kind === 'number') {
							isDeltaBased = true;
						}
					} catch {
						// Not delta format
					}
				}

				if (isDeltaBased) {
					// Delta-based format: reconstruct full state first, then extract turns
					let sessionState: any = {};
					for (const line of lines) {
						try {
							const delta = JSON.parse(line);
							sessionState = this.applyDelta(sessionState, delta);
						} catch {
							// Skip invalid lines
						}
					}

					// Extract session-level info
					let sessionMode: 'ask' | 'edit' | 'agent' | 'plan' | 'customAgent' = 'ask';
					let currentModel: string | null = null;

					if (sessionState.inputState?.mode) {
						sessionMode = this.getModeType(sessionState.inputState.mode);
						if (sessionState.inputState?.selectedModel?.metadata?.id) {
							currentModel = sessionState.inputState.selectedModel.metadata.id;
						}
					}

					// Extract turns from reconstructed requests array
					const requests = sessionState.requests || [];
					for (let i = 0; i < requests.length; i++) {
						const request = requests[i];
						if (!request || !request.requestId) { continue; }

						const contextRefs = this.createEmptyContextRefs();
						const userMessage = request.message?.text || '';

						// Analyze all context references from this request
						this.analyzeRequestContext(request, contextRefs);

						// Get model from request or fall back to session model
						const requestModel = request.modelId ||
							currentModel ||
							this.getModelFromRequest(request) ||
							'gpt-4';

						// Extract response data
						const { responseText, thinkingText, toolCalls, mcpTools } = this.extractResponseData(request.response || []);
						
						// Extract actual usage data from request.result if available
						let actualUsage: ActualUsage | undefined;
						if (request.result?.usage) {
							const u = request.result.usage;
							actualUsage = {
								completionTokens: typeof u.completionTokens === 'number' ? u.completionTokens : 0,
								promptTokens: typeof u.promptTokens === 'number' ? u.promptTokens : 0,
								promptTokenDetails: Array.isArray(u.promptTokenDetails) ? u.promptTokenDetails : undefined,
								details: typeof request.result.details === 'string' ? request.result.details : undefined
							};
						}

					const turn: ChatTurn = {
						turnNumber: i + 1,
						timestamp: request.timestamp ? new Date(request.timestamp).toISOString() : null,
						mode: sessionMode,
						userMessage,
						assistantResponse: responseText,
						model: requestModel,
						toolCalls,
						contextReferences: contextRefs,
						mcpTools,
						inputTokensEstimate: this.estimateTokensFromText(userMessage, requestModel),
						outputTokensEstimate: this.estimateTokensFromText(responseText, requestModel),
						thinkingTokensEstimate: this.estimateTokensFromText(thinkingText, requestModel),
						actualUsage
					};

					turns.push(turn);
				}
			} else {
			// Non-delta JSONL (Copilot CLI format)
			let turnNumber = 0;

			for (const line of lines) {
				try {
					const event = JSON.parse(line);

					// Handle Copilot CLI format (type: 'user.message')
					if (event.type === 'user.message' && event.data?.content) {
						turnNumber++;
						const contextRefs = this.createEmptyContextRefs();
						const userMessage = event.data.content;
						this.analyzeContextReferences(userMessage, contextRefs);
						const turn: ChatTurn = {
							turnNumber,
							timestamp: event.timestamp ? new Date(event.timestamp).toISOString() : null,
							mode: 'agent', // CLI is typically agent mode
							userMessage,
							assistantResponse: '',
							model: event.model || 'gpt-4o',
							toolCalls: [],
							contextReferences: contextRefs,
							mcpTools: [],
							inputTokensEstimate: this.estimateTokensFromText(userMessage, event.model || 'gpt-4o'),
							outputTokensEstimate: 0,
							thinkingTokensEstimate: 0
						};
						turns.push(turn);
					}

					// Handle CLI assistant response
					if (event.type === 'assistant.message' && event.data?.content && turns.length > 0) {
						const lastTurn = turns[turns.length - 1];
						lastTurn.assistantResponse += event.data.content;
						lastTurn.outputTokensEstimate = this.estimateTokensFromText(lastTurn.assistantResponse, lastTurn.model || 'gpt-4o');
					}

					// Handle CLI tool calls
					if ((event.type === 'tool.call' || event.type === 'tool.result') && turns.length > 0) {
						const lastTurn = turns[turns.length - 1];
						const toolName = event.data?.toolName || event.toolName || 'unknown';

						// Check if this is an MCP tool by name pattern
						if (this.isMcpTool(toolName)) {
							const serverName = this.extractMcpServerName(toolName);
							lastTurn.mcpTools.push({ server: serverName, tool: toolName });
						} else {
							// Add to regular tool calls
							lastTurn.toolCalls.push({
								toolName,
								arguments: event.type === 'tool.call' ? JSON.stringify(event.data?.arguments || {}) : undefined,
								result: event.type === 'tool.result' ? event.data?.output : undefined
							});
						}
					}

					// Handle explicit MCP tool calls from CLI
					if ((event.type === 'mcp.tool.call' || event.data?.mcpServer) && turns.length > 0) {
						const lastTurn = turns[turns.length - 1];
						const serverName = event.data?.mcpServer || 'unknown';
						const toolName = event.data?.toolName || event.toolName || 'unknown';
						lastTurn.mcpTools.push({ server: serverName, tool: toolName });
					}
				} catch {
					// Skip malformed lines
				}
			}
		}
				const sessionContent = JSON.parse(fileContent);
				let sessionMode: 'ask' | 'edit' | 'agent' | 'plan' | 'customAgent' = 'ask';

				// Detect session-level mode
				if (sessionContent.mode) {
					sessionMode = this.getModeType(sessionContent.mode);
				}

				if (sessionContent.requests && Array.isArray(sessionContent.requests)) {
					let turnNumber = 0;
					for (const request of sessionContent.requests) {
						turnNumber++;

						// Determine mode for this request
						let requestMode = sessionMode;
						if (request.agent?.id) {
							const agentId = request.agent.id.toLowerCase();
							if (agentId.includes('edit')) {
								requestMode = 'edit';
							} else if (agentId.includes('agent')) {
								requestMode = 'agent';
							}
						}

						// Extract user message
						let userMessage = '';
						if (request.message?.text) {
							userMessage = request.message.text;
						} else if (request.message?.parts) {
							userMessage = request.message.parts
								.filter((p: any) => p.text)
								.map((p: any) => p.text)
								.join('\n');
						}

						// Analyze context references
						const contextRefs = this.createEmptyContextRefs();
						this.analyzeRequestContext(request, contextRefs);

						// Extract model
						const model = this.getModelFromRequest(request);

						// Extract response
						let assistantResponse = '';
						let thinkingText = '';
						const toolCalls: { toolName: string; arguments?: string; result?: string }[] = [];
						const mcpTools: { server: string; tool: string }[] = [];

						if (request.response && Array.isArray(request.response)) {
							const { responseText, thinkingText: tt, toolCalls: tc, mcpTools: mcp } = this.extractResponseData(request.response);
							assistantResponse = responseText;
							thinkingText = tt;
							toolCalls.push(...tc);
							mcpTools.push(...mcp);
						}

						const turn: ChatTurn = {
							turnNumber,
							timestamp: request.timestamp || request.ts || request.result?.timestamp || null,
							mode: requestMode,
							userMessage,
							assistantResponse,
							model,
							toolCalls,
							contextReferences: contextRefs,
							mcpTools,
							inputTokensEstimate: this.estimateTokensFromText(userMessage, model),
							outputTokensEstimate: this.estimateTokensFromText(assistantResponse, model),
							thinkingTokensEstimate: this.estimateTokensFromText(thinkingText, model)
						};

						turns.push(turn);
					}
				}
			}
		} catch (error) {
			this.warn(`Error extracting chat turns from ${sessionFile}: ${error}`);
		}

		let usageAnalysis: SessionUsageAnalysis | undefined;
		try {
			const mtimeMs = new Date(details.modified).getTime();
			usageAnalysis = await this.getUsageAnalysisFromSessionCached(sessionFile, mtimeMs, details.size);
		} catch (usageError) {
			this.warn(`Error loading usage analysis for ${sessionFile}: ${usageError}`);
		}

		return {
			file: details.file,
			title: details.title || null,
			editorSource: details.editorSource,
			editorName: details.editorName || details.editorSource,
			size: details.size,
			modified: details.modified,
			interactions: details.interactions,
			contextReferences: details.contextReferences,
			firstInteraction: details.firstInteraction,
			lastInteraction: details.lastInteraction,
			turns,
			usageAnalysis
		};
	}

	/**
	 * Create empty context references object.
	 */
	private createEmptyContextRefs(): ContextReferenceUsage {
		return {
			file: 0, selection: 0, implicitSelection: 0, symbol: 0, codebase: 0,
			workspace: 0, terminal: 0, vscode: 0,
			terminalLastCommand: 0, terminalSelection: 0, clipboard: 0, changes: 0, outputPanel: 0, problemsPanel: 0,
			byKind: {}, copilotInstructions: 0, agentsMd: 0, byPath: {}
		};
	}

	/**
	 * Extract response data from a response array.
	 */
	private extractResponseData(response: any[]): {
		responseText: string;
		thinkingText: string;
		toolCalls: { toolName: string; arguments?: string; result?: string }[];
		mcpTools: { server: string; tool: string }[];
	} {
		let responseText = '';
		let thinkingText = '';
		const toolCalls: { toolName: string; arguments?: string; result?: string }[] = [];
		const mcpTools: { server: string; tool: string }[] = [];

		for (const item of response) {
			// Separate thinking items
			if (item.kind === 'thinking') {
				if (item.value && typeof item.value === 'string') {
					thinkingText += item.value;
				}
				continue;
			}

			// Extract text content
			if (item.value && typeof item.value === 'string') {
				responseText += item.value;
			} else if (item.kind === 'markdownContent' && item.content?.value) {
				responseText += item.content.value;
			}

			// Extract tool invocations
			if (item.kind === 'toolInvocationSerialized' || item.kind === 'prepareToolInvocation') {
				const toolName = item.toolId || item.toolName || item.invocationMessage?.toolName || item.toolSpecificData?.kind || 'unknown';

				// Check if this is an MCP tool by name pattern
				if (this.isMcpTool(toolName)) {
					const serverName = this.extractMcpServerName(toolName);
					mcpTools.push({ server: serverName, tool: toolName });
				} else {
					// Add to regular tool calls
					toolCalls.push({
						toolName,
						arguments: item.input ? JSON.stringify(item.input) : undefined,
						result: item.result ? (typeof item.result === 'string' ? item.result : JSON.stringify(item.result)) : undefined
					});
				}
			}

			// Extract MCP tools
			if (item.kind === 'mcpServersStarting' && item.didStartServerIds) {
				for (const serverId of item.didStartServerIds) {
					mcpTools.push({ server: serverId, tool: 'start' });
				}
			}
		}

		return { responseText, thinkingText, toolCalls, mcpTools };
	}

	/**
	 * Calculate estimated cost in USD based on model usage
	 * Assumes 50/50 split between input and output tokens for estimation
	 * @param modelUsage Object with model names as keys and token counts as values
	 * @returns Estimated cost in USD
	 */
	private calculateEstimatedCost(modelUsage: ModelUsage): number {
		let totalCost = 0;

		for (const [model, usage] of Object.entries(modelUsage)) {
			const pricing = this.modelPricing[model];

			if (pricing) {
				// Use actual input and output token counts
				const inputCost = (usage.inputTokens / 1_000_000) * pricing.inputCostPerMillion;
				const outputCost = (usage.outputTokens / 1_000_000) * pricing.outputCostPerMillion;

				totalCost += inputCost + outputCost;
			} else {
				// Fallback for models without pricing data - use GPT-4o-mini as default
				const fallbackPricing = this.modelPricing['gpt-4o-mini'];

				const inputCost = (usage.inputTokens / 1_000_000) * fallbackPricing.inputCostPerMillion;
				const outputCost = (usage.outputTokens / 1_000_000) * fallbackPricing.outputCostPerMillion;

				totalCost += inputCost + outputCost;

				this.log(`No pricing data for model '${model}', using fallback pricing (gpt-4o-mini)`);
			}
		}

		return totalCost;
	}

	private checkCopilotExtension(): void {
		const copilotExtension = vscode.extensions.getExtension('GitHub.copilot');
		const copilotChatExtension = vscode.extensions.getExtension('GitHub.copilot-chat');

		if (!copilotExtension && !copilotChatExtension) {
			this.log('⚠️ GitHub Copilot extensions not found');
		} else {
			const copilotStatus = copilotExtension ? (copilotExtension.isActive ? '✅ Active' : '⏳ Loading') : '❌ Not found';
			const chatStatus = copilotChatExtension ? (copilotChatExtension.isActive ? '✅ Active' : '⏳ Loading') : '❌ Not found';
			this.log(`GitHub Copilot: ${copilotStatus}, Chat: ${chatStatus}`);
		}

		// Check if we're in GitHub Codespaces
		const isCodespaces = process.env.CODESPACES === 'true';
		if (isCodespaces && (!copilotExtension?.isActive || !copilotChatExtension?.isActive)) {
			this.warn('⚠️ Running in Codespaces with inactive Copilot extensions');
		}
	}

	/**
	 * Get all possible VS Code user data paths for all VS Code variants
	 * Supports: Code (stable), Code - Insiders, VSCodium, remote servers, etc.
	 * 
	 * NOTE: The canonical JavaScript implementation is in:
	 * .github/skills/copilot-log-analysis/session-file-discovery.js
	 * This TypeScript implementation should mirror that logic.
	 */
	private getVSCodeUserPaths(): string[] {
		const platform = os.platform();
		const homedir = os.homedir();
		const paths: string[] = [];

		// VS Code variants to check
		const vscodeVariants = [
			'Code',               // Stable
			'Code - Insiders',    // Insiders
			'Code - Exploration', // Exploration builds
			'VSCodium',           // VSCodium
			'Cursor'              // Cursor editor
		];

		if (platform === 'win32') {
			const appDataPath = process.env.APPDATA || path.join(homedir, 'AppData', 'Roaming');
			for (const variant of vscodeVariants) {
				paths.push(path.join(appDataPath, variant, 'User'));
			}
		} else if (platform === 'darwin') {
			for (const variant of vscodeVariants) {
				paths.push(path.join(homedir, 'Library', 'Application Support', variant, 'User'));
			}
		} else {
			// Linux and other Unix-like systems
			const xdgConfigHome = process.env.XDG_CONFIG_HOME || path.join(homedir, '.config');
			for (const variant of vscodeVariants) {
				paths.push(path.join(xdgConfigHome, variant, 'User'));
			}
		}

		// Remote/Server paths (used in Codespaces, WSL, SSH remotes)
		const remotePaths = [
			path.join(homedir, '.vscode-server', 'data', 'User'),
			path.join(homedir, '.vscode-server-insiders', 'data', 'User'),
			path.join(homedir, '.vscode-remote', 'data', 'User'),
			path.join('/tmp', '.vscode-server', 'data', 'User'),
			path.join('/workspace', '.vscode-server', 'data', 'User')
		];

		paths.push(...remotePaths);

		return paths;
	}

	/**
	 * NOTE: The canonical JavaScript implementation is in:
	 * .github/skills/copilot-log-analysis/session-file-discovery.js
	 * This TypeScript implementation should mirror that logic.
	 */
	private async getCopilotSessionFiles(): Promise<string[]> {
		// Check short-term cache to avoid expensive filesystem scans during rapid successive calls
		const now = Date.now();
		if (this._sessionFilesCache && (now - this._sessionFilesCacheTime) < CopilotTokenTracker.SESSION_FILES_CACHE_TTL) {
			this.log(`💨 Using cached session files list (${this._sessionFilesCache.length} files, cached ${Math.round((now - this._sessionFilesCacheTime) / 1000)}s ago)`);
			return this._sessionFilesCache;
		}

		const sessionFiles: string[] = [];

		const platform = os.platform();
		const homedir = os.homedir();

		this.log(`🔍 Searching for Copilot session files on ${platform}`);

		// Get all possible VS Code user paths (stable, insiders, remote, etc.)
		const allVSCodePaths = this.getVSCodeUserPaths();
		this.log(`📂 Reading local folders [0/${allVSCodePaths.length}]`);

		// Track which paths we actually found
		const foundPaths: string[] = [];
		for (let i = 0; i < allVSCodePaths.length; i++) {
			const codeUserPath = allVSCodePaths[i];
			try {
				if (fs.existsSync(codeUserPath)) {
					foundPaths.push(codeUserPath);
				}
			} catch (checkError) {
				this.warn(`Could not check path ${codeUserPath}: ${checkError}`);
			}
			// Update progress
			if ((i + 1) % 5 === 0 || i === allVSCodePaths.length - 1) {
				this.log(`📂 Reading local folders [${i + 1}/${allVSCodePaths.length}]`);
			}
		}

		this.log(`✅ Found ${foundPaths.length} VS Code installation(s)`);

		try {
			// Scan all found VS Code paths for session files
			for (let i = 0; i < foundPaths.length; i++) {
				const codeUserPath = foundPaths[i];
				const pathName = path.basename(path.dirname(codeUserPath));

				// Workspace storage sessions
				const workspaceStoragePath = path.join(codeUserPath, 'workspaceStorage');
				try {
					if (fs.existsSync(workspaceStoragePath)) {
						try {
							const workspaceDirs = fs.readdirSync(workspaceStoragePath);

							for (const workspaceDir of workspaceDirs) {
								const chatSessionsPath = path.join(workspaceStoragePath, workspaceDir, 'chatSessions');
								try {
									if (fs.existsSync(chatSessionsPath)) {
										try {
											const sessionFiles2 = fs.readdirSync(chatSessionsPath)
												.filter(file => file.endsWith('.json') || file.endsWith('.jsonl'))
												.map(file => path.join(chatSessionsPath, file));
											if (sessionFiles2.length > 0) {
												this.log(`📄 Found ${sessionFiles2.length} session files in ${pathName}/workspaceStorage/${workspaceDir}`);
												sessionFiles.push(...sessionFiles2);
											}
										} catch (readError) {
											this.warn(`Could not read chat sessions in ${chatSessionsPath}: ${readError}`);
										}
									}
								} catch (checkError) {
									this.warn(`Could not check chat sessions path ${chatSessionsPath}: ${checkError}`);
								}
							}
						} catch (readError) {
							this.warn(`Could not read workspace storage in ${workspaceStoragePath}: ${readError}`);
						}
					}
				} catch (checkError) {
					this.warn(`Could not check workspace storage path ${workspaceStoragePath}: ${checkError}`);
				}

				// Global storage sessions (legacy emptyWindowChatSessions)
				const globalStoragePath = path.join(codeUserPath, 'globalStorage', 'emptyWindowChatSessions');
				try {
					if (fs.existsSync(globalStoragePath)) {
						try {
							const globalSessionFiles = fs.readdirSync(globalStoragePath)
								.filter(file => file.endsWith('.json') || file.endsWith('.jsonl'))
								.map(file => path.join(globalStoragePath, file));
							if (globalSessionFiles.length > 0) {
								this.log(`📄 Found ${globalSessionFiles.length} session files in ${pathName}/globalStorage/emptyWindowChatSessions`);
								sessionFiles.push(...globalSessionFiles);
							}
						} catch (readError) {
							this.warn(`Could not read global storage in ${globalStoragePath}: ${readError}`);
						}
					}
				} catch (checkError) {
					this.warn(`Could not check global storage path ${globalStoragePath}: ${checkError}`);
				}

				// GitHub Copilot Chat extension global storage
				const copilotChatGlobalPath = path.join(codeUserPath, 'globalStorage', 'github.copilot-chat');
				try {
					if (fs.existsSync(copilotChatGlobalPath)) {
						this.log(`📄 Scanning ${pathName}/globalStorage/github.copilot-chat`);
						this.scanDirectoryForSessionFiles(copilotChatGlobalPath, sessionFiles);
					}
				} catch (checkError) {
					this.warn(`Could not check Copilot Chat global storage path ${copilotChatGlobalPath}: ${checkError}`);
				}
			}

			// Check for Copilot CLI session-state directory (new location for agent mode sessions)
			const copilotCliSessionPath = path.join(os.homedir(), '.copilot', 'session-state');
			try {
				if (fs.existsSync(copilotCliSessionPath)) {
					try {
						const entries = fs.readdirSync(copilotCliSessionPath, { withFileTypes: true });

						// Collect flat .json/.jsonl files at the top level
						const cliSessionFiles = entries
							.filter(e => !e.isDirectory() && (e.name.endsWith('.json') || e.name.endsWith('.jsonl')))
							.map(e => path.join(copilotCliSessionPath, e.name));
						if (cliSessionFiles.length > 0) {
							this.log(`📄 Found ${cliSessionFiles.length} session files in Copilot CLI directory`);
							sessionFiles.push(...cliSessionFiles);
						}

						// Scan UUID subdirectories for events.jsonl (newer Copilot CLI format)
						const subDirs = entries.filter(e => e.isDirectory());
						let subDirSessionCount = 0;
						for (const subDir of subDirs) {
							const eventsFile = path.join(copilotCliSessionPath, subDir.name, 'events.jsonl');
							try {
								if (fs.existsSync(eventsFile)) {
									const stats = fs.statSync(eventsFile);
									if (stats.size > 0) {
										sessionFiles.push(eventsFile);
										subDirSessionCount++;
									}
								}
							} catch {
								// Ignore individual file access errors
							}
						}
						if (subDirSessionCount > 0) {
							this.log(`📄 Found ${subDirSessionCount} session files in Copilot CLI subdirectories`);
						}
					} catch (readError) {
						this.warn(`Could not read Copilot CLI session path in ${copilotCliSessionPath}: ${readError}`);
					}
				}
			} catch (checkError) {
				this.warn(`Could not check Copilot CLI session path ${copilotCliSessionPath}: ${checkError}`);
			}

			// Check for OpenCode session files
			// OpenCode stores session data in ~/.local/share/opencode/storage/session/
			const openCodeDataDir = this.getOpenCodeDataDir();
			try {
				const openCodeSessionDir = path.join(openCodeDataDir, 'storage', 'session');
				if (fs.existsSync(openCodeSessionDir)) {
					const scanOpenCodeDir = (dir: string) => {
						try {
							const entries = fs.readdirSync(dir, { withFileTypes: true });
							for (const entry of entries) {
								if (entry.isDirectory()) {
									scanOpenCodeDir(path.join(dir, entry.name));
								} else if (entry.name.startsWith('ses_') && entry.name.endsWith('.json')) {
									const fullPath = path.join(dir, entry.name);
									try {
										const stats = fs.statSync(fullPath);
										if (stats.size > 0) {
											sessionFiles.push(fullPath);
										}
									} catch {
										// Ignore file access errors
									}
								}
							}
						} catch {
							// Ignore directory access errors
						}
					};
					scanOpenCodeDir(openCodeSessionDir);
					const openCodeCount = sessionFiles.length - (sessionFiles.filter(f => !this.isOpenCodeSessionFile(f))).length;
					if (openCodeCount > 0) {
						this.log(`📄 Found ${openCodeCount} session files in OpenCode storage`);
					}
				}
			} catch (checkError) {
				this.warn(`Could not check OpenCode session path: ${checkError}`);
			}

			// Check for OpenCode sessions in SQLite database (opencode.db)
			// Newer OpenCode versions store sessions in SQLite instead of JSON files
			try {
				const openCodeDbPath = path.join(openCodeDataDir, 'opencode.db');
				if (fs.existsSync(openCodeDbPath)) {
					const existingSessionIds = new Set(
						sessionFiles
							.filter(f => this.isOpenCodeSessionFile(f))
							.map(f => this.getOpenCodeSessionId(f))
							.filter(Boolean)
					);
					const dbSessionIds = await this.discoverOpenCodeDbSessions();
					let dbNewCount = 0;
					for (const sessionId of dbSessionIds) {
						if (!existingSessionIds.has(sessionId)) {
							// Create virtual path for DB session
							sessionFiles.push(path.join(openCodeDataDir, `opencode.db#${sessionId}`));
							dbNewCount++;
						}
					}
					if (dbNewCount > 0) {
						this.log(`📄 Found ${dbNewCount} additional session(s) in OpenCode database`);
					}
				}
			} catch (dbError) {
				this.warn(`Could not read OpenCode database: ${dbError}`);
			}

			// Log summary
			this.log(`✨ Total: ${sessionFiles.length} session file(s) discovered`);
			if (sessionFiles.length === 0) {
				this.warn('⚠️ No session files found - Have you used GitHub Copilot Chat yet?');
			}

			// Update short-term cache
			this._sessionFilesCache = sessionFiles;
			this._sessionFilesCacheTime = Date.now();
		} catch (error) {
			this.error('Error getting session files:', error);
		}

		return sessionFiles;
	}

	/**
	 * Recursively scan a directory for session files (.json and .jsonl)
	 * 
	 * NOTE: Mirrors logic in .github/skills/copilot-log-analysis/session-file-discovery.js
	 */
	private scanDirectoryForSessionFiles(dir: string, sessionFiles: string[]): void {
		try {
			const entries = fs.readdirSync(dir, { withFileTypes: true });
			for (const entry of entries) {
				const fullPath = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					this.scanDirectoryForSessionFiles(fullPath, sessionFiles);
				} else if (entry.name.endsWith('.json') || entry.name.endsWith('.jsonl')) {
					// Skip known non-session files (embeddings, indexes, etc.)
					if (this.isNonSessionFile(entry.name)) {
						continue;
					}
					// Only add files that look like session files (have reasonable content)
					try {
						const stats = fs.statSync(fullPath);
						if (stats.size > 0) {
							sessionFiles.push(fullPath);
						}
					} catch (e) {
						// Ignore file access errors
					}
				}
			}
		} catch (error) {
			this.warn(`Could not scan directory ${dir}: ${error}`);
		}
	}

	/**
	 * Check if a filename is a known non-session file that should be excluded
	 */
	private isNonSessionFile(filename: string): boolean {
		const nonSessionFilePatterns = [
			'embeddings',       // commandEmbeddings.json, settingEmbeddings.json
			'index',            // index files
			'cache',            // cache files
			'preferences',
			'settings',
			'config',
			'workspacesessions', // copilot.cli.workspaceSessions.*.json (index files with session ID lists)
			'globalsessions',    // copilot.cli.oldGlobalSessions.json (index files)
			'api.json'           // api.json (API configuration)
		];
		const lowerFilename = filename.toLowerCase();
		return nonSessionFilePatterns.some(pattern => lowerFilename.includes(pattern));
	}

	private async estimateTokensFromSession(sessionFilePath: string): Promise<{ tokens: number; thinkingTokens: number; actualTokens: number }> {
		try {
			// Handle OpenCode sessions - they have actual token counts in message files
			if (this.isOpenCodeSessionFile(sessionFilePath)) {
				const result = await this.getTokensFromOpenCodeSession(sessionFilePath);
				return { ...result, actualTokens: result.tokens }; // OpenCode has actual counts
			}

			const fileContent = await fs.promises.readFile(sessionFilePath, 'utf8');

			// Check if this is a UUID-only file (new Copilot CLI format)
			if (this.isUuidPointerFile(fileContent)) {
				return { tokens: 0, thinkingTokens: 0, actualTokens: 0 };
			}

			// Handle .jsonl files OR .json files with JSONL content (each line is a separate JSON object)
			const isJsonlContent = sessionFilePath.endsWith('.jsonl') || this.isJsonlContent(fileContent);
			if (isJsonlContent) {
				return this.estimateTokensFromJsonlSession(fileContent);
			}

			// Handle regular .json files
			const sessionContent = JSON.parse(fileContent);
			let totalInputTokens = 0;
			let totalOutputTokens = 0;
			let totalThinkingTokens = 0;
			let totalActualTokens = 0;

			if (sessionContent.requests && Array.isArray(sessionContent.requests)) {
				for (const request of sessionContent.requests) {
					// Estimate tokens from user message (input)
					if (request.message && request.message.parts) {
						for (const part of request.message.parts) {
							if (part.text) {
								totalInputTokens += this.estimateTokensFromText(part.text);
							}
						}
					}

					// Estimate tokens from assistant response (output)
					if (request.response && Array.isArray(request.response)) {
						for (const responseItem of request.response) {
							// Separate thinking tokens
							if (responseItem.kind === 'thinking' && responseItem.value) {
								totalThinkingTokens += this.estimateTokensFromText(responseItem.value, this.getModelFromRequest(request));
								continue;
							}
							if (responseItem.value) {
								totalOutputTokens += this.estimateTokensFromText(responseItem.value, this.getModelFromRequest(request));
							}
						}
					}

					// Extract actual token counts from LLM API usage data
					if (request.result?.usage) {
						const u = request.result.usage;
						const prompt = typeof u.promptTokens === 'number' ? u.promptTokens : 0;
						const completion = typeof u.completionTokens === 'number' ? u.completionTokens : 0;
						totalActualTokens += prompt + completion;
					}
				}
			}

			return { tokens: totalInputTokens + totalOutputTokens + totalThinkingTokens, thinkingTokens: totalThinkingTokens, actualTokens: totalActualTokens };
		} catch (error) {
			this.warn(`Error parsing session file ${sessionFilePath}: ${error}`);
			return { tokens: 0, thinkingTokens: 0, actualTokens: 0 };
		}
	}

	/**
	 * Estimate tokens from a JSONL session file (used by Copilot CLI/Agent mode and VS Code incremental format)
	 * Each line is a separate JSON object representing an event in the session
	 */
	private estimateTokensFromJsonlSession(fileContent: string): { tokens: number; thinkingTokens: number; actualTokens: number } {
		let totalTokens = 0;
		let totalThinkingTokens = 0;
		const lines = fileContent.trim().split('\n');

		// For delta-based formats, reconstruct full state to reliably extract actual usage.
		// Usage data can arrive at many different delta path levels, so line-by-line matching
		// is fragile. Reconstructing the state (like the logviewer does) is the reliable approach.
		let sessionState: any = {};
		let isDeltaBased = false;

		for (const line of lines) {
			if (!line.trim()) { continue; }

			try {
				const event = JSON.parse(line);

				// Detect and reconstruct delta-based format in parallel with estimation
				if (typeof event.kind === 'number') {
					isDeltaBased = true;
					sessionState = this.applyDelta(sessionState, event);
				}

				// Handle Copilot CLI event types
				if (event.type === 'user.message' && event.data?.content) {
					totalTokens += this.estimateTokensFromText(event.data.content);
				} else if (event.type === 'assistant.message' && event.data?.content) {
					totalTokens += this.estimateTokensFromText(event.data.content);
				} else if (event.type === 'tool.result' && event.data?.output) {
					totalTokens += this.estimateTokensFromText(event.data.output);
				} else if (event.content) {
					// Fallback for other formats that might have content
					totalTokens += this.estimateTokensFromText(event.content);
				}

				// Handle VS Code incremental format (kind: 2 with requests or response)
				if (event.kind === 2 && event.k?.[0] === 'requests' && Array.isArray(event.v)) {
					for (const request of event.v) {
						if (request.message?.text) {
							totalTokens += this.estimateTokensFromText(request.message.text);
						}
					}
				}

				if (event.kind === 2 && event.k?.includes('response') && Array.isArray(event.v)) {
					for (const responseItem of event.v) {
						// Separate thinking tokens
						if (responseItem.kind === 'thinking' && responseItem.value) {
							totalThinkingTokens += this.estimateTokensFromText(responseItem.value);
							continue;
						}
						if (responseItem.value) {
							totalTokens += this.estimateTokensFromText(responseItem.value);
						} else if (responseItem.kind === 'markdownContent' && responseItem.content?.value) {
							totalTokens += this.estimateTokensFromText(responseItem.content.value);
						}
					}
				}
			} catch (e) {
				// Skip malformed lines
			}
		}

		// Extract actual tokens from the reconstructed state (handles all delta path patterns)
		let totalActualTokens = 0;
		if (isDeltaBased && sessionState.requests && Array.isArray(sessionState.requests)) {
			for (const request of sessionState.requests) {
				if (request?.result?.usage) {
					const u = request.result.usage;
					const prompt = typeof u.promptTokens === 'number' ? u.promptTokens : 0;
					const completion = typeof u.completionTokens === 'number' ? u.completionTokens : 0;
					totalActualTokens += prompt + completion;
				}
			}
		}

		return { tokens: totalTokens + totalThinkingTokens, thinkingTokens: totalThinkingTokens, actualTokens: totalActualTokens };
	}

	/**
	 * Get OpenCode messages for a session, trying DB first then JSON files.
	 */
	private async getOpenCodeMessagesForSession(sessionFilePath: string): Promise<any[]> {
		const sessionId = this.getOpenCodeSessionId(sessionFilePath);
		if (!sessionId) { return []; }
		if (this.isOpenCodeDbSession(sessionFilePath)) {
			return this.readOpenCodeDbMessages(sessionId);
		}
		// Try DB first (may have newer data), fall back to JSON files
		const dbMessages = await this.readOpenCodeDbMessages(sessionId);
		if (dbMessages.length > 0) { return dbMessages; }
		return this.readOpenCodeMessages(sessionId);
	}

	/**
	 * Get OpenCode parts for a message, trying DB first then JSON files.
	 */
	private async getOpenCodePartsForMessage(messageId: string): Promise<any[]> {
		const dbParts = await this.readOpenCodeDbParts(messageId);
		if (dbParts.length > 0) { return dbParts; }
		return this.readOpenCodeParts(messageId);
	}

	/**
	 * Extract actual token counts from an OpenCode session.
	 * OpenCode stores actual token counts in message files (tokens.input, tokens.output, tokens.reasoning).
	 */
	private async getTokensFromOpenCodeSession(sessionFilePath: string): Promise<{ tokens: number; thinkingTokens: number }> {
		const messages = await this.getOpenCodeMessagesForSession(sessionFilePath);
		let thinkingTokens = 0;

		// OpenCode messages have a cumulative `total` field that grows with each API call.
		// The last assistant message's `total` is the session total.
		// Summing input+output across messages would over-count because each API call
		// re-sends the full conversation context as input.
		let sessionTotal = 0;
		for (const msg of messages) {
			if (msg.role === 'assistant' && msg.tokens) {
				if (typeof msg.tokens.total === 'number') {
					sessionTotal = msg.tokens.total; // cumulative — last one wins
				}
				thinkingTokens += msg.tokens.reasoning || 0;
			}
		}

		return { tokens: sessionTotal, thinkingTokens };
	}

	/**
	 * Extract the session ID from an OpenCode session file path.
	 * Handles both JSON file paths and DB virtual paths:
	 * - ".../storage/session/global/ses_abc123.json" -> "ses_abc123"
	 * - ".../opencode.db#ses_abc123" -> "ses_abc123"
	 */
	private getOpenCodeSessionId(sessionFilePath: string): string | null {
		// Handle DB virtual path: opencode.db#ses_<id>
		const hashIdx = sessionFilePath.indexOf('opencode.db#');
		if (hashIdx !== -1) {
			return sessionFilePath.substring(hashIdx + 'opencode.db#'.length);
		}
		const basename = path.basename(sessionFilePath, '.json');
		return basename.startsWith('ses_') ? basename : null;
	}

	/**
	 * Count interactions in an OpenCode session (number of user messages).
	 */
	private async countOpenCodeInteractions(sessionFilePath: string): Promise<number> {
		const messages = await this.getOpenCodeMessagesForSession(sessionFilePath);
		return messages.filter(m => m.role === 'user').length;
	}

	/**
	 * Get model usage from an OpenCode session.
	 * Extracts model info from assistant message files.
	 */
	private async getOpenCodeModelUsage(sessionFilePath: string): Promise<ModelUsage> {
		const modelUsage: ModelUsage = {};
		const messages = await this.getOpenCodeMessagesForSession(sessionFilePath);

		// OpenCode messages have a cumulative `total` field. To get per-turn tokens,
		// compute deltas between consecutive user turns using the last assistant message's total.
		let prevTotal = 0;
		for (let i = 0; i < messages.length; i++) {
			const msg = messages[i];
			if (msg.role !== 'user') { continue; }
			// Find all assistant messages for this turn
			const turnAssistantMsgs = messages.filter((m, idx) => idx > i && m.role === 'assistant' && m.parentID === msg.id);
			if (turnAssistantMsgs.length === 0) { continue; }

			// Get cumulative total from the last assistant message in this turn
			let turnCumTotal = prevTotal;
			for (const am of turnAssistantMsgs) {
				if (typeof am.tokens?.total === 'number') {
					turnCumTotal = Math.max(turnCumTotal, am.tokens.total);
				}
			}
			const turnTokens = turnCumTotal - prevTotal;
			if (turnTokens <= 0) { prevTotal = turnCumTotal; continue; }

			// Attribute to the model used in this turn (from first assistant message)
			const model = turnAssistantMsgs[0].modelID || turnAssistantMsgs[0].model?.modelID || 'unknown';
			if (!modelUsage[model]) {
				modelUsage[model] = { inputTokens: 0, outputTokens: 0 };
			}
			// Output tokens are the sum of actual output+reasoning across the turn's API calls
			const turnOutput = turnAssistantMsgs.reduce((sum, m) => sum + (m.tokens?.output || 0) + (m.tokens?.reasoning || 0), 0);
			const turnInput = Math.max(0, turnTokens - turnOutput);
			modelUsage[model].inputTokens += turnInput;
			modelUsage[model].outputTokens += turnOutput;

			prevTotal = turnCumTotal;
		}

		return modelUsage;
	}

	/**
	 * Get all session data from an OpenCode session in one call (for backend sync).
	 * Returns tokens, interactions, model usage, and timestamp.
	 * Includes per-model interaction counts in modelUsage.
	 */
	private async getOpenCodeSessionData(sessionFilePath: string): Promise<{ tokens: number; interactions: number; modelUsage: ModelUsage & { [key: string]: { inputTokens: number; outputTokens: number; interactions?: number } }; timestamp: number }> {
		const messages = await this.getOpenCodeMessagesForSession(sessionFilePath);
		
		// Get timestamp from the first message
		let timestamp = Date.now();
		if (messages.length > 0 && messages[0].time_created) {
			timestamp = messages[0].time_created;
		}

		// Get tokens
		const { tokens } = await this.getTokensFromOpenCodeSession(sessionFilePath);

		// Get interactions (total count)
		const interactions = await this.countOpenCodeInteractions(sessionFilePath);

		// Get model usage with per-model interaction counts
		const baseModelUsage = await this.getOpenCodeModelUsage(sessionFilePath);
		
		// Count interactions per model (each user turn -> 1 interaction for the model that responded)
		const modelInteractions: { [model: string]: number } = {};
		let prevTotal = 0;
		for (let i = 0; i < messages.length; i++) {
			const msg = messages[i];
			if (msg.role !== 'user') { continue; }
			const turnAssistantMsgs = messages.filter((m, idx) => idx > i && m.role === 'assistant' && m.parentID === msg.id);
			if (turnAssistantMsgs.length === 0) { continue; }
			
			const model = turnAssistantMsgs[0].modelID || turnAssistantMsgs[0].model?.modelID || 'unknown';
			modelInteractions[model] = (modelInteractions[model] || 0) + 1;
		}
		
		// Merge interaction counts into model usage
		const modelUsage: any = {};
		for (const [model, usage] of Object.entries(baseModelUsage)) {
			modelUsage[model] = {
				...usage,
				interactions: modelInteractions[model] || 0
			};
		}

		return { tokens, interactions, modelUsage, timestamp };
	}

	private getModelFromRequest(request: any): string {
		// Try to determine model from request metadata (most reliable source)
		// First check the top-level modelId field (VS Code format)
		if (request.modelId) {
			// Remove "copilot/" prefix if present
			return request.modelId.replace(/^copilot\//, '');
		}

		if (request.result && request.result.metadata && request.result.metadata.modelId) {
			return request.result.metadata.modelId.replace(/^copilot\//, '');
		}

		// Build a lookup map from display names to model IDs from modelPricing.json
		if (request.result && request.result.details) {
			// Create reverse lookup: displayName -> modelId
			const displayNameToModelId: { [displayName: string]: string } = {};
			for (const [modelId, pricing] of Object.entries(this.modelPricing)) {
				if (pricing.displayNames) {
					for (const displayName of pricing.displayNames) {
						displayNameToModelId[displayName] = modelId;
					}
				}
			}

			// Check which display name appears in the details
			// Sort by length descending to match longer names first (e.g., "Gemini 3 Pro (Preview)" before "Gemini 3 Pro")
			const sortedDisplayNames = Object.keys(displayNameToModelId).sort((a, b) => b.length - a.length);
			for (const displayName of sortedDisplayNames) {
				if (request.result.details.includes(displayName)) {
					return displayNameToModelId[displayName];
				}
			}
		}

		return 'gpt-4'; // default
	}

	/**
	 * Detect if file content is JSONL format (multiple JSON objects, one per line)
	 * This handles cases where .json files actually contain JSONL content
	 */
	private isJsonlContent(content: string): boolean {
		const trimmed = content.trim();
		// JSONL typically has multiple lines, each starting with { and ending with }
		if (!trimmed.includes('\n')) {
			return false; // Single line - not JSONL
		}
		const lines = trimmed.split('\n').filter(l => l.trim());
		if (lines.length < 2) {
			return false; // Need multiple lines for JSONL
		}
		// Check if first two non-empty lines look like separate JSON objects
		const firstLine = lines[0].trim();
		const secondLine = lines[1].trim();
		return firstLine.startsWith('{') && firstLine.endsWith('}') &&
			secondLine.startsWith('{') && secondLine.endsWith('}');
	}

	/**
	 * Check if file content is a UUID-only pointer file (new Copilot CLI format).
	 * These files contain only a session ID instead of actual session data.
	 * @param content The file content to check
	 * @returns true if the content is a UUID-only pointer file
	 */
	private isUuidPointerFile(content: string): boolean {
		const trimmedContent = content.trim();
		return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(trimmedContent);
	}

	/**
	 * Apply a delta to reconstruct session state from delta-based JSONL format.
	 * VS Code Insiders uses this format where:
	 * - kind: 0 = initial state (full replacement)
	 * - kind: 1 = update value at key path
	 * - kind: 2 = append to array at key path
	 * - k = key path (array of strings)
	 * - v = value
	 */
	private applyDelta(state: any, delta: any): any {
		if (typeof delta !== 'object' || delta === null) {
			return state;
		}

		const { kind, k, v } = delta;

		if (kind === 0) {
			// Initial state - full replacement
			return v;
		}

		if (!Array.isArray(k) || k.length === 0) {
			return state;
		}

		const pathArr = k.map(String);
		let root = typeof state === 'object' && state !== null ? state : {};
		let current: any = root;

		// Traverse to the parent of the target location
		for (let i = 0; i < pathArr.length - 1; i++) {
			const seg = pathArr[i];
			const nextSeg = pathArr[i + 1];
			const wantsArray = /^\d+$/.test(nextSeg);

			if (Array.isArray(current)) {
				const idx = Number(seg);
				if (!current[idx] || typeof current[idx] !== 'object') {
					current[idx] = wantsArray ? [] : {};
				}
				current = current[idx];
			} else {
				if (!current[seg] || typeof current[seg] !== 'object') {
					current[seg] = wantsArray ? [] : {};
				}
				current = current[seg];
			}
		}

		const lastSeg = pathArr[pathArr.length - 1];

		if (kind === 1) {
			// Set value at key path
			if (Array.isArray(current)) {
				current[Number(lastSeg)] = v;
			} else {
				current[lastSeg] = v;
			}
			return root;
		}

		if (kind === 2) {
			// Append value(s) to array at key path
			let target: any[];
			if (Array.isArray(current)) {
				const idx = Number(lastSeg);
				if (!Array.isArray(current[idx])) {
					current[idx] = [];
				}
				target = current[idx];
			} else {
				if (!Array.isArray(current[lastSeg])) {
					current[lastSeg] = [];
				}
				target = current[lastSeg];
			}

			if (Array.isArray(v)) {
				target.push(...v);
			} else {
				target.push(v);
			}
			return root;
		}

		return root;
	}

	private getModelTier(modelId: string): 'standard' | 'premium' | 'unknown' {
		// Determine tier based on multiplier: 0 = standard, >0 = premium
		// Look up from modelPricing.json
		const pricingInfo = this.modelPricing[modelId];
		if (pricingInfo && typeof pricingInfo.multiplier === 'number') {
			return pricingInfo.multiplier === 0 ? 'standard' : 'premium';
		}

		// Fallback: try to match partial model names
		for (const [key, value] of Object.entries(this.modelPricing)) {
			if (modelId.includes(key) || key.includes(modelId)) {
				if (typeof value.multiplier === 'number') {
					return value.multiplier === 0 ? 'standard' : 'premium';
				}
			}
		}

		return 'unknown';
	}

	private estimateTokensFromText(text: string, model: string = 'gpt-4'): number {
		// Token estimation based on character count and model
		let tokensPerChar = 0.25; // default

		// Find matching model
		for (const [modelKey, ratio] of Object.entries(this.tokenEstimators)) {
			if (model.includes(modelKey) || model.includes(modelKey.replace('-', ''))) {
				tokensPerChar = ratio;
				break;
			}
		}

		return Math.ceil(text.length * tokensPerChar);
	}

	public async showDetails(): Promise<void> {
		this.log('📊 Opening Details panel');

		// If panel already exists, just reveal it
		if (this.detailsPanel) {
			this.detailsPanel.reveal();
			this.log('📊 Details panel revealed (already exists)');
			return;
		}

		// Use cached stats if available, otherwise calculate
		let stats = this.lastDetailedStats;
		if (!stats) {
			this.log('No cached stats available, calculating...');
			stats = await this.updateTokenStats();
			if (!stats) {
				return;
			}
		}

		// Create a small webview panel
		this.detailsPanel = vscode.window.createWebviewPanel(
			'copilotTokenDetails',
			'GitHub Copilot Token Usage',
			{
				viewColumn: vscode.ViewColumn.One,
				preserveFocus: true
			},
			{
				enableScripts: true,
				retainContextWhenHidden: false,
				localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')]
			}
		);

		this.log('✅ Details panel created successfully');

		// Set the HTML content
		this.detailsPanel.webview.html = this.getDetailsHtml(this.detailsPanel.webview, stats);

		// Handle messages from the webview
		this.detailsPanel.webview.onDidReceiveMessage(async (message) => {
			switch (message.command) {
				case 'refresh':
					await this.refreshDetailsPanel();
					break;
				case 'showChart':
					await this.showChart();
					break;
				case 'showUsageAnalysis':
					await this.showUsageAnalysis();
					break;
				case 'showDiagnostics':
					await this.showDiagnosticReport();
					break;
				case 'showMaturity':
					await this.showMaturity();
					break;
				case 'showDashboard':
					await this.showDashboard();
					break;
			}
		});

		// Handle panel disposal
		this.detailsPanel.onDidDispose(() => {
			this.log('📊 Details panel closed');
			this.detailsPanel = undefined;
		});
	}

	public async showChart(): Promise<void> {
		this.log('📈 Opening Chart view');

		// If panel already exists, just reveal it
		if (this.chartPanel) {
			this.chartPanel.reveal();
			this.log('📈 Chart view revealed (already exists)');
			return;
		}

		// Get daily stats
		const dailyStats = await this.calculateDailyStats();

		// Create webview panel
		this.chartPanel = vscode.window.createWebviewPanel(
			'copilotTokenChart',
			'Token Usage Over Time',
			{
				viewColumn: vscode.ViewColumn.One,
				preserveFocus: true
			},
			{
				enableScripts: true,
				retainContextWhenHidden: false,
				localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview')]
			}
		);

		this.log('✅ Chart view created successfully');

		// Set the HTML content
		this.chartPanel.webview.html = this.getChartHtml(this.chartPanel.webview, dailyStats);

		// Handle messages from the webview
		this.chartPanel.webview.onDidReceiveMessage(async (message) => {
			switch (message.command) {
				case 'refresh':
					await this.refreshChartPanel();
					break;
				case 'showDetails':
					await this.showDetails();
					break;
				case 'showUsageAnalysis':
					await this.showUsageAnalysis();
					break;
				case 'showDiagnostics':
					await this.showDiagnosticReport();
					break;
				case 'showMaturity':
					await this.showMaturity();
					break;
				case 'showDashboard':
					await this.showDashboard();
					break;
			}
		});

		// Handle panel disposal
		this.chartPanel.onDidDispose(() => {
			this.log('📈 Chart view closed');
			this.chartPanel = undefined;
		});
	}

	public async showUsageAnalysis(): Promise<void> {
		this.log('📊 Opening Usage Analysis dashboard');

		// If panel already exists, dispose it and recreate with fresh data
		if (this.analysisPanel) {
			this.log('📊 Closing existing panel to refresh data...');
			this.analysisPanel.dispose();
			this.analysisPanel = undefined;
		}

		// Get usage analysis stats (use cached version for fast loading)
		const analysisStats = await this.calculateUsageAnalysisStats(true);

		// Create webview panel
		this.analysisPanel = vscode.window.createWebviewPanel(
			'copilotUsageAnalysis',
			'Copilot Usage Analysis',
			{
				viewColumn: vscode.ViewColumn.One,
				preserveFocus: true
			},
			{
				enableScripts: true,
				retainContextWhenHidden: false,
				localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview')]
			}
		);

		this.log('✅ Usage Analysis dashboard created successfully');

		// Set the HTML content
		this.analysisPanel.webview.html = this.getUsageAnalysisHtml(this.analysisPanel.webview, analysisStats);

		// Handle messages from the webview
		this.analysisPanel.webview.onDidReceiveMessage(async (message) => {
			switch (message.command) {
				case 'refresh':
					await this.refreshAnalysisPanel();
					break;
				case 'showDetails':
					await this.showDetails();
					break;
				case 'showChart':
					await this.showChart();
					break;
				case 'showDiagnostics':
					await this.showDiagnosticReport();
					break;
				case 'showMaturity':
					await this.showMaturity();
					break;
				case 'showDashboard':
					await this.showDashboard();
					break;
			}
		});

		// Handle panel disposal
		this.analysisPanel.onDidDispose(() => {
			this.log('📊 Usage Analysis dashboard closed');
			this.analysisPanel = undefined;
		});
	}

	public async showLogViewer(sessionFilePath: string): Promise<void> {
		// Close existing log viewer panel if open
		if (this.logViewerPanel) {
			this.logViewerPanel.dispose();
			this.logViewerPanel = undefined;
		}

		// Get session log data with chat turns
		const logData = await this.getSessionLogData(sessionFilePath);

		// Create webview panel
		this.logViewerPanel = vscode.window.createWebviewPanel(
			'copilotLogViewer',
			`Session: ${logData.title || path.basename(sessionFilePath)}`,
			{
				viewColumn: vscode.ViewColumn.One,
				preserveFocus: false
			},
			{
				enableScripts: true,
				retainContextWhenHidden: false,
				localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview')]
			}
		);

		// Set the HTML content
		this.logViewerPanel.webview.html = this.getLogViewerHtml(this.logViewerPanel.webview, logData);

		// Handle messages from the webview
		this.logViewerPanel.webview.onDidReceiveMessage(async (message) => {
			switch (message.command) {
				case 'openRawFile':
					try {
						await vscode.window.showTextDocument(vscode.Uri.file(sessionFilePath));
					} catch (err) {
						vscode.window.showErrorMessage('Could not open raw file: ' + sessionFilePath);
					}
					break;
				case 'showToolCallPretty': {
					const { turnNumber, toolCallIdx } = message as { turnNumber: number; toolCallIdx: number };
					this.log(`showToolCallPretty: turn=${turnNumber}, toolCallIdx=${toolCallIdx}, file=${sessionFilePath}`);
					try {
						const turn = logData.turns.find(t => t.turnNumber === turnNumber);
						const turnIndex = logData.turns.findIndex(t => t.turnNumber === turnNumber);
						const toolCall = turn?.toolCalls?.[toolCallIdx];
						if (!toolCall) {
							this.log('showToolCallPretty: tool call not found in session data');
							vscode.window.showInformationMessage('Tool call not found in session data.');
							break;
						}

						const safeParse = (text?: string) => {
							if (!text) { return text; }
							try { return JSON.parse(text); } catch { return text; }
						};

						const mapTurnForContext = (t?: ChatTurn) => t ? {
							turnNumber: t.turnNumber,
							timestamp: t.timestamp,
							mode: t.mode,
							model: t.model,
							userMessage: t.userMessage,
							assistantResponse: t.assistantResponse,
							inputTokensEstimate: t.inputTokensEstimate,
							outputTokensEstimate: t.outputTokensEstimate,
							toolCalls: t.toolCalls?.map((tc, idx) => ({ index: idx, toolName: tc.toolName, arguments: tc.arguments, result: tc.result }))
						} : undefined;

						const mapToolCallForContext = (tc: { toolName: string; arguments?: string; result?: string }, idx: number, parentTurn?: ChatTurn) => ({
							turn: parentTurn?.turnNumber ?? turnNumber,
							toolCallIdx: idx,
							toolName: tc.toolName,
							model: parentTurn?.model,
							mode: parentTurn?.mode,
							timestamp: parentTurn?.timestamp,
							userMessage: parentTurn?.userMessage,
							assistantResponse: parentTurn?.assistantResponse,
							inputTokensEstimate: parentTurn?.inputTokensEstimate,
							outputTokensEstimate: parentTurn?.outputTokensEstimate,
							argumentsRaw: tc.arguments ?? null,
							argumentsParsed: safeParse(tc.arguments),
							resultRaw: tc.result ?? null,
							resultParsed: safeParse(tc.result)
						});

						const sanitize = (name: string) => name.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 60) || 'toolcall';
						const prettyName = sanitize(`${toolCall.toolName || 'tool'}-turn-${turnNumber}-call-${toolCallIdx}`);

						const prettyPayload = {
							turnBefore: turnIndex > 0 ? mapTurnForContext(logData.turns[turnIndex - 1]) : undefined,
							toolCall: mapToolCallForContext(toolCall, toolCallIdx, turn),
							turnAfter: turnIndex >= 0 && turnIndex < logData.turns.length - 1 ? mapTurnForContext(logData.turns[turnIndex + 1]) : undefined
						};

						const prettyUri = vscode.Uri.parse(`untitled:${prettyName}.json`);
						const openDoc = vscode.workspace.textDocuments.find(d => d.uri.toString() === prettyUri.toString());
						if (openDoc) {
							await vscode.window.showTextDocument(openDoc, { preview: true });
							break;
						}

						const doc = await vscode.workspace.openTextDocument(prettyUri);
						const editor = await vscode.window.showTextDocument(doc, { preview: true });
						const jsonText = JSON.stringify(prettyPayload, null, 2);
						await editor.edit((editBuilder) => {
							editBuilder.insert(new vscode.Position(0, 0), jsonText);
						});
						await vscode.languages.setTextDocumentLanguage(doc, 'json');
					} catch (err) {
						this.error('showToolCallPretty: error', err);
						vscode.window.showErrorMessage('Could not open formatted tool call.');
					}
					break;
				}
				case 'revealToolCallSource': {
					const { turnNumber, toolCallIdx } = message as { turnNumber: number; toolCallIdx: number };
					this.log(`revealToolCallSource: turn=${turnNumber}, toolCallIdx=${toolCallIdx}, file=${sessionFilePath}`);
					try {
						const turn = logData.turns.find(t => t.turnNumber === turnNumber);
						const toolCall = turn?.toolCalls?.[toolCallIdx];
						if (!toolCall) {
							this.log('revealToolCallSource: tool call not found in session data');
							vscode.window.showInformationMessage('Tool call not found in session data.');
							break;
						}

						const fileContent = await fs.promises.readFile(sessionFilePath, 'utf8');
						const searchTerm = toolCall.toolName || '';
						const matchIdx = searchTerm ? fileContent.indexOf(searchTerm) : -1;
						this.log(`revealToolCallSource: searchTerm='${searchTerm}', matchIdx=${matchIdx}`);

						const doc = await vscode.workspace.openTextDocument(sessionFilePath);
						const editor = await vscode.window.showTextDocument(doc);

						if (matchIdx >= 0) {
							const pos = doc.positionAt(matchIdx);
							editor.selection = new vscode.Selection(pos, pos);
							editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
						} else {
							vscode.window.showInformationMessage('Opened session file, but could not locate this tool call text.');
						}
					} catch (err) {
						this.error('revealToolCallSource: error', err);
						vscode.window.showErrorMessage('Could not reveal tool call in file.');
					}
					break;
				}
				case 'showDiagnostics':
					await this.showDiagnosticReport();
					break;
				case 'showDetails':
					await this.showDetails();
					break;
				case 'showUsageAnalysis':
					await this.showUsageAnalysis();
					break;
				case 'showMaturity':
					await this.showMaturity();
					break;
			}
		});

		// Handle panel disposal
		this.logViewerPanel.onDidDispose(() => {
			this.logViewerPanel = undefined;
		});
	}

	/**
	 * Opens a JSONL file in a formatted view with array brackets and commas.
	 * Does not modify the original file.
	 */
	public async showFormattedJsonlFile(sessionFilePath: string): Promise<void> {
		try {
			// Read the file content
			const fileContent = await fs.promises.readFile(sessionFilePath, 'utf-8');

			// Check if this is a UUID-only file (new Copilot CLI format)
			if (this.isUuidPointerFile(fileContent)) {
				vscode.window.showInformationMessage(
					`This file contains only a session ID (${fileContent.trim()}). The actual session data is stored elsewhere in the Copilot CLI format.`
				);
				return;
			}

			// Parse JSONL into array of objects
			const lines = fileContent.trim().split('\n').filter(line => line.trim().length > 0);
			const jsonObjects: unknown[] = [];

			for (let i = 0; i < lines.length; i++) {
				try {
					const obj = JSON.parse(lines[i]);
					jsonObjects.push(obj);
				} catch (e) {
					// Skip malformed lines with detailed warning
					this.warn(`Skipping malformed line ${i + 1} in ${sessionFilePath}: ${e}`);
				}
			}

			// Format as JSON array
			const formattedJson = JSON.stringify(jsonObjects, null, 2);

			// Create an untitled document with the formatted content
			const fileName = path.basename(sessionFilePath, path.extname(sessionFilePath));
			const prettyUri = vscode.Uri.parse(`untitled:${fileName}-formatted.json`);

			// Check if this document is already open and close it to refresh
			const openDoc = vscode.workspace.textDocuments.find(d => d.uri.toString() === prettyUri.toString());
			if (openDoc) {
				// Close the existing document so we can create a fresh one with updated content
				const editor = vscode.window.visibleTextEditors.find(e => e.document === openDoc);
				if (editor) {
					await vscode.window.showTextDocument(openDoc, editor.viewColumn);
					await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
				}
			}

			// Create and open the document
			const doc = await vscode.workspace.openTextDocument(prettyUri);
			const editor = await vscode.window.showTextDocument(doc, { preview: true });

			// Insert the formatted JSON
			await editor.edit((editBuilder) => {
				editBuilder.insert(new vscode.Position(0, 0), formattedJson);
			});

			// Set language mode to JSON for syntax highlighting
			await vscode.languages.setTextDocumentLanguage(doc, 'json');

		} catch (error) {
			this.error(`Error formatting JSONL file ${sessionFilePath}:`, error);
			throw error;
		}
	}

	private getLogViewerHtml(webview: vscode.Webview, logData: SessionLogData): string {
		const nonce = this.getNonce();
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'logviewer.js'));

		const csp = [
			`default-src 'none'`,
			`img-src ${webview.cspSource} https: data:`,
			`style-src 'unsafe-inline' ${webview.cspSource}`,
			`font-src ${webview.cspSource} https: data:`,
			`script-src 'nonce-${nonce}'`
		].join('; ');

		const initialData = JSON.stringify(logData).replace(/</g, '\\u003c');

		return `<!DOCTYPE html>
		<html lang="en">
		<head>
			<meta charset="UTF-8" />
			<meta name="viewport" content="width=device-width, initial-scale=1.0" />
			<meta http-equiv="Content-Security-Policy" content="${csp}" />
			<title>Session Log Viewer</title>
		</head>
		<body>
			<div id="root"></div>
			<script nonce="${nonce}">window.__INITIAL_LOGDATA__ = ${initialData};</script>
			<script nonce="${nonce}" src="${scriptUri}"></script>
		</body>
		</html>`;
	}

	private async refreshDetailsPanel(): Promise<void> {
		if (!this.detailsPanel) {
			return;
		}

		this.log('🔄 Refreshing Details panel');
		// Update token stats and refresh the webview content
		const stats = await this.updateTokenStats();
		if (stats) {
			this.detailsPanel.webview.html = this.getDetailsHtml(this.detailsPanel.webview, stats);
			this.log('✅ Details panel refreshed');
		}
	}

	private async refreshChartPanel(): Promise<void> {
		if (!this.chartPanel) {
			return;
		}

		this.log('🔄 Refreshing Chart view');
		// Refresh all stats so the status bar and tooltip stay in sync
		await this.updateTokenStats();
		this.log('✅ Chart view refreshed');
	}

	private async refreshAnalysisPanel(): Promise<void> {
		if (!this.analysisPanel) {
			return;
		}

		this.log('🔄 Refreshing Usage Analysis dashboard');
		// Force fresh usage analysis stats and re-render the webview
		const analysisStats = await this.calculateUsageAnalysisStats(false);
		this.analysisPanel.webview.html = this.getUsageAnalysisHtml(this.analysisPanel.webview, analysisStats);
		// Refresh token stats so the status bar and tooltip stay in sync
		await this.updateTokenStats();
		this.log('✅ Usage Analysis dashboard refreshed');
	}

	// ── Maturity / Fluency Score ───────────────────────────────────────

	/**
	 * Calculate maturity scores across 6 categories using last 30 days of usage data.
	 * Each category is scored 1-4 based on threshold rules.
	 * Overall stage = median of the 6 category scores.
	 * @param useCache If true, use cached usage stats. If false, force recalculation.
	 */
	private async calculateMaturityScores(useCache = true): Promise<{
		overallStage: number;
		overallLabel: string;
		categories: { category: string; icon: string; stage: number; evidence: string[]; tips: string[] }[];
		period: UsageAnalysisPeriod;
		lastUpdated: string;
	}> {
		const stats = await this.calculateUsageAnalysisStats(useCache);
		const p = stats.last30Days;

		const stageLabels: Record<number, string> = {
			1: 'Stage 1: Copilot Skeptic',
			2: 'Stage 2: Copilot Explorer',
			3: 'Stage 3: Copilot Collaborator',
			4: 'Stage 4: Copilot Strategist'
		};

		// ---------- 1. Prompt Engineering ----------
		const peEvidence: string[] = [];
		const peTips: string[] = [];
		let peStage = 1;

		const totalInteractions = p.modeUsage.ask + p.modeUsage.edit + p.modeUsage.agent;
		if (totalInteractions > 0) {
			peEvidence.push(`${totalInteractions} total interactions`);
		}
		if (p.modeUsage.ask > 0) {
			peEvidence.push(`${p.modeUsage.ask} ask-mode conversations`);
		}
		if (p.modeUsage.agent > 0) {
			peEvidence.push(`${p.modeUsage.agent} agent-mode interactions`);
		}

		// Conversation patterns (multi-turn shows iterative refinement)
		if (p.conversationPatterns) {
			const multiTurnRate = p.sessions > 0
				? Math.round((p.conversationPatterns.multiTurnSessions / p.sessions) * 100)
				: 0;
			if (p.conversationPatterns.multiTurnSessions > 0) {
				peEvidence.push(`${p.conversationPatterns.multiTurnSessions} multi-turn sessions (${multiTurnRate}%)`);
			}
			if (p.conversationPatterns.avgTurnsPerSession >= 3) {
				peEvidence.push(`Avg ${p.conversationPatterns.avgTurnsPerSession.toFixed(1)} exchanges per session`);
				peStage = Math.max(peStage, 2) as 1 | 2 | 3 | 4;
			}
			if (p.conversationPatterns.avgTurnsPerSession >= 5) {
				peStage = Math.max(peStage, 3) as 1 | 2 | 3 | 4;
			}
		}

		if (totalInteractions >= 5) {
			peStage = 2; // At least trying it out
		}

		// Check slash command / tool usage (indicates structured prompts)
		const slashCommands = ['explain', 'fix', 'tests', 'doc', 'generate', 'optimize', 'new', 'newNotebook', 'search', 'fixTestFailure', 'setupTests'];
		const usedSlashCommands = slashCommands.filter(cmd => (p.toolCalls.byTool[cmd] || 0) > 0);
		if (usedSlashCommands.length > 0) {
			peEvidence.push(`Used slash commands: /${usedSlashCommands.join(', /')}`);
		}

		const hasModelSwitching = p.modelSwitching.mixedTierSessions > 0 || p.modelSwitching.switchingFrequency > 0;
		const hasAgentMode = p.modeUsage.agent > 0;

		if (totalInteractions >= 30 && (usedSlashCommands.length >= 2 || hasAgentMode)) {
			peStage = 3; // Regular, purposeful use
		}

		// Strategist: high volume + agent mode + (model switching or diverse slash commands)
		if (totalInteractions >= 100 && hasAgentMode && (hasModelSwitching || usedSlashCommands.length >= 3)) {
			peStage = 4;
		}

		// Model switching awareness
		if (hasModelSwitching) {
			peEvidence.push(`Switched models in ${Math.round(p.modelSwitching.switchingFrequency)}% of sessions`);
			if (peStage < 4 && p.modelSwitching.mixedTierSessions > 0) {
				peStage = Math.max(peStage, 3) as 1 | 2 | 3 | 4;
			}
		}

		// Context-aware tips
		if (peStage < 2) { peTips.push('Try asking Copilot a question using the Chat panel'); }
		if (peStage < 3) {
			if (!hasAgentMode) { peTips.push('Try agent mode for multi-file changes'); }
			if (usedSlashCommands.length < 2) { peTips.push('Use slash commands like /explain, /fix, or /tests to give structured prompts'); }
		}
		if (peStage < 4) {
			if (!hasAgentMode) { peTips.push('Try agent mode for autonomous, multi-step coding tasks'); }
			if (!hasModelSwitching) { peTips.push('Experiment with different models for different tasks - use fast models for simple queries and reasoning models for complex problems'); }
			if (usedSlashCommands.length < 3 && hasAgentMode && hasModelSwitching) { peTips.push('Explore more slash commands like /explain, /tests, or /doc to diversify your prompting'); }
		}

		// ---------- 2. Context Engineering ----------
		const ceEvidence: string[] = [];
		const ceTips: string[] = [];
		let ceStage = 1;

		const totalContextRefs = p.contextReferences.file + p.contextReferences.selection +
			p.contextReferences.symbol + p.contextReferences.codebase + p.contextReferences.workspace;
		const refTypes = [
			p.contextReferences.file > 0,
			p.contextReferences.selection > 0,
			p.contextReferences.symbol > 0,
			p.contextReferences.codebase > 0,
			p.contextReferences.workspace > 0,
			p.contextReferences.terminal > 0,
			p.contextReferences.vscode > 0,
			p.contextReferences.clipboard > 0,
			p.contextReferences.changes > 0,
			p.contextReferences.problemsPanel > 0,
			p.contextReferences.outputPanel > 0,
			p.contextReferences.terminalLastCommand > 0,
			p.contextReferences.terminalSelection > 0
		];
		const usedRefTypeCount = refTypes.filter(Boolean).length;

		if (p.contextReferences.file > 0) { ceEvidence.push(`${p.contextReferences.file} #file references`); }
		if (p.contextReferences.selection > 0) { ceEvidence.push(`${p.contextReferences.selection} #selection references`); }
		if (p.contextReferences.codebase > 0) { ceEvidence.push(`${p.contextReferences.codebase} #codebase references`); }
		if (p.contextReferences.workspace > 0) { ceEvidence.push(`${p.contextReferences.workspace} @workspace references`); }
		if (p.contextReferences.terminal > 0) { ceEvidence.push(`${p.contextReferences.terminal} @terminal references`); }

		if (totalContextRefs >= 1) { ceStage = 2; }
		if (usedRefTypeCount >= 3 && totalContextRefs >= 10) { ceStage = 3; }
		if (usedRefTypeCount >= 5 && totalContextRefs >= 30) { ceStage = 4; }

		// Image context (byKind: copilot.image)
		const imageRefs = p.contextReferences.byKind['copilot.image'] || 0;
		if (imageRefs > 0) {
			ceEvidence.push(`${imageRefs} image references (vision)`);
			ceStage = Math.max(ceStage, 3) as 1 | 2 | 3 | 4;
		}

		if (ceStage < 2) { ceTips.push('Try adding #file or #selection references to give Copilot more context'); }
		if (ceStage < 3) { ceTips.push('Explore @workspace, #codebase, and @terminal for broader context'); }
		if (ceStage < 4) { ceTips.push('Try image attachments, #changes, #problemsPanel, and other specialized context variables'); }

		// ---------- 3. Agentic ----------
		const agEvidence: string[] = [];
		const agTips: string[] = [];
		let agStage = 1;

		if (p.modeUsage.agent > 0) {
			agEvidence.push(`${p.modeUsage.agent} agent-mode interactions`);
			agStage = 2;
		}
		if (p.toolCalls.total > 0) {
			agEvidence.push(`${p.toolCalls.total} tool calls executed`);
		}
		if (p.modeUsage.edit > 0) {
			agEvidence.push(`${p.modeUsage.edit} edit-mode interactions`);
		}

		// Edit scope tracking (multi-file edits show advanced agentic behavior)
		if (p.editScope) {
			const multiFileRate = p.editScope.totalEditedFiles > 0
				? Math.round((p.editScope.multiFileEdits / (p.editScope.singleFileEdits + p.editScope.multiFileEdits)) * 100)
				: 0;
			if (p.editScope.multiFileEdits > 0) {
				agEvidence.push(`${p.editScope.multiFileEdits} multi-file edit sessions (${multiFileRate}%)`);
				agStage = Math.max(agStage, 2) as 1 | 2 | 3 | 4;
			}
			if (p.editScope.avgFilesPerSession >= 3) {
				agEvidence.push(`Avg ${p.editScope.avgFilesPerSession.toFixed(1)} files per edit session`);
				agStage = Math.max(agStage, 3) as 1 | 2 | 3 | 4;
			}
		}

		// Agent type distribution
		if (p.agentTypes && p.agentTypes.editsAgent > 0) {
			agEvidence.push(`${p.agentTypes.editsAgent} edits agent sessions`);
			agStage = Math.max(agStage, 2) as 1 | 2 | 3 | 4;
		}

		// Diverse tool usage in agent mode
		const toolCount = Object.keys(p.toolCalls.byTool).length;
		if (p.modeUsage.agent >= 10 && toolCount >= 3) {
			agStage = 3;
		}

		// Heavy agentic use with many tool types or high multi-file edit rate
		if (p.modeUsage.agent >= 50 && toolCount >= 5) {
			agStage = 4;
		}
		if (p.editScope && p.editScope.multiFileEdits >= 20 && p.editScope.avgFilesPerSession >= 3) {
			agStage = Math.max(agStage, 4) as 1 | 2 | 3 | 4;
		}

		if (agStage < 2) { agTips.push('Try agent mode — it can run terminal commands, edit files, and explore your codebase autonomously'); }
		if (agStage < 3) { agTips.push('Use agent mode for multi-step tasks; let it chain tools like file search, terminal, and code edits'); }
		if (agStage < 4) { agTips.push('Tackle complex refactoring or debugging tasks in agent mode for deeper autonomous workflows'); }

		// ---------- 4. Tool Usage ----------
		const tuEvidence: string[] = [];
		const tuTips: string[] = [];
		let tuStage = 1;

		// Basic tool usage (primarily from agent mode)
		if (toolCount > 0) {
			tuEvidence.push(`${toolCount} unique tools used`);
			tuStage = 2;
		}

		// Agent type distribution (workspace agent shows advanced tool usage)
		if (p.agentTypes) {
			if (p.agentTypes.workspaceAgent > 0) {
				tuEvidence.push(`${p.agentTypes.workspaceAgent} @workspace agent sessions`);
				tuStage = Math.max(tuStage, 3) as 1 | 2 | 3 | 4;
			}
		}

		// Specific advanced tool IDs (intentional tool integration)
		const advancedToolFriendlyNames: Record<string, string> = {
			github_pull_request: 'GitHub Pull Request',
			github_repo: 'GitHub Repository',
			run_in_terminal: 'Run In Terminal',
			editFiles: 'Edit Files',
			listFiles: 'List Files'
		};
		const usedAdvanced = Object.keys(advancedToolFriendlyNames).filter(t => (p.toolCalls.byTool[t] || 0) > 0);
		if (usedAdvanced.length > 0) {
			tuEvidence.push(`Advanced tools: ${usedAdvanced.map(t => advancedToolFriendlyNames[t]).join(', ')}`);
			if (usedAdvanced.length >= 2) {
				tuStage = Math.max(tuStage, 3) as 1 | 2 | 3 | 4;
			}
		}

		// MCP tools are a strong signal of strategic/advanced use
		const mcpServers = Object.keys(p.mcpTools.byServer);
		if (p.mcpTools.total > 0) {
			tuEvidence.push(`${p.mcpTools.total} MCP tool calls across ${mcpServers.length} server(s)`);
			tuStage = Math.max(tuStage, 3) as 1 | 2 | 3 | 4; // Using any MCP server is stage 3
			if (mcpServers.length >= 2) {
				tuStage = 4; // Multiple MCP servers = strategist
			}
		}

		// Tips based on current state
		if (tuStage < 2) {
			tuTips.push('Try agent mode to let Copilot use built-in tools for file operations and terminal commands');
		}
		if (tuStage < 3) {
			if (mcpServers.length === 0) {
				tuTips.push('Set up MCP servers to connect Copilot to external tools (databases, APIs, cloud services)');
			} else {
				tuTips.push('Explore GitHub integrations and advanced tools like editFiles and run_in_terminal');
			}
		}
		if (tuStage < 4) {
			if (mcpServers.length === 1) {
				tuTips.push('Add more MCP servers to expand Copilot\'s capabilities - check the VS Code MCP registry');
			} else if (mcpServers.length === 0) {
				tuTips.push('Explore the VS Code MCP registry for tools that integrate with your workflow');
			} else {
				tuTips.push('You\'re using multiple MCP servers - keep exploring advanced tool combinations');
			}
		}

		// ---------- 5. Customization ----------
		const cuEvidence: string[] = [];
		const cuTips: string[] = [];
		let cuStage = 1;

		// Derive repo-level customization from the customization matrix (which is actually populated)
		const matrix = this._lastCustomizationMatrix;
		const totalRepos = matrix?.totalWorkspaces ?? 0;
		const reposWithCustomization = totalRepos - (matrix?.workspacesWithIssues ?? 0);
		const customizationRate = totalRepos > 0 ? (reposWithCustomization / totalRepos) : 0;

		if (totalRepos > 0) {
			cuEvidence.push(`Worked in ${totalRepos} repositor${totalRepos === 1 ? 'y' : 'ies'}`);
		}

		if (reposWithCustomization > 0) {
			cuStage = 2;
		}

		// Stage thresholds based on adoption rate
		if (customizationRate >= 0.3 && reposWithCustomization >= 2) {
			cuStage = 3;
		}

		if (customizationRate >= 0.7 && reposWithCustomization >= 3) {
			cuStage = 4;
		}

		// Model selection awareness (choosing specific models)
		const uniqueModels = [...new Set([
			...p.modelSwitching.standardModels,
			...p.modelSwitching.premiumModels
		])];
		if (uniqueModels.length >= 3) {
			// Check for Stage 4 criteria first
			const hasStage4Models = uniqueModels.length >= 5 && reposWithCustomization >= 3;
			
			cuEvidence.push(`Used ${uniqueModels.length} different models`);
			if (hasStage4Models) {
				cuStage = 4;
			} else if (uniqueModels.length >= 5) {
				cuStage = Math.max(cuStage, 3) as 1 | 2 | 3 | 4;
			} else {
				cuStage = Math.max(cuStage, 3) as 1 | 2 | 3 | 4;
			}
		}

		// Show repo customization evidence once, reflecting the final achieved stage
		if (cuStage >= 4) {
			cuEvidence.push(`${reposWithCustomization} of ${totalRepos} repos customized (70%+ with 3+ repos → Stage 4)`);
		} else if (cuStage >= 3) {
			cuEvidence.push(`${reposWithCustomization} of ${totalRepos} repos customized (30%+ with 2+ repos → Stage 3)`);
		} else if (reposWithCustomization > 0) {
			cuEvidence.push(`${reposWithCustomization} of ${totalRepos} repos with custom instructions or agents.md`);
		}

		if (cuStage < 2) { cuTips.push('Create a .github/copilot-instructions.md file with project-specific guidelines'); }
		if (cuStage < 3) { cuTips.push('Add custom instructions to more repositories to standardize your Copilot experience'); }
		if (cuStage < 4) {
			const uncustomized = totalRepos - reposWithCustomization;
			if (totalRepos > 0 && uncustomized > 0) {
				cuTips.push(`${reposWithCustomization} of ${totalRepos} repos have customization — add instructions and agents.md to the remaining ${uncustomized} repo${uncustomized === 1 ? '' : 's'} for Stage 4`);
			} else {
				cuTips.push('Aim for consistent customization across all projects with instructions and agents.md');
			}
		}
		if (cuStage >= 4) {
			const uncustomized = totalRepos - reposWithCustomization;
			if (uncustomized > 0) {
				const missingCustomizationRepos = (matrix?.workspaces || [])
					.filter(row => Object.values(row.typeStatuses).every(status => status === '❌'));
				const prioritizedMissingRepos = missingCustomizationRepos
					.filter(row => !row.workspacePath.startsWith('<unresolved:'))
					.sort((a, b) => {
						if (b.interactionCount !== a.interactionCount) {
							return b.interactionCount - a.interactionCount;
						}
						return b.sessionCount - a.sessionCount;
					})
					.slice(0, 3);

				const summaryTip = `${uncustomized} repo${uncustomized === 1 ? '' : 's'} still missing customization — add instructions, agents.md, or MCP configs for full coverage.`;
				if (prioritizedMissingRepos.length > 0) {
					const repoLines = prioritizedMissingRepos.map(row => 
						`${row.workspaceName} (${row.interactionCount} interaction${row.interactionCount === 1 ? '' : 's'})`
					).join('\n');
					cuTips.push(`${summaryTip}\n\nTop repos to customize first:\n${repoLines}`);
				} else {
					cuTips.push(summaryTip);
				}
			} else {
				cuTips.push('All repos customized! Keep instructions up to date and add skill files or MCP server configs for deeper integration');
			}
		}

		// ---------- 6. Workflow Integration ----------
		const wiEvidence: string[] = [];
		const wiTips: string[] = [];
		let wiStage = 1;

		// Sessions count reflects regularity
		if (p.sessions >= 3) {
			wiEvidence.push(`${p.sessions} sessions in the last 30 days`);
			wiStage = 2;
		}

		// Apply button usage (high rate shows active adoption of suggestions)
		if (p.applyUsage && p.applyUsage.totalCodeBlocks > 0) {
			const applyRatePercent = Math.round(p.applyUsage.applyRate);
			wiEvidence.push(`${applyRatePercent}% code block apply rate (${p.applyUsage.totalApplies}/${p.applyUsage.totalCodeBlocks})`);
			if (applyRatePercent >= 50) {
				wiStage = Math.max(wiStage, 2) as 1 | 2 | 3 | 4;
			}
		}

		// Session duration (informational only - not used for staging)
		if (p.sessionDuration && p.sessionDuration.avgDurationMs > 0) {
			const avgMinutes = Math.round(p.sessionDuration.avgDurationMs / 60000);
			wiEvidence.push(`Avg ${avgMinutes}min session duration`);
		}

		// Multi-mode usage (ask + agent) - key indicator of integration
		const modesUsed = [p.modeUsage.ask > 0, p.modeUsage.agent > 0].filter(Boolean).length;
		if (modesUsed >= 2) {
			wiEvidence.push(`Uses ${modesUsed} modes (ask/agent)`);
			wiStage = Math.max(wiStage, 3) as 1 | 2 | 3 | 4;
		}

		// Explicit context usage - strong signal of intentional integration
		const hasExplicitContext = totalContextRefs >= 10;
		if (hasExplicitContext) {
			wiEvidence.push(`${totalContextRefs} explicit context references`);
			if (totalContextRefs >= 20) {
				wiStage = Math.max(wiStage, 3) as 1 | 2 | 3 | 4;
			}
		}

		// Stage 4: Multi-mode + explicit context + regular usage
		if (p.sessions >= 15 && modesUsed >= 2 && totalContextRefs >= 20) {
			wiStage = 4;
			wiEvidence.push('Deep integration: regular usage with multi-mode and explicit context');
		}

		if (wiStage < 2) { wiTips.push('Use Copilot more regularly - even for quick questions'); }
		if (wiStage < 3) { 
			if (modesUsed < 2) { wiTips.push('Combine ask mode with agent mode in your daily workflow'); }
			if (totalContextRefs < 10) { wiTips.push('Use explicit context references like #file, @workspace, and #selection'); }
		}
		if (wiStage < 4) { 
			if (totalContextRefs < 20) { wiTips.push('Make explicit context a habit - use #file, @workspace, and other references consistently'); }
			wiTips.push('Make Copilot part of every coding task: planning, coding, testing, and reviewing'); 
		}

		// ---------- Overall score (median) ----------
		const scores = [peStage, ceStage, agStage, tuStage, cuStage, wiStage].sort((a, b) => a - b);
		const mid = Math.floor(scores.length / 2);
		const overallStage = scores.length % 2 === 0
			? Math.round((scores[mid - 1] + scores[mid]) / 2)
			: scores[mid];

		return {
			overallStage,
			overallLabel: stageLabels[overallStage] || `Stage ${overallStage}`,
			categories: [
				{ category: 'Prompt Engineering', icon: '💬', stage: peStage, evidence: peEvidence, tips: peTips },
				{ category: 'Context Engineering', icon: '📎', stage: ceStage, evidence: ceEvidence, tips: ceTips },
				{ category: 'Agentic', icon: '🤖', stage: agStage, evidence: agEvidence, tips: agTips },
				{ category: 'Tool Usage', icon: '🔧', stage: tuStage, evidence: tuEvidence, tips: tuTips },
				{ category: 'Customization', icon: '⚙️', stage: cuStage, evidence: cuEvidence, tips: cuTips },
				{ category: 'Workflow Integration', icon: '🔄', stage: wiStage, evidence: wiEvidence, tips: wiTips }
			],
			period: p,
			lastUpdated: stats.lastUpdated.toISOString()
		};
	}

	public async showMaturity(): Promise<void> {
		this.log('🎯 Opening Copilot Fluency Score dashboard');

		// If panel already exists, dispose and recreate with fresh data
		if (this.maturityPanel) {
			this.maturityPanel.dispose();
			this.maturityPanel = undefined;
		}

		const maturityData = await this.calculateMaturityScores(true); // Use cached data for fast loading
		const isDebugMode = this.context.extensionMode === vscode.ExtensionMode.Development;

		this.maturityPanel = vscode.window.createWebviewPanel(
			'copilotMaturity',
			'Copilot Fluency Score',
			{ viewColumn: vscode.ViewColumn.One, preserveFocus: true },
			{
				enableScripts: true,
				retainContextWhenHidden: false,
				localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview')]
			}
		);

		const dismissedTips = await this.getDismissedFluencyTips();
		const fluencyLevels = isDebugMode ? this.getFluencyLevelData(isDebugMode).categories : undefined;
		this.maturityPanel.webview.html = this.getMaturityHtml(this.maturityPanel.webview, { ...maturityData, dismissedTips, isDebugMode, fluencyLevels });

		this.maturityPanel.webview.onDidReceiveMessage(async (message) => {
			switch (message.command) {
				case 'refresh':
					await this.refreshMaturityPanel();
					break;
				case 'showFluencyLevelViewer':
					await this.showFluencyLevelViewer();
					break;
				case 'showDetails':
					await this.showDetails();
					break;
				case 'showChart':
					await this.showChart();
					break;
				case 'showUsageAnalysis':
					await this.showUsageAnalysis();
					break;
				case 'showDiagnostics':
					await this.showDiagnosticReport();
					break;
				case 'searchMcpExtensions':
					await vscode.commands.executeCommand('workbench.extensions.search', '@tag:mcp');
					break;
				case 'shareToIssue': {
					const scores = await this.calculateMaturityScores();
					const categorySections = scores.categories.map(c => {
						const evidenceList = c.evidence.length > 0
							? c.evidence.map(e => `- ✅ ${e}`).join('\n')
							: '- No significant activity detected';
						return `<h2>${c.icon} ${c.category} — Stage ${c.stage}</h2>\n\n${evidenceList}`;
					}).join('\n\n');
					const body = `<h2>Copilot Fluency Score Feedback</h2>\n\n**Overall Stage:** ${scores.overallLabel}\n\n${categorySections}\n\n<h2>Feedback</h2>\n<!-- Describe your feedback or suggestion here -->\n`;
					const issueUrl = `https://github.com/rajbos/github-copilot-token-usage/issues/new?title=${encodeURIComponent('Fluency Score Feedback')}&body=${encodeURIComponent(body)}&labels=${encodeURIComponent('fluency-score')}`;
					await vscode.env.openExternal(vscode.Uri.parse(issueUrl));
					break;
				}
				case 'dismissTips':
					if (message.category) {
						await this.dismissFluencyTips(message.category);
						await this.refreshMaturityPanel();
					}
					break;
				case 'resetDismissedTips':
					await this.resetDismissedFluencyTips();
					await this.refreshMaturityPanel();
					break;
				case 'showDashboard':
					await this.showDashboard();
					break;
				case 'shareToLinkedIn':
					await this.shareToSocialMedia('linkedin');
					break;
				case 'shareToBluesky':
					await this.shareToSocialMedia('bluesky');
					break;
				case 'shareToMastodon':
					await this.shareToSocialMedia('mastodon');
					break;
				case 'downloadChartImage':
					await this.downloadChartImage();
					break;
				case 'saveChartImage':
					if (message.data) {
						await this.saveChartImageData(message.data);
					}
					break;
				case 'exportPdf':
					if (message.data) {
						await this.exportFluencyScorePdf(message.data);
					}
					break;
				case 'exportPptx':
					if (message.data) {
						await this.exportFluencyScorePptx(message.data);
					}
					break;
		}
	});

	this.maturityPanel.onDidDispose(() => {
		this.log('🎯 Copilot Fluency Score dashboard closed');
		this.maturityPanel = undefined;
	});
}

private async refreshMaturityPanel(): Promise<void> {
	if (!this.maturityPanel) {
		return;
	}

	this.log('🔄 Refreshing Copilot Fluency Score dashboard');
	const maturityData = await this.calculateMaturityScores(false); // Force recalculation on refresh
	const dismissedTips = await this.getDismissedFluencyTips();
	const isDebugMode = this.context.extensionMode === vscode.ExtensionMode.Development;
	const fluencyLevels = isDebugMode ? this.getFluencyLevelData(isDebugMode).categories : undefined;
	this.maturityPanel.webview.html = this.getMaturityHtml(this.maturityPanel.webview, { ...maturityData, dismissedTips, isDebugMode, fluencyLevels });
	this.log('✅ Copilot Fluency Score dashboard refreshed');
}

private async getDismissedFluencyTips(): Promise<string[]> {
	return this.context.globalState.get<string[]>('dismissedFluencyTips', []);
}

private async dismissFluencyTips(category: string): Promise<void> {
	const dismissed = await this.getDismissedFluencyTips();
	if (!dismissed.includes(category)) {
		dismissed.push(category);
		await this.context.globalState.update('dismissedFluencyTips', dismissed);
		this.log(`Dismissed fluency tips for category: ${category}`);
	}
}

private async resetDismissedFluencyTips(): Promise<void> {
	await this.context.globalState.update('dismissedFluencyTips', []);
	this.log('Reset all dismissed fluency tips');
}

/**
 * Share Copilot Fluency Score to social media platforms
 */
private async shareToSocialMedia(platform: 'linkedin' | 'bluesky' | 'mastodon'): Promise<void> {
	const scores = await this.calculateMaturityScores();
	const marketplaceUrl = 'https://marketplace.visualstudio.com/items?itemName=RobBos.copilot-token-tracker';
	const hashtag = '#CopilotFluencyScore';
	
	// Build share text with stats
	const categoryScores = scores.categories.map(c => `${c.icon} ${c.category}: Stage ${c.stage}`).join('\n');
	
	const shareText = `🎯 My GitHub Copilot Fluency Score

Overall: ${scores.overallLabel}

${categoryScores}

Track your Copilot usage and level up your AI-assisted development skills!

Get the extension: ${marketplaceUrl}

${hashtag}`;
	
	switch (platform) {
		case 'linkedin': {
			// LinkedIn share URL - opens in browser for user to add their own commentary
			const shareUrl = `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(marketplaceUrl)}`;
			
			// Copy share text to clipboard for easy pasting
			await vscode.env.clipboard.writeText(shareText);
			await vscode.window.showInformationMessage(
				'Share text copied to clipboard! Paste it into your LinkedIn post.',
				'Open LinkedIn'
			).then(async selection => {
				if (selection === 'Open LinkedIn') {
					await vscode.env.openExternal(vscode.Uri.parse(shareUrl));
				}
			});
			break;
		}
			
		case 'bluesky': {
			// Copy share text to clipboard, then open Bluesky compose
			await vscode.env.clipboard.writeText(shareText);
			await vscode.window.showInformationMessage(
				'Share text copied to clipboard! Paste it into your Bluesky post.',
				'Open Bluesky'
			).then(async selection => {
				if (selection === 'Open Bluesky') {
					await vscode.env.openExternal(vscode.Uri.parse('https://bsky.app/intent/compose'));
				}
			});
			break;
		}
			
		case 'mastodon': {
			// Mastodon share - ask user for their instance
			const instance = await vscode.window.showInputBox({
				prompt: 'Enter your Mastodon instance (e.g., mastodon.social)',
				placeHolder: 'mastodon.social',
				value: 'mastodon.social'
			});
			
			if (instance) {
				// Copy share text to clipboard, then open Mastodon compose
				await vscode.env.clipboard.writeText(shareText);
				await vscode.window.showInformationMessage(
					'Share text copied to clipboard! Paste it into your Mastodon post.',
					'Open Mastodon'
				).then(async selection => {
					if (selection === 'Open Mastodon') {
						await vscode.env.openExternal(vscode.Uri.parse(`https://${instance}/share`));
					}
				});
			}
			break;
		}
	}
	
	this.log(`Shared fluency score to ${platform}`);
}

/**
 * Download the fluency chart as an image
 */
private async downloadChartImage(): Promise<void> {
	await vscode.window.showInformationMessage(
		'💡 Click the "Download Chart Image" button to save the radar chart as a PNG file.',
		'Got it'
	);
	this.log('Showed chart download instructions');
}

private async saveChartImageData(dataUrl: string): Promise<void> {
	const base64Match = dataUrl.match(/^data:image\/png;base64,(.+)$/);
	if (!base64Match) {
		void vscode.window.showErrorMessage('Failed to process chart image data.');
		return;
	}

	const uri = await vscode.window.showSaveDialog({
		defaultUri: vscode.Uri.file('copilot-fluency-score.png'),
		filters: { 'PNG Image': ['png'] },
		title: 'Save Fluency Score Chart'
	});

	if (!uri) { return; }

	const buffer = Buffer.from(base64Match[1], 'base64');
	await vscode.workspace.fs.writeFile(uri, buffer);
	void vscode.window.showInformationMessage(`Chart image saved to ${uri.fsPath}`, 'Open Image').then(selection => {
		if (selection === 'Open Image') {
			void vscode.env.openExternal(uri);
		}
	});
	this.log(`Chart image saved to ${uri.fsPath}`);
}

/**
	 * Export Copilot Fluency Score as a landscape PDF with screenshot images
	 */
	private async exportFluencyScorePdf(images: { label: string; dataUrl: string }[]): Promise<void> {
		try {
			const jsPDF = (await import('jspdf')).default;

			const uri = await vscode.window.showSaveDialog({
				defaultUri: vscode.Uri.file('copilot-fluency-score.pdf'),
				filters: { 'PDF Document': ['pdf'] },
				title: 'Export Fluency Score Report'
			});

			if (!uri) { return; }

			const pdf = new jsPDF({
				orientation: 'landscape',
				unit: 'mm',
				format: 'a4'
			});

			const pageWidth = pdf.internal.pageSize.getWidth();   // ~297mm
			const pageHeight = pdf.internal.pageSize.getHeight();  // ~210mm
			const margin = 10;

			for (let i = 0; i < images.length; i++) {
				if (i > 0) { pdf.addPage(); }

				// Page header
				pdf.setFontSize(8);
				pdf.setTextColor(128, 128, 128);
				pdf.text(`Copilot Fluency Score Report - Page ${i + 1} of ${images.length}`, margin, 7);
				pdf.text(new Date().toLocaleDateString(), pageWidth - margin, 7, { align: 'right' });

				// Insert the screenshot image, fitting within the page
				const imgData = images[i].dataUrl;
				const availW = pageWidth - 2 * margin;
				const availH = pageHeight - 2 * margin - 5; // extra space for header/footer

				// Determine image aspect ratio from the base64 PNG header
				const imgProps = pdf.getImageProperties(imgData);
				const imgW = imgProps.width;
				const imgH = imgProps.height;
				const scale = Math.min(availW / imgW, availH / imgH);
				const drawW = imgW * scale;
				const drawH = imgH * scale;
				const x = margin + (availW - drawW) / 2;
				const y = margin + 5 + (availH - drawH) / 2;

				pdf.addImage(imgData, 'PNG', x, y, drawW, drawH);

				// Footer
				pdf.setFontSize(8);
				pdf.setTextColor(128, 128, 128);
				pdf.text('Generated by Copilot Token Tracker Extension', pageWidth / 2, pageHeight - 5, { align: 'center' });
			}

			const pdfBuffer = Buffer.from(pdf.output('arraybuffer'));
			await vscode.workspace.fs.writeFile(uri, pdfBuffer);

			void vscode.window.showInformationMessage(`Fluency Score PDF saved to ${uri.fsPath}`, 'Open PDF').then(selection => {
				if (selection === 'Open PDF') {
					void vscode.env.openExternal(uri);
				}
			});

			this.log(`Fluency Score PDF exported to ${uri.fsPath}`);
		} catch (error) {
			this.error('Failed to export PDF', error instanceof Error ? error : new Error(String(error)));
			void vscode.window.showErrorMessage(`Failed to export PDF: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * Export Copilot Fluency Score as a PowerPoint presentation with screenshot images
	 */
	private async exportFluencyScorePptx(images: { label: string; dataUrl: string }[]): Promise<void> {
		try {
			const PptxGenJSModule = await import('pptxgenjs');
			const PptxGenJS = PptxGenJSModule.default as any;

			const uri = await vscode.window.showSaveDialog({
				defaultUri: vscode.Uri.file('copilot-fluency-score.pptx'),
				filters: { 'PowerPoint Presentation': ['pptx'] },
				title: 'Export Fluency Score as PowerPoint'
			});

			if (!uri) { return; }

			const pptx = new PptxGenJS();
			pptx.layout = 'LAYOUT_WIDE'; // 13.33" x 7.5" — great for presentations
			pptx.author = 'Copilot Token Tracker';
			pptx.subject = 'Copilot Fluency Score Report';
			pptx.title = 'Copilot Fluency Score';

			const slideW = 13.33;
			const slideH = 7.5;
			const maxW = slideW - 0.8;  // 0.4" margin each side
			const maxH = slideH - 1.0;  // room for footer

			for (const img of images) {
				const slide = pptx.addSlide();
				slide.background = { color: '1b1b1e' };

				// Decode PNG dimensions from the base64 data to preserve aspect ratio
				let imgW = maxW;
				let imgH = maxH;
				try {
					const base64 = img.dataUrl.split(',')[1];
					const buf = Buffer.from(base64, 'base64');
					// PNG header: width at bytes 16-19, height at bytes 20-23 (big-endian)
					if (buf.length > 24 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
						const pxW = buf.readUInt32BE(16);
						const pxH = buf.readUInt32BE(20);
						if (pxW > 0 && pxH > 0) {
							const aspect = pxW / pxH;
							// Fit within maxW x maxH preserving aspect ratio
							if (aspect > maxW / maxH) {
								imgW = maxW;
								imgH = maxW / aspect;
							} else {
								imgH = maxH;
								imgW = maxH * aspect;
							}
						}
					}
				} catch { /* fall back to max dimensions */ }

				const x = (slideW - imgW) / 2;
				const y = (slideH - 1.0 - imgH) / 2 + 0.1; // center in area above footer

				slide.addImage({
					data: img.dataUrl,
					x, y, w: imgW, h: imgH
				});

				// Footer text
				slide.addText('Generated by Copilot Token Tracker Extension', {
					x: 0, y: 7.0, w: 13.33, h: 0.4,
					fontSize: 8, color: '808080', align: 'center'
				});
			}

			const pptxBuffer = await pptx.write({ outputType: 'nodebuffer' }) as Buffer;
			await vscode.workspace.fs.writeFile(uri, pptxBuffer);

			void vscode.window.showInformationMessage(`Fluency Score PPTX saved to ${uri.fsPath}`, 'Open File').then(selection => {
				if (selection === 'Open File') {
					void vscode.env.openExternal(uri);
				}
			});

			this.log(`Fluency Score PPTX exported to ${uri.fsPath}`);
		} catch (error) {
			this.error('Failed to export PPTX', error instanceof Error ? error : new Error(String(error)));
			void vscode.window.showErrorMessage(`Failed to export PPTX: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

public async showFluencyLevelViewer(): Promise<void> {
	// Check if debugger is active
	const isDebugMode = this.context.extensionMode === vscode.ExtensionMode.Development;

	if (!isDebugMode) {
		this.warn('⚠️ Fluency Level Viewer is only available in debug mode');
		void vscode.window.showWarningMessage(
			'Fluency Level Viewer is only available when a debugger is active.',
			'Learn More'
		).then(selection => {
			if (selection === 'Learn More') {
				void vscode.env.openExternal(vscode.Uri.parse('https://code.visualstudio.com/docs/editor/debugging'));
			}
		});
		return;
	}

	this.log('🔍 Opening Fluency Level Viewer (debug mode)');

	// If panel already exists, dispose and recreate with fresh data
	if (this.fluencyLevelViewerPanel) {
		this.fluencyLevelViewerPanel.dispose();
		this.fluencyLevelViewerPanel = undefined;
	}

	const fluencyLevelData = this.getFluencyLevelData(isDebugMode);

	this.fluencyLevelViewerPanel = vscode.window.createWebviewPanel(
		'copilotFluencyLevelViewer',
		'Fluency Level Viewer',
		{ viewColumn: vscode.ViewColumn.One, preserveFocus: true },
		{
			enableScripts: true,
			retainContextWhenHidden: false,
			localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview')]
		}
	);

	this.fluencyLevelViewerPanel.webview.html = this.getFluencyLevelViewerHtml(this.fluencyLevelViewerPanel.webview, fluencyLevelData);

	this.fluencyLevelViewerPanel.webview.onDidReceiveMessage(async (message) => {
		switch (message.command) {
			case 'refresh':
				await this.refreshFluencyLevelViewerPanel();
				break;
			case 'showMaturity':
				await this.showMaturity();
				break;
			case 'showDetails':
				await this.showDetails();
				break;
			case 'showChart':
				await this.showChart();
				break;
			case 'showUsageAnalysis':
				await this.showUsageAnalysis();
				break;
			case 'showDiagnostics':
				await this.showDiagnosticReport();
				break;
		}
	});

	this.fluencyLevelViewerPanel.onDidDispose(() => {
		this.log('🔍 Fluency Level Viewer closed');
		this.fluencyLevelViewerPanel = undefined;
	});
}

private async refreshFluencyLevelViewerPanel(): Promise<void> {
	if (!this.fluencyLevelViewerPanel) {
		return;
	}

	const isDebugMode = this.context.extensionMode === vscode.ExtensionMode.Development;
	this.log('🔄 Refreshing Fluency Level Viewer');
	const fluencyLevelData = this.getFluencyLevelData(isDebugMode);
	this.fluencyLevelViewerPanel.webview.html = this.getFluencyLevelViewerHtml(this.fluencyLevelViewerPanel.webview, fluencyLevelData);
	this.log('✅ Fluency Level Viewer refreshed');
}

private getFluencyLevelData(isDebugMode: boolean): {
	categories: Array<{
		category: string;
		icon: string;
		levels: Array<{
			stage: number;
			label: string;
			description: string;
			thresholds: string[];
			tips: string[];
		}>;
	}>;
	isDebugMode: boolean;
} {
	return {
		isDebugMode,
		categories: [
			{
				category: 'Prompt Engineering',
				icon: '💬',
				levels: [
					{
						stage: 1,
						label: 'Stage 1: Copilot Skeptic',
						description: 'Rarely uses Copilot or uses only basic features',
						thresholds: [
							'Fewer than 5 total interactions in 30 days',
							'Minimal multi-turn conversations',
							'No slash commands or agent mode usage'
						],
						tips: [
							'Try asking Copilot a question using the Chat panel',
							'Start with simple queries to get familiar with the interface'
						]
					},
					{
						stage: 2,
						label: 'Stage 2: Copilot Explorer',
						description: 'Exploring Copilot capabilities with occasional use',
						thresholds: [
							'At least 5 total interactions',
							'Average 3+ exchanges per session shows iterative refinement',
							'Beginning to use slash commands or agent mode'
						],
						tips: [
							'Try agent mode for multi-file changes',
							'Use slash commands like /explain, /fix, or /tests to give structured prompts',
							'Experiment with multi-turn conversations to refine responses'
						]
					},
					{
						stage: 3,
						label: 'Stage 3: Copilot Collaborator',
						description: 'Regular, purposeful use across multiple features',
						thresholds: [
							'At least 30 total interactions',
							'Using 2+ slash commands or agent mode regularly',
							'Average 5+ exchanges per session OR model switching in sessions',
							'Shows model switching awareness (mixed-tier sessions)'
						],
						tips: [
							'Try agent mode for autonomous, multi-step coding tasks',
							'Experiment with different models for different tasks - use fast models for simple queries and reasoning models for complex problems',
							'Explore more slash commands like /explain, /tests, or /doc to diversify your prompting'
						]
					},
					{
						stage: 4,
						label: 'Stage 4: Copilot Strategist',
						description: 'Strategic, advanced use leveraging the full Copilot ecosystem',
						thresholds: [
							'At least 100 total interactions',
							'Using agent mode regularly',
							'Active model switching (switches in sessions) OR 3+ diverse slash commands',
							'Demonstrates strategic choice of models and commands for different tasks'
						],
						tips: [
							'You\'re at the highest level!',
							'Continue exploring advanced combinations of models, modes, and commands'
						]
					}
				]
			},
			{
				category: 'Context Engineering',
				icon: '📎',
				levels: [
					{
						stage: 1,
						label: 'Stage 1: Copilot Skeptic',
						description: 'Not using explicit context references',
						thresholds: [
							'Zero explicit context references (#file, #selection, @workspace, etc.)'
						],
						tips: [
							'Try adding #file or #selection references to give Copilot more context',
							'Start with #file to reference specific files in your prompts'
						]
					},
					{
						stage: 2,
						label: 'Stage 2: Copilot Explorer',
						description: 'Beginning to use basic context references',
						thresholds: [
							'At least 1 context reference used',
							'Exploring basic references like #file or #selection'
						],
						tips: [
							'Explore @workspace, #codebase, and @terminal for broader context',
							'Try combining multiple context types in a single query'
						]
					},
					{
						stage: 3,
						label: 'Stage 3: Copilot Collaborator',
						description: 'Regular use of diverse context types',
						thresholds: [
							'At least 3 different context reference types used',
							'At least 10 total context references',
							'May include image references (vision capabilities)'
						],
						tips: [
							'Try image attachments, #changes, #problemsPanel, and other specialized context variables',
							'Experiment with @terminal and @vscode for IDE-level context'
						]
					},
					{
						stage: 4,
						label: 'Stage 4: Copilot Strategist',
						description: 'Strategic use of advanced context engineering',
						thresholds: [
							'At least 5 different context reference types used',
							'At least 30 total context references',
							'Using specialized references like #changes, #problemsPanel, #outputPanel, etc.'
						],
						tips: [
							'You\'re at the highest level!',
							'Continue mastering context engineering for optimal results'
						]
					}
				]
			},
			{
				category: 'Agentic',
				icon: '🤖',
				levels: [
					{
						stage: 1,
						label: 'Stage 1: Copilot Skeptic',
						description: 'Not using agent mode or autonomous features',
						thresholds: [
							'Zero agent-mode interactions',
							'No tool calls executed',
							'Not using edit mode or multi-file capabilities'
						],
						tips: [
							'Try agent mode — it can run terminal commands, edit files, and explore your codebase autonomously',
							'Start with simple tasks to see how agent mode works'
						]
					},
					{
						stage: 2,
						label: 'Stage 2: Copilot Explorer',
						description: 'Beginning to explore agent mode',
						thresholds: [
							'At least 1 agent-mode interaction OR',
							'Using edit mode OR',
							'At least 1 multi-file edit session'
						],
						tips: [
							'Use agent mode for multi-step tasks; let it chain tools like file search, terminal, and code edits',
							'Try edit mode for focused code changes'
						]
					},
					{
						stage: 3,
						label: 'Stage 3: Copilot Collaborator',
						description: 'Regular use of agent mode with diverse tools',
						thresholds: [
							'At least 10 agent-mode interactions AND 3+ unique tools used OR',
							'Average 3+ files per edit session OR',
							'Using edits agent for focused editing tasks'
						],
						tips: [
							'Tackle complex refactoring or debugging tasks in agent mode for deeper autonomous workflows',
							'Let agent mode handle multi-step tasks that span multiple files'
						]
					},
					{
						stage: 4,
						label: 'Stage 4: Copilot Strategist',
						description: 'Heavy, strategic use of autonomous features',
						thresholds: [
							'At least 50 agent-mode interactions AND 5+ tool types used OR',
							'At least 20 multi-file edits with 3+ files per session average',
							'Demonstrates mastery of agent orchestration'
						],
						tips: [
							'You\'re at the highest level!',
							'Continue leveraging agent mode for complex, multi-step workflows'
						]
					}
				]
			},
			{
				category: 'Tool Usage',
				icon: '🔧',
				levels: [
					{
						stage: 1,
						label: 'Stage 1: Copilot Skeptic',
						description: 'Not using tools beyond basic chat',
						thresholds: [
							'Zero unique tools used',
							'No MCP servers configured',
							'No workspace agent sessions'
						],
						tips: [
							'Try agent mode to let Copilot use built-in tools for file operations and terminal commands',
							'Explore the built-in tools available in agent mode'
						]
					},
					{
						stage: 2,
						label: 'Stage 2: Copilot Explorer',
						description: 'Beginning to use basic tools',
						thresholds: [
							'At least 1 unique tool used',
							'Using basic agent mode tools'
						],
						tips: [
							'Set up MCP servers to connect Copilot to external tools (databases, APIs, cloud services)',
							'Explore GitHub integrations and advanced tools like editFiles and run_in_terminal'
						]
					},
					{
						stage: 3,
						label: 'Stage 3: Copilot Collaborator',
						description: 'Regular use of diverse tools and integrations',
						thresholds: [
							'Using @workspace agent OR',
							'Using 2+ advanced tools (GitHub PR, GitHub Repo, terminal, editFiles, listFiles) OR',
							'Using at least 1 MCP server'
						],
						tips: [
							'Add more MCP servers to expand Copilot\'s capabilities - check the VS Code MCP registry',
							'Explore advanced tool combinations for complex workflows'
						]
					},
					{
						stage: 4,
						label: 'Stage 4: Copilot Strategist',
						description: 'Strategic use of multiple MCP servers and advanced tools',
						thresholds: [
							'Using 2+ MCP servers',
							'Leveraging multiple advanced tools strategically'
						],
						tips: [
							'You\'re at the highest level!',
							'Keep exploring advanced tool combinations and new MCP servers'
						]
					}
				]
			},
			{
				category: 'Customization',
				icon: '⚙️',
				levels: [
					{
						stage: 1,
						label: 'Stage 1: Copilot Skeptic',
						description: 'Using default Copilot without customization',
						thresholds: [
							'No repositories with custom instructions or agents.md',
							'Using fewer than 3 different models'
						],
						tips: [
							'Create a .github/copilot-instructions.md file with project-specific guidelines',
							'Start customizing Copilot for your workflow'
						]
					},
					{
						stage: 2,
						label: 'Stage 2: Copilot Explorer',
						description: 'Beginning to customize Copilot',
						thresholds: [
							'At least 1 repository with custom instructions or agents.md'
						],
						tips: [
							'Add custom instructions to more repositories to standardize your Copilot experience',
							'Experiment with different models for different tasks'
						]
					},
					{
						stage: 3,
						label: 'Stage 3: Copilot Collaborator',
						description: 'Regular customization across repositories',
						thresholds: [
							'30%+ of repositories have customization (with 2+ repos) OR',
							'Using 3+ different models strategically'
						],
						tips: [
							'Aim for consistent customization across all projects with instructions and agents.md',
							'Explore 5+ models to match tasks with optimal model capabilities'
						]
					},
					{
						stage: 4,
						label: 'Stage 4: Copilot Strategist',
						description: 'Comprehensive customization strategy',
						thresholds: [
							'70%+ customization adoption rate with 3+ repos OR',
							'Using 5+ different models with 3+ repos customized'
						],
						tips: [
							'You\'re at the highest level!',
							'Continue refining your customization strategy'
						]
					}
				]
			},
			{
				category: 'Workflow Integration',
				icon: '🔄',
				levels: [
					{
						stage: 1,
						label: 'Stage 1: Copilot Skeptic',
						description: 'Minimal integration into daily workflow',
						thresholds: [
							'Fewer than 3 sessions in 30 days',
							'Using only 1 mode (ask OR agent)',
							'Fewer than 10 explicit context references'
						],
						tips: [
							'Use Copilot more regularly - even for quick questions',
							'Make Copilot part of your daily coding routine'
						]
					},
					{
						stage: 2,
						label: 'Stage 2: Copilot Explorer',
						description: 'Occasional integration with some regularity',
						thresholds: [
							'At least 3 sessions in 30 days OR',
							'50%+ code block apply rate'
						],
						tips: [
							'Combine ask mode with agent mode in your daily workflow',
							'Use explicit context references like #file, @workspace, and #selection'
						]
					},
					{
						stage: 3,
						label: 'Stage 3: Copilot Collaborator',
						description: 'Regular workflow integration',
						thresholds: [
							'Using 2 modes (ask AND agent) OR',
							'At least 20 explicit context references'
						],
						tips: [
							'Make explicit context a habit - use #file, @workspace, and other references consistently',
							'Make Copilot part of every coding task: planning, coding, testing, and reviewing'
						]
					},
					{
						stage: 4,
						label: 'Stage 4: Copilot Strategist',
						description: 'Deep integration across all development activities',
						thresholds: [
							'At least 15 sessions',
							'Using 2+ modes (ask + agent)',
							'At least 20 explicit context references',
							'Shows regular, purposeful usage pattern'
						],
						tips: [
							'You\'re at the highest level!',
							'Continue integrating Copilot into every aspect of your development workflow'
						]
					}
				]
			}
		]
	};
}

private getFluencyLevelViewerHtml(webview: vscode.Webview, data: {
	categories: Array<{
		category: string;
		icon: string;
		levels: Array<{
			stage: number;
			label: string;
			description: string;
			thresholds: string[];
			tips: string[];
		}>;
	}>;
	isDebugMode: boolean;
}): string {
	const nonce = this.getNonce();
	const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'fluency-level-viewer.js'));

	const csp = [
		`default-src 'none'`,
		`img-src ${webview.cspSource} https: data:`,
		`style-src 'unsafe-inline' ${webview.cspSource}`,
		`font-src ${webview.cspSource} https: data:`,
		`script-src 'nonce-${nonce}'`
	].join('; ');

	const dataWithBackend = { ...data, backendConfigured: this.isBackendConfigured() };
	const initialData = JSON.stringify(dataWithBackend).replace(/</g, '\\u003c');

	return `<!DOCTYPE html>
	<html lang="en">
	<head>
		<meta charset="UTF-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1.0" />
		<meta http-equiv="Content-Security-Policy" content="${csp}" />
		<title>Fluency Level Viewer</title>
	</head>
	<body>
		<div id="root"></div>
		<script nonce="${nonce}">window.__INITIAL_FLUENCY_LEVEL_DATA__ = ${initialData};</script>
		<script nonce="${nonce}" src="${scriptUri}"></script>
	</body>
	</html>`;
}

private getMaturityHtml(webview: vscode.Webview, data: {
		overallStage: number;
		overallLabel: string;
		categories: { category: string; icon: string; stage: number; evidence: string[]; tips: string[] }[];
		period: UsageAnalysisPeriod;
		lastUpdated: string;
		dismissedTips?: string[];
		isDebugMode?: boolean;
		fluencyLevels?: Array<{
			category: string;
			icon: string;
			levels: Array<{ stage: number; label: string; description: string; thresholds: string[]; tips: string[] }>;
		}>;
	}): string {
		const nonce = this.getNonce();
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'maturity.js'));

		const csp = [
			`default-src 'none'`,
			`img-src ${webview.cspSource} https: data:`,
			`style-src 'unsafe-inline' ${webview.cspSource}`,
			`font-src ${webview.cspSource} https: data:`,
			`script-src 'nonce-${nonce}'`
		].join('; ');

		const dataWithBackend = { ...data, backendConfigured: this.isBackendConfigured() };
		const initialData = JSON.stringify(dataWithBackend).replace(/</g, '\\u003c');

		return `<!DOCTYPE html>
		<html lang="en">
		<head>
			<meta charset="UTF-8" />
			<meta name="viewport" content="width=device-width, initial-scale=1.0" />
			<meta http-equiv="Content-Security-Policy" content="${csp}" />
			<title>Copilot Fluency Score</title>
		</head>
		<body>
			<div id="root"></div>
			<script nonce="${nonce}">window.__INITIAL_MATURITY__ = ${initialData};</script>
			<script nonce="${nonce}" src="${scriptUri}"></script>
		</body>
		</html>`;
	}

	/**
	 * Opens the Team Dashboard panel showing personal and team usage comparison.
	 */
	public async showDashboard(): Promise<void> {
		this.log('📊 Opening Team Dashboard');

		// Check if backend is configured
		if (!this.backend) {
			vscode.window.showWarningMessage('Team Dashboard requires backend sync to be configured. Please configure backend settings first.');
			return;
		}

		const settings = this.backend.getSettings();
		if (!this.backend.isConfigured(settings)) {
			vscode.window.showWarningMessage('Team Dashboard requires backend sync to be configured. Please configure backend settings first.');
			return;
		}

		// If panel already exists, just reveal it
		if (this.dashboardPanel) {
			this.dashboardPanel.reveal();
			this.log('📊 Team Dashboard revealed (already exists)');
			return;
		}

		// Show panel immediately with loading state
		this.dashboardPanel = vscode.window.createWebviewPanel(
			'copilotDashboard',
			'Team Dashboard',
			{ viewColumn: vscode.ViewColumn.One, preserveFocus: true },
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview')]
			}
		);

		this.dashboardPanel.webview.html = this.getDashboardHtml(this.dashboardPanel.webview, undefined);

		this.dashboardPanel.webview.onDidReceiveMessage(async (message) => {
			switch (message.command) {
				case 'refresh':
					await this.refreshDashboardPanel();
					break;
				case 'showDetails':
					await this.showDetails();
					break;
				case 'showChart':
					await this.showChart();
					break;
				case 'showUsageAnalysis':
					await this.showUsageAnalysis();
					break;
				case 'showDiagnostics':
					await this.showDiagnosticReport();
					break;
				case 'showMaturity':
					await this.showMaturity();
					break;
			}
		});

		this.dashboardPanel.onDidDispose(() => {
			this.log('📊 Team Dashboard closed');
			this.dashboardPanel = undefined;
		});

		// Load data asynchronously and send to webview
		try {
			const dashboardData = await this.getDashboardData();
			this.dashboardPanel?.webview.postMessage({ command: 'dashboardData', data: dashboardData });
		} catch (error) {
			this.error('Failed to load dashboard data:', error);
			this.dashboardPanel?.webview.postMessage({ command: 'dashboardError', message: 'Failed to load dashboard data. Please check backend configuration and try again.' });
		}
	}

	private async refreshDashboardPanel(): Promise<void> {
		if (!this.dashboardPanel) {
			return;
		}

		this.log('🔄 Refreshing Team Dashboard');
		this.dashboardPanel.webview.postMessage({ command: 'dashboardLoading' });
		try {
			const dashboardData = await this.getDashboardData();
			this.dashboardPanel?.webview.postMessage({ command: 'dashboardData', data: dashboardData });
			this.log('✅ Team Dashboard refreshed');
		} catch (error) {
			this.error('Failed to refresh dashboard:', error);
			this.dashboardPanel?.webview.postMessage({ command: 'dashboardError', message: 'Failed to refresh dashboard data.' });
		}
	}

	/**
	 * Fetches and aggregates data for the Team Dashboard.
	 */
	private async getDashboardData(): Promise<any> {
		if (!this.backend) {
			throw new Error('Backend not configured');
		}

		const { BackendUtility } = await import('./backend/services/utilityService.js');
		const settings = this.backend.getSettings();
		
		// Log backend settings for debugging
		this.log(`[Dashboard] Backend settings - userIdentityMode: ${settings.userIdentityMode}, configured userId: "${settings.userId}", datasetId: "${settings.datasetId}"`);
		
		// Resolve the effective userId for the current user based on backend config
		const currentUserId = await this.backend.resolveEffectiveUserId(settings);
		
		if (!currentUserId) {
			this.warn('[Dashboard] No user identity available. Ensure sharing profile includes user dimension.');
			this.warn(`[Dashboard] Settings: mode=${settings.userIdentityMode}, userId="${settings.userId}"`);
		}

		// Query backend for last 30 days
		const now = new Date();
		const todayKey = BackendUtility.toUtcDayKey(now);
		const startKey = BackendUtility.addDaysUtc(todayKey, -29);

		// Fetch ALL entities across all datasets using the facade's public API
		const allEntities = await this.backend.getAllAggEntitiesForRange(settings, startKey, todayKey);
		
		// Log all unique userIds and datasets in the data for debugging
		const uniqueUserIds = new Set(allEntities.map(e => (e.userId ?? '').toString()).filter(id => id.trim()));
		const uniqueDatasets = new Set(allEntities.map(e => (e.datasetId ?? '').toString()).filter(id => id.trim()));
		this.log(`[Dashboard] Fetched ${allEntities.length} entities for date range ${startKey} to ${todayKey}`);
		this.log(`[Dashboard] Current user ID resolved as: ${currentUserId || '(none)'}`);
		this.log(`[Dashboard] Datasets found: [${Array.from(uniqueDatasets).map(id => `"${id}"`).join(', ')}]`);
		this.log(`[Dashboard] UserIds in data: [${Array.from(uniqueUserIds).map(id => `"${id}"`).join(', ')}]`);

		// Aggregate personal data (all machines and workspaces for current user)
		const personalDevices = new Set<string>();
		const personalWorkspaces = new Set<string>();
		const personalModelUsage: { [model: string]: { inputTokens: number; outputTokens: number } } = {};
		let personalTotalTokens = 0;
		let personalTotalInteractions = 0;

		// Aggregate team data (all users across all datasets)
		const userMap = new Map<string, { 
			tokens: number; 
			interactions: number; 
			cost: number; 
			datasetId: string;
			sessions: Set<string>; // Track unique day+workspace+machine as session proxy
			models: Set<string>; // Track unique models used
			workspaces: Set<string>; // Track unique workspaces
			days: Set<string>; // Track unique days active
		}>();
		
		// Track first and last data points for reference
		let firstDate: string | null = null;
		let lastDate: string | null = null;

		for (const entity of allEntities) {
			const userId = (entity.userId ?? '').toString().replace(/^u:/, ''); // Strip u: prefix
			const datasetId = (entity.datasetId ?? '').toString().replace(/^ds:/, ''); // Strip ds: prefix
			const machineId = (entity.machineId ?? '').toString();
			const workspaceId = (entity.workspaceId ?? '').toString();
			const model = (entity.model ?? '').toString().replace(/^m:/, ''); // Strip m: prefix
			const inputTokens = Number.isFinite(Number(entity.inputTokens)) ? Number(entity.inputTokens) : 0;
			const outputTokens = Number.isFinite(Number(entity.outputTokens)) ? Number(entity.outputTokens) : 0;
			const interactions = Number.isFinite(Number(entity.interactions)) ? Number(entity.interactions) : 0;
			const tokens = inputTokens + outputTokens;
			const dayKey = (entity.day ?? '').toString().replace(/^d:/, ''); // Strip d: prefix

			// Track date range
			if (dayKey) {
				if (!firstDate || dayKey < firstDate) {
					firstDate = dayKey;
				}
				if (!lastDate || dayKey > lastDate) {
					lastDate = dayKey;
				}
			}

			// Personal data aggregation - match against resolved userId
			if (currentUserId && userId === currentUserId) {
				personalTotalTokens += tokens;
				personalTotalInteractions += interactions;
				personalDevices.add(machineId);
				personalWorkspaces.add(workspaceId);

				if (!personalModelUsage[model]) {
					personalModelUsage[model] = { inputTokens: 0, outputTokens: 0 };
				}
				personalModelUsage[model].inputTokens += inputTokens;
				personalModelUsage[model].outputTokens += outputTokens;
			}

			// Team data aggregation - use userId|datasetId as key to track users across datasets
			if (userId && userId.trim()) {
				const userKey = `${userId}|${datasetId}`;
				if (!userMap.has(userKey)) {
					userMap.set(userKey, { 
						tokens: 0, 
						interactions: 0, 
						cost: 0, 
						datasetId, 
						sessions: new Set<string>(),
						models: new Set<string>(),
						workspaces: new Set<string>(),
						days: new Set<string>()
					});
				}
				const userData = userMap.get(userKey)!;
				userData.tokens += tokens;
				userData.interactions += interactions;
				// Track unique sessions as day+workspace+machine combinations
				const sessionKey = `${dayKey}|${workspaceId}|${machineId}`;
				userData.sessions.add(sessionKey);
				// Track unique models, workspaces, and days
				if (model) { userData.models.add(model); }
				if (workspaceId) { userData.workspaces.add(workspaceId); }
				if (dayKey) { userData.days.add(dayKey); }
			}
		}

		// Calculate costs
		const personalCost = this.calculateEstimatedCost(personalModelUsage);
		
		// For team members, use a simplified cost estimate since we don't track
		// per-user model usage in aggregated data yet.
		// The personal cost uses the accurate model-aware calculation.
		for (const [userId, userData] of userMap.entries()) {
			userData.cost = (userData.tokens / 1000000) * 0.05;
		}

		// Build team leaderboard grouped by dataset
		const teamMembers = Array.from(userMap.entries())
			.map(([userKey, data]) => {
				const [userId, datasetId] = userKey.split('|');
				const sessionCount = data.sessions.size;
				const avgTurnsPerSession = sessionCount > 0 ? Math.round(data.interactions / sessionCount) : 0;
				const avgTokensPerTurn = data.interactions > 0 ? Math.round(data.tokens / data.interactions) : 0;
				return {
					userId,
					datasetId,
					totalTokens: data.tokens,
					totalInteractions: data.interactions,
					totalCost: data.cost,
					sessions: sessionCount,
					avgTurnsPerSession,
					uniqueModels: data.models.size,
					uniqueWorkspaces: data.workspaces.size,
					daysActive: data.days.size,
					avgTokensPerTurn,
					rank: 0
				};
			})
			.sort((a, b) => b.totalTokens - a.totalTokens)
			.map((member, index) => ({
				...member,
				rank: index + 1
			}));

		const teamTotalTokens = Array.from(userMap.values()).reduce((sum, u) => sum + u.tokens, 0);
		const teamTotalInteractions = Array.from(userMap.values()).reduce((sum, u) => sum + u.interactions, 0);
		const averageTokensPerUser = userMap.size > 0 ? teamTotalTokens / userMap.size : 0;

		this.log(`[Dashboard] Date range: ${firstDate} to ${lastDate} (${teamMembers.length} team members)`);
		this.log(`[Dashboard] Personal stats: ${personalTotalTokens} tokens, ${personalTotalInteractions} interactions, ${personalDevices.size} devices, ${personalWorkspaces.size} workspaces`);
		
		// Log each user's aggregated data for debugging
		for (const [userKey, data] of userMap.entries()) {
			const [userId, datasetId] = userKey.split('|');
			this.log(`[Dashboard] User "${userId}" (dataset: ${datasetId}): ${data.tokens} tokens, ${data.interactions} interactions`);
		}

		return {
			personal: {
				userId: currentUserId || '',
				totalTokens: personalTotalTokens,
				totalInteractions: personalTotalInteractions,
				totalCost: personalCost,
				devices: Array.from(personalDevices),
				workspaces: Array.from(personalWorkspaces),
				modelUsage: personalModelUsage
			},
			team: {
				members: teamMembers,
				totalTokens: teamTotalTokens,
				totalInteractions: teamTotalInteractions,
				averageTokensPerUser,
				firstDate,
				lastDate
			},
			lastUpdated: new Date().toISOString()
		};
	}

	private getDashboardHtml(webview: vscode.Webview, data: any | undefined): string {
		const nonce = this.getNonce();
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'dashboard.js'));

		const csp = [
			`default-src 'none'`,
			`img-src ${webview.cspSource} https: data:`,
			`style-src 'unsafe-inline' ${webview.cspSource}`,
			`font-src ${webview.cspSource} https: data:`,
			`script-src 'nonce-${nonce}'`
		].join('; ');

		const dataWithBackend = data ? { ...data, backendConfigured: this.isBackendConfigured() } : undefined;
		const initialDataScript = dataWithBackend
			? `<script nonce="${nonce}">window.__INITIAL_DASHBOARD__ = ${JSON.stringify(dataWithBackend).replace(/</g, '\\u003c')};</script>`
			: '';

		return `<!DOCTYPE html>
		<html lang="en">
		<head>
			<meta charset="UTF-8" />
			<meta name="viewport" content="width=device-width, initial-scale=1.0" />
			<meta http-equiv="Content-Security-Policy" content="${csp}" />
			<title>Team Dashboard</title>
		</head>
		<body>
			<div id="root"></div>
			${initialDataScript}
			<script nonce="${nonce}" src="${scriptUri}"></script>
		</body>
		</html>`;
	}

	private getNonce(): string {
		const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
		let text = '';
		for (let i = 0; i < 32; i++) {
			text += possible.charAt(Math.floor(Math.random() * possible.length));
		}
		return text;
	}

	/**
	 * Check if backend sync is configured for Team Dashboard access.
	 */
	private isBackendConfigured(): boolean {
		if (!this.backend) {
			return false;
		}
		const settings = this.backend.getSettings();
		return this.backend.isConfigured(settings);
	}

	private getDetailsHtml(webview: vscode.Webview, stats: DetailedStats): string {
		const nonce = this.getNonce();
		const scriptUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'details.js')
		);

		const csp = [
			`default-src 'none'`,
			`img-src ${webview.cspSource} https: data:`,
			`style-src 'unsafe-inline' ${webview.cspSource}`,
			`font-src ${webview.cspSource} https: data:`,
			`script-src 'nonce-${nonce}'`
		].join('; ');

		const dataWithBackend = { ...stats, backendConfigured: this.isBackendConfigured() };
		const initialData = JSON.stringify(dataWithBackend).replace(/</g, '\\u003c');

		return `<!DOCTYPE html>
		<html lang="en">
		<head>
			<meta charset="UTF-8" />
			<meta name="viewport" content="width=device-width, initial-scale=1.0" />
			<meta http-equiv="Content-Security-Policy" content="${csp}" />
			<title>Copilot Token Usage</title>
		</head>
		<body>
			<div id="root"></div>
			<script nonce="${nonce}">window.__INITIAL_DETAILS__ = ${initialData};</script>
			<script nonce="${nonce}" src="${scriptUri}"></script>
		</body>
		</html>`;
	}


	public async generateDiagnosticReport(): Promise<string> {
		this.log('Generating diagnostic report...');

		const report: string[] = [];

		// Header
		report.push('='.repeat(70));
		report.push('GitHub Copilot Token Tracker - Diagnostic Report');
		report.push('='.repeat(70));
		report.push('');

		// Extension Information
		report.push('## Extension Information');
		report.push(`Extension Version: ${vscode.extensions.getExtension('RobBos.copilot-token-tracker')?.packageJSON.version || 'Unknown'}`);
		report.push(`VS Code Version: ${vscode.version}`);
		report.push('');

		// System Information
		report.push('## System Information');
		report.push(`OS: ${os.platform()} ${os.release()} (${os.arch()})`);
		report.push(`Node Version: ${process.version}`);
		report.push(`Home Directory: ${os.homedir()}`);
		report.push(`Environment: ${process.env.CODESPACES === 'true' ? 'GitHub Codespaces' : (vscode.env.remoteName || 'Local')}`);
		report.push(`VS Code Machine ID: ${vscode.env.machineId}`);
		report.push(`VS Code Session ID: ${vscode.env.sessionId}`);
		report.push(`VS Code UI Kind: ${vscode.env.uiKind === vscode.UIKind.Desktop ? 'Desktop' : 'Web'}`);
		report.push(`Remote Name: ${vscode.env.remoteName || 'N/A'}`);
		report.push('');

		// GitHub Copilot Extension Status
		report.push('## GitHub Copilot Extension Status');
		const copilotExtension = vscode.extensions.getExtension('GitHub.copilot');
		const copilotChatExtension = vscode.extensions.getExtension('GitHub.copilot-chat');

		if (copilotExtension) {
			report.push(`GitHub Copilot Extension:`);
			report.push(`  - Installed: Yes`);
			report.push(`  - Version: ${copilotExtension.packageJSON.version}`);
			report.push(`  - Active: ${copilotExtension.isActive ? 'Yes' : 'No'}`);

			// Try to get Copilot tier information if available
			try {
				const copilotApi = copilotExtension.exports;
				if (copilotApi && copilotApi.status) {
					const status = copilotApi.status;
					// Display key status fields in a readable format
					if (typeof status === 'object') {
						Object.keys(status).forEach(key => {
							const value = status[key];
							if (value !== undefined && value !== null) {
								report.push(`  - ${key}: ${value}`);
							}
						});
					} else {
						report.push(`  - Status: ${status}`);
					}
				}
			} catch (error) {
				this.log(`Could not retrieve Copilot tier information: ${error}`);
			}
		} else {
			report.push(`GitHub Copilot Extension: Not Installed`);
		}

		if (copilotChatExtension) {
			report.push(`GitHub Copilot Chat Extension:`);
			report.push(`  - Installed: Yes`);
			report.push(`  - Version: ${copilotChatExtension.packageJSON.version}`);
			report.push(`  - Active: ${copilotChatExtension.isActive ? 'Yes' : 'No'}`);
		} else {
			report.push(`GitHub Copilot Chat Extension: Not Installed`);
		}
		report.push('');

		// Session Files Discovery
		report.push('## Session Files Discovery');
		try {
			const sessionFiles = await this.getCopilotSessionFiles();
			report.push(`Total Session Files Found: ${sessionFiles.length}`);
			report.push('');

			if (sessionFiles.length > 0) {
				report.push('Session File Locations (first 20):');

				// Use async file stat to avoid blocking the event loop
				const filesToShow = sessionFiles.slice(0, 20);
				const fileStats = await Promise.all(
					filesToShow.map(async (file) => {
						try {
							const stat = await fs.promises.stat(file);
							return { file, stat, error: null };
						} catch (error) {
							return { file, stat: null, error };
						}
					})
				);

				fileStats.forEach((result, index) => {
					if (result.stat) {
						report.push(`  ${index + 1}. ${result.file}`);
						report.push(`     - Size: ${result.stat.size} bytes`);
						report.push(`     - Modified: ${result.stat.mtime.toISOString()}`);
					} else {
						report.push(`  ${index + 1}. ${result.file}`);
						report.push(`     - Error: ${result.error}`);
					}
				});

				if (sessionFiles.length > 20) {
					report.push(`  ... and ${sessionFiles.length - 20} more files`);
				}
			} else {
				report.push('No session files found. Possible reasons:');
				report.push('  - Copilot extensions are not active');
				report.push('  - No Copilot Chat conversations have been initiated');
				report.push('  - Sessions stored in unsupported location');
				report.push('  - Authentication required with GitHub Copilot');
			}
			report.push('');
		} catch (error) {
			report.push(`Error discovering session files: ${error}`);
			report.push('');
		}

		// Cache Statistics
		report.push('## Cache Statistics');
		report.push(`Cached Session Files: ${this.sessionFileCache.size}`);
		report.push(`Cache Storage: Extension Global State`);
		report.push('');
		report.push('Cache provides faster loading by storing parsed session data with file modification timestamps.');
		report.push('Files are only re-parsed when their modification time changes.');
		report.push('');

		// Token Statistics
		report.push('## Token Usage Statistics');
		try {
			// Use cached session files to avoid redundant scans during diagnostic report generation
			// DO NOT call calculateDetailedStats here - it triggers expensive re-analysis
			// The loadDiagnosticDataInBackground method ensures stats are calculated if needed
			try {
				const sessionFiles = await this.getCopilotSessionFiles();
				report.push(`Total Session Files Found: ${sessionFiles.length}`);
				report.push("");

				// Group session files by their parent directory
				const dirCounts = new Map<string, number>();
				for (const file of sessionFiles) {
					const parent = require('path').dirname(file);
					dirCounts.set(parent, (dirCounts.get(parent) || 0) + 1);
				}
				if (dirCounts.size > 0) {
					report.push("Session Files by Directory:");
					for (const [dir, count] of dirCounts.entries()) {
						report.push(`  ${dir}: ${count}`);
					}
					report.push("");
				}

				if (sessionFiles.length > 0) {
					report.push('Session File Locations (first 20):');
					const filesToShow = sessionFiles.slice(0, 20);
					const fileStats = await Promise.all(
						filesToShow.map(async (file) => {
							try {
								const stat = await fs.promises.stat(file);
								return { file, stat, error: null };
							} catch (error) {
								return { file, stat: null, error };
							}
						})
					);
					fileStats.forEach((result, index) => {
						if (result.stat) {
							report.push(`  ${index + 1}. ${result.file}`);
							report.push(`     - Size: ${result.stat.size} bytes`);
							report.push(`     - Modified: ${result.stat.mtime.toISOString()}`);
						} else {
							report.push(`  ${index + 1}. ${result.file}`);
							report.push(`     - Error: ${result.error}`);
						}
					});
					if (sessionFiles.length > 20) {
						report.push(`  ... and ${sessionFiles.length - 20} more files`);
					}
				} else {
					report.push('No session files found. Possible reasons:');
					report.push('  - Copilot extensions are not active');
					report.push('  - No Copilot Chat conversations have been initiated');
					report.push('  - Sessions stored in unsupported location');
					report.push('  - Authentication required with GitHub Copilot');
				}
				report.push('');
			} catch (error) {
				report.push(`Error discovering session files: ${error}`);
				report.push('');
			}
		} catch (error) {
			report.push(`Error calculating token usage statistics: ${error}`);
			report.push('');
		}

		// Footer
		report.push('='.repeat(70));
		report.push(`Report Generated: ${new Date().toISOString()}`);
		report.push('='.repeat(70));
		report.push('');
		report.push('This report can be shared with the extension maintainers to help');
		report.push('troubleshoot issues. No sensitive data from your code is included.');
		report.push('');
		report.push('Submit issues at:');
		report.push(`${this.getRepositoryUrl()}/issues`);

		const fullReport = report.join('\n');
		this.log('Diagnostic report generated successfully');
		return fullReport;
	}

	public async showDiagnosticReport(): Promise<void> {
		this.log('🔍 Opening Diagnostic Report');

		// If panel already exists, just reveal it and trigger a refresh in the background
		if (this.diagnosticsPanel) {
			this.diagnosticsPanel.reveal();
			this.log('🔍 Diagnostic Report revealed (already exists)');
			// Load data in background and update the webview
			this.loadDiagnosticDataInBackground(this.diagnosticsPanel);
			return;
		}

		// Create the panel immediately with loading state
		this.diagnosticsPanel = vscode.window.createWebviewPanel(
			'copilotTokenDiagnostics',
			'Diagnostic Report',
			{
				viewColumn: vscode.ViewColumn.One,
				preserveFocus: false
			},
			{
				enableScripts: true,
				retainContextWhenHidden: true, // Keep webview context to avoid reloading session files
				localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview')]
			}
		);

		this.log('✅ Diagnostic Report panel created');

		// Set the HTML content immediately with loading state
		// Note: "Loading..." is the agreed contract between backend and frontend
		// The webview checks for this value to show a loading indicator
		this.diagnosticsPanel.webview.html = this.getDiagnosticReportHtml(
			this.diagnosticsPanel.webview,
			'Loading...', // Placeholder report
			[], // Empty session files
			[], // Empty detailed session files
			[], // Empty session folders
			null // No backend info yet
		);

		// Handle messages from the webview
		this.diagnosticsPanel.webview.onDidReceiveMessage(async (message) => {
			switch (message.command) {
				case 'copyReport':
					await vscode.env.clipboard.writeText(this.lastDiagnosticReport);
					vscode.window.showInformationMessage('Diagnostic report copied to clipboard');
					break;
				case 'openIssue':
					await vscode.env.clipboard.writeText(this.lastDiagnosticReport);
					vscode.window.showInformationMessage('Diagnostic report copied to clipboard. Please paste it into the GitHub issue.');
					const shortBody = encodeURIComponent('The diagnostic report has been copied to the clipboard. Please paste it below.');
					const issueUrl = `${this.getRepositoryUrl()}/issues/new?body=${shortBody}`;
					await vscode.env.openExternal(vscode.Uri.parse(issueUrl));
					break;
				case 'openSessionFile':
					if (message.file) {
						try {
							// Open the session file in the log viewer
							await this.showLogViewer(message.file);
						} catch (err) {
							vscode.window.showErrorMessage('Could not open log viewer: ' + message.file);
						}
					}
					break;

				case 'openFormattedJsonlFile':
					if (message.file) {
						try {
							await this.showFormattedJsonlFile(message.file);
						} catch (err) {
							const errorMsg = err instanceof Error ? err.message : String(err);
							vscode.window.showErrorMessage('Could not open formatted file: ' + message.file + ' (' + errorMsg + ')');
						}
					}
					break;

				case 'revealPath':
					if (message.path) {
						try {
							const fs = require('fs');
							const pathModule = require('path');
							const normalized = pathModule.normalize(message.path);

							// If the path exists and is a directory, open it directly in the OS file manager.
							// Using `vscode.env.openExternal` with a file URI reliably opens the folder itself.
							try {
								const stat = await fs.promises.stat(normalized);
								if (stat.isDirectory()) {
									await vscode.env.openExternal(vscode.Uri.file(normalized));
								} else {
									// For files, reveal the file in OS (select it)
									await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(normalized));
								}
							} catch (err) {
								// If the stat fails, fallback to revealFileInOS which may still work
								await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(normalized));
							}
						} catch (err) {
							vscode.window.showErrorMessage('Could not reveal: ' + message.path);
						}
					}
					break;
				case 'showDetails':
					await this.showDetails();
					break;
				case 'showChart':
					await this.showChart();
					break;
				case 'showUsageAnalysis':
					await this.showUsageAnalysis();
					break;
				case 'showMaturity':
					await this.showMaturity();
					break;
				case 'clearCache':
					this.log('clearCache message received from diagnostics webview');
					await this.clearCache();
					// After clearing cache, refresh the diagnostic report if it's open
					if (this.diagnosticsPanel) {
						// Send completion message to webview before refreshing
						this.diagnosticsPanel.webview.postMessage({ command: 'cacheCleared' });
						// Wait a moment for the message to be processed
						await new Promise(resolve => setTimeout(resolve, 500));
						// Simply refresh the diagnostic report by revealing it again
						// This will trigger a rebuild with fresh data
						await this.showDiagnosticReport();
					}
					break;
				case 'configureBackend':
					// Execute the configureBackend command if it exists
					try {
						await vscode.commands.executeCommand('copilot-token-tracker.configureBackend');
					} catch (err) {
						// If command is not registered, show settings
						vscode.window.showInformationMessage(
							'Backend configuration is available in settings. Search for "Copilot Token Tracker: Backend" in settings.',
							'Open Settings'
						).then(choice => {
							if (choice === 'Open Settings') {
								vscode.commands.executeCommand('workbench.action.openSettings', 'copilotTokenTracker.backend');
							}
						});
					}
					break;
				case 'openSettings':
					await vscode.commands.executeCommand('workbench.action.openSettings', 'copilotTokenTracker.backend');
					break;
				case 'showDashboard':
					await this.showDashboard();
					break;
			}
		});

		// Handle panel disposal
		this.diagnosticsPanel.onDidDispose(() => {
			this.log('🔍 Diagnostic Report closed');
			this.diagnosticsPanel = undefined;
		});

		// Load data in background and update the webview when ready
		this.loadDiagnosticDataInBackground(this.diagnosticsPanel);
	}

	/**
	 * Load all diagnostic data in the background and update the webview progressively.
	 */
	private async loadDiagnosticDataInBackground(panel: vscode.WebviewPanel): Promise<void> {
		try {
			this.log('🔄 Loading diagnostic data in background...');

			// CRITICAL: Ensure stats have been calculated at least once to populate cache
			// If this is the first diagnostic panel open and no stats exist yet,
			// force an update now so the cache is populated before we load session files.
			// This dramatically improves performance on first load (near 100% cache hit rate).
			if (!this.lastDetailedStats) {
				this.log('⚡ No cached stats found - forcing initial stats calculation to populate cache...');
				await this.updateTokenStats(true);
				this.log('✅ Cache populated, proceeding with diagnostics load');
			}

			// Load the diagnostic report
			const report = await this.generateDiagnosticReport();
			this.lastDiagnosticReport = report;

			// Get session files
			const sessionFiles = await this.getCopilotSessionFiles();

			// Get first 20 session files with stats (quick preview)
			const sessionFileData: { file: string; size: number; modified: string }[] = [];
			for (const file of sessionFiles.slice(0, 20)) {
				try {
					const stat = await this.statSessionFile(file);
					sessionFileData.push({
						file,
						size: stat.size,
						modified: stat.mtime.toISOString()
					});
				} catch {
					// Skip inaccessible files
				}
			}

			// Build folder counts grouped by top-level VS Code user folder (editor roots)
			const dirCounts = new Map<string, number>();
			const pathModule = require('path');
			const copilotSessionStateDir = pathModule.join(os.homedir(), '.copilot', 'session-state');
			for (const file of sessionFiles) {
				// Handle OpenCode DB virtual paths (opencode.db#ses_<id>)
				if (this.isOpenCodeDbSession(file)) {
					const editorRoot = this.getOpenCodeDataDir();
					dirCounts.set(editorRoot, (dirCounts.get(editorRoot) || 0) + 1);
					continue;
				}
				const parts = file.split(/[\\\/]/);
				const userIdx = parts.findIndex((p: string) => p.toLowerCase() === 'user');
				let editorRoot = '';
				if (userIdx > 0) {
					const rootParts = parts.slice(0, Math.min(parts.length, userIdx + 2));
					editorRoot = pathModule.join(...rootParts);
				} else {
					editorRoot = pathModule.dirname(file);
				}
				// Group all CLI session-state subdirectories under the common parent
				if (editorRoot.startsWith(copilotSessionStateDir) && editorRoot !== copilotSessionStateDir) {
					editorRoot = copilotSessionStateDir;
				}
				dirCounts.set(editorRoot, (dirCounts.get(editorRoot) || 0) + 1);
			}
			const sessionFolders = Array.from(dirCounts.entries()).map(([dir, count]) => ({
				dir,
				count,
				editorName: this.getEditorNameFromRoot(dir)
			}));

			// Get backend storage info
			const backendStorageInfo = await this.getBackendStorageInfo();
			this.log(`Backend storage info retrieved: enabled=${backendStorageInfo.enabled}, configured=${backendStorageInfo.isConfigured}`);

			// Check if panel is still open before updating
			if (!this.isPanelOpen(panel)) {
				this.log('Diagnostic panel closed during data load, aborting update');
				return;
			}

			// Send the loaded data to the webview
			this.log(`Sending backend info to webview: ${backendStorageInfo ? 'present' : 'missing'}`);
			panel.webview.postMessage({
				command: 'diagnosticDataLoaded',
				report,
				sessionFiles: sessionFileData,
				sessionFolders,
				backendStorageInfo
			});

			this.log('✅ Diagnostic data loaded and sent to webview');

			// Now load detailed session files in the background
			this.loadSessionFilesInBackground(panel, sessionFiles);
		} catch (error) {
			this.error(`Failed to load diagnostic data: ${error}`);
			// Send error to webview if panel is still open
			if (this.isPanelOpen(panel)) {
				panel.webview.postMessage({
					command: 'diagnosticDataError',
					error: String(error)
				});
			}
		}
	}

	/**
	 * Check if a webview panel is still open and accessible.
	 * A panel is considered open if its viewColumn is defined.
	 */
	private isPanelOpen(panel: vscode.WebviewPanel): boolean {
		return panel.viewColumn !== undefined;
	}

	/**
	 * Load session file details in the background and send to webview.
	 */
	private async loadSessionFilesInBackground(
		panel: vscode.WebviewPanel,
		sessionFiles: string[]
	): Promise<void> {
		const fourteenDaysAgo = new Date();
		fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);
		const detailedSessionFiles: SessionFileDetails[] = [];

		// Track cache performance for this load operation
		const initialCacheHits = this._cacheHits;
		const initialCacheMisses = this._cacheMisses;

		// Sort files by modification time (most recent first) before taking first 500
		// This ensures we prioritize recent sessions regardless of their folder location
		const fileStats = await Promise.all(
			sessionFiles.map(async (file) => {
				try {
					const stat = await this.statSessionFile(file);
					return { file, mtime: stat.mtime.getTime() };
				} catch {
					return { file, mtime: 0 };
				}
			})
		);

		const sortedFiles = fileStats
			.sort((a, b) => b.mtime - a.mtime)
			.map(item => item.file);

		// Process up to 500 most recent session files
		for (const file of sortedFiles.slice(0, 500)) {
			// Check if panel was disposed
			if (!this.isPanelOpen(panel)) {
				this.log('Diagnostic panel closed, stopping background load');
				return;
			}

			try {
				const details = await this.getSessionFileDetails(file);
				// Only include sessions with activity (lastInteraction or file modified time) within the last x days
				const lastActivity = details.lastInteraction
					? new Date(details.lastInteraction)
					: new Date(details.modified);
				if (lastActivity >= fourteenDaysAgo) {
					detailedSessionFiles.push(details);
				}
			} catch {
				// Skip inaccessible files
			}
		}

		// Send the loaded data to the webview
		try {
			// Cache the loaded session files so we can re-send if the webview is recreated
			if (panel === this.diagnosticsPanel) {
				this.diagnosticsCachedFiles = detailedSessionFiles;
			}
			// Log summary stats
			const withRepo = detailedSessionFiles.filter(s => s.repository).length;
			this.log(`📊 Sending ${detailedSessionFiles.length} sessions to diagnostics (${withRepo} with repository info)`);
			await panel.webview.postMessage({
				command: 'sessionFilesLoaded',
				detailedSessionFiles
			});

			// Calculate and log cache performance for this operation
			const cacheHits = this._cacheHits - initialCacheHits;
			const cacheMisses = this._cacheMisses - initialCacheMisses;
			const totalAccesses = cacheHits + cacheMisses;
			const hitRate = totalAccesses > 0 ? ((cacheHits / totalAccesses) * 100).toFixed(1) : '0.0';

			this.log(`Loaded ${detailedSessionFiles.length} session files in background (Cache: ${cacheHits} hits, ${cacheMisses} misses, ${hitRate}% hit rate)`);

			// Mark diagnostics as loaded so we don't reload unnecessarily
			if (panel === this.diagnosticsPanel) {
				this.diagnosticsHasLoadedFiles = true;
			}
		} catch (err) {
			// Panel may have been disposed
			this.log('Could not send session files to panel (may be closed)');
		}
	}

	/**
	 * Get backend storage information for diagnostics
	 */
	private async getBackendStorageInfo(): Promise<any> {
		const config = vscode.workspace.getConfiguration('copilotTokenTracker');
		const enabled = config.get<boolean>('backend.enabled', false);
		const storageAccount = config.get<string>('backend.storageAccount', '');
		const subscriptionId = config.get<string>('backend.subscriptionId', '');
		const resourceGroup = config.get<string>('backend.resourceGroup', '');
		const aggTable = config.get<string>('backend.aggTable', 'usageAggDaily');
		const eventsTable = config.get<string>('backend.eventsTable', 'usageEvents');
		const authMode = config.get<string>('backend.authMode', 'entraId');
		const sharingProfile = config.get<string>('backend.sharingProfile', 'off');

		// Get last sync time from global state
		const lastSyncAt = this.context.globalState.get<number>('backend.lastSyncAt');
		const lastSyncTime = lastSyncAt ? new Date(lastSyncAt).toISOString() : null;

		// Check if backend is configured (has required settings)
		const isConfigured = enabled && storageAccount && subscriptionId && resourceGroup;

		// Get unique device count from session files (estimate based on unique workspace roots)
		const sessionFiles = await this.getCopilotSessionFiles();
		const workspaceIds = new Set<string>();
		const pathModule = require('path');

		for (const file of sessionFiles) {
			const parts = file.split(/[\\\/]/);
			const workspaceStorageIdx = parts.findIndex(p => p.toLowerCase() === 'workspacestorage');
			if (workspaceStorageIdx >= 0 && workspaceStorageIdx < parts.length - 1) {
				const workspaceId = parts[workspaceStorageIdx + 1];
				if (workspaceId && workspaceId.length > 10) {
					workspaceIds.add(workspaceId);
				}
			}
		}

		return {
			enabled,
			isConfigured,
			storageAccount,
			subscriptionId: subscriptionId ? subscriptionId.substring(0, 8) + '...' : '',
			resourceGroup,
			aggTable,
			eventsTable,
			authMode,
			sharingProfile,
			lastSyncTime,
			deviceCount: workspaceIds.size,
			sessionCount: sessionFiles.length,
			recordCount: null // Will be populated from Azure if configured
		};
	}

	private getDiagnosticReportHtml(
		webview: vscode.Webview,
		report: string,
		sessionFiles: { file: string; size: number; modified: string }[],
		detailedSessionFiles: SessionFileDetails[],
		sessionFolders: { dir: string; count: number }[] = [],
		backendStorageInfo: any = null
	): string {
		const nonce = this.getNonce();
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'diagnostics.js'));

		const csp = [
			`default-src 'none'`,
			`img-src ${webview.cspSource} https: data:`,
			`style-src 'unsafe-inline' ${webview.cspSource}`,
			`font-src ${webview.cspSource} https: data:`,
			`script-src 'nonce-${nonce}'`
		].join('; ');

		// Get cache information
		let cacheSizeInMB = 0;
		try {
			// Estimate cache size by serializing to JSON
			const cacheData = Object.fromEntries(this.sessionFileCache);
			const jsonString = JSON.stringify(cacheData);
			cacheSizeInMB = (jsonString.length * 2) / (1024 * 1024); // UTF-16 encoding (2 bytes per char)
		} catch {
			cacheSizeInMB = 0;
		}

		// Try to read the persisted cache from VS Code global state to show its actual storage status
		let persistedCacheSummary = 'Not found in VS Code Global State';
		try {
			const persisted = this.context.globalState.get<Record<string, SessionFileCache>>('sessionFileCache');
			if (persisted && typeof persisted === 'object') {
				const count = Object.keys(persisted).length;
				persistedCacheSummary = `VS Code Global State - sessionFileCache (${count} entr${count === 1 ? 'y' : 'ies'})`;
			}
		} catch (e) {
			persistedCacheSummary = 'Error reading VS Code Global State';
		}

		// Try to locate the actual storage file (state DB) for the extension global state
		let storageFilePath: string | null = null;
		try {
			const extensionId = 'RobBos.copilot-token-tracker';
			const userPaths = this.getVSCodeUserPaths();
			for (const userPath of userPaths) {
				try {
					const candidate = path.join(userPath, 'globalStorage', extensionId);
					if (fs.existsSync(candidate)) {
						const files = fs.readdirSync(candidate);
						// Look for likely state files
						const match = files.find(f => f.includes('state') || f.endsWith('.vscdb') || f.endsWith('.json'));
						if (match) {
							storageFilePath = path.join(candidate, match);
							break;
						}
					}
				} catch (e) {
					// ignore path access errors
				}
			}
		} catch (e) {
			// ignore
		}

		const cacheInfo = {
			size: this.sessionFileCache.size,
			sizeInMB: cacheSizeInMB,
			lastUpdated: this.sessionFileCache.size > 0 ? new Date().toISOString() : null,
			location: persistedCacheSummary,
			storagePath: storageFilePath
		};

		const initialData = JSON.stringify({ report, sessionFiles, detailedSessionFiles, sessionFolders, cacheInfo, backendStorageInfo, backendConfigured: this.isBackendConfigured() }).replace(/</g, '\\u003c');

		return `<!DOCTYPE html>
		<html lang="en">
		<head>
			<meta charset="UTF-8" />
			<meta name="viewport" content="width=device-width, initial-scale=1.0" />
			<meta http-equiv="Content-Security-Policy" content="${csp}" />
			<title>Diagnostic Report</title>
		</head>
		<body>
			<div id="root"></div>
			<script nonce="${nonce}">window.__INITIAL_DIAGNOSTICS__ = ${initialData};</script>
			<script nonce="${nonce}" src="${scriptUri}"></script>
		</body>
		</html>`;
	}

	private getChartHtml(webview: vscode.Webview, dailyStats: DailyTokenStats[]): string {
		const nonce = this.getNonce();
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'chart.js'));

		const csp = [
			`default-src 'none'`,
			`img-src ${webview.cspSource} https: data:`,
			`style-src 'unsafe-inline' ${webview.cspSource}`,
			`font-src ${webview.cspSource} https: data:`,
			`script-src 'nonce-${nonce}'`
		].join('; ');

		// Transform dailyStats into the structure expected by the webview
		const labels = dailyStats.map(d => d.date);
		const tokensData = dailyStats.map(d => d.tokens);
		const sessionsData = dailyStats.map(d => d.sessions);

		// Aggregate model usage across all days
		const allModels = new Set<string>();
		dailyStats.forEach(d => Object.keys(d.modelUsage).forEach(m => allModels.add(m)));

		const modelColors = [
			{ bg: 'rgba(54, 162, 235, 0.6)', border: 'rgba(54, 162, 235, 1)' },
			{ bg: 'rgba(255, 99, 132, 0.6)', border: 'rgba(255, 99, 132, 1)' },
			{ bg: 'rgba(75, 192, 192, 0.6)', border: 'rgba(75, 192, 192, 1)' },
			{ bg: 'rgba(153, 102, 255, 0.6)', border: 'rgba(153, 102, 255, 1)' },
			{ bg: 'rgba(255, 159, 64, 0.6)', border: 'rgba(255, 159, 64, 1)' },
			{ bg: 'rgba(255, 205, 86, 0.6)', border: 'rgba(255, 205, 86, 1)' },
			{ bg: 'rgba(201, 203, 207, 0.6)', border: 'rgba(201, 203, 207, 1)' },
			{ bg: 'rgba(100, 181, 246, 0.6)', border: 'rgba(100, 181, 246, 1)' }
		];

		const modelDatasets = Array.from(allModels).map((model, idx) => {
			const color = modelColors[idx % modelColors.length];
			return {
				label: getModelDisplayName(model),
				data: dailyStats.map(d => {
					const usage = d.modelUsage[model];
					return usage ? usage.inputTokens + usage.outputTokens : 0;
				}),
				backgroundColor: color.bg,
				borderColor: color.border,
				borderWidth: 1
			};
		});

		// Aggregate editor usage across all days
		const allEditors = new Set<string>();
		dailyStats.forEach(d => Object.keys(d.editorUsage).forEach(e => allEditors.add(e)));

		const editorDatasets = Array.from(allEditors).map((editor, idx) => {
			const color = modelColors[idx % modelColors.length];
			return {
				label: editor,
				data: dailyStats.map(d => d.editorUsage[editor]?.tokens || 0),
				backgroundColor: color.bg,
				borderColor: color.border,
				borderWidth: 1
			};
		});

		// Aggregate repository usage across all days
		const allRepositories = new Set<string>();
		dailyStats.forEach(d => Object.keys(d.repositoryUsage).forEach(r => allRepositories.add(r)));

		const repositoryDatasets = Array.from(allRepositories).map((repo, idx) => {
			const color = modelColors[idx % modelColors.length];
			// Shorten repository URL for display (e.g., "owner/repo")
			const label = this.getRepoDisplayName(repo);
			return {
				label,
				fullRepo: repo,
				data: dailyStats.map(d => d.repositoryUsage[repo]?.tokens || 0),
				backgroundColor: color.bg,
				borderColor: color.border,
				borderWidth: 1
			};
		});

		// Calculate repository totals for summary
		const repositoryTotalsMap: Record<string, number> = {};
		dailyStats.forEach(d => {
			Object.entries(d.repositoryUsage).forEach(([repo, usage]) => {
				const displayName = this.getRepoDisplayName(repo);
				repositoryTotalsMap[displayName] = (repositoryTotalsMap[displayName] || 0) + usage.tokens;
			});
		});

		// Calculate editor totals for summary cards
		const editorTotalsMap: Record<string, number> = {};
		dailyStats.forEach(d => {
			Object.entries(d.editorUsage).forEach(([editor, usage]) => {
				editorTotalsMap[editor] = (editorTotalsMap[editor] || 0) + usage.tokens;
			});
		});

		const totalTokens = tokensData.reduce((a, b) => a + b, 0);
		const totalSessions = sessionsData.reduce((a, b) => a + b, 0);

		const chartData = {
			labels,
			tokensData,
			sessionsData,
			modelDatasets,
			editorDatasets,
			editorTotalsMap,
			repositoryDatasets,
			repositoryTotalsMap,
			dailyCount: dailyStats.length,
			totalTokens,
			avgTokensPerDay: dailyStats.length > 0 ? Math.round(totalTokens / dailyStats.length) : 0,
			totalSessions,
			lastUpdated: new Date().toISOString(),
			backendConfigured: this.isBackendConfigured()
		};

		const initialData = JSON.stringify(chartData).replace(/</g, '\\u003c');

		return `<!DOCTYPE html>
		<html lang="en">
		<head>
			<meta charset="UTF-8" />
			<meta name="viewport" content="width=device-width, initial-scale=1.0" />
			<meta http-equiv="Content-Security-Policy" content="${csp}" />
			<title>Copilot Token Usage Chart</title>
		</head>
		<body>
			<div id="root"></div>
			<script nonce="${nonce}">window.__INITIAL_CHART__ = ${initialData};</script>
			<script nonce="${nonce}" src="${scriptUri}"></script>
		</body>
		</html>`;
	}

	private getUsageAnalysisHtml(webview: vscode.Webview, stats: UsageAnalysisStats): string {
		const nonce = this.getNonce();
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'usage.js'));

		const csp = [
			`default-src 'none'`,
			`img-src ${webview.cspSource} https: data:`,
			`style-src 'unsafe-inline' ${webview.cspSource}`,
			`font-src ${webview.cspSource} https: data:`,
			`script-src 'nonce-${nonce}'`
		].join('; ');

		// Detect user's locale for number formatting
		const localeFromEnv = process.env.LC_ALL || process.env.LC_NUMERIC || process.env.LANG;
		const vscodeLanguage = vscode.env.language; // e.g., 'en', 'nl', 'de'
		const intlLocale = Intl.DateTimeFormat().resolvedOptions().locale;
		
		this.log(`[Locale Detection] VS Code language: ${vscodeLanguage}`);
		this.log(`[Locale Detection] Environment locale: ${localeFromEnv || 'not set'}`);
		this.log(`[Locale Detection] Intl default: ${intlLocale}`);
		
		const detectedLocale = stats.locale || localeFromEnv || intlLocale;
		this.log(`[Usage Analysis] Extension detected locale: ${detectedLocale}`);
		this.log(`[Usage Analysis] Test format 1234567.89: ${new Intl.NumberFormat(detectedLocale).format(1234567.89)}`);
		
		const initialData = JSON.stringify({
			today: stats.today,
			last30Days: stats.last30Days,
			month: stats.month,
			locale: detectedLocale,
			customizationMatrix: stats.customizationMatrix || null,
			missedPotential: stats.missedPotential || [],
			lastUpdated: stats.lastUpdated.toISOString(),
			backendConfigured: this.isBackendConfigured()
		}).replace(/</g, '\\u003c');

		return `<!DOCTYPE html>
		<html lang="en">
		<head>
			<meta charset="UTF-8" />
			<meta name="viewport" content="width=device-width, initial-scale=1.0" />
			<meta http-equiv="Content-Security-Policy" content="${csp}" />
			<title>Usage Analysis</title>
		</head>
		<body>
			<div id="root"></div>
			<script nonce="${nonce}">window.__INITIAL_USAGE__ = ${initialData};</script>
			<script nonce="${nonce}" src="${scriptUri}"></script>
		</body>
		</html>`;
	}

	public dispose(): void {
		if (this.updateInterval) {
			clearInterval(this.updateInterval);
		}
		if (this.initialDelayTimeout) {
			clearTimeout(this.initialDelayTimeout);
			this.log('Cleared initial delay timeout during disposal');
		}
		if (this.detailsPanel) {
			this.detailsPanel.dispose();
		}
		if (this.chartPanel) {
			this.chartPanel.dispose();
		}
		if (this.analysisPanel) {
			this.analysisPanel.dispose();
		}
		if (this.maturityPanel) {
			this.maturityPanel.dispose();
		}
		// Save cache to storage before disposing (fire-and-forget async operation)
		// Note: Cache loss during abnormal shutdown is acceptable as it will rebuild on next startup
		// We can't await here since dispose() is synchronous
		this.saveCacheToStorage().catch(err => {
			// Output channel will be disposed, so log to console as fallback
			console.error('Error saving cache during disposal:', err);
		});
		if (this.logViewerPanel) {
			this.logViewerPanel.dispose();
		}
		if (this.diagnosticsPanel) {
			this.diagnosticsPanel.dispose();
		}
		this.statusBarItem.dispose();
		this.outputChannel.dispose();
	}
}

export function activate(context: vscode.ExtensionContext) {
	// Create the token tracker
	const tokenTracker = new CopilotTokenTracker(context.extensionUri, context);

	// Wire up backend facade and commands so the diagnostics webview can launch the
	// configuration wizard. Uses tokenTracker logging and helpers via casting to any.
	try {
		const backendFacade = new BackendFacade({
			context,
			log: (m: string) => (tokenTracker as any).log(m),
			warn: (m: string) => (tokenTracker as any).warn(m),
			updateTokenStats: () => (tokenTracker as any).updateTokenStats(),
			calculateEstimatedCost: (modelUsage: any) => {
				let total = 0;
				const pricing = (modelPricingData as any).pricing || {};
				for (const [model, usage] of Object.entries(modelUsage || {})) {
					const p = pricing[model] || pricing['gpt-4o-mini'];
					if (!p) { continue; }
					const usageData = usage as { inputTokens?: number; outputTokens?: number };
					total += ((usageData.inputTokens || 0) / 1_000_000) * p.inputCostPerMillion;
					total += ((usageData.outputTokens || 0) / 1_000_000) * p.outputCostPerMillion;
				}
				return total;
			},
			co2Per1kTokens: 0.2,
			waterUsagePer1kTokens: 0.3,
			co2AbsorptionPerTreePerYear: 21000,
			getCopilotSessionFiles: () => (tokenTracker as any).getCopilotSessionFiles(),
			estimateTokensFromText: (text: string, model?: string) => (tokenTracker as any).estimateTokensFromText(text, model),
			getModelFromRequest: (req: any) => (tokenTracker as any).getModelFromRequest(req),
			getSessionFileDataCached: (p: string, m: number, s: number) => (tokenTracker as any).getSessionFileDataCached(p, m, s),
			statSessionFile: (sessionFile: string) => (tokenTracker as any).statSessionFile(sessionFile),
			isOpenCodeSession: (sessionFile: string) => (tokenTracker as any).isOpenCodeSessionFile(sessionFile),
			getOpenCodeSessionData: (sessionFile: string) => (tokenTracker as any).getOpenCodeSessionData(sessionFile)
		});

		const backendHandler = new BackendCommandHandler({
			facade: backendFacade as any,
			integration: undefined,
			calculateEstimatedCost: (mu: any) => 0,
			warn: (m: string) => (tokenTracker as any).warn(m),
			log: (m: string) => (tokenTracker as any).log(m)
		});

		// Store backend facade in the tracker instance for dashboard access
		(tokenTracker as any).backend = backendFacade;

		// Backend sync timer will be started after initial token analysis completes
		// (see startBackendSyncAfterInitialAnalysis method)

		const configureBackendCommand = vscode.commands.registerCommand('copilot-token-tracker.configureBackend', async () => {
			await backendHandler.handleConfigureBackend();
		});

		context.subscriptions.push(configureBackendCommand);
	} catch (err) {
		// If backend wiring fails for any reason, don't block activation - fall back to settings behavior.
		(tokenTracker as any).warn('Failed to wire backend commands: ' + String(err));
	}

	// Register the refresh command
	const refreshCommand = vscode.commands.registerCommand('copilot-token-tracker.refresh', async () => {
		tokenTracker.log('Refresh command called');
		await tokenTracker.updateTokenStats();
		vscode.window.showInformationMessage('Copilot token usage refreshed');
	});

	// Register the show details command
	const showDetailsCommand = vscode.commands.registerCommand('copilot-token-tracker.showDetails', async () => {
		tokenTracker.log('Show details command called');
		await tokenTracker.showDetails();
	});

	// Register the show chart command
	const showChartCommand = vscode.commands.registerCommand('copilot-token-tracker.showChart', async () => {
		tokenTracker.log('Show chart command called');
		await tokenTracker.showChart();
	});

	// Register the show usage analysis command
	const showUsageAnalysisCommand = vscode.commands.registerCommand('copilot-token-tracker.showUsageAnalysis', async () => {
		tokenTracker.log('Show usage analysis command called');
		await tokenTracker.showUsageAnalysis();
	});

	// Register the show maturity / fluency score command
	const showMaturityCommand = vscode.commands.registerCommand('copilot-token-tracker.showMaturity', async () => {
		tokenTracker.log('Show maturity command called');
		await tokenTracker.showMaturity();
	});

	// Register the show dashboard command
	const showDashboardCommand = vscode.commands.registerCommand('copilot-token-tracker.showDashboard', async () => {
		tokenTracker.log('Show dashboard command called');
		await tokenTracker.showDashboard();
	});
  
	// Register the show fluency level viewer command (debug-only)
	const showFluencyLevelViewerCommand = vscode.commands.registerCommand('copilot-token-tracker.showFluencyLevelViewer', async () => {
		tokenTracker.log('Show fluency level viewer command called');
		await tokenTracker.showFluencyLevelViewer();
	});

	// Register the generate diagnostic report command
	const generateDiagnosticReportCommand = vscode.commands.registerCommand('copilot-token-tracker.generateDiagnosticReport', async () => {
		tokenTracker.log('Generate diagnostic report command called');
		await tokenTracker.showDiagnosticReport();
	});

	// Register the clear cache command
	const clearCacheCommand = vscode.commands.registerCommand('copilot-token-tracker.clearCache', async () => {
		tokenTracker.log('Clear cache command called');
		await tokenTracker.clearCache();
	});

	// Add to subscriptions for proper cleanup
	context.subscriptions.push(refreshCommand, showDetailsCommand, showChartCommand, showUsageAnalysisCommand, showMaturityCommand, showFluencyLevelViewerCommand, showDashboardCommand, generateDiagnosticReportCommand, clearCacheCommand, tokenTracker);

	tokenTracker.log('Extension activation complete');
}

export function deactivate() {
	// Extension cleanup is handled in the CopilotTokenTracker class
}
