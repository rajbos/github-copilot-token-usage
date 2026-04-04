import test from 'node:test';
import * as assert from 'node:assert/strict';

import { escapeHtml, escapeAttr, safeJsonForInlineScript } from '../../src/utils/html';

// ── escapeHtml ──────────────────────────────────────────────────────────

test('escapeHtml: escapes all five HTML-special characters', () => {
	assert.equal(escapeHtml('<b>"Tom & Jerry\'s"</b>'), '&lt;b&gt;&quot;Tom &amp; Jerry&#39;s&quot;&lt;/b&gt;');
});

test('escapeHtml: returns empty string for null / undefined', () => {
	assert.equal(escapeHtml(null), '');
	assert.equal(escapeHtml(undefined), '');
});

test('escapeHtml: coerces non-string values', () => {
	assert.equal(escapeHtml(42), '42');
	assert.equal(escapeHtml(true), 'true');
	assert.equal(escapeHtml(0), '0');
});

test('escapeHtml: neutralises a script injection attempt', () => {
	const attack = '<script>alert("xss")</script>';
	const escaped = escapeHtml(attack);
	assert.ok(!escaped.includes('<script'));
	assert.ok(!escaped.includes('</script'));
	assert.equal(escaped, '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
});

test('escapeHtml: leaves safe text unchanged', () => {
	assert.equal(escapeHtml('hello world 123'), 'hello world 123');
});

// ── escapeAttr ──────────────────────────────────────────────────────────

test('escapeAttr: escapes the same characters as escapeHtml', () => {
	const input = 'a"b\'c<d>e&f';
	assert.equal(escapeAttr(input), escapeHtml(input));
});

// ── safeJsonForInlineScript ─────────────────────────────────────────────

test('safeJsonForInlineScript: escapes </script> inside a string value', () => {
	const result = safeJsonForInlineScript({ html: '</script><script>alert(1)</script>' });
	assert.ok(!result.includes('</script>'));
	assert.ok(result.includes('\\u003c'));
});

test('safeJsonForInlineScript: escapes angle brackets and ampersands', () => {
	const result = safeJsonForInlineScript({ a: '<b>&c' });
	assert.ok(!result.includes('<'));
	assert.ok(!result.includes('>'));
	assert.ok(!result.includes('&'));
});

test('safeJsonForInlineScript: escapes unicode line/paragraph separators', () => {
	const result = safeJsonForInlineScript({ text: 'line\u2028para\u2029' });
	// The replacement keeps the same literal escape string (\\u2028 / \\u2029)
	// but ensures the raw codepoint is not present.
	assert.ok(!result.includes('\u2028'));
	assert.ok(!result.includes('\u2029'));
});

test('safeJsonForInlineScript: handles null, numbers, arrays', () => {
	assert.equal(safeJsonForInlineScript(null), 'null');
	assert.equal(safeJsonForInlineScript(123), '123');
	const arr = safeJsonForInlineScript([1, 2]);
	assert.equal(arr, '[1,2]');
});
