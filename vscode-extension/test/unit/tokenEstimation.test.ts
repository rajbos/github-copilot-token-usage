import test from 'node:test';
import * as assert from 'node:assert/strict';

import { extractSubAgentData, normalizeDisplayModelName } from '../../src/tokenEstimation';

test('normalizeDisplayModelName: lowercases and replaces spaces with hyphens', () => {
	assert.equal(normalizeDisplayModelName('Claude Haiku 4.5'), 'claude-haiku-4.5');
	assert.equal(normalizeDisplayModelName('GPT 4 Turbo'), 'gpt-4-turbo');
	assert.equal(normalizeDisplayModelName('claude-sonnet-4'), 'claude-sonnet-4');
	assert.equal(normalizeDisplayModelName('  Gemini 2.5 Pro  '), 'gemini-2.5-pro');
});

test('extractSubAgentData: returns null for non-subagent items', () => {
	assert.equal(extractSubAgentData(null), null);
	assert.equal(extractSubAgentData(undefined), null);
	assert.equal(extractSubAgentData({ kind: 'markdownContent', value: 'hello' }), null);
	assert.equal(extractSubAgentData({ kind: 'toolInvocationSerialized', toolSpecificData: { kind: 'other' } }), null);
	assert.equal(extractSubAgentData({ kind: 'toolInvocationSerialized' }), null);
	assert.equal(extractSubAgentData({ kind: 'toolInvocationSerialized', toolSpecificData: {} }), null);
});

test('extractSubAgentData: extracts data from plain string result', () => {
	const item = {
		kind: 'toolInvocationSerialized',
		toolSpecificData: {
			kind: 'subagent',
			modelName: 'Claude Haiku 4.5',
			prompt: 'search for files',
			result: 'found 3 files',
		}
	};
	const data = extractSubAgentData(item);
	assert.ok(data, 'should return data');
	assert.equal(data.prompt, 'search for files');
	assert.equal(data.result, 'found 3 files');
	assert.equal(data.modelName, 'claude-haiku-4.5');
});

test('extractSubAgentData: decodes streaming char object result in correct order', () => {
	// Numeric keys in non-sequential order to verify sort
	const item = {
		kind: 'toolInvocationSerialized',
		toolSpecificData: {
			kind: 'subagent',
			modelName: 'Claude Haiku 4.5',
			prompt: 'go',
			result: { '2': 'l', '0': 'h', '1': 'e', '3': 'p' }
		}
	};
	const data = extractSubAgentData(item);
	assert.ok(data);
	assert.equal(data.result, 'help', 'should sort numerically: 0=h,1=e,2=l,3=p');
});

test('extractSubAgentData: returns null when both prompt and result are empty', () => {
	const item = {
		kind: 'toolInvocationSerialized',
		toolSpecificData: {
			kind: 'subagent',
			modelName: 'Claude Haiku 4.5',
			prompt: '',
			result: '',
		}
	};
	assert.equal(extractSubAgentData(item), null);
});

test('extractSubAgentData: handles missing modelName gracefully', () => {
	const item = {
		kind: 'toolInvocationSerialized',
		toolSpecificData: {
			kind: 'subagent',
			prompt: 'list files',
			result: 'file.ts',
		}
	};
	const data = extractSubAgentData(item);
	assert.ok(data);
	assert.equal(data.modelName, '', 'empty string when modelName is absent');
	assert.equal(data.prompt, 'list files');
	assert.equal(data.result, 'file.ts');
});
