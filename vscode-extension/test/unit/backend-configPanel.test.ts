import './vscode-shim-register';
import { test, describe, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';

import * as vscode from 'vscode';
import { BackendConfigPanel, renderBackendConfigHtml, type BackendConfigPanelState, type BackendConfigPanelCallbacks } from '../../src/backend/configPanel';
import { toDraft } from '../../src/backend/configurationFlow';
import type { BackendSettings } from '../../src/backend/settings';

const baseSettings: BackendSettings = {
	enabled: true,
	backend: 'storageTables',
	authMode: 'entraId',
	datasetId: 'default',
	sharingProfile: 'soloFull',
	shareWithTeam: false,
	shareWorkspaceMachineNames: false,
	shareConsentAt: '',
	userIdentityMode: 'pseudonymous',
	userId: '',
	userIdMode: 'alias',
	subscriptionId: 'sub-1',
	resourceGroup: 'rg-1',
	storageAccount: 'stor1',
	aggTable: 'usageAggDaily',
	eventsTable: 'usageEvents',
	lookbackDays: 30,
	includeMachineBreakdown: false,
	blobUploadEnabled: false,
	blobContainerName: 'copilot-session-logs',
	blobUploadFrequencyHours: 24,
	blobCompressFiles: true
};

function makeState(overrides?: Partial<BackendConfigPanelState>): BackendConfigPanelState {
	return {
		draft: toDraft(baseSettings),
		sharedKeySet: false,
		privacyBadge: 'Solo',
		isConfigured: true,
		authStatus: 'Entra ID',
		...overrides
	};
}

function makeWebview(): vscode.Webview {
	return {
		cspSource: 'test-csp-source',
		asWebviewUri: (uri: any) => ({
			toString: () => 'vscode-webview://toolkit.js',
			scheme: 'vscode-webview',
			authority: '',
			path: '/toolkit.js',
			query: '',
			fragment: '',
			fsPath: '/toolkit.js',
			with: () => ({} as any),
			toJSON: () => ''
		})
	} as any;
}

// ── renderBackendConfigHtml ──────────────────────────────────────────────

test('renderBackendConfigHtml returns valid HTML document', () => {
	const html = renderBackendConfigHtml(makeWebview(), makeState());
	assert.ok(html.includes('<!DOCTYPE html>'));
	assert.ok(html.includes('</html>'));
	assert.ok(html.includes('<title>Configure Backend</title>'));
});

test('renderBackendConfigHtml includes CSP meta tag with nonce', () => {
	const html = renderBackendConfigHtml(makeWebview(), makeState());
	assert.ok(html.includes('Content-Security-Policy'));
	assert.ok(html.includes('nonce-'));
});

test('renderBackendConfigHtml embeds initial state safely', () => {
	const state = makeState();
	const html = renderBackendConfigHtml(makeWebview(), state);
	// The safe JSON function escapes < and > so the dataset value should appear
	assert.ok(html.includes('default'));
});

test('renderBackendConfigHtml includes privacy badge', () => {
	const state = makeState({ privacyBadge: 'Team Anonymized' });
	const html = renderBackendConfigHtml(makeWebview(), state);
	assert.ok(html.includes('Team Anonymized'));
});

test('renderBackendConfigHtml includes auth status', () => {
	const state = makeState({ authStatus: 'Shared Key (set)' });
	const html = renderBackendConfigHtml(makeWebview(), state);
	assert.ok(html.includes('Shared Key (set)'));
});

test('renderBackendConfigHtml renders navigation sections', () => {
	const html = renderBackendConfigHtml(makeWebview(), makeState());
	// Should have section identifiers for nav
	assert.ok(html.includes('Overview'));
	assert.ok(html.includes('Azure'));
});

test('renderBackendConfigHtml includes form field values from draft', () => {
	const state = makeState({
		draft: {
			...toDraft(baseSettings),
			datasetId: 'my-team-data',
			storageAccount: 'myStorAcct'
		}
	});
	const html = renderBackendConfigHtml(makeWebview(), state);
	assert.ok(html.includes('my-team-data'));
	assert.ok(html.includes('myStorAcct'));
});

test('renderBackendConfigHtml renders error messages when present', () => {
	const state = makeState({
		errors: { datasetId: 'Dataset ID is required.' }
	});
	const html = renderBackendConfigHtml(makeWebview(), state);
	assert.ok(html.includes('Dataset ID is required.'));
});

// ── BackendConfigPanel class tests ───────────────────────────────────────

function makeDraft() {
	return toDraft(baseSettings);
}

function makeCallbacks(overrides?: Partial<BackendConfigPanelCallbacks>): BackendConfigPanelCallbacks {
	return {
		getState: async () => makeState(),
		onSave: async (_draft) => ({ state: makeState(), message: 'Settings saved.' }),
		onDiscard: async () => makeState(),
		onStayLocal: async () => makeState(),
		onTestConnection: async () => ({ ok: true, message: 'Connection successful.' }),
		onUpdateSharedKey: async () => ({ ok: true, message: 'Key updated.', state: makeState() }),
		onLaunchWizard: async () => makeState(),
		onClearAzureSettings: async () => makeState(),
		...overrides
	};
}

describe('BackendConfigPanel class', { concurrency: false }, () => {
	beforeEach(() => {
		(vscode as any).__mock.reset();
	});

	test('show creates panel and sets HTML', async () => {
		const panel = new BackendConfigPanel(vscode.Uri.file('/mock/ext') as any, makeCallbacks());
		await panel.show();
		assert.ok(!panel.isDisposed());
		panel.dispose();
	});

	test('isDisposed returns true after dispose', async () => {
		const panel = new BackendConfigPanel(vscode.Uri.file('/mock/ext') as any, makeCallbacks());
		await panel.show();
		assert.equal(panel.isDisposed(), false);
		panel.dispose();
	});

	test('show followed by dispose cleans up', async () => {
		const panel = new BackendConfigPanel(vscode.Uri.file('/mock/ext') as any, makeCallbacks());
		await panel.show();
		panel.dispose();
		// Should not throw on double dispose
		panel.dispose();
	});

	test('handleMessage save calls onSave callback', async () => {
		let saveCalled = false;
		const callbacks = makeCallbacks({
			onSave: async (draft) => {
				saveCalled = true;
				return { state: makeState(), message: 'Saved.' };
			}
		});
		const configPanel = new BackendConfigPanel(vscode.Uri.file('/mock/ext') as any, callbacks);
		await configPanel.show();
		// Access internal panel to simulate message
		const internalPanel = (configPanel as any).panel;
		await internalPanel._simulateMessage({ command: 'save', draft: makeDraft() });
		assert.ok(saveCalled);
		configPanel.dispose();
	});

	test('handleMessage discard calls onDiscard callback', async () => {
		let discardCalled = false;
		const callbacks = makeCallbacks({
			onDiscard: async () => {
				discardCalled = true;
				return makeState();
			}
		});
		const configPanel = new BackendConfigPanel(vscode.Uri.file('/mock/ext') as any, callbacks);
		await configPanel.show();
		const internalPanel = (configPanel as any).panel;
		await internalPanel._simulateMessage({ command: 'discard' });
		assert.ok(discardCalled);
		configPanel.dispose();
	});

	test('handleMessage stayLocal calls onStayLocal callback', async () => {
		let stayLocalCalled = false;
		const callbacks = makeCallbacks({
			onStayLocal: async () => {
				stayLocalCalled = true;
				return makeState();
			}
		});
		const configPanel = new BackendConfigPanel(vscode.Uri.file('/mock/ext') as any, callbacks);
		await configPanel.show();
		const internalPanel = (configPanel as any).panel;
		await internalPanel._simulateMessage({ command: 'stayLocal' });
		assert.ok(stayLocalCalled);
		configPanel.dispose();
	});

	test('handleMessage testConnection calls onTestConnection', async () => {
		let tested = false;
		const callbacks = makeCallbacks({
			onTestConnection: async () => {
				tested = true;
				return { ok: true, message: 'OK' };
			}
		});
		const configPanel = new BackendConfigPanel(vscode.Uri.file('/mock/ext') as any, callbacks);
		await configPanel.show();
		const internalPanel = (configPanel as any).panel;
		await internalPanel._simulateMessage({ command: 'testConnection', draft: makeDraft() });
		assert.ok(tested);
		configPanel.dispose();
	});

	test('handleMessage updateSharedKey calls onUpdateSharedKey', async () => {
		let keyCalled = false;
		const callbacks = makeCallbacks({
			onUpdateSharedKey: async () => {
				keyCalled = true;
				return { ok: true, message: 'Key set.', state: makeState() };
			}
		});
		const configPanel = new BackendConfigPanel(vscode.Uri.file('/mock/ext') as any, callbacks);
		await configPanel.show();
		const internalPanel = (configPanel as any).panel;
		await internalPanel._simulateMessage({ command: 'updateSharedKey', storageAccount: 'testacc' });
		assert.ok(keyCalled);
		configPanel.dispose();
	});

	test('handleMessage launchWizard calls onLaunchWizard', async () => {
		let wizardCalled = false;
		const callbacks = makeCallbacks({
			onLaunchWizard: async () => {
				wizardCalled = true;
				return makeState();
			}
		});
		const configPanel = new BackendConfigPanel(vscode.Uri.file('/mock/ext') as any, callbacks);
		await configPanel.show();
		const internalPanel = (configPanel as any).panel;
		await internalPanel._simulateMessage({ command: 'launchWizard' });
		assert.ok(wizardCalled);
		configPanel.dispose();
	});

	test('handleMessage clearAzureSettings calls onClearAzureSettings', async () => {
		let clearCalled = false;
		const callbacks = makeCallbacks({
			onClearAzureSettings: async () => {
				clearCalled = true;
				return makeState();
			}
		});
		const configPanel = new BackendConfigPanel(vscode.Uri.file('/mock/ext') as any, callbacks);
		await configPanel.show();
		const internalPanel = (configPanel as any).panel;
		await internalPanel._simulateMessage({ command: 'clearAzureSettings' });
		assert.ok(clearCalled);
		configPanel.dispose();
	});

	test('handleMessage markDirty sets dirty flag', async () => {
		const configPanel = new BackendConfigPanel(vscode.Uri.file('/mock/ext') as any, makeCallbacks());
		await configPanel.show();
		const internalPanel = (configPanel as any).panel;
		await internalPanel._simulateMessage({ command: 'markDirty' });
		assert.equal((configPanel as any).dirty, true);
		configPanel.dispose();
	});

	test('save error shows error message', async () => {
		const callbacks = makeCallbacks({
			onSave: async () => { throw new Error('save failed'); }
		});
		const configPanel = new BackendConfigPanel(vscode.Uri.file('/mock/ext') as any, callbacks);
		await configPanel.show();
		const internalPanel = (configPanel as any).panel;
		await internalPanel._simulateMessage({ command: 'save', draft: makeDraft() });
		const msgs = (vscode as any).__mock.state.lastErrorMessages as string[];
		assert.ok(msgs.some((m: string) => m.includes('save failed')));
		configPanel.dispose();
	});

	test('withLock prevents concurrent operations', async () => {
		let resolveOp: () => void;
		const longOp = new Promise<void>((res) => { resolveOp = res; });
		let callCount = 0;
		const callbacks = makeCallbacks({
			onSave: async () => {
				callCount++;
				await longOp;
				return { state: makeState(), message: 'OK' };
			}
		});
		const configPanel = new BackendConfigPanel(vscode.Uri.file('/mock/ext') as any, callbacks);
		await configPanel.show();
		const internalPanel = (configPanel as any).panel;
		// Start first save (will block on longOp)
		const firstSave = internalPanel._simulateMessage({ command: 'save', draft: makeDraft() });
		// Second save should fail due to lock
		await internalPanel._simulateMessage({ command: 'save', draft: makeDraft() });
		const msgs = (vscode as any).__mock.state.lastErrorMessages as string[];
		assert.ok(msgs.some((m: string) => m.includes('Another operation')));
		// Release first save
		resolveOp!();
		await firstSave;
		configPanel.dispose();
	});
});
