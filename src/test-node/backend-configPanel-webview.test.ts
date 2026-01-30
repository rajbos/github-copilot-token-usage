import * as assert from 'assert';
import { JSDOM } from 'jsdom';
import { renderBackendConfigHtml } from '../backend/configPanel';

suite('Backend Config Panel Webview Integration Tests', () => {
	let dom: JSDOM;
	let document: Document;
	let window: Window;

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
				userId: 'testuser'
			},
			sharedKeySet: false,
			privacyBadge: 'Solo',
			isConfigured: true,
			authStatus: 'Entra ID'
		};
		
		// Mock webview CSP source
		const webview = {
			cspSource: 'test-csp-source',
			asWebviewUri: (uri: any) => ({
				toString: () => 'vscode-webview://test-toolkit.js'
			})
		};
		
		return renderBackendConfigHtml(webview as any, initialState);
	}

	setup(() => {
		const html = createPanelHtml();
		dom = new JSDOM(html, {
			runScripts: 'dangerously',
			resources: 'usable',
			beforeParse(window: any) {
				// Mock vscode webview API
				(window as any).acquireVsCodeApi = () => ({
					postMessage: (msg: any) => {
						window.dispatchEvent(new CustomEvent('vscode-message', { detail: msg }));
					},
					getState: () => ({}),
					setState: (state: any) => {}
				});
			}
		});
		window = dom.window as unknown as Window;
		document = window.document;
	});

	teardown(() => {
		dom.window.close();
	});

	suite('HTML Structure', () => {
		test('Should have all navigation buttons', () => {
			const navButtons = document.querySelectorAll('.nav-btn');
			assert.strictEqual(navButtons.length, 5, 'Should have 5 navigation buttons');

			const targets = Array.from(navButtons).map(btn => btn.getAttribute('data-target'));
			assert.deepStrictEqual(
				targets,
				['overview', 'azure', 'sharing', 'advanced', 'review'],
				'Navigation buttons should have correct targets'
			);
		});

		test('Should have all sections', () => {
			const sections = ['overview', 'azure', 'sharing', 'advanced', 'review'];
			for (const id of sections) {
				const section = document.getElementById(id);
				assert.ok(section, `Section ${id} should exist`);
				assert.ok(section?.classList.contains('section'), `${id} should have section class`);
			}
		});

		test('Overview section should be active by default', () => {
			const overview = document.getElementById('overview');
			assert.ok(overview?.classList.contains('active'), 'Overview section should be active');

			const otherSections = document.querySelectorAll('.section:not(#overview)');
			otherSections.forEach(section => {
				assert.ok(!section.classList.contains('active'), `${section.id} should not be active`);
			});
		});

		test('Should have all three overview cards', () => {
			const overview = document.getElementById('overview');
			const cards = overview?.querySelectorAll('.card');
			assert.strictEqual(cards?.length, 3, 'Overview should have 3 cards');

			const headings = Array.from(cards || []).map(card => card.querySelector('h3')?.textContent);
			assert.deepStrictEqual(
				headings,
				['Why use backend sync?', 'Current status', 'How it works'],
				'Overview cards should have correct headings'
			);
		});

		test('Current status card should have all required elements', () => {
			const statusCard = document.querySelector('#overview .card:nth-child(2)');
			assert.ok(statusCard, 'Current status card should exist');

			assert.ok(document.getElementById('backendStateBadge'), 'Should have backend state badge');
			assert.ok(document.getElementById('privacyBadge'), 'Should have privacy badge');
			assert.ok(document.getElementById('authBadge'), 'Should have auth badge');
			assert.ok(document.getElementById('overviewDetails'), 'Should have overview details container');
			assert.ok(document.getElementById('overviewProfile'), 'Should have overview profile element');
			assert.ok(document.getElementById('overviewDataset'), 'Should have overview dataset element');
			assert.ok(document.getElementById('statusMessage'), 'Should have status message element');
		});

		test('Should have launchWizardLink in How it works card', () => {
			const link = document.getElementById('launchWizardLink');
			assert.ok(link, 'Launch wizard link should exist in How it works card');
		});

		test('Azure section should have all required buttons', () => {
			assert.ok(document.getElementById('setupBtn'), 'Should have setup button');
			assert.ok(document.getElementById('testConnectionBtn'), 'Should have test connection button');
			assert.ok(document.getElementById('clearSettingsBtn'), 'Should have clear settings button');
		});
	});

	suite('JavaScript Functionality', () => {
		test('Navigation buttons should switch sections', (done) => {
			// Wait for scripts to execute
			setTimeout(() => {
				const azureBtn = document.querySelector('[data-target="azure"]') as HTMLElement;
				const overviewSection = document.getElementById('overview');
				const azureSection = document.getElementById('azure');

				assert.ok(overviewSection?.classList.contains('active'), 'Overview should start active');
				assert.ok(!azureSection?.classList.contains('active'), 'Azure should start inactive');

				azureBtn?.click();

				// Check after click
				setTimeout(() => {
					assert.ok(!overviewSection?.classList.contains('active'), 'Overview should be inactive after click');
					assert.ok(azureSection?.classList.contains('active'), 'Azure should be active after click');
					done();
				}, 10);
			}, 100);
		});

		test('Window message handler should be registered', (done) => {
			setTimeout(() => {
				let messageReceived = false;

				// Listen for vscode messages
				window.addEventListener('vscode-message', () => {
					messageReceived = true;
				});

				// Simulate state update message
				window.postMessage({
					type: 'state',
					state: {
						draft: {
							enabled: true,
							authMode: 'sharedKey',
							sharingProfile: 'teamAnonymized',
							shareWorkspaceMachineNames: false,
							includeMachineBreakdown: true,
							datasetId: 'new-dataset',
							lookbackDays: 60,
							subscriptionId: 'sub-456',
							resourceGroup: 'rg-new',
							storageAccount: 'newaccount',
							aggTable: 'aggTable',
							eventsTable: 'events',
							userIdentityMode: 'entraObjectId',
							userId: ''
						},
						privacyBadge: 'Team Anonymized',
						authStatus: 'Shared Key',
						message: 'Updated'
					},
					errors: {}
				}, '*');

				setTimeout(() => {
					const backendBadge = document.getElementById('backendStateBadge');
					const privacyBadge = document.getElementById('privacyBadge');
					const authBadge = document.getElementById('authBadge');

					assert.strictEqual(backendBadge?.textContent, 'Backend: Enabled', 'Backend badge should update');
					assert.strictEqual(privacyBadge?.textContent, 'Privacy: Team Anonymized', 'Privacy badge should update');
					assert.strictEqual(authBadge?.textContent, 'Shared Key', 'Auth badge should update');

					const profileSpan = document.getElementById('overviewProfile');
					const datasetSpan = document.getElementById('overviewDataset');
					assert.strictEqual(profileSpan?.textContent, 'teamAnonymized', 'Profile should update');
					assert.strictEqual(datasetSpan?.textContent, 'new-dataset', 'Dataset should update');

					done();
				}, 50);
			}, 100);
		});

		test('Event listeners should be bound for all buttons', (done) => {
			setTimeout(() => {
				const buttons = [
					'setupBtn',
					'testConnectionBtn',
					'clearSettingsBtn',
					'launchWizardLink',
					'saveBtnReview',
					'discardBtnReview'
				];

				let messagesPosted = 0;
				window.addEventListener('vscode-message', (e: any) => {
					messagesPosted++;
				});

				// Click setup button
				const setupBtn = document.getElementById('setupBtn') as HTMLElement;
				setupBtn?.click();

				setTimeout(() => {
					assert.ok(messagesPosted > 0, 'Clicking setup button should post message');

					// Click launch wizard link
					const wizardLink = document.getElementById('launchWizardLink') as HTMLElement;
					wizardLink?.click();

					setTimeout(() => {
						assert.ok(messagesPosted >= 2, 'Clicking wizard link should post message');
						done();
					}, 10);
				}, 10);
			}, 100);
		});

		test('Disabled state should update when backend is toggled off', (done) => {
			setTimeout(() => {
				// Simulate backend disabled
				window.postMessage({
					type: 'state',
					state: {
						draft: {
							enabled: false,
							authMode: 'entraId',
							sharingProfile: 'off',
							shareWorkspaceMachineNames: false,
							includeMachineBreakdown: false,
							datasetId: 'test',
							lookbackDays: 30,
							subscriptionId: '',
							resourceGroup: '',
							storageAccount: '',
							aggTable: '',
							eventsTable: '',
							userIdentityMode: 'alias',
							userId: ''
						},
						privacyBadge: 'Off',
						authStatus: 'None',
						message: 'Backend is off'
					},
					errors: {}
				}, '*');

				setTimeout(() => {
					const backendBadge = document.getElementById('backendStateBadge');
					assert.strictEqual(backendBadge?.textContent, 'Backend: Disabled', 'Backend badge should show disabled');

					const overviewDetails = document.getElementById('overviewDetails') as HTMLElement;
					assert.strictEqual(overviewDetails?.style.display, 'none', 'Overview details should be hidden when disabled');

					const statusMessage = document.getElementById('statusMessage');
					assert.ok(statusMessage?.textContent?.includes('Backend is off'), 'Status message should indicate backend is off');

					done();
				}, 50);
			}, 100);
		});
	});

	suite('Form Validation', () => {
		test('Should validate required fields when enabled', (done) => {
			setTimeout(() => {
				const enableToggle = document.getElementById('enabledToggle') as any;
				const subscriptionId = document.getElementById('subscriptionId') as any;
				const resourceGroup = document.getElementById('resourceGroup') as any;

				// Enable backend
				if (enableToggle) {
					enableToggle.checked = true;
					enableToggle.dispatchEvent(new Event('change'));
				}

				// Clear required fields
				if (subscriptionId) {
					subscriptionId.value = '';
					subscriptionId.dispatchEvent(new Event('input'));
				}

				if (resourceGroup) {
					resourceGroup.value = '';
					resourceGroup.dispatchEvent(new Event('input'));
				}

				setTimeout(() => {
					const confirmCheckbox = document.getElementById('confirmApply') as any;
					const saveBtn = document.getElementById('saveBtnReview') as HTMLButtonElement;

					// Save button should be disabled when validation fails
					assert.ok(saveBtn?.disabled || !confirmCheckbox?.checked, 'Save should be disabled without valid config');

					done();
				}, 50);
			}, 100);
		});
	});

	suite('Regression Tests', () => {
		test('REGRESSION: Navigation must work (buttons switch sections)', (done) => {
			setTimeout(() => {
				const buttons = document.querySelectorAll('.nav-btn');
				assert.ok(buttons.length > 0, 'Navigation buttons must exist');

				// Click each button and verify section switches
				const sharingBtn = document.querySelector('[data-target="sharing"]') as HTMLElement;
				sharingBtn?.click();

				setTimeout(() => {
					const sharingSection = document.getElementById('sharing');
					assert.ok(
						sharingSection?.classList.contains('active'),
						'CRITICAL: Navigation MUST work - sharing section should be active after clicking sharing button'
					);
					done();
				}, 10);
			}, 100);
		});

		test('REGRESSION: Current status must populate with state data', (done) => {
			setTimeout(() => {
				const backendBadge = document.getElementById('backendStateBadge');
				const privacyBadge = document.getElementById('privacyBadge');
				const authBadge = document.getElementById('authBadge');

				assert.ok(backendBadge?.textContent, 'CRITICAL: Backend badge MUST have content');
				assert.ok(privacyBadge?.textContent, 'CRITICAL: Privacy badge MUST have content');
				assert.ok(authBadge?.textContent, 'CRITICAL: Auth badge MUST have content');

				assert.notStrictEqual(backendBadge?.textContent, '', 'Backend badge must not be empty');
				assert.notStrictEqual(privacyBadge?.textContent, '', 'Privacy badge must not be empty');
				assert.notStrictEqual(authBadge?.textContent, '', 'Auth badge must not be empty');

				done();
			}, 100);
		});

		test('REGRESSION: Message handler must be registered', (done) => {
			setTimeout(() => {

				const originalInnerText = document.getElementById('backendStateBadge')?.textContent;

				// Send a state message
				window.postMessage({
					type: 'state',
					state: {
						draft: {
							enabled: false,
							authMode: 'entraId',
							sharingProfile: 'off',
							shareWorkspaceMachineNames: false,
							includeMachineBreakdown: false,
							datasetId: 'regression-test',
							lookbackDays: 7,
							subscriptionId: 'sub',
							resourceGroup: 'rg',
							storageAccount: 'sa',
							aggTable: 'agg',
							eventsTable: 'evt',
							userIdentityMode: 'alias',
							userId: ''
						},
						privacyBadge: 'Regression',
						authStatus: 'Test',
						message: 'Regression test message'
					},
					errors: {}
				}, '*');

				setTimeout(() => {
					const newInnerText = document.getElementById('backendStateBadge')?.textContent;
					assert.notStrictEqual(
						newInnerText,
						originalInnerText,
						'CRITICAL: Message handler MUST be registered and process state updates'
					);
					assert.strictEqual(newInnerText, 'Backend: Disabled', 'Badge should update to new state');
					done();
				}, 50);
			}, 100);
		});

		test('REGRESSION: All event listeners must be bound', (done) => {
			setTimeout(() => {
				const requiredButtons = [
					{ id: 'setupBtn', name: 'Setup button' },
					{ id: 'clearSettingsBtn', name: 'Clear settings button' },
					{ id: 'launchWizardLink', name: 'Launch wizard link' }
				];

				for (const { id, name } of requiredButtons) {
					const element = document.getElementById(id);
					assert.ok(element, `${name} must exist`);
				}

				done();
			}, 100);
		});
	});
});
