import './vscode-shim-register';
import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';

import * as vscode from 'vscode';

import {
	buildBackendConfigClipboardPayload,
	copyBackendConfigToClipboard,
	getBackendConfigSummary
} from '../backend/copyConfig';

const baseSettings: any = {
	enabled: true,
	backend: 'storageTables',
	authMode: 'entraId',
	datasetId: 'default',
	sharingProfile: 'soloFull',
	shareWithTeam: false,
	shareWorkspaceMachineNames: false,
	shareConsentAt: '',
	userIdentityMode: 'pseudonymous',
	userId: 'dev-01',
	userIdMode: 'alias',
	subscriptionId: 'sub',
	resourceGroup: 'rg',
	storageAccount: 'sa',
	aggTable: 'usageAggDaily',
	eventsTable: 'usageEvents',
	rawContainer: 'raw-usage',
	lookbackDays: 30,
	includeMachineBreakdown: true
};
describe('backend/copyConfig', { concurrency: false }, () => {
	test('getBackendConfigSummary formats key fields and masks userId presence', () => {
		const summary = getBackendConfigSummary(baseSettings);
		assert.ok(summary.includes('Backend Configuration:'));
		assert.ok(summary.includes('Enabled: true'));
		assert.ok(summary.includes('User ID: [SET]'));
	});

	test('buildBackendConfigClipboardPayload redacts userId and fully redacts machineId', () => {
		const payload = buildBackendConfigClipboardPayload(baseSettings);
		assert.equal(payload.version, 1);
		assert.equal(payload.config.userId, '[REDACTED]');
		assert.equal(payload.machineId, '<redacted>', 'machineId should be fully redacted');
		assert.equal(payload.config.sharingProfile, 'soloFull', 'sharingProfile should be included');
		assert.ok(payload.note.includes('machineId'), 'note should mention machineId');
		assert.ok(payload.note.includes('sessionId'), 'note should mention sessionId');
		assert.ok(payload.note.includes('home directory'), 'note should mention home directory');
	});

	test('copyBackendConfigToClipboard writes JSON to clipboard and shows success message', async () => {
		(vscode as any).__mock.reset();
		const mock = (vscode as any).__mock;
		const ok = await copyBackendConfigToClipboard(baseSettings);
		assert.equal(ok, true);
		assert.ok(mock.state.clipboardText.includes('"version": 1'));
		assert.ok(mock.state.lastInfoMessages.some((m: string) => m.includes('copied to clipboard')));
	});

	test('copyBackendConfigToClipboard returns false when clipboard write fails', async () => {
		(vscode as any).__mock.reset();
		const mock = (vscode as any).__mock;
		mock.setClipboardThrow(true);
		const ok = await copyBackendConfigToClipboard(baseSettings);
		assert.equal(ok, false);
		assert.ok(mock.state.lastErrorMessages.some((m: string) => m.includes('Failed to copy config')));
	});
});
