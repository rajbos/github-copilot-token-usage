import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { disposePanels } from '../../src/panelDisposal';

function fakePanel(onDispose?: () => void) {
	return { disposed: 0, dispose() { this.disposed++; onDispose?.(); } };
}

test('disposePanels: disposes every defined panel and skips undefined ones', () => {
	const a = fakePanel();
	const b = fakePanel();
	disposePanels([a, undefined, b]);
	assert.equal(a.disposed, 1);
	assert.equal(b.disposed, 1);
});

test('disposePanels: a throwing panel does not stop the rest, and the error is rethrown', () => {
	const bad = fakePanel(() => { throw new Error('boom'); });
	const good = fakePanel();
	assert.throws(() => disposePanels([bad, good]), /boom/);
	assert.equal(good.disposed, 1);
});

// ---------------------------------------------------------------------------
// Source guard: every WebviewPanel field on the extension class must be released by dispose().
// ---------------------------------------------------------------------------

function loadExtensionSource(): string {
	// Compiled tests live in out/vscode-extension/test/unit; resolve from the package root either way.
	const candidates = [
		path.resolve(__dirname, '../../../../src/extension.ts'),
		path.resolve(__dirname, '../../src/extension.ts'),
	];
	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) { return fs.readFileSync(candidate, 'utf8'); }
	}
	throw new Error(`extension.ts not found; tried ${candidates.join(', ')}`);
}

test('extension.ts dispose() releases every vscode.WebviewPanel field', () => {
	const source = loadExtensionSource();
	const fields = [...source.matchAll(/^\s*private\s+(\w+)\??\s*(?::\s*vscode\.WebviewPanel\b|\?:\s*vscode\.WebviewPanel\b)/gm)]
		.map(m => m[1]);
	assert.ok(fields.length >= 11, `expected to find the panel fields, found: ${fields.join(', ')}`);

	const start = source.indexOf('public dispose(): void {');
	assert.ok(start > 0, 'dispose() not found');
	const end = source.indexOf('\n  }\n', start);
	const body = source.slice(start, end);
	assert.match(body, /disposePanels\(/, 'dispose() must call disposePanels()');

	const missing = fields.filter(f => !new RegExp(`this\\.${f}\\b`).test(body));
	assert.deepEqual(missing, [], `WebviewPanel fields not disposed in dispose(): ${missing.join(', ')}`);
});
