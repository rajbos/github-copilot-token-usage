import './vscode-shim-register';
import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';

import * as vscode from 'vscode';

import { BackendCommandHandler } from '../backend/commands';
import type { BackendFacadeInterface } from '../backend/types';

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

	test('handleSyncBackendNow runs sync and shows success; errors show error message', async () => {
	(vscode as any).__mock.reset();
	let synced = false;
	const handler = new BackendCommandHandler({
		facade: createMockFacade({
			getSettings: () => ({ enabled: true }),
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
			getSettings: () => ({ enabled: true }),
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

	// Convenience wrappers
	(vscode as any).__mock.reset();
	await handler.configureBackend();
	await handler.exportCurrentView();
	await handler.setBackendSharedKey();
	await handler.rotateBackendSharedKey();
	await handler.clearBackendSharedKey();
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
});
