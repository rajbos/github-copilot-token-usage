import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { countColors, findColors } from './check-hardcoded-colors.mjs';

test('finds hex and color functions', () => {
	const css = 'a { color: #fff; background: #1e1e1e; border-color: rgba(0, 0, 0, .5); x: hsl(1 2% 3%); }';
	assert.equal(findColors(css).length, 4);
});

test('ignores comments and var() tokens', () => {
	const css = '/* #abc rgb(1,2,3) */ #root { color: var(--vscode-foreground); }';
	assert.equal(findColors(css).length, 0);
});

test('hex-shaped ID selectors are not colors', () => {
	for (const css of ['#abc {}', '.item:has(#abcdef) { margin: 0 }', 'a#fff:hover { margin: 0 }', '#abc, #def123 > p { margin: 0 }',
		'@media (min-width: 600px) { #abc { margin: 0 } }', 'a { &:hover #abcdef { margin: 0 } }']) {
		assert.deepEqual(findColors(css), [], css);
	}
});

test('real colors in declaration values are found', () => {
	assert.deepEqual(findColors('a { color: #abc }'), ['#abc']);
	assert.deepEqual(findColors('a { background: linear-gradient(#fff, #000) }'), ['#fff', '#000']);
	assert.deepEqual(findColors(':root { --x: #abcdef; }'), ['#abcdef']);
	assert.deepEqual(findColors('@media (min-width: 600px) { #abc { color: #123456 } }'), ['#123456']);
	assert.deepEqual(findColors('a { border: 1px solid rgb(1 2 3 / 50%); color: var(--c, #abc) }'), ['rgb(1 2 3 / 50%)', '#abc']);
	assert.deepEqual(findColors('a { color: red;color:#fff }'), ['#fff'], 'no trailing semicolon');
});

test('url() contents and strings do not hide or invent colors', () => {
	assert.deepEqual(findColors(`a { fill: url(#abcdef); background: url("data:image/svg+xml;utf8,<svg fill='#fff'/>") }`), []);
	assert.deepEqual(findColors('a { content: "; color: #abc"; color: #def }'), ['#def']);
});

test('skips allowlisted literals case-insensitively', () => {
	assert.equal(findColors('a { color: #FFF; b: #123456 }', { '#fff': null }).length, 1);
});

test('does not treat long hex-like words as colors', () => {
	assert.equal(findColors('a { margin: #abcdefg; }').length, 0);
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
	assert.equal(findColors('#fff { color: #fff }', allowed).length, 0, 'selector text is not a hit');
});

test('the committed baseline is current: no file exceeds it, and the allowlisted theme.css is not counted', () => {
	const dir = path.dirname(fileURLToPath(import.meta.url));
	const baseline = JSON.parse(fs.readFileSync(path.join(dir, 'hardcoded-colors-baseline.json'), 'utf8')).counts;
	const counts = countColors();
	for (const [file, n] of Object.entries(counts)) {
		assert.ok(n <= (baseline[file] ?? 0), `${file}: ${n} > baseline ${baseline[file] ?? 0}`);
	}
	assert.ok(!Object.keys(counts).some((f) => f.endsWith('shared/theme.css')), 'theme.css defines the palette and is allowlisted');
	assert.ok(!Object.keys(baseline).some((f) => f.endsWith('shared/theme.css')));
});

test('function names and hex digits are matched case-insensitively', () => {
	assert.deepEqual(findColors('a { color: RGB(1 2 3); background: HsLa(20 30% 40% / .5); border-color: #ABCDEF }'),
		['RGB(1 2 3)', 'HsLa(20 30% 40% / .5)', '#ABCDEF']);
});

test('space-separated modern syntax and the other absolute color functions are colors', () => {
	assert.deepEqual(findColors('a { color: rgb(1 2 3 / 50%); b: hwb(200 10% 20%); c: oklch(60% 0.2 30); d: LAB(50 10 10) }'),
		['rgb(1 2 3 / 50%)', 'hwb(200 10% 20%)', 'oklch(60% 0.2 30)', 'LAB(50 10 10)']);
	assert.deepEqual(findColors('a { color: color-mix(in srgb, var(--x) 50%, transparent) }'), [], 'theme-derived mixes are fine');
});

test('allowlist matching ignores case and spacing, so uppercase uses of an allowed literal stay allowed', () => {
	const allowed = { '#fff': ['color'], 'rgba(1,2,3,0.5)': null };
	assert.deepEqual(findColors('a { color: #FFF; border-color: RGBA(1, 2, 3, 0.5) }', allowed), []);
	assert.deepEqual(findColors('a { background: #FFF }', allowed), ['#FFF']);
});
