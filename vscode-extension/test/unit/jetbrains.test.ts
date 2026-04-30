/**
 * Unit tests for the JetBrains IDE Copilot session parser
 * (src/jetbrains.ts).
 */
import test from 'node:test';
import * as assert from 'node:assert/strict';

import {
	parseJetBrainsPartition,
	detectJetBrainsModeFromContent,
	modelHintFromToolCallId,
} from '../../src/jetbrains';

const partitionCreated = (id = 'conv-1') => ({
	type: 'partition.created',
	data: { conversationId: id, partitionId: 1, source: 'panel', createdAt: 1777552130660 },
	timestamp: '2026-04-30T12:28:50.660Z',
});
const userMessage = (turnId: string, content: string, timestamp = '2026-04-30T12:28:50.713Z') => ({
	type: 'user.message', data: { content, turnId }, timestamp,
});
const userMessageRendered = (turnId: string, renderedMessage: string) => ({
	type: 'user.message_rendered', data: { turnId, renderedMessage }, timestamp: '2026-04-30T12:28:51.826Z',
});
const assistantMessage = (text: string, opts: { thinking?: string; timestamp?: string } = {}) => ({
	type: 'assistant.message',
	data: {
		text,
		messageId: 't1',
		iterationNumber: 1,
		...(opts.thinking ? { thinking: { id: 'th0', text: opts.thinking } } : {}),
	},
	timestamp: opts.timestamp ?? '2026-04-30T12:29:07.000Z',
});
const toolStart = (toolCallId = 'toolu_bdrk_xyz', toolName = 'read_file') => ({
	type: 'tool.execution_start',
	data: { toolCallId, toolName, arguments: {} },
	timestamp: '2026-04-30T12:28:55.802Z',
});
const toolComplete = (toolCallId = 'toolu_bdrk_xyz', text = 'tool result') => ({
	type: 'tool.execution_complete',
	data: { toolCallId, success: true, result: { result: [{ type: 'text', value: text }] } },
	timestamp: '2026-04-30T12:28:56.000Z',
});
const turnEnd = (timestamp = '2026-04-30T12:29:07.522Z') => ({
	type: 'assistant.turn_end', data: { turnId: 't1', status: 'success' }, timestamp,
});

const toJsonl = (events: any[]) => events.map(e => JSON.stringify(e)).join('\n') + '\n';

// ── modelHintFromToolCallId ────────────────────────────────────────────

test('modelHintFromToolCallId: maps Anthropic toolu_* prefix to claude', () => {
	assert.equal(modelHintFromToolCallId('toolu_01ABC'), 'claude');
	assert.equal(modelHintFromToolCallId('toolu_bdrk_01ABC'), 'claude');
});

test('modelHintFromToolCallId: maps OpenAI call_* prefix to gpt', () => {
	assert.equal(modelHintFromToolCallId('call_abc123'), 'gpt');
});

test('modelHintFromToolCallId: returns null for unknown prefixes', () => {
	assert.equal(modelHintFromToolCallId('xyz_123'), null);
	assert.equal(modelHintFromToolCallId(''), null);
	assert.equal(modelHintFromToolCallId(undefined), null);
});

// ── detectJetBrainsModeFromContent ──────────────────────────────────────

test('detectJetBrainsModeFromContent: presence of tool.execution_start ⇒ agent', () => {
	const content = toJsonl([
		partitionCreated(),
		userMessage('t1', 'hi'),
		toolStart(),
	]);
	assert.equal(detectJetBrainsModeFromContent(content), 'agent');
});

test('detectJetBrainsModeFromContent: no tool.execution_start ⇒ ask', () => {
	const content = toJsonl([
		partitionCreated(),
		userMessage('t1', 'hi'),
		assistantMessage('hello back'),
	]);
	assert.equal(detectJetBrainsModeFromContent(content), 'ask');
});

test('detectJetBrainsModeFromContent: ignores the substring inside tool result text', () => {
	// A tool result accidentally containing the literal "tool.execution_start" text
	// must NOT cause a false positive — only a real event with that type counts.
	const content = toJsonl([
		partitionCreated(),
		userMessage('t1', 'hi'),
		toolComplete('toolu_x', 'a doc that mentions tool.execution_start in prose'),
		assistantMessage('done'),
	]);
	assert.equal(detectJetBrainsModeFromContent(content), 'ask');
});

test('detectJetBrainsModeFromContent: skips malformed JSON lines', () => {
	const content = '{"type":"partition.created"}\nthis is not json\n{"type":"tool.execution_start","data":{}}\n';
	assert.equal(detectJetBrainsModeFromContent(content), 'agent');
});

// ── parseJetBrainsPartition ─────────────────────────────────────────────

test('parseJetBrainsPartition: empty content returns zeroed result', () => {
	const r = parseJetBrainsPartition('');
	assert.equal(r.tokens, 0);
	assert.equal(r.interactions, 0);
	assert.equal(r.thinkingTokens, 0);
	assert.equal(r.actualTokens, 0);
	assert.equal(r.mode, 'ask');
	assert.equal(r.modelHint, 'unknown');
	assert.deepEqual(r.modelUsage, {});
	assert.equal(r.firstInteraction, null);
	assert.equal(r.lastInteraction, null);
});

test('parseJetBrainsPartition: counts one user.message as one interaction', () => {
	const content = toJsonl([
		partitionCreated('conv-1'),
		userMessage('t1', 'hello'),
		assistantMessage('hi back'),
		turnEnd(),
	]);
	const r = parseJetBrainsPartition(content);
	assert.equal(r.interactions, 1);
	assert.equal(r.conversationId, 'conv-1');
	assert.equal(r.source, 'panel');
	assert.equal(r.firstInteraction, '2026-04-30T12:28:50.713Z');
	assert.equal(r.lastInteraction, '2026-04-30T12:29:07.522Z');
});

test('parseJetBrainsPartition: estimates tokens from rendered message + assistant text', () => {
	const content = toJsonl([
		partitionCreated(),
		userMessage('t1', 'hi'),
		userMessageRendered('t1', 'a long rendered prompt with extra context wrappers'),
		assistantMessage('a moderately long assistant response with words'),
		turnEnd(),
	]);
	const r = parseJetBrainsPartition(content);
	assert.ok(r.tokens > 0);
});

test('parseJetBrainsPartition: counts thinking tokens separately', () => {
	const content = toJsonl([
		partitionCreated(),
		userMessage('t1', 'hi'),
		assistantMessage('short reply', { thinking: 'a long internal chain of thought reasoning text' }),
	]);
	const r = parseJetBrainsPartition(content);
	assert.ok(r.thinkingTokens > 0);
});

test('parseJetBrainsPartition: agent mode when tool.execution_start present', () => {
	const content = toJsonl([
		partitionCreated(),
		userMessage('t1', 'do something'),
		toolStart('toolu_bdrk_xyz', 'read_file'),
		toolComplete('toolu_bdrk_xyz', 'result'),
		assistantMessage('done'),
	]);
	const r = parseJetBrainsPartition(content);
	assert.equal(r.mode, 'agent');
	// toolu_* prefix → claude attribution
	assert.equal(r.modelHint, 'claude');
	assert.ok(r.modelUsage['claude']);
	assert.ok(r.modelUsage['claude'].inputTokens >= 0);
	assert.ok(r.modelUsage['claude'].outputTokens > 0);
});

test('parseJetBrainsPartition: ask mode when no tools used', () => {
	const content = toJsonl([
		partitionCreated(),
		userMessage('t1', 'hi'),
		assistantMessage('hello'),
	]);
	const r = parseJetBrainsPartition(content);
	assert.equal(r.mode, 'ask');
});

test('parseJetBrainsPartition: actualTokens is always 0 (no API counts)', () => {
	const content = toJsonl([
		partitionCreated(),
		userMessage('t1', 'hi'),
		assistantMessage('long reply with many words'),
	]);
	const r = parseJetBrainsPartition(content);
	assert.equal(r.actualTokens, 0);
});

test('parseJetBrainsPartition: prefers explicit assistant.turn_start.data.model when present', () => {
	const content = toJsonl([
		partitionCreated(),
		userMessage('t1', 'hi'),
		{ type: 'assistant.turn_start', data: { turnId: 't1', model: 'gpt-5' }, timestamp: '2026-04-30T12:28:51.900Z' },
		toolStart('call_xyz'),
		assistantMessage('reply'),
	]);
	const r = parseJetBrainsPartition(content);
	// Explicit model wins over toolCallId heuristic
	assert.equal(r.modelHint, 'gpt-5');
});

test('parseJetBrainsPartition: skips malformed lines without throwing', () => {
	const content = '{"type":"partition.created","data":{}}\nnot json at all\n{"type":"user.message","data":{"content":"x","turnId":"t1"},"timestamp":"2026-04-30T12:00:00Z"}\n';
	const r = parseJetBrainsPartition(content);
	assert.equal(r.interactions, 1);
});

test('parseJetBrainsPartition: avoids double-counting user text when both message and rendered are present', () => {
	// When user.message_rendered exists for a turn, the bare user.message text
	// should not be re-counted on top — the rendered version subsumes it.
	const renderedOnly = toJsonl([
		partitionCreated(),
		userMessageRendered('t1', 'rendered prompt content'),
	]);
	const both = toJsonl([
		partitionCreated(),
		userMessage('t1', 'rendered prompt content'),
		userMessageRendered('t1', 'rendered prompt content'),
	]);
	const r1 = parseJetBrainsPartition(renderedOnly);
	const r2 = parseJetBrainsPartition(both);
	assert.equal(r1.tokens, r2.tokens, 'rendered+message should not double-count user input');
});
