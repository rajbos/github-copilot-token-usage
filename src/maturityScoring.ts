/**
 * Maturity/fluency scoring functions.
 * Computes AI Fluency Score and related metrics.
 */
import type {
	DetailedStats,
	UsageAnalysisStats,
	WorkspaceCustomizationMatrix,
	UsageAnalysisPeriod,
	AgenticTrendPoint,
} from './types';
import automaticToolIds from './automaticTools.json';
import fluencyLevelDataRaw from './fluencyLevelData.json';
import { countDelegationToolCalls } from './taskClassification';

/** Set of tool IDs that Copilot uses autonomously (reading files, searching, etc.).
 *  These are excluded from fluency scoring since the user doesn't configure them. */
const AUTOMATIC_TOOL_SET = new Set<string>((automaticToolIds as string[]).map(id => id.toLowerCase()));

/** Format a number with thousand separators for display. */
function fmt(n: number): string {
	return n.toLocaleString('en-US');
}

/** Total CLI-style interactions: terminal CLI plus Copilot desktop app sessions (`cliApp`) and non-terminal Claude Code surfaces (`claudeDesktop`, `claudeVsCode`) — all still agentic, tool-calling sessions, just launched from a different surface than a plain terminal. */
function cliTotal(m: UsageAnalysisPeriod['modeUsage']): number {
	return (m.cli ?? 0) + (m.cliApp ?? 0) + (m.claudeDesktop ?? 0) + (m.claudeVsCode ?? 0);
}

/** Fluency stage levels (1 = AI Skeptic through 4 = AI Strategist). */
type Stage = 1 | 2 | 3 | 4;

type CategoryScore = { stage: Stage; evidence: string[]; tips: string[] };

/** Promotes a stage to at least `next`, returning the higher of the two. */
function promoteStage(current: Stage, next: Stage): Stage {
	return Math.max(current, next) as Stage;
}

/** Human-readable labels for each stage. */
export const STAGE_LABELS: Record<Stage, string> = {
	1: 'Stage 1: AI Skeptic',
	2: 'Stage 2: AI Explorer',
	3: 'Stage 3: AI Collaborator',
	4: 'Stage 4: AI Strategist',
};

/**
 * Centralised threshold configuration for all maturity/fluency stage promotions.
 * Change a value here to adjust the bar for that stage across every scoring function
 * (both the per-session `_score*` functions and `calculateFluencyScoreForTeamMember`).
 */
export const STAGE_THRESHOLDS = {
	promptEngineering: {
		/** Minimum total interactions (ask + edit + agent + cli) to reach Stage 2. */
		stage2MinInteractions: 5,
		/** Minimum avg turns per session to promote to at least Stage 2. */
		stage2MinAvgTurns: 3,
		/** Minimum avg turns per session to promote to at least Stage 3. */
		stage3MinAvgTurns: 5,
		/** Minimum total interactions (alongside slash commands or agent mode) to reach Stage 3. */
		stage3MinInteractions: 30,
		/** Minimum slash commands used (alongside stage3MinInteractions) to qualify for Stage 3. */
		stage3MinSlashCommands: 2,
		/** Minimum total interactions (alongside agent mode and model switching) to reach Stage 4. */
		stage4MinInteractions: 100,
		/** Minimum slash commands used as an alternative to model switching to qualify for Stage 4. */
		stage4MinSlashCommands: 3,
	},
	contextEngineering: {
		/** Minimum total context refs (file + selection + symbol + codebase + workspace) to reach Stage 2. */
		stage2MinTotalRefs: 1,
		/** Minimum distinct reference types used to reach Stage 3. */
		stage3MinRefTypes: 3,
		/** Minimum total context references to reach Stage 3. */
		stage3MinTotalRefs: 10,
		/** Minimum distinct reference types used to reach Stage 4. */
		stage4MinRefTypes: 5,
		/** Minimum total context references to reach Stage 4. */
		stage4MinTotalRefs: 30,
	},
	agentic: {
		/** Minimum avg files per edit session to promote to at least Stage 3. */
		stage3MinAvgFilesPerSession: 3,
		/** Minimum agent/CLI interactions (alongside non-auto tools) to reach Stage 3. */
		stage3MinAgentInteractions: 10,
		/** Minimum non-automatic tools used (alongside agent interactions) to reach Stage 3. */
		stage3MinNonAutoTools: 3,
		/** Minimum agent/CLI interactions (alongside non-auto tools) to reach Stage 4. */
		stage4MinAgentInteractions: 50,
		/** Minimum non-automatic tools used (alongside agent interactions) to reach Stage 4. */
		stage4MinNonAutoTools: 5,
		/** Minimum multi-file edit sessions (alongside avgFilesPerSession) to promote to Stage 4. */
		stage4MinMultiFileEdits: 20,
		/** Minimum sessions with 2+ child workspaces (multi-agent orchestration) to reach at least Stage 3. */
		stage3MinMultiAgentParents: 1,
		/** Minimum sessions with 2+ child workspaces (multi-agent orchestration) to reach at least Stage 4. */
		stage4MinMultiAgentParents: 3,
		/** Minimum number of child workspaces per session to count as multi-agent orchestration. */
		multiAgentMinChildren: 2,
		/** Minimum sessions classified as `Delegation` (sub-agent/Task-tool usage) to reach at least Stage 3. */
		stage3MinDelegationSessions: 2,
		/** Minimum sessions classified as `Delegation` to reach at least Stage 4. */
		stage4MinDelegationSessions: 5,
	},
	toolUsage: {
		/** Minimum number of distinct advanced built-in tools used to promote to Stage 3. */
		stage3MinAdvancedTools: 2,
		/** Minimum number of distinct MCP servers connected to reach Stage 4. */
		stage4MinMcpServers: 2,
	},
	customization: {
		/** Minimum fraction of repos with customization to reach Stage 3 (requires stage3MinCustomizedRepos). */
		stage3MinCustomizationRate: 0.3,
		/** Minimum number of repos with customization to reach Stage 3 (requires stage3MinCustomizationRate). */
		stage3MinCustomizedRepos: 2,
		/** Minimum fraction of repos with customization to reach Stage 4 (requires stage4MinCustomizedRepos). */
		stage4MinCustomizationRate: 0.7,
		/** Minimum number of repos with customization to reach Stage 4 (requires stage4MinCustomizationRate). */
		stage4MinCustomizedRepos: 3,
		/** Minimum number of distinct AI models used to promote to at least Stage 3. */
		stage3MinUniqueModels: 3,
		/** Minimum distinct models used (alongside stage4MinCustomizedRepos) to reach Stage 4. */
		stage4MinUniqueModels: 5,
	},
	workflowIntegration: {
		/** Minimum sessions in the scoring period to reach Stage 2. */
		stage2MinSessions: 3,
		/** Minimum code-block apply rate (percentage) to promote to at least Stage 2. */
		stage2MinApplyRatePct: 50,
		/** Minimum number of distinct usage modes to promote to at least Stage 3. */
		stage3MinModesUsed: 2,
		/** Minimum total context references to be counted as "explicit context" evidence. */
		hasExplicitContextMinRefs: 10,
		/** Minimum total context references to promote to at least Stage 3. */
		stage3MinContextRefs: 20,
		/** Minimum sessions (alongside modes and context) to reach Stage 4. */
		stage4MinSessions: 15,
	},
} as const;

/** Computes the median stage from an array of category stage scores. */
function computeMedianStage(stages: Stage[]): Stage {
	const sorted = [...stages].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	const median = sorted.length % 2 === 0
		? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
		: sorted[mid];
	return median as Stage;
}

/** VS Code Copilot slash commands (stored as tool calls by the session parser). */
const SLASH_COMMANDS = ['explain', 'fix', 'tests', 'doc', 'generate', 'optimize', 'new', 'newNotebook', 'search', 'fixTestFailure', 'setupTests'] as const;

/** Claude Code slash commands (stored with __slash__ prefix to avoid inflating tool counts). */
const CLAUDE_SLASH_COMMANDS = ['review', 'bug', 'think', 'compact', 'pr_comments'] as const;

/** Returns the slash commands actually used, based on tool call data. */
function getUsedSlashCommands(byTool: Record<string, number>): string[] {
	return [
		...SLASH_COMMANDS.filter(cmd => (byTool[cmd] ?? 0) > 0),
		...CLAUDE_SLASH_COMMANDS.filter(cmd => (byTool[`__slash__${cmd}`] ?? 0) > 0),
	];
}

/** Counts tools intentionally invoked by the user (excludes automatic agent tools and slash-command entries). */
function countNonAutoTools(byTool: Record<string, number>): number {
	return Object.keys(byTool).filter(t => !AUTOMATIC_TOOL_SET.has(t.toLowerCase()) && !t.startsWith('__slash__')).length;
}

function _peHasModelSwitching(mixedTierSessions: number, mixedCostSessions: number, switchingFrequency: number): boolean {
	return mixedTierSessions > 0 || mixedCostSessions > 0 || switchingFrequency > 0;
}
function _peHasAgentMode(agentCount: number, cliCount: number): boolean {
	return agentCount > 0 || cliCount > 0;
}
function _peQualifiesForStage3(totalInteractions: number, usedSlashCommands: string[], hasAgentMode: boolean): boolean {
	const T = STAGE_THRESHOLDS.promptEngineering;
	return totalInteractions >= T.stage3MinInteractions && (usedSlashCommands.length >= T.stage3MinSlashCommands || hasAgentMode);
}
function _peQualifiesForStage4(totalInteractions: number, hasAgentMode: boolean, hasModelSwitching: boolean, usedSlashCommands: string[]): boolean {
	const T = STAGE_THRESHOLDS.promptEngineering;
	return totalInteractions >= T.stage4MinInteractions && hasAgentMode && (hasModelSwitching || usedSlashCommands.length >= T.stage4MinSlashCommands);
}
function _buildPeTipsForStage3(hasAgentMode: boolean, usedSlashCommands: string[], T: { stage3MinSlashCommands: number }): string[] {
	const tips: string[] = [];
	if (!hasAgentMode) { tips.push('Try [agent mode](https://code.visualstudio.com/docs/copilot/agents/overview) for multi-file changes — [▶ Agent Mode video](https://tech.hub.ms/github-copilot/videos/agent-mode)'); }
	if (usedSlashCommands.length < T.stage3MinSlashCommands) { tips.push('Use [slash commands](https://code.visualstudio.com/docs/copilot/chat/copilot-chat#_add-context-to-your-prompts) like /explain, /fix, or /tests to give structured prompts'); }
	return tips;
}

function _buildPeTipsForStage4(hasAgentMode: boolean, hasModelSwitching: boolean, usedSlashCommands: string[], autoUsageRatio: number, T: { stage4MinSlashCommands: number }): string[] {
	const tips: string[] = [];
	if (!hasAgentMode) { tips.push('Try [agent mode](https://code.visualstudio.com/docs/copilot/agents/overview) for autonomous, multi-step coding tasks'); }
	if (!hasModelSwitching) { tips.push('Experiment with [different models](https://code.visualstudio.com/docs/copilot/chat/copilot-chat#_choose-a-language-model) for different tasks - use fast models for simple queries and reasoning models for complex problems — [▶ Model selection video](https://tech.hub.ms/github-copilot/videos/model-selection)'); }
	if (autoUsageRatio === 0) { tips.push('Try the Auto model for cost-sensitive tasks so Copilot can pick the most efficient model for you'); }
	else if (autoUsageRatio < 0.5) { tips.push('Use the Auto model more often when you want Copilot to balance quality and cost for you'); }
	if (usedSlashCommands.length < T.stage4MinSlashCommands && hasAgentMode && hasModelSwitching) { tips.push('Explore more [slash commands](https://code.visualstudio.com/docs/copilot/chat/copilot-chat#_add-context-to-your-prompts) like /explain, /tests, or /doc to diversify your prompting'); }
	return tips;
}

function _buildPeTips(stage: Stage, hasAgentMode: boolean, hasModelSwitching: boolean, usedSlashCommands: string[], autoUsageRatio: number): string[] {
	const T = STAGE_THRESHOLDS.promptEngineering;
	const tips: string[] = [];
	if (stage < 2) { tips.push('Try asking Copilot a question using the Chat panel — [▶ Chat in IDE video](https://tech.hub.ms/github-copilot/videos/chat-in-ide)'); }
	if (stage < 3) { tips.push(..._buildPeTipsForStage3(hasAgentMode, usedSlashCommands, T)); }
	if (stage < 4) { tips.push(..._buildPeTipsForStage4(hasAgentMode, hasModelSwitching, usedSlashCommands, autoUsageRatio, T)); }
	return tips;
}
function _applyPeConversationStage(p: UsageAnalysisPeriod, evidence: string[], stage: Stage): Stage {
	if (!p.conversationPatterns) { return stage; }
	const T = STAGE_THRESHOLDS.promptEngineering;
	const multiTurnRate = Math.round((p.conversationPatterns.multiTurnSessions / Math.max(1, p.sessions)) * 100);
	if (p.conversationPatterns.multiTurnSessions > 0) { evidence.push(`${fmt(p.conversationPatterns.multiTurnSessions)} multi-turn sessions (${multiTurnRate}%)`); }
	if (p.conversationPatterns.avgTurnsPerSession >= T.stage2MinAvgTurns) { evidence.push(`Avg ${p.conversationPatterns.avgTurnsPerSession.toFixed(1)} exchanges per session`); stage = promoteStage(stage, 2); }
	if (p.conversationPatterns.avgTurnsPerSession >= T.stage3MinAvgTurns) { stage = promoteStage(stage, 3); }
	return stage;
}

function _scorePromptEngineering(p: UsageAnalysisPeriod): CategoryScore {
	const { stage, evidence, usedSlashCommands, hasModelSwitching, hasAgentMode, autoUsageRatio } = _speComputeEvidence(p);
	return { stage, evidence, tips: _buildPeTips(stage, hasAgentMode, hasModelSwitching, usedSlashCommands, autoUsageRatio) };
}


/**
 * Add evidence for mode usage counts.
 */
function _speAddModeEvidence(evidence: string[], p: UsageAnalysisPeriod): void {
	const totalInteractions = p.modeUsage.ask + p.modeUsage.edit + p.modeUsage.agent + cliTotal(p.modeUsage);
	if (totalInteractions > 0) { evidence.push(`${fmt(totalInteractions)} total interactions`); }
	if (p.modeUsage.ask > 0) { evidence.push(`${fmt(p.modeUsage.ask)} ask-mode conversations`); }
	if (p.modeUsage.agent > 0) { evidence.push(`${fmt(p.modeUsage.agent)} agent-mode interactions`); }
	if (cliTotal(p.modeUsage) > 0) { evidence.push(`${fmt(cliTotal(p.modeUsage))} CLI interactions`); }
}

/**
 * Add evidence for auto model usage.
 */
function _speAddAutoModelEvidence(evidence: string[], p: UsageAnalysisPeriod, autoUsageRatio: number): void {
	if (p.modelSwitching.autoSessions > 0) {
		evidence.push(`Auto model used in ${fmt(p.modelSwitching.autoSessions)} session${p.modelSwitching.autoSessions === 1 ? '' : 's'} (${Math.round(autoUsageRatio * 100)}%)`);
	}
}

/**
 * Apply stage promotions based on auto usage ratio.
 */
function _speApplyAutoUsageStage(stage: Stage, autoUsageRatio: number, sessions: number): Stage {
	let result = stage;
	if (autoUsageRatio > 0) { result = promoteStage(result, 2); }
	if (autoUsageRatio >= 0.5) { result = promoteStage(result, 3); }
	if (autoUsageRatio >= 0.8 && sessions >= 5) { result = 4; }
	return result;
}

/**
 * Apply model switching stage boost.
 */
function _speApplyModelSwitchingBoost(stage: Stage, hasModelSwitching: boolean, p: UsageAnalysisPeriod, evidence: string[]): Stage {
	if (!hasModelSwitching) { return stage; }
	
	evidence.push(`Switched models in ${Math.round(p.modelSwitching.switchingFrequency)}% of sessions`);
	if (stage < 4 && (p.modelSwitching.mixedTierSessions > 0 || p.modelSwitching.mixedCostSessions > 0)) {
		return promoteStage(stage, 3);
	}
	return stage;
}

type SpeResult = { stage: Stage; evidence: string[]; usedSlashCommands: string[]; hasModelSwitching: boolean; hasAgentMode: boolean; autoUsageRatio: number };
function _speComputeEvidence(p: UsageAnalysisPeriod): SpeResult {
	const evidence: string[] = [];
	const T = STAGE_THRESHOLDS.promptEngineering;
	
	_speAddModeEvidence(evidence, p);
	
	const totalInteractions = p.modeUsage.ask + p.modeUsage.edit + p.modeUsage.agent + cliTotal(p.modeUsage);
	let stage: Stage = _applyPeConversationStage(p, evidence, 1);
	if (totalInteractions >= T.stage2MinInteractions) { stage = 2; }

	const usedSlashCommands = getUsedSlashCommands(p.toolCalls.byTool);
	if (usedSlashCommands.length > 0) { evidence.push(`Used slash commands: /${usedSlashCommands.join(', /')}`); }

	const hasModelSwitching = _peHasModelSwitching(p.modelSwitching.mixedTierSessions, p.modelSwitching.mixedCostSessions, p.modelSwitching.switchingFrequency);
	const hasAgentMode = _peHasAgentMode(p.modeUsage.agent, cliTotal(p.modeUsage));
	const autoUsageRatio = p.modelSwitching.totalSessions > 0 ? (p.modelSwitching.autoSessions / p.modelSwitching.totalSessions) : 0;
	
	_speAddAutoModelEvidence(evidence, p, autoUsageRatio);

	if (_peQualifiesForStage3(totalInteractions, usedSlashCommands, hasAgentMode)) { stage = 3; }
	if (_peQualifiesForStage4(totalInteractions, hasAgentMode, hasModelSwitching, usedSlashCommands)) { stage = 4; }
	
	stage = _speApplyAutoUsageStage(stage, autoUsageRatio, p.sessions);
	stage = _speApplyModelSwitchingBoost(stage, hasModelSwitching, p, evidence);
	
	return { stage, evidence, usedSlashCommands, hasModelSwitching, hasAgentMode, autoUsageRatio };
}

function _ceFormatGapTip(gapParts: string[], allTypesNotUsed: string[]): string | undefined {
	if (gapParts.length === 0) { return undefined; }
	const suggStr = allTypesNotUsed.length > 0 ? ` — try ${allTypesNotUsed.slice(0, 3).join(', ')}` : '';
	return `Stage 4 needs ${gapParts.join(' and ')}${suggStr}`;
}

function _ceFormatSpecializedTip(specializedItems: { name: string; used: boolean }[], link: string): string | undefined {
	const notUsed = specializedItems.filter(i => !i.used).map(i => i.name);
	if (notUsed.length === 0) { return undefined; }
	const extra = notUsed.length > 3 ? ` and ${notUsed.length - 3} more` : '';
	return `Try ${notUsed.slice(0, 3).join(', ')}${extra} — see ${link} to reach Stage 4`;
}

function _buildCeStage4Tip(refs: UsageAnalysisPeriod['contextReferences'], usedRefTypeCount: number, totalContextRefs: number): string | undefined {
	const T = STAGE_THRESHOLDS.contextEngineering;
	const typesStillNeeded = Math.max(0, T.stage4MinRefTypes - usedRefTypeCount);
	const refsStillNeeded = Math.max(0, T.stage4MinTotalRefs - totalContextRefs);
	const specializedItems = [
		{ name: 'image attachments', used: (refs.byKind?.['copilot.image'] ?? 0) > 0 },
		{ name: 'prompt files', used: (refs.byKind?.['promptFile'] ?? 0) > 0 },
		{ name: 'custom prompt commands', used: (refs.byKind?.['prompt'] ?? 0) > 0 },
		{ name: '#changes', used: refs.changes > 0 },
		{ name: '#problemsPanel', used: refs.problemsPanel > 0 },
		{ name: '#outputPanel', used: refs.outputPanel > 0 },
		{ name: '#terminalLastCommand', used: refs.terminalLastCommand > 0 },
		{ name: '#terminalSelection', used: refs.terminalSelection > 0 },
		{ name: '#clipboard', used: refs.clipboard > 0 },
		{ name: '@vscode', used: refs.vscode > 0 },
	];
	const specializedUsedCount = specializedItems.filter(i => i.used).length;
	if (specializedUsedCount >= 2) {
		const allTypesNotUsed = [
			{ name: '#symbol', used: refs.symbol > 0 },
			{ name: '@workspace', used: refs.workspace > 0 },
			{ name: '#codebase', used: refs.codebase > 0 },
			{ name: '@terminal', used: refs.terminal > 0 },
			...specializedItems,
		].filter(i => !i.used).map(i => i.name);
		const gapParts: string[] = [];
		if (typesStillNeeded > 0) { gapParts.push(`${fmt(usedRefTypeCount)} of ${T.stage4MinRefTypes} different reference types used`); }
		if (refsStillNeeded > 0) { gapParts.push(`${fmt(totalContextRefs)} of ${T.stage4MinTotalRefs} total references`); }
		return _ceFormatGapTip(gapParts, allTypesNotUsed);
	}
	return _ceFormatSpecializedTip(specializedItems, '[specialized context variables](https://code.visualstudio.com/docs/copilot/chat/copilot-chat#_add-context-to-your-prompts)');
}

function _pushCeEvidence(evidence: string[], count: number, label: string): void {
	if (count > 0) { evidence.push(`${fmt(count)} ${label}`); }
}

function _buildCeEvidence(refs: UsageAnalysisPeriod['contextReferences']): string[] {
	const evidence: string[] = [];
	const baseEvidence: Array<[number, string]> = [
		[refs.file, '#file references'],
		[refs.selection, '#selection references'],
		[refs.codebase, '#codebase references'],
		[refs.workspace, '@workspace references'],
		[refs.terminal, '@terminal references'],
		[refs.vscode, '@vscode references'],
		[refs.clipboard, '#clipboard references'],
		[refs.changes, '#changes references'],
		[refs.problemsPanel, '#problemsPanel references'],
		[refs.outputPanel, '#outputPanel references'],
		[refs.terminalLastCommand, '#terminalLastCommand references'],
		[refs.terminalSelection, '#terminalSelection references'],
		[refs.byKind?.['promptFile'] ?? 0, 'prompt file uses'],
		[refs.byKind?.['prompt'] ?? 0, 'custom prompt commands'],
		[refs.codeContextLines ?? 0, 'lines of code context'],
	];
	for (const [count, label] of baseEvidence) {
		_pushCeEvidence(evidence, count, label);
	}
	return evidence;
}

function _getCeUsedRefTypeCount(refs: UsageAnalysisPeriod['contextReferences']): number {
	return [
		refs.file, refs.selection, refs.symbol, refs.codebase, refs.workspace,
		refs.terminal, refs.vscode, refs.clipboard, refs.changes,
		refs.problemsPanel, refs.outputPanel, refs.terminalLastCommand, refs.terminalSelection,
		refs.byKind?.['copilot.image'] ?? 0, refs.byKind?.['promptFile'] ?? 0, refs.byKind?.['prompt'] ?? 0,
	].filter(Boolean).length;
}

function _applyCeBoosters(refs: UsageAnalysisPeriod['contextReferences'], evidence: string[], stage: Stage): Stage {
	const imageRefs = refs.byKind['copilot.image'] || 0;
	if (imageRefs > 0) {
		evidence.push(`${fmt(imageRefs)} image references (vision)`);
		stage = promoteStage(stage, 3);
	}
	if ((refs.byKind['promptFile'] || 0) > 0) {
		stage = promoteStage(stage, 3);
	}
	return stage;
}

function _scoreContextEngineering(p: UsageAnalysisPeriod): CategoryScore {
	let stage: Stage = 1;
	const T = STAGE_THRESHOLDS.contextEngineering;
	const refs = p.contextReferences;
	const totalContextRefs = refs.file + refs.selection + refs.symbol + refs.codebase + refs.workspace;
	const usedRefTypeCount = _getCeUsedRefTypeCount(refs);
	const evidence = _buildCeEvidence(refs);
	if (totalContextRefs >= T.stage2MinTotalRefs) { stage = 2; }
	if (usedRefTypeCount >= T.stage3MinRefTypes && totalContextRefs >= T.stage3MinTotalRefs) { stage = 3; }
	if (usedRefTypeCount >= T.stage4MinRefTypes && totalContextRefs >= T.stage4MinTotalRefs) { stage = 4; }
	stage = _applyCeBoosters(refs, evidence, stage);
	const tips: string[] = [];
	if (stage < 2) { tips.push('Try adding [#file or #selection](https://code.visualstudio.com/docs/copilot/chat/copilot-chat#_add-context-to-your-prompts) references to give Copilot more context'); }
	if (stage < 3) { tips.push('Explore [@workspace, #codebase, and @terminal](https://code.visualstudio.com/docs/copilot/chat/copilot-chat#_add-context-to-your-prompts) for broader context'); }
	if (stage < 4) {
		const tip = _buildCeStage4Tip(refs, usedRefTypeCount, totalContextRefs);
		if (tip) { tips.push(tip); }
	}
	return { stage, evidence, tips };
}

function _agQualifiesForStage3(agentInteractions: number, nonAutoToolCount: number, T: typeof STAGE_THRESHOLDS.agentic): boolean {
	return agentInteractions >= T.stage3MinAgentInteractions && nonAutoToolCount >= T.stage3MinNonAutoTools;
}

function _agQualifiesForStage4(agentInteractions: number, nonAutoToolCount: number, T: typeof STAGE_THRESHOLDS.agentic): boolean {
	return agentInteractions >= T.stage4MinAgentInteractions && nonAutoToolCount >= T.stage4MinNonAutoTools;
}

function _agQualifiesMultiFileStage4(editScope: UsageAnalysisPeriod['editScope'], T: typeof STAGE_THRESHOLDS.agentic): boolean {
	return !!editScope && editScope.multiFileEdits >= T.stage4MinMultiFileEdits && editScope.avgFilesPerSession >= T.stage3MinAvgFilesPerSession;
}

function _agApplyMultiAgentBooster(
	multiAgentParents: number,
	T: typeof STAGE_THRESHOLDS.agentic,
	stage: Stage,
	evidence: string[],
): Stage {
	if (multiAgentParents < T.stage3MinMultiAgentParents) { return stage; }
	const label = multiAgentParents === 1 ? '1 session' : `${fmt(multiAgentParents)} sessions`;
	evidence.push(`${label} with child workspaces (multi-agent orchestration)`);
	stage = promoteStage(stage, 3);
	if (multiAgentParents >= T.stage4MinMultiAgentParents) { stage = promoteStage(stage, 4); }
	return stage;
}

/**
 * Booster for sessions classified as `Delegation` (tool calls matching subagent/delegate
 * patterns — see `taskClassification.ts`). Complements `_agApplyMultiAgentBooster`: it works
 * for adapters without data.db/JSONL parent-child hierarchy data (e.g. Hermes, Claude Code),
 * since it only needs the tool names already captured in `toolCalls`/`taskCategory`.
 */
function _agApplyDelegationBooster(
	delegationSessions: number,
	T: typeof STAGE_THRESHOLDS.agentic,
	stage: Stage,
	evidence: string[],
): Stage {
	if (delegationSessions < T.stage3MinDelegationSessions) { return stage; }
	const label = delegationSessions === 1 ? '1 session' : `${fmt(delegationSessions)} sessions`;
	evidence.push(`${label} delegated work to sub-agents (Task/delegate tool calls)`);
	stage = promoteStage(stage, 3);
	if (delegationSessions >= T.stage4MinDelegationSessions) { stage = promoteStage(stage, 4); }
	return stage;
}

function _agBuildTips(stage: Stage): string[] {
	const tips: string[] = [];
	if (stage < 2) { tips.push('Try [agent mode](https://code.visualstudio.com/docs/copilot/agents/overview) — it can run terminal commands, edit files, and explore your codebase autonomously — [▶ Agent Mode video](https://tech.hub.ms/github-copilot/videos/agent-mode)'); }
	if (stage < 3) { tips.push('Use [agent mode](https://code.visualstudio.com/docs/copilot/agents/overview) for multi-step tasks; let it chain tools like file search, terminal, and code edits — [▶ Agent Mode video](https://tech.hub.ms/github-copilot/videos/agent-mode)'); }
	if (stage < 4) { tips.push('Try [multi-agent orchestration](https://code.visualstudio.com/docs/copilot/agents/overview): start child sessions from a parent session to run multiple agents in parallel on independent sub-tasks'); }
	return tips;
}

/**
 * Add evidence for basic agentic usage.
 */
function _agAddBasicEvidence(evidence: string[], p: UsageAnalysisPeriod, stage: Stage): Stage {
	let result = stage;
	if (p.modeUsage.agent > 0) { evidence.push(`${fmt(p.modeUsage.agent)} agent-mode interactions`); result = 2; }
	if (cliTotal(p.modeUsage) > 0) { evidence.push(`${fmt(cliTotal(p.modeUsage))} CLI interactions`); result = promoteStage(result, 2); }
	if (p.toolCalls.total > 0) { evidence.push(`${fmt(p.toolCalls.total)} tool calls executed`); }
	if (p.modeUsage.edit > 0) { evidence.push(`${fmt(p.modeUsage.edit)} edit-mode interactions`); }
	return result;
}

/**
 * Add evidence for edit scope and apply stage promotions.
 */
function _agAddEditScopeEvidence(evidence: string[], p: UsageAnalysisPeriod, stage: Stage, T: typeof STAGE_THRESHOLDS.agentic): Stage {
	if (!p.editScope) { return stage; }
	
	let result = stage;
	const totalEditSessions = p.editScope.singleFileEdits + p.editScope.multiFileEdits;
	const multiFileRate = totalEditSessions > 0 ? Math.round((p.editScope.multiFileEdits / totalEditSessions) * 100) : 0;
	
	if (p.editScope.multiFileEdits > 0) {
		evidence.push(`${fmt(p.editScope.multiFileEdits)} multi-file edit sessions (${multiFileRate}%)`);
		result = promoteStage(result, 2);
	}
	if (p.editScope.avgFilesPerSession >= T.stage3MinAvgFilesPerSession) {
		evidence.push(`Avg ${p.editScope.avgFilesPerSession.toFixed(1)} files per edit session`);
		result = promoteStage(result, 3);
	}
	
	return result;
}

/**
 * Apply agentic stage qualifications and boosters.
 */
function _agApplyStageQualifications(stage: Stage, p: UsageAnalysisPeriod, T: typeof STAGE_THRESHOLDS.agentic, evidence: string[]): Stage {
	let result = stage;
	
	if (p.agentTypes?.editsAgent) { evidence.push(`${fmt(p.agentTypes.editsAgent)} edits agent sessions`); result = promoteStage(result, 2); }

	const nonAutoToolCount = countNonAutoTools(p.toolCalls.byTool);
	const agentInteractions = p.modeUsage.agent + cliTotal(p.modeUsage);
	
	if (_agQualifiesForStage3(agentInteractions, nonAutoToolCount, T)) { result = 3; }
	if (_agQualifiesForStage4(agentInteractions, nonAutoToolCount, T)) { result = 4; }
	if (_agQualifiesMultiFileStage4(p.editScope, T)) { result = promoteStage(result, 4); }
	
	result = _agApplyMultiAgentBooster(p.multiAgentParentSessions ?? 0, T, result, evidence);
	result = _agApplyDelegationBooster(p.delegationSessions ?? 0, T, result, evidence);
	
	return result;
}

/**
 * Add evidence for sub-agent/delegate tool-call volume (adapter-agnostic, derived from
 * `toolCalls.byTool` — see `countDelegationToolCalls()`). This is a volume signal shown
 * alongside the `delegationSessions` stage booster; it doesn't affect the stage itself
 * since a single delegating session can rack up many tool calls.
 */
function _agAddDelegationToolCallEvidence(evidence: string[], p: UsageAnalysisPeriod): void {
	const delegationCalls = countDelegationToolCalls(p.toolCalls.byTool);
	if (delegationCalls === 0) { return; }
	const sessions = p.delegationSessions ?? 0;
	const avgSuffix = sessions > 0 ? ` (avg ${(delegationCalls / sessions).toFixed(1)} per delegating session)` : '';
	evidence.push(`${fmt(delegationCalls)} sub-agent/delegate tool calls executed${avgSuffix}`);
}

function _scoreAgentic(p: UsageAnalysisPeriod): CategoryScore {
	const evidence: string[] = [];
	let stage: Stage = 1;
	const T = STAGE_THRESHOLDS.agentic;

	stage = _agAddBasicEvidence(evidence, p, stage);
	stage = _agAddEditScopeEvidence(evidence, p, stage, T);
	stage = _agApplyStageQualifications(stage, p, T, evidence);
	_agAddDelegationToolCallEvidence(evidence, p);

	return { stage, evidence, tips: _agBuildTips(stage) };
}

function _tuBuildTips(stage: Stage, mcpServers: string[], isMCPDisabled?: boolean): string[] {
	const tips: string[] = [];
	if (stage < 2) { tips.push('Try [agent mode](https://code.visualstudio.com/docs/copilot/agents/overview) to let Copilot use built-in tools for file operations and terminal commands — [▶ Agent Mode video](https://tech.hub.ms/github-copilot/videos/agent-mode)'); }
	if (stage < 3) {
		if (mcpServers.length === 0 && !isMCPDisabled) { tips.push('Set up [MCP servers](https://code.visualstudio.com/docs/copilot/customization/mcp-servers) to connect Copilot to external tools (databases, APIs, cloud services) — [▶ MCP with Azure and GitHub](https://tech.hub.ms/github-copilot/videos/mcp-with-azure-and-github)'); }
		else if (mcpServers.length > 0) { tips.push('Explore [GitHub integrations](https://code.visualstudio.com/docs/copilot/agents/agent-tools) and advanced tools like editFiles and run_in_terminal'); }
	}
	if (stage < 4) {
		if (mcpServers.length === 1) { tips.push('Add more [MCP servers](https://code.visualstudio.com/docs/copilot/customization/mcp-servers) to expand Copilot\'s capabilities - check the VS Code MCP registry — [▶ MCP with Azure and GitHub](https://tech.hub.ms/github-copilot/videos/mcp-with-azure-and-github)'); }
		else if (mcpServers.length === 0 && !isMCPDisabled) { tips.push('Explore the [VS Code MCP registry](https://code.visualstudio.com/docs/copilot/customization/mcp-servers) for tools that integrate with your workflow'); }
		else if (mcpServers.length > 0) { tips.push('You\'re using multiple MCP servers - keep exploring advanced tool combinations'); }
	}
	return tips;
}

/**
 * Add evidence for basic tool usage.
 */
function _tuAddBasicToolEvidence(evidence: string[], p: UsageAnalysisPeriod, stage: Stage): Stage {
	const toolCount = Object.keys(p.toolCalls.byTool).length;
	const nonAutoToolCount = countNonAutoTools(p.toolCalls.byTool);
	
	let result = stage;
	if (nonAutoToolCount > 0) {
		const autoCount = toolCount - nonAutoToolCount;
		const autoNote = autoCount > 0 ? ` (+ ${fmt(autoCount)} automatic)` : '';
		evidence.push(`${fmt(nonAutoToolCount)} intentional tools used${autoNote}`);
		result = 2;
	} else if (toolCount > 0) {
		evidence.push(`${fmt(toolCount)} tools used (all automatic — agent reads/searches)`);
	}
	
	return result;
}

/**
 * Add evidence for workspace agent usage.
 */
function _tuAddWorkspaceAgentEvidence(evidence: string[], p: UsageAnalysisPeriod, stage: Stage): Stage {
	if (p.agentTypes?.workspaceAgent > 0) {
		evidence.push(`${fmt(p.agentTypes.workspaceAgent)} @workspace agent sessions`);
		return promoteStage(stage, 3);
	}
	return stage;
}

/**
 * Add evidence for advanced tool usage.
 */
function _tuAddAdvancedToolEvidence(evidence: string[], p: UsageAnalysisPeriod, stage: Stage, T: typeof STAGE_THRESHOLDS.toolUsage): Stage {
	const advancedToolFriendlyNames: Record<string, string> = {
		github_pull_request: 'GitHub Pull Request', github_repo: 'GitHub Repository',
		run_in_terminal: 'Run In Terminal', editFiles: 'Edit Files', listFiles: 'List Files'
	};
	const usedAdvanced = Object.keys(advancedToolFriendlyNames).filter(t => (p.toolCalls.byTool[t] || 0) > 0);
	
	let result = stage;
	if (usedAdvanced.length > 0) {
		evidence.push(`Advanced tools: ${usedAdvanced.map(t => advancedToolFriendlyNames[t]).join(', ')}`);
		if (usedAdvanced.length >= T.stage3MinAdvancedTools) {
			result = promoteStage(result, 3);
		}
	}
	
	return result;
}

/**
 * Add evidence for MCP tool usage.
 */
function _tuAddMcpEvidence(evidence: string[], p: UsageAnalysisPeriod, stage: Stage, T: typeof STAGE_THRESHOLDS.toolUsage): { stage: Stage; mcpServers: string[] } {
	const mcpServers = Object.keys(p.mcpTools.byServer);
	let result = stage;
	
	if (p.mcpTools.total > 0) {
		evidence.push(`${fmt(p.mcpTools.total)} MCP tool calls across ${mcpServers.length} server(s)`);
		result = promoteStage(result, 3);
		if (mcpServers.length >= T.stage4MinMcpServers) {
			result = 4;
		}
	}
	
	return { stage: result, mcpServers };
}

function _scoreToolUsage(p: UsageAnalysisPeriod, isMCPEnabled?: boolean): CategoryScore {
	const evidence: string[] = [];
	let stage: Stage = 1;
	const T = STAGE_THRESHOLDS.toolUsage;

	stage = _tuAddBasicToolEvidence(evidence, p, stage);
	stage = _tuAddWorkspaceAgentEvidence(evidence, p, stage);
	stage = _tuAddAdvancedToolEvidence(evidence, p, stage, T);

	const mcpDisabled = isMCPEnabled === false;
	if (!mcpDisabled) {
		const { stage: mcpStage, mcpServers: mcpServersResult } = _tuAddMcpEvidence(evidence, p, stage, T);
		stage = mcpStage;
		return { stage, evidence, tips: _tuBuildTips(stage, mcpServersResult) };
	}

	return { stage, evidence, tips: _tuBuildTips(stage, [], mcpDisabled) };
}

/**
 * The most-used resolved workspaces that have no customization at all, most active first. A row
 * with no status data is unknown, not missing (`every()` is true for an empty list), so it is
 * never recommended as a repository to customize.
 */
export function topReposMissingCustomization(matrix: WorkspaceCustomizationMatrix | undefined, limit = 3): WorkspaceCustomizationMatrix['workspaces'] {
	return (matrix?.workspaces || [])
		.filter(row => {
			const statuses = Object.values(row.typeStatuses ?? {});
			return statuses.length > 0 && statuses.every(status => status === '❌');
		})
		.filter(row => !row.workspacePath.startsWith('<unresolved:'))
		.sort((a, b) => b.interactionCount !== a.interactionCount ? b.interactionCount - a.interactionCount : b.sessionCount - a.sessionCount)
		.slice(0, limit);
}

function _buildCustomizationStage4Tip(matrix: WorkspaceCustomizationMatrix | undefined, totalRepos: number, reposWithCustomization: number): string {
	const uncustomized = totalRepos - reposWithCustomization;
	if (uncustomized === 0) {
		return 'All repos customized! Keep instructions up to date and add [skill files](https://code.visualstudio.com/docs/copilot/customization/agent-skills) or [MCP server configs](https://code.visualstudio.com/docs/copilot/customization/mcp-servers) for deeper integration';
	}
	const summaryTip = `${fmt(uncustomized)} repo${uncustomized === 1 ? '' : 's'} still missing customization — add [instructions](https://code.visualstudio.com/docs/copilot/customization/custom-instructions), [agents.md](https://code.visualstudio.com/docs/copilot/customization/custom-instructions), or [MCP configs](https://code.visualstudio.com/docs/copilot/customization/mcp-servers) for full coverage.`;
	const prioritizedMissingRepos = topReposMissingCustomization(matrix);
	if (prioritizedMissingRepos.length === 0) { return summaryTip; }
	const repoLines = prioritizedMissingRepos.map(row =>
		`${row.workspaceName} (${fmt(row.interactionCount)} interaction${row.interactionCount === 1 ? '' : 's'})`
	).join('\n');
	return `${summaryTip}\n\nTop repos to customize first:\n${repoLines}`;
}

function _cuComputeStage(
	customizationRate: number, reposWithCustomization: number,
	uniqueModelCount: number, T: typeof STAGE_THRESHOLDS.customization
): Stage {
	let stage: Stage = 1;
	if (reposWithCustomization > 0) { stage = 2; }
	if (customizationRate >= T.stage3MinCustomizationRate && reposWithCustomization >= T.stage3MinCustomizedRepos) { stage = 3; }
	if (customizationRate >= T.stage4MinCustomizationRate && reposWithCustomization >= T.stage4MinCustomizedRepos) { stage = 4; }
	if (uniqueModelCount >= T.stage3MinUniqueModels) { stage = promoteStage(stage, 3); }
	if (uniqueModelCount >= T.stage4MinUniqueModels && reposWithCustomization >= T.stage4MinCustomizedRepos) { stage = 4; }
	return stage;
}

function _cuBuildTips(stage: Stage, totalRepos: number, reposWithCustomization: number): string[] {
	const tips: string[] = [];
	const uncustomized = totalRepos - reposWithCustomization;
	if (stage < 2) { tips.push('Create a [.github/copilot-instructions.md](https://code.visualstudio.com/docs/copilot/customization/custom-instructions) or [CLAUDE.md](https://docs.anthropic.com/en/docs/claude-code/memory) file with project-specific guidelines — [▶ User Instructions video](https://tech.hub.ms/github-copilot/videos/user-instructions)'); }
	if (stage < 3) { tips.push('Add [custom instructions](https://code.visualstudio.com/docs/copilot/customization/custom-instructions) to more repositories to standardize your Copilot experience — [▶ User Instructions video](https://tech.hub.ms/github-copilot/videos/user-instructions)'); }
	if (stage < 4 && uncustomized > 0) { tips.push(`${fmt(reposWithCustomization)} of ${fmt(totalRepos)} repos have customization — add [instructions and agents.md](https://code.visualstudio.com/docs/copilot/customization/custom-instructions) to the remaining ${fmt(uncustomized)} repo${uncustomized === 1 ? '' : 's'} for Stage 4`); }
	else if (stage < 4) { tips.push('Aim for consistent customization across all projects with [instructions and agents.md](https://code.visualstudio.com/docs/copilot/customization/custom-instructions)'); }
	return tips;
}

/**
 * Extract unique models from model switching data.
 */
function _cuExtractUniqueModels(p: UsageAnalysisPeriod): string[] {
	return [...new Set([
		...p.modelSwitching.standardModels,
		...p.modelSwitching.premiumModels,
		...p.modelSwitching.lowCostModels,
		...p.modelSwitching.mediumCostModels,
		...p.modelSwitching.highCostModels
	])];
}

/**
 * Add evidence for repository and model usage.
 */
function _cuAddBasicEvidence(evidence: string[], totalRepos: number, uniqueModels: string[], T: typeof STAGE_THRESHOLDS.customization): void {
	if (totalRepos > 0) { evidence.push(`Worked in ${totalRepos} repositor${totalRepos === 1 ? 'y' : 'ies'}`); }
	if (uniqueModels.length >= T.stage3MinUniqueModels) { evidence.push(`Used ${uniqueModels.length} different models`); }
}

/**
 * Apply stage boosts for special model usage.
 */
function _cuApplyModelUsageBoosts(stage: Stage, p: UsageAnalysisPeriod, evidence: string[]): Stage {
	let result = stage;
	
	if (p.modelSwitching.foundryWindowsSessions > 0) {
		result = promoteStage(result, 2);
		evidence.push(`Used Microsoft Foundry / local models in ${fmt(p.modelSwitching.foundryWindowsSessions)} session${p.modelSwitching.foundryWindowsSessions === 1 ? '' : 's'}`);
	}
	if (p.modelSwitching.unknownProviderSessions > 0) {
		result = promoteStage(result, 2);
		evidence.push(`Used models from unknown providers in ${fmt(p.modelSwitching.unknownProviderSessions)} session${p.modelSwitching.unknownProviderSessions === 1 ? '' : 's'}`);
	}
	
	return result;
}

/**
 * Add evidence for customization level.
 */
function _cuAddCustomizationEvidence(evidence: string[], stage: Stage, reposWithCustomization: number, totalRepos: number, T: typeof STAGE_THRESHOLDS.customization): void {
	if (stage >= 4) {
		evidence.push(`${fmt(reposWithCustomization)} of ${fmt(totalRepos)} repos customized (${T.stage4MinCustomizationRate * 100}%+ with ${T.stage4MinCustomizedRepos}+ repos → Stage 4)`);
	} else if (stage >= 3) {
		evidence.push(`${fmt(reposWithCustomization)} of ${fmt(totalRepos)} repos customized (${T.stage3MinCustomizationRate * 100}%+ with ${T.stage3MinCustomizedRepos}+ repos → Stage 3)`);
	} else if (reposWithCustomization > 0) {
		evidence.push(`${fmt(reposWithCustomization)} of ${fmt(totalRepos)} repos with custom instructions or agents.md`);
	}
}

/**
 * Build final tips with additional suggestions.
 */
function _cuBuildFinalTips(tips: string[], stage: Stage, p: UsageAnalysisPeriod, uniqueModels: string[], matrix: WorkspaceCustomizationMatrix | undefined, totalRepos: number, reposWithCustomization: number): string[] {
	const result = [...tips];
	
	if (p.modelSwitching.foundryWindowsSessions === 0) {
		result.unshift('Try the Microsoft Foundry on Windows extension if you want to experiment with local models and offline-friendly workflows');
	}
	if (p.modelSwitching.unknownProviderSessions === 0 && uniqueModels.length <= 1) {
		result.unshift('Try different model providers from the marketplace when you want more specialized or cost-effective options');
	}
	if (stage >= 4) {
		result.push(_buildCustomizationStage4Tip(matrix, totalRepos, reposWithCustomization));
	}
	
	return result;
}

function _scoreCustomization(p: UsageAnalysisPeriod, lastCustomizationMatrix: WorkspaceCustomizationMatrix | undefined): CategoryScore {
	const evidence: string[] = [];
	const T = STAGE_THRESHOLDS.customization;

	const matrix = lastCustomizationMatrix;
	const totalRepos = matrix?.totalWorkspaces ?? 0;
	const reposWithCustomization = totalRepos - (matrix?.workspacesWithIssues ?? 0);
	const customizationRate = totalRepos > 0 ? (reposWithCustomization / totalRepos) : 0;
	const uniqueModels = _cuExtractUniqueModels(p);
	
	let stage = _cuComputeStage(customizationRate, reposWithCustomization, uniqueModels.length, T);

	_cuAddBasicEvidence(evidence, totalRepos, uniqueModels, T);
	stage = _cuApplyModelUsageBoosts(stage, p, evidence);
	_cuAddCustomizationEvidence(evidence, stage, reposWithCustomization, totalRepos, T);

	let tips = _cuBuildTips(stage, totalRepos, reposWithCustomization);
	tips = _cuBuildFinalTips(tips, stage, p, uniqueModels, matrix, totalRepos, reposWithCustomization);

	return { stage, evidence, tips };
}

function _wiQualifiesForStage4(sessions: number, modesUsed: number, totalContextRefs: number, T: typeof STAGE_THRESHOLDS.workflowIntegration): boolean {
	return sessions >= T.stage4MinSessions && modesUsed >= T.stage3MinModesUsed && totalContextRefs >= T.stage3MinContextRefs;
}

function _wiBuildTips(stage: Stage, modesUsed: number, totalContextRefs: number, T: typeof STAGE_THRESHOLDS.workflowIntegration): string[] {
	const tips: string[] = [];
	if (stage < 2) { tips.push('Use AI more regularly - even for quick questions — [▶ Chat in IDE video](https://tech.hub.ms/github-copilot/videos/chat-in-ide)'); }
	if (stage < 3) {
		if (modesUsed < T.stage3MinModesUsed) { tips.push('Combine [ask mode with agent mode](https://code.visualstudio.com/docs/copilot/agents/overview) in your daily workflow — [▶ Agent Mode video](https://tech.hub.ms/github-copilot/videos/agent-mode)'); }
		if (totalContextRefs < T.hasExplicitContextMinRefs) { tips.push('Use explicit [context references](https://code.visualstudio.com/docs/copilot/chat/copilot-chat#_add-context-to-your-prompts) like #file, @workspace, and #selection'); }
	}
	if (stage < 4) {
		if (totalContextRefs < T.stage3MinContextRefs) { tips.push('Make explicit context a habit - use [#file, @workspace, and other references](https://code.visualstudio.com/docs/copilot/chat/copilot-chat#_add-context-to-your-prompts) consistently'); }
		tips.push('Make AI part of every coding task: planning, coding, testing, and reviewing');
	}
	return tips;
}

/**
 * Calculate total context references from all sources.
 */
function _wiCalculateTotalContextRefs(p: UsageAnalysisPeriod): number {
	return p.contextReferences.file + p.contextReferences.selection +
		p.contextReferences.symbol + p.contextReferences.codebase + p.contextReferences.workspace;
}

/**
 * Calculate number of modes used.
 */
function _wiCalculateModesUsed(p: UsageAnalysisPeriod): number {
	return [p.modeUsage.ask > 0, p.modeUsage.agent > 0, cliTotal(p.modeUsage) > 0].filter(Boolean).length;
}

/**
 * Add evidence for session count.
 */
function _wiAddSessionEvidence(evidence: string[], p: UsageAnalysisPeriod, stage: Stage, T: typeof STAGE_THRESHOLDS.workflowIntegration): Stage {
	if (p.sessions >= T.stage2MinSessions) {
		evidence.push(`${fmt(p.sessions)} sessions in the last 30 days`);
		return 2;
	}
	return stage;
}

/**
 * Add evidence for apply usage.
 */
function _wiAddApplyUsageEvidence(evidence: string[], p: UsageAnalysisPeriod, stage: Stage, T: typeof STAGE_THRESHOLDS.workflowIntegration): Stage {
	if (!p.applyUsage || p.applyUsage.totalCodeBlocks <= 0) { return stage; }
	
	const applyRatePercent = Math.round(p.applyUsage.applyRate);
	evidence.push(`${applyRatePercent}% code block apply rate (${fmt(p.applyUsage.totalApplies)}/${fmt(p.applyUsage.totalCodeBlocks)})`);
	
	if (applyRatePercent >= T.stage2MinApplyRatePct) {
		return promoteStage(stage, 2);
	}
	
	return stage;
}

/**
 * Add evidence for session duration.
 */
function _wiAddSessionDurationEvidence(evidence: string[], p: UsageAnalysisPeriod): void {
	if (p.sessionDuration && p.sessionDuration.avgDurationMs > 0) {
		evidence.push(`Avg ${Math.round(p.sessionDuration.avgDurationMs / 60000)}min session duration`);
	}
	if (p.sessionDuration && p.sessionDuration.activeDurationMs > 0 && p.sessions > 0) {
		const avgActiveMin = Math.round(p.sessionDuration.activeDurationMs / p.sessions / 60000);
		evidence.push(`Avg ${avgActiveMin}min active time (interacting + waiting on the agent)`);
	}
}

/**
 * Add evidence for modes and context references.
 */
function _wiAddModesAndContextEvidence(evidence: string[], stage: Stage, modesUsed: number, totalContextRefs: number, T: typeof STAGE_THRESHOLDS.workflowIntegration): Stage {
	let result = stage;
	
	if (modesUsed >= T.stage3MinModesUsed) {
		evidence.push(`Uses ${modesUsed} modes (ask/agent/cli)`);
		result = promoteStage(result, 3);
	}

	if (totalContextRefs >= T.hasExplicitContextMinRefs) {
		evidence.push(`${fmt(totalContextRefs)} explicit context references`);
		if (totalContextRefs >= T.stage3MinContextRefs) {
			result = promoteStage(result, 3);
		}
	}
	
	return result;
}

/**
 * Apply stage 4 qualification.
 */
function _wiApplyStage4Qualification(stage: Stage, p: UsageAnalysisPeriod, modesUsed: number, totalContextRefs: number, T: typeof STAGE_THRESHOLDS.workflowIntegration, evidence: string[]): Stage {
	const qualifiesForStage4 = _wiQualifiesForStage4(p.sessions, modesUsed, totalContextRefs, T);
	if (qualifiesForStage4) {
		evidence.push('Deep integration: regular usage with multi-mode and explicit context');
		return 4;
	}
	return stage;
}

function _scoreWorkflowIntegration(p: UsageAnalysisPeriod): CategoryScore {
	const evidence: string[] = [];
	let stage: Stage = 1;
	const T = STAGE_THRESHOLDS.workflowIntegration;

	stage = _wiAddSessionEvidence(evidence, p, stage, T);
	stage = _wiAddApplyUsageEvidence(evidence, p, stage, T);
	_wiAddSessionDurationEvidence(evidence, p);

	const totalContextRefs = _wiCalculateTotalContextRefs(p);
	const modesUsed = _wiCalculateModesUsed(p);
	
	stage = _wiAddModesAndContextEvidence(evidence, stage, modesUsed, totalContextRefs, T);
	stage = _wiApplyStage4Qualification(stage, p, modesUsed, totalContextRefs, T, evidence);

	return { stage, evidence, tips: _wiBuildTips(stage, modesUsed, totalContextRefs, T) };
}


export function getFluencyLevelData(isDebugMode: boolean): {
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
      categories: fluencyLevelDataRaw as Array<{
        category: string;
        icon: string;
        levels: Array<{
          stage: number;
          label: string;
          description: string;
          thresholds: string[];
          tips: string[];
        }>;
      }>,
    };
  }

  /**
   * Calculates a fluency stage (1-4) for a team member based on aggregated Azure Table Storage metrics.
   * Applies the same 6-category scoring thresholds as calculateMaturityScores().
   */

/** Input data shape for calculateFluencyScoreForTeamMember. */
type FluencyInputData = {
	askModeCount: number; editModeCount: number; agentModeCount: number;
	planModeCount: number; customAgentModeCount: number; cliModeCount: number;
	toolCallsTotal: number; toolCallsByTool: Record<string, number>;
	ctxFile: number; ctxSelection: number; ctxSymbol: number;
	ctxCodebase: number; ctxWorkspace: number; ctxTerminal: number;
	ctxVscode: number; ctxClipboard: number; ctxChanges: number;
	ctxProblemsPanel: number; ctxOutputPanel: number;
	ctxTerminalLastCommand: number; ctxTerminalSelection: number;
	ctxByKind: Record<string, number>;
	mcpTotal: number; mcpByServer: Record<string, number>;
	mixedTierSessions: number; mixedCostSessions: number; switchingFreqSum: number; switchingFreqCount: number;
	standardModels: Set<string>; premiumModels: Set<string>;
	lowCostModels: Set<string>; mediumCostModels: Set<string>; highCostModels: Set<string>;
	multiFileEdits: number; filesPerEditSum: number; filesPerEditCount: number;
	editsAgentCount: number; workspaceAgentCount: number;
	repositories: Set<string>; repositoriesWithCustomization: Set<string>;
	autoSessions: number; foundryWindowsSessions: number; unknownProviderSessions: number;
	selectedModelExtensions: Set<string>; unknownProviderModels: Set<string>;
	applyRateSum: number; applyRateCount: number;
	multiTurnSessions: number; turnsPerSessionSum: number; turnsPerSessionCount: number;
	sessionCount: number; durationMsSum: number; durationMsCount: number;
};

/** Pre-computed common values shared across all 6 fluency category helpers. */
type FluencyVars = {
	totalInteractions: number; avgTurnsPerSession: number;
	hasModelSwitching: boolean; hasAgentMode: boolean;
	nonAutoToolCount: number; avgFilesPerSession: number;
	avgApplyRate: number; totalContextRefs: number;
	usedRefTypeCount: number; usedSlashCommands: string[];
};

type FluencyStageResult = { stage: Stage; tips: string[] };

function _calcFluencyPE(fd: FluencyInputData, cv: FluencyVars): FluencyStageResult {
	const T = STAGE_THRESHOLDS.promptEngineering;
	let stage: Stage = 1;
	const autoUsageRatio = fd.sessionCount > 0 ? fd.autoSessions / fd.sessionCount : 0;
	if (cv.avgTurnsPerSession >= T.stage2MinAvgTurns) { stage = promoteStage(stage, 2); }
	if (cv.avgTurnsPerSession >= T.stage3MinAvgTurns) { stage = promoteStage(stage, 3); }
	if (cv.totalInteractions >= T.stage2MinInteractions) { stage = promoteStage(stage, 2); }
	if (_peQualifiesForStage3(cv.totalInteractions, cv.usedSlashCommands, cv.hasAgentMode)) { stage = promoteStage(stage, 3); }
	if (_peQualifiesForStage4(cv.totalInteractions, cv.hasAgentMode, cv.hasModelSwitching, cv.usedSlashCommands)) { stage = 4; }
	if (autoUsageRatio > 0) { stage = promoteStage(stage, 2); }
	if (autoUsageRatio >= 0.5) { stage = promoteStage(stage, 3); }
	if (autoUsageRatio >= 0.8 && fd.sessionCount >= 5) { stage = 4; }
	if (cv.hasModelSwitching && (fd.mixedTierSessions > 0 || fd.mixedCostSessions > 0)) { stage = promoteStage(stage, 3); }
	return { stage, tips: _buildPeTips(stage, cv.hasAgentMode, cv.hasModelSwitching, cv.usedSlashCommands, autoUsageRatio) };
}

function _buildCeGapTip(fd: FluencyInputData, cv: FluencyVars, T: typeof STAGE_THRESHOLDS.contextEngineering): string | undefined {
	const typesStillNeeded = Math.max(0, T.stage4MinRefTypes - cv.usedRefTypeCount);
	const refsStillNeeded = Math.max(0, T.stage4MinTotalRefs - cv.totalContextRefs);
	const specializedItems = [
		{ name: 'image attachments', used: (fd.ctxByKind["copilot.image"] ?? 0) > 0 },
		{ name: 'prompt files', used: (fd.ctxByKind["promptFile"] ?? 0) > 0 },
		{ name: 'custom prompt commands', used: (fd.ctxByKind["prompt"] ?? 0) > 0 },
		{ name: '#changes', used: fd.ctxChanges > 0 },
		{ name: '#problemsPanel', used: fd.ctxProblemsPanel > 0 },
		{ name: '#outputPanel', used: fd.ctxOutputPanel > 0 },
		{ name: '#terminalLastCommand', used: fd.ctxTerminalLastCommand > 0 },
		{ name: '#terminalSelection', used: fd.ctxTerminalSelection > 0 },
		{ name: '#clipboard', used: fd.ctxClipboard > 0 },
		{ name: '@vscode', used: fd.ctxVscode > 0 },
	];
	const specializedUsedCount = specializedItems.filter(i => i.used).length;
	if (specializedUsedCount >= 2) {
		const allTypesNotUsed = [
			{ name: '#symbol', used: fd.ctxSymbol > 0 }, { name: '@workspace', used: fd.ctxWorkspace > 0 },
			{ name: '#codebase', used: fd.ctxCodebase > 0 }, { name: '@terminal', used: fd.ctxTerminal > 0 },
			...specializedItems,
		].filter(i => !i.used).map(i => i.name);
		const gapParts: string[] = [];
		if (typesStillNeeded > 0) { gapParts.push(`${fmt(cv.usedRefTypeCount)} of ${T.stage4MinRefTypes} different reference types used`); }
		if (refsStillNeeded > 0) { gapParts.push(`${fmt(cv.totalContextRefs)} of ${T.stage4MinTotalRefs} total references`); }
		return _ceFormatGapTip(gapParts, allTypesNotUsed);
	}
	return _ceFormatSpecializedTip(specializedItems, 'specialized context variables');
}

function _buildCeTips(fd: FluencyInputData, cv: FluencyVars, stage: Stage): string[] {
	const T = STAGE_THRESHOLDS.contextEngineering;
	const tips: string[] = [];
	if (stage < 2) { tips.push("Add #file or #selection references to give Copilot more context"); }
	if (stage < 3) { tips.push("Explore @workspace, #codebase, and @terminal for broader context"); }
	if (stage < 4) {
		const tip = _buildCeGapTip(fd, cv, T);
		if (tip) { tips.push(tip); }
	}
	return tips;
}

function _calcFluencyCE(fd: FluencyInputData, cv: FluencyVars): FluencyStageResult {
	const T = STAGE_THRESHOLDS.contextEngineering;
	let stage: Stage = 1;
	if (cv.totalContextRefs >= T.stage2MinTotalRefs) { stage = 2; }
	if (cv.usedRefTypeCount >= T.stage3MinRefTypes && cv.totalContextRefs >= T.stage3MinTotalRefs) { stage = 3; }
	if (cv.usedRefTypeCount >= T.stage4MinRefTypes && cv.totalContextRefs >= T.stage4MinTotalRefs) { stage = 4; }
	if ((fd.ctxByKind["copilot.image"] ?? 0) > 0 || (fd.ctxByKind["promptFile"] ?? 0) > 0) { stage = promoteStage(stage, 3); }
	return { stage, tips: _buildCeTips(fd, cv, stage) };
}

function _calcFluencyAg(fd: FluencyInputData, cv: FluencyVars): FluencyStageResult {
	const T = STAGE_THRESHOLDS.agentic;
	let stage: Stage = 1;
	if (cv.hasAgentMode) { stage = 2; }
	if (fd.multiFileEdits > 0) { stage = promoteStage(stage, 2); }
	if (cv.avgFilesPerSession >= T.stage3MinAvgFilesPerSession) { stage = promoteStage(stage, 3); }
	if (fd.editsAgentCount > 0) { stage = promoteStage(stage, 2); }
	if (fd.agentModeCount >= T.stage3MinAgentInteractions && cv.nonAutoToolCount >= T.stage3MinNonAutoTools) { stage = promoteStage(stage, 3); }
	if (fd.agentModeCount >= T.stage4MinAgentInteractions && cv.nonAutoToolCount >= T.stage4MinNonAutoTools) { stage = 4; }
	if (fd.multiFileEdits >= T.stage4MinMultiFileEdits && cv.avgFilesPerSession >= T.stage3MinAvgFilesPerSession) { stage = promoteStage(stage, 4); }
	const tips: string[] = [];
	if (stage < 2) { tips.push("Try agent mode — it can run terminal commands, edit files, and explore codebases autonomously"); }
	if (stage < 3) { tips.push("Use agent mode for multi-step tasks; let it chain tools like file search, terminal, and code edits"); }
	if (stage < 4) { tips.push("Tackle complex refactoring or debugging tasks in agent mode for deeper autonomous workflows"); }
	return { stage, tips };
}

function _calcFluencyTuStage(fd: FluencyInputData, cv: FluencyVars, isMCPEnabled: boolean | undefined): Stage {
	const T = STAGE_THRESHOLDS.toolUsage;
	const advancedToolIds = ["github_pull_request", "github_repo", "run_in_terminal", "editFiles", "listFiles"];
	const usedAdvancedCount = advancedToolIds.filter(t => (fd.toolCallsByTool[t] ?? 0) > 0).length;
	let stage: Stage = cv.nonAutoToolCount > 0 ? 2 : 1;
	if (fd.workspaceAgentCount > 0) { stage = promoteStage(stage, 3); }
	if (usedAdvancedCount >= T.stage3MinAdvancedTools) { stage = promoteStage(stage, 3); }
	if (isMCPEnabled !== false && fd.mcpTotal > 0) { stage = promoteStage(stage, 3); }
	if (isMCPEnabled !== false && Object.keys(fd.mcpByServer).length >= T.stage4MinMcpServers) { stage = 4; }
	return stage;
}

function _calcFluencyTuTips(fd: FluencyInputData, stage: Stage, isMCPEnabled: boolean | undefined): string[] {
	const tips: string[] = [];
	if (stage < 2) { tips.push("Try agent mode to let Copilot use built-in tools for file operations and terminal commands"); }
	if (stage < 3) {
		if (fd.mcpTotal === 0 && isMCPEnabled !== false) { tips.push("Set up MCP servers to connect Copilot to external tools (databases, APIs, cloud services)"); }
		else if (fd.mcpTotal > 0) { tips.push("Explore GitHub integrations and advanced tools like editFiles and run_in_terminal"); }
	}
	if (stage < 4) {
		if (Object.keys(fd.mcpByServer).length === 1) { tips.push("Add more MCP servers to expand Copilot's capabilities"); }
		else if (fd.mcpTotal === 0 && isMCPEnabled !== false) { tips.push("Explore MCP servers for tools that integrate with your workflow"); }
		else if (fd.mcpTotal > 0) { tips.push("Keep exploring advanced tool combinations"); }
	}
	return tips;
}

function _calcFluencyTu(fd: FluencyInputData, cv: FluencyVars, isMCPEnabled?: boolean): FluencyStageResult {
	const stage = _calcFluencyTuStage(fd, cv, isMCPEnabled);
	return { stage, tips: _calcFluencyTuTips(fd, stage, isMCPEnabled) };
}

function _calcFluencyCu(fd: FluencyInputData, cv: FluencyVars): FluencyStageResult {
	const T = STAGE_THRESHOLDS.customization;
	const totalRepos = fd.repositories.size;
	const reposWithCustomization = fd.repositoriesWithCustomization.size;
	const customizationRate = totalRepos > 0 ? reposWithCustomization / totalRepos : 0;
	const uniqueModels = new Set([...fd.standardModels, ...fd.premiumModels, ...fd.lowCostModels, ...fd.mediumCostModels, ...fd.highCostModels]);
	let stage = _cuComputeStage(customizationRate, reposWithCustomization, uniqueModels.size, T);
	const uncustomized = totalRepos - reposWithCustomization;
	const tips: string[] = [];
	if (fd.foundryWindowsSessions > 0) {
		stage = promoteStage(stage, 2);
		tips.push('If you are using Microsoft Foundry on Windows local models, keep exploring them for private and offline-friendly workflows');
	} else if (uniqueModels.size <= 1) {
		tips.push('Try the Microsoft Foundry on Windows extension if you want to experiment with local models and offline-friendly workflows');
	}
	if (fd.unknownProviderSessions > 0) {
		stage = promoteStage(stage, 2);
		tips.push('You have used models from other providers — keep exploring providers to match each task to the right model');
	} else if (uniqueModels.size <= 1) {
		tips.push('Try different model providers from the marketplace when you want more specialized or cost-effective options');
	}
	if (stage < 2) { tips.push("Create a .github/copilot-instructions.md or CLAUDE.md file with project-specific guidelines"); }
	if (stage < 3) { tips.push("Add custom instructions to more repositories to standardize your Copilot experience"); }
	if (stage < 4 && uncustomized > 0) { tips.push(`${fmt(reposWithCustomization)} of ${fmt(totalRepos)} repos customized — add instructions to the remaining ${fmt(uncustomized)} for Stage 4`); }
	else if (stage < 4) { tips.push("Aim for consistent customization across all projects with instructions and agents.md"); }
	if (stage >= 4 && uncustomized > 0) { tips.push(`${fmt(uncustomized)} repo${uncustomized === 1 ? '' : 's'} still missing customization — add instructions, agents.md, or MCP configs for full coverage`); }
	else if (stage >= 4) { tips.push("All repos customized! Keep instructions up to date and add skill files or MCP server configs for deeper integration"); }
	return { stage, tips };
}

function _calcFluencyWi(fd: FluencyInputData, cv: FluencyVars, effectiveSessions: number): FluencyStageResult {
	const T = STAGE_THRESHOLDS.workflowIntegration;
	let stage: Stage = 1;
	if (effectiveSessions >= T.stage2MinSessions) { stage = 2; }
	if (cv.avgApplyRate >= T.stage2MinApplyRatePct) { stage = promoteStage(stage, 2); }
	const modesUsed = [fd.askModeCount > 0, fd.agentModeCount > 0].filter(Boolean).length;
	if (modesUsed >= T.stage3MinModesUsed) { stage = promoteStage(stage, 3); }
	if (cv.totalContextRefs >= T.stage3MinContextRefs) { stage = promoteStage(stage, 3); }
	if (effectiveSessions >= T.stage4MinSessions && modesUsed >= T.stage3MinModesUsed && cv.totalContextRefs >= T.stage3MinContextRefs) { stage = 4; }
	const tips: string[] = [];
	if (stage < 2) { tips.push("Use Copilot more regularly — even for quick questions"); }
	if (stage < 3) {
		if (modesUsed < T.stage3MinModesUsed) { tips.push("Combine ask mode with agent mode in your daily workflow"); }
		if (cv.totalContextRefs < T.hasExplicitContextMinRefs) { tips.push("Use explicit context references like #file, @workspace, and #selection"); }
	}
	if (stage < 4) {
		if (cv.totalContextRefs < T.stage3MinContextRefs) { tips.push("Make explicit context a habit — use #file, @workspace, and other references consistently"); }
		tips.push("Make Copilot part of every coding task: planning, coding, testing, and reviewing");
	}
	return { stage, tips };
}

/**
 * Build FluencyVars object from FluencyInputData.
 * Extracted to reduce complexity of calculateFluencyScoreForTeamMember.
 */
function _buildFluencyVars(fd: FluencyInputData): FluencyVars {
	const totalInteractions = fd.askModeCount + fd.editModeCount + fd.agentModeCount + fd.cliModeCount;
	const avgTurnsPerSession = fd.turnsPerSessionCount > 0 ? fd.turnsPerSessionSum / fd.turnsPerSessionCount : 0;
	const switchingFrequency = fd.switchingFreqCount > 0 ? fd.switchingFreqSum / fd.switchingFreqCount : 0;
	
	const hasModelSwitching = fd.mixedTierSessions > 0 || fd.mixedCostSessions > 0 || switchingFrequency > 0;
	const hasAgentMode = (fd.agentModeCount + fd.cliModeCount) > 0;
	
	const avgFilesPerSession = fd.filesPerEditCount > 0 ? fd.filesPerEditSum / fd.filesPerEditCount : 0;
	const avgApplyRate = fd.applyRateCount > 0 ? fd.applyRateSum / fd.applyRateCount : 0;
	
	const totalContextRefs = fd.ctxFile + fd.ctxSelection + fd.ctxSymbol + fd.ctxCodebase + fd.ctxWorkspace;
	
	const usedRefTypeCount = [
		fd.ctxFile, fd.ctxSelection, fd.ctxSymbol, fd.ctxCodebase, fd.ctxWorkspace,
		fd.ctxTerminal, fd.ctxVscode, fd.ctxClipboard, fd.ctxChanges,
		fd.ctxProblemsPanel, fd.ctxOutputPanel, fd.ctxTerminalLastCommand, fd.ctxTerminalSelection,
	].filter(v => v > 0).length;
	
	return {
		totalInteractions,
		avgTurnsPerSession,
		hasModelSwitching,
		hasAgentMode,
		nonAutoToolCount: countNonAutoTools(fd.toolCallsByTool),
		avgFilesPerSession,
		avgApplyRate,
		totalContextRefs,
		usedRefTypeCount,
		usedSlashCommands: getUsedSlashCommands(fd.toolCallsByTool),
	};
}

/**
 * Build the result categories array from individual category scores.
 * Extracted to reduce complexity of calculateFluencyScoreForTeamMember.
 */
function _buildFluencyCategories(pe: FluencyStageResult, ce: FluencyStageResult, ag: FluencyStageResult, tu: FluencyStageResult, cu: FluencyStageResult, wi: FluencyStageResult): { category: string; icon: string; stage: number; tips: string[] }[] {
	return [
		{ category: "Prompt Engineering", icon: "💬", stage: pe.stage, tips: pe.tips },
		{ category: "Context Engineering", icon: "📎", stage: ce.stage, tips: ce.tips },
		{ category: "Agentic", icon: "🤖", stage: ag.stage, tips: ag.tips },
		{ category: "Tool Usage", icon: "🔧", stage: tu.stage, tips: tu.tips },
		{ category: "Customization", icon: "⚙️", stage: cu.stage, tips: cu.tips },
		{ category: "Workflow Integration", icon: "🔄", stage: wi.stage, tips: wi.tips },
	];
}

export function calculateFluencyScoreForTeamMember(fd: FluencyInputData, dashboardSessions: number, isMCPEnabled?: boolean): { stage: number; label: string; categories: { category: string; icon: string; stage: number; tips: string[] }[] } {
	const cv = _buildFluencyVars(fd);
	const effectiveSessions = Math.max(dashboardSessions, fd.sessionCount);
	
	const pe = _calcFluencyPE(fd, cv);
	const ce = _calcFluencyCE(fd, cv);
	const ag = _calcFluencyAg(fd, cv);
	const tu = _calcFluencyTu(fd, cv, isMCPEnabled);
	const cu = _calcFluencyCu(fd, cv);
	const wi = _calcFluencyWi(fd, cv, effectiveSessions);
	
	const overallStage = computeMedianStage([pe.stage, ce.stage, ag.stage, tu.stage, cu.stage, wi.stage] as Stage[]);
	
	return {
		stage: overallStage,
		label: STAGE_LABELS[overallStage as Stage] ?? `Stage ${overallStage}`,
		categories: _buildFluencyCategories(pe, ce, ag, tu, cu, wi),
	};
}

/**
 * Calculate maturity scores across 6 categories using last 30 days of usage data.
 * Each category is scored 1-4 based on threshold rules.
 * Overall stage = median of the 6 category scores.
 * @param useCache If true, use cached usage stats. If false, force recalculation.
 */
export async function calculateMaturityScores(lastCustomizationMatrix: WorkspaceCustomizationMatrix | undefined, calculateUsageAnalysisStatsFn: (useCache?: boolean) => Promise<UsageAnalysisStats>, useCache = true, isMCPEnabled?: boolean): Promise<{
	overallStage: number;
	overallLabel: string;
	categories: { category: string; icon: string; stage: number; evidence: string[]; tips: string[] }[];
	period: UsageAnalysisPeriod;
	lastUpdated: string;
	agenticTrend?: AgenticTrendPoint[];
}> {
	const stats = await calculateUsageAnalysisStatsFn(useCache);
	const p = stats.last30Days;

	const pe = _scorePromptEngineering(p);
	const ce = _scoreContextEngineering(p);
	const ag = _scoreAgentic(p);
	const tu = _scoreToolUsage(p, isMCPEnabled);
	const cu = _scoreCustomization(p, lastCustomizationMatrix);
	const wi = _scoreWorkflowIntegration(p);

	const overallStage = computeMedianStage([pe.stage, ce.stage, ag.stage, tu.stage, cu.stage, wi.stage]);

	return {
		overallStage,
		overallLabel: STAGE_LABELS[overallStage as Stage] ?? `Stage ${overallStage}`,
		categories: [
			{ category: 'Prompt Engineering', icon: '💬', stage: pe.stage, evidence: pe.evidence, tips: pe.tips },
			{ category: 'Context Engineering', icon: '📎', stage: ce.stage, evidence: ce.evidence, tips: ce.tips },
			{ category: 'Agentic', icon: '🤖', stage: ag.stage, evidence: ag.evidence, tips: ag.tips },
			{ category: 'Tool Usage', icon: '🔧', stage: tu.stage, evidence: tu.evidence, tips: tu.tips },
			{ category: 'Customization', icon: '⚙️', stage: cu.stage, evidence: cu.evidence, tips: cu.tips },
			{ category: 'Workflow Integration', icon: '🔄', stage: wi.stage, evidence: wi.evidence, tips: wi.tips }
		],
		period: p,
		lastUpdated: stats.lastUpdated.toISOString(),
		agenticTrend: stats.agenticDailyTrend
	};
}
