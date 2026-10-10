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
import * as ts from 'typescript';
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

/**
 * Direct property names of the payload object a builder method returns — parsed with the
 * TypeScript AST so that keys of nested objects (or text inside strings) can never stand in
 * for a missing top-level field. The payload is the first object literal in the method's
 * return statement: `return { ... }` or `return JSON.stringify({ ... }).replace(...)`.
 */
function payloadKeys(source: string, methodName: string): Set<string> {
	const sourceFile = ts.createSourceFile('extension.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	let method: ts.MethodDeclaration | undefined;
	const findMethod = (node: ts.Node): void => {
		if (method) { return; }
		if (ts.isMethodDeclaration(node) && node.name.getText(sourceFile) === methodName) { method = node; return; }
		ts.forEachChild(node, findMethod);
	};
	findMethod(sourceFile);
	assert.ok(method?.body, `method ${methodName} not found`);

	let payload: ts.ObjectLiteralExpression | undefined;
	const findPayload = (node: ts.Node): void => {
		if (payload || ts.isFunctionLike(node)) { return; } // nested functions return other things
		if (ts.isReturnStatement(node) && node.expression) {
			const firstObject = (n: ts.Node): void => {
				if (payload) { return; }
				if (ts.isObjectLiteralExpression(n)) { payload = n; return; }
				ts.forEachChild(n, firstObject);
			};
			firstObject(node.expression);
			return;
		}
		ts.forEachChild(node, findPayload);
	};
	ts.forEachChild(method.body, findPayload);
	assert.ok(payload, `no returned object literal found in ${methodName}`);

	const keys = new Set<string>();
	for (const property of payload.properties) {
		if ((ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) && property.name) {
			keys.add(property.name.getText(sourceFile).replace(/^['"]|['"]$/g, ''));
		}
	}
	return keys;
}

test('payloadKeys only collects direct properties of the returned payload', () => {
	const fixture = `class C {
	private build(): object {
		const helper = { onlyNested: 1 };
		return {
			topLevel: 1,
			nested: { onlyNested: true, deeper: { alsoNested: 2 } },
			text: 'onlyInString: 3',
			shorthand,
			...spread,
		};
	}
}`;
	assert.deepEqual([...payloadKeys(fixture, 'build')].sort(), ['nested', 'shorthand', 'text', 'topLevel']);
});

test('the initial Usage Analysis payload carries every field the updateStats payload does', () => {
	// bootstrap() renders window.__INITIAL_USAGE__ without requesting fresh stats, so a field
	// only sent by updateStats leaves its section empty on open until the next refresh (this
	// is how Skill Suggestions went missing on a cold open with cached stats).
	const updateKeys = payloadKeys(EXTENSION_SRC, '_buildAnalysisUpdateData');
	const initialKeys = payloadKeys(EXTENSION_SRC, '_buildUsageAnalysisInitialData');
	assert.ok(updateKeys.has('repeatedTasks') && updateKeys.size >= 15, `key extraction looks broken: ${[...updateKeys].join(', ')}`);
	const missing = [...updateKeys].filter(key => !initialKeys.has(key));
	assert.deepEqual(missing, [], `_buildUsageAnalysisInitialData() is missing fields that updateStats sends: ${missing.join(', ')}`);
});
