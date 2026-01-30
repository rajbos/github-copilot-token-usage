import * as path from 'node:path';
import Module = require('module');

type ConfigStore = Record<string, unknown>;

type VscodeMockState = {
	config: ConfigStore;
	workspaceFolders: Array<{ uri: { fsPath: string; toString: () => string } }> | undefined;
	clipboardText: string;
	clipboardThrow: boolean;
	lastInfoMessages: string[];
	lastWarningMessages: string[];
	lastErrorMessages: string[];
	nextPick: string | undefined;
	extensions: Record<string, unknown>;
};

const state: VscodeMockState = {
	config: {},
	workspaceFolders: undefined,
	clipboardText: '',
	clipboardThrow: false,
	lastInfoMessages: [],
	lastWarningMessages: [],
	lastErrorMessages: [],
	nextPick: undefined,
	extensions: {}
};

function normalizeGetKey(key: string): string {
	return String(key ?? '').trim();
}

function createConfiguration(section: string) {
	return {
		get<T>(key: string, defaultValue?: T): T {
			const fullKey = section ? `${section}.${normalizeGetKey(key)}` : normalizeGetKey(key);
			if (Object.prototype.hasOwnProperty.call(state.config, fullKey)) {
				return state.config[fullKey] as T;
			}
			return defaultValue as T;
		},
		async update(_key: string, _value: unknown, _target?: unknown): Promise<void> {
			// No-op for tests.
		}
	};
}

function consumeNextPick(): string | undefined {
	const p = state.nextPick;
	state.nextPick = undefined;
	return p;
}

function showMessage(kind: 'info' | 'warn' | 'error', message: string, _optionsOrItem?: any, ...items: any[]): Promise<string | undefined> {
	if (kind === 'info') {
		state.lastInfoMessages.push(message);
	}
	if (kind === 'warn') {
		state.lastWarningMessages.push(message);
	}
	if (kind === 'error') {
		state.lastErrorMessages.push(message);
	}

	const pick = consumeNextPick();
	if (typeof pick === 'string') {
		return Promise.resolve(pick);
	}

	// If no explicit nextPick, default to undefined (no selection).
	void items;
	return Promise.resolve(undefined);
}

function attachMock(target: any): void {
	if (target.__mock) {
		target.__mock.reset();
		return;
	}

	target.__mock = {
		state,
		reset(): void {
			state.config = {};
			state.workspaceFolders = undefined;
			state.clipboardText = '';
			state.clipboardThrow = false;
			state.lastInfoMessages = [];
			state.lastWarningMessages = [];
			state.lastErrorMessages = [];
			state.nextPick = undefined;
			state.extensions = {};
		},
		setConfig(values: ConfigStore): void {
			state.config = { ...values };
		},
		setWorkspaceFolders(folders: Array<{ fsPath: string; uriString?: string }>): void {
			state.workspaceFolders = folders.map((f) => ({
				uri: {
					fsPath: f.fsPath,
					toString: () => f.uriString ?? `file://${f.fsPath.replace(/\\/g, '/')}`
				}
			}));
		},
		setNextPick(value: string | undefined): void {
			state.nextPick = value;
		},
		setClipboardThrow(shouldThrow: boolean): void {
			state.clipboardThrow = shouldThrow;
		}
	};

	target.ConfigurationTarget = target.ConfigurationTarget ?? { Global: 1 };
	target.ProgressLocation = target.ProgressLocation ?? { Notification: 15 };

	// Add Uri class for tests
	target.Uri = target.Uri ?? class Uri {
		static parse(uriString: string): any {
			try {
				const url = new URL(uriString);
				return {
					fsPath: url.pathname.replace(/^\/([a-zA-Z]:)/, '$1'), // Convert /C:/path to C:/path
					toString: () => uriString
				};
			} catch {
				// Fallback for non-URL strings
				return {
					fsPath: uriString,
					toString: () => uriString
				};
			}
		}
	};

	target.workspace = target.workspace ?? {};
	target.workspace.getConfiguration = createConfiguration;
	Object.defineProperty(target.workspace, 'workspaceFolders', {
		get() {
			return state.workspaceFolders;
		},
		set(folders: any) {
			state.workspaceFolders = folders;
		}
	});

	target.window = target.window ?? {};
	target.window.showInformationMessage = (message: string, optionsOrItem?: any, ...items: any[]) => showMessage('info', message, optionsOrItem, ...items);
	target.window.showWarningMessage = (message: string, optionsOrItem?: any, ...items: any[]) => showMessage('warn', message, optionsOrItem, ...items);
	target.window.showErrorMessage = (message: string, optionsOrItem?: any, ...items: any[]) => showMessage('error', message, optionsOrItem, ...items);
	target.window.withProgress = async (_options: any, task: () => any): Promise<any> => await task();
	target.window.createOutputChannel = (_name: string) => ({
		appendLine(_line: string) {
			// no-op
		},
		dispose() {
			// no-op
		}
	});

	target.env = target.env ?? {};
	target.env.machineId = target.env.machineId ?? 'test-machine-id-0000000000000000';
	const clipboardImpl = {
		async writeText(text: string): Promise<void> {
			if (state.clipboardThrow) {
				throw new Error('clipboard write failed');
			}
			state.clipboardText = text;
		}
	};
	// In the extension host, vscode.env.clipboard may already exist and may not be
	// writable. Best-effort override so tests can observe clipboardText.
	// Prefer overriding the `clipboard` property itself (getter), since `writeText`
	// can be read-only/non-writable.
	try {
		Object.defineProperty(target.env, 'clipboard', {
			get() {
				return clipboardImpl;
			},
			configurable: true
		});
	} catch {
		if (!target.env.clipboard) {
			try {
				target.env.clipboard = clipboardImpl;
			} catch {
				try {
					Object.defineProperty(target.env, 'clipboard', {
						value: clipboardImpl,
						configurable: true
					});
				} catch {
					// ignore
				}
			}
		}
	}

	// Patch writeText even when clipboard object already exists.
	try {
		(target.env.clipboard as any).writeText = clipboardImpl.writeText;
	} catch {
		try {
			Object.defineProperty(target.env.clipboard, 'writeText', {
				value: clipboardImpl.writeText,
				configurable: true
			});
		} catch {
			// ignore
		}
	}

	target.extensions = target.extensions ?? {};
	target.extensions.getExtension = target.extensions.getExtension ?? ((id: string) => {
		if (id === 'RobBos.copilot-token-tracker') {
			return { packageJSON: { version: '0.0.0-test' } };
		}
		return state.extensions[id] as any;
	});
}

const vscodeStub: any = {};
attachMock(vscodeStub);

const stubId = path.join(process.cwd(), '.vscode-test-stub.js');

// Seed module cache with our stub.
(require as any).cache[stubId] = {
	id: stubId,
	filename: stubId,
	loaded: true,
	exports: vscodeStub
};

const originalResolveFilename = (Module as any)._resolveFilename;

// Ensure `require('vscode')` resolves to our stub.
(Module as any)._resolveFilename = function (request: string, parent: any, isMain: boolean, options: any) {
	if (request === 'vscode') {
		return stubId;
	}
	return originalResolveFilename.call(this, request, parent, isMain, options);
};

// If vscode was already loaded (e.g., extension host), attach mocks to it too.
try {
	const existing = require('vscode');
	attachMock(existing);
} catch {
	// ignore
}
