import test from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// main.ts is a webview entry point and cannot be imported under node, so the
// placement of the memory sections is asserted on the panel builders' source.
const SRC = readFileSync(join(__dirname, '../../../../src/webview/usage/main.ts'), 'utf8');

function functionBody(name: string): string {
	const start = SRC.indexOf(`function ${name}(`);
	assert.ok(start >= 0, `${name} not found`);
	const next = SRC.indexOf('\nfunction ', start + 1);
	return SRC.slice(start, next < 0 ? undefined : next);
}

test('memory sections render in the Workspace Health panel', () => {
	const health = functionBody('buildHealthTabPanelHtml');
	assert.ok(health.includes('buildMemorySectionsHtml('));
	assert.ok(health.indexOf('buildMemorySectionsHtml(') < health.indexOf('section-repo-hygiene'));
	const memory = functionBody('buildMemorySectionsHtml');
	assert.ok(memory.includes('buildMemoryFilesSectionHtml('));
	assert.ok(memory.includes('buildServerMemoriesSectionHtml('));
});

test('memory sections no longer render in the Tools panel', () => {
	const tools = functionBody('buildToolsTabPanelHtml');
	assert.ok(!tools.includes('buildMemorySectionsHtml('));
	assert.ok(!tools.includes('buildMemoryFilesSectionHtml('));
	assert.ok(!tools.includes('buildServerMemoriesSectionHtml('));
});
