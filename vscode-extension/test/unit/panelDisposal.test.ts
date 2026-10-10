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

/** WebviewPanel field names declared on the class. */
function findPanelFields(source: string): string[] {
	return [...source.matchAll(/^\s*private\s+(\w+)\??\s*(?::|\?:)\s*vscode\.WebviewPanel\b/gm)].map(m => m[1]);
}

/** Panel fields that are in the `panelsToDispose` list handed to disposePanels() inside dispose(). */
function findDisposedPanelFields(source: string): string[] {
	const start = source.indexOf('public dispose(): void {');
	assert.ok(start > 0, 'dispose() not found');
	const body = source.slice(start, source.indexOf('\n  }\n', start));
	const list = /const\s+panelsToDispose\s*=\s*\[([^\]]*)\]/.exec(body);
	assert.ok(list, 'dispose() must declare a panelsToDispose array');
	assert.match(body, /disposePanels\(\s*panelsToDispose\s*\)/, 'dispose() must pass panelsToDispose to disposePanels()');
	return [...list[1].matchAll(/this\.(\w+)/g)].map(m => m[1]);
}

test('extension.ts dispose() releases every vscode.WebviewPanel field', () => {
	const source = loadExtensionSource();
	const fields = findPanelFields(source);
	assert.ok(fields.length >= 11, `expected to find the panel fields, found: ${fields.join(', ')}`);
	const disposed = findDisposedPanelFields(source);
	const missing = fields.filter(f => !disposed.includes(f));
	assert.deepEqual(missing, [], `WebviewPanel fields not in panelsToDispose: ${missing.join(', ')}`);
});

test('panel guard: fails when a field is removed from panelsToDispose even if still mentioned elsewhere in dispose()', () => {
	const source = loadExtensionSource();
	const mutated = source
		.replace(/(const\s+panelsToDispose\s*=\s*\[[^\]]*?)this\.dashboardPanel,\s*/, '$1')
		.replace('this._disposed = true;', 'this.dashboardPanel = undefined; this._disposed = true;');
	assert.notEqual(mutated, source, 'mutation must change the source');
	const missing = findPanelFields(mutated).filter(f => !findDisposedPanelFields(mutated).includes(f));
	assert.deepEqual(missing, ['dashboardPanel']);
});
