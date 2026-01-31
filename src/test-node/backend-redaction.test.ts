import './vscode-shim-register';
import test from 'node:test';
import * as assert from 'node:assert/strict';

import { buildBackendConfigClipboardPayload } from '../backend/copyConfig';
import type { BackendSettings } from '../backend/settings';

test('config export fully redacts machineId', () => {
	const settings: BackendSettings = {
		enabled: true,
		backend: 'storageTables',
		authMode: 'entraId',
		datasetId: 'test-dataset',
		sharingProfile: 'teamAnonymized',
		shareWithTeam: false,
		shareWorkspaceMachineNames: false,
		shareConsentAt: '2026-01-20T00:00:00Z',
		userIdentityMode: 'pseudonymous',
		userId: 'test-user',
		userIdMode: 'alias',
		subscriptionId: 'sub-123',
		resourceGroup: 'rg-test',
		storageAccount: 'sa-test',
		aggTable: 'agg',
		eventsTable: 'events',
		lookbackDays: 30,
		includeMachineBreakdown: true
	};

	const payload = buildBackendConfigClipboardPayload(settings);

	assert.equal(payload.machineId, '<redacted>', 'machineId should be fully redacted');
	assert.equal(payload.config.userId, '[REDACTED]', 'userId should be redacted');
	assert.equal(payload.config.shareConsentAt, '[REDACTED_TIMESTAMP]', 'shareConsentAt should be redacted');
});

test('config export includes sharingProfile', () => {
	const settings: BackendSettings = {
		enabled: true,
		backend: 'storageTables',
		authMode: 'entraId',
		datasetId: 'test-dataset',
		sharingProfile: 'teamPseudonymous',
		shareWithTeam: true,
		shareWorkspaceMachineNames: false,
		shareConsentAt: '',
		userIdentityMode: 'pseudonymous',
		userId: '',
		userIdMode: 'alias',
		subscriptionId: 'sub-123',
		resourceGroup: 'rg-test',
		storageAccount: 'sa-test',
		aggTable: 'agg',
		eventsTable: 'events',
		lookbackDays: 30,
		includeMachineBreakdown: true
	};

	const payload = buildBackendConfigClipboardPayload(settings);

	assert.equal(payload.config.sharingProfile, 'teamPseudonymous');
	assert.equal(payload.config.shareWithTeam, true);
	assert.equal(payload.config.shareWorkspaceMachineNames, false);
});

test('config export JSON string does not contain full machineId or sessionId', () => {
	const settings: BackendSettings = {
		enabled: true,
		backend: 'storageTables',
		authMode: 'entraId',
		datasetId: 'test-dataset',
		sharingProfile: 'soloFull',
		shareWithTeam: false,
		shareWorkspaceMachineNames: true,
		shareConsentAt: '',
		userIdentityMode: 'pseudonymous',
		userId: 'test-user-123',
		userIdMode: 'alias',
		subscriptionId: 'sub-123',
		resourceGroup: 'rg-test',
		storageAccount: 'sa-test',
		aggTable: 'agg',
		eventsTable: 'events',
		lookbackDays: 30,
		includeMachineBreakdown: true
	};

	const payload = buildBackendConfigClipboardPayload(settings);
	const json = JSON.stringify(payload, null, 2);

	// Ensure no sensitive patterns leak in JSON
	// The field name "machineId" is OK, but the value should be redacted
	assert.ok(json.includes('"machineId": "<redacted>"'), 'JSON should contain redacted machineId');
	// Check that 'sessionId' doesn't appear as a field key (but it's OK in the note text)
	assert.ok(!/"sessionId"\s*:/.test(json), 'JSON should not contain sessionId field (as key)');
	assert.ok(json.includes('<redacted>'), 'JSON should include redacted placeholder');
	assert.ok(json.includes('[REDACTED]'), 'JSON should include redacted userId');
	
	// Verify no actual sensitive values leak (mock machineId would be a hex string)
	// If vscode.env.machineId were leaked, it would be a 64-char hex string
	const hexPattern = /[0-9a-f]{32,}/i;
	assert.ok(!hexPattern.test(json), 'JSON should not contain long hex strings (potential machineId leak)');
});

test('config export note mentions no secrets or PII', () => {
	const settings: BackendSettings = {
		enabled: true,
		backend: 'storageTables',
		authMode: 'sharedKey',
		datasetId: 'test-dataset',
		sharingProfile: 'off',
		shareWithTeam: false,
		shareWorkspaceMachineNames: false,
		shareConsentAt: '',
		userIdentityMode: 'pseudonymous',
		userId: '',
		userIdMode: 'alias',
		subscriptionId: 'sub-123',
		resourceGroup: 'rg-test',
		storageAccount: 'sa-test',
		aggTable: 'agg',
		eventsTable: 'events',
		lookbackDays: 30,
		includeMachineBreakdown: true
	};

	const payload = buildBackendConfigClipboardPayload(settings);

	assert.ok(payload.note.includes('NOT include secrets'));
	assert.ok(payload.note.includes('machineId'));
	assert.ok(payload.note.includes('sessionId'));
	assert.ok(payload.note.includes('home directory'));
});
