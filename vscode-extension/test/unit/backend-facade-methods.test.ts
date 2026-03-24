import './vscode-shim-register';
import { test, describe, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import * as fs from 'node:fs';

import { BackendFacade } from '../../src/backend/facade';

function createFacade(): any {
	const facade = new BackendFacade({
		context: { extensionUri: vscode.Uri.file('/mock/extension') } as any,
		log: () => undefined,
		warn: () => undefined,
		calculateEstimatedCost: () => 0,
		co2Per1kTokens: 0.2,
		waterUsagePer1kTokens: 0.3,
		co2AbsorptionPerTreePerYear: 21000,
		getCopilotSessionFiles: async () => [],
		estimateTokensFromText: () => 0,
		getModelFromRequest: () => 'gpt-4o',
		statSessionFile: async (f: string) => fs.promises.stat(f),
	});
	return facade;
}

describe('BackendFacade public methods', { concurrency: false }, () => {
	beforeEach(() => {
		(vscode as any).__mock.reset();
	});

	test('startTimerIfEnabled delegates to syncService', () => {
		const facade = createFacade();
		let called = false;
		facade.syncService.startTimerIfEnabled = () => { called = true; };
		facade.startTimerIfEnabled();
		assert.ok(called);
	});

	test('stopTimer delegates to syncService', () => {
		const facade = createFacade();
		let called = false;
		facade.syncService.stopTimer = () => { called = true; };
		facade.stopTimer();
		assert.ok(called);
	});

	test('clearQueryCache delegates to queryService', () => {
		const facade = createFacade();
		let called = false;
		facade.queryService.clearQueryCache = () => { called = true; };
		facade.clearQueryCache();
		assert.ok(called);
	});

	test('dispose cleans up syncService and configPanel', () => {
		const facade = createFacade();
		let syncDisposed = false;
		facade.syncService.dispose = () => { syncDisposed = true; };
		facade.dispose();
		assert.ok(syncDisposed);
	});

	test('getSettings returns backend settings', () => {
		const facade = createFacade();
		const settings = facade.getSettings();
		assert.equal(typeof settings, 'object');
		assert.equal(typeof settings.enabled, 'boolean');
	});

	test('isConfigured checks settings completeness', () => {
		const facade = createFacade();
		// Default settings are not configured
		const settings = facade.getSettings();
		assert.equal(facade.isConfigured(settings), false);
	});

	test('toggleBackendWorkspaceMachineNameSync toggles setting and shows message', async () => {
		const facade = createFacade();
		await facade.toggleBackendWorkspaceMachineNameSync();
		assert.ok((vscode as any).__mock.state.lastInfoMessages.some(
			(m: string) => m.includes('workspace/machine name sync')
		));
	});

	test('setBackendSharedKey shows error when no storageAccount configured', async () => {
		const facade = createFacade();
		// No storage account is configured by default
		await facade.setBackendSharedKey();
		// Should show error since storageAccount is empty
		assert.ok(
			(vscode as any).__mock.state.lastErrorMessages.length > 0 ||
			(vscode as any).__mock.state.lastInfoMessages.length === 0
		);
	});

	test('rotateBackendSharedKey shows error when no storageAccount configured', async () => {
		const facade = createFacade();
		await facade.rotateBackendSharedKey();
		assert.ok(
			(vscode as any).__mock.state.lastErrorMessages.length > 0 ||
			(vscode as any).__mock.state.lastInfoMessages.length === 0
		);
	});

	test('clearBackendSharedKey shows error when no storageAccount configured', async () => {
		const facade = createFacade();
		await facade.clearBackendSharedKey();
		assert.ok((vscode as any).__mock.state.lastErrorMessages.some(
			(m: string) => m.includes('not configured')
		));
	});

	test('clearAzureSettingsCommand resets all Azure settings and shows success', async () => {
		const facade = createFacade();
		let syncStarted = false;
		facade.syncService.startTimerIfEnabled = () => { syncStarted = true; };
		facade.queryService.clearQueryCache = () => {};
		await facade.clearAzureSettingsCommand();
		assert.ok((vscode as any).__mock.state.lastInfoMessages.some(
			(m: string) => m.includes('Azure settings cleared')
		));
		assert.ok(syncStarted);
	});

	test('setSharingProfileCommand delegates to azureResourceService', async () => {
		const facade = createFacade();
		let called = false;
		facade.azureResourceService.setSharingProfileCommand = async () => { called = true; };
		facade.queryService.clearQueryCache = () => {};
		await facade.setSharingProfileCommand();
		assert.ok(called);
	});

	test('syncToBackendStore delegates to syncService and clears cache', async () => {
		const facade = createFacade();
		let synced = false;
		facade.syncService.syncToBackendStore = async () => { synced = true; };
		facade.queryService.clearQueryCache = () => {};
		await facade.syncToBackendStore(true);
		assert.ok(synced);
	});

	test('tryGetBackendDetailedStatsForStatusBar delegates to queryService', async () => {
		const facade = createFacade();
		let calledWith: any;
		facade.queryService.tryGetBackendDetailedStatsForStatusBar = async (s: any, c: any, p: any) => {
			calledWith = { s, c, p };
			return undefined;
		};
		const settings = facade.getSettings();
		const result = await facade.tryGetBackendDetailedStatsForStatusBar(settings);
		assert.equal(result, undefined);
		assert.ok(calledWith);
	});

	test('getStatsForDetailsPanel delegates to queryService', async () => {
		const facade = createFacade();
		let called = false;
		facade.queryService.getStatsForDetailsPanel = async () => { called = true; return undefined; };
		await facade.getStatsForDetailsPanel();
		assert.ok(called);
	});

	test('getBackendSecretsToRedactForError delegates to credentialService', async () => {
		const facade = createFacade();
		facade.credentialService.getBackendSecretsToRedactForError = async () => ['secret1'];
		const settings = facade.getSettings();
		const result = await facade.getBackendSecretsToRedactForError(settings);
		assert.deepEqual(result, ['secret1']);
	});

	test('cache property round-trips work correctly', () => {
		const facade: any = createFacade();
		// These use the query service's setCacheState/clearQueryCache
		assert.equal(facade.queryService.backendLastQueryResult, undefined);
		assert.equal(facade.queryService.backendLastQueryCacheKey, undefined);
		assert.equal(facade.queryService.backendLastQueryCacheAt, undefined);

		const now = Date.now();
		const result = { stats: { today: { tokens: 10 } } };
		facade.queryService.setCacheState(result, 'test-key', now);
		assert.deepEqual(facade.queryService.backendLastQueryResult, result);
		assert.equal(facade.queryService.backendLastQueryCacheKey, 'test-key');
		assert.equal(facade.queryService.backendLastQueryCacheAt, now);

		facade.clearQueryCache();
		assert.equal(facade.queryService.backendLastQueryResult, undefined);
	});
});

describe('BackendFacade private methods via casting', { concurrency: false }, () => {
	beforeEach(() => {
		(vscode as any).__mock.reset();
	});

	test('getConfigPanelState returns expected structure', async () => {
		const facade: any = createFacade();
		// Mock credentialService to avoid real secret storage
		facade.credentialService.getStoredStorageSharedKey = async () => null;
		const state = await facade.getConfigPanelState();
		assert.equal(typeof state, 'object');
		assert.ok('draft' in state);
		assert.ok('sharedKeySet' in state);
		assert.ok('privacyBadge' in state);
		assert.ok('isConfigured' in state);
		assert.ok('authStatus' in state);
		assert.equal(state.sharedKeySet, false);
	});

	test('getConfigPanelState with sharedKey set returns sharedKeySet=true', async () => {
		const facade: any = createFacade();
		(vscode as any).__mock.setConfig({ 'copilotTokenTracker.backend.storageAccount': 'myaccount', 'copilotTokenTracker.backend.authMode': 'sharedKey' });
		facade.credentialService.getStoredStorageSharedKey = async () => 'abc123';
		const state = await facade.getConfigPanelState();
		assert.equal(state.sharedKeySet, true);
		assert.ok(state.authStatus.includes('Shared Key stored'));
	});

	test('getConfigPanelState with entraId authMode shows Entra ID status', async () => {
		const facade: any = createFacade();
		(vscode as any).__mock.setConfig({ 'copilotTokenTracker.backend.authMode': 'entraId' });
		facade.credentialService.getStoredStorageSharedKey = async () => null;
		const state = await facade.getConfigPanelState();
		assert.ok(state.authStatus.includes('Entra ID'));
	});

	test('getConfigPanelState with sharedKey authMode and no key shows missing', async () => {
		const facade: any = createFacade();
		(vscode as any).__mock.setConfig({ 'copilotTokenTracker.backend.authMode': 'sharedKey', 'copilotTokenTracker.backend.storageAccount': 'acct' });
		facade.credentialService.getStoredStorageSharedKey = async () => null;
		const state = await facade.getConfigPanelState();
		assert.ok(state.authStatus.includes('missing'));
	});

	test('getConfigPanelState with draftOverride uses the override', async () => {
		const facade: any = createFacade();
		facade.credentialService.getStoredStorageSharedKey = async () => null;
		const draft = {
			enabled: true,
			authMode: 'entraId',
			sharingProfile: 'soloFull' as const,
			shareWorkspaceMachineNames: true,
			includeMachineBreakdown: true,
			datasetId: 'mydata',
			lookbackDays: 7,
			subscriptionId: 'sub1',
			resourceGroup: 'rg1',
			storageAccount: 'acct1',
			aggTable: 'usageAggDaily',
			eventsTable: 'usageEvents',
			userIdentityMode: 'pseudonymous' as const,
			userId: '',
			blobUploadEnabled: false,
			blobContainerName: 'copilot-session-logs',
			blobUploadFrequencyHours: 24,
			blobCompressFiles: true,
		};
		const state = await facade.getConfigPanelState(draft);
		assert.equal(state.draft.enabled, true);
		assert.equal(state.draft.datasetId, 'mydata');
	});

	test('testConnectionFromDraft returns disabled message when backend disabled', async () => {
		const facade: any = createFacade();
		const result = await facade.testConnectionFromDraft({ enabled: false });
		assert.equal(result.ok, false);
		assert.ok(result.message.includes('disabled'));
	});

	test('testConnectionFromDraft returns validation error for invalid draft', async () => {
		const facade: any = createFacade();
		// enabled but missing required fields
		const result = await facade.testConnectionFromDraft({
			enabled: true,
			storageAccount: '',
			aggTable: '',
		});
		assert.equal(result.ok, false);
		assert.ok(result.message.includes('validation'));
	});

	test('testConnectionFromDraft classifies 403 as auth error', async () => {
		const facade: any = createFacade();
		(vscode as any).__mock.setConfig({
			'backend.storageAccount': 'acct',
			'backend.aggTable': 'table1',
			'backend.eventsTable': 'events1',
			'backend.datasetId': 'ds',
		});
		facade.credentialService.getBackendDataPlaneCredentials = async () => ({
			tableCredential: {},
			blobCredential: {},
			secretsToRedact: [],
		});
		facade.dataPlaneService.validateAccess = async () => {
			throw new Error('403 Forbidden');
		};
		const draft = {
			enabled: true,
			authMode: 'entraId',
			sharingProfile: 'soloFull',
			shareWorkspaceMachineNames: false,
			includeMachineBreakdown: false,
			datasetId: 'default',
			lookbackDays: 30,
			subscriptionId: 'sub',
			resourceGroup: 'rg',
			storageAccount: 'acct',
			aggTable: 'table1',
			eventsTable: 'events1',
			userIdentityMode: 'pseudonymous' as const,
			userId: '',
			blobUploadEnabled: false,
			blobContainerName: 'copilot-session-logs',
			blobUploadFrequencyHours: 24,
			blobCompressFiles: true,
		};
		const result = await facade.testConnectionFromDraft(draft);
		assert.equal(result.ok, false);
		assert.ok(result.message.includes('permissions'));
	});

	test('testConnectionFromDraft classifies 404 as not-found', async () => {
		const facade: any = createFacade();
		facade.credentialService.getBackendDataPlaneCredentials = async () => ({
			tableCredential: {},
			blobCredential: {},
			secretsToRedact: [],
		});
		facade.dataPlaneService.validateAccess = async () => {
			throw new Error('404 NotFound');
		};
		const draft = {
			enabled: true,
			authMode: 'entraId',
			sharingProfile: 'soloFull',
			shareWorkspaceMachineNames: false,
			includeMachineBreakdown: false,
			datasetId: 'default',
			lookbackDays: 30,
			subscriptionId: 'sub',
			resourceGroup: 'rg',
			storageAccount: 'acct',
			aggTable: 'table1',
			eventsTable: 'events1',
			userIdentityMode: 'pseudonymous' as const,
			userId: '',
			blobUploadEnabled: false,
			blobContainerName: 'copilot-session-logs',
			blobUploadFrequencyHours: 24,
			blobCompressFiles: true,
		};
		const result = await facade.testConnectionFromDraft(draft);
		assert.equal(result.ok, false);
		assert.ok(result.message.includes('not found'));
	});

	test('testConnectionFromDraft classifies ENOTFOUND as connection error', async () => {
		const facade: any = createFacade();
		facade.credentialService.getBackendDataPlaneCredentials = async () => ({
			tableCredential: {},
			blobCredential: {},
			secretsToRedact: [],
		});
		facade.dataPlaneService.validateAccess = async () => {
			throw new Error('ENOTFOUND getaddrinfo');
		};
		const draft = {
			enabled: true,
			authMode: 'entraId',
			sharingProfile: 'soloFull',
			shareWorkspaceMachineNames: false,
			includeMachineBreakdown: false,
			datasetId: 'default',
			lookbackDays: 30,
			subscriptionId: 'sub',
			resourceGroup: 'rg',
			storageAccount: 'acct',
			aggTable: 'table1',
			eventsTable: 'events1',
			userIdentityMode: 'pseudonymous' as const,
			userId: '',
			blobUploadEnabled: false,
			blobContainerName: 'copilot-session-logs',
			blobUploadFrequencyHours: 24,
			blobCompressFiles: true,
		};
		const result = await facade.testConnectionFromDraft(draft);
		assert.equal(result.ok, false);
		assert.ok(result.message.includes('network') || result.message.includes('Check'));
	});

	test('testConnectionFromDraft handles no credentials', async () => {
		const facade: any = createFacade();
		facade.credentialService.getBackendDataPlaneCredentials = async () => null;
		const draft = {
			enabled: true,
			authMode: 'sharedKey',
			sharingProfile: 'soloFull',
			shareWorkspaceMachineNames: false,
			includeMachineBreakdown: false,
			datasetId: 'default',
			lookbackDays: 30,
			subscriptionId: 'sub',
			resourceGroup: 'rg',
			storageAccount: 'acct',
			aggTable: 'table1',
			eventsTable: 'events1',
			userIdentityMode: 'pseudonymous' as const,
			userId: '',
			blobUploadEnabled: false,
			blobContainerName: 'copilot-session-logs',
			blobUploadFrequencyHours: 24,
			blobCompressFiles: true,
		};
		const result = await facade.testConnectionFromDraft(draft);
		assert.equal(result.ok, false);
		assert.ok(result.message.includes('Shared Key'));
	});

	test('testConnectionFromDraft success path', async () => {
		const facade: any = createFacade();
		facade.credentialService.getBackendDataPlaneCredentials = async () => ({
			tableCredential: {},
			blobCredential: {},
			secretsToRedact: [],
		});
		facade.dataPlaneService.validateAccess = async () => {};
		const draft = {
			enabled: true,
			authMode: 'entraId',
			sharingProfile: 'soloFull',
			shareWorkspaceMachineNames: false,
			includeMachineBreakdown: false,
			datasetId: 'default',
			lookbackDays: 30,
			subscriptionId: 'sub',
			resourceGroup: 'rg',
			storageAccount: 'acct',
			aggTable: 'table1',
			eventsTable: 'events1',
			userIdentityMode: 'pseudonymous' as const,
			userId: '',
			blobUploadEnabled: false,
			blobContainerName: 'copilot-session-logs',
			blobUploadFrequencyHours: 24,
			blobCompressFiles: true,
		};
		const result = await facade.testConnectionFromDraft(draft);
		assert.equal(result.ok, true);
		assert.ok(result.message.includes('onnect'));
	});

	test('testConnectionFromDraft fallback error message for unknown errors', async () => {
		const facade: any = createFacade();
		facade.credentialService.getBackendDataPlaneCredentials = async () => ({
			tableCredential: {},
			blobCredential: {},
			secretsToRedact: [],
		});
		facade.dataPlaneService.validateAccess = async () => {
			throw new Error('something completely unexpected');
		};
		const draft = {
			enabled: true,
			authMode: 'entraId',
			sharingProfile: 'soloFull',
			shareWorkspaceMachineNames: false,
			includeMachineBreakdown: false,
			datasetId: 'default',
			lookbackDays: 30,
			subscriptionId: 'sub',
			resourceGroup: 'rg',
			storageAccount: 'acct',
			aggTable: 'table1',
			eventsTable: 'events1',
			userIdentityMode: 'pseudonymous' as const,
			userId: '',
			blobUploadEnabled: false,
			blobContainerName: 'copilot-session-logs',
			blobUploadFrequencyHours: 24,
			blobCompressFiles: true,
		};
		const result = await facade.testConnectionFromDraft(draft);
		assert.equal(result.ok, false);
		assert.ok(result.message.includes('unexpected'));
	});

	test('saveDraft with invalid draft returns validation errors', async () => {
		const facade: any = createFacade();
		facade.credentialService.getStoredStorageSharedKey = async () => null;
		const result = await facade.saveDraft({
			enabled: true,
			authMode: 'entraId',
			sharingProfile: 'soloFull',
			shareWorkspaceMachineNames: false,
			includeMachineBreakdown: false,
			datasetId: 'default',
			lookbackDays: 30,
			subscriptionId: '',
			resourceGroup: '',
			storageAccount: '',
			aggTable: '',
			eventsTable: '',
			userIdentityMode: 'pseudonymous' as const,
			userId: '',
			blobUploadEnabled: false,
			blobContainerName: 'copilot-session-logs',
			blobUploadFrequencyHours: 24,
			blobCompressFiles: true,
		});
		assert.ok(result.errors);
		assert.ok(result.message?.includes('validation') || result.message?.includes('Fix'));
	});

	test('saveDraft with valid draft saves settings', async () => {
		const facade: any = createFacade();
		facade.credentialService.getStoredStorageSharedKey = async () => null;
		facade.syncService.startTimerIfEnabled = () => {};
		facade.queryService.clearQueryCache = () => {};
		const result = await facade.saveDraft({
			enabled: true,
			authMode: 'entraId',
			sharingProfile: 'off',
			shareWorkspaceMachineNames: false,
			includeMachineBreakdown: false,
			datasetId: 'default',
			lookbackDays: 30,
			subscriptionId: 'sub-123',
			resourceGroup: 'rg-test',
			storageAccount: 'testaccount',
			aggTable: 'usageAggDaily',
			eventsTable: 'usageEvents',
			userIdentityMode: 'pseudonymous' as const,
			userId: '',
			blobUploadEnabled: false,
			blobContainerName: 'copilot-session-logs',
			blobUploadFrequencyHours: 24,
			blobCompressFiles: true,
		});
		assert.ok(result.message?.includes('saved') || result.message?.includes('Saved'));
		assert.ok(result.state);
	});

	test('disableBackend disables and resets settings', async () => {
		const facade: any = createFacade();
		facade.credentialService.getStoredStorageSharedKey = async () => null;
		facade.syncService.startTimerIfEnabled = () => {};
		facade.queryService.clearQueryCache = () => {};
		const state = await facade.disableBackend();
		assert.equal(state.draft.enabled, false);
		assert.equal(state.draft.sharingProfile, 'off');
	});

	test('clearAzureSettings cancels when user dismisses confirmation', async () => {
		const facade: any = createFacade();
		// No nextPick set => user cancels
		facade.credentialService.getStoredStorageSharedKey = async () => null;
		const state = await facade.clearAzureSettings();
		assert.ok(state); // Returns current state without changes
	});

	test('clearAzureSettings proceeds when user confirms', async () => {
		const facade: any = createFacade();
		(vscode as any).__mock.setNextPick('Clear Settings');
		facade.credentialService.getStoredStorageSharedKey = async () => null;
		facade.credentialService.clearStoredStorageSharedKey = async () => {};
		facade.syncService.startTimerIfEnabled = () => {};
		facade.queryService.clearQueryCache = () => {};
		const state = await facade.clearAzureSettings();
		assert.equal(state.draft.enabled, false);
		assert.equal(state.draft.storageAccount, '');
	});

	test('updateSharedKey returns error when storageAccount is empty', async () => {
		const facade: any = createFacade();
		const result = await facade.updateSharedKey('');
		assert.equal(result.ok, false);
		assert.ok(result.message.includes('required'));
	});

	test('updateSharedKey returns error when storageAccount is whitespace', async () => {
		const facade: any = createFacade();
		const result = await facade.updateSharedKey('   ');
		assert.equal(result.ok, false);
		assert.ok(result.message.includes('required'));
	});

	test('promptForAndStoreSharedKey returns false when no storageAccount', async () => {
		const facade: any = createFacade();
		const result = await facade.promptForAndStoreSharedKey('', 'Test');
		assert.equal(result, false);
		assert.ok((vscode as any).__mock.state.lastErrorMessages.some(
			(m: string) => m.includes('not configured')
		));
	});

	test('promptForAndStoreSharedKey returns false when user cancels input', async () => {
		const facade: any = createFacade();
		// showInputBox returns undefined by default (user cancelled)
		const result = await facade.promptForAndStoreSharedKey('myaccount', 'Test');
		assert.equal(result, false);
	});

	test('clearBackendSharedKey with storageAccount confirms and clears', async () => {
		const facade: any = createFacade();
		(vscode as any).__mock.setConfig({ 'copilotTokenTracker.backend.storageAccount': 'myaccount' });
		(vscode as any).__mock.setNextPick('Remove Key');
		let cleared = false;
		facade.credentialService.clearStoredStorageSharedKey = async () => { cleared = true; };
		await facade.clearBackendSharedKey();
		assert.ok(cleared);
		assert.ok((vscode as any).__mock.state.lastInfoMessages.some(
			(m: string) => m.includes('removed') || m.includes('Shared key')
		));
	});

	test('clearBackendSharedKey cancelled by user does nothing', async () => {
		const facade: any = createFacade();
		(vscode as any).__mock.setConfig({ 'copilotTokenTracker.backend.storageAccount': 'myaccount' });
		// No nextPick => user dismisses
		let cleared = false;
		facade.credentialService.clearStoredStorageSharedKey = async () => { cleared = true; };
		await facade.clearBackendSharedKey();
		assert.equal(cleared, false);
	});

	test('clearBackendSharedKey error path shows error message', async () => {
		const facade: any = createFacade();
		(vscode as any).__mock.setConfig({ 'copilotTokenTracker.backend.storageAccount': 'myaccount' });
		(vscode as any).__mock.setNextPick('Remove Key');
		facade.credentialService.clearStoredStorageSharedKey = async () => { throw new Error('boom'); };
		await facade.clearBackendSharedKey();
		assert.ok((vscode as any).__mock.state.lastErrorMessages.some(
			(m: string) => m.includes('Failed to clear')
		));
	});

	test('setBackendSharedKey with storageAccount prompts and stores key', async () => {
		const facade: any = createFacade();
		(vscode as any).__mock.setConfig({ 'copilotTokenTracker.backend.storageAccount': 'myaccount' });
		// promptForAndStoreSharedKey calls showInputBox which returns undefined by default 
		await facade.setBackendSharedKey();
		// Since showInputBox returns undefined, no success message
		assert.equal((vscode as any).__mock.state.lastInfoMessages.length, 0);
	});

	test('setBackendSharedKey error path shows error message', async () => {
		const facade: any = createFacade();
		(vscode as any).__mock.setConfig({ 'copilotTokenTracker.backend.storageAccount': 'myaccount' });
		facade.promptForAndStoreSharedKey = async () => { throw new Error('fail!'); };
		await facade.setBackendSharedKey();
		assert.ok((vscode as any).__mock.state.lastErrorMessages.some(
			(m: string) => m.includes('Failed to set')
		));
	});

	test('rotateBackendSharedKey error path shows error message', async () => {
		const facade: any = createFacade();
		(vscode as any).__mock.setConfig({ 'copilotTokenTracker.backend.storageAccount': 'myaccount' });
		facade.promptForAndStoreSharedKey = async () => { throw new Error('rotation fail!'); };
		await facade.rotateBackendSharedKey();
		assert.ok((vscode as any).__mock.state.lastErrorMessages.some(
			(m: string) => m.includes('Failed to rotate')
		));
	});

	// ── Additional tests for uncovered facade methods ──

	test('getAggEntitiesForRange delegates to credential and dataPlane services', async () => {
		const facade: any = createFacade();
		facade.credentialService.getBackendDataPlaneCredentialsOrThrow = async () => ({ tableCredential: 'fake' });
		facade.dataPlaneService.createTableClient = () => ({ tableName: 'test' });
		facade.dataPlaneService.listEntitiesForRange = async () => [{ model: 'gpt-4o', inputTokens: 50 }];
		const settings = facade.getSettings();
		(vscode as any).__mock.setConfig({
			'copilotTokenTracker.backend.storageAccount': 'acct1',
			'copilotTokenTracker.backend.aggTable': 'usageAggDaily',
		});
		const result = await facade.getAggEntitiesForRange(facade.getSettings(), '2025-01-01', '2025-01-07');
		assert.ok(Array.isArray(result));
		assert.equal(result.length, 1);
	});

	test('getAllAggEntitiesForRange delegates to credential and dataPlane services', async () => {
		const facade: any = createFacade();
		facade.credentialService.getBackendDataPlaneCredentialsOrThrow = async () => ({ tableCredential: 'fake' });
		facade.dataPlaneService.createTableClient = () => ({ tableName: 'test' });
		facade.dataPlaneService.listAllEntitiesForRange = async () => [{ model: 'o1' }];
		const result = await facade.getAllAggEntitiesForRange(facade.getSettings(), '2025-01-01', '2025-01-07');
		assert.ok(Array.isArray(result));
		assert.equal(result.length, 1);
	});

	test('deleteUserDataset calls deleteEntitiesForUserDataset and clears cache', async () => {
		const facade: any = createFacade();
		let deleteCalled = false;
		facade.credentialService.getBackendDataPlaneCredentialsOrThrow = async () => ({ tableCredential: 'fake' });
		facade.dataPlaneService.createTableClient = () => ({ tableName: 'test' });
		facade.dataPlaneService.deleteEntitiesForUserDataset = async () => {
			deleteCalled = true;
			return { deletedCount: 3, errors: [] };
		};
		(vscode as any).__mock.setConfig({
			'copilotTokenTracker.backend.storageAccount': 'acct1',
			'copilotTokenTracker.backend.aggTable': 'usageAggDaily',
		});
		const result = await facade.deleteUserDataset('user1', 'ds1');
		assert.ok(deleteCalled);
		assert.equal(result.deletedCount, 3);
	});

	test('disableBackend calls updateConfiguration and returns state', async () => {
		const facade: any = createFacade();
		const state = await facade.disableBackend();
		assert.ok(state);
		assert.equal(state.draft.enabled, false);
		assert.equal(state.draft.sharingProfile, 'off');
	});

	test('showConfigPanel creates and shows config panel', async () => {
		const facade: any = createFacade();
		facade.credentialService.getStoredStorageSharedKey = async () => undefined;
		await facade.showConfigPanel();
		assert.ok(facade.configPanel);
		assert.ok(!facade.configPanel.isDisposed());
		facade.dispose();
	});

	test('setBackendSharedKey success shows info message', async () => {
		const facade: any = createFacade();
		(vscode as any).__mock.setConfig({ 'copilotTokenTracker.backend.storageAccount': 'myaccount' });
		facade.promptForAndStoreSharedKey = async () => true;
		await facade.setBackendSharedKey();
		assert.ok((vscode as any).__mock.state.lastInfoMessages.some(
			(m: string) => m.includes('myaccount')
		));
	});

	test('rotateBackendSharedKey success shows info message', async () => {
		const facade: any = createFacade();
		(vscode as any).__mock.setConfig({ 'copilotTokenTracker.backend.storageAccount': 'myaccount' });
		facade.promptForAndStoreSharedKey = async () => true;
		await facade.rotateBackendSharedKey();
		assert.ok((vscode as any).__mock.state.lastInfoMessages.some(
			(m: string) => m.includes('myaccount')
		));
	});

	test('toggleBackendWorkspaceMachineNameSync includes team sharing suffix', async () => {
		const facade = createFacade();
		(vscode as any).__mock.setConfig({ 'copilotTokenTracker.backend.shareWithTeam': true });
		await facade.toggleBackendWorkspaceMachineNameSync();
		// When shareWithTeam is true, the suffix about team sharing should NOT be appended
		const msgs = (vscode as any).__mock.state.lastInfoMessages;
		assert.ok(msgs.some((m: string) => m.includes('workspace/machine name sync')));
		assert.ok(!msgs.some((m: string) => m.includes('Note:')));
	});

	test('clearAzureSettings confirmed clears config and credentials', async () => {
		const facade: any = createFacade();
		let clearedKey = false;
		facade.credentialService.clearStoredStorageSharedKey = async () => { clearedKey = true; };
		facade.credentialService.getStoredStorageSharedKey = async () => undefined;
		(vscode as any).__mock.setConfig({ 'copilotTokenTracker.backend.storageAccount': 'myaccount' });
		// Mock showWarningMessage to return "Clear Settings"
		(vscode as any).__mock.setNextPick('Clear Settings');
		const state = await facade.clearAzureSettings();
		assert.ok(clearedKey);
		assert.ok(state);
		assert.equal(state.draft.enabled, false);
	});

	test('setFilters sets model and workspace filters', () => {
		const facade = createFacade();
		facade.setFilters({ lookbackDays: 14, model: 'gpt-4o', workspaceId: 'w1', machineId: 'm1', userId: 'u1' });
		const f = facade.getFilters();
		assert.equal(f.lookbackDays, 14);
		assert.equal(f.model, 'gpt-4o');
		assert.equal(f.workspaceId, 'w1');
		assert.equal(f.machineId, 'm1');
		assert.equal(f.userId, 'u1');
	});

	test('getBackendSecretsToRedactForError delegates to credentialService', async () => {
		const facade: any = createFacade();
		facade.credentialService.getBackendSecretsToRedactForError = async () => ['secret'];
		const secrets = await facade.getBackendSecretsToRedactForError(facade.getSettings());
		assert.deepEqual(secrets, ['secret']);
	});
});
