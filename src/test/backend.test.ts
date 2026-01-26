import * as assert from 'assert';

import {
	shouldPromptToSetSharedKey
} from '../extension';

import { buildBackendConfigClipboardPayload } from '../backend/copyConfig';
import { isBackendConfigured } from '../backend/settings';

suite('Extension Test Suite', () => {
	suite('Backend', () => {
		suite('Clipboard Payload', () => {
			test('Includes expected non-secret config and never includes secret key names', () => {
				const payload = buildBackendConfigClipboardPayload({
					enabled: true,
					backend: 'storageTables',
					authMode: 'sharedKey',
					datasetId: 'default',
					sharingProfile: 'soloFull',
					shareWithTeam: false,
					shareWorkspaceMachineNames: false,
					shareConsentAt: '',
					userIdentityMode: 'pseudonymous',
					userId: '',
					userIdMode: 'alias',
					subscriptionId: '00000000-0000-0000-0000-000000000000',
					resourceGroup: 'rg-test',
					storageAccount: 'staccttest',
					aggTable: 'usageAggDaily',
					eventsTable: 'usageEvents',
					lookbackDays: 30,
					includeMachineBreakdown: true
				});

				assert.strictEqual(payload.version, 1);
				assert.ok(typeof payload.timestamp === 'string' && payload.timestamp.length > 0);

			const backendKeys = Object.keys(payload.config).sort();
			assert.deepStrictEqual(
				backendKeys,
				[
					'aggTable',
					'authMode',
					'backend',
					'datasetId',
					'enabled',
					'eventsTable',
					'includeMachineBreakdown',
					'lookbackDays',
					'resourceGroup',
					'shareConsentAt',
					'shareWithTeam',
					'shareWorkspaceMachineNames',
					'sharingProfile',
					'storageAccount',
					'subscriptionId',
					'userIdMode',
					'userIdentityMode',
					'userId'
				].sort(),
				'Payload config should include all expected fields'
			);

			const json = JSON.stringify(payload);
			assert.ok(!json.includes('storageSharedKey'), 'Payload must not mention SecretStorage key names');
			assert.ok(!json.includes('copilotTokenTracker.backend.storageSharedKey'), 'Payload must not contain SecretStorage key prefix');
			assert.ok(!json.includes('backend.storageSharedKey'), 'Payload must not contain config key name for shared key');
		});
		});

		suite('Shared Key Prompt', () => {
			test('shouldPromptToSetSharedKey covers edge cases', () => {
				const cases: Array<{ authMode: any; storageAccount: string; sharedKey: any; expected: boolean; name: string }> = [
					{ name: 'EntraId never prompts', authMode: 'entraId', storageAccount: 'acct', sharedKey: undefined, expected: false },
					{ name: 'EntraId never prompts even with key', authMode: 'entraId', storageAccount: 'acct', sharedKey: 'key', expected: false },
					{ name: 'No prompt when storage account missing', authMode: 'sharedKey', storageAccount: '', sharedKey: undefined, expected: false },
					{ name: 'No prompt when storage account whitespace', authMode: 'sharedKey', storageAccount: '  ', sharedKey: undefined, expected: false },
					{ name: 'Prompt when sharedKey mode and key missing', authMode: 'sharedKey', storageAccount: 'acct', sharedKey: undefined, expected: true },
					{ name: 'Prompt when sharedKey mode and key empty', authMode: 'sharedKey', storageAccount: 'acct', sharedKey: '', expected: true },
					{ name: 'Prompt when sharedKey mode and key whitespace', authMode: 'sharedKey', storageAccount: 'acct', sharedKey: '  ', expected: true },
					{ name: 'No prompt when sharedKey mode and key is set', authMode: 'sharedKey', storageAccount: 'acct', sharedKey: 'mykey', expected: false }
				];

				for (const c of cases) {
					assert.strictEqual(
						shouldPromptToSetSharedKey(c.authMode, c.storageAccount, c.sharedKey),
						c.expected,
						c.name
					);
				}
			});
		});

		suite('Configuration Validation', () => {
			test('isBackendConfigured returns false when required fields are missing', () => {
				assert.strictEqual(
				isBackendConfigured({
						enabled: true,
						backend: 'storageTables' as any,
						authMode: 'entraId' as any,
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
						aggTable: 'table',
						eventsTable: '',
						lookbackDays: 30,
						includeMachineBreakdown: true
					}),
					false,
					'Should return false when subscriptionId is empty'
				);

				assert.strictEqual(
					isBackendConfigured({
						enabled: true,
						backend: 'storageTables' as any,
						authMode: 'entraId' as any,
						datasetId: 'default',
							sharingProfile: 'off',
							shareWithTeam: false,
							shareWorkspaceMachineNames: false,
							shareConsentAt: '',
							userIdentityMode: 'pseudonymous',
							userId: '',
							userIdMode: 'alias',
						subscriptionId: 'sub',
						resourceGroup: '',
						storageAccount: 'sa',
						aggTable: 'table',
						eventsTable: '',
						lookbackDays: 30,
						includeMachineBreakdown: true
					}),
					false,
					'Should return false when resourceGroup is empty'
				);

				assert.strictEqual(
					isBackendConfigured({
						enabled: true,
						backend: 'storageTables' as any,
						authMode: 'entraId' as any,
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
						storageAccount: '',
						aggTable: 'table',
						eventsTable: '',
						lookbackDays: 30,
						includeMachineBreakdown: true
					}),
					false,
					'Should return false when storageAccount is empty'
				);

				assert.strictEqual(
					isBackendConfigured({
						enabled: true,
						backend: 'storageTables' as any,
						authMode: 'entraId' as any,
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
						aggTable: '',
						eventsTable: '',
						lookbackDays: 30,
						includeMachineBreakdown: true
					}),
					false,
					'Should return false when aggTable is empty'
				);

				assert.strictEqual(
					isBackendConfigured({
						enabled: true,
						backend: 'storageTables' as any,
						authMode: 'entraId' as any,
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
						aggTable: 'table',
						eventsTable: '',
						lookbackDays: 30,
						includeMachineBreakdown: true
					}),
					true,
					'Should return true when required fields are present'
				);
			});
		});
	});
});
