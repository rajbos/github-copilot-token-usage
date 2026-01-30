import test from 'node:test';
import * as assert from 'node:assert/strict';

import { parseSessionFileContent } from '../sessionParser';

function estimateTokensByLength(text: string): number {
	return text.length;
}

test('delta-based JSONL: does not allow prototype pollution via delta path keys', () => {
	// Ensure clean baseline
	delete (Object.prototype as any).polluted;

	const filePath = 'C:/tmp/session.jsonl';
	const content = [
		JSON.stringify({ kind: 0, v: { requests: [] } }),
		JSON.stringify({ kind: 1, k: ['__proto__', 'polluted'], v: 'yes' })
	].join('\n');

	const result = parseSessionFileContent(filePath, content, estimateTokensByLength);
	assert.equal(result.tokens, 0);
	assert.equal(({} as any).polluted, undefined);
	assert.equal((Object.prototype as any).polluted, undefined);
});

test('delta-based JSONL: extracts per-request modelId and does not let callback override to default', () => {
	const filePath = 'C:/tmp/session.jsonl';
	const content = [
		JSON.stringify({ kind: 0, v: { requests: [] } }),
		JSON.stringify({
			kind: 2,
			k: ['requests'],
			v: [
				{
					modelId: 'copilot/claude-sonnet-4.5',
					message: { text: 'hi' },
					response: [{ kind: 'markdownContent', content: { value: 'hello' } }]
				}
			]
		})
	].join('\n');

	const result = parseSessionFileContent(
		filePath,
		content,
		estimateTokensByLength,
		// Simulate an unhelpful callback returning a default model
		() => 'gpt-4o'
	);

	assert.equal(result.interactions, 1);
	assert.ok(result.modelUsage['claude-sonnet-4.5']);
	assert.equal(result.modelUsage['claude-sonnet-4.5'].inputTokens, 2);
	assert.equal(result.modelUsage['claude-sonnet-4.5'].outputTokens, 5);
});

test('delta-based JSONL: response text prefers content.value over value to avoid double counting', () => {
	const filePath = 'C:/tmp/session.jsonl';
	const content = [
		JSON.stringify({ kind: 0, v: { requests: [] } }),
		JSON.stringify({
			kind: 2,
			k: ['requests'],
			v: [
				{
					modelId: 'copilot/gpt-5-mini',
					message: { text: 'x' },
					response: [{ kind: 'markdownContent', value: 'AAAA', content: { value: 'BB' } }]
				}
			]
		})
	].join('\n');

	const result = parseSessionFileContent(filePath, content, estimateTokensByLength);
	assert.ok(result.modelUsage['gpt-5-mini']);
	assert.equal(result.modelUsage['gpt-5-mini'].inputTokens, 1);
	// Should count only "BB" (2), not "AAAA" + "BB"
	assert.equal(result.modelUsage['gpt-5-mini'].outputTokens, 2);
});

test('non-delta .jsonl: parses JSON object content when file extension is .jsonl', () => {
	const filePath = 'C:/tmp/session.jsonl';
	const content = JSON.stringify({
		requests: [
			{ model: 'gpt-5-mini', message: { text: 'x' }, response: [{ value: 'y' }] }
		]
	});

	const result = parseSessionFileContent(filePath, content, estimateTokensByLength);
	assert.equal(result.interactions, 1);
	assert.ok(result.modelUsage['gpt-5-mini']);
	assert.equal(result.modelUsage['gpt-5-mini'].inputTokens, 1);
	assert.equal(result.modelUsage['gpt-5-mini'].outputTokens, 1);
});

// CR-002: Additional prototype pollution attack vector tests
test('delta-based JSONL: blocks prototype pollution via constructor path', () => {
	delete (Object.prototype as any).polluted;

	const filePath = 'C:/tmp/session.jsonl';
	const content = [
		JSON.stringify({ kind: 0, v: { requests: [] } }),
		JSON.stringify({ kind: 1, k: ['constructor', 'polluted'], v: 'yes' })
	].join('\n');

	const result = parseSessionFileContent(filePath, content, estimateTokensByLength);
	assert.equal(result.tokens, 0);
	assert.equal(({} as any).polluted, undefined);
	assert.equal((Object.prototype as any).polluted, undefined);
});

test('delta-based JSONL: blocks prototype pollution via hasOwnProperty path', () => {
	delete (Object.prototype as any).polluted;

	const filePath = 'C:/tmp/session.jsonl';
	const content = [
		JSON.stringify({ kind: 0, v: { requests: [] } }),
		JSON.stringify({ kind: 1, k: ['hasOwnProperty', 'polluted'], v: 'yes' })
	].join('\n');

	const result = parseSessionFileContent(filePath, content, estimateTokensByLength);
	assert.equal(result.tokens, 0);
	assert.equal(({} as any).polluted, undefined);
	assert.equal((Object.prototype as any).polluted, undefined);
});

test('delta-based JSONL: blocks prototype pollution via __-prefixed keys', () => {
	delete (Object.prototype as any).polluted;

	const filePath = 'C:/tmp/session.jsonl';
	const content = [
		JSON.stringify({ kind: 0, v: { requests: [] } }),
		JSON.stringify({ kind: 1, k: ['__secret__', 'polluted'], v: 'yes' })
	].join('\n');

	const result = parseSessionFileContent(filePath, content, estimateTokensByLength);
	assert.equal(result.tokens, 0);
	assert.equal(({} as any).polluted, undefined);
});

test('delta-based JSONL: blocks nested prototype pollution attempts', () => {
	delete (Object.prototype as any).polluted;

	const filePath = 'C:/tmp/session.jsonl';
	const content = [
		JSON.stringify({ kind: 0, v: { requests: [] } }),
		JSON.stringify({ kind: 1, k: ['requests', '__proto__', 'polluted'], v: 'yes' })
	].join('\n');

	const _ = parseSessionFileContent(filePath, content, estimateTokensByLength);
	assert.equal(({} as any).polluted, undefined);
	assert.equal((Object.prototype as any).polluted, undefined);
});

test('delta-based JSONL: blocks prototype pollution in array append operations', () => {
	delete (Object.prototype as any).polluted;

	const filePath = 'C:/tmp/session.jsonl';
	const content = [
		JSON.stringify({ kind: 0, v: { requests: [] } }),
		JSON.stringify({ kind: 2, k: ['__proto__'], v: [{ polluted: 'yes' }] })
	].join('\n');

	const result = parseSessionFileContent(filePath, content, estimateTokensByLength);
	assert.equal(({} as any).polluted, undefined);
	assert.equal((Object.prototype as any).polluted, undefined);
});
