/**
 * Minimal VS Code API stub for CLI usage.
 * Only provides the bare minimum needed by sessionDiscovery.ts and opencode.ts
 * when running outside VS Code.
 */

export const workspace = {
	getConfiguration: () => ({
		get: () => undefined,
	}),
};

export const extensions = {
	getExtension: () => undefined,
};

export class Uri {
	readonly fsPath: string;
	readonly scheme: string;
	readonly path: string;

	private constructor(fsPath: string) {
		this.fsPath = fsPath;
		this.scheme = 'file';
		this.path = fsPath;
	}

	static file(path: string): Uri {
		return new Uri(path);
	}

	static joinPath(base: Uri, ...pathSegments: string[]): Uri {
		const joined = [base.fsPath, ...pathSegments].join('/');
		return new Uri(joined);
	}

	toString(): string {
		return this.fsPath;
	}
}

export const window = {
	createOutputChannel: () => ({
		appendLine: () => { /* noop */ },
		show: () => { /* noop */ },
		clear: () => { /* noop */ },
		dispose: () => { /* noop */ },
	}),
};

export default {
	workspace,
	extensions,
	Uri,
	window,
};
