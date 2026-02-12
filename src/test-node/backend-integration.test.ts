import './vscode-shim-register';
import test from 'node:test';
import * as assert from 'node:assert/strict';

import * as vscode from 'vscode';

import crypto from 'node:crypto';

import {
	BackendIntegration,
	confirmAction,
	createBackendOutputChannel,
	formatTimestamp,
	getCurrentWorkspacePath,
	getWorkspaceId,
	getWorkspaceStorageId,
	isAzureAuthAvailable,
	logToBackendChannel,
	showBackendError,
	showBackendSuccess,
	showBackendWarning,
	validateAzureResourceName
} from '../backend/integration';
import type { BackendSettings } from '../backend/settings';

test('formatTimestamp returns Never for invalid dates', () => {
	assert.equal(formatTimestamp('not-a-date'), 'Never');
	assert.equal(formatTimestamp(NaN as any), 'Never');
});

test('formatTimestamp returns relative labels for recent times', () => {
	const now = Date.now();
	assert.equal(formatTimestamp(now - 10_000), 'Just now');
	assert.equal(formatTimestamp(now - 70_000).includes('minute'), true);
});

test('validateAzureResourceName enforces basic rules and storage-specific rules', () => {
	assert.equal(validateAzureResourceName('', 'Storage account'), 'Storage account name is required');
	assert.ok(validateAzureResourceName('ab', 'Storage account')?.includes('at least 3'));
	assert.equal(validateAzureResourceName('ABC', 'Storage account'), 'Storage account name must contain only lowercase letters and numbers');
	assert.equal(validateAzureResourceName('goodname', 'Storage account'), undefined);
});

test('confirmAction returns true when user picks confirm label', async () => {
	(vscode as any).__mock.reset();
	(vscode as any).__mock.setNextPick('Do it');
	const ok = await confirmAction('msg', 'Do it');
	assert.equal(ok, true);
});

test('workspace helpers return unknown when no folders, else stable values', () => {
	(vscode as any).__mock.reset();
	assert.equal(getCurrentWorkspacePath(), undefined);
	assert.equal(getWorkspaceId(), 'unknown');

	(vscode as any).__mock.setWorkspaceFolders([{ fsPath: 'C:\\repo', uriString: 'file:///C:/repo' }]);
	assert.equal(getCurrentWorkspacePath(), 'C:\\repo');
	const id = getWorkspaceId();
	assert.equal(typeof id, 'string');
	assert.equal(id.length, 16);
});

test('showBackendError includes storage context when settings provided', () => {
	(vscode as any).__mock.reset();
	showBackendError('boom', { storageAccount: 'sa' } as any);
	const msg = (vscode as any).__mock.state.lastErrorMessages.at(-1);
	assert.ok(String(msg).includes('Storage: sa'));
});

test('showBackendWarning and showBackendSuccess record messages', () => {
	(vscode as any).__mock.reset();
	showBackendWarning('check me');
	showBackendSuccess('all good');
	assert.ok((vscode as any).__mock.state.lastWarningMessages.at(-1)?.includes('check me'));
	assert.ok((vscode as any).__mock.state.lastInfoMessages.at(-1)?.includes('all good'));
});

test('createBackendOutputChannel adds to context subscriptions', () => {
	(vscode as any).__mock.reset();
	const context = { subscriptions: [] as any[] } as vscode.ExtensionContext;
	const channel = createBackendOutputChannel(context);
	assert.equal(context.subscriptions.length, 1);
	assert.ok(channel);
});

test('logToBackendChannel prefixes timestamps', () => {
	const lines: string[] = [];
	const channel: vscode.OutputChannel = {
		name: 'test',
		appendLine: (line: string) => {
			lines.push(line);
		},
		append: () => {},
		replace: () => {},
		clear: () => {},
		show: () => {},
		hide: () => {},
		dispose: () => {}
	};
	logToBackendChannel(channel, 'hello');
	assert.equal(lines.length, 1);
	assert.ok(/^\[\d{4}-\d{2}-\d{2}T/.test(lines[0]));
	assert.ok(lines[0].includes('hello'));
});

test('getWorkspaceStorageId matches md5 of workspace URI', () => {
	(vscode as any).__mock.reset();
	(vscode as any).__mock.setWorkspaceFolders([{ fsPath: 'C:\\repo', uriString: 'file:///C:/repo' }]);
	const expected = crypto.createHash('md5').update('file:///C:/repo').digest('hex');
	assert.equal(getWorkspaceStorageId(), expected);
});

test('isAzureAuthAvailable returns true regardless of extension presence', async () => {
	(vscode as any).__mock.reset();
	assert.equal(await isAzureAuthAvailable(), true);
	(vscode as any).__mock.state.extensions['ms-vscode.azure-account'] = {};
	assert.equal(await isAzureAuthAvailable(), true);
});

test('BackendIntegration proxies facade calls and fallbacks', async () => {
	const calls: Array<{ method: string; args: any[] }> = [];
	const settings: BackendSettings = {
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
		aggTable: 'usageAggDaily',
		eventsTable: 'usageEvents',
		lookbackDays: 30,
		includeMachineBreakdown: true,
	blobUploadEnabled: false,
	blobContainerName: "copilot-session-logs",
	blobUploadFrequencyHours: 24,
	blobCompressFiles: true
	};
	const facade = {
		getSettings: () => {
			calls.push({ method: 'getSettings', args: [] });
			return settings;
		},
		isConfigured: (_settings: BackendSettings) => {
			calls.push({ method: 'isConfigured', args: [_settings] });
			return true;
		},
		syncToBackendStore: async (force: boolean) => {
			calls.push({ method: 'syncToBackendStore', args: [force] });
		},
		getStatsForDetailsPanel: async () => {
			calls.push({ method: 'getStatsForDetailsPanel', args: [] });
			return undefined;
		},
		setFilters: (filters: any) => {
			calls.push({ method: 'setFilters', args: [filters] });
		}
	};

	const warnMessages: string[] = [];
	const errorMessages: Array<{ message: string; error?: unknown }> = [];
	const loggedMessages: string[] = [];
	const integration = new BackendIntegration({
		facade,
		context: undefined,
		log: (m) => loggedMessages.push(m),
		warn: (m) => warnMessages.push(m),
		error: (m, e) => errorMessages.push({ message: m, error: e }),
		updateTokenStats: async () => 'local-fallback',
		toUtcDayKey: (d) => d.toISOString().slice(0, 10)
	});

	assert.equal(integration.getContext(), undefined);
	integration.log('again');
	integration.warn('warned');
	integration.error('errored', new Error('boom'));
	assert.ok(loggedMessages.some(m => m.includes('[Backend] again')));
	assert.deepEqual(warnMessages, ['warned']);
	assert.equal(errorMessages.length, 1);
	assert.equal(errorMessages[0].message, 'errored');

	assert.equal(integration.toUtcDayKey(new Date('2024-01-02')), '2024-01-02');
	await integration.updateTokenStats();
	assert.equal(integration.getSettings().storageAccount, 'sa');
	assert.equal(integration.isConfigured(settings), true);
	await integration.syncToBackendStore(false);
	assert.equal(await integration.getStatsForDetailsPanel(), 'local-fallback');
	integration.setFilters({ x: 1 });
	assert.ok(calls.some(c => c.method === 'setFilters'));
});
