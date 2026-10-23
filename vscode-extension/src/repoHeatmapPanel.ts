/**
 * The Repository Heatmap panel: every file an agent read, edited, created or deleted, one cell
 * per file grouped by folder, filtered by the standard period selector.
 *
 * Self-contained so `extension.ts` only has to hand over a {@link RepoHeatmapHost}: the panel
 * owns its webview, its scan of the session logs and a persistent per-session cache in the
 * extension's global storage. Everything it shows is derived locally and is never uploaded.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
	deserializeRepoHeatmapCache,
	scanRepoHeatmapSessions,
	serializeRepoHeatmapCache,
	type RepoHeatmapCollectDeps,
	type RepoHeatmapScanCache,
} from '../../src/repoHeatmapCollector';
import { buildRepoHeatmapViewData, type RepoHeatmapViewData } from '../../src/repoHeatmapViewBuilder';
import { t as l10nT, resolvedLocale } from './l10n';
import { buildWebviewLocalization } from './webviewLocalization';
import { buildCspMeta, getCodiconStylesheetTag, getNonce } from './utils/webviewUtils';

export const REPO_HEATMAP_VIEW_TYPE = 'aiFluencyRepoHeatmap';
const CACHE_FILE = 'repo-heatmap-cache.json';

/** What the panel needs from the extension; supplied by `CopilotTokenTracker.getRepoHeatmapHost()`. */
export interface RepoHeatmapHost {
	extensionUri: vscode.Uri;
	/** Directory for the persistent scan cache (the extension's global storage). */
	storageDir: string;
	getSessionFiles(): Promise<string[]>;
	getCollectDeps(): RepoHeatmapCollectDeps;
	log(message: string): void;
	warn(message: string): void;
}

export class RepoHeatmapPanel {
	private panel: vscode.WebviewPanel | undefined;
	private cache: RepoHeatmapScanCache | undefined;
	private scanning: Promise<void> | undefined;

	constructor(private readonly host: RepoHeatmapHost) {}

	/** Opens the panel, or reveals it when already open. */
	show(): void {
		if (this.panel) { this.panel.reveal(); return; }
		const panel = vscode.window.createWebviewPanel(
			REPO_HEATMAP_VIEW_TYPE,
			'Repository Heatmap',
			{ viewColumn: vscode.ViewColumn.One, preserveFocus: true },
			{
				enableScripts: true,
				retainContextWhenHidden: false,
				localResourceRoots: [
					vscode.Uri.joinPath(this.host.extensionUri, 'dist', 'webview'),
					vscode.Uri.joinPath(this.host.extensionUri, 'media'),
				],
			},
		);
		this.panel = panel;
		panel.webview.html = this.getHtml(panel.webview);
		panel.webview.onDidReceiveMessage((message: { command?: string }) => {
			if (message?.command === 'ready' || message?.command === 'refresh') { void this.scan(); }
		});
		panel.onDidDispose(() => { if (this.panel === panel) { this.panel = undefined; } });
	}

	/** Scans (or re-scans) the session logs and posts the result; concurrent requests share one scan. */
	private scan(): Promise<void> {
		this.scanning ??= this.runScan().finally(() => { this.scanning = undefined; });
		return this.scanning;
	}

	private post(message: unknown): void {
		void this.panel?.webview.postMessage(message);
	}

	private async runScan(): Promise<void> {
		try {
			const cache = this.cache ??= await this.loadCache();
			const files = await this.host.getSessionFiles();
			let lastPost = 0;
			const sessions = await scanRepoHeatmapSessions(this.host.getCollectDeps(), files, cache, {
				onProgress: (done, total) => {
					// A progress message per file would flood the webview on a first scan of thousands.
					const now = Date.now();
					if (done === total || now - lastPost >= 150) { lastPost = now; this.post({ command: 'progress', done, total }); }
				},
				onError: (file, error) => this.host.warn(`Repository heatmap: could not read ${path.basename(file)}: ${String(error)}`),
			});
			const data: RepoHeatmapViewData = buildRepoHeatmapViewData(sessions, new Date());
			this.post({ command: 'data', data });
			await this.saveCache(cache);
		} catch (error) {
			this.host.warn(`Repository heatmap scan failed: ${String(error)}`);
			this.post({ command: 'error' });
		}
	}

	private get cachePath(): string { return path.join(this.host.storageDir, CACHE_FILE); }

	private async loadCache(): Promise<RepoHeatmapScanCache> {
		try { return deserializeRepoHeatmapCache(await fs.promises.readFile(this.cachePath, 'utf8')); }
		catch { return new Map(); }
	}

	private async saveCache(cache: RepoHeatmapScanCache): Promise<void> {
		try {
			await fs.promises.mkdir(this.host.storageDir, { recursive: true });
			await fs.promises.writeFile(this.cachePath, serializeRepoHeatmapCache(cache), 'utf8');
		} catch (error) {
			// The cache is an optimisation; the next open simply re-scans.
			this.host.warn(`Repository heatmap: could not write its cache: ${String(error)}`);
		}
	}

	private getHtml(webview: vscode.Webview): string {
		const nonce = getNonce();
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.host.extensionUri, 'dist', 'webview', 'repo-heatmap.js'));
		const initial = JSON.stringify({
			data: null,
			loading: true,
			localization: buildWebviewLocalization(l10nT),
			language: resolvedLocale(vscode.env.language),
		}).replace(/</g, '\\u003c');
		return `<!DOCTYPE html>
		<html lang="en">
		<head>
			<meta charset="UTF-8" />
			<meta name="viewport" content="width=device-width, initial-scale=1.0" />
			${buildCspMeta(webview, nonce)}
			${getCodiconStylesheetTag(webview, this.host.extensionUri)}
			<title>Repository Heatmap</title>
		</head>
		<body>
			<div id="root"></div>
			<script nonce="${nonce}">window.__INITIAL_REPO_HEATMAP__ = ${initial};</script>
			<script nonce="${nonce}" src="${scriptUri}"></script>
		</body>
		</html>`;
	}
}

/** The slice of `CopilotTokenTracker` the heatmap needs; all of it is already public. */
export interface RepoHeatmapTrackerSource {
	sessionDiscovery: { getCopilotSessionFiles(): Promise<string[]> };
	ecosystems: RepoHeatmapCollectDeps['ecosystems'];
	log(message: string): void;
	warn(message: string): void;
}

/** Builds the panel's host view of the extension from the activation context and the tracker. */
export function createRepoHeatmapHost(context: vscode.ExtensionContext, tracker: RepoHeatmapTrackerSource): RepoHeatmapHost {
	return {
		extensionUri: context.extensionUri,
		storageDir: context.globalStorageUri.fsPath,
		getSessionFiles: () => tracker.sessionDiscovery.getCopilotSessionFiles(),
		getCollectDeps: () => ({ ecosystems: tracker.ecosystems }),
		log: message => tracker.log(message),
		warn: message => tracker.warn(message),
	};
}
