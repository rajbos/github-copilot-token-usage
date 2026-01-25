import './vscode-shim-register';
import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as Module from 'node:module';
import * as vscode from 'vscode';

const requireCjs = Module.createRequire(__filename);

type CacheEntry = any;

function setMockModule(path: string, exports: any): CacheEntry | undefined {
	const existing = requireCjs.cache[path] as CacheEntry | undefined;
	requireCjs.cache[path] = { id: path, filename: path, loaded: true, exports } as CacheEntry;
	return existing;
}

function restoreModule(path: string, entry: CacheEntry | undefined): void {
	if (entry) {
		requireCjs.cache[path] = entry;
	} else {
		delete requireCjs.cache[path];
	}
}

function getWindowMock() {
	return vscode.window as unknown as {
		showQuickPick: typeof vscode.window.showQuickPick;
		showInputBox: typeof vscode.window.showInputBox;
		showWarningMessage: typeof vscode.window.showWarningMessage;
		showErrorMessage: typeof vscode.window.showErrorMessage;
		showInformationMessage: typeof vscode.window.showInformationMessage;
	};
}

test('configureBackendWizard handles policy-blocked storage creation and falls back to existing account', async () => {
	(vscode as any).__mock.reset();
	const warningMessages: string[] = [];
	const errorMessages: string[] = [];
	const infoMessages: string[] = [];

	const subscriptionPath = requireCjs.resolve('@azure/arm-subscriptions');
	const resourcesPath = requireCjs.resolve('@azure/arm-resources');
	const storagePath = requireCjs.resolve('@azure/arm-storage');
	const tablesPath = requireCjs.resolve('@azure/data-tables');
	const blobsPath = requireCjs.resolve('@azure/storage-blob');

	const subBackup = setMockModule(subscriptionPath, {
		SubscriptionClient: class {
			subscriptions = {
				async *list() {
					yield { subscriptionId: 'sub-1', displayName: 'Primary Sub' };
				}
			};
		}
	});

	const resourcesBackup = setMockModule(resourcesPath, {
		ResourceManagementClient: class {
			resourceGroups = {
				async *list() {
					yield { name: 'rg-existing' };
				},
				async get() {
					return { location: 'eastus' };
				}
			};
		}
	});

	let createAttempts = 0;
	const storageBackup = setMockModule(storagePath, {
		StorageManagementClient: class {
			storageAccounts = {
				async *listByResourceGroup() {
					yield { name: 'sa-existing' };
				},
				async beginCreateAndWait() {
					createAttempts += 1;
					const error = new Error('policy block');
					(error as any).code = 'RequestDisallowedByPolicy';
					throw error;
				}
			};
		}
	});

	const tablesBackup = setMockModule(tablesPath, {
		TableServiceClient: class {
			constructor(public _endpoint: string, public _cred: any) {}
			async createTable() {}
		}
	});

	const blobsBackup = setMockModule(blobsPath, {
		BlobServiceClient: class {
			constructor(public endpoint: string, public _cred: any) {}
			getContainerClient() {
				return { async createIfNotExists() {} };
			}
		}
	});

	const warningsQueue = ['Choose existing Storage account'];
	const quickPick = async (items: any[], options?: any) => {
		const title = options?.title ?? '';
		if (title.includes('subscription') || title.includes('Subscription')) {
			return items[0];
		}
		if (title.includes('resource group') || title.includes('Resource Group')) {
			return items.find((i: any) => i.description === 'Existing resource group') ?? items[0];
		}
		if (title.includes('Storage Account')) {
			return items[0]; // create new storage account
		}
		if (title.includes('Location')) {
			return 'eastus';
		}
		if (title.includes('Authentication') || title.includes('authentication mode')) {
			return items[0];
		}
		if (title.includes('Sharing Profile')) {
			return items.find((i: any) => i.profile === 'teamAnonymized') ?? items[0];
		}
		if (title.includes('Events Table') || title.includes('optional usageEvents')) {
			return 'No (recommended)';
		}
		if (title.includes('Raw Container') || title.includes('optional raw blob')) {
			return 'No (recommended)';
		}
		if (title.includes('existing Storage account')) {
			return items.find((i: any) => i.label === 'sa-existing') ?? items[0];
		}
		return undefined;
	};

	const inputBoxQueue = ['newstorage01', 'usageAggDaily', 'dataset-1'];
	const inputBox = async () => inputBoxQueue.shift();

	const windowMock = getWindowMock();
	windowMock.showQuickPick = quickPick as any;
	windowMock.showInputBox = inputBox as any;
	windowMock.showWarningMessage = async (message: string) => {
		warningMessages.push(message);
		return warningsQueue.shift();
	};
	windowMock.showErrorMessage = async (message: string) => {
		errorMessages.push(message);
		return undefined;
	};
	windowMock.showInformationMessage = async (message: string) => {
		infoMessages.push(message);
		return undefined;
	};

	const credentialService = {
		createAzureCredential: () => ({
			async getToken() {
				return { token: 'tok' } as any;
			}
		}),
		async getBackendDataPlaneCredentials() {
			return { tableCredential: {}, blobCredential: {}, secretsToRedact: [] };
		}
	} as any;

	let ensureTableCalled = false;
	let validateAccessCalled = false;
	const dataPlaneService = {
		async ensureTableExists() {
			ensureTableCalled = true;
		},
		async validateAccess() {
			validateAccessCalled = true;
		},
		getStorageBlobEndpoint: (account: string) => `https://${account}.blob.core.windows.net`
	} as any;

	const settings = {
		enabled: true,
		backend: 'storageTables',
		authMode: 'entraId',
		datasetId: 'dataset-1',
		sharingProfile: 'teamAnonymized',
		shareWithTeam: false,
		shareWorkspaceMachineNames: false,
		shareConsentAt: '',
		userIdentityMode: 'pseudonymous',
		userId: '',
		userIdMode: 'alias',
		subscriptionId: 'sub-1',
		resourceGroup: 'rg-existing',
		storageAccount: 'sa-existing',
		aggTable: 'usageAggDaily',
		eventsTable: 'usageEvents',
		rawContainer: 'raw-usage',
		lookbackDays: 30,
		includeMachineBreakdown: true
	};

	const deps = {
		log: () => {},
		updateTokenStats: async () => {},
		getSettings: () => settings,
		startTimerIfEnabled: () => {},
		syncToBackendStore: async () => {},
		clearQueryCache: () => {}
	};

	delete requireCjs.cache[requireCjs.resolve('../backend/services/azureResourceService')];
	const { AzureResourceService } = requireCjs('../backend/services/azureResourceService');
	const svc = new AzureResourceService(deps as any, credentialService, dataPlaneService);
	await svc.configureBackendWizard();

	assert.equal(createAttempts, 1, 'should attempt storage creation once');
	assert.ok(warningMessages.some(m => m.includes('blocked by Azure Policy')));
	assert.equal(errorMessages.length, 0);
	assert.equal(infoMessages.pop(), 'Backend sync configured. Initial sync completed (or queued).');
	assert.ok(ensureTableCalled);
	assert.ok(validateAccessCalled);

	restoreModule(subscriptionPath, subBackup);
	restoreModule(resourcesPath, resourcesBackup);
	restoreModule(storagePath, storageBackup);
	restoreModule(tablesPath, tablesBackup);
	restoreModule(blobsPath, blobsBackup);
});

test('configureBackendWizard disables Shared Key when Entra ID auth is selected', async () => {
	(vscode as any).__mock.reset();

	const subscriptionPath = requireCjs.resolve('@azure/arm-subscriptions');
	const resourcesPath = requireCjs.resolve('@azure/arm-resources');
	const storagePath = requireCjs.resolve('@azure/arm-storage');
	const tablesPath = requireCjs.resolve('@azure/data-tables');
	const blobsPath = requireCjs.resolve('@azure/storage-blob');

	const subBackup = setMockModule(subscriptionPath, {
		SubscriptionClient: class {
			subscriptions = {
				async *list() {
					yield { subscriptionId: 'sub-1', displayName: 'Primary Sub' };
				}
			};
		}
	});

	const resourcesBackup = setMockModule(resourcesPath, {
		ResourceManagementClient: class {
			resourceGroups = {
				async *list() {
					yield { name: 'rg-existing', location: 'eastus' };
				},
				async get() {
					return { location: 'eastus' };
				}
			};
		}
	});

	let createParams: any | undefined;
	const storageBackup = setMockModule(storagePath, {
		StorageManagementClient: class {
			storageAccounts = {
				async *listByResourceGroup() {
					yield { name: 'sa-existing' };
				},
				async beginCreateAndWait(_rg: string, _sa: string, params: any) {
					createParams = params;
					return {};
				}
			};
		}
	});

	const tablesBackup = setMockModule(tablesPath, {
		TableServiceClient: class {
			constructor(public _endpoint: string, public _cred: any) {}
			async createTable() {}
		}
	});

	const blobsBackup = setMockModule(blobsPath, {
		BlobServiceClient: class {
			constructor(public endpoint: string, public _cred: any) {}
			getContainerClient() {
				return { async createIfNotExists() {} };
			}
		}
	});

	const quickPick = async (items: any[], options?: any) => {
		const title = options?.title ?? '';
		if (title.includes('subscription') || title.includes('Subscription')) {
			return items[0];
		}
		if (title.includes('resource group') || title.includes('Resource Group')) {
			return items.find((i: any) => i.description === 'Existing resource group') ?? items[0];
		}
		if (title.includes('Authentication') || title.includes('authentication mode')) {
			return items.find((i: any) => i.authMode === 'entraId') ?? items[0];
		}
		if (title.includes('Storage Account')) {
			return items[0];
		}
		if (title.includes('Location')) {
			return 'eastus';
		}
		if (title.includes('Events Table') || title.includes('optional usageEvents')) {
			return 'No (recommended)';
		}
		if (title.includes('Raw Container') || title.includes('optional raw blob')) {
			return 'No (recommended)';
		}
		if (title.includes('Sharing Profile')) {
			return items.find((i: any) => i.profile === 'teamAnonymized') ?? items[0];
		}
		return undefined;
	};

	const inputBoxQueue = ['newstorage02', 'usageAggDaily', 'dataset-entra'];
	const inputBox = async () => inputBoxQueue.shift();

	const windowMock = getWindowMock();
	windowMock.showQuickPick = quickPick as any;
	windowMock.showInputBox = inputBox as any;
	windowMock.showWarningMessage = async () => undefined;
	windowMock.showErrorMessage = async () => undefined;
	windowMock.showInformationMessage = async () => undefined;

	const credentialService = {
		createAzureCredential: () => ({
			async getToken() {
				return { token: 'tok' } as any;
			}
		}),
		async getBackendDataPlaneCredentials() {
			return { tableCredential: {}, blobCredential: {}, secretsToRedact: [] };
		}
	} as any;

	const dataPlaneService = {
		async ensureTableExists() {},
		async validateAccess() {},
		getStorageBlobEndpoint: (account: string) => `https://${account}.blob.core.windows.net`
	} as any;

	const settings = {
		enabled: true,
		backend: 'storageTables',
		authMode: 'entraId',
		datasetId: 'dataset-entra',
		sharingProfile: 'teamAnonymized',
		shareWithTeam: false,
		shareWorkspaceMachineNames: false,
		shareConsentAt: '',
		userIdentityMode: 'pseudonymous',
		userId: '',
		userIdMode: 'alias',
		subscriptionId: 'sub-1',
		resourceGroup: 'rg-existing',
		storageAccount: 'sa-existing',
		aggTable: 'usageAggDaily',
		eventsTable: 'usageEvents',
		rawContainer: 'raw-usage',
		lookbackDays: 30,
		includeMachineBreakdown: true
	};

	const deps = {
		log: () => {},
		updateTokenStats: async () => {},
		getSettings: () => settings,
		startTimerIfEnabled: () => {},
		syncToBackendStore: async () => {},
		clearQueryCache: () => {}
	};

	delete requireCjs.cache[requireCjs.resolve('../backend/services/azureResourceService')];
	const { AzureResourceService } = requireCjs('../backend/services/azureResourceService');
	const svc = new AzureResourceService(deps as any, credentialService, dataPlaneService);

	await svc.configureBackendWizard();

	assert.ok(createParams, 'storage account creation should be invoked');
	assert.equal(createParams?.allowSharedKeyAccess, false);
	assert.equal(createParams?.defaultToOAuthAuthentication, true);

	restoreModule(subscriptionPath, subBackup);
	restoreModule(resourcesPath, resourcesBackup);
	restoreModule(storagePath, storageBackup);
	restoreModule(tablesPath, tablesBackup);
	restoreModule(blobsPath, blobsBackup);
});

test('configureBackendWizard enables Shared Key when shared-key auth is selected', async () => {
	(vscode as any).__mock.reset();

	const subscriptionPath = requireCjs.resolve('@azure/arm-subscriptions');
	const resourcesPath = requireCjs.resolve('@azure/arm-resources');
	const storagePath = requireCjs.resolve('@azure/arm-storage');
	const tablesPath = requireCjs.resolve('@azure/data-tables');
	const blobsPath = requireCjs.resolve('@azure/storage-blob');

	const subBackup = setMockModule(subscriptionPath, {
		SubscriptionClient: class {
			subscriptions = {
				async *list() {
					yield { subscriptionId: 'sub-1', displayName: 'Primary Sub' };
				}
			};
		}
	});

	const resourcesBackup = setMockModule(resourcesPath, {
		ResourceManagementClient: class {
			resourceGroups = {
				async *list() {
					yield { name: 'rg-existing', location: 'eastus' };
				},
				async get() {
					return { location: 'eastus' };
				}
			};
		}
	});

	let createParams: any | undefined;
	const storageBackup = setMockModule(storagePath, {
		StorageManagementClient: class {
			storageAccounts = {
				async *listByResourceGroup() {
					yield { name: 'sa-existing' };
				},
				async beginCreateAndWait(_rg: string, _sa: string, params: any) {
					createParams = params;
					return {};
				}
			};
		}
	});

	const tablesBackup = setMockModule(tablesPath, {
		TableServiceClient: class {
			constructor(public _endpoint: string, public _cred: any) {}
			async createTable() {}
		}
	});

	const blobsBackup = setMockModule(blobsPath, {
		BlobServiceClient: class {
			constructor(public endpoint: string, public _cred: any) {}
			getContainerClient() {
				return { async createIfNotExists() {} };
			}
		}
	});

	const quickPick = async (items: any[], options?: any) => {
		const title = options?.title ?? '';
		if (title.includes('subscription') || title.includes('Subscription')) {
			return items[0];
		}
		if (title.includes('resource group') || title.includes('Resource Group')) {
			return items.find((i: any) => i.description === 'Existing resource group') ?? items[0];
		}
		if (title.includes('Authentication') || title.includes('authentication mode')) {
			return items.find((i: any) => i.authMode === 'sharedKey') ?? items[0];
		}
		if (title.includes('Storage Account')) {
			return items[0];
		}
		if (title.includes('Location')) {
			return 'eastus';
		}
		if (title.includes('Events Table') || title.includes('optional usageEvents')) {
			return 'No (recommended)';
		}
		if (title.includes('Raw Container') || title.includes('optional raw blob')) {
			return 'No (recommended)';
		}
		if (title.includes('Sharing Profile')) {
			return items.find((i: any) => i.profile === 'teamAnonymized') ?? items[0];
		}
		return undefined;
	};

	const inputBoxQueue = ['newstorage03', 'usageAggDaily', 'dataset-sharedkey'];
	const inputBox = async () => inputBoxQueue.shift();

	const windowMock = getWindowMock();
	windowMock.showQuickPick = quickPick as any;
	windowMock.showInputBox = inputBox as any;
	windowMock.showWarningMessage = async () => undefined;
	windowMock.showErrorMessage = async () => undefined;
	windowMock.showInformationMessage = async () => undefined;

	const credentialService = {
		createAzureCredential: () => ({
			async getToken() {
				return { token: 'tok' } as any;
			}
		}),
		async getBackendDataPlaneCredentials() {
			return { tableCredential: {}, blobCredential: {}, secretsToRedact: [] };
		}
	} as any;

	const dataPlaneService = {
		async ensureTableExists() {},
		async validateAccess() {},
		getStorageBlobEndpoint: (account: string) => `https://${account}.blob.core.windows.net`
	} as any;

	const settings = {
		enabled: true,
		backend: 'storageTables',
		authMode: 'sharedKey',
		datasetId: 'dataset-sharedkey',
		sharingProfile: 'teamAnonymized',
		shareWithTeam: false,
		shareWorkspaceMachineNames: false,
		shareConsentAt: '',
		userIdentityMode: 'pseudonymous',
		userId: '',
		userIdMode: 'alias',
		subscriptionId: 'sub-1',
		resourceGroup: 'rg-existing',
		storageAccount: 'sa-existing',
		aggTable: 'usageAggDaily',
		eventsTable: 'usageEvents',
		rawContainer: 'raw-usage',
		lookbackDays: 30,
		includeMachineBreakdown: true
	};

	const deps = {
		log: () => {},
		updateTokenStats: async () => {},
		getSettings: () => settings,
		startTimerIfEnabled: () => {},
		syncToBackendStore: async () => {},
		clearQueryCache: () => {}
	};

	delete requireCjs.cache[requireCjs.resolve('../backend/services/azureResourceService')];
	const { AzureResourceService } = requireCjs('../backend/services/azureResourceService');
	const svc = new AzureResourceService(deps as any, credentialService, dataPlaneService);

	await svc.configureBackendWizard();

	assert.ok(createParams, 'storage account creation should be invoked');
	assert.equal(createParams?.allowSharedKeyAccess, true);
	assert.equal(createParams?.defaultToOAuthAuthentication, false);

	restoreModule(subscriptionPath, subBackup);
	restoreModule(resourcesPath, resourcesBackup);
	restoreModule(storagePath, storageBackup);
	restoreModule(tablesPath, tablesBackup);
	restoreModule(blobsPath, blobsBackup);
});

test('setSharingProfileCommand clears identity when downgrading to non-identifying profile', async () => {
	(vscode as any).__mock.reset();

	const updates: Record<string, unknown> = {};
	const configStore: Record<string, unknown> = {
		'backend.userId': 'dev-01',
		'backend.userIdMode': 'alias',
		'backend.userIdentityMode': 'teamAlias',
		'backend.shareConsentAt': '2026-01-20T00:00:00Z'
	};

	const originalGetConfiguration = vscode.workspace.getConfiguration;
	vscode.workspace.getConfiguration = () => ({
		get: (key: string, defaultValue?: any) => {
			return (configStore[key] as any) ?? defaultValue;
		},
		update: async (key: string, value: any) => {
			updates[key] = value;
			configStore[key] = value;
		}
	}) as any;

	const infoMessages: string[] = [];
	const quickPick = async (items: any[], options?: any) => {
		if (options?.title === 'Set Sharing Profile') {
			return items.find((i: any) => i.profile === 'teamAnonymized');
		}
		return undefined;
	};
	const windowMock = getWindowMock();
	windowMock.showQuickPick = quickPick as any;
	windowMock.showWarningMessage = async () => undefined;
	windowMock.showInformationMessage = async (msg: string) => {
		infoMessages.push(msg);
		return undefined;
	};

	const deps = {
		log: () => {},
		updateTokenStats: async () => {},
		getSettings: () => ({
			enabled: true,
			sharingProfile: 'teamIdentified'
		}),
		startTimerIfEnabled: () => {},
		syncToBackendStore: async () => {},
		clearQueryCache: () => {}
	};

	delete requireCjs.cache[requireCjs.resolve('../backend/services/azureResourceService')];
	const { AzureResourceService } = requireCjs('../backend/services/azureResourceService');
	const svc = new AzureResourceService(deps as any, {} as any, {} as any);

	await svc.setSharingProfileCommand();

	assert.equal(updates['backend.sharingProfile'], 'teamAnonymized');
	assert.equal(updates['backend.shareWithTeam'], false);
	assert.equal(updates['backend.shareWorkspaceMachineNames'], false);
	assert.equal(updates['backend.userId'], '');
	assert.equal(updates['backend.userIdMode'], 'alias');
	assert.equal(updates['backend.userIdentityMode'], 'pseudonymous');
	assert.equal(updates['backend.shareConsentAt'], '');
	assert.ok(infoMessages.some(m => m.includes('Sharing profile updated')));

	vscode.workspace.getConfiguration = originalGetConfiguration;
});