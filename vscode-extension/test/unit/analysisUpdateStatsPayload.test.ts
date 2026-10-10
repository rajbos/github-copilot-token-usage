/**
 * Regression guard for the bug fixed in PR #1934: the Usage Analysis webview's
 * Corrections tab (and Skill Suggestions / curation sections) went blank on every
 * periodic silent refresh while an insight card kept reporting accurate correction
 * counts. The root cause was `updateAnalysisPanelIfOpen()` hand-rolling its own
 * partial `updateStats` payload for the silent refresh path instead of reusing the
 * shared `_buildAnalysisUpdateData()` builder used by the other two call sites —
 * so it silently dropped `correctionReport`, `repeatedTasks`, `curationAnalysis`,
 * etc. The webview does a full replace on every `updateStats` message, so any
 * field missing from *any* call site's payload blanks that section for anyone
 * with the panel already open.
 *
 * This isn't a runtime test (instantiating `CopilotTokenTracker` requires a full
 * VS Code host and file-system session discovery), so instead it asserts a
 * structural invariant directly on the source: every `analysisPanel` `updateStats`
 * postMessage call must build its `data` via `this._buildAnalysisUpdateData(...)`,
 * and that builder itself must still include the fields the webview renders.
 * A future change that reintroduces an ad-hoc payload object (or drops a field
 * from the shared builder) fails this test immediately, without needing to click
 * through the webview to notice a tab went empty.
 */
import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { extractBracesBlock } from './sourceStructureTestHelpers';

// Compiled test output lives under out/vscode-extension/test/unit (tsconfig.tests.json's
// rootDir is the repo root), so __dirname does not sit next to the real source tree —
// walk back up to the vscode-extension package root, then down into src/.
const EXTENSION_SRC_PATH = path.join(__dirname, '../../../../src/extension.ts');
const EXTENSION_SRC = fs.readFileSync(EXTENSION_SRC_PATH, 'utf8');

/** Find every balanced `marker(...)` call in `source` (marker must end with '('). */
function findAllBalancedCalls(source: string, marker: string): string[] {
	const calls: string[] = [];
	let searchFrom = 0;
	for (;;) {
		const markerIndex = source.indexOf(marker, searchFrom);
		if (markerIndex === -1) { break; }
		const openParenIndex = markerIndex + marker.length - 1;
		let depth = 0;
		let closeIndex = -1;
		for (let i = openParenIndex; i < source.length; i++) {
			if (source[i] === '(') { depth++; }
			else if (source[i] === ')') {
				depth--;
				if (depth === 0) { closeIndex = i; break; }
			}
		}
		assert.notEqual(closeIndex, -1, `unbalanced parens while scanning for marker: ${marker}`);
		calls.push(source.slice(markerIndex, closeIndex + 1));
		searchFrom = closeIndex + 1;
	}
	return calls;
}

test('_buildAnalysisUpdateData still includes every field the Usage Analysis webview renders', () => {
	const body = extractBracesBlock(EXTENSION_SRC, 'private _buildAnalysisUpdateData(');
	const requiredFields = [
		'today:', 'last30Days:', 'month:', 'lastMonth:',
		'insights:', 'correctionReport:', 'repeatedTasks:', 'curationAnalysis:', 'memoryFilesAnalysis:',
	];
	for (const field of requiredFields) {
		assert.ok(body.includes(field), `_buildAnalysisUpdateData() is missing '${field}' — the webview will blank the section that reads it`);
	}
});

test('every analysisPanel "updateStats" postMessage reuses _buildAnalysisUpdateData (no ad-hoc payloads that can drift out of sync)', () => {
	const postMessageCalls = findAllBalancedCalls(EXTENSION_SRC, 'this.analysisPanel.webview.postMessage(');
	const updateStatsCalls = postMessageCalls.filter(call => /command:\s*['"]updateStats['"]/.test(call));

	// Sanity check the extraction itself found the call sites we expect (today: silent
	// refresh, settings-change refresh, and initial background load) — if this count
	// ever drops to 0 the regex/marker above has silently stopped matching and the
	// assertions below would vacuously pass.
	assert.ok(updateStatsCalls.length >= 2, `expected at least 2 analysisPanel updateStats call sites, found ${updateStatsCalls.length}`);

	for (const call of updateStatsCalls) {
		assert.ok(
			/data:\s*this\._buildAnalysisUpdateData\(/.test(call),
			`Found an analysisPanel 'updateStats' postMessage that does not build its data via this._buildAnalysisUpdateData(...):\n${call}`
		);
	}
});
