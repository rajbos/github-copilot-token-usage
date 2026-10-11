import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { sanitizeCustomizationMatrix } from '../../src/webview/usage/customizationSanitizer';
import type { WorkspaceCustomizationMatrix } from '../../../src/types';

// ── Compile-time schema parity guarantee ────────────────────────────────────────
//
// customizationSanitizer.ts imports WorkspaceCustomizationMatrix directly from types.ts
// (the extension's canonical schema) and returns that exact type.  If anyone changes
// the type in types.ts, this file will fail to compile unless the sanitizer is updated
// to match — preventing the schema drift that caused issue #1332.
//
// The round-trip test below adds a runtime check: a valid WorkspaceCustomizationMatrix
// fed through sanitizeCustomizationMatrix must come out unchanged.

describe('sanitizeCustomizationMatrix', () => {
	test('returns undefined for null / non-object input', () => {
		assert.equal(sanitizeCustomizationMatrix(null), undefined);
		assert.equal(sanitizeCustomizationMatrix(undefined), undefined);
		assert.equal(sanitizeCustomizationMatrix('string'), undefined);
		assert.equal(sanitizeCustomizationMatrix(42), undefined);
	});

	test('returns empty matrix for empty-workspaces input', () => {
		const result = sanitizeCustomizationMatrix({
			customizationTypes: [],
			workspaces: [],
			totalWorkspaces: 0,
			workspacesWithIssues: 0,
		});
		assert.ok(result);
		assert.deepEqual(result.customizationTypes, []);
		assert.deepEqual(result.workspaces, []);
		assert.equal(result.totalWorkspaces, 0);
		assert.equal(result.workspacesWithIssues, 0);
	});

	test('preserves customizationTypes with id, icon, label', () => {
		const result = sanitizeCustomizationMatrix({
			customizationTypes: [
				{ id: 'copilot-instructions', icon: '📄', label: 'Copilot Instructions' },
				{ id: 'agents-md', icon: '🤖', label: 'Agents MD' },
			],
			workspaces: [],
			totalWorkspaces: 0,
			workspacesWithIssues: 0,
		});
		assert.ok(result);
		assert.equal(result.customizationTypes.length, 2);
		assert.deepEqual(result.customizationTypes[0], { id: 'copilot-instructions', icon: '📄', label: 'Copilot Instructions' });
		assert.deepEqual(result.customizationTypes[1], { id: 'agents-md', icon: '🤖', label: 'Agents MD' });
	});

	test('drops customizationType entries with missing id', () => {
		const result = sanitizeCustomizationMatrix({
			customizationTypes: [
				{ id: '', icon: '📄', label: 'No ID' },
				{ id: 'valid', icon: '✅', label: 'Valid' },
			],
			workspaces: [],
			totalWorkspaces: 0,
			workspacesWithIssues: 0,
		});
		assert.ok(result);
		assert.equal(result.customizationTypes.length, 1);
		assert.equal(result.customizationTypes[0].id, 'valid');
	});

	test('preserves workspace row fields with current schema', () => {
		const result = sanitizeCustomizationMatrix({
			customizationTypes: [{ id: 'copilot-instructions', icon: '📄', label: 'Copilot Instructions' }],
			workspaces: [
				{
					workspacePath: '/home/user/project',
					workspaceName: 'project',
					sessionCount: 5,
					interactionCount: 20,
					typeStatuses: {
						'copilot-instructions': '✅',
					},
				},
			],
			totalWorkspaces: 1,
			workspacesWithIssues: 0,
		});
		assert.ok(result);
		assert.equal(result.workspaces.length, 1);
		const ws = result.workspaces[0];
		assert.equal(ws.workspacePath, '/home/user/project');
		assert.equal(ws.workspaceName, 'project');
		assert.equal(ws.sessionCount, 5);
		assert.equal(ws.interactionCount, 20);
		assert.deepEqual(ws.typeStatuses, { 'copilot-instructions': '✅' });
	});

	test('sanitizes invalid typeStatuses values to ❌', () => {
		const result = sanitizeCustomizationMatrix({
			customizationTypes: [],
			workspaces: [
				{
					workspacePath: '/home/user/project',
					workspaceName: 'project',
					sessionCount: 1,
					interactionCount: 3,
					typeStatuses: {
						'copilot-instructions': '✅',   // valid
						'agents-md': '⚠️',              // valid
						'setup-steps': '❌',             // valid
						'unknown-field': 'invalid-value', // invalid → becomes ❌
						'another-bad': 42,                // invalid → becomes ❌
					},
				},
			],
			totalWorkspaces: 1,
			workspacesWithIssues: 0,
		});
		assert.ok(result);
		const ws = result.workspaces[0];
		assert.equal(ws.typeStatuses['copilot-instructions'], '✅');
		assert.equal(ws.typeStatuses['agents-md'], '⚠️');
		assert.equal(ws.typeStatuses['setup-steps'], '❌');
		assert.equal(ws.typeStatuses['unknown-field'], '❌');
		assert.equal(ws.typeStatuses['another-bad'], '❌');
	});

	test('handles workspace with missing typeStatuses gracefully', () => {
		const result = sanitizeCustomizationMatrix({
			customizationTypes: [],
			workspaces: [
				{
					workspacePath: '/home/user/project',
					workspaceName: 'project',
					sessionCount: 1,
					interactionCount: 1,
					// typeStatuses missing
				},
			],
			totalWorkspaces: 1,
			workspacesWithIssues: 0,
		});
		assert.ok(result);
		assert.deepEqual(result.workspaces[0].typeStatuses, {});
	});

	test('coerces numeric fields', () => {
		const result = sanitizeCustomizationMatrix({
			customizationTypes: [],
			workspaces: [
				{
					workspacePath: '',
					workspaceName: '',
					sessionCount: '7',    // string → number
					interactionCount: null, // null → 0
					typeStatuses: {},
				},
			],
			totalWorkspaces: '3',
			workspacesWithIssues: NaN,
		});
		assert.ok(result);
		assert.equal(result.workspaces[0].sessionCount, 7);
		assert.equal(result.workspaces[0].interactionCount, 0);
		assert.equal(result.totalWorkspaces, 3);
		assert.equal(result.workspacesWithIssues, 0);
	});

	test('filters out non-object workspace entries', () => {
		const result = sanitizeCustomizationMatrix({
			customizationTypes: [],
			workspaces: [null, 'invalid', 42, { workspacePath: '/valid', workspaceName: 'valid', sessionCount: 0, interactionCount: 0, typeStatuses: {} }],
			totalWorkspaces: 1,
			workspacesWithIssues: 0,
		});
		assert.ok(result);
		assert.equal(result.workspaces.length, 1);
		assert.equal(result.workspaces[0].workspaceName, 'valid');
	});

	test('handles missing customizationTypes gracefully', () => {
		const result = sanitizeCustomizationMatrix({
			// customizationTypes missing
			workspaces: [],
			totalWorkspaces: 0,
			workspacesWithIssues: 0,
		});
		assert.ok(result);
		assert.deepEqual(result.customizationTypes, []);
	});

	// ── Schema parity round-trip ──────────────────────────────────────────────────
	//
	// This test verifies that a correctly-shaped WorkspaceCustomizationMatrix (the
	// canonical type from types.ts that the extension sends) passes through
	// sanitizeCustomizationMatrix unchanged.  If the sanitizer's internal field
	// mapping ever drifts from the canonical type, deepEqual will catch it.
	test('round-trip: valid WorkspaceCustomizationMatrix passes through unchanged', () => {
		// This variable's type annotation is WorkspaceCustomizationMatrix from types.ts.
		// If that interface gains or removes fields the sanitizer doesn't handle, the
		// compile step will surface the mismatch before this test even runs.
		const canonical: WorkspaceCustomizationMatrix = {
			customizationTypes: [
				{ id: 'copilot-instructions', icon: '📄', label: 'Copilot Instructions' },
				{ id: 'agents-md', icon: '🤖', label: 'Agents MD' },
			],
			workspaces: [
				{
					workspacePath: '/home/user/project-a',
					workspaceName: 'project-a',
					sessionCount: 3,
					interactionCount: 12,
					typeStatuses: {
						'copilot-instructions': '✅',
						'agents-md': '❌',
					},
				},
				{
					workspacePath: '/home/user/project-b',
					workspaceName: 'project-b',
					sessionCount: 1,
					interactionCount: 4,
					typeStatuses: {
						'copilot-instructions': '⚠️',
						'agents-md': '✅',
					},
				},
			],
			totalWorkspaces: 2,
			workspacesWithIssues: 1,
		};

		const result = sanitizeCustomizationMatrix(canonical);
		assert.ok(result);
		assert.deepEqual(result, canonical);
	});
});

describe('sanitizeCustomizationMatrix: workspace grouping fields', () => {
	test('keeps string memberPaths and ungroupedWorkspaceNames, drops non-strings', () => {
		const result = sanitizeCustomizationMatrix({
			customizationTypes: [],
			workspaces: [{
				workspacePath: '/code/repo', workspaceName: 'repo', sessionCount: 2, interactionCount: 3, typeStatuses: {},
				memberPaths: ['/code/repo', 42, '/wt/repo-wt'],
			}],
			totalWorkspaces: 1,
			workspacesWithIssues: 0,
			ungroupedWorkspaceNames: ['repo-85ed99', { bad: true }],
		});
		assert.deepEqual(result?.workspaces[0].memberPaths, ['/code/repo', '/wt/repo-wt']);
		assert.deepEqual(result?.ungroupedWorkspaceNames, ['repo-85ed99']);
	});

	test('omits the fields when absent, empty or not arrays', () => {
		const result = sanitizeCustomizationMatrix({
			customizationTypes: [],
			workspaces: [{ workspacePath: '/a', workspaceName: 'a', sessionCount: 1, interactionCount: 1, typeStatuses: {}, memberPaths: 'nope' }],
			totalWorkspaces: 1,
			workspacesWithIssues: 0,
			ungroupedWorkspaceNames: [],
		});
		assert.equal('memberPaths' in result!.workspaces[0], false);
		assert.equal('ungroupedWorkspaceNames' in result!, false);
	});
});
