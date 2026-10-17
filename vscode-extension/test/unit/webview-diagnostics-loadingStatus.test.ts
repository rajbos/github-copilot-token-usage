import test from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The Model Usage "Loading sessions…" indicator must stay prominent (it was a
// 12px muted-gray span users could barely see) and must vanish when idle.
const webviewDir = join(__dirname, '../../../../src/webview/diagnostics');
const mainSrc = readFileSync(join(webviewDir, 'main.ts'), 'utf8');
const css = readFileSync(join(webviewDir, 'styles.css'), 'utf8');

test('diagnostics: model-usage status span uses the loading-status pill class', () => {
	assert.match(mainSrc, /<span id="model-usage-status" class="loading-status" role="status" aria-live="polite">/);
	assert.doesNotMatch(mainSrc, /id="model-usage-status" style=/);
});

test('diagnostics: .loading-status is a bordered, bold pill in the link color', () => {
	const rule = /\.loading-status\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
	assert.match(rule, /font-weight:\s*600/);
	assert.match(rule, /color:\s*var\(--link-color\)/);
	assert.match(rule, /border:\s*1px solid var\(--link-color\)/);
	assert.match(rule, /border-radius:/);
});

test('diagnostics: .loading-status pulse is disabled for prefers-reduced-motion', () => {
	assert.match(css, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.loading-status\s*\{\s*animation:\s*none;?\s*\}\s*\}/);
});

test('diagnostics: .loading-status is hidden when empty so no empty pill shows after loading', () => {
	assert.match(css, /\.loading-status:empty\s*\{\s*display:\s*none;?\s*\}/);
});
