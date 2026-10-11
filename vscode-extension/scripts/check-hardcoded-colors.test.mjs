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
	assert.equal(findColors('a { color: #FFF; b: #123456 }', { '#fff': null }).length, 1);
});

test('does not treat long hex-like words as colors', () => {
	assert.equal(findColors('a { content: "#abcdefg"; }').length, 0);
});

test('captures the complete functional color, so allowlisting one call does not allow others', () => {
	const css = 'a { color: rgba(1, 2, 3, 0.5); border-color: rgba(9, 9, 9, 0.5); x: rgba(var(--c), .2); }';
	assert.deepEqual(findColors(css), ['rgba(1, 2, 3, 0.5)', 'rgba(9, 9, 9, 0.5)', 'rgba(var(--c), .2)']);
	assert.deepEqual(findColors(css, { 'rgba(1,2,3,0.5)': null }).length, 2, 'whitespace-insensitive exact match');
	assert.equal(findColors(css, { 'rgba(': null }).length, 3, 'a bare function prefix allows nothing');
});

test('property-scoped allowlist entries only exempt those properties', () => {
	const allowed = { '#fff': ['color'] };
	assert.equal(findColors('a { color: #fff; }', allowed).length, 0);
	assert.equal(findColors('a { background: #fff; }', allowed).length, 1);
	assert.equal(findColors('a { background-color: #fff; border: 1px solid #fff; }', allowed).length, 2);
	assert.equal(findColors('a { x: 1 } b { color: #FFF }', allowed).length, 0);
});
