import test from 'node:test';
import * as assert from 'node:assert/strict';
import { createDiagnosticsPayload } from '../diagnosticsView';
import { DIAGNOSTICS_VIEW_KEYS } from '../../../src/diagnosticsViewBuilder';

test('diagnostics --json payload carries every field of the shared Diagnostics view payload', async () => {
	const payload = await createDiagnosticsPayload([], null, 'report', []) as unknown as Record<string, unknown>;
	for (const key of DIAGNOSTICS_VIEW_KEYS) {
		assert.ok(key in payload, `missing ${key}`);
	}
	assert.ok('diagnosticPaths' in payload);
	// VS Code-only state takes the builder's documented "not available in this host" values.
	assert.equal(payload.backendStorageInfo, null);
	assert.equal(payload.backendConfigured, false);
	assert.equal(payload.quotaEntitlements, null);
	assert.deepEqual(payload.accountBudgets, []);
	assert.equal(payload.skillCallsByEditor, null);
	assert.deepEqual(payload.detailedSessionFiles, []);
	assert.equal(payload.toolCallStats, null);
});
