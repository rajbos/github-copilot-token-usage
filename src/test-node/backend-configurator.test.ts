/// <reference path="../types/jsdom.d.ts" />
import './vscode-shim-register';
import test from 'node:test';
import * as assert from 'node:assert/strict';

import * as vscode from 'vscode';
import { JSDOM } from 'jsdom';

import { BackendConfigPanel, type BackendConfigPanelState } from '../backend/configPanel';
import {
	applyDraftToSettings,
	needsConsent,
	toDraft,
	validateDraft,
	type BackendConfigDraft
} from '../backend/configurationFlow';
import { BackendFacade } from '../backend/facade';
import type { BackendSettings } from '../backend/settings';

const baseSettings: BackendSettings = {
	enabled: true,
	backend: 'storageTables',
	authMode: 'entraId',
	datasetId: 'default',
	sharingProfile: 'teamAnonymized',
	shareWithTeam: false,
	shareWorkspaceMachineNames: false,
	shareConsentAt: '',
	userIdentityMode: 'pseudonymous',
	userId: '',
	userIdMode: 'alias',
	subscriptionId: 'sub',
	resourceGroup: 'rg',
	storageAccount: 'stor',
	aggTable: 'usageAggDaily',
	eventsTable: 'usageEvents',
	lookbackDays: 30,
	includeMachineBreakdown: false
};

test('validateDraft enforces lookback bounds, alias rules, and dataset/table format', () => {
	const invalidDraft: BackendConfigDraft = {
		...toDraft(baseSettings),
		enabled: true,
		sharingProfile: 'teamIdentified',
		userIdentityMode: 'teamAlias',
		userId: 'john doe',
		datasetId: 'bad dataset',
		aggTable: 'agg table',
		eventsTable: 'events#1',
		lookbackDays: 0,
		subscriptionId: '',
		resourceGroup: '',
		storageAccount: '',
		includeMachineBreakdown: true,
		shareWorkspaceMachineNames: true
	};

	const result = validateDraft(invalidDraft);
	assert.equal(result.valid, false);
	assert.equal(result.errors.lookbackDays, 'Must be between 1 and 90.');
	assert.ok(result.errors.userId?.includes('Team alias'));
	assert.ok(result.errors.datasetId?.includes('letters'));
	assert.ok(result.errors.aggTable?.includes('letters'));
	assert.ok(result.errors.subscriptionId?.includes('Subscription ID is required'));
});

test('needsConsent detects more permissive sharing and name uploads, and applyDraftToSettings clears consent when team sharing is off', () => {
	const previous: BackendConfigDraft = { ...toDraft(baseSettings), sharingProfile: 'teamAnonymized', shareWorkspaceMachineNames: false };
	const next: BackendConfigDraft = { ...previous, sharingProfile: 'teamIdentified', shareWorkspaceMachineNames: true };
	const consent = needsConsent(previous, next);
	assert.equal(consent.required, true);
	assert.ok(consent.reasons.some((r) => r.includes('more permissive')));
	assert.ok(consent.reasons.some((r) => r.includes('names')));

	const settingsWithConsent: BackendSettings = {
		...baseSettings,
		shareWithTeam: true,
		shareConsentAt: '2024-01-01T00:00:00.000Z'
	};
	const cleared = applyDraftToSettings(settingsWithConsent, { ...toDraft(settingsWithConsent), sharingProfile: 'off', enabled: false }, undefined);
	assert.equal(cleared.shareWithTeam, false);
	assert.equal(cleared.shareConsentAt, '');
});

test('saveDraft persists settings, records consent, and clamps values', async () => {
	(vscode as any).__mock.reset();
	(vscode as any).__mock.setNextPick('I Understand, Continue');

	let current: BackendSettings = { ...baseSettings, sharingProfile: 'teamAnonymized', shareWithTeam: false };
	const updates: BackendSettings[] = [];
	let cleared = 0;
	let statsUpdated = 0;

	const facade: any = new BackendFacade({
		context: { extensionUri: (vscode as any).Uri.parse('file:///ext'), secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} } } as any,
		log: () => undefined,
		warn: () => undefined,
		updateTokenStats: async () => { statsUpdated++; },
		calculateEstimatedCost: () => 0,
		co2Per1kTokens: 0,
		waterUsagePer1kTokens: 0,
		co2AbsorptionPerTreePerYear: 0,
		getCopilotSessionFiles: async () => [],
		estimateTokensFromText: () => 0,
		getModelFromRequest: () => 'gpt-4o'
	});

	facade.getSettings = () => current;
	facade.updateConfiguration = async (next: BackendSettings) => { updates.push(next); current = next; };
	facade.clearQueryCache = () => { cleared++; };
	facade['deps'].updateTokenStats = async () => { statsUpdated++; };

	const draft: BackendConfigDraft = {
		...toDraft(current),
		enabled: true,
		sharingProfile: 'teamIdentified',
		shareWorkspaceMachineNames: true,
		userIdentityMode: 'teamAlias',
		userId: 'team-handle',
		lookbackDays: 90
	};

	const result = await facade.saveDraft(draft);
	assert.equal(updates.length, 1);
	assert.equal(updates[0].shareWithTeam, true);
	assert.ok(updates[0].shareConsentAt.length > 0);
	assert.equal(updates[0].lookbackDays, 90);
	assert.ok(cleared >= 1);
	assert.equal(result.message, 'Settings saved.');
});

test('saveDraft blocks when consent is withheld', async () => {
	(vscode as any).__mock.reset();
	(vscode as any).__mock.setNextPick('Cancel');

	let current: BackendSettings = { ...baseSettings, sharingProfile: 'teamAnonymized', shareWithTeam: false };
	const updates: BackendSettings[] = [];

	const facade: any = new BackendFacade({
		context: { extensionUri: (vscode as any).Uri.parse('file:///ext'), secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} } } as any,
		log: () => undefined,
		warn: () => undefined,
		updateTokenStats: async () => undefined,
		calculateEstimatedCost: () => 0,
		co2Per1kTokens: 0,
		waterUsagePer1kTokens: 0,
		co2AbsorptionPerTreePerYear: 0,
		getCopilotSessionFiles: async () => [],
		estimateTokensFromText: () => 0,
		getModelFromRequest: () => 'gpt-4o'
	});

	facade.getSettings = () => current;
	facade.updateConfiguration = async (next: BackendSettings) => { updates.push(next); current = next; };

	const draft: BackendConfigDraft = {
		...toDraft(current),
		sharingProfile: 'teamIdentified',
		shareWorkspaceMachineNames: true,
		userIdentityMode: 'teamAlias',
		userId: 'alias-ok'
	};

	const result = await facade.saveDraft(draft);
	assert.equal(updates.length, 0);
	assert.equal(result.message, 'Consent is required to apply these changes.');
});

test('updateSharedKey stores secret and returns updated panel state', async () => {
	(vscode as any).__mock.reset();

	let storedKey: string | undefined;
	let current: BackendSettings = { ...baseSettings };

	const facade: any = new BackendFacade({
		context: { extensionUri: (vscode as any).Uri.parse('file:///ext'), secrets: { get: async () => storedKey, store: async () => {}, delete: async () => {} } } as any,
		log: () => undefined,
		warn: () => undefined,
		calculateEstimatedCost: () => 0,
		co2Per1kTokens: 0,
		waterUsagePer1kTokens: 0,
		co2AbsorptionPerTreePerYear: 0,
		getCopilotSessionFiles: async () => [],
		estimateTokensFromText: () => 0,
		getModelFromRequest: () => 'gpt-4o'
	});

	facade.getSettings = () => current;
	facade.credentialService = {
		getStoredStorageSharedKey: async () => storedKey
	};
	facade.promptForAndStoreSharedKey = async () => {
		storedKey = 'secret-key';
		return true;
	};

	const result = await facade.updateSharedKey('stor', toDraft(current));
	assert.equal(result.ok, true);
	assert.equal(result.state?.sharedKeySet, true);
	assert.equal(result.message, 'Shared key stored for this machine.');
});

test('testConnectionFromDraft surfaces success, errors, and shared-key requirements', async () => {
	(vscode as any).__mock.reset();

	const facade: any = new BackendFacade({
		context: { extensionUri: (vscode as any).Uri.parse('file:///ext'), secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} } } as any,
		log: () => undefined,
		warn: () => undefined,
		calculateEstimatedCost: () => 0,
		co2Per1kTokens: 0,
		waterUsagePer1kTokens: 0,
		co2AbsorptionPerTreePerYear: 0,
		getCopilotSessionFiles: async () => [],
		estimateTokensFromText: () => 0,
		getModelFromRequest: () => 'gpt-4o'
	});

	let validated = 0;
	facade.getSettings = () => baseSettings;
	facade.credentialService = {
		getBackendDataPlaneCredentials: async () => ({ tableCredential: 'token' })
	};
	facade.dataPlaneService = {
		validateAccess: async () => { validated++; }
	};

	const okResult = await facade['testConnectionFromDraft'](toDraft(baseSettings));
	assert.equal(okResult.ok, true);
	assert.equal(validated, 1);
	assert.ok(okResult.message.includes('Connected'));

	facade.dataPlaneService = {
		validateAccess: async () => { throw new Error('no access'); }
	};
	const errorResult = await facade['testConnectionFromDraft'](toDraft(baseSettings));
	assert.equal(errorResult.ok, false);
	assert.ok(errorResult.message.includes('no access'));

	const sharedKeyDraft = { ...toDraft(baseSettings), authMode: 'sharedKey' };
	facade.credentialService = { getBackendDataPlaneCredentials: async () => undefined };
	const missingKey = await facade['testConnectionFromDraft'](sharedKeyDraft);
	assert.equal(missingKey.ok, false);
	assert.ok(missingKey.message.includes('Shared Key'));

	const disabledDraft = { ...toDraft(baseSettings), enabled: false };
	const disabledResult = await facade['testConnectionFromDraft'](disabledDraft);
	assert.equal(disabledResult.ok, false);
	assert.ok(disabledResult.message.toLowerCase().includes('disabled'));
});

test('BackendConfigPanel routes webview messages to callbacks', async () => {
	(vscode as any).__mock.reset();

	const posts: any[] = [];
	let receiveMessage: ((msg: any) => void) | undefined;

	(vscode as any).window.createWebviewPanel = () => ({
		webview: {
			html: '',
			cspSource: 'vscode-resource://',
			postMessage: (payload: any) => posts.push(payload),
			onDidReceiveMessage: (handler: (msg: any) => void) => { receiveMessage = handler; },
			asWebviewUri: (uri: any) => uri
		},
		onDidDispose: () => undefined,
		reveal: () => undefined,
		dispose: () => undefined
	});

	const baseState = await Promise.resolve({
		draft: toDraft(baseSettings),
		errors: {},
		sharedKeySet: false,
		privacyBadge: 'Team Anonymized',
		isConfigured: true,
		authStatus: 'Auth: Entra ID (RBAC)'
	});

	const panel = new BackendConfigPanel((vscode as any).Uri.parse('file:///ext'), {
		getState: async () => baseState,
		onSave: async (draft) => ({ state: { ...baseState, draft }, message: 'saved' }),
		onDiscard: async () => ({ ...baseState, message: undefined } as any),
		onStayLocal: async () => ({ ...baseState, draft: { ...baseState.draft, enabled: false } }),
		onTestConnection: async () => ({ ok: true, message: 'ok' }),
		onUpdateSharedKey: async () => ({ ok: true, message: 'key-set', state: baseState }),
		onLaunchWizard: async () => baseState,
		onClearAzureSettings: async () => baseState
	});

	await panel.show();
	assert.ok(receiveMessage, 'webview message handler registered');
	await receiveMessage?.({ command: 'save', draft: { ...baseState.draft, datasetId: 'newds' } });
	assert.ok(posts.some((p) => p.type === 'state' && p.state?.draft?.datasetId === 'newds'));
	await receiveMessage?.({ command: 'launchWizard' });
	assert.ok(posts.some((p) => p.type === 'state'), 'launchWizard should post refreshed state');
});

test('config panel HTML marks offline state and disables test button when offline', async () => {
	const state = await Promise.resolve({
		draft: toDraft(baseSettings),
		sharedKeySet: false,
		privacyBadge: 'Team Anonymized',
		isConfigured: false,
		authStatus: 'Auth: Entra ID (RBAC)'
	});

	const panel: any = new BackendConfigPanel((vscode as any).Uri.parse('file:///ext'), {
		getState: async () => state,
		onSave: async () => ({ state }),
		onDiscard: async () => state,
		onStayLocal: async () => state,
		onTestConnection: async () => ({ ok: true, message: 'ok' }),
		onUpdateSharedKey: async () => ({ ok: true, message: 'updated', state }),
		onLaunchWizard: async () => state,
		onClearAzureSettings: async () => state
	});

	const webview = {
		cspSource: 'vscode-resource://',
		asWebviewUri: () => 'toolkit.js'
	};
	const html: string = panel.renderHtml(webview as any, state);
	const sanitized = html.replace(/<script type="module"[^>]*toolkit\.js"><\/script>/, '');
	const alerts: string[] = [];

	const dom = new JSDOM(sanitized, {
		runScripts: 'dangerously',
		resources: 'usable',
		pretendToBeVisual: true,
		beforeParse(window: Window) {
			(window as any).acquireVsCodeApi = () => ({ postMessage: () => undefined });
			Object.defineProperty(window.navigator, 'onLine', { get: () => false });
			window.alert = (msg: any) => { alerts.push(String(msg)); };
		}
	});

	await new Promise((resolve) => dom.window.addEventListener('load', () => resolve(null)));
	const banner = dom.window.document.getElementById('offlineBanner');
	const testBtn = dom.window.document.getElementById('testConnectionBtn') as HTMLButtonElement;
	assert.ok(banner?.classList.contains('offline'));
	assert.equal(testBtn?.disabled, true);
	assert.deepEqual(alerts, []);
});

test('config panel HTML disables test button when backend is disabled', async () => {
	const state = await Promise.resolve({
		draft: { ...toDraft(baseSettings), enabled: false },
		sharedKeySet: false,
		privacyBadge: 'Team Anonymized',
		isConfigured: false,
		authStatus: 'Auth: Entra ID (RBAC)'
	});

	const panel: any = new BackendConfigPanel((vscode as any).Uri.parse('file:///ext'), {
		getState: async () => state,
		onSave: async () => ({ state }),
		onDiscard: async () => state,
		onStayLocal: async () => state,
		onTestConnection: async () => ({ ok: true, message: 'ok' }),
		onUpdateSharedKey: async () => ({ ok: true, message: 'updated', state }),
		onLaunchWizard: async () => state,
		onClearAzureSettings: async () => state
	});

	const webview = {
		cspSource: 'vscode-resource://',
		asWebviewUri: () => 'toolkit.js'
	};
	const html: string = panel.renderHtml(webview as any, state as any);
	const sanitized = html.replace(/<script type="module"[^>]*toolkit\.js"><\/script>/, '');

	const dom = new JSDOM(sanitized, {
		runScripts: 'dangerously',
		resources: 'usable',
		pretendToBeVisual: true,
		beforeParse(window: Window) {
			(window as any).acquireVsCodeApi = () => ({ postMessage: () => undefined });
			Object.defineProperty(window.navigator, 'onLine', { get: () => true });
		}
	});

	await new Promise((resolve) => dom.window.addEventListener('load', () => resolve(null)));
	const doc = dom.window.document;
	const testBtn = doc.getElementById('testConnectionBtn') as HTMLButtonElement;
	const testResult = doc.getElementById('testResult') as HTMLElement;
	assert.equal(testBtn?.disabled, true);
	assert.ok((testResult?.textContent || '').toLowerCase().includes('enable'));
});

test('config panel HTML toggles shared-key controls, keeps enable-first layout, and shows overview copy', async () => {
	const state: BackendConfigPanelState = {
		draft: { ...toDraft(baseSettings), authMode: 'entraId' },
		sharedKeySet: false,
		privacyBadge: 'Team Anonymized',
		isConfigured: false,
		authStatus: 'Auth: Entra ID (RBAC)'
	};

	const panel: any = new BackendConfigPanel((vscode as any).Uri.parse('file:///ext'), {
		getState: async () => state,
		onSave: async () => ({ state }),
		onDiscard: async () => state,
		onStayLocal: async () => state,
		onTestConnection: async () => ({ ok: true, message: 'ok' }),
		onUpdateSharedKey: async () => ({ ok: true, message: 'updated', state }),
		onLaunchWizard: async () => state,
		onClearAzureSettings: async () => state
	});

	const webview = { cspSource: 'vscode-resource://', asWebviewUri: () => 'toolkit.js' };
	const html: string = panel.renderHtml(webview as any, state);
	const sanitized = html.replace(/<script type="module"[^>]*toolkit\.js"><\/script>/, '');

	const dom = new JSDOM(sanitized, {
		runScripts: 'dangerously',
		resources: 'usable',
		pretendToBeVisual: true,
		beforeParse(window: Window) {
			(window as any).acquireVsCodeApi = () => ({ postMessage: () => undefined });
			Object.defineProperty(window.navigator, 'onLine', { get: () => true });
		}
	});

	await new Promise((resolve) => dom.window.addEventListener('load', () => resolve(null)));
	const doc = dom.window.document;

	const updateBtn = doc.getElementById('updateKeyBtn') as HTMLElement;
	const authDropdown = doc.getElementById('authMode') as HTMLSelectElement;
	assert.ok(updateBtn?.style.display === 'none' || updateBtn?.style.display === '');

	authDropdown.value = 'sharedKey';
	authDropdown.dispatchEvent(new dom.window.Event('change'));
	assert.equal(updateBtn?.style.display, 'inline-flex');

	const azureHeadings = Array.from(doc.querySelectorAll('#azure .card h3') as NodeListOf<HTMLElement>).map((el) => el.textContent?.trim());
	assert.equal(azureHeadings[0], 'Enable backend');
	assert.equal(azureHeadings[1], 'Azure resource IDs');

	const helper = doc.querySelector('#overview .helper')?.textContent || '';
	assert.ok(helper.includes('Stay Local'));
	assert.ok(doc.getElementById('privacyBadge'));
	assert.ok(doc.getElementById('authBadge'));
	assert.ok(doc.getElementById('backendStateBadge'));

	const testResult = doc.getElementById('testResult') as HTMLElement;
	testResult.textContent = '';
	authDropdown.value = 'sharedKey';
	authDropdown.dispatchEvent(new dom.window.Event('change'));
	const testResultText = (testResult.textContent || '').toLowerCase();
	assert.ok(
		testResultText.includes('test connection') ||
		testResultText.includes('test the connection') ||
		testResult.textContent === ''
	);
});

test('launchConfigureWizardFromPanel triggers wizard, timers, cache clear, and state refresh', async () => {
	let wizardCalled = 0;
	let timerStarted = 0;
	let cacheCleared = 0;
	let statsUpdated = 0;

	const facade: any = new BackendFacade({
		context: { extensionUri: (vscode as any).Uri.parse('file:///ext'), secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} } } as any,
		log: () => undefined,
		warn: () => undefined,
		updateTokenStats: async () => { statsUpdated++; },
		calculateEstimatedCost: () => 0,
		co2Per1kTokens: 0,
		waterUsagePer1kTokens: 0,
		co2AbsorptionPerTreePerYear: 0,
		getCopilotSessionFiles: async () => [],
		estimateTokensFromText: () => 0,
		getModelFromRequest: () => 'gpt-4o'
	});

	facade.azureResourceService = { configureBackendWizard: async () => { wizardCalled++; } } as any;
	facade.startTimerIfEnabled = () => { timerStarted++; };
	facade.clearQueryCache = () => { cacheCleared++; };
	facade.credentialService = { getStoredStorageSharedKey: async () => undefined } as any;
	facade.getSettings = () => baseSettings;

	const state = await facade['launchConfigureWizardFromPanel']();
	assert.equal(wizardCalled, 1);
	assert.equal(timerStarted, 1);
	assert.ok(cacheCleared >= 1);
	assert.ok(statsUpdated >= 1);
	assert.equal(state.draft.datasetId, baseSettings.datasetId);
});
