import './vscode-shim-register';
import test from 'node:test';
import * as assert from 'node:assert/strict';

import * as vscode from 'vscode';

import { getBackendSettings, isBackendConfigured, shouldPromptToSetSharedKey } from '../backend/settings';

test('shouldPromptToSetSharedKey gates on authMode/storageAccount/sharedKey presence', () => {
	assert.equal(shouldPromptToSetSharedKey('entraId', 'acct', undefined), false);
	assert.equal(shouldPromptToSetSharedKey('sharedKey', '', undefined), false);
	assert.equal(shouldPromptToSetSharedKey('sharedKey', '   ', undefined), false);
	assert.equal(shouldPromptToSetSharedKey('sharedKey', 'acct', undefined), true);
	assert.equal(shouldPromptToSetSharedKey('sharedKey', 'acct', '   '), true);
	assert.equal(shouldPromptToSetSharedKey('sharedKey', 'acct', 'key'), false);
});

test('getBackendSettings reads config defaults and clamps lookbackDays', () => {
	(vscode as any).__mock.reset();
	(vscode as any).__mock.setConfig({
		'copilotTokenTracker.backend.enabled': true,
		'copilotTokenTracker.backend.backend': 'storageTables',
		'copilotTokenTracker.backend.authMode': 'entraId',
		'copilotTokenTracker.backend.datasetId': '  myds  ',
		'copilotTokenTracker.backend.shareWithTeam': false,
		'copilotTokenTracker.backend.shareWorkspaceMachineNames': false,
		'copilotTokenTracker.backend.shareConsentAt': '',
		'copilotTokenTracker.backend.userIdentityMode': 'pseudonymous',
		'copilotTokenTracker.backend.userId': '  ',
		'copilotTokenTracker.backend.userIdMode': 'alias',
		'copilotTokenTracker.backend.subscriptionId': 'sub',
		'copilotTokenTracker.backend.resourceGroup': 'rg',
		'copilotTokenTracker.backend.storageAccount': 'sa',
		'copilotTokenTracker.backend.aggTable': 'agg',
		'copilotTokenTracker.backend.eventsTable': 'events',
		'copilotTokenTracker.backend.lookbackDays': 999,
		'copilotTokenTracker.backend.includeMachineBreakdown': true
	});

	const s = getBackendSettings();
	assert.equal(s.enabled, true);
	assert.equal(s.datasetId, 'myds');
	assert.equal(s.userId, '');
	assert.equal(s.sharingProfile, 'teamAnonymized');
	assert.equal(s.shareWorkspaceMachineNames, false);
	assert.equal(s.lookbackDays, 90);
});

test('isBackendConfigured checks required fields', () => {
	assert.equal(
		isBackendConfigured({
			enabled: true,
			backend: 'storageTables',
			authMode: 'entraId',
			datasetId: 'default',
			sharingProfile: 'off',
			shareWithTeam: false,
			shareWorkspaceMachineNames: false,
			shareConsentAt: '',
			userIdentityMode: 'pseudonymous',
			userId: '',
			userIdMode: 'alias',
			subscriptionId: 'sub',
			resourceGroup: 'rg',
			storageAccount: 'sa',
			aggTable: 'agg',
			eventsTable: 'events',
			lookbackDays: 30,
			includeMachineBreakdown: true
		}),
		true
	);

	assert.equal(
		isBackendConfigured({
			enabled: true,
			backend: 'storageTables',
			authMode: 'entraId',
			datasetId: 'default',
			sharingProfile: 'off',
			shareWithTeam: false,
			shareWorkspaceMachineNames: false,
			shareConsentAt: '',
			userIdentityMode: 'pseudonymous',
			userId: '',
			userIdMode: 'alias',
			subscriptionId: '',
			resourceGroup: 'rg',
			storageAccount: 'sa',
			aggTable: 'agg',
			eventsTable: 'events',
			lookbackDays: 30,
			includeMachineBreakdown: true
		}),
		false
	);
});
