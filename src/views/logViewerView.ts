import * as vscode from 'vscode';

interface ContextReferenceUsage {
	file: number;
	selection: number;
	symbol: number;
	codebase: number;
	workspace: number;
	terminal: number;
	vscode: number;
}

interface SessionUsageAnalysis {
	toolCalls: { total: number; byTool: { [toolName: string]: number } };
	modeUsage: { ask: number; edit: number; agent: number };
	contextReferences: ContextReferenceUsage;
	mcpTools: { total: number; byServer: { [serverName: string]: number }; byTool: { [toolName: string]: number } };
}

interface ChatTurn {
	turnNumber: number;
	timestamp: string | null;
	mode: 'ask' | 'edit' | 'agent';
	userMessage: string;
	assistantResponse: string;
	model: string | null;
	toolCalls: { toolName: string; arguments?: string; result?: string }[];
	contextReferences: ContextReferenceUsage;
	mcpTools: { server: string; tool: string }[];
	inputTokensEstimate: number;
	outputTokensEstimate: number;
}

interface SessionLogData {
	file: string;
	title: string | null;
	editorSource: string;
	editorName: string;
	size: number;
	modified: string;
	interactions: number;
	contextReferences: ContextReferenceUsage;
	firstInteraction: string | null;
	lastInteraction: string | null;
	turns: ChatTurn[];
	usageAnalysis?: SessionUsageAnalysis;
}

export class LogViewerView {
	constructor(private extensionUri: vscode.Uri) {}

	public getLogViewerHtml(webview: vscode.Webview, logData: SessionLogData): string {
		const nonce = this.getNonce();
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'logviewer.js'));

		const csp = [
			`default-src 'none'`,
			`img-src ${webview.cspSource} https: data:`,
			`style-src 'unsafe-inline' ${webview.cspSource}`,
			`font-src ${webview.cspSource} https: data:`,
			`script-src 'nonce-${nonce}'`
		].join('; ');

		const initialData = JSON.stringify(logData).replace(/</g, '\\u003c');

		return `<!DOCTYPE html>
		<html lang="en">
		<head>
			<meta charset="UTF-8" />
			<meta name="viewport" content="width=device-width, initial-scale=1.0" />
			<meta http-equiv="Content-Security-Policy" content="${csp}" />
			<title>Session Log Viewer</title>
		</head>
		<body>
			<div id="root"></div>
			<script nonce="${nonce}">window.__INITIAL_LOGDATA__ = ${initialData};</script>
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
