import * as vscode from 'vscode';

interface ToolCallUsage {
	total: number;
	byTool: { [toolName: string]: number };
}

interface ModeUsage {
	ask: number;     // Regular chat mode
	edit: number;    // Edit mode interactions
	agent: number;   // Agent mode interactions
}

interface ContextReferenceUsage {
	file: number;        // #file references
	selection: number;   // #selection references
	symbol: number;      // #symbol references
	codebase: number;    // #codebase references
	workspace: number;   // @workspace references
	terminal: number;    // @terminal references
	vscode: number;      // @vscode references
}

interface McpToolUsage {
	total: number;
	byServer: { [serverName: string]: number };
	byTool: { [toolName: string]: number };
}

interface UsageAnalysisPeriod {
	sessions: number;
	toolCalls: ToolCallUsage;
	modeUsage: ModeUsage;
	contextReferences: ContextReferenceUsage;
	mcpTools: McpToolUsage;
}

interface UsageAnalysisStats {
	today: UsageAnalysisPeriod;
	month: UsageAnalysisPeriod;
	lastUpdated: Date;
}

export class UsageAnalysisView {
	constructor(private extensionUri: vscode.Uri) {}

	public getUsageAnalysisHtml(webview: vscode.Webview, stats: UsageAnalysisStats): string {
		const nonce = this.getNonce();
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'usage.js'));

		const csp = [
			`default-src 'none'`,
			`img-src ${webview.cspSource} https: data:`,
			`style-src 'unsafe-inline' ${webview.cspSource}`,
			`font-src ${webview.cspSource} https: data:`,
			`script-src 'nonce-${nonce}'`
		].join('; ');

		const initialData = JSON.stringify({
			today: stats.today,
			month: stats.month,
			lastUpdated: stats.lastUpdated.toISOString()
		}).replace(/</g, '\\u003c');

		return `<!DOCTYPE html>
		<html lang="en">
		<head>
			<meta charset="UTF-8" />
			<meta name="viewport" content="width=device-width, initial-scale=1.0" />
			<meta http-equiv="Content-Security-Policy" content="${csp}" />
			<title>Usage Analysis</title>
		</head>
		<body>
			<div id="root"></div>
			<script nonce="${nonce}">window.__INITIAL_USAGE__ = ${initialData};</script>
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
