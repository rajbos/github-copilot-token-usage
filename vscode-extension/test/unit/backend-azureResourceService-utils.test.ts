import './vscode-shim-register';
import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

test('AzureResourceService - buildProfileOptions returns correct options', () => {
	(vscode as any).__mock.reset();
	
	const deps = {
		log: () => {},
		getSettings: () => ({}),
		startTimerIfEnabled: () => {},
		syncToBackendStore: async () => {},
		clearQueryCache: () => {}
	};
	
	delete require.cache[require.resolve('../../src/backend/services/azureResourceService')];
	const { AzureResourceService } = require('../../src/backend/services/azureResourceService');
	
	const credentialService = {} as any;
	const dataPlaneService = {} as any;
	
	const svc = new AzureResourceService(deps as any, credentialService, dataPlaneService);
	
	// Access private method
	const options = (svc as any).buildProfileOptions();
	
	// Verify structure
	assert.equal(options.length, 5, 'Should have 5 profile options');
	
	// Verify each option has required fields
	for (const option of options) {
		assert.ok(option.label, 'Should have label');
		assert.ok(option.description, 'Should have description');
		assert.ok(option.detail, 'Should have detail');
		assert.ok(option.profile, 'Should have profile');
		assert.ok(typeof option.sharingLevel === 'number', 'Should have sharingLevel as number');
	}
	
	// Verify specific profiles
	const profiles = options.map((o: { profile: string }) => o.profile);
	assert.ok(profiles.includes('off'));
	assert.ok(profiles.includes('teamAnonymized'));
	assert.ok(profiles.includes('teamPseudonymous'));
	assert.ok(profiles.includes('teamIdentified'));
	assert.ok(profiles.includes('soloFull'));
	
	// Verify sharing levels are in order
	const levels = options.map((o: { sharingLevel: number }) => o.sharingLevel);
	assert.deepEqual(levels, [0, 1, 2, 3, 4]);
});

test('AzureResourceService - getProfileDefaults returns correct defaults for teamPseudonymous', () => {
	(vscode as any).__mock.reset();
	
	const config = {
		get: (key: string, defaultValue: any) => defaultValue
	} as any;
	
	const deps = {
		log: () => {},
		getSettings: () => ({}),
		startTimerIfEnabled: () => {},
		syncToBackendStore: async () => {},
		clearQueryCache: () => {}
	};
	
	delete require.cache[require.resolve('../../src/backend/services/azureResourceService')];
	const { AzureResourceService } = require('../../src/backend/services/azureResourceService');
	
	const credentialService = {} as any;
	const dataPlaneService = {} as any;
	
	const svc = new AzureResourceService(deps as any, credentialService, dataPlaneService);
	
	// Access private method
	const defaults = (svc as any).getProfileDefaults('teamPseudonymous', config);
	
	assert.equal(defaults.shareWithTeam, true);
	assert.equal(defaults.shareWorkspaceMachineNames, false);
	assert.equal(defaults.userId, '');
	assert.equal(defaults.userIdMode, 'alias');
	assert.equal(defaults.userIdentityMode, 'pseudonymous');
	assert.ok(defaults.shareConsentAt, 'Should have shareConsentAt timestamp');
});

test('AzureResourceService - getProfileDefaults returns correct defaults for teamIdentified with existing config', () => {
	(vscode as any).__mock.reset();
	
	const config = {
		get: (key: string, defaultValue: any) => {
			if (key === 'backend.userIdentityMode') {return 'teamAlias';}
			if (key === 'backend.userId') {return 'test-user';}
			if (key === 'backend.userIdMode') {return 'alias';}
			return defaultValue;
		}
	} as any;
	
	const deps = {
		log: () => {},
		getSettings: () => ({}),
		startTimerIfEnabled: () => {},
		syncToBackendStore: async () => {},
		clearQueryCache: () => {}
	};
	
	delete require.cache[require.resolve('../../src/backend/services/azureResourceService')];
	const { AzureResourceService } = require('../../src/backend/services/azureResourceService');
	
	const credentialService = {} as any;
	const dataPlaneService = {} as any;
	
	const svc = new AzureResourceService(deps as any, credentialService, dataPlaneService);
	
	// Access private method
	const defaults = (svc as any).getProfileDefaults('teamIdentified', config);
	
	assert.equal(defaults.shareWithTeam, true);
	assert.equal(defaults.shareWorkspaceMachineNames, false);
	assert.equal(defaults.userId, 'test-user');
	assert.equal(defaults.userIdMode, 'alias');
	assert.equal(defaults.userIdentityMode, 'teamAlias');
	assert.ok(defaults.shareConsentAt, 'Should have shareConsentAt timestamp');
});

test('AzureResourceService - getProfileDefaults returns correct defaults for off', () => {
	(vscode as any).__mock.reset();
	
	const config = {
		get: (key: string, defaultValue: any) => defaultValue
	} as any;
	
	const deps = {
		log: () => {},
		getSettings: () => ({}),
		startTimerIfEnabled: () => {},
		syncToBackendStore: async () => {},
		clearQueryCache: () => {}
	};
	
	delete require.cache[require.resolve('../../src/backend/services/azureResourceService')];
	const { AzureResourceService } = require('../../src/backend/services/azureResourceService');
	
	const credentialService = {} as any;
	const dataPlaneService = {} as any;
	
	const svc = new AzureResourceService(deps as any, credentialService, dataPlaneService);
	
	// Access private method
	const defaults = (svc as any).getProfileDefaults('off', config);
	
	assert.equal(defaults.shareWithTeam, false);
	assert.equal(defaults.shareWorkspaceMachineNames, false);
	assert.equal(defaults.userId, '');
	assert.equal(defaults.userIdMode, 'alias');
	assert.equal(defaults.userIdentityMode, 'pseudonymous');
	assert.equal(defaults.shareConsentAt, '');
});

test('AzureResourceService - getProfileDefaults returns correct defaults for soloFull', () => {
	(vscode as any).__mock.reset();
	
	const config = {
		get: (key: string, defaultValue: any) => defaultValue
	} as any;
	
	const deps = {
		log: () => {},
		getSettings: () => ({}),
		startTimerIfEnabled: () => {},
		syncToBackendStore: async () => {},
		clearQueryCache: () => {}
	};
	
	delete require.cache[require.resolve('../../src/backend/services/azureResourceService')];
	const { AzureResourceService } = require('../../src/backend/services/azureResourceService');
	
	const credentialService = {} as any;
	const dataPlaneService = {} as any;
	
	const svc = new AzureResourceService(deps as any, credentialService, dataPlaneService);
	
	// Access private method
	const defaults = (svc as any).getProfileDefaults('soloFull', config);
	
	assert.equal(defaults.shareWithTeam, false);
	assert.equal(defaults.shareWorkspaceMachineNames, true);
	assert.equal(defaults.userId, '');
	assert.equal(defaults.userIdMode, 'alias');
	assert.equal(defaults.userIdentityMode, 'pseudonymous');
	assert.equal(defaults.shareConsentAt, '');
});

test('AzureResourceService - maybeAskNamesForTeamProfile returns undefined for non-team profiles', async () => {
	(vscode as any).__mock.reset();
	
	const deps = {
		log: () => {},
		getSettings: () => ({}),
		startTimerIfEnabled: () => {},
		syncToBackendStore: async () => {},
		clearQueryCache: () => {}
	};
	
	delete require.cache[require.resolve('../../src/backend/services/azureResourceService')];
	const { AzureResourceService } = require('../../src/backend/services/azureResourceService');
	
	const credentialService = {} as any;
	const dataPlaneService = {} as any;
	
	const svc = new AzureResourceService(deps as any, credentialService, dataPlaneService);
	
	// Access private method
	const result = await (svc as any).maybeAskNamesForTeamProfile('off', 0, 0);
	
	assert.equal(result, undefined);
});

test('AzureResourceService - maybeAskNamesForTeamProfile returns undefined when new level <= current', async () => {
	(vscode as any).__mock.reset();
	
	const deps = {
		log: () => {},
		getSettings: () => ({}),
		startTimerIfEnabled: () => {},
		syncToBackendStore: async () => {},
		clearQueryCache: () => {}
	};
	
	delete require.cache[require.resolve('../../src/backend/services/azureResourceService')];
	const { AzureResourceService } = require('../../src/backend/services/azureResourceService');
	
	const credentialService = {} as any;
	const dataPlaneService = {} as any;
	
	const svc = new AzureResourceService(deps as any, credentialService, dataPlaneService);
	
	// Access private method - teamPseudonymous has level 2, current is 2
	const result = await (svc as any).maybeAskNamesForTeamProfile('teamPseudonymous', 2, 2);
	
	assert.equal(result, undefined);
});

test('AzureResourceService - maybeAskNamesForTeamProfile returns boolean for team profiles with higher level', async () => {
	(vscode as any).__mock.reset();
	
	let quickPickResult: any = null;
	
	const windowMock = vscode.window as any;
	windowMock.showQuickPick = async (items: any[], options?: any) => {
		quickPickResult = items[0];
		return items[0];
	};
	
	const deps = {
		log: () => {},
		getSettings: () => ({}),
		startTimerIfEnabled: () => {},
		syncToBackendStore: async () => {},
		clearQueryCache: () => {}
	};
	
	delete require.cache[require.resolve('../../src/backend/services/azureResourceService')];
	const { AzureResourceService } = require('../../src/backend/services/azureResourceService');
	
	const credentialService = {} as any;
	const dataPlaneService = {} as any;
	
	const svc = new AzureResourceService(deps as any, credentialService, dataPlaneService);
	
	// Access private method - teamPseudonymous has level 2, current is 0
	const result = await (svc as any).maybeAskNamesForTeamProfile('teamPseudonymous', 2, 0);
	
	assert.equal(result, false); // First option has shareNames: false
	assert.ok(quickPickResult, 'Should have called showQuickPick');
});

// Test for confirmMorePermissiveProfile method
test('AzureResourceService - confirmMorePermissiveProfile returns true when user confirms', async () => {
	(vscode as any).__mock.reset();
	let warningMessage: string | undefined;
	let warningOptions: any;
	const windowMock = vscode.window as any;
	windowMock.showWarningMessage = async (message: string, options: any, ...items: any[]) => {
		warningMessage = message;
		warningOptions = options;
		return 'Yes, Enable';
	};
	const deps = {
		log: () => {},
		getSettings: () => ({}),
		startTimerIfEnabled: () => {},
		syncToBackendStore: async () => {},
		clearQueryCache: () => {}
	};
	delete require.cache[require.resolve('../../src/backend/services/azureResourceService')];
	const { AzureResourceService } = require('../../src/backend/services/azureResourceService');
	const credentialService = {} as any;
	const dataPlaneService = {} as any;
	const svc = new AzureResourceService(deps as any, credentialService, dataPlaneService);
	const result = await (svc as any).confirmMorePermissiveProfile('Team / Identified', 'Some detail');
	assert.equal(result, true);
	assert.ok(warningMessage?.includes('Team / Identified'));
	assert.ok(warningMessage?.includes('Some detail'));
	assert.equal(warningOptions?.modal, true);
});

test('AzureResourceService - confirmMorePermissiveProfile returns false when user cancels', async () => {
	(vscode as any).__mock.reset();
	const windowMock = vscode.window as any;
	windowMock.showWarningMessage = async () => undefined;
	const deps = {
		log: () => {},
		getSettings: () => ({}),
		startTimerIfEnabled: () => {},
		syncToBackendStore: async () => {},
		clearQueryCache: () => {}
	};
	delete require.cache[require.resolve('../../src/backend/services/azureResourceService')];
	const { AzureResourceService } = require('../../src/backend/services/azureResourceService');
	const credentialService = {} as any;
	const dataPlaneService = {} as any;
	const svc = new AzureResourceService(deps as any, credentialService, dataPlaneService);
	const result = await (svc as any).confirmMorePermissiveProfile('Team / Identified', 'Some detail');
	assert.equal(result, false);
});

test('AzureResourceService - pickAuthMode returns entraId when selected', async () => {
	(vscode as any).__mock.reset();
	const windowMock = vscode.window as any;
	windowMock.showQuickPick = async (items: any[], options?: any) => {
		return items.find((i: any) => i.authMode === 'entraId');
	};
	const deps = {
		log: () => {},
		getSettings: () => ({}),
		startTimerIfEnabled: () => {},
		syncToBackendStore: async () => {},
		clearQueryCache: () => {}
	};
	delete require.cache[require.resolve('../../src/backend/services/azureResourceService')];
	const { AzureResourceService } = require('../../src/backend/services/azureResourceService');
	const credentialService = {} as any;
	const dataPlaneService = {} as any;
	const svc = new AzureResourceService(deps as any, credentialService, dataPlaneService);
	const result = await (svc as any)._pickAuthMode();
	assert.equal(result, 'entraId');
});

test('AzureResourceService - pickAuthMode returns sharedKey when selected', async () => {
	(vscode as any).__mock.reset();
	const windowMock = vscode.window as any;
	windowMock.showQuickPick = async (items: any[], options?: any) => {
		return items.find((i: any) => i.authMode === 'sharedKey');
	};
	const deps = {
		log: () => {},
		getSettings: () => ({}),
		startTimerIfEnabled: () => {},
		syncToBackendStore: async () => {},
		clearQueryCache: () => {}
	};
	delete require.cache[require.resolve('../../src/backend/services/azureResourceService')];
	const { AzureResourceService } = require('../../src/backend/services/azureResourceService');
	const credentialService = {} as any;
	const dataPlaneService = {} as any;
	const svc = new AzureResourceService(deps as any, credentialService, dataPlaneService);
	const result = await (svc as any)._pickAuthMode();
	assert.equal(result, 'sharedKey');
});

test('AzureResourceService - pickAuthMode returns null when cancelled', async () => {
	(vscode as any).__mock.reset();
	const windowMock = vscode.window as any;
	windowMock.showQuickPick = async () => undefined;
	const deps = {
		log: () => {},
		getSettings: () => ({}),
		startTimerIfEnabled: () => {},
		syncToBackendStore: async () => {},
		clearQueryCache: () => {}
	};
	delete require.cache[require.resolve('../../src/backend/services/azureResourceService')];
	const { AzureResourceService } = require('../../src/backend/services/azureResourceService');
	const credentialService = {} as any;
	const dataPlaneService = {} as any;
	const svc = new AzureResourceService(deps as any, credentialService, dataPlaneService);
	const result = await (svc as any)._pickAuthMode();
	assert.equal(result, null);
});

test('AzureResourceService - _configureTableSettings returns config with all inputs', async () => {
	(vscode as any).__mock.reset();
	const config = {
		get: (key: string, defaultValue: any) => {
			if (key === 'backend.aggTable') {return 'usageAggDaily';}
			if (key === 'backend.datasetId') {return 'default';}
			return defaultValue;
		},
		update: async () => {}
	} as any;
	const windowMock = vscode.window as any;
	windowMock.showInputBox = async (options: any) => {
		if (options?.title?.includes('Aggregate Table')) {return 'my-agg-table';}
		if (options?.title?.includes('Dataset ID')) {return 'my-dataset';}
		return undefined;
	};
	windowMock.showQuickPick = async (items: any[], options?: any) => {
		if (options?.title?.includes('Events Table')) {return items[0];}
		return undefined;
	};
	const deps = {
		log: () => {},
		getSettings: () => ({}),
		startTimerIfEnabled: () => {},
		syncToBackendStore: async () => {},
		clearQueryCache: () => {}
	};
	delete require.cache[require.resolve('../../src/backend/services/azureResourceService')];
	const { AzureResourceService } = require('../../src/backend/services/azureResourceService');
	const credentialService = {} as any;
	const dataPlaneService = {} as any;
	const svc = new AzureResourceService(deps as any, credentialService, dataPlaneService);
	const result = await (svc as any)._configureTableSettings(config);
	assert.notEqual(result, null);
	assert.equal(result.aggTable, 'my-agg-table');
	assert.equal(result.datasetId, 'my-dataset');
});

test('AzureResourceService - _configureTableSettings returns null when cancelled', async () => {
	(vscode as any).__mock.reset();
	const config = {
		get: () => 'default',
		update: async () => {}
	} as any;
	const windowMock = vscode.window as any;
	windowMock.showInputBox = async () => undefined;
	const deps = {
		log: () => {},
		getSettings: () => ({}),
		startTimerIfEnabled: () => {},
		syncToBackendStore: async () => {},
		clearQueryCache: () => {}
	};
	delete require.cache[require.resolve('../../src/backend/services/azureResourceService')];
	const { AzureResourceService } = require('../../src/backend/services/azureResourceService');
	const credentialService = {} as any;
	const dataPlaneService = {} as any;
	const svc = new AzureResourceService(deps as any, credentialService, dataPlaneService);
	const result = await (svc as any)._configureTableSettings(config);
	assert.equal(result, null);
});

test('AzureResourceService - _pickTeamIdentity returns teamAlias with valid input', async () => {
	(vscode as any).__mock.reset();
	const config = {
		get: (key: string, defaultValue: any) => {
			if (key === 'backend.userId') {return 'test-user';}
			return defaultValue;
		}
	} as any;
	const windowMock = vscode.window as any;
	windowMock.showQuickPick = async (items: any[], options?: any) => {
		return items.find((i: any) => i.mode === 'teamAlias');
	};
	windowMock.showInputBox = async (options: any) => {
		return 'my-alias';
	};
	const deps = {
		log: () => {},
		getSettings: () => ({}),
		startTimerIfEnabled: () => {},
		syncToBackendStore: async () => {},
		clearQueryCache: () => {}
	};
	delete require.cache[require.resolve('../../src/backend/services/azureResourceService')];
	const { AzureResourceService } = require('../../src/backend/services/azureResourceService');
	const credentialService = {} as any;
	const dataPlaneService = {} as any;
	const svc = new AzureResourceService(deps as any, credentialService, dataPlaneService);
	const result = await (svc as any)._pickTeamIdentity(config);
	assert.notEqual(result, null);
	assert.equal(result.userIdentityMode, 'teamAlias');
	assert.equal(result.userId, 'my-alias');
	assert.equal(result.userIdMode, 'alias');
});

test('AzureResourceService - _pickTeamIdentity returns entraObjectId with valid GUID', async () => {
	(vscode as any).__mock.reset();
	const config = {
		get: () => ''
	} as any;
	const windowMock = vscode.window as any;
	windowMock.showQuickPick = async (items: any[], options?: any) => {
		return items.find((i: any) => i.mode === 'entraObjectId');
	};
	windowMock.showInputBox = async (options: any) => {
		return '00000000-0000-0000-0000-000000000000';
	};
	const deps = {
		log: () => {},
		getSettings: () => ({}),
		startTimerIfEnabled: () => {},
		syncToBackendStore: async () => {},
		clearQueryCache: () => {}
	};
	delete require.cache[require.resolve('../../src/backend/services/azureResourceService')];
	const { AzureResourceService } = require('../../src/backend/services/azureResourceService');
	const credentialService = {} as any;
	const dataPlaneService = {} as any;
	const svc = new AzureResourceService(deps as any, credentialService, dataPlaneService);
	const result = await (svc as any)._pickTeamIdentity(config);
	assert.notEqual(result, null);
	assert.equal(result.userIdentityMode, 'entraObjectId');
	assert.equal(result.userId, '00000000-0000-0000-0000-000000000000');
	assert.equal(result.userIdMode, 'custom');
});

test('AzureResourceService - _pickTeamIdentity returns null when cancelled', async () => {
	(vscode as any).__mock.reset();
	const config = {
		get: () => ''
	} as any;
	const windowMock = vscode.window as any;
	windowMock.showQuickPick = async () => undefined;
	const deps = {
		log: () => {},
		getSettings: () => ({}),
		startTimerIfEnabled: () => {},
		syncToBackendStore: async () => {},
		clearQueryCache: () => {}
	};
	delete require.cache[require.resolve('../../src/backend/services/azureResourceService')];
	const { AzureResourceService } = require('../../src/backend/services/azureResourceService');
	const credentialService = {} as any;
	const dataPlaneService = {} as any;
	const svc = new AzureResourceService(deps as any, credentialService, dataPlaneService);
	const result = await (svc as any)._pickTeamIdentity(config);
	assert.equal(result, null);
});

test('AzureResourceService - _handlePolicyBlockedStorageCreation returns existing storage account when policy blocked', async () => {
	(vscode as any).__mock.reset();
	const windowMock = vscode.window as any;
	windowMock.showWarningMessage = async (message: string, options: any, ...items: any[]) => {
		return 'Choose existing Storage account';
	};
	windowMock.showQuickPick = async (items: any[], options?: any) => {
		return items.find((i: any) => i.label === 'sa-existing');
	};
	const deps = {
		log: () => {},
		getSettings: () => ({}),
		startTimerIfEnabled: () => {},
		syncToBackendStore: async () => {},
		clearQueryCache: () => {}
	};
	delete require.cache[require.resolve('../../src/backend/services/azureResourceService')];
	const { AzureResourceService } = require('../../src/backend/services/azureResourceService');
	const credentialService = {} as any;
	const dataPlaneService = {} as any;
	const svc = new AzureResourceService(deps as any, credentialService, dataPlaneService);
	const error = new Error('policy block');
	(error as any).code = 'RequestDisallowedByPolicy';
	const result = await (svc as any)._handlePolicyBlockedStorageCreation(error, ['sa-existing', 'sa-other'], 'rg-test');
	assert.equal(result, 'sa-existing');
});

test('AzureResourceService - _handlePolicyBlockedStorageCreation returns null when user cancels', async () => {
	(vscode as any).__mock.reset();
	const windowMock = vscode.window as any;
	windowMock.showWarningMessage = async () => undefined;
	const deps = {
		log: () => {},
		getSettings: () => ({}),
		startTimerIfEnabled: () => {},
		syncToBackendStore: async () => {},
		clearQueryCache: () => {}
	};
	delete require.cache[require.resolve('../../src/backend/services/azureResourceService')];
	const { AzureResourceService } = require('../../src/backend/services/azureResourceService');
	const credentialService = {} as any;
	const dataPlaneService = {} as any;
	const svc = new AzureResourceService(deps as any, credentialService, dataPlaneService);
	const error = new Error('policy block');
	(error as any).code = 'RequestDisallowedByPolicy';
	const result = await (svc as any)._handlePolicyBlockedStorageCreation(error, ['sa-existing'], 'rg-test');
	assert.equal(result, null);
});

test('AzureResourceService - _configureSharingProfile returns soloFull profile', async () => {
	(vscode as any).__mock.reset();
	const config = {
		get: (key: string, defaultValue: any) => defaultValue
	} as any;
	const windowMock = vscode.window as any;
	windowMock.showQuickPick = async (items: any[], options?: any) => {
		if (options?.title?.includes('Sharing Profile')) {
			return items.find((i: any) => i.profile === 'soloFull');
		}
		return undefined;
	};
	const deps = {
		log: () => {},
		getSettings: () => ({}),
		startTimerIfEnabled: () => {},
		syncToBackendStore: async () => {},
		clearQueryCache: () => {}
	};
	delete require.cache[require.resolve('../../src/backend/services/azureResourceService')];
	const { AzureResourceService } = require('../../src/backend/services/azureResourceService');
	const credentialService = {} as any;
	const dataPlaneService = {} as any;
	const svc = new AzureResourceService(deps as any, credentialService, dataPlaneService);
	const result = await (svc as any)._configureSharingProfile(config, 'entraId');
	assert.notEqual(result, null);
	assert.equal(result.sharingProfile, 'soloFull');
	assert.equal(result.shareWithTeam, false);
	assert.equal(result.shareWorkspaceMachineNames, true);
});

test('AzureResourceService - _configureSharingProfile returns teamAnonymized profile', async () => {
	(vscode as any).__mock.reset();
	const config = {
		get: (key: string, defaultValue: any) => defaultValue
	} as any;
	const windowMock = vscode.window as any;
	windowMock.showQuickPick = async (items: any[], options?: any) => {
		if (options?.title?.includes('Sharing Profile')) {
			return items.find((i: any) => i.profile === 'teamAnonymized');
		}
		return undefined;
	};
	const deps = {
		log: () => {},
		getSettings: () => ({}),
		startTimerIfEnabled: () => {},
		syncToBackendStore: async () => {},
		clearQueryCache: () => {}
	};
	delete require.cache[require.resolve('../../src/backend/services/azureResourceService')];
	const { AzureResourceService } = require('../../src/backend/services/azureResourceService');
	const credentialService = {} as any;
	const dataPlaneService = {} as any;
	const svc = new AzureResourceService(deps as any, credentialService, dataPlaneService);
	const result = await (svc as any)._configureSharingProfile(config, 'entraId');
	assert.notEqual(result, null);
	assert.equal(result.sharingProfile, 'teamAnonymized');
	assert.equal(result.shareWithTeam, false);
	assert.equal(result.shareWorkspaceMachineNames, false);
});
