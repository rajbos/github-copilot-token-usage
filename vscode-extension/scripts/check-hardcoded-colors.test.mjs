import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findColors } from './check-hardcoded-colors.mjs';

test('finds hex and color functions', () => {
	const css = 'a { color: #fff; background: #1e1e1e; border-color: rgba(0, 0, 0, .5); x: hsl(1 2% 3%); }';
	assert.equal(findColors(css).length, 4);
});

test('ignores comments, var() tokens and id selectors', () => {
	const css = '/* #abc rgb(1,2,3) */ #root { color: var(--vscode-foreground); }';
	assert.equal(findColors(css).length, 0);
});

test('skips allowlisted literals case-insensitively', () => {
	assert.equal(findColors('a { color: #FFF; b: #123456 }', ['#fff']).length, 1);
});

test('does not treat long hex-like words as colors', () => {
	assert.equal(findColors('a { content: "#abcdefg"; }').length, 0);
});
