import test from 'node:test';
import * as assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// A stylesheet with an unclosed rule does not fail the build: the browser just folds every
// rule after it into the open block and drops it, so whole sections lose their styling and
// only a screenshot shows it. A conflict resolution that loses one `}` does exactly that.
const webviewDir = join(__dirname, '../../../../src/webview');

function stylesheets(dir: string): string[] {
	return readdirSync(dir).flatMap(name => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) { return stylesheets(path); }
		return name.endsWith('.css') ? [path] : [];
	});
}

/** First position where the braces stop balancing, ignoring comments and quoted strings; -1 when balanced. */
function firstImbalance(css: string): number {
	let depth = 0;
	for (let i = 0; i < css.length; i++) {
		const ch = css[i];
		if (ch === '/' && css[i + 1] === '*') {
			const end = css.indexOf('*/', i + 2);
			if (end === -1) { return i; }
			i = end + 1;
		} else if (ch === '"' || ch === '\'') {
			const end = css.indexOf(ch, i + 1);
			if (end === -1) { return i; }
			i = end;
		} else if (ch === '{') {
			depth++;
		} else if (ch === '}') {
			depth--;
			if (depth < 0) { return i; }
		}
	}
	return depth === 0 ? -1 : css.length;
}

test('webview stylesheets: every rule is closed', () => {
	const files = stylesheets(webviewDir);
	assert.ok(files.length > 5, `expected the webview stylesheets, found ${files.length}`);
	for (const file of files) {
		const css = readFileSync(file, 'utf8');
		const at = firstImbalance(css);
		const line = at === -1 ? 0 : css.slice(0, at).split('\n').length;
		assert.equal(at, -1, `${relative(webviewDir, file)}: braces stop balancing near line ${line}`);
	}
});

test('webview stylesheets: the check catches a rule left open', () => {
	assert.equal(firstImbalance('.a { color: red; }\n/* } */ .b { content: "}"; }'), -1);
	assert.notEqual(firstImbalance('.a { color: red;\n.b { color: blue; }'), -1);
	assert.notEqual(firstImbalance('.a { color: red; } }'), -1);
});
