import * as vscode from 'vscode';

export async function writeClipboardText(text: string): Promise<void> {
	const maybeMock = (vscode as any).__mock;
	if (maybeMock?.state?.clipboardThrow) {
		throw new Error('clipboard write failed');
	}

	// Keep mock state in sync for tests even if env.clipboard is not patchable
	if (maybeMock?.state) {
		maybeMock.state.clipboardText = text;
	}

	await vscode.env.clipboard.writeText(text);
}
