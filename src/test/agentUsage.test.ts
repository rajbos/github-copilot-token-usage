import test from 'node:test';
import * as assert from 'node:assert/strict';
import { advanceCliAgentState, classifyAgentSource, createCliAgentState, isCustomAgentFile, mergeAgentUsage, readVsCodeModeId, resolveVsCodeAgent } from '../agentUsage';
import { analyzeSessionUsage, createEmptySessionUsageAnalysis, type UsageAnalysisDeps } from '../usageAnalysis';
import { getModeType } from '../workspaceHelpers';
import type { AgentUsage } from '../types';

function makeDeps(): UsageAnalysisDeps {
	return {
		warn: () => { /* ignore */ },
		modelPricing: {},
		tokenEstimators: {},
		toolNameMap: {},
		ecosystems: [],
	} as unknown as UsageAnalysisDeps;
}

const jsonl = (events: unknown[]) => events.map(e => JSON.stringify(e)).join('\n');
const fileUri = (p: string) => ({ $mid: 1, external: `file://${p}`, path: p, scheme: 'file' });
const customMode = (name: string, uriPath: string) => ({
	kind: 'agent', isBuiltin: false, modeId: 'custom', modeName: '-810970857',
	modeInstructions: { uri: fileUri(uriPath), name, content: 'PRIVATE', toolReferences: [], isBuiltin: false },
});
const req = (id: string, modeInfo?: unknown) => ({ requestId: id, message: { text: 'hi' }, ...(modeInfo ? { modeInfo } : {}) });

const GITHUB_PATH = '/c:/code/repo/.github/agents/product-owner.agent.md';
const CLAUDE_PATH = '/c:/code/repo/.claude/agents/product-owner.md';
const ASK_PATH = '/c:/Users/me/AppData/Roaming/Code/User/globalStorage/github.copilot-chat/ask-agent/Ask.agent.md';

test('isCustomAgentFile accepts .agent.md and .claude/agents/*.md but not the built-in Ask/Plan files', () => {
	assert.equal(isCustomAgentFile(GITHUB_PATH), true);
	assert.equal(isCustomAgentFile(CLAUDE_PATH), true);
	assert.equal(isCustomAgentFile('file:///c%3A/code/repo/.claude/agents/product-owner.md'), true);
	assert.equal(isCustomAgentFile(ASK_PATH), false);
	assert.equal(isCustomAgentFile('vscode-userdata:/x/globalStorage/github.copilot-chat/plan-agent/Plan.agent.md'), false);
	assert.equal(isCustomAgentFile('/c:/code/repo/docs/product-owner.md'), false);
	assert.equal(isCustomAgentFile('agent'), false);
	assert.equal(isCustomAgentFile(undefined), false);
});

test('classifyAgentSource tells the definition locations apart', () => {
	assert.equal(classifyAgentSource(GITHUB_PATH), 'github');
	assert.equal(classifyAgentSource(CLAUDE_PATH), 'claude');
	assert.equal(classifyAgentSource('vscode-userdata:/x/User/prompts/mine.agent.md'), 'user');
	assert.equal(classifyAgentSource('/somewhere/else.agent.md'), 'other');
});

test('getModeType treats a .claude/agents file as a custom agent', () => {
	assert.equal(getModeType({ kind: 'agent', id: 'file:///c%3A/code/repo/.claude/agents/product-owner.md' }), 'customAgent');
	assert.equal(getModeType({ kind: 'agent', id: 'file:///c%3A/code/repo/.github/agents/product-owner.agent.md' }), 'customAgent');
	assert.equal(getModeType({ kind: 'agent', id: 'agent' }), 'agent');
});

test('resolveVsCodeAgent keeps the name exactly as VS Code shows it and ignores built-in modes', () => {
	assert.deepEqual(resolveVsCodeAgent(customMode('Product Owner', GITHUB_PATH)), { name: 'Product Owner', source: 'github' });
	assert.deepEqual(resolveVsCodeAgent(customMode('Product Owner[Claude]', CLAUDE_PATH)), { name: 'Product Owner[Claude]', source: 'claude' });
	assert.equal(resolveVsCodeAgent(customMode('Ask', ASK_PATH)), null);
	assert.equal(resolveVsCodeAgent({ kind: 'agent', isBuiltin: true, modeId: 'agent' }), null);
	assert.equal(resolveVsCodeAgent(undefined, 'agent'), null);
	// No modeInfo: fall back to the inputState.mode.id URI, naming the agent after its file.
	assert.deepEqual(resolveVsCodeAgent(undefined, 'file:///c%3A/code/repo/.github/agents/repostatus.agent.md'), { name: 'repostatus', source: 'github' });
});

test('readVsCodeModeId reads kind 0 headers and kind 1 patches', () => {
	assert.equal(readVsCodeModeId({ kind: 0, v: { inputState: { mode: { id: 'a', kind: 'agent' } } } }), 'a');
	assert.equal(readVsCodeModeId({ kind: 1, k: ['inputState', 'mode'], v: { id: 'b', kind: 'agent' } }), 'b');
	assert.equal(readVsCodeModeId({ kind: 1, k: ['inputState'], v: { mode: { id: 'c' } } }), 'c');
	assert.equal(readVsCodeModeId({ kind: 1, k: ['inputState', 'permissionLevel'], v: 'autopilot' }), undefined);
});

test('VS Code delta session: .github and .claude agents with the same file name stay separate, per request', async () => {
	const content = jsonl([
		{ kind: 0, v: { requests: [], inputState: { mode: { id: 'agent', kind: 'agent' } } } },
		{ kind: 2, k: ['requests'], v: [req('r1', customMode('Product Owner', GITHUB_PATH))] },
		{ kind: 2, k: ['requests'], v: [req('r2', customMode('Product Owner', GITHUB_PATH))] },
		{ kind: 2, k: ['requests'], v: [req('r3', customMode('Product Owner[Claude]', CLAUDE_PATH))] },
		{ kind: 2, k: ['requests'], v: [req('r4', customMode('Ask', ASK_PATH))] },
		{ kind: 2, k: ['requests'], v: [req('r5', { kind: 'agent', isBuiltin: true, modeId: 'agent' })] },
	]);
	const result = await analyzeSessionUsage(makeDeps(), 'chatSessions/s.jsonl', content);
	assert.deepEqual(result.agentUsage, {
		byAgent: {
			'Product Owner': { sessions: 1, requests: 2, source: 'github' },
			'Product Owner[Claude]': { sessions: 1, requests: 1, source: 'claude' },
		},
	});
	assert.ok(!JSON.stringify(result.agentUsage).includes('PRIVATE'), 'agent prompt content must never be stored');
});

test('VS Code delta session: without modeInfo the inputState.mode.id in force per request is used', async () => {
	const claudeId = 'file:///c%3A/code/repo/.claude/agents/reviewer.md';
	const content = jsonl([
		{ kind: 0, v: { requests: [], inputState: { mode: { id: 'agent', kind: 'agent' } } } },
		{ kind: 2, k: ['requests'], v: [req('r1')] },
		{ kind: 1, k: ['inputState', 'mode'], v: { id: claudeId, kind: 'agent' } },
		{ kind: 2, k: ['requests'], v: [req('r2')] },
		{ kind: 2, k: ['requests'], v: [req('r3')] },
	]);
	const result = await analyzeSessionUsage(makeDeps(), 'chatSessions/s.jsonl', content);
	assert.deepEqual(result.agentUsage, { byAgent: { reviewer: { sessions: 1, requests: 2, source: 'claude' } } });
});

test('legacy VS Code .json session reads modeInfo per request', async () => {
	const content = JSON.stringify({ requests: [req('r1', customMode('Prep Release', '/c:/code/repo/.github/agents/prep-release.agent.md')), req('r2')] });
	const result = await analyzeSessionUsage(makeDeps(), 'chatSessions/s.json', content);
	assert.deepEqual(result.agentUsage, { byAgent: { 'Prep Release': { sessions: 1, requests: 1, source: 'github' } } });
});

test('sessions without a custom agent report no agentUsage', async () => {
	const content = jsonl([
		{ kind: 0, v: { requests: [], inputState: { mode: { id: 'agent', kind: 'agent' } } } },
		{ kind: 2, k: ['requests'], v: [req('r1', { kind: 'agent', isBuiltin: true, modeId: 'agent' })] },
	]);
	const result = await analyzeSessionUsage(makeDeps(), 'chatSessions/s.jsonl', content);
	assert.equal(result.agentUsage, undefined);
	assert.equal(createEmptySessionUsageAnalysis().agentUsage, undefined);
});

test('Copilot CLI: a top-level subagent.selected counts the turn, deselect stops it, real subagents are ignored', async () => {
	const content = jsonl([
		{ type: 'session.start', data: {} },
		// Selection lands after the message that started the turn.
		{ type: 'user.message', data: { content: 'a' } },
		{ type: 'assistant.turn_start', data: {} },
		{ type: 'subagent.selected', data: { agentName: 'repostatus', agentDisplayName: 'Repo Status', tools: [] } },
		{ type: 'assistant.turn_end', data: {} },
		// Still selected: next message counts without a new selected event.
		{ type: 'user.message', data: { content: 'b' } },
		{ type: 'assistant.turn_end', data: {} },
		{ type: 'subagent.deselected', data: {} },
		{ type: 'user.message', data: { content: 'c' } },
		{ type: 'assistant.turn_end', data: {} },
		// A subagent the model delegated to carries an agentId and is not a user selection.
		{ type: 'subagent.selected', agentId: 'abc', data: { agentName: 'explore', agentDisplayName: 'Explore Agent', tools: [] } },
		{ type: 'user.message', data: { content: 'd' } },
	]);
	const result = await analyzeSessionUsage(makeDeps(), 'session-state/x/events.jsonl', content);
	assert.deepEqual(result.agentUsage, { byAgent: { 'Repo Status': { sessions: 1, requests: 2, source: 'other' } } });
});

test('CLI agent state: a selection after the turn ended does not claim the previous message', () => {
	const analysis: { agentUsage?: AgentUsage } = {};
	const state = createCliAgentState();
	for (const event of [
		{ type: 'user.message' },
		{ type: 'assistant.turn_end' },
		{ type: 'subagent.selected', data: { agentName: 'Product Owner', agentDisplayName: 'Product Owner' } },
	]) { advanceCliAgentState(state, analysis, event); }
	assert.equal(analysis.agentUsage, undefined);
	advanceCliAgentState(state, analysis, { type: 'user.message' });
	assert.equal((analysis as { agentUsage?: AgentUsage }).agentUsage?.byAgent['Product Owner']?.requests, 1);
});

test('agent names cannot write to the prototype', async () => {
	const content = jsonl([
		{ kind: 0, v: { requests: [], inputState: { mode: { id: 'agent', kind: 'agent' } } } },
		{ kind: 2, k: ['requests'], v: [req('r1', customMode('__proto__', GITHUB_PATH))] },
	]);
	const result = await analyzeSessionUsage(makeDeps(), 'chatSessions/s.jsonl', content);
	assert.equal(result.agentUsage, undefined);
	assert.equal(({} as Record<string, unknown>).requests, undefined);
});

test('mergeAgentUsage sums per agent name and keeps agents with the same file name apart', () => {
	const period: { agentUsage?: AgentUsage } = {};
	mergeAgentUsage(period, undefined);
	assert.equal(period.agentUsage, undefined);
	mergeAgentUsage(period, { byAgent: { 'Product Owner': { sessions: 1, requests: 3, source: 'github' } } });
	mergeAgentUsage(period, { byAgent: {
		'Product Owner': { sessions: 1, requests: 2, source: 'github' },
		'Product Owner[Claude]': { sessions: 1, requests: 4, source: 'claude' },
	} });
	assert.deepEqual(period.agentUsage, { byAgent: {
		'Product Owner': { sessions: 2, requests: 5, source: 'github' },
		'Product Owner[Claude]': { sessions: 1, requests: 4, source: 'claude' },
	} });
});
