import './vscode-shim-register';
import test from 'node:test';
import * as assert from 'node:assert/strict';

import * as vscode from 'vscode';

import { getBackendSettings, isBackendConfigured, shouldPromptToSetSharedKey } from '../../src/backend/settings';

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
		'aiEngineeringFluency.backend.enabled': true,
		'aiEngineeringFluency.backend.backend': 'storageTables',
		'aiEngineeringFluency.backend.authMode': 'entraId',
		'aiEngineeringFluency.backend.datasetId': '  myds  ',
		'aiEngineeringFluency.backend.shareWithTeam': false,
		'aiEngineeringFluency.backend.shareWorkspaceMachineNames': false,
		'aiEngineeringFluency.backend.shareConsentAt': '',
		'aiEngineeringFluency.backend.userIdentityMode': 'pseudonymous',
		'aiEngineeringFluency.backend.userId': '  ',
		'aiEngineeringFluency.backend.userIdMode': 'alias',
		'aiEngineeringFluency.backend.subscriptionId': 'sub',
		'aiEngineeringFluency.backend.resourceGroup': 'rg',
		'aiEngineeringFluency.backend.storageAccount': 'sa',
		'aiEngineeringFluency.backend.aggTable': 'agg',
		'aiEngineeringFluency.backend.eventsTable': 'events',
		'aiEngineeringFluency.backend.lookbackDays': 999,
		'aiEngineeringFluency.backend.includeMachineBreakdown': true
	});

	const s = getBackendSettings();
	assert.equal(s.enabled, true);
	assert.equal(s.datasetId, 'myds');
	assert.equal(s.userId, '');
	assert.equal(s.sharingProfile, 'teamAnonymized');
	assert.equal(s.shareWorkspaceMachineNames, false);
	assert.equal(s.lookbackDays, 90);
});

test('getBackendSettings sharingProfile is off when backend disabled', () => {
	(vscode as any).__mock.reset();
	(vscode as any).__mock.setConfig({
		'aiEngineeringFluency.backend.enabled': false,
		'aiEngineeringFluency.backend.shareWithTeam': true,
		'aiEngineeringFluency.backend.userIdentityMode': 'alias',
	});
	const s = getBackendSettings();
	assert.equal(s.sharingProfile, 'off');
});

test('getBackendSettings sharingProfile is teamIdentified when shareWithTeam and non-pseudonymous', () => {
	(vscode as any).__mock.reset();
	(vscode as any).__mock.setConfig({
		'aiEngineeringFluency.backend.enabled': true,
		'aiEngineeringFluency.backend.shareWithTeam': true,
		'aiEngineeringFluency.backend.userIdentityMode': 'alias',
	});
	const s = getBackendSettings();
	assert.equal(s.sharingProfile, 'teamIdentified');
});

test('getBackendSettings sharingProfile is teamPseudonymous when shareWithTeam and pseudonymous', () => {
	(vscode as any).__mock.reset();
	(vscode as any).__mock.setConfig({
		'aiEngineeringFluency.backend.enabled': true,
		'aiEngineeringFluency.backend.shareWithTeam': true,
		'aiEngineeringFluency.backend.userIdentityMode': 'pseudonymous',
	});
	const s = getBackendSettings();
	assert.equal(s.sharingProfile, 'teamPseudonymous');
});

test('getBackendSettings clamps lookbackDays to minimum', () => {
	(vscode as any).__mock.reset();
	(vscode as any).__mock.setConfig({
		'aiEngineeringFluency.backend.lookbackDays': 0,
	});
	const s = getBackendSettings();
	assert.ok(s.lookbackDays >= 1);
});

test('getBackendSettings defaults empty datasetId to "default"', () => {
	(vscode as any).__mock.reset();
	(vscode as any).__mock.setConfig({
		'aiEngineeringFluency.backend.datasetId': '   ',
	});
	const s = getBackendSettings();
	assert.equal(s.datasetId, 'default');
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
			includeMachineBreakdown: true,
	blobUploadEnabled: false,
	blobContainerName: "copilot-session-logs",
	blobUploadFrequencyHours: 24,
	blobCompressFiles: true
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
			includeMachineBreakdown: true,
	blobUploadEnabled: false,
	blobContainerName: "copilot-session-logs",
	blobUploadFrequencyHours: 24,
	blobCompressFiles: true
		}),
		false
	);
});
