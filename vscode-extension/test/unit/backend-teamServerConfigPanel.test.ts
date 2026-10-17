// @ts-nocheck
import './vscode-shim-register';
import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

// Helper to create a mock panel with proper event emitters
function createMockPanel(overrides: any = {}): any {
	return {
		reveal: () => {},
		dispose: () => {},
		onDidDispose: (callback: () => void) => ({ dispose: () => {} }),
		webview: {
			onDidReceiveMessage: (callback: (msg: any) => void) => ({ dispose: () => {} }),
			postMessage: (msg: any) => {},
			html: ''
		},
		...overrides
	};
}

test('TeamServerConfigPanel - show reuses existing panel', async () => {
	(vscode as any).__mock.reset();
	
	const revealCalls: string[] = [];
	const createWebviewCalls: any[] = [];
	
	// Mock the existing panel
	const mockPanel = createMockPanel({
		reveal: () => { revealCalls.push('reveal'); }
	});
	
	// Mock vscode.window
	const windowMock = vscode.window as any;
	windowMock.createWebviewPanel = (viewType: string, title: string, column: any, options: any) => {
		createWebviewCalls.push({ viewType, title, column, options });
		return createMockPanel();
	};
	
	// Mock vscode.workspace
	const workspaceMock = vscode.workspace as any;
	workspaceMock.getConfiguration = () => ({
		get: (key: string, defaultValue: any) => defaultValue
	});
	
	// Mock context
	const context = {
		extensionUri: vscode.Uri.parse('file:///extension'),
		subscriptions: []
	} as any;
	
	// Set the current panel
	const { TeamServerConfigPanel } = require('../../src/backend/teamServerConfigPanel');
	TeamServerConfigPanel.current = new TeamServerConfigPanel(context.extensionUri);
	(TeamServerConfigPanel.current as any).panel = mockPanel;
	(TeamServerConfigPanel.current as any).disposed = false;
	
	// Call show
	TeamServerConfigPanel.show(context);
	
	// Should reuse existing panel
	assert.equal(createWebviewCalls.length, 0, 'Should not create new panel when one exists');
	assert.equal(revealCalls.length, 1, 'Should reveal existing panel');
	
	// Clean up
	TeamServerConfigPanel.current = undefined;
});

test('TeamServerConfigPanel - show creates new panel when none exists', async () => {
	(vscode as any).__mock.reset();
	
	const createWebviewCalls: any[] = [];
	
	// Mock vscode.window
	const windowMock = vscode.window as any;
	windowMock.createWebviewPanel = (viewType: string, title: string, column: any, options: any) => {
		createWebviewCalls.push({ viewType, title, column, options });
		return createMockPanel();
	};
	
	// Mock vscode.workspace
	const workspaceMock = vscode.workspace as any;
	workspaceMock.getConfiguration = () => ({
		get: (key: string, defaultValue: any) => defaultValue
	});
	
	// Mock context
	const context = {
		extensionUri: vscode.Uri.parse('file:///extension'),
		subscriptions: []
	} as any;
	
	// Ensure no current panel
	const { TeamServerConfigPanel } = require('../../src/backend/teamServerConfigPanel');
	TeamServerConfigPanel.current = undefined;
	
	// Call show
	TeamServerConfigPanel.show(context);
	
	// Should create new panel
	assert.equal(createWebviewCalls.length, 1, 'Should create new panel when none exists');
	assert.equal(createWebviewCalls[0].viewType, 'copilotTeamServerConfig');
	assert.equal(createWebviewCalls[0].title, 'AI Engineering Fluency: Configure Team Server');
	
	// Clean up
	TeamServerConfigPanel.current?.dispose();
	TeamServerConfigPanel.current = undefined;
});

test('TeamServerConfigPanel - dispose cleans up resources', async () => {
	(vscode as any).__mock.reset();
	
	const panelDisposeCalls: number[] = [];
	const disposableDisposeCalls: string[] = [];
	
	// Mock panel
	const mockPanel = createMockPanel({
		dispose: () => { panelDisposeCalls.push(1); }
	});
	
	// Mock vscode.window
	const windowMock = vscode.window as any;
	windowMock.createWebviewPanel = () => mockPanel;
	
	// Mock vscode.workspace
	const workspaceMock = vscode.workspace as any;
	workspaceMock.getConfiguration = () => ({
		get: (key: string, defaultValue: any) => defaultValue
	});
	
	// Mock context
	const context = {
		extensionUri: vscode.Uri.parse('file:///extension'),
		subscriptions: []
	} as any;
	
	// Create instance
	const { TeamServerConfigPanel } = require('../../src/backend/teamServerConfigPanel');
	TeamServerConfigPanel.current = undefined;
	
	const panel = new TeamServerConfigPanel(context.extensionUri);
	(panel as any).panel = mockPanel;
	(panel as any).disposables = [
		{ dispose: () => { disposableDisposeCalls.push('disposable1'); } },
		{ dispose: () => { disposableDisposeCalls.push('disposable2'); } }
	];
	
	// Call dispose
	panel.dispose();
	
	// Verify cleanup
	assert.ok(panel.isDisposed(), 'Panel should be marked as disposed');
	assert.equal(panelDisposeCalls.length, 1, 'Panel dispose should be called');
	assert.equal(disposableDisposeCalls.length, 2, 'All disposables should be disposed');
	assert.equal(TeamServerConfigPanel.current, undefined, 'Current reference should be cleared');
});

test('TeamServerConfigPanel - handleMessage validates required endpoint URL', async () => {
	(vscode as any).__mock.reset();
	
	const postMessageCalls: any[] = [];
	
	// Mock panel with postMessage
	const mockPanel = createMockPanel({
		webview: {
			...createMockPanel().webview,
			postMessage: (msg: any) => { postMessageCalls.push(msg); }
		}
	});
	
	// Mock vscode.window
	const windowMock = vscode.window as any;
	windowMock.createWebviewPanel = () => mockPanel;
	windowMock.showInformationMessage = async () => {};
	
	// Mock vscode.workspace
	const configUpdates: any[] = [];
	const workspaceMock = vscode.workspace as any;
	workspaceMock.getConfiguration = () => ({
		get: (key: string, defaultValue: any) => defaultValue,
		update: async (key: string, value: any) => { configUpdates.push({ key, value }); }
	});
	
	// Mock context
	const context = {
		extensionUri: vscode.Uri.parse('file:///extension'),
		subscriptions: []
	} as any;
	
	// Create instance
	const { TeamServerConfigPanel } = require('../../src/backend/teamServerConfigPanel');
	TeamServerConfigPanel.current = undefined;
	
	const panel = new TeamServerConfigPanel(context.extensionUri);
	(panel as any).panel = mockPanel;
	
	// Call handleMessage with enabled=true but empty endpointUrl
	const message = { command: 'save', enabled: true, endpointUrl: '', sharingProfile: 'teamAnonymized' };
	
	// Access the private method through the instance
	const handleMessage = (panel as any).handleMessage.bind(panel);
	await handleMessage(message);
	
	// Should send validation error
	assert.equal(postMessageCalls.length, 1, 'Should send validation error message');
	assert.equal(postMessageCalls[0].command, 'validationError');
	assert.equal(postMessageCalls[0].field, 'endpointUrl');
	assert.ok(postMessageCalls[0].text.includes('required'), 'Error message should mention required');
	
	// Should not update config
	assert.equal(configUpdates.length, 0, 'Should not update config when validation fails');
});

test('TeamServerConfigPanel - handleMessage validates URL format', async () => {
	(vscode as any).__mock.reset();
	
	const postMessageCalls: any[] = [];
	
	// Mock panel with postMessage
	const mockPanel = createMockPanel({
		webview: {
			...createMockPanel().webview,
			postMessage: (msg: any) => { postMessageCalls.push(msg); }
		}
	});
	
	// Mock vscode.window
	const windowMock = vscode.window as any;
	windowMock.createWebviewPanel = () => mockPanel;
	windowMock.showInformationMessage = async () => {};
	
	// Mock vscode.workspace
	const configUpdates: any[] = [];
	const workspaceMock = vscode.workspace as any;
	workspaceMock.getConfiguration = () => ({
		get: (key: string, defaultValue: any) => defaultValue,
		update: async (key: string, value: any) => { configUpdates.push({ key, value }); }
	});
	
	// Mock context
	const context = {
		extensionUri: vscode.Uri.parse('file:///extension'),
		subscriptions: []
	} as any;
	
	// Create instance
	const { TeamServerConfigPanel } = require('../../src/backend/teamServerConfigPanel');
	TeamServerConfigPanel.current = undefined;
	
	const panel = new TeamServerConfigPanel(context.extensionUri);
	(panel as any).panel = mockPanel;
	
	// Call handleMessage with invalid URL
	const message = { command: 'save', enabled: true, endpointUrl: 'not-a-valid-url', sharingProfile: 'teamAnonymized' };
	
	const handleMessage = (panel as any).handleMessage.bind(panel);
	await handleMessage(message);
	
	// Should send validation error for invalid URL
	assert.equal(postMessageCalls.length, 1, 'Should send validation error message');
	assert.equal(postMessageCalls[0].command, 'validationError');
	assert.equal(postMessageCalls[0].field, 'endpointUrl');
	assert.ok(postMessageCalls[0].text.includes('valid URL'), 'Error message should mention valid URL');
	
	// Should not update config
	assert.equal(configUpdates.length, 0, 'Should not update config when validation fails');
});

test('TeamServerConfigPanel - handleMessage saves valid configuration', async () => {
	(vscode as any).__mock.reset();
	
	const infoMessages: string[] = [];
	const panelDisposeCalls: number[] = [];
	
	// Mock panel
	const mockPanel = createMockPanel({
		dispose: () => { panelDisposeCalls.push(1); }
	});
	
	// Mock vscode.window
	const windowMock = vscode.window as any;
	windowMock.createWebviewPanel = () => mockPanel;
	windowMock.showInformationMessage = async (msg: string) => { infoMessages.push(msg); };
	
	// Mock vscode.workspace
	const configUpdates: any[] = [];
	const workspaceMock = vscode.workspace as any;
	workspaceMock.getConfiguration = () => ({
		get: (key: string, defaultValue: any) => defaultValue,
		update: async (key: string, value: any) => { configUpdates.push({ key, value }); }
	});
	
	// Mock context
	const context = {
		extensionUri: vscode.Uri.parse('file:///extension'),
		subscriptions: []
	} as any;
	
	// Create instance
	const { TeamServerConfigPanel } = require('../../src/backend/teamServerConfigPanel');
	TeamServerConfigPanel.current = undefined;
	
	const panel = new TeamServerConfigPanel(context.extensionUri);
	(panel as any).panel = mockPanel;
	
	// Call handleMessage with valid data
	const message = { 
		command: 'save', 
		enabled: true, 
		endpointUrl: 'https://example.com/server',
		sharingProfile: 'teamAnonymized'
	};
	
	const handleMessage = (panel as any).handleMessage.bind(panel);
	await handleMessage(message);
	
	// Should update config — the enable flag last, once endpoint and profile are in place
	assert.equal(configUpdates.length, 3, 'Should update 3 config values');
	assert.equal(configUpdates[0].key, 'backend.sharingProfile');
	assert.equal(configUpdates[0].value, 'teamAnonymized');
	assert.equal(configUpdates[1].key, 'backend.sharingServer.endpointUrl');
	assert.equal(configUpdates[1].value, 'https://example.com/server');
	assert.equal(configUpdates[2].key, 'backend.sharingServer.enabled');
	assert.equal(configUpdates[2].value, true);
	
	// Should show success message
	assert.equal(infoMessages.length, 1, 'Should show success message');
	assert.ok(infoMessages[0].includes('saved'), 'Success message should mention saved');
	
	// Should dispose panel
	assert.equal(panelDisposeCalls.length, 1, 'Should dispose panel after save');
});

test('TeamServerConfigPanel - handleMessage uses default profile for invalid sharing profile', async () => {
	(vscode as any).__mock.reset();
	
	const infoMessages: string[] = [];
	
	// Mock panel
	const mockPanel = createMockPanel();
	
	// Mock vscode.window
	const windowMock = vscode.window as any;
	windowMock.createWebviewPanel = () => mockPanel;
	windowMock.showInformationMessage = async (msg: string) => { infoMessages.push(msg); };
	
	// Mock vscode.workspace
	const configUpdates: any[] = [];
	const workspaceMock = vscode.workspace as any;
	workspaceMock.getConfiguration = () => ({
		get: (key: string, defaultValue: any) => defaultValue,
		update: async (key: string, value: any) => { configUpdates.push({ key, value }); }
	});
	
	// Mock context
	const context = {
		extensionUri: vscode.Uri.parse('file:///extension'),
		subscriptions: []
	} as any;
	
	// Create instance
	const { TeamServerConfigPanel } = require('../../src/backend/teamServerConfigPanel');
	TeamServerConfigPanel.current = undefined;
	
	const panel = new TeamServerConfigPanel(context.extensionUri);
	(panel as any).panel = mockPanel;
	
	// Call handleMessage with invalid sharing profile
	const message = { 
		command: 'save', 
		enabled: true, 
		endpointUrl: 'https://example.com/server',
		sharingProfile: 'invalid-profile'
	};
	
	const handleMessage = (panel as any).handleMessage.bind(panel);
	await handleMessage(message);
	
	// Should use 'off' as default for invalid profile
	assert.equal(configUpdates.length, 3, 'Should update 3 config values');
	const profileUpdate = configUpdates.find((u: any) => u.key === 'backend.sharingProfile');
	assert.equal(profileUpdate?.value, 'off', 'Should default to off for invalid profile');
});

test('TeamServerConfigPanel - handleMessage ignores non-save commands', async () => {
	(vscode as any).__mock.reset();
	
	const postMessageCalls: any[] = [];
	
	// Mock panel
	const mockPanel = createMockPanel({
		webview: {
			...createMockPanel().webview,
			postMessage: (msg: any) => { postMessageCalls.push(msg); }
		}
	});
	
	// Mock vscode.window
	const windowMock = vscode.window as any;
	windowMock.createWebviewPanel = () => mockPanel;
	windowMock.showInformationMessage = async () => {};
	
	// Mock vscode.workspace
	const configUpdates: any[] = [];
	const workspaceMock = vscode.workspace as any;
	workspaceMock.getConfiguration = () => ({
		get: (key: string, defaultValue: any) => defaultValue,
		update: async (key: string, value: any) => { configUpdates.push({ key, value }); }
	});
	
	// Mock context
	const context = {
		extensionUri: vscode.Uri.parse('file:///extension'),
		subscriptions: []
	} as any;
	
	// Create instance
	const { TeamServerConfigPanel } = require('../../src/backend/teamServerConfigPanel');
	TeamServerConfigPanel.current = undefined;
	
	const panel = new TeamServerConfigPanel(context.extensionUri);
	(panel as any).panel = mockPanel;
	
	// Call handleMessage with non-save command
	const message = { command: 'cancel' };
	
	const handleMessage = (panel as any).handleMessage.bind(panel);
	await handleMessage(message);
	
	// Should not do anything
	assert.equal(postMessageCalls.length, 0, 'Should not send any messages');
	assert.equal(configUpdates.length, 0, 'Should not update config');
});

test('TeamServerConfigPanel - renderHtml generates valid HTML', async () => {
	(vscode as any).__mock.reset();
	
	// Mock context
	const context = {
		extensionUri: vscode.Uri.parse('file:///extension'),
		subscriptions: []
	} as any;
	
	// Create instance
	const { TeamServerConfigPanel } = require('../../src/backend/teamServerConfigPanel');
	TeamServerConfigPanel.current = undefined;
	
	const panel = new TeamServerConfigPanel(context.extensionUri);
	
	// Mock webview
	const mockWebview = {
		postMessage: () => {}
	} as any;
	
	// Call renderHtml
	const html = (panel as any).renderHtml(mockWebview, true, 'https://test.com', 'teamAnonymized');
	
	// Verify HTML structure
	assert.ok(html.includes('<!DOCTYPE html>'), 'Should include DOCTYPE');
	assert.ok(html.includes('Configure Team Server'), 'Should include title');
	assert.ok(html.includes('checked'), 'Should include checked attribute for enabled');
	assert.ok(html.includes('https://test.com'), 'Should include endpoint URL');
	assert.ok(html.includes('teamAnonymized'), 'Should include sharing profile');
	assert.ok(html.includes('nonce='), 'Should include nonce for CSP');
});

test('TeamServerConfigPanel - renderHtml includes the data-sharing info column', async () => {
	(vscode as any).__mock.reset();

	const context = {
		extensionUri: vscode.Uri.parse('file:///extension'),
		subscriptions: []
	} as any;

	const { TeamServerConfigPanel } = require('../../src/backend/teamServerConfigPanel');
	TeamServerConfigPanel.current = undefined;

	const panel = new TeamServerConfigPanel(context.extensionUri);
	const mockWebview = { postMessage: () => {} } as any;
	const html = (panel as any).renderHtml(mockWebview, false, '', 'off');

	// Info column explaining what data is shared and why
	assert.ok(html.includes('What data is shared'), 'Should include the info column heading');
	assert.ok(html.includes('id="profile-explainer"'), 'Should include the per-profile explainer container');
	assert.ok(html.includes('Your identity'), 'Should explain the always-on GitHub identity model');
	assert.ok(html.includes('PROFILE_EXPLAINERS'), 'Should include the per-profile explainer script map');
	assert.ok(html.includes('teamAnonymized:'), 'Explainer map should cover the teamAnonymized profile');
	assert.ok(html.includes('teamPseudonymous:'), 'Explainer map should cover the teamPseudonymous profile');
	assert.ok(html.includes('teamIdentified:'), 'Explainer map should cover the teamIdentified profile');

	// Fields table listing the exact SharingServerEntry payload
	assert.ok(html.includes('Fields sent per upload'), 'Should include the fields table heading');
	assert.ok(html.includes('workspaceId, machineId'), 'Should list workspace/machine IDs');
	assert.ok(html.includes('workspaceName, machineName'), 'Should list optional workspace/machine names');
	assert.ok(html.includes('datasetId, fluencyMetrics'), 'Should list dataset ID and fluency metrics');
	assert.ok(html.includes('Prompt and response content is never uploaded'), 'Should include the no-content callout');

	// Illustrative dashboard preview
	assert.ok(html.includes("What you'll get"), 'Should include the dashboard preview heading');
	assert.ok(html.includes('dashboard-preview'), 'Should include the dashboard preview mockup');
	assert.ok(html.includes('not live data'), 'Should label the mockup as illustrative, not live data');
});

function renderPanelWithProfile(inspected: string | undefined, values: Record<string, unknown> = {}): string {
	(vscode as any).__mock.reset();
	const panel = createMockPanel();
	(vscode.window as any).createWebviewPanel = () => panel;
	(vscode.workspace as any).getConfiguration = () => ({
		// get() returns the package.json default for an unset profile, exactly like VS Code.
		get: (key: string, defaultValue: any) => (key in values ? values[key] : defaultValue),
		inspect: (key: string) => key === 'backend.sharingProfile' ? { globalValue: inspected } : undefined,
	});
	const { TeamServerConfigPanel } = require('../../src/backend/teamServerConfigPanel');
	TeamServerConfigPanel.current = undefined;
	TeamServerConfigPanel.show({ extensionUri: vscode.Uri.parse('file:///extension'), subscriptions: [] } as any);
	const html = panel.webview.html as string;
	TeamServerConfigPanel.current?.dispose();
	TeamServerConfigPanel.current = undefined;
	return html;
}

test('TeamServerConfigPanel - an unset sharing profile preselects teamAnonymized, not off', () => {
	const html = renderPanelWithProfile(undefined);
	assert.ok(html.includes('<option value="teamAnonymized" selected>'), 'an unchanged save must not persist an explicit off');
	assert.ok(!html.includes('<option value="off" selected>'));
});

test('TeamServerConfigPanel - an explicit sharing profile is preserved, including off', () => {
	assert.ok(renderPanelWithProfile('off').includes('<option value="off" selected>'));
	assert.ok(renderPanelWithProfile('teamIdentified').includes('<option value="teamIdentified" selected>'));
});

test('TeamServerConfigPanel - an unset profile follows the same legacy inference as the settings', () => {
	const html = renderPanelWithProfile(undefined, { 'backend.shareWithTeam': true, 'backend.userIdentityMode': 'teamAlias' });
	assert.ok(html.includes('<option value="teamIdentified" selected>'));
});

async function saveFromPanel(message: any, current: Record<string, unknown>): Promise<Array<{ key: string; value: unknown }>> {
	(vscode as any).__mock.reset();
	const updates: Array<{ key: string; value: unknown }> = [];
	const state: Record<string, unknown> = { ...current };
	(vscode.workspace as any).getConfiguration = () => ({
		get: (key: string, defaultValue: any) => (key in state ? state[key] : defaultValue),
		update: async (key: string, value: unknown) => { updates.push({ key, value }); state[key] = value; },
	});
	(vscode.window as any).showInformationMessage = async () => undefined;
	const { TeamServerConfigPanel } = require('../../src/backend/teamServerConfigPanel');
	const panel = new TeamServerConfigPanel(vscode.Uri.parse('file:///extension'));
	(panel as any).panel = createMockPanel();
	await (panel as any).handleMessage({ command: 'save', ...message });
	return updates;
}

/** Replays the writes and returns every intermediate state in which the Team Server would upload. */
function uploadingStates(updates: Array<{ key: string; value: unknown }>, current: Record<string, unknown>): Array<Record<string, unknown>> {
	const state: Record<string, unknown> = { ...current };
	const uploading: Array<Record<string, unknown>> = [];
	for (const { key, value } of updates) {
		state[key] = value;
		if (state['backend.sharingServer.enabled'] && state['backend.sharingServer.endpointUrl'] && state['backend.sharingProfile'] !== 'off') {
			uploading.push({ ...state });
		}
	}
	return uploading;
}

test('TeamServerConfigPanel - a new setup saved with profile Off never passes through an uploading state', async () => {
	const current = {};
	const updates = await saveFromPanel({ enabled: true, endpointUrl: 'https://team.example.com', sharingProfile: 'off' }, current);
	assert.deepEqual(uploadingStates(updates, current), []);
	assert.deepEqual(updates.at(-1), { key: 'backend.sharingServer.enabled', value: true });
});

test('TeamServerConfigPanel - changing endpoint and profile on an enabled server disables it before applying them', async () => {
	const current = { 'backend.sharingServer.enabled': true, 'backend.sharingServer.endpointUrl': 'https://old.example.com', 'backend.sharingProfile': 'teamIdentified' };
	const updates = await saveFromPanel({ enabled: true, endpointUrl: 'https://new.example.com', sharingProfile: 'off' }, current);
	assert.deepEqual(updates[0], { key: 'backend.sharingServer.enabled', value: false });
	assert.deepEqual(uploadingStates(updates, current), [], 'no write may upload to the new endpoint under the old profile');
});

test('TeamServerConfigPanel - only the final state uploads when enabling with a team profile', async () => {
	const current = {};
	const updates = await saveFromPanel({ enabled: true, endpointUrl: 'https://team.example.com', sharingProfile: 'teamAnonymized' }, current);
	const uploading = uploadingStates(updates, current);
	assert.equal(uploading.length, 1);
	assert.equal(uploading[0]['backend.sharingProfile'], 'teamAnonymized');
	assert.equal(uploading[0]['backend.sharingServer.endpointUrl'], 'https://team.example.com');
});

test('TeamServerConfigPanel - disabling writes the enable flag first', async () => {
	const current = { 'backend.sharingServer.enabled': true, 'backend.sharingServer.endpointUrl': 'https://team.example.com', 'backend.sharingProfile': 'teamAnonymized' };
	const updates = await saveFromPanel({ enabled: false, endpointUrl: 'https://team.example.com', sharingProfile: 'teamAnonymized' }, current);
	assert.deepEqual(updates[0], { key: 'backend.sharingServer.enabled', value: false });
	assert.deepEqual(uploadingStates(updates, current), []);
});

test('TeamServerConfigPanel - the settings-change sync is deferred until the whole save has been applied', async () => {
	const { deferWhileApplyingSettings } = require('../../src/backend/settingsBatch');
	(vscode as any).__mock.reset();
	const state: Record<string, unknown> = { 'backend.sharingServer.enabled': false };
	const syncedStates: Array<Record<string, unknown>> = [];
	// Stand-in for the extension's listener: every write fires a change, whose reaction syncs
	// against whatever the settings are when it runs.
	const react = () => { syncedStates.push({ ...state }); };
	(vscode.workspace as any).getConfiguration = () => ({
		get: (key: string, defaultValue: any) => (key in state ? state[key] : defaultValue),
		update: async (key: string, value: unknown) => { state[key] = value; if (!deferWhileApplyingSettings(react)) { react(); } },
	});
	(vscode.window as any).showInformationMessage = async () => undefined;
	const { TeamServerConfigPanel } = require('../../src/backend/teamServerConfigPanel');
	const panel = new TeamServerConfigPanel(vscode.Uri.parse('file:///extension'));
	(panel as any).panel = createMockPanel();
	await (panel as any).handleMessage({ command: 'save', enabled: true, endpointUrl: 'https://team.example.com', sharingProfile: 'off' });
	assert.equal(syncedStates.length, 1, 'one sync after the save, none per intermediate write');
	assert.equal(syncedStates[0]['backend.sharingProfile'], 'off');
	assert.equal(syncedStates[0]['backend.sharingServer.enabled'], true);
});
