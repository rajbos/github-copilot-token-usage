export const TASK_CATEGORIES = [
	'Coding',
	'Debugging',
	'Feature Dev',
	'Refactoring',
	'Testing',
	'Exploration',
	'Planning',
	'Delegation',
	'Git Ops',
	'Build/Deploy',
	'Brainstorming',
	'Conversation',
] as const;

export type TaskCategory = typeof TASK_CATEGORIES[number];
export type TaskCategoryBreakdown = Record<TaskCategory, number>;

export interface TaskTurnSignal {
	messageText?: string;
	toolNames?: string[];
	shellCommands?: string[];
}

export interface TaskClassificationResult {
	primaryCategory: TaskCategory;
	categoryShares: TaskCategoryBreakdown;
	turnCategories: TaskCategory[];
	turnCount: number;
}

const CATEGORY_PRIORITY: TaskCategory[] = [
	'Delegation',
	'Git Ops',
	'Build/Deploy',
	'Debugging',
	'Testing',
	'Refactoring',
	'Feature Dev',
	'Planning',
	'Exploration',
	'Coding',
	'Brainstorming',
	'Conversation',
];

const TOOL_PATTERNS: Record<TaskCategory, RegExp[]> = {
	'Coding': [/^(edit|create|write|apply_patch|replace|insert|multi_edit|str_replace)$/i],
	'Debugging': [/^(read|view|grep|rg|diagnostics?|log|trace)$/i],
	'Feature Dev': [],
	'Refactoring': [/^(refactor|rename|move|restructure)$/i],
	'Testing': [/^(test|jest|vitest|pytest|mocha|playwright|cypress)$/i],
	'Exploration': [/^(read|view|grep|rg|glob|search|web_fetch|web_search|ls|list)$/i],
	'Planning': [/^(plan|todo|checklist)$/i],
	'Delegation': [/^(task|agent|subagent|delegate|handoff|write_agent|read_agent)$/i],
	'Git Ops': [/^(git|commit|push|pull|merge|rebase|cherry-pick|branch|pr)$/i],
	'Build/Deploy': [/^(build|deploy|release|docker|k8s|helm|terraform|npm|yarn|pnpm)$/i],
	'Brainstorming': [],
	'Conversation': [],
};

const KEYWORD_PATTERNS: Record<TaskCategory, RegExp[]> = {
	'Coding': [/\b(code|implement|write code|function|class|module|api)\b/i],
	'Debugging': [/\b(debug|bug|fix|error|failing|stack ?trace|investigate|root cause|broken)\b/i],
	'Feature Dev': [/\b(add|create|implement|introduce|support|new feature|build feature)\b/i],
	'Refactoring': [/\b(refactor|rename|simplify|cleanup|clean up|extract|restructure)\b/i],
	'Testing': [/\b(test|tests|unit test|integration test|e2e|pytest|vitest|jest|mocha|cypress)\b/i],
	'Exploration': [/\b(explore|inspect|analyze|understand|investigate|read|search|find where)\b/i],
	'Planning': [/\b(plan|approach|roadmap|steps|outline|strategy)\b/i],
	'Delegation': [/\b(delegate|sub-?agent|spawn agent|handoff|hand off|ask agent)\b/i],
	'Git Ops': [/\b(git|commit|push|pull request|merge|rebase|branch|cherry-pick|tag)\b/i],
	'Build/Deploy': [/\b(build|compile|bundle|deploy|release|publish|docker|kubernetes|ci|cd)\b/i],
	'Brainstorming': [/\b(brainstorm|what if|ideas?|alternatives?|trade-?offs?|design options?)\b/i],
	'Conversation': [],
};

function createEmptyBreakdown(): TaskCategoryBreakdown {
	return TASK_CATEGORIES.reduce((acc, cat) => {
		acc[cat] = 0;
		return acc;
	}, {} as TaskCategoryBreakdown);
}

function pickCategory(scores: TaskCategoryBreakdown): TaskCategory {
	let best = 0;
	let selected: TaskCategory = 'Conversation';
	for (const category of CATEGORY_PRIORITY) {
		const score = scores[category];
		if (score > best) {
			best = score;
			selected = category;
		}
	}
	return best > 0 ? selected : 'Conversation';
}

function scoreTurn(turn: TaskTurnSignal): TaskCategoryBreakdown {
	const scores = createEmptyBreakdown();
	const message = (turn.messageText ?? '').trim();
	const tools = (turn.toolNames ?? []).map(t => t.trim()).filter(Boolean);
	const shellCommands = (turn.shellCommands ?? []).join('\n');
	applyKeywordScores(scores, message);
	applyToolScores(scores, tools);
	applyShellScores(scores, shellCommands);
	applyConversationFallback(scores, message, tools);
	return scores;
}

function applyKeywordScores(scores: TaskCategoryBreakdown, message: string): void {
	for (const [category, patterns] of Object.entries(KEYWORD_PATTERNS) as Array<[TaskCategory, RegExp[]]>) {
		for (const pattern of patterns) {
			if (pattern.test(message)) { scores[category] += 2; }
		}
	}
}

function applyToolScores(scores: TaskCategoryBreakdown, tools: string[]): void {
	for (const tool of tools) {
		for (const [category, patterns] of Object.entries(TOOL_PATTERNS) as Array<[TaskCategory, RegExp[]]>) {
			if (patterns.some(p => p.test(tool))) { scores[category] += 1; }
		}
	}
}

function applyShellScores(scores: TaskCategoryBreakdown, shellCommands: string): void {
	if (/\b(git (commit|push|pull|merge|rebase|checkout|cherry-pick|tag|branch)|gh pr)\b/i.test(shellCommands)) { scores['Git Ops'] += 3; }
	if (/\b(npm (run )?(test|lint|build)|pnpm (test|build)|yarn (test|build)|pytest|vitest|jest|mocha|cypress)\b/i.test(shellCommands)) { scores['Testing'] += 2; }
	if (/\b(npm (run )?build|pnpm build|yarn build|docker (build|push|run)|kubectl|helm|terraform|vercel|netlify)\b/i.test(shellCommands)) { scores['Build/Deploy'] += 2; }
}

function applyConversationFallback(scores: TaskCategoryBreakdown, message: string, tools: string[]): void {
	if (tools.length === 0 && !message) { scores['Conversation'] += 1; }
	if (tools.length === 0 && message && Object.values(scores).every(v => v === 0)) { scores['Conversation'] += 1; }
}

export function classifyTurn(turn: TaskTurnSignal): TaskCategory {
	return pickCategory(scoreTurn(turn));
}

export function classifySessionTurns(turns: TaskTurnSignal[]): TaskClassificationResult {
	const byCategory = createEmptyBreakdown();
	if (turns.length === 0) {
		byCategory['Conversation'] = 1;
		return {
			primaryCategory: 'Conversation',
			categoryShares: byCategory,
			turnCategories: [],
			turnCount: 0,
		};
	}

	const turnCategories = turns.map(classifyTurn);
	for (const category of turnCategories) {
		byCategory[category] += 1;
	}
	for (const category of TASK_CATEGORIES) {
		byCategory[category] = byCategory[category] / turns.length;
	}

	const primaryCategory = pickCategory(byCategory);
	return {
		primaryCategory,
		categoryShares: byCategory,
		turnCategories,
		turnCount: turns.length,
	};
}

export function createEmptyTaskClassificationResult(): TaskClassificationResult {
	const categoryShares = createEmptyBreakdown();
	categoryShares['Conversation'] = 1;
	return {
		primaryCategory: 'Conversation',
		categoryShares,
		turnCategories: [],
		turnCount: 0,
	};
}

/**
 * Task classification — buckets a session into a single dominant task category
 * using keyword + tool-usage heuristics (issue #1650).
 */
import type { SessionUsageAnalysis, ChatTurn } from './types';

/** Adapter-agnostic input for `classifySessionTask()`. */
export interface TaskClassificationInput {
	toolNames: string[];
	terminalCommands?: string[];
	userText?: string;
}

const EDIT_TOOL_PATTERN = /edit|write|create_?file|replace_?string|str_replace|apply_?patch|patch/i;
const READ_TOOL_PATTERN = /read_?file|grep_?search|file_?search|search|glob|list_dir|websearch|fetch/i;
const TERMINAL_TOOL_PATTERN = /terminal|bash|shell|run_?command/i;
const PLANNING_TOOL_PATTERN = /todo|task[-_]?create|enterplanmode|\bplan\b/i;
export const DELEGATION_TOOL_PATTERN = /^(task|agent|read_agent|write_agent|list_agents|create_session|open_pr_session|open_issue_session|fork_session)$|subagent|sub[-_]?agent|agent[-_]?spawn|spawn[-_]?(task|agent)|delegate/i;

export function countDelegationToolCalls(byTool: Record<string, number>): number {
	let total = 0;
	for (const [tool, count] of Object.entries(byTool)) {
		if (DELEGATION_TOOL_PATTERN.test(tool)) { total += count; }
	}
	return total;
}
const TEST_TOOL_PATTERN = /run_?tests?|pytest|vitest|jest/i;
const GIT_KEYWORD_PATTERN = /\bgit\s+(push|commit|merge|pull|rebase|checkout|clone)\b/i;
const BUILD_KEYWORD_PATTERN = /\b(npm\s+run\s+build|docker\s+(build|run|compose)|pm2|webpack|esbuild|make\s+build|deploy(ment)?)\b/i;
const TEST_KEYWORD_PATTERN = /\b(pytest|vitest|jest|npm\s+(run\s+)?test|go\s+test|dotnet\s+test|mocha)\b/i;
const DEBUG_KEYWORD_PATTERN = /\b(fix(ing|ed)?|bug|error|debug(ging)?|broken|crash(ing|ed)?|fail(ing|ed|ure)?|issue)\b/i;
const REFACTOR_KEYWORD_PATTERN = /\b(refactor(ing)?|rename|simplify|restructure|clean\s?up)\b/i;
const FEATURE_KEYWORD_PATTERN = /\b(add|create|implement|build|new feature)\b/i;
const PLANNING_KEYWORD_PATTERN = /\b(plan|roadmap|outline|todo list|task list)\b/i;
const BRAINSTORM_KEYWORD_PATTERN = /\b(brainstorm|what if|design|explore ideas?|thinking about)\b/i;

interface ClassificationSignals {
	hasToolCalls: boolean;
	hasEditTools: boolean;
	hasReadTools: boolean;
	hasTerminalTools: boolean;
	hasPlanningTools: boolean;
	hasDelegationTools: boolean;
	hasTestTools: boolean;
	terminalText: string;
	userText: string;
}

function deriveSignals(input: TaskClassificationInput): ClassificationSignals {
	const toolNames = (input.toolNames ?? []).map(t => t.toLowerCase());
	return {
		hasToolCalls: toolNames.length > 0,
		hasEditTools: toolNames.some(t => EDIT_TOOL_PATTERN.test(t)),
		hasReadTools: toolNames.some(t => READ_TOOL_PATTERN.test(t)),
		hasTerminalTools: toolNames.some(t => TERMINAL_TOOL_PATTERN.test(t)),
		hasPlanningTools: toolNames.some(t => PLANNING_TOOL_PATTERN.test(t)),
		hasDelegationTools: toolNames.some(t => DELEGATION_TOOL_PATTERN.test(t)),
		hasTestTools: toolNames.some(t => TEST_TOOL_PATTERN.test(t)),
		terminalText: (input.terminalCommands ?? []).join(' ').toLowerCase(),
		userText: (input.userText ?? '').toLowerCase(),
	};
}

function classifyByToolAndTerminalSignals(s: ClassificationSignals): TaskCategory | null {
	if (GIT_KEYWORD_PATTERN.test(s.terminalText)) { return 'Git Ops'; }
	if (BUILD_KEYWORD_PATTERN.test(s.terminalText)) { return 'Build/Deploy'; }
	if (TEST_KEYWORD_PATTERN.test(s.terminalText) || s.hasTestTools) { return 'Testing'; }
	if (s.hasDelegationTools) { return 'Delegation'; }
	if (s.hasPlanningTools) { return 'Planning'; }
	return null;
}

function classifyByActivityKeywords(s: ClassificationSignals): TaskCategory | null {
	if (!s.hasToolCalls) { return null; }
	if (DEBUG_KEYWORD_PATTERN.test(s.userText)) { return 'Debugging'; }
	if (REFACTOR_KEYWORD_PATTERN.test(s.userText)) { return 'Refactoring'; }
	if (FEATURE_KEYWORD_PATTERN.test(s.userText)) { return 'Feature Dev'; }
	return null;
}

function classifyByFallback(s: ClassificationSignals): TaskCategory {
	if (!s.hasEditTools && PLANNING_KEYWORD_PATTERN.test(s.userText)) { return 'Planning'; }
	if (s.hasToolCalls && s.hasReadTools && !s.hasEditTools && !s.hasTerminalTools) { return 'Exploration'; }
	if (s.hasEditTools) { return 'Coding'; }
	if ((!s.hasToolCalls || s.hasReadTools) && BRAINSTORM_KEYWORD_PATTERN.test(s.userText)) { return 'Brainstorming'; }
	if (!s.hasToolCalls) { return 'Conversation'; }
	return 'Coding';
}

export function classifySessionTask(input: TaskClassificationInput): TaskCategory {
	const signals = deriveSignals(input);
	return classifyByToolAndTerminalSignals(signals) ?? classifyByActivityKeywords(signals) ?? classifyByFallback(signals);
}

export function buildClassificationInputFromUsageAnalysis(
	usageAnalysis: Pick<SessionUsageAnalysis, 'toolCalls'> & Partial<Pick<SessionUsageAnalysis, 'mcpTools'>> | undefined,
	userText?: string | null
): TaskClassificationInput {
	const toolNames = usageAnalysis ? Object.keys(usageAnalysis.toolCalls?.byTool ?? {}) : [];
	const mcpToolNames = usageAnalysis?.mcpTools ? Object.keys(usageAnalysis.mcpTools.byTool ?? {}) : [];
	return { toolNames: [...toolNames, ...mcpToolNames], userText: userText ?? undefined };
}

/**
 * A session's task attribution as every host stores it: the analysis' own primary category and
 * shares when it produced them, otherwise the tool/title heuristic. Shared by the extension's
 * session analyzer and the CLI so the Chart view's "By Task" split cannot drift between them.
 */
export function resolveSessionTaskAttribution(
	usageAnalysis: Pick<SessionUsageAnalysis, 'toolCalls' | 'taskClassification'> & Partial<Pick<SessionUsageAnalysis, 'mcpTools'>>,
	title?: string | null,
): { taskCategory: TaskCategory; taskCategoryShares?: TaskCategoryBreakdown } {
	// analyzeSessionUsage() and the ecosystem adapters always set `taskClassification`, using
	// createEmptyTaskClassificationResult() (a "Conversation" placeholder with no turns) when
	// nothing was classified. Only a classification that actually covered turns is
	// authoritative; otherwise fall back to the tool/title heuristic, so an adapter that
	// reports tool calls but no turn classification is not filed under "Conversation".
	const classification = usageAnalysis.taskClassification;
	if (classification && classification.turnCount > 0) {
		return { taskCategory: classification.primaryCategory, taskCategoryShares: classification.categoryShares };
	}
	return { taskCategory: classifySessionTask(buildClassificationInputFromUsageAnalysis(usageAnalysis, title)) };
}

export function buildClassificationInputFromChatTurns(turns: ChatTurn[]): TaskClassificationInput {
	const toolNames: string[] = [];
	const terminalCommands: string[] = [];
	const userTextParts: string[] = [];
	for (const turn of turns) {
		if (turn.userMessage) { userTextParts.push(turn.userMessage); }
		for (const tc of turn.toolCalls ?? []) {
			toolNames.push(tc.toolName);
			if (tc.arguments && TERMINAL_TOOL_PATTERN.test(tc.toolName.toLowerCase())) {
				terminalCommands.push(tc.arguments);
			}
		}
	}
	return { toolNames, terminalCommands, userText: userTextParts.join(' ') };
}

export default {
	classifySessionTask,
	buildClassificationInputFromUsageAnalysis,
	buildClassificationInputFromChatTurns,
	countDelegationToolCalls,
	classifySessionTurns,
	classifyTurn,
	createEmptyTaskClassificationResult,
};

