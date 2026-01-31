import * as vscode from 'vscode';

interface DetailedStats {
	today: {
		tokens: number;
		sessions: number;
		avgInteractionsPerSession: number;
		avgTokensPerSession: number;
		modelUsage: ModelUsage;
		editorUsage: EditorUsage;
		co2: number;
		treesEquivalent: number;
		waterUsage: number;
		estimatedCost: number;
	};
	month: {
		tokens: number;
		sessions: number;
		avgInteractionsPerSession: number;
		avgTokensPerSession: number;
		modelUsage: ModelUsage;
		editorUsage: EditorUsage;
		co2: number;
		treesEquivalent: number;
		waterUsage: number;
		estimatedCost: number;
	};
	lastUpdated: Date;
}

interface ModelUsage {
	[modelName: string]: {
		inputTokens: number;
		outputTokens: number;
	};
}

interface EditorUsage {
	[editorType: string]: {
		tokens: number;
		sessions: number;
	};
}

export class DetailsView {
	constructor(private extensionUri: vscode.Uri) {}

	public getDetailsHtml(webview: vscode.Webview, stats: DetailedStats): string {
		const nonce = this.getNonce();
		const scriptUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'details.js')
		);

		const csp = [
			`default-src 'none'`,
			`img-src ${webview.cspSource} https: data:`,
			`style-src 'unsafe-inline' ${webview.cspSource}`,
			`font-src ${webview.cspSource} https: data:`,
			`script-src 'nonce-${nonce}'`
		].join('; ');

		const initialData = JSON.stringify(stats).replace(/</g, '\\u003c');

		return `<!DOCTYPE html>
		<html lang="en">
		<head>
			<meta charset="UTF-8" />
			<meta name="viewport" content="width=device-width, initial-scale=1.0" />
			<meta http-equiv="Content-Security-Policy" content="${csp}" />
			<title>Copilot Token Usage</title>
		</head>
		<body>
			<div id="root"></div>
			<script nonce="${nonce}">window.__INITIAL_DETAILS__ = ${initialData};</script>
			<script nonce="${nonce}" src="${scriptUri}"></script>
		</body>
		</html>`;
	}

	private getNonce(): string {
		const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
		let text = '';
		for (let i = 0; i < 32; i++) {
			text += possible.charAt(Math.floor(Math.random() * possible.length));
		}
		return text;
	}
}
