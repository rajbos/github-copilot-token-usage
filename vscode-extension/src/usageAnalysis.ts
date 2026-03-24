/**
 * Usage analysis functions for session data processing.
 * Analysis and aggregation functions extracted from CopilotTokenTracker.
 */
import * as fs from 'fs';
import type {
	SessionUsageAnalysis,
	ToolCallUsage,
	ModeUsage,
	ContextReferenceUsage,
	McpToolUsage,
	EditScopeUsage,
	ApplyButtonUsage,
	SessionDurationData,
	ConversationPatterns,
	AgentTypeUsage,
	ModelSwitchingAnalysis,
	ModelUsage,
	UsageAnalysisPeriod,
	ModelPricing,
} from './types';
import {
	applyDelta,
	isJsonlContent,
	isUuidPointerFile,
	getModelFromRequest,
	getModelTier,
	estimateTokensFromText,
	extractPerRequestUsageFromRawLines,
	createEmptyContextRefs,
} from './tokenEstimation';
import {
	getModeType,
	isMcpTool,
	normalizeMcpToolName,
	extractMcpServerName,
} from './workspaceHelpers';
import type { OpenCodeDataAccess } from './opencode';
import type { CrushDataAccess } from './crush';
import type { ContinueDataAccess } from './continue';
import type { VisualStudioDataAccess } from './visualstudio';

export interface UsageAnalysisDeps {
	warn: (msg: string) => void;
	openCode: OpenCodeDataAccess;
	crush?: CrushDataAccess;
	continue_: ContinueDataAccess;
	visualStudio?: VisualStudioDataAccess;
	tokenEstimators: { [key: string]: number };
	modelPricing: { [key: string]: ModelPricing };
	toolNameMap: { [key: string]: string };
}


/**
 * Merge usage analysis data into period stats
 */
export function mergeUsageAnalysis(period: UsageAnalysisPeriod, analysis: SessionUsageAnalysis): void {
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

/**
 * Analyze text for context references like #file, #selection, @workspace
 */
export function analyzeContextReferences(text: string, refs: ContextReferenceUsage): void {
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
export function analyzeContentReferences(contentReferences: any[], refs: ContextReferenceUsage): void {
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
export function analyzeVariableData(variableData: any, refs: ContextReferenceUsage): void {
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
 * Derive conversation patterns from already-computed mode usage.
 * Called before every return in analyzeSessionUsage to ensure all file formats get patterns.
 */
export function deriveConversationPatterns(analysis: SessionUsageAnalysis): void {
	const totalRequests = analysis.modeUsage.ask + analysis.modeUsage.edit + analysis.modeUsage.agent;
	analysis.conversationPatterns = {
		multiTurnSessions: totalRequests > 1 ? 1 : 0,
		singleTurnSessions: totalRequests === 1 ? 1 : 0,
		avgTurnsPerSession: totalRequests,
		maxTurnsInSession: totalRequests
	};
}

/**
 * Analyze a request object for all context references.
 * This is the unified method that processes text, contentReferences, and variableData.
 */
export function analyzeRequestContext(request: any, refs: ContextReferenceUsage): void {
	// Analyze user message text for context references
	if (request.message) {
		if (request.message.text) {
			analyzeContextReferences(request.message.text, refs);
		}
		if (request.message.parts) {
			for (const part of request.message.parts) {
				if (part.text) {
					analyzeContextReferences(part.text, refs);
				}
			}
		}
	}

	// Analyze contentReferences if present
	if (request.contentReferences && Array.isArray(request.contentReferences)) {
		analyzeContentReferences(request.contentReferences, refs);
	}

	// Analyze variableData if present
	if (request.variableData) {
		analyzeVariableData(request.variableData, refs);
	}
}

/**
 * Calculate model switching statistics for a session file.
 * This method updates the analysis.modelSwitching field in place.
 */
export async function calculateModelSwitching(deps: Pick<UsageAnalysisDeps, 'warn' | 'modelPricing' | 'openCode' | 'continue_' | 'tokenEstimators'>, sessionFile: string, analysis: SessionUsageAnalysis): Promise<void> {
	try {
		// Use non-cached method to avoid circular dependency
		// (getSessionFileDataCached -> analyzeSessionUsage -> getModelUsageFromSessionCached -> getSessionFileDataCached)
		const modelUsage = await getModelUsageFromSession(deps, sessionFile);
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
			const tier = getModelTier(model, deps.modelPricing);
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
		if (isUuidPointerFile(fileContent)) {
			return;
		}
		const isJsonl = sessionFile.endsWith('.jsonl') || isJsonlContent(fileContent);
		if (!isJsonl) {
			const sessionContent = JSON.parse(fileContent);
			if (sessionContent.requests && Array.isArray(sessionContent.requests)) {
				let previousModel: string | null = null;
				let switchCount = 0;
				const tierCounts = { standard: 0, premium: 0, unknown: 0 };

				for (const request of sessionContent.requests) {
					const currentModel = getModelFromRequest(request, deps.modelPricing);
					
					// Count model switches
					if (previousModel && currentModel !== previousModel) {
						switchCount++;
					}
					previousModel = currentModel;

					// Count requests per tier
					const tier = getModelTier(currentModel, deps.modelPricing);
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
						const tier = getModelTier(model, deps.modelPricing);
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
								requestModel = getModelFromRequest(request, deps.modelPricing);
							}

							const tier = getModelTier(requestModel, deps.modelPricing);
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
		deps.warn(`Error calculating model switching for ${sessionFile}: ${error}`);
	}
}

/**
 * Track enhanced metrics from session files:
 * - Edit scope (single vs multi-file edits)
 * - Apply button usage (codeblockUri with isEdit flag)
 * - Session duration data
 * - Conversation patterns (multi-turn sessions)
 * - Agent type usage
 */
export async function trackEnhancedMetrics(deps: Pick<UsageAnalysisDeps, 'warn'>, sessionFile: string, analysis: SessionUsageAnalysis): Promise<void> {
	try {
		const fileContent = await fs.promises.readFile(sessionFile, 'utf8');

		// Check if this is a UUID-only file (new Copilot CLI format)
		if (isUuidPointerFile(fileContent)) {
			return; // No metrics to track in pointer files
		}

		const isJsonl = sessionFile.endsWith('.jsonl') || isJsonlContent(fileContent);
		
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
		
		if (isJsonl) {
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
						sessionState = applyDelta(sessionState, delta);
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
		deriveConversationPatterns(analysis);
		
		// Store agent type usage
		analysis.agentTypes = agentCounts;
		
	} catch (error) {
		deps.warn(`Error tracking enhanced metrics from ${sessionFile}: ${error}`);
	}
}

/**
 * Analyze a session file for usage patterns (tool calls, modes, context references, MCP tools)
 */
export async function analyzeSessionUsage(deps: UsageAnalysisDeps, sessionFile: string): Promise<SessionUsageAnalysis> {
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
		if (deps.openCode.isOpenCodeSessionFile(sessionFile)) {
			const messages = await deps.openCode.getOpenCodeMessagesForSession(sessionFile);
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
						const parts = await deps.openCode.getOpenCodePartsForMessage(msg.id);
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

		// Handle Visual Studio sessions
		if (deps.visualStudio?.isVSSessionFile(sessionFile)) {
			const objects = deps.visualStudio.decodeSessionFile(sessionFile);
			const models: string[] = [];
			for (let i = 1; i < objects.length; i++) {
				const isRequest = i % 2 === 1;
				if (isRequest) {
					analysis.modeUsage.ask++;
				} else {
					const model = deps.visualStudio.getModelId(objects[i], false);
					if (model) { models.push(model); }
					// Count tool calls from response content
					for (const c of (objects[i]?.Content || [])) {
						const inner = Array.isArray(c) ? c[1] : null;
						if (inner?.Function) {
							analysis.toolCalls.total++;
							const toolName = String(inner.Function.Description || 'tool');
							analysis.toolCalls.byTool[toolName] = (analysis.toolCalls.byTool[toolName] || 0) + 1;
						}
					}
				}
			}
			const uniqueModels = [...new Set(models)];
			analysis.modelSwitching.uniqueModels = uniqueModels;
			analysis.modelSwitching.modelCount = uniqueModels.length;
			analysis.modelSwitching.totalRequests = models.length;
			let switchCount = 0;
			for (let i = 1; i < models.length; i++) {
				if (models[i] !== models[i - 1]) { switchCount++; }
			}
			analysis.modelSwitching.switchCount = switchCount;
			return analysis;
		}

		// Handle Visual Studio sessions
		if (deps.visualStudio?.isVSSessionFile(sessionFile)) {
			const objects = deps.visualStudio.decodeSessionFile(sessionFile);
			const models: string[] = [];
			for (let i = 1; i < objects.length; i++) {
				const isRequest = i % 2 === 1;
				if (isRequest) {
					analysis.modeUsage.ask++;
				} else {
					const model = deps.visualStudio.getModelId(objects[i], false);
					if (model) { models.push(model); }
					// Count tool calls from response content
					for (const c of (objects[i]?.Content || [])) {
						const inner = Array.isArray(c) ? c[1] : null;
						if (inner?.Function) {
							analysis.toolCalls.total++;
							const toolName = String(inner.Function.Description || 'tool');
							analysis.toolCalls.byTool[toolName] = (analysis.toolCalls.byTool[toolName] || 0) + 1;
						}
					}
				}
			}
			const uniqueModels = [...new Set(models)];
			analysis.modelSwitching.uniqueModels = uniqueModels;
			analysis.modelSwitching.modelCount = uniqueModels.length;
			analysis.modelSwitching.totalRequests = models.length;
			let switchCount = 0;
			for (let i = 1; i < models.length; i++) {
				if (models[i] !== models[i - 1]) { switchCount++; }
			}
			analysis.modelSwitching.switchCount = switchCount;
			return analysis;
		}

		// Handle Crush sessions
		if (deps.crush?.isCrushSessionFile(sessionFile)) {
			const messages = await deps.crush.getCrushMessages(sessionFile);
			const models: string[] = [];
			for (const msg of messages) {
				if (msg.role === 'user') {
					analysis.modeUsage.agent++;
				}
				if (msg.role === 'assistant') {
					const model = msg.model || 'unknown';
					models.push(model);
					const parts: any[] = Array.isArray(msg.parts) ? msg.parts : [];
					for (const part of parts) {
						if (part?.type === 'tool_call' && part?.data?.name) {
							analysis.toolCalls.total++;
							const toolName = part.data.name as string;
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
			return analysis;
		}

		// Handle Continue sessions
		if (deps.continue_.isContinueSessionFile(sessionFile)) {
			const turns = deps.continue_.buildContinueTurns(sessionFile);
			const meta = deps.continue_.getContinueSessionMeta(sessionFile);
			const models: string[] = [];
			for (const turn of turns) {
				analysis.modeUsage.ask++;
				if (turn.model) { models.push(turn.model); }
				for (const tc of turn.toolCalls) {
					analysis.toolCalls.total++;
					analysis.toolCalls.byTool[tc.toolName] = (analysis.toolCalls.byTool[tc.toolName] || 0) + 1;
				}
			}
			if (meta?.mode === 'agent') {
				// Recount interactions as agent mode
				for (let k = 0; k < turns.length; k++) {
					analysis.modeUsage.ask--;
					analysis.modeUsage.agent++;
				}
			}
			const uniqueModels = [...new Set(models)];
			analysis.modelSwitching.uniqueModels = uniqueModels;
			analysis.modelSwitching.modelCount = uniqueModels.length;
			analysis.modelSwitching.totalRequests = models.length;
			let switchCount = 0;
			for (let ki = 1; ki < models.length; ki++) {
				if (models[ki] !== models[ki - 1]) { switchCount++; }
			}
			analysis.modelSwitching.switchCount = switchCount;
			return analysis;
		}

		const fileContent = await fs.promises.readFile(sessionFile, 'utf8');

		// Handle .jsonl files OR .json files with JSONL content (Copilot CLI format and VS Code incremental format)
		const isJsonl = sessionFile.endsWith('.jsonl') || isJsonlContent(fileContent);
		if (isJsonl) {
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
						sessionState = applyDelta(sessionState, delta);
					} catch {
						// Skip invalid lines
					}
				}

				// Extract session mode from reconstructed state
				const sessionModeType = sessionState.inputState?.mode 
					? getModeType(sessionState.inputState.mode)
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
					analyzeRequestContext(request, analysis.contextReferences);

					// Extract tool calls and MCP tools from request.response array
					if (request.response && Array.isArray(request.response)) {
						for (const responseItem of request.response) {
							if (responseItem.kind === 'toolInvocationSerialized' || responseItem.kind === 'prepareToolInvocation') {
								const toolName = responseItem.toolId || responseItem.toolName || responseItem.invocationMessage?.toolName || responseItem.toolSpecificData?.kind || 'unknown';

								// Check if this is an MCP tool by name pattern
								if (isMcpTool(toolName)) {
									analysis.mcpTools.total++;
									const serverName = extractMcpServerName(toolName, deps.toolNameMap);
									analysis.mcpTools.byServer[serverName] = (analysis.mcpTools.byServer[serverName] || 0) + 1;
									const normalizedTool = normalizeMcpToolName(toolName);
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
				await calculateModelSwitching(deps, sessionFile, analysis);

				// Derive conversation patterns from mode usage before returning
				deriveConversationPatterns(analysis);

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
						sessionMode = getModeType(event.v.inputState.mode);

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
						sessionMode = getModeType(event.v);
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
						analyzeContentReferences(event.v, analysis.contextReferences);
					}

					// Handle variableData updates (kind: 1 with variableData update)
					if (event.kind === 1 && event.k?.includes('variableData') && event.v) {
						analyzeVariableData(event.v, analysis.contextReferences);
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
							analyzeRequestContext(request, analysis.contextReferences);

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
						if (isMcpTool(toolName)) {
							// Count as MCP tool
							analysis.mcpTools.total++;
							const serverName = extractMcpServerName(toolName, deps.toolNameMap);
							analysis.mcpTools.byServer[serverName] = (analysis.mcpTools.byServer[serverName] || 0) + 1;
							const normalizedTool = normalizeMcpToolName(toolName);
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
						const normalizedMcpTool = normalizeMcpToolName(mcpToolName);
						analysis.mcpTools.byTool[normalizedMcpTool] = (analysis.mcpTools.byTool[normalizedMcpTool] || 0) + 1;
					}
				} catch (e) {
					// Skip malformed lines
				}
			}
			// Calculate model switching for JSONL files before returning
			await calculateModelSwitching(deps, sessionFile, analysis);

			// Derive conversation patterns from mode usage before returning
			deriveConversationPatterns(analysis);

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
				analyzeRequestContext(request, analysis.contextReferences);

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
							if (isMcpTool(toolName)) {
								// Count as MCP tool
								analysis.mcpTools.total++;
								const serverName = extractMcpServerName(toolName, deps.toolNameMap);
								analysis.mcpTools.byServer[serverName] = (analysis.mcpTools.byServer[serverName] || 0) + 1;
								const normalizedTool = normalizeMcpToolName(toolName);
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
							analyzeContentReferences([responseItem], analysis.contextReferences);
						}
					}
				}
			}
		}
	} catch (error) {
		deps.warn(`Error analyzing session usage from ${sessionFile}: ${error}`);
	}

	// Calculate model switching statistics from session
	await calculateModelSwitching(deps, sessionFile, analysis);

	// Track new metrics: edit scope, apply usage, session duration, conversation patterns, agent types
	await trackEnhancedMetrics(deps, sessionFile, analysis);

	return analysis;
}

export async function getModelUsageFromSession(deps: Pick<UsageAnalysisDeps, 'warn' | 'openCode' | 'crush' | 'continue_' | 'visualStudio' | 'tokenEstimators' | 'modelPricing'>, sessionFile: string): Promise<ModelUsage> {
	const modelUsage: ModelUsage = {};

	// Handle OpenCode sessions
	if (deps.openCode.isOpenCodeSessionFile(sessionFile)) {
		return await deps.openCode.getOpenCodeModelUsage(sessionFile);
	}

	// Handle Visual Studio sessions
	if (deps.visualStudio?.isVSSessionFile(sessionFile)) {
		return deps.visualStudio.getModelUsage(sessionFile, (text, model) => estimateTokensFromText(text, model ?? undefined, deps.tokenEstimators));
	}

	// Handle Crush sessions
	if (deps.crush?.isCrushSessionFile(sessionFile)) {
		return await deps.crush.getCrushModelUsage(sessionFile);
	}

	// Handle Continue sessions
	if (deps.continue_.isContinueSessionFile(sessionFile)) {
		return deps.continue_.getContinueModelUsage(sessionFile);
	}

	const fileName = sessionFile.split(/[/\\]/).pop() || sessionFile;

	try {
		const fileContent = await fs.promises.readFile(sessionFile, 'utf8');

		// Check if this is a UUID-only file (new Copilot CLI format)
		if (isUuidPointerFile(fileContent)) {
			return modelUsage; // Empty model usage for pointer files
		}

		// Detect JSONL content: either by extension or by content analysis
		const isJsonl = sessionFile.endsWith('.jsonl') || isJsonlContent(fileContent);

		// Handle .jsonl files OR .json files with JSONL content (Copilot CLI format and VS Code incremental format)
		if (isJsonl) {
			const lines = fileContent.trim().split('\n');
			// Default model for CLI sessions - they may not specify the model per event
			let defaultModel = 'gpt-4o';

			// For delta-based formats, reconstruct state to extract actual usage
			let sessionState: any = {};
			let isDeltaBased = false;
			// For CLI (non-delta) sessions: capture exact per-model usage from session.shutdown
			let cliShutdownModelUsage: ModelUsage | null = null;

			for (const line of lines) {
				if (!line.trim()) { continue; }
				try {
					const event = JSON.parse(line);

					// Detect and reconstruct delta-based format
					if (typeof event.kind === 'number') {
						isDeltaBased = true;
						sessionState = applyDelta(sessionState, event);
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
						// Copilot CLI: session.shutdown has exact per-model token totals
						if (event.type === 'session.shutdown' && event.data?.modelMetrics) {
							cliShutdownModelUsage = {};
							for (const [modelName, metrics] of Object.entries(event.data.modelMetrics) as [string, any][]) {
								const usage = metrics?.usage;
								if (usage) {
									cliShutdownModelUsage[modelName] = {
										inputTokens: typeof usage.inputTokens === 'number' ? usage.inputTokens : 0,
										outputTokens: typeof usage.outputTokens === 'number' ? usage.outputTokens : 0,
									};
								}
							}
						} else if (event.type === 'user.message' && event.data?.content) {
							modelUsage[model].inputTokens += estimateTokensFromText(event.data.content, model, deps.tokenEstimators);
						} else if (event.type === 'assistant.message' && event.data?.content) {
							modelUsage[model].outputTokens += estimateTokensFromText(event.data.content, model, deps.tokenEstimators);
						} else if (event.type === 'tool.result' && event.data?.output) {
							// Tool outputs are typically input context
							modelUsage[model].inputTokens += estimateTokensFromText(event.data.output, model, deps.tokenEstimators);
						}
					}
				} catch (e) {
					// Skip malformed lines
				}
			}

			// If CLI session.shutdown provided exact per-model data, use it instead of estimates
			if (!isDeltaBased && cliShutdownModelUsage) {
				return cliShutdownModelUsage;
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
						requestModel = getModelFromRequest(request, deps.modelPricing);
					}

					if (!modelUsage[requestModel]) {
						modelUsage[requestModel] = { inputTokens: 0, outputTokens: 0 };
					}

					// Use actual usage if available, otherwise estimate from text
					if (request.result?.usage) {
						// OLD FORMAT (pre-Feb 2026)
						const u = request.result.usage;
						modelUsage[requestModel].inputTokens += typeof u.promptTokens === 'number' ? u.promptTokens : 0;
						modelUsage[requestModel].outputTokens += typeof u.completionTokens === 'number' ? u.completionTokens : 0;
					} else if (typeof request.result?.promptTokens === 'number' && typeof request.result?.outputTokens === 'number') {
						// NEW FORMAT (Feb 2026+)
						modelUsage[requestModel].inputTokens += request.result.promptTokens;
						modelUsage[requestModel].outputTokens += request.result.outputTokens;
					} else {
						// Fallback to text-based estimation
						if (request.message?.text) {
							modelUsage[requestModel].inputTokens += estimateTokensFromText(request.message.text, requestModel, deps.tokenEstimators);
						}
						if (request.response && Array.isArray(request.response)) {
							for (const responseItem of request.response) {
								if (responseItem.value) {
									modelUsage[requestModel].outputTokens += estimateTokensFromText(responseItem.value, requestModel, deps.tokenEstimators);
								}
							}
						}
					}
				}
			}

			// FALLBACK: If reconstruction missed result data, use regex extraction from raw lines
			const rawModelUsage = extractPerRequestUsageFromRawLines(lines);
			for (const [reqIdx, extracted] of rawModelUsage) {
				const request = sessionState.requests?.[reqIdx];
				if (!request) { continue; }
				// Only use regex fallback if reconstruction didn't already provide usage
				if (request.result?.usage || (typeof request.result?.promptTokens === 'number') || (request.result?.metadata && typeof request.result.metadata.promptTokens === 'number')) { continue; }
				let requestModel = defaultModel;
				if (request.modelId) { requestModel = request.modelId.replace(/^copilot\//, ''); }
				if (!modelUsage[requestModel]) { modelUsage[requestModel] = { inputTokens: 0, outputTokens: 0 }; }
				modelUsage[requestModel].inputTokens += extracted.promptTokens;
				modelUsage[requestModel].outputTokens += extracted.outputTokens;
			}

			return modelUsage;
		}

		// Handle regular .json files
		const sessionContent = JSON.parse(fileContent);

		if (sessionContent.requests && Array.isArray(sessionContent.requests)) {
			for (const request of sessionContent.requests) {
				// Get model for this request
				const model = getModelFromRequest(request, deps.modelPricing);

				// Initialize model if not exists
				if (!modelUsage[model]) {
					modelUsage[model] = { inputTokens: 0, outputTokens: 0 };
				}

				// Use actual usage if available, otherwise estimate from text
				if (request.result?.usage) {
					// OLD FORMAT (pre-Feb 2026)
					const u = request.result.usage;
					modelUsage[model].inputTokens += typeof u.promptTokens === 'number' ? u.promptTokens : 0;
					modelUsage[model].outputTokens += typeof u.completionTokens === 'number' ? u.completionTokens : 0;
				} else if (typeof request.result?.promptTokens === 'number' && typeof request.result?.outputTokens === 'number') {
					// NEW FORMAT (Feb 2026+)
					modelUsage[model].inputTokens += request.result.promptTokens;
					modelUsage[model].outputTokens += request.result.outputTokens;
				} else if (request.result?.metadata && typeof request.result.metadata.promptTokens === 'number' && typeof request.result.metadata.outputTokens === 'number') {
					// INSIDERS FORMAT (Feb 2026+): Tokens nested under result.metadata
					modelUsage[model].inputTokens += request.result.metadata.promptTokens;
					modelUsage[model].outputTokens += request.result.metadata.outputTokens;
				} else {
					// Fallback to text-based estimation
					// Estimate tokens from user message (input)
					if (request.message && request.message.parts) {
						for (const part of request.message.parts) {
							if (part.text) {
								const tokens = estimateTokensFromText(part.text, model, deps.tokenEstimators);
								modelUsage[model].inputTokens += tokens;
							}
						}
					}

					// Estimate tokens from assistant response (output)
					if (request.response && Array.isArray(request.response)) {
						for (const responseItem of request.response) {
							if (responseItem.value) {
								const tokens = estimateTokensFromText(responseItem.value, model, deps.tokenEstimators);
								modelUsage[model].outputTokens += tokens;
							}
						}
					}
				}
			}
		}
	} catch (error) {
		deps.warn(`Error getting model usage from ${sessionFile}: ${error}`);
	}

	return modelUsage;
}
