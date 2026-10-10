/**
 * Unit tests for buildClaudeChatTurns — the turn grouping shared by the
 * Claude Code and Claude Desktop (Cowork) adapters.
 */
import test from 'node:test';
import * as assert from 'node:assert/strict';

import { buildClaudeChatTurns, type ClaudeAssistantTurnData } from '../../../src/adapters/claudeTurns';

const user = (content: unknown, extra: Record<string, unknown> = {}) =>
	({ type: 'user', timestamp: '2026-01-01T10:00:00Z', message: { role: 'user', content }, ...extra });
const assistant = (text: string, stop_reason: string | null = 'end_turn') =>
	({ type: 'assistant', message: { role: 'assistant', stop_reason, text } });

/** Joins the fake assistant events' text so tests can see which events a turn received. */
const joinText = (events: any[]): ClaudeAssistantTurnData => ({
	assistantText: events.map(e => e.message.text).join('|'),
	model: null,
	actualInputTokens: 0,
	actualOutputTokens: 0,
	toolCalls: [],
	mcpTools: [],
});
const charCount = (text: string) => text.length;

test('buildClaudeChatTurns: returns no turns when there are no human user events', () => {
	let calls = 0;
	const turns = buildClaudeChatTurns([assistant('orphan')], evs => { calls++; return joinText(evs); }, charCount);
	assert.deepEqual(turns, []);
	assert.equal(calls, 0, 'assistant events are only processed once a user turn exists');
});

test('buildClaudeChatTurns: groups assistant events under the preceding user turn', () => {
	const turns = buildClaudeChatTurns([
		user('first'),
		assistant('a1'),
		assistant('a2'),
		user('second'),
		assistant('b1'),
	], joinText, charCount);

	assert.equal(turns.length, 2);
	assert.deepEqual(turns.map(t => t.turnNumber), [1, 2]);
	assert.deepEqual(turns.map(t => t.userMessage), ['first', 'second']);
	assert.deepEqual(turns.map(t => t.assistantResponse), ['a1|a2', 'b1']);
	assert.equal(turns[0].timestamp, '2026-01-01T10:00:00.000Z');
	assert.equal(turns[0].mode, 'agent');
});

test('buildClaudeChatTurns: skips sidechain, tool-result and non-final events', () => {
	const turns = buildClaudeChatTurns([
		user('real'),
		user('side', { isSidechain: true }),
		user([{ type: 'tool_result', content: 'x' }]),
		assistant('streaming', null),
		assistant('final'),
	], joinText, charCount);

	assert.equal(turns.length, 1);
	assert.equal(turns[0].userMessage, 'real');
	assert.equal(turns[0].assistantResponse, 'final');
});

test('buildClaudeChatTurns: joins text blocks of array content into the user message', () => {
	const turns = buildClaudeChatTurns([
		user([{ type: 'text', text: 'line one' }, { type: 'image' }, { type: 'text', text: 'line two' }]),
	], joinText, charCount);
	assert.equal(turns[0].userMessage, 'line one\nline two');
});

test('buildClaudeChatTurns: uses actual usage when present, else estimates with the default model', () => {
	const estimated = buildClaudeChatTurns([user('hello'), assistant('abc')], joinText, charCount)[0];
	assert.equal(estimated.model, 'claude-sonnet-4-6');
	assert.equal(estimated.inputTokensEstimate, 5);
	assert.equal(estimated.outputTokensEstimate, 3);
	assert.equal(estimated.actualUsage, undefined);

	const actual = buildClaudeChatTurns([user('hello'), assistant('abc')], evs => ({
		...joinText(evs), model: 'claude-opus-4-5', actualInputTokens: 120, actualOutputTokens: 40,
	}), charCount)[0];
	assert.equal(actual.model, 'claude-opus-4-5');
	assert.equal(actual.inputTokensEstimate, 120);
	assert.equal(actual.outputTokensEstimate, 40);
	assert.deepEqual(actual.actualUsage, { promptTokens: 120, completionTokens: 40 });
});
