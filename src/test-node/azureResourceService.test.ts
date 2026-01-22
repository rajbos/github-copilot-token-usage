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
		if (title.includes('subscription')) {
			return items[0];
		}
		if (title.includes('resource group')) {
			return items.find((i: any) => i.description === 'Existing resource group') ?? items[0];
		}
		if (title.includes('Storage account for backend sync')) {
			return items[0]; // create new storage account
		}
		if (title === 'Storage account location') {
			return 'eastus';
		}
		if (title.includes('backend authentication mode')) {
			return items[0];
		}
		if (title.includes('Select Sharing Profile')) {
			return items.find((i: any) => i.profile === 'teamAnonymized') ?? items[0];
		}
		if (title.includes('optional usageEvents')) {
			return 'No (MVP)';
		}
		if (title.includes('optional raw blob')) {
			return 'No (MVP)';
		}
		if (title.includes('existing Storage account')) {
			return items.find((i: any) => i.label === 'sa-existing') ?? items[0];
		}
		return undefined;
	};

	const inputBoxQueue = ['newstorage01', 'usageAggDaily', 'dataset-1'];
	const inputBox = async () => inputBoxQueue.shift();

	vscode.window.showQuickPick = quickPick as any;
	vscode.window.showInputBox = inputBox as any;
	vscode.window.showWarningMessage = async (message: string) => {
		warningMessages.push(message);
		return warningsQueue.shift();
	};
	vscode.window.showErrorMessage = async (message: string) => {
		errorMessages.push(message);
		return undefined;
	};
	vscode.window.showInformationMessage = async (message: string) => {
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