import * as vscode from 'vscode';
import {getModelDisplayName} from '../webview/shared/modelUtils';

interface DailyTokenStats {
	date: string; // YYYY-MM-DD format
	tokens: number;
	sessions: number;
	interactions: number;
	modelUsage: ModelUsage;
	editorUsage: EditorUsage;
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

export class ChartView {
	constructor(private extensionUri: vscode.Uri) {}

	public getChartHtml(webview: vscode.Webview, dailyStats: DailyTokenStats[]): string {
		const nonce = this.getNonce();
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'chart.js'));

		const csp = [
			`default-src 'none'`,
			`img-src ${webview.cspSource} https: data:`,
			`style-src 'unsafe-inline' ${webview.cspSource}`,
			`font-src ${webview.cspSource} https: data:`,
			`script-src 'nonce-${nonce}'`
		].join('; ');

		// Transform dailyStats into the structure expected by the webview
		const labels = dailyStats.map(d => d.date);
		const tokensData = dailyStats.map(d => d.tokens);
		const sessionsData = dailyStats.map(d => d.sessions);

		// Aggregate model usage across all days
		const allModels = new Set<string>();
		dailyStats.forEach(d => Object.keys(d.modelUsage).forEach(m => allModels.add(m)));

		const modelColors = [
			{ bg: 'rgba(54, 162, 235, 0.6)', border: 'rgba(54, 162, 235, 1)' },
			{ bg: 'rgba(255, 99, 132, 0.6)', border: 'rgba(255, 99, 132, 1)' },
			{ bg: 'rgba(75, 192, 192, 0.6)', border: 'rgba(75, 192, 192, 1)' },
			{ bg: 'rgba(153, 102, 255, 0.6)', border: 'rgba(153, 102, 255, 1)' },
			{ bg: 'rgba(255, 159, 64, 0.6)', border: 'rgba(255, 159, 64, 1)' },
			{ bg: 'rgba(255, 205, 86, 0.6)', border: 'rgba(255, 205, 86, 1)' },
			{ bg: 'rgba(201, 203, 207, 0.6)', border: 'rgba(201, 203, 207, 1)' },
			{ bg: 'rgba(100, 181, 246, 0.6)', border: 'rgba(100, 181, 246, 1)' }
		];

		const modelDatasets = Array.from(allModels).map((model, idx) => {
			const color = modelColors[idx % modelColors.length];
			return {
				label: getModelDisplayName(model),
				data: dailyStats.map(d => {
					const usage = d.modelUsage[model];
					return usage ? usage.inputTokens + usage.outputTokens : 0;
				}),
				backgroundColor: color.bg,
				borderColor: color.border,
				borderWidth: 1
			};
		});

		// Aggregate editor usage across all days
		const allEditors = new Set<string>();
		dailyStats.forEach(d => Object.keys(d.editorUsage).forEach(e => allEditors.add(e)));

		const editorDatasets = Array.from(allEditors).map((editor, idx) => {
			const color = modelColors[idx % modelColors.length];
			return {
				label: editor,
				data: dailyStats.map(d => d.editorUsage[editor]?.tokens || 0),
				backgroundColor: color.bg,
				borderColor: color.border,
				borderWidth: 1
			};
		});

		// Calculate editor totals for summary cards
		const editorTotalsMap: Record<string, number> = {};
		dailyStats.forEach(d => {
			Object.entries(d.editorUsage).forEach(([editor, usage]) => {
				editorTotalsMap[editor] = (editorTotalsMap[editor] || 0) + usage.tokens;
			});
		});

		const totalTokens = tokensData.reduce((a, b) => a + b, 0);
		const totalSessions = sessionsData.reduce((a, b) => a + b, 0);

		const chartData = {
			labels,
			tokensData,
			sessionsData,
			modelDatasets,
			editorDatasets,
			editorTotalsMap,
			dailyCount: dailyStats.length,
			totalTokens,
			avgTokensPerDay: dailyStats.length > 0 ? Math.round(totalTokens / dailyStats.length) : 0,
			totalSessions,
			lastUpdated: new Date().toISOString()
		};

		const initialData = JSON.stringify(chartData).replace(/</g, '\\u003c');

		return `<!DOCTYPE html>
		<html lang="en">
		<head>
			<meta charset="UTF-8" />
			<meta name="viewport" content="width=device-width, initial-scale=1.0" />
			<meta http-equiv="Content-Security-Policy" content="${csp}" />
			<title>Copilot Token Usage Chart</title>
		</head>
		<body>
			<div id="root"></div>
			<script nonce="${nonce}">window.__INITIAL_CHART__ = ${initialData};</script>
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
