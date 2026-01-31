import * as vscode from 'vscode';

interface SessionFileCache {
	tokens: number;
	interactions: number;
	modelUsage: any;
	mtime: number;
	usageAnalysis?: any;
}

interface SessionFileDetails {
	file: string;
	size: number;
	modified: string;
	interactions: number;
	contextReferences: any;
	firstInteraction: string | null;
	lastInteraction: string | null;
	editorSource: string;
	editorRoot?: string;
	editorName?: string;
	title?: string;
}

export class DiagnosticsView {
	constructor(private extensionUri: vscode.Uri) {}

	public getDiagnosticReportHtml(
		webview: vscode.Webview, 
		report: string, 
		sessionFiles: { file: string; size: number; modified: string }[],
		detailedSessionFiles: SessionFileDetails[],
		sessionFolders: { dir: string; count: number; editorName: string }[],
		cacheInfo: {
			size: number;
			sizeInMB: number;
			lastUpdated: string | null;
			location: string;
			storagePath: string | null;
		}
	): string {
		const nonce = this.getNonce();
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'diagnostics.js'));

		const csp = [
			`default-src 'none'`,
			`img-src ${webview.cspSource} https: data:`,
			`style-src 'unsafe-inline' ${webview.cspSource}`,
			`font-src ${webview.cspSource} https: data:`,
			`script-src 'nonce-${nonce}'`
		].join('; ');

		const initialData = JSON.stringify({ report, sessionFiles, detailedSessionFiles, sessionFolders, cacheInfo }).replace(/</g, '\\u003c');

		return `<!DOCTYPE html>
		<html lang="en">
		<head>
			<meta charset="UTF-8" />
			<meta name="viewport" content="width=device-width, initial-scale=1.0" />
			<meta http-equiv="Content-Security-Policy" content="${csp}" />
			<title>Diagnostic Report</title>
		</head>
		<body>
			<div id="root"></div>
			<script nonce="${nonce}">window.__INITIAL_DIAGNOSTICS__ = ${initialData};</script>
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
