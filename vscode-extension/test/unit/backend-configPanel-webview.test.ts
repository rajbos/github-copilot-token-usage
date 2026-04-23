/// <reference path="../../src/types/jsdom.d.ts" />
import './vscode-shim-register';
import { test, describe, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { renderBackendConfigHtml } from '../../src/backend/configPanel';

function createPanelHtml(): string {
	const initialState = {
		draft: {
			enabled: true,
			authMode: 'entraId' as const,
			sharingProfile: 'soloFull' as const,
			shareWorkspaceMachineNames: true,
			includeMachineBreakdown: true,
			datasetId: 'test-dataset',
			lookbackDays: 30,
			subscriptionId: 'sub-123',
			resourceGroup: 'rg-test',
			storageAccount: 'testaccount',
			aggTable: 'usageAggDaily',
			eventsTable: 'usageEvents',
			userIdentityMode: 'pseudonymous' as const,
			userId: 'testuser',
			blobUploadEnabled: false,
			blobContainerName: 'copilot-session-logs',
			blobUploadFrequencyHours: 24,
			blobCompressFiles: true,
			backend: 'storageTables' as const,
			sharingServerEnabled: false,
			sharingServerEndpointUrl: ''
		},
		sharedKeySet: false,
		privacyBadge: 'Solo',
		isConfigured: true,
		authStatus: 'Entra ID'
	};

	const webview = {
		cspSource: 'test-csp-source',
		asWebviewUri: (uri: any) => ({
			toString: () => 'vscode-webview://test-toolkit.js'
		})
	};

	return renderBackendConfigHtml(webview as any, initialState);
}

let dom: JSDOM;
let document: Document;

function setupDom(): void {
	const html = createPanelHtml();
	dom = new JSDOM(html);
	document = dom.window.document;
}

function teardownDom(): void {
	dom?.window?.close();
}

describe('Backend Config Panel Webview (node:test)', { concurrency: false }, () => {
	describe('HTML Structure', () => {
		beforeEach(() => { setupDom(); });

		test('has all 5 navigation buttons with correct targets', () => {
			const navButtons = document.querySelectorAll('.nav-btn');
			assert.equal(navButtons.length, 5);
			const targets = Array.from(navButtons).map(btn => btn.getAttribute('data-target'));
			assert.deepEqual(targets, ['overview', 'azure', 'sharing', 'advanced', 'review']);
			teardownDom();
		});

		test('has all section elements', () => {
			for (const id of ['overview', 'azure', 'sharing', 'advanced', 'review']) {
				const section = document.getElementById(id);
				assert.ok(section, `Section ${id} should exist`);
				assert.ok(section?.classList.contains('section'));
			}
			teardownDom();
		});

		test('overview section is active by default', () => {
			assert.ok(document.getElementById('overview')?.classList.contains('active'));
			const others = document.querySelectorAll('.section:not(#overview)');
			others.forEach(s => assert.ok(!s.classList.contains('active')));
			teardownDom();
		});

		test('overview has 3 cards with correct headings', () => {
			const cards = document.querySelectorAll('#overview .card');
			assert.equal(cards.length, 3);
			const headings = Array.from(cards).map(c => c.querySelector('h3')?.textContent);
			assert.deepEqual(headings, ['Why use backend sync?', 'Current status', 'How it works']);
			teardownDom();
		});

		test('current status card has all required elements', () => {
			assert.ok(document.getElementById('backendStateBadge'));
			assert.ok(document.getElementById('privacyBadge'));
			assert.ok(document.getElementById('authBadge'));
			assert.ok(document.getElementById('overviewDetails'));
			assert.ok(document.getElementById('overviewProfile'));
			assert.ok(document.getElementById('overviewDataset'));
			assert.ok(document.getElementById('statusMessage'));
			teardownDom();
		});

		test('has launchWizardLink', () => {
			assert.ok(document.getElementById('launchWizardLink'));
			teardownDom();
		});

		test('azure section has required buttons', () => {
			assert.ok(document.getElementById('setupBtn'));
			assert.ok(document.getElementById('testConnectionBtn'));
			assert.ok(document.getElementById('clearSettingsBtn'));
			teardownDom();
		});
	});

	describe('Navigation', () => {
		beforeEach(() => { setupDom(); });

		test('nav buttons have correct data-target attributes', () => {
			const navButtons = document.querySelectorAll('.nav-btn');
			const targets = Array.from(navButtons).map(btn => btn.getAttribute('data-target'));
			assert.ok(targets.includes('azure'), 'should have azure nav button');
			assert.ok(targets.includes('sharing'), 'should have sharing nav button');
			assert.ok(targets.includes('advanced'), 'should have advanced nav button');
			assert.ok(targets.includes('review'), 'should have review nav button');
			teardownDom();
		});

		test('all target sections referenced by nav buttons exist', () => {
			const navButtons = document.querySelectorAll('.nav-btn');
			const targets = Array.from(navButtons).map(btn => btn.getAttribute('data-target'));
			for (const target of targets) {
				assert.ok(document.getElementById(target!), `Section #${target} should exist`);
			}
			teardownDom();
		});
	});

	describe('Regression', () => {
		beforeEach(() => { setupDom(); });

		test('all required buttons exist', () => {
			for (const id of ['setupBtn', 'clearSettingsBtn', 'launchWizardLink']) {
				assert.ok(document.getElementById(id), `${id} must exist`);
			}
			teardownDom();
		});
	});
});
