import test from 'node:test';
import * as assert from 'node:assert/strict';

import taskClassificationDefault, {
classifyTurn,
classifySessionTurns,
classifySessionTask,
buildClassificationInputFromUsageAnalysis,
buildClassificationInputFromChatTurns,
countDelegationToolCalls,
resolveSessionTaskAttribution,
createEmptyTaskClassificationResult,
} from '../taskClassification';
import type { ChatTurn, ContextReferenceUsage, SessionUsageAnalysis } from '../types';

test('classifyTurn: edit tool is Coding', () => {
assert.equal(classifyTurn({ toolNames: ['edit'] }), 'Coding');
});

test('classifyTurn: debug keywords classify as Debugging', () => {
assert.equal(classifyTurn({ messageText: 'Please debug this failing test and fix the error' }), 'Debugging');
});

test('classifyTurn: git command in shell classifies as Git Ops', () => {
assert.equal(classifyTurn({ toolNames: ['bash'], shellCommands: ['git commit -m "x"'] }), 'Git Ops');
});

test('classifySessionTurns: returns weighted shares and primary category', () => {
const result = classifySessionTurns([
	{ messageText: 'implement new endpoint', toolNames: ['edit'] },
	{ messageText: 'run tests', toolNames: ['bash'], shellCommands: ['npm test'] },
	{ messageText: 'run tests again', toolNames: ['bash'], shellCommands: ['npm test'] },
]);
assert.equal(result.primaryCategory, 'Testing');
assert.equal(result.turnCount, 3);
assert.equal(result.categoryShares['Testing'], 2 / 3);
assert.equal(result.categoryShares['Coding'], 1 / 3);
});

function emptyContextRefs(): ContextReferenceUsage {
	return {
		file: 0, selection: 0, implicitSelection: 0, symbol: 0, codebase: 0, workspace: 0,
		terminal: 0, vscode: 0, terminalLastCommand: 0, terminalSelection: 0, clipboard: 0,
		changes: 0, outputPanel: 0, problemsPanel: 0, pullRequest: 0,
		byKind: {}, copilotInstructions: 0, agentsMd: 0, byPath: {},
	};
}

function makeTurn(overrides: Partial<ChatTurn>): ChatTurn {
	return {
		turnNumber: 1,
		timestamp: null,
		mode: 'agent',
		userMessage: '',
		assistantResponse: '',
		model: null,
		toolCalls: [],
		contextReferences: emptyContextRefs(),
		mcpTools: [],
		inputTokensEstimate: 0,
		outputTokensEstimate: 0,
		thinkingTokensEstimate: 0,
		...overrides,
	};
}

// ── classifySessionTask: one example per TaskCategory ─────────────────────────

test('classifySessionTask: Git Ops — terminal git command wins over everything else', () => {
	assert.equal(classifySessionTask({ toolNames: ['run_in_terminal'], terminalCommands: ['git push origin main'] }), 'Git Ops');
});

test('classifySessionTask: Build/Deploy — docker build terminal command', () => {
	assert.equal(classifySessionTask({ toolNames: ['run_in_terminal'], terminalCommands: ['docker build -t app .'] }), 'Build/Deploy');
});

test('classifySessionTask: Testing — test-runner terminal command', () => {
	assert.equal(classifySessionTask({ toolNames: ['run_in_terminal'], terminalCommands: ['npm test'] }), 'Testing');
});

test('classifySessionTask: Testing — dedicated test tool call', () => {
	assert.equal(classifySessionTask({ toolNames: ['run_tests'] }), 'Testing');
});

test('classifySessionTask: Delegation — sub-agent tool call', () => {
	assert.equal(classifySessionTask({ toolNames: ['delegate_task'] }), 'Delegation');
});

test('classifySessionTask: Delegation — Copilot CLI task tool', () => {
	assert.equal(classifySessionTask({ toolNames: ['task', 'edit_file'] }), 'Delegation');
});

test('classifySessionTask: Delegation — Copilot CLI background-agent tools', () => {
	assert.equal(classifySessionTask({ toolNames: ['read_agent'] }), 'Delegation');
	assert.equal(classifySessionTask({ toolNames: ['write_agent'] }), 'Delegation');
	assert.equal(classifySessionTask({ toolNames: ['list_agents'] }), 'Delegation');
});

test('classifySessionTask: Delegation — Claude Code Task tool (capitalized)', () => {
	assert.equal(classifySessionTask({ toolNames: ['Task'] }), 'Delegation');
});

test('classifySessionTask: Delegation — Claude Agent tool', () => {
	assert.equal(classifySessionTask({ toolNames: ['Bash', 'Agent'] }), 'Delegation');
});

test('classifySessionTask: Delegation — Copilot App session-spawning tools', () => {
	assert.equal(classifySessionTask({ toolNames: ['create_session'] }), 'Delegation');
	assert.equal(classifySessionTask({ toolNames: ['open_pr_session'] }), 'Delegation');
});

test('classifySessionTask: Delegation — MCP spawn_task tool', () => {
	assert.equal(classifySessionTask({ toolNames: ['mcp__ccd_session__spawn_task'] }), 'Delegation');
});

test('classifySessionTask: Planning — dedicated planning/todo tool call', () => {
	assert.equal(classifySessionTask({ toolNames: ['todo_write'] }), 'Planning');
});

test('classifySessionTask: Debugging — edit tool + bug/fix keywords', () => {
	assert.equal(classifySessionTask({ toolNames: ['edit_file'], userText: 'fix the bug in the parser' }), 'Debugging');
});

test('classifySessionTask: Refactoring — edit tool + refactor keywords', () => {
	assert.equal(classifySessionTask({ toolNames: ['edit_file'], userText: 'refactor the module to simplify duplicate logic' }), 'Refactoring');
});

test('classifySessionTask: Feature Dev — edit tool + add/implement keywords', () => {
	assert.equal(classifySessionTask({ toolNames: ['create_file'], userText: 'add a new feature to export CSV data' }), 'Feature Dev');
});

test('classifySessionTask: Planning — planning keywords without edit tools', () => {
	assert.equal(classifySessionTask({ toolNames: ['read_file'], userText: 'help me outline a roadmap for next quarter' }), 'Planning');
});

test('classifySessionTask: Exploration — only read/search tool calls', () => {
	assert.equal(classifySessionTask({ toolNames: ['read_file', 'grep_search'] }), 'Exploration');
});

test('classifySessionTask: Coding — edit tool calls, no stronger signal', () => {
	assert.equal(classifySessionTask({ toolNames: ['edit_file'] }), 'Coding');
});

test('classifySessionTask: Brainstorming — no tool calls, brainstorming keywords', () => {
	assert.equal(classifySessionTask({ toolNames: [], userText: 'brainstorm some ideas for the new architecture' }), 'Brainstorming');
});

test('classifySessionTask: Conversation — no tool calls, no keyword match', () => {
	assert.equal(classifySessionTask({ toolNames: [], userText: 'thanks so much, that really helped me understand' }), 'Conversation');
});

// ── buildClassificationInputFromUsageAnalysis ─────────────────────────────────

test('buildClassificationInputFromUsageAnalysis: extracts tool names from byTool keys and passes through title', () => {
	const usageAnalysis = { toolCalls: { total: 2, byTool: { edit_file: 1, read_file: 1 } } } as unknown as Pick<SessionUsageAnalysis, 'toolCalls'>;
	const result = buildClassificationInputFromUsageAnalysis(usageAnalysis, 'Fix a bug in the parser');
	assert.deepEqual([...result.toolNames].sort(), ['edit_file', 'read_file']);
	assert.equal(result.userText, 'Fix a bug in the parser');
	assert.equal(result.terminalCommands, undefined);
});

test('buildClassificationInputFromUsageAnalysis: handles missing usageAnalysis/title gracefully', () => {
	const result = buildClassificationInputFromUsageAnalysis(undefined, undefined);
	assert.deepEqual(result.toolNames, []);
	assert.equal(result.userText, undefined);
});

test('buildClassificationInputFromUsageAnalysis: includes MCP spawn tools so MCP-only delegation classifies as Delegation', () => {
	const usageAnalysis = {
		toolCalls: { total: 5, byTool: { Bash: 5 } },
		mcpTools: { total: 3, byServer: { ccd_session: 3 }, byTool: { mcp__ccd_session__spawn_task: 3 } },
	} as unknown as SessionUsageAnalysis;
	const input = buildClassificationInputFromUsageAnalysis(usageAnalysis, 'do some work');
	assert.ok(input.toolNames.includes('mcp__ccd_session__spawn_task'));
	assert.equal(classifySessionTask(input), 'Delegation');
});

// ── buildClassificationInputFromChatTurns ─────────────────────────────────────

test('buildClassificationInputFromChatTurns: collects tool names, terminal commands, and joined user text', () => {
	const turns: ChatTurn[] = [
		makeTurn({ userMessage: 'please fix this', toolCalls: [{ toolName: 'edit_file' }] }),
		makeTurn({ userMessage: 'and run the tests', toolCalls: [{ toolName: 'run_in_terminal', arguments: 'npm test' }] }),
	];
	const result = buildClassificationInputFromChatTurns(turns);
	assert.deepEqual(result.toolNames, ['edit_file', 'run_in_terminal']);
	assert.deepEqual(result.terminalCommands, ['npm test']);
	assert.equal(result.userText, 'please fix this and run the tests');
});

test('buildClassificationInputFromChatTurns: empty turns array yields empty input', () => {
	const result = buildClassificationInputFromChatTurns([]);
	assert.deepEqual(result.toolNames, []);
	assert.deepEqual(result.terminalCommands, []);
	assert.equal(result.userText, '');
});

test('default export bundles all three functions', () => {
	assert.equal(taskClassificationDefault.classifySessionTask, classifySessionTask);
	assert.equal(taskClassificationDefault.buildClassificationInputFromUsageAnalysis, buildClassificationInputFromUsageAnalysis);
	assert.equal(taskClassificationDefault.buildClassificationInputFromChatTurns, buildClassificationInputFromChatTurns);
});

// ── countDelegationToolCalls ───────────────────────────────────────────────

test('countDelegationToolCalls: sums counts for subagent/delegate-matching tool names', () => {
	const total = countDelegationToolCalls({ subagent: 3, delegate_task: 2, edit_file: 10 });
	assert.equal(total, 5);
});

test('countDelegationToolCalls: matches sub-agent, agent-spawn, and case-insensitively', () => {
	const total = countDelegationToolCalls({ 'Sub-Agent': 1, agent_spawn: 4, Delegate: 2, run_tests: 7 });
	assert.equal(total, 7);
});

test('countDelegationToolCalls: returns 0 when no tools match', () => {
	assert.equal(countDelegationToolCalls({ edit_file: 5, read_file: 3 }), 0);
});

test('countDelegationToolCalls: returns 0 for empty input', () => {
	assert.equal(countDelegationToolCalls({}), 0);
});

test('countDelegationToolCalls: matches the Copilot CLI sub-agent tool family', () => {
	const total = countDelegationToolCalls({ task: 2, read_agent: 1, write_agent: 1, list_agents: 1, edit: 20 });
	assert.equal(total, 5);
});

test('countDelegationToolCalls: matches Claude Agent tool, MCP spawn tools, and App session spawners', () => {
	const total = countDelegationToolCalls({ Agent: 2, mcp__ccd_session__spawn_task: 3, create_session: 1, fork_session: 1, Bash: 50 });
	assert.equal(total, 7);
});

test('countDelegationToolCalls: does not match tool names merely containing "task" or "agent"', () => {
	assert.equal(countDelegationToolCalls({ task_create: 1, todo_write: 1, manage_agents_config: 1 }), 0);
});

test('resolveSessionTaskAttribution uses a classification that covered turns', () => {
	const classification = classifySessionTurns([
		{ messageText: 'run tests', toolNames: ['bash'], shellCommands: ['npm test'] },
	]);
	assert.ok(classification.turnCount > 0);
	const result = resolveSessionTaskAttribution({ toolCalls: { total: 0, byTool: {} }, taskClassification: classification });
	assert.equal(result.taskCategory, classification.primaryCategory);
	assert.deepEqual(result.taskCategoryShares, classification.categoryShares);
});

test('resolveSessionTaskAttribution falls back to the tool heuristic for an empty classification', () => {
	// analyzeSessionUsage() and the adapters always set taskClassification, to the empty
	// "Conversation" placeholder when nothing was classified; that must not mask tool calls.
	const toolCalls = { total: 1, byTool: { edit: 1 } };
	const result = resolveSessionTaskAttribution({ toolCalls, taskClassification: createEmptyTaskClassificationResult() });
	assert.equal(result.taskCategory, classifySessionTask(buildClassificationInputFromUsageAnalysis({ toolCalls })));
	assert.notEqual(result.taskCategory, 'Conversation', 'the placeholder category must not win over the tools');
	assert.equal('taskCategoryShares' in result, false, 'the placeholder shares must not be carried over');
});
