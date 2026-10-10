import './vscode-shim-register';
import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';

import * as vscode from 'vscode';

import { BackendCommandHandler } from '../../src/backend/commands';
import type { BackendFacadeInterface } from '../../src/backend/types';

// Helper to create a mock facade with all required methods
function createMockFacade(overrides: Partial<BackendFacadeInterface> = {}): BackendFacadeInterface {
	return {
		getSettings: () => ({ enabled: false }),
		isConfigured: () => false,
		getStatsForDetailsPanel: async () => undefined,
		tryGetBackendDetailedStatsForStatusBar: async () => undefined,
		setFilters: () => {},
		getFilters: () => ({}),
		getLastQueryResult: () => undefined,
		syncToBackendStore: async () => {},
		startTimerIfEnabled: () => {},
		stopTimer: () => {},
		dispose: () => {},
		configureBackendWizard: async () => {},
		setBackendSharedKey: async () => {},
		rotateBackendSharedKey: async () => {},
		clearBackendSharedKey: async () => {},
		clearAzureSettingsCommand: async () => {},
		toggleBackendWorkspaceMachineNameSync: async () => {},
		setSharingProfileCommand: async () => {},
		...overrides
	};
}

describe('backend/commands', { concurrency: false }, () => {
	test('handleSyncBackendNow warns when disabled or not configured', async () => {
	(vscode as any).__mock.reset();
	const handler = new BackendCommandHandler({
		facade: createMockFacade({
			getSettings: () => ({ enabled: false }),
			isConfigured: () => false
		}),
		integration: {},
		calculateEstimatedCost: () => 0,
		warn: () => undefined,
		log: () => undefined
	});

	await handler.handleSyncBackendNow();
	assert.ok((vscode as any).__mock.state.lastWarningMessages.some((m: string) => m.includes('disabled')));

	(vscode as any).__mock.reset();
	const handler2 = new BackendCommandHandler({
		facade: createMockFacade({
			getSettings: () => ({ enabled: true }),
			isConfigured: () => false
		}),
		integration: {},
		calculateEstimatedCost: () => 0,
		warn: () => undefined,
		log: () => undefined
	});
	await handler2.handleSyncBackendNow();
	assert.ok((vscode as any).__mock.state.lastWarningMessages.some((m: string) => m.includes('not fully configured')));
	});

	test('handleSyncBackendNow syncs a Team Server-only setup without backend.enabled', async () => {
	(vscode as any).__mock.reset();
	let synced = false;
	const handler = new BackendCommandHandler({
		facade: createMockFacade({
			getSettings: () => ({ enabled: false, backend: 'storageTables', sharingProfile: 'teamAnonymized', sharingServerEnabled: true, sharingServerEndpointUrl: 'https://team.example.com' }),
			isConfigured: () => false, // legacy Azure-keyed check
			syncToBackendStore: async () => { synced = true; }
		}),
		integration: {},
		calculateEstimatedCost: () => 0,
		warn: () => undefined,
		log: () => undefined
	});
	await handler.handleSyncBackendNow();
	assert.equal(synced, true);
	assert.deepEqual((vscode as any).__mock.state.lastWarningMessages, []);
	// No Azure request ran, so the success text must not claim one did.
	assert.ok((vscode as any).__mock.state.lastInfoMessages.some((m: string) => m.includes('Synced to Team Server successfully')));
	});

	test('handleSyncBackendNow refuses a sharing profile of off instead of reporting a no-op as success', async () => {
	(vscode as any).__mock.reset();
	let synced = false;
	const handler = new BackendCommandHandler({
		facade: createMockFacade({
			getSettings: () => ({ enabled: false, sharingProfile: 'off', sharingServerEnabled: true, sharingServerEndpointUrl: 'https://team.example.com' }),
			isConfigured: () => true,
			syncToBackendStore: async () => { synced = true; }
		}),
		integration: {},
		calculateEstimatedCost: () => 0,
		warn: () => undefined,
		log: () => undefined
	});
	await handler.handleSyncBackendNow();
	assert.equal(synced, false);
	assert.deepEqual((vscode as any).__mock.state.lastInfoMessages, []);
	assert.ok((vscode as any).__mock.state.lastWarningMessages.some((m: string) => m.includes('sharing profile is set to Off')));
	});

	const runSyncNow = async (settings: any, result: any) => {
		(vscode as any).__mock.reset();
		const handler = new BackendCommandHandler({
			facade: createMockFacade({ getSettings: () => settings, isConfigured: () => true, syncToBackendStore: async () => result }),
			integration: {},
			calculateEstimatedCost: () => 0,
			warn: () => undefined,
			log: () => undefined
		});
		await handler.handleSyncBackendNow();
		return (vscode as any).__mock.state;
	};

	test('handleSyncBackendNow reports a failed Team Server upload as an error, not success', async () => {
		const state = await runSyncNow({ enabled: false, sharingProfile: 'teamAnonymized', sharingServerEnabled: true, sharingServerEndpointUrl: 'https://team.example.com' }, { sharingServer: 'failed' });
		assert.deepEqual(state.lastInfoMessages, []);
		assert.ok(state.lastErrorMessages.some((m: string) => m.includes('Upload to Team Server failed')), JSON.stringify(state.lastErrorMessages));
	});

	test('handleSyncBackendNow reports a partial failure per target', async () => {
		const state = await runSyncNow({ enabled: true, sharingProfile: 'teamAnonymized', subscriptionId: 'sub', resourceGroup: 'rg', storageAccount: 'sa', aggTable: 'agg', sharingServerEnabled: true, sharingServerEndpointUrl: 'https://team.example.com' }, { azure: 'synced', sharingServer: 'failed' });
		assert.ok(state.lastInfoMessages.some((m: string) => m.includes('Synced to Azure successfully')), JSON.stringify(state.lastInfoMessages));
		assert.ok(!state.lastInfoMessages.some((m: string) => m.includes('Azure and Team Server')));
		assert.ok(state.lastErrorMessages.some((m: string) => m.includes('Upload to Team Server failed') && !m.includes('Azure failed')));
	});

	test('handleSyncBackendNow never reports "both" when one target was skipped', async () => {
		const state = await runSyncNow({ enabled: true, sharingProfile: 'teamAnonymized', subscriptionId: 'sub', resourceGroup: 'rg', storageAccount: 'sa', aggTable: 'agg', sharingServerEnabled: true, sharingServerEndpointUrl: 'https://team.example.com' }, { azure: 'synced', sharingServer: 'skipped' });
		assert.ok(state.lastInfoMessages.some((m: string) => m.includes('Synced to Azure successfully')), JSON.stringify(state.lastInfoMessages));
		assert.ok(!state.lastInfoMessages.some((m: string) => m.includes('Azure and Team Server')));
		assert.ok(state.lastWarningMessages.some((m: string) => m.includes('Nothing was uploaded to Team Server')));
		assert.deepEqual(state.lastErrorMessages, []);
	});

	test('handleSyncBackendNow warns instead of claiming success when nothing was sent', async () => {
		const state = await runSyncNow({ enabled: false, sharingProfile: 'teamAnonymized', sharingServerEnabled: true, sharingServerEndpointUrl: 'https://team.example.com' }, { sharingServer: 'skipped' });
		assert.deepEqual(state.lastInfoMessages, []);
		assert.ok(state.lastWarningMessages.some((m: string) => m.includes('Nothing was uploaded to Team Server')));
		const idle = await runSyncNow({ enabled: false, sharingProfile: 'teamAnonymized', sharingServerEnabled: true, sharingServerEndpointUrl: 'https://team.example.com' }, {});
		assert.deepEqual(idle.lastInfoMessages, []);
		assert.ok(idle.lastWarningMessages.some((m: string) => m.includes('Nothing was uploaded')));
	});

	test('handleSyncBackendNow reports success when every attempted target synced', async () => {
		const state = await runSyncNow({ enabled: true, sharingProfile: 'teamAnonymized', subscriptionId: 'sub', resourceGroup: 'rg', storageAccount: 'sa', aggTable: 'agg', sharingServerEnabled: true, sharingServerEndpointUrl: 'https://team.example.com' }, { azure: 'synced', sharingServer: 'synced' });
		assert.ok(state.lastInfoMessages.some((m: string) => m.includes('Synced to Azure and Team Server successfully')));
	});

	test('handleSyncBackendNow runs sync and shows success; errors show error message', async () => {
	(vscode as any).__mock.reset();
	let synced = false;
	const handler = new BackendCommandHandler({
		facade: createMockFacade({
			getSettings: () => ({ enabled: true, sharingProfile: 'teamAnonymized', subscriptionId: 'sub', resourceGroup: 'rg', storageAccount: 'sa', aggTable: 'agg' }),
			isConfigured: () => true,
			syncToBackendStore: async () => { synced = true; }
		}),
		integration: {},
		calculateEstimatedCost: () => 0,
		warn: () => undefined,
		log: () => undefined
	});

	await handler.handleSyncBackendNow();
	assert.equal(synced, true);
	assert.ok((vscode as any).__mock.state.lastInfoMessages.some((m: string) => m.includes('Synced to Azure successfully')));

	(vscode as any).__mock.reset();
	const handlerFail = new BackendCommandHandler({
		facade: createMockFacade({
			getSettings: () => ({ enabled: true, sharingProfile: 'teamAnonymized', subscriptionId: 'sub', resourceGroup: 'rg', storageAccount: 'sa', aggTable: 'agg' }),
			isConfigured: () => true,
			syncToBackendStore: async () => { throw new Error('nope'); }
		}),
		integration: {},
		calculateEstimatedCost: () => 0,
		warn: () => undefined,
		log: () => undefined
	});
	await handlerFail.handleSyncBackendNow();
	assert.ok((vscode as any).__mock.state.lastErrorMessages.some((m: string) => m.includes('Unable to sync to Azure')));
	});

	test('BackendCommandHandler covers configure/query/export/keys and convenience wrappers', async () => {
	(vscode as any).__mock.reset();

	let configured = false;
	let setKey = false;
	let rotated = false;
	let cleared = false;

	const facade = createMockFacade({
		getSettings: () => ({ enabled: true }),
		isConfigured: () => true,
		configureBackendWizard: async () => { configured = true; },
		tryGetBackendDetailedStatsForStatusBar: async () => ({
			today: { tokens: 123, sessions: 0, avgInteractionsPerSession: 0, avgTokensPerSession: 0, modelUsage: {}, editorUsage: {}, co2: 0, treesEquivalent: 0, waterUsage: 0, estimatedCost: 0 },
			month: { tokens: 456, sessions: 0, avgInteractionsPerSession: 0, avgTokensPerSession: 0, modelUsage: {}, editorUsage: {}, co2: 0, treesEquivalent: 0, waterUsage: 0, estimatedCost: 0 },
			lastUpdated: new Date()
		}),
		getLastQueryResult: () => ({
			stats: {
				today: { tokens: 1, sessions: 0, avgInteractionsPerSession: 0, avgTokensPerSession: 0, modelUsage: {}, editorUsage: {}, co2: 0, treesEquivalent: 0, waterUsage: 0, estimatedCost: 0 },
				month: { tokens: 1, sessions: 0, avgInteractionsPerSession: 0, avgTokensPerSession: 0, modelUsage: {}, editorUsage: {}, co2: 0, treesEquivalent: 0, waterUsage: 0, estimatedCost: 0 },
				lastUpdated: new Date()
			},
			availableModels: [],
			availableWorkspaces: [],
			availableMachines: [],
			availableUsers: [],
			workspaceTokenTotals: [],
			machineTokenTotals: []
		}),
		setBackendSharedKey: async () => { setKey = true; },
		rotateBackendSharedKey: async () => { rotated = true; },
		clearBackendSharedKey: async () => { cleared = true; }
	});

	const handler = new BackendCommandHandler({
		facade,
		integration: {},
		calculateEstimatedCost: () => 0,
		warn: () => undefined,
		log: () => undefined
	});

	await handler.handleConfigureBackend();
	assert.equal(configured, true);

	await handler.handleQueryBackend();
	assert.ok((vscode as any).__mock.state.lastInfoMessages.some((m: string) => m.includes('Backend Query Results')));
	assert.ok((vscode as any).__mock.state.lastInfoMessages.some((m: string) => m.includes('Today: 123 tokens')));

	await handler.handleExportCurrentView();
	assert.ok((vscode as any).__mock.state.clipboardText.includes('"stats"'));

	await handler.handleSetBackendSharedKey();
	assert.equal(setKey, true);

	(vscode as any).__mock.setNextPick('Replace Key');
	await handler.handleRotateBackendSharedKey();
	assert.equal(rotated, true);

	(vscode as any).__mock.setNextPick('Remove Key');
	await handler.handleClearBackendSharedKey();
	assert.equal(cleared, true);
	});

	test('BackendCommandHandler error paths: configure failure, query disabled, export failures, and confirm cancellations', async () => {
	(vscode as any).__mock.reset();
	const handler = new BackendCommandHandler({
		facade: createMockFacade({
			getSettings: () => ({ enabled: false }),
			isConfigured: () => false,
			configureBackendWizard: async () => { throw new Error('boom'); },
			tryGetBackendDetailedStatsForStatusBar: async () => undefined,
			getLastQueryResult: () => undefined,
			setBackendSharedKey: async () => { throw new Error('nope'); },
			rotateBackendSharedKey: async () => undefined,
			clearBackendSharedKey: async () => undefined
		}),
		integration: {},
		calculateEstimatedCost: () => 0,
		warn: () => undefined,
		log: () => undefined
	});

	await handler.handleConfigureBackend();
	assert.ok((vscode as any).__mock.state.lastErrorMessages.some((m: string) => m.includes('Unable to configure backend')));

	await handler.handleQueryBackend();
	assert.ok((vscode as any).__mock.state.lastWarningMessages.some((m: string) => m.includes('not configured or enabled')));

	await handler.handleExportCurrentView();
	assert.ok((vscode as any).__mock.state.lastWarningMessages.some((m: string) => m.includes('No query results')));

	// Export error path
	(vscode as any).__mock.reset();
	(vscode as any).__mock.setClipboardThrow(true);
	const handler2 = new BackendCommandHandler({
		facade: createMockFacade({
			getSettings: () => ({ enabled: true }),
			isConfigured: () => true,
			getLastQueryResult: () => ({
				stats: {
					today: { tokens: 1, sessions: 0, avgInteractionsPerSession: 0, avgTokensPerSession: 0, modelUsage: {}, editorUsage: {}, co2: 0, treesEquivalent: 0, waterUsage: 0, estimatedCost: 0 },
					month: { tokens: 1, sessions: 0, avgInteractionsPerSession: 0, avgTokensPerSession: 0, modelUsage: {}, editorUsage: {}, co2: 0, treesEquivalent: 0, waterUsage: 0, estimatedCost: 0 },
					lastUpdated: new Date()
				},
				availableModels: [],
				availableWorkspaces: [],
				availableMachines: [],
				availableUsers: [],
				workspaceTokenTotals: [],
				machineTokenTotals: []
			})
		}),
		integration: {},
		calculateEstimatedCost: () => 0,
		warn: () => undefined,
		log: () => undefined
	});
	await handler2.handleExportCurrentView();
	assert.ok((vscode as any).__mock.state.lastErrorMessages.some((m: string) => m.includes('Unable to export')));

	// confirmAction cancellations
	(vscode as any).__mock.reset();
	let rotated = false;
	let cleared = false;
	const handler3 = new BackendCommandHandler({
		facade: createMockFacade({
			getSettings: () => ({ enabled: true }),
			isConfigured: () => true,
			rotateBackendSharedKey: async () => { rotated = true; },
			clearBackendSharedKey: async () => { cleared = true; }
		}),
		integration: {},
		calculateEstimatedCost: () => 0,
		warn: () => undefined,
		log: () => undefined
	});
	await handler3.handleRotateBackendSharedKey();
	await handler3.handleClearBackendSharedKey();
	assert.equal(rotated, false);
	assert.equal(cleared, false);

	// setBackendSharedKey error path
	(vscode as any).__mock.reset();
	await handler.handleSetBackendSharedKey();
	assert.ok((vscode as any).__mock.state.lastErrorMessages.some((m: string) => m.includes('Unable to set shared key')));
	});

	test('handleEnableTeamSharing sets sharingProfile to teamPseudonymous and shareWithTeam to true', async () => {
	(vscode as any).__mock.reset();
	(vscode as any).__mock.setNextPick('I Understand, Continue');

	const handler = new BackendCommandHandler({
		facade: createMockFacade({
			getSettings: () => ({ enabled: true }),
			isConfigured: () => true
		}),
		integration: {},
		calculateEstimatedCost: () => 0,
		warn: () => undefined,
		log: () => undefined
	});

	await handler.handleEnableTeamSharing();

	// Verify success message is shown (indicates config.update succeeded)
	assert.ok((vscode as any).__mock.state.lastInfoMessages.some((m: string) => m.includes('Team sharing enabled')));
	});

	test('handleDisableTeamSharing sets sharingProfile to teamAnonymized and reduces data sharing', async () => {
	(vscode as any).__mock.reset();
	(vscode as any).__mock.setNextPick('Switch to Anonymized');

	const handler = new BackendCommandHandler({
		facade: createMockFacade({
			getSettings: () => ({ enabled: true }),
			isConfigured: () => true
		}),
		integration: {},
		calculateEstimatedCost: () => 0,
		warn: () => undefined,
		log: () => undefined
	});

	await handler.handleDisableTeamSharing();

	// Verify success message is shown (indicates config.update succeeded)
	assert.ok((vscode as any).__mock.state.lastInfoMessages.some((m: string) => m.includes('Switched to anonymized sharing')));
	});

	test('handleToggleBackendWorkspaceMachineNameSync delegates and handles error', async () => {
	(vscode as any).__mock.reset();
	let toggled = false;
	const handler = new BackendCommandHandler({
		facade: createMockFacade({
			toggleBackendWorkspaceMachineNameSync: async () => { toggled = true; },
		}),
		integration: {},
		calculateEstimatedCost: () => 0,
		warn: () => undefined,
		log: () => undefined
	});
	await handler.handleToggleBackendWorkspaceMachineNameSync();
	assert.ok(toggled);

	(vscode as any).__mock.reset();
	const handlerFail = new BackendCommandHandler({
		facade: createMockFacade({
			toggleBackendWorkspaceMachineNameSync: async () => { throw new Error('toggle fail'); },
		}),
		integration: {},
		calculateEstimatedCost: () => 0,
		warn: () => undefined,
		log: () => undefined
	});
	await handlerFail.handleToggleBackendWorkspaceMachineNameSync();
	assert.ok((vscode as any).__mock.state.lastErrorMessages.some((m: string) => m.includes('Unable to toggle')));
	});

	test('handleSetSharingProfile delegates and handles error', async () => {
	(vscode as any).__mock.reset();
	let called = false;
	const handler = new BackendCommandHandler({
		facade: createMockFacade({
			setSharingProfileCommand: async () => { called = true; },
		}),
		integration: {},
		calculateEstimatedCost: () => 0,
		warn: () => undefined,
		log: () => undefined
	});
	await handler.handleSetSharingProfile();
	assert.ok(called);

	(vscode as any).__mock.reset();
	const handlerFail = new BackendCommandHandler({
		facade: createMockFacade({
			setSharingProfileCommand: async () => { throw new Error('profile fail'); },
		}),
		integration: {},
		calculateEstimatedCost: () => 0,
		warn: () => undefined,
		log: () => undefined
	});
	await handlerFail.handleSetSharingProfile();
	assert.ok((vscode as any).__mock.state.lastErrorMessages.some((m: string) => m.includes('Unable to set sharing')));
	});

	test('handleClearAzureSettings confirms and clears, or cancels', async () => {
	(vscode as any).__mock.reset();
	let cleared = false;
	const handler = new BackendCommandHandler({
		facade: createMockFacade({
			clearAzureSettingsCommand: async () => { cleared = true; },
		}),
		integration: {},
		calculateEstimatedCost: () => 0,
		warn: () => undefined,
		log: () => undefined
	});

	// User cancels
	await handler.handleClearAzureSettings();
	assert.equal(cleared, false);

	// User confirms
	(vscode as any).__mock.reset();
	(vscode as any).__mock.setNextPick('Clear Settings');
	await handler.handleClearAzureSettings();
	assert.ok(cleared);

	// Error path
	(vscode as any).__mock.reset();
	(vscode as any).__mock.setNextPick('Clear Settings');
	const handlerFail = new BackendCommandHandler({
		facade: createMockFacade({
			clearAzureSettingsCommand: async () => { throw new Error('clear fail'); },
		}),
		integration: {},
		calculateEstimatedCost: () => 0,
		warn: () => undefined,
		log: () => undefined
	});
	await handlerFail.handleClearAzureSettings();
	assert.ok((vscode as any).__mock.state.lastErrorMessages.some((m: string) => m.includes('Unable to clear')));
	});

	test('handleSyncBackendNow respects cooldown', async () => {
	(vscode as any).__mock.reset();
	const handler = new BackendCommandHandler({
		facade: createMockFacade({
			getSettings: () => ({ enabled: true, sharingProfile: 'teamAnonymized', subscriptionId: 'sub', resourceGroup: 'rg', storageAccount: 'sa', aggTable: 'agg' }),
			isConfigured: () => true,
			syncToBackendStore: async () => {},
		}),
		integration: {},
		calculateEstimatedCost: () => 0,
		warn: () => undefined,
		log: () => undefined
	});

	// First call succeeds
	await handler.handleSyncBackendNow();
	assert.ok((vscode as any).__mock.state.lastInfoMessages.length > 0);

	// Second call within cooldown shows warning
	(vscode as any).__mock.reset();
	await handler.handleSyncBackendNow();
	assert.ok((vscode as any).__mock.state.lastWarningMessages.some((m: string) => m.includes('wait')));
	});

	test('handleEnableTeamSharing cancellation does nothing', async () => {
	(vscode as any).__mock.reset();
	// No nextPick => user cancels consent dialog
	const handler = new BackendCommandHandler({
		facade: createMockFacade(),
		integration: {},
		calculateEstimatedCost: () => 0,
		warn: () => undefined,
		log: () => undefined
	});
	await handler.handleEnableTeamSharing();
	// No success message should appear
	assert.equal((vscode as any).__mock.state.lastInfoMessages.filter((m: string) => m.includes('Team sharing')).length, 0);
	});

	test('handleDisableTeamSharing cancellation does nothing', async () => {
	(vscode as any).__mock.reset();
	// No nextPick => user cancels
	const handler = new BackendCommandHandler({
		facade: createMockFacade(),
		integration: {},
		calculateEstimatedCost: () => 0,
		warn: () => undefined,
		log: () => undefined
	});
	await handler.handleDisableTeamSharing();
	assert.equal((vscode as any).__mock.state.lastInfoMessages.filter((m: string) => m.includes('anonymized')).length, 0);
	});

	test('handleExportCurrentView with identifiers includes workspace/machine data', async () => {
	(vscode as any).__mock.reset();
	(vscode as any).__mock.setNextPick('Include identifiers/names');
	const handler = new BackendCommandHandler({
		facade: createMockFacade({
			getSettings: () => ({
				enabled: true,
				sharingProfile: 'teamPseudonymous',
				shareWorkspaceMachineNames: true,
			}),
			isConfigured: () => true,
			getLastQueryResult: () => ({
				stats: {
					today: { tokens: 1, sessions: 0, avgInteractionsPerSession: 0, avgTokensPerSession: 0, modelUsage: {}, editorUsage: {}, co2: 0, treesEquivalent: 0, waterUsage: 0, estimatedCost: 0 },
					month: { tokens: 2, sessions: 0, avgInteractionsPerSession: 0, avgTokensPerSession: 0, modelUsage: {}, editorUsage: {}, co2: 0, treesEquivalent: 0, waterUsage: 0, estimatedCost: 0 },
					lastUpdated: new Date()
				},
				availableModels: ['gpt-4o'],
				availableWorkspaces: ['w1'],
				availableMachines: ['m1'],
				availableUsers: ['u1'],
				workspaceNamesById: { w1: 'MyProject' },
				machineNamesById: { m1: 'DevBox' },
				workspaceTokenTotals: [{ workspaceId: 'w1', tokens: 100 }],
				machineTokenTotals: [{ machineId: 'm1', tokens: 200 }],
			}),
		}),
		integration: {},
		calculateEstimatedCost: () => 0,
		warn: () => undefined,
		log: () => undefined
	});
	await handler.handleExportCurrentView();
	const clipText = (vscode as any).__mock.state.clipboardText;
	assert.ok(clipText.includes('MyProject'));
	assert.ok(clipText.includes('DevBox'));
	assert.ok((vscode as any).__mock.state.lastInfoMessages.some((m: string) => m.includes('identifiers')));
	});

	test('handleQueryBackend with no data shows warning', async () => {
	(vscode as any).__mock.reset();
	const handler = new BackendCommandHandler({
		facade: createMockFacade({
			getSettings: () => ({ enabled: true }),
			isConfigured: () => true,
			tryGetBackendDetailedStatsForStatusBar: async () => undefined,
		}),
		integration: {},
		calculateEstimatedCost: () => 0,
		warn: () => undefined,
		log: () => undefined
	});
	await handler.handleQueryBackend();
	assert.ok((vscode as any).__mock.state.lastWarningMessages.some((m: string) => m.includes('No data')));
	});

	test('handleQueryBackend error path shows error', async () => {
	(vscode as any).__mock.reset();
	const handler = new BackendCommandHandler({
		facade: createMockFacade({
			getSettings: () => ({ enabled: true }),
			isConfigured: () => true,
			tryGetBackendDetailedStatsForStatusBar: async () => { throw new Error('query fail'); },
		}),
		integration: {},
		calculateEstimatedCost: () => 0,
		warn: () => undefined,
		log: () => undefined
	});
	await handler.handleQueryBackend();
	assert.ok((vscode as any).__mock.state.lastErrorMessages.some((m: string) => m.includes('query') || m.includes('Query')));
	});

	test('handleExportCurrentView respects non-identifying policy', async () => {
	(vscode as any).__mock.reset();
	const handler = new BackendCommandHandler({
		facade: createMockFacade({
			getSettings: () => ({
				enabled: true,
				sharingProfile: 'teamAnonymized',
				shareWorkspaceMachineNames: false,
			}),
			isConfigured: () => true,
			getLastQueryResult: () => ({
				stats: {
					today: { tokens: 1, sessions: 0, avgInteractionsPerSession: 0, avgTokensPerSession: 0, modelUsage: {}, editorUsage: {}, co2: 0, treesEquivalent: 0, waterUsage: 0, estimatedCost: 0 },
					month: { tokens: 2, sessions: 0, avgInteractionsPerSession: 0, avgTokensPerSession: 0, modelUsage: {}, editorUsage: {}, co2: 0, treesEquivalent: 0, waterUsage: 0, estimatedCost: 0 },
					lastUpdated: new Date()
				},
				availableModels: [],
				availableWorkspaces: ['w1'],
				availableMachines: ['m1'],
				availableUsers: [],
				workspaceNamesById: { w1: 'MyProject' },
				machineNamesById: { m1: 'DevBox' },
				workspaceTokenTotals: [{ workspaceId: 'w1', tokens: 100 }],
				machineTokenTotals: [{ machineId: 'm1', tokens: 200 }],
			}),
		}),
		integration: {},
		calculateEstimatedCost: () => 0,
		warn: () => undefined,
		log: () => undefined
	});
	await handler.handleExportCurrentView();
	const clipText = (vscode as any).__mock.state.clipboardText;
	// With non-identifying policy, workspace/machine data should be redacted
	assert.ok(!clipText.includes('MyProject'));
	assert.ok(!clipText.includes('DevBox'));
	});

	test('handleCopyBackendConfig delegates to copyBackendConfigToClipboard', async () => {
	(vscode as any).__mock.reset();
	const handler = new BackendCommandHandler({
		facade: createMockFacade({
			getSettings: () => ({
				enabled: true,
				storageAccount: 'testacct',
				sharingProfile: 'soloFull',
			}),
		}),
		integration: {},
		calculateEstimatedCost: () => 0,
		warn: () => undefined,
		log: () => undefined
	});
	await handler.handleCopyBackendConfig();
	// copyBackendConfigToClipboard writes to clipboard
	assert.ok((vscode as any).__mock.state.clipboardText.length > 0);
	});

	test('handleEnableTeamSharing error path shows error', async () => {
	(vscode as any).__mock.reset();
	(vscode as any).__mock.setNextPick('I Understand, Continue');
	// Force config.update to throw by mocking workspace configuration
	const origGetConfig = (vscode as any).workspace.getConfiguration;
	(vscode as any).workspace.getConfiguration = () => ({
		get: () => false,
		update: async () => { throw new Error('config write fail'); },
	});
	const handler = new BackendCommandHandler({
		facade: createMockFacade(),
		integration: {},
		calculateEstimatedCost: () => 0,
		warn: () => undefined,
		log: () => undefined
	});
	await handler.handleEnableTeamSharing();
	(vscode as any).workspace.getConfiguration = origGetConfig;
	assert.ok((vscode as any).__mock.state.lastErrorMessages.some((m: string) => m.includes('Unable to enable team sharing')));
	});

	test('handleDisableTeamSharing error path shows error', async () => {
	(vscode as any).__mock.reset();
	(vscode as any).__mock.setNextPick('Switch to Anonymized');
	const origGetConfig = (vscode as any).workspace.getConfiguration;
	(vscode as any).workspace.getConfiguration = () => ({
		get: () => false,
		update: async () => { throw new Error('config write fail'); },
	});
	const handler = new BackendCommandHandler({
		facade: createMockFacade(),
		integration: {},
		calculateEstimatedCost: () => 0,
		warn: () => undefined,
		log: () => undefined
	});
	await handler.handleDisableTeamSharing();
	(vscode as any).workspace.getConfiguration = origGetConfig;
	assert.ok((vscode as any).__mock.state.lastErrorMessages.some((m: string) => m.includes('Unable to disable team sharing')));
	});

	test('handleRotateBackendSharedKey error path shows error', async () => {
	(vscode as any).__mock.reset();
	(vscode as any).__mock.setNextPick('Replace Key');
	const handler = new BackendCommandHandler({
		facade: createMockFacade({
			rotateBackendSharedKey: async () => { throw new Error('rotate-fail'); },
		}),
		integration: {},
		calculateEstimatedCost: () => 0,
		warn: () => undefined,
		log: () => undefined
	});
	await handler.handleRotateBackendSharedKey();
	assert.ok((vscode as any).__mock.state.lastErrorMessages.some((m: string) => m.includes('Unable to rotate shared key')));
	});

	test('handleClearBackendSharedKey error path shows error', async () => {
	(vscode as any).__mock.reset();
	(vscode as any).__mock.setNextPick('Remove Key');
	const handler = new BackendCommandHandler({
		facade: createMockFacade({
			clearBackendSharedKey: async () => { throw new Error('clear-fail'); },
		}),
		integration: {},
		calculateEstimatedCost: () => 0,
		warn: () => undefined,
		log: () => undefined
	});
	await handler.handleClearBackendSharedKey();
	assert.ok((vscode as any).__mock.state.lastErrorMessages.some((m: string) => m.includes('Unable to clear shared key')));
	});
});
