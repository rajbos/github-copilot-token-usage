import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { safeJsonForInlineScript } from '../utils/html';
import type { BackendConfigDraft } from './configurationFlow';

export interface BackendConfigPanelState {
	draft: BackendConfigDraft;
	errors?: Record<string, string>;
	sharedKeySet: boolean;
	privacyBadge: string;
	isConfigured: boolean;
	authStatus: string;
	shareConsentAt?: string;
}

export interface BackendConfigPanelCallbacks {
	getState: () => Promise<BackendConfigPanelState>;
	onSave: (draft: BackendConfigDraft) => Promise<{ state: BackendConfigPanelState; errors?: Record<string, string>; message?: string }>;
	onDiscard: () => Promise<BackendConfigPanelState>;
	onStayLocal: () => Promise<BackendConfigPanelState>;
	onTestConnection: (draft: BackendConfigDraft) => Promise<{ ok: boolean; message: string }>;
	onUpdateSharedKey: (storageAccount: string, draft?: BackendConfigDraft) => Promise<{ ok: boolean; message: string; state?: BackendConfigPanelState }>;
	onLaunchWizard: () => Promise<BackendConfigPanelState>;
	onClearAzureSettings: () => Promise<BackendConfigPanelState>;
}

export class BackendConfigPanel implements vscode.Disposable {
	private panel: vscode.WebviewPanel | undefined;
	private readonly disposables: vscode.Disposable[] = [];
	private disposed = false;
	private dirty = false;
	private operationInProgress = false;

	constructor(private readonly extensionUri: vscode.Uri, private readonly callbacks: BackendConfigPanelCallbacks) {}

	public async show(): Promise<void> {
		const state = await this.callbacks.getState();
		if (!this.panel) {
			this.panel = vscode.window.createWebviewPanel(
				'copilotBackendConfig',
				'Copilot Token Tracker: Configure Backend',
				{ viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
				{ enableScripts: true, retainContextWhenHidden: false }
			);
			// Track all event listeners in disposables array for proper cleanup
			this.disposables.push(
				this.panel.onDidDispose(() => this.handleDispose()),
				this.panel.webview.onDidReceiveMessage(async (message) => this.handleMessage(message))
			);
		}
		this.panel.webview.html = this.renderHtml(this.panel.webview, state);
		this.panel.reveal();
	}

	private handleDispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		if (this.dirty) {
			vscode.window.showWarningMessage('Backend configuration panel closed with unsaved changes. No changes were applied.');
		}
	}

	public dispose(): void {
		// Dispose all tracked event listeners
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.disposables.length = 0;
		
		// Dispose the panel itself
		if (this.panel) {
			this.panel.dispose();
			this.panel = undefined;
		}
	}

	/**
	 * Execute an async operation with locking to prevent concurrent state updates.
	 */
	private async withLock<T>(operation: () => Promise<T>): Promise<T> {
		if (this.operationInProgress) {
			throw new Error('Another operation is in progress. Please wait.');
		}
		this.operationInProgress = true;
		try {
			return await operation();
		} finally {
			this.operationInProgress = false;
		}
	}

	private async handleMessage(message: any): Promise<void> {
		switch (message?.command) {
			case 'markDirty':
				this.dirty = true;
				return;
			case 'save':
				await this.handleSave(message.draft as BackendConfigDraft);
				return;
			case 'discard':
				await this.handleDiscard();
				return;
			case 'stayLocal':
				await this.handleStayLocal();
				return;
			case 'testConnection':
				await this.handleTestConnection(message.draft as BackendConfigDraft);
				return;
			case 'updateSharedKey':
				await this.handleUpdateSharedKey(message.storageAccount as string, message.draft as BackendConfigDraft | undefined);
				return;
			case 'launchWizard':
				await this.handleLaunchWizard();
				return;
			case 'clearAzureSettings':
				await this.handleClearAzureSettings();
				return;
		}
	}

	private async handleSave(draft: BackendConfigDraft): Promise<void> {
		try {
			await this.withLock(async () => {
				const result = await this.callbacks.onSave(draft);
				this.dirty = false;
				this.postState(result.state, result.errors, result.message);
			});
		} catch (error: any) {
			vscode.window.showErrorMessage(`Failed to save backend settings: ${error?.message || String(error)}`);
		}
	}

	private async handleDiscard(): Promise<void> {
		const state = await this.callbacks.onDiscard();
		this.dirty = false;
		this.postState(state, undefined, 'Changes discarded.');
	}

	private async handleStayLocal(): Promise<void> {
		const state = await this.callbacks.onStayLocal();
		this.dirty = false;
		this.postState(state, undefined, 'Backend disabled. Staying local-only.');
	}

	private async handleTestConnection(draft: BackendConfigDraft): Promise<void> {
		const result = await this.callbacks.onTestConnection(draft);
		this.postMessage({ type: 'testResult', result });
	}

	private async handleUpdateSharedKey(storageAccount: string, draft?: BackendConfigDraft): Promise<void> {
		const result = await this.callbacks.onUpdateSharedKey(storageAccount, draft);
		if (result.state) {
			this.postState(result.state);
		}
		this.postMessage({ type: 'sharedKeyResult', result });
	}

	private async handleLaunchWizard(): Promise<void> {
		const state = await this.callbacks.onLaunchWizard();
		this.postState(state, undefined, 'Wizard completed. Refreshing settings.');
	}

	private async handleClearAzureSettings(): Promise<void> {
		const state = await this.callbacks.onClearAzureSettings();
		this.dirty = false;
		this.postState(state, undefined, 'Azure settings cleared.');
	}

	private postState(state: BackendConfigPanelState, errors?: Record<string, string>, message?: string): void {
		this.postMessage({ type: 'state', state, errors, message });
	}

	private postMessage(payload: any): void {
		if (this.panel) {
			this.panel.webview.postMessage(payload);
		}
	}

	private renderHtml(webview: vscode.Webview, state: BackendConfigPanelState): string {
		// Use cryptographically secure random for CSP nonce
		const nonce = crypto.randomBytes(16).toString('base64');
		const toolkitUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'node_modules', '@vscode', 'webview-ui-toolkit', 'dist', 'toolkit.js'));
		const initialState = safeJsonForInlineScript(state);
 		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource};">
	<title>Configure Backend</title>
		<style>
			body { font-family: 'Segoe UI', sans-serif; background: #1e1e1e; color: #e5e5e5; margin: 0; padding: 0; }
			.banner { background: #423620; color: #f2c97d; padding: 10px 16px; display: none; }
			.banner.offline { display: block; }
			.layout { display: grid; grid-template-columns: 220px 1fr; min-height: 100vh; }
			.nav { border-right: 1px solid #2f2f2f; padding: 16px; background: #252526; }
			.nav vscode-button { width: 100%; margin-bottom: 8px; }
			.nav vscode-button.selected { 
				--vscode-button-secondaryBackground: #0e639c; 
				--vscode-button-secondaryHoverBackground: #1177bb;
			}
			.main { padding: 16px 20px 32px; }
			.section { display: none; gap: 12px; }
			.section.active { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
			.card { background: #252526; border: 1px solid #2f2f2f; border-radius: 8px; padding: 16px; display: flex; flex-direction: column; gap: 10px; }
			.field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 6px; }
			.field label { font-size: 12px; color: #c8c8c8; }
			.field small { color: #999; }
			.field .error { color: #f48771; font-size: 11px; }
			.actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 4px; }
			.grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; }
			.inline { display: flex; align-items: center; gap: 10px; }
			.helper { color: #b3b3b3; font-size: 12px; line-height: 1.4; }
			.status-line { font-size: 12px; padding: 8px 10px; border-radius: 6px; background: #1b252e; }
			.status-line.ok { color: #b8f5c4; border: 1px solid #2d4f3a; }
			.status-line.error { color: #f8c7c0; border: 1px solid #7c2f2f; }
			.pill-row { display: flex; flex-wrap: wrap; gap: 8px; }
			.muted { color: #9a9a9a; }
			.disabled-section { opacity: 0.5; pointer-events: none; }
			.change-item { padding: 8px 12px; margin: 6px 0; background: #2d2d30; border-left: 3px solid #0e639c; border-radius: 4px; }
			.change-item.warning { border-left-color: #d7ba7d; }
			.change-item.danger { border-left-color: #f48771; }
			.change-label { font-weight: bold; color: #e5e5e5; margin-bottom: 4px; }
			.change-value { color: #b3b3b3; font-size: 13px; }
			#reviewSummary { margin-bottom: 16px; }
		</style>
</head>
<body>
	<div id="offlineBanner" class="banner">Offline detected. You can edit and save locally. "Test connection" is disabled.</div>
	<div class="layout">
		<aside class="nav">
			<vscode-button appearance="secondary" class="nav-btn selected" data-target="overview" aria-label="Navigate to Overview section">Overview</vscode-button>
			<vscode-button appearance="secondary" class="nav-btn" data-target="azure" aria-label="Navigate to Azure section">Azure</vscode-button>
			<vscode-button appearance="secondary" class="nav-btn" data-target="sharing" aria-label="Navigate to Sharing section">Sharing</vscode-button>
			<vscode-button appearance="secondary" class="nav-btn" data-target="advanced" aria-label="Navigate to Advanced section">Advanced</vscode-button>
			<vscode-button appearance="secondary" class="nav-btn" data-target="review" aria-label="Navigate to Review and Apply section">Review & Apply</vscode-button>
		</aside>
		<main class="main">
			<section id="overview" class="section active">
				<div class="card">
					<h3>Why use backend sync?</h3>
					<p class="helper"><strong>Team visibility & insights:</strong> Share Copilot usage across your team to identify patterns, optimize costs, and track adoption. Perfect for managers, platform teams, and anyone managing Copilot licenses.</p>
					<p class="helper"><strong>Multi-device sync:</strong> Work on multiple machines? Backend keeps your token usage history synced across all devices automatically.</p>
					<p class="helper"><strong>Long-term tracking:</strong> Local data lives in VS Code session files that can be cleaned up. Backend provides durable, queryable storage for trend analysis and compliance reporting.</p>
					<p class="helper"><strong>Privacy-first:</strong> Choose your sharing level from Solo (just you) to Team Identified (full analytics). You control what's shared and how you're identified.</p>
				</div>
				<div class="card">
					<h3>Current status</h3>
					<div class="pill-row">
						<vscode-badge id="backendStateBadge"></vscode-badge>
					<vscode-badge id="privacyBadge"></vscode-badge>
					<vscode-badge id="authBadge"></vscode-badge>
				</div>
				<div id="overviewDetails" style="margin-top: 12px; display: grid; grid-template-columns: auto 1fr; gap: 8px 12px; font-size: 12px;">
					<span style="color: #999;">Profile:</span>
					<span id="overviewProfile" style="color: #e5e5e5;"></span>
					<span style="color: #999;">Dataset:</span>
					<span id="overviewDataset" style="color: #e5e5e5;"></span>
				</div>
				<div class="helper" id="statusMessage" style="margin-top: 12px;"></div>
			</div>
			<div class="card">
				<h3>How it works</h3>
				<p class="helper"><strong>1. Azure Storage setup:</strong> Your usage data syncs to Azure Table Storage. Daily aggregates (tokens, interactions, model) are stored per workspace/machine/day. You own the data, you control access.</p>
				<p class="helper"><strong>2. Authentication:</strong> Use Entra ID (role-based, recommended) or Storage Shared Key. Your credentials stay local and secure.</p>
				<p class="helper"><strong>3. Automatic sync:</strong> Every 5 minutes, the extension calculates token usage from session files and pushes aggregates to Azure. Configurable lookback window (7-90 days).</p>
				<p class="helper"><strong>4. Query & analyze:</strong> Use Azure Storage Explorer, Power BI, or custom tools to query your Table Storage data.</p>
				<p class="helper">Need help? <vscode-link id="launchWizardLink" href="#">Launch the guided Azure setup walkthrough</vscode-link> to configure subscription, resource group, storage account, and auth mode step-by-step.</p>
			</div>
		</section>
		<section id="sharing" class="section">
				<div class="card">
					<h3>Sharing profile</h3>
					<div class="field">
						<label for="sharingProfile">Profile</label>
						<vscode-dropdown id="sharingProfile" aria-describedby="sharingProfile-help">
							<vscode-option value="off">Off (local-only)</vscode-option>
							<vscode-option value="soloFull">Solo</vscode-option>
							<vscode-option value="teamAnonymized">Team Anonymized</vscode-option>
							<vscode-option value="teamPseudonymous">Team Pseudonymous</vscode-option>
							<vscode-option value="teamIdentified">Team Identified</vscode-option>
						</vscode-dropdown>
						<div id="sharingProfile-help" class="helper" style="margin-bottom: 8px;">Choose your privacy level. Each profile controls what data is synced to Azure and who can see it.</div>
						<details style="margin-bottom: 12px;">
							<summary style="cursor: pointer; color: #3794ff; font-size: 12px; margin-bottom: 8px;">What do these profiles mean?</summary>
							<div style="margin-top: 12px; font-size: 11px; line-height: 1.5;">
								<div style="background: #2d2d30; border-left: 3px solid #555; padding: 10px 12px; margin-bottom: 10px;">
									<div style="color: #e5e5e5; font-weight: bold; margin-bottom: 6px;">🔒 Off (Local-only)</div>
									<div style="color: #b3b3b3; margin-bottom: 4px;"><strong>Who can see:</strong> No one — data never leaves your device</div>
									<div style="color: #b3b3b3; margin-bottom: 4px;"><strong>What's stored:</strong> Nothing synced to Azure</div>
									<div style="color: #b3b3b3; margin-bottom: 4px;"><strong>Workspace names:</strong> ❌ Not synced</div>
									<div style="color: #b3b3b3; margin-bottom: 4px;"><strong>Machine names:</strong> ❌ Not synced</div>
									<div style="color: #b3b3b3; margin-bottom: 4px;"><strong>Your identity:</strong> ❌ No user ID stored</div>
									<div style="color: #888; font-style: italic; margin-top: 6px;">Use this to keep all data private on this device only.</div>
								</div>
								<div style="background: #2d2d30; border-left: 3px solid #0e639c; padding: 10px 12px; margin-bottom: 10px;">
									<div style="color: #e5e5e5; font-weight: bold; margin-bottom: 6px;">👤 Solo</div>
									<div style="color: #b3b3b3; margin-bottom: 4px;"><strong>Who can see:</strong> Only you (single-user Azure storage)</div>
									<div style="color: #b3b3b3; margin-bottom: 4px;"><strong>What's stored:</strong> Token counts, model usage, interaction counts, dates</div>
									<div style="color: #b3b3b3; margin-bottom: 4px;"><strong>Workspace names:</strong> ✅ <em>Actual names</em> (e.g., "frontend-monorepo")</div>
									<div style="color: #b3b3b3; margin-bottom: 4px;"><strong>Machine names:</strong> ✅ <em>Actual names</em> (e.g., "DESKTOP-ABC123")</div>
									<div style="color: #b3b3b3; margin-bottom: 4px;"><strong>Your identity:</strong> ❌ No user ID (you're the only user)</div>
									<div style="color: #888; font-style: italic; margin-top: 6px;">Perfect for personal tracking across multiple devices. No privacy concerns since only you have access.</div>
								</div>
								<div style="background: #2d2d30; border-left: 3px solid #4ec9b0; padding: 10px 12px; margin-bottom: 10px;">
									<div style="color: #e5e5e5; font-weight: bold; margin-bottom: 6px;">👥 Team Anonymized</div>
									<div style="color: #b3b3b3; margin-bottom: 4px;"><strong>Who can see:</strong> Team members with Azure storage access</div>
									<div style="color: #b3b3b3; margin-bottom: 4px;"><strong>What's stored:</strong> Token counts, model usage, interaction counts, dates</div>
									<div style="color: #b3b3b3; margin-bottom: 4px;"><strong>Workspace names:</strong> ❌ <em>Hashed IDs only</em> (e.g., "ws_a7f3...")</div>
									<div style="color: #b3b3b3; margin-bottom: 4px;"><strong>Machine names:</strong> ❌ <em>Hashed IDs only</em> (e.g., "mc_9d2b...")</div>
									<div style="color: #b3b3b3; margin-bottom: 4px;"><strong>Your identity:</strong> ❌ No user ID stored</div>
									<div style="color: #888; font-style: italic; margin-top: 6px;">Strongest team privacy: team sees aggregated usage but can't identify specific workspaces, machines, or users.</div>
								</div>
								<div style="background: #2d2d30; border-left: 3px solid #c586c0; padding: 10px 12px; margin-bottom: 10px;">
									<div style="color: #e5e5e5; font-weight: bold; margin-bottom: 6px;">👥 Team Pseudonymous</div>
									<div style="color: #b3b3b3; margin-bottom: 4px;"><strong>Who can see:</strong> Team members with Azure storage access</div>
									<div style="color: #b3b3b3; margin-bottom: 4px;"><strong>What's stored:</strong> Token counts, model usage, interaction counts, dates</div>
									<div style="color: #b3b3b3; margin-bottom: 4px;"><strong>Workspace names:</strong> ❌ <em>Hashed IDs only</em> (e.g., "ws_a7f3...")</div>
									<div style="color: #b3b3b3; margin-bottom: 4px;"><strong>Machine names:</strong> ❌ <em>Hashed IDs only</em> (e.g., "mc_9d2b...")</div>
									<div style="color: #b3b3b3; margin-bottom: 4px;"><strong>Your identity:</strong> ⚠️ <em>Stable alias auto-derived from Entra ID</em> (e.g., "dev-001")</div>
									<div style="color: #888; font-style: italic; margin-top: 6px;">Track usage per-person without revealing real names. Same developer always gets same alias across sessions.</div>
								</div>
								<div style="background: #2d2d30; border-left: 3px solid #d7ba7d; padding: 10px 12px; margin-bottom: 10px;">
									<div style="color: #e5e5e5; font-weight: bold; margin-bottom: 6px;">👥 Team Identified</div>
									<div style="color: #b3b3b3; margin-bottom: 4px;"><strong>Who can see:</strong> Team members with Azure storage access</div>
									<div style="color: #b3b3b3; margin-bottom: 4px;"><strong>What's stored:</strong> Token counts, model usage, interaction counts, dates</div>
									<div style="color: #b3b3b3; margin-bottom: 4px;"><strong>Workspace names:</strong> ⚠️ <em>Optional: can enable actual names</em> (e.g., "frontend-monorepo")</div>
									<div style="color: #b3b3b3; margin-bottom: 4px;"><strong>Machine names:</strong> ⚠️ <em>Optional: can enable actual names</em> (e.g., "DESKTOP-ABC123")</div>
									<div style="color: #b3b3b3; margin-bottom: 4px;"><strong>Your identity:</strong> ⚠️ <em>Team alias OR Entra object ID</em> (e.g., "alex-dev" or GUID)</div>
									<div style="color: #888; font-style: italic; margin-top: 6px;">Full transparency: team sees who uses what. Best for small teams or compliance scenarios.</div>
								</div>
								<div style="background: #3a3d41; border: 1px solid #555; border-radius: 4px; padding: 8px 10px; margin-top: 12px;">
									<div style="color: #f48771; font-size: 10px; font-weight: bold; margin-bottom: 4px;">⚠️ IMPORTANT</div>
									<div style="color: #b3b3b3; font-size: 10px;">• Token counts, model names, and dates are <strong>always included</strong> when backend is enabled</div>
									<div style="color: #b3b3b3; font-size: 10px;">• "Who can see" means anyone with read access to your Azure Storage account</div>
									<div style="color: #b3b3b3; font-size: 10px;">• Upgrading to more permissive profiles requires explicit consent</div>
									<div style="color: #b3b3b3; font-size: 10px;">• Use the "Store readable workspace & machine names" checkbox below to control name storage</div>
								</div>
							</div>
						</details>
					</div>
					<div id="nameStorageControl" style="margin-top: 16px;">
						<div class="field inline">
							<vscode-checkbox id="shareNames" aria-describedby="shareNames-help">Store readable workspace & machine names</vscode-checkbox>
							<div id="shareNames-help" class="helper" style="margin-left: 24px;">Applies when using Team Pseudonymous or Team Identified. Solo always includes names; Team Anonymized always uses hashed IDs.</div>
						</div>
					</div>
					<div class="field inline" style="margin-top: 12px;">
						<vscode-checkbox id="includeMachineBreakdown" aria-describedby="includeMachineBreakdown-help">Include per-machine breakdown</vscode-checkbox>
						<div id="includeMachineBreakdown-help" class="helper" style="margin-left: 24px;">Separate rows per machine. Disable to merge into workspace totals only.</div>
					</div>
				</div>
				<div class="card" id="identityCard" style="display:none;">
					<h3>Identity (Team Identified)</h3>
					<div class="field">
						<label for="userIdentityMode">Identity mode</label>
						<vscode-dropdown id="userIdentityMode" aria-describedby="userIdentityMode-help">
							<vscode-option value="teamAlias">Team alias</vscode-option>
							<vscode-option value="entraObjectId">Entra object ID</vscode-option>
						</vscode-dropdown>
					</div>
					<div class="field">
						<label for="userId">Alias or object ID</label>
						<vscode-text-field id="userId" placeholder="alex-dev" aria-describedby="userId-help userId-error"></vscode-text-field>
						<div id="userId-error" class="error" role="alert" data-error-for="userId"></div>
					</div>
					<div id="userId-help userIdentityMode-help" class="helper">Team alias: Use a non-identifying handle like "alex-dev". Entra object ID: Use your directory GUID for compliance auditing.</div>
				</div>
			</section>
			<section id="azure" class="section">
				<div class="card">
					<h3>Enable backend</h3>
					<div class="field inline">
						<vscode-checkbox id="enabledToggle" aria-describedby="enabledToggle-help">Enable backend sync to Azure</vscode-checkbox>
					</div>
					<div id="enabledToggle-help" class="helper">Syncs token usage to Azure Storage when enabled. Stays local-only when disabled.</div>
					<div class="actions">
						<vscode-button id="setupBtn" appearance="secondary" aria-label="Open guided Azure setup wizard">Setup</vscode-button>
						<vscode-button id="testConnectionBtn" appearance="secondary" aria-label="Test connection to Azure Storage">Test connection</vscode-button>
						<vscode-button id="clearSettingsBtn" appearance="secondary" aria-label="Clear all Azure settings">Clear settings</vscode-button>
					</div>
					<div class="status-line" id="testResult" role="status" aria-live="polite"></div>
				</div>
				<div class="card">
				<h3>Azure Settings</h3>
					<p class="helper">Azure Storage connection details. Use the guided wizard to auto-fill these fields.</p>
					<div class="grid-2">
						<div class="field"><label for="subscriptionId">Subscription ID</label><vscode-text-field id="subscriptionId" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" aria-describedby="subscriptionId-error"></vscode-text-field><div id="subscriptionId-error" class="error" role="alert" data-error-for="subscriptionId"></div></div>
						<div class="field"><label for="resourceGroup">Resource Group</label><vscode-text-field id="resourceGroup" placeholder="copilot-tokens-rg" aria-describedby="resourceGroup-error"></vscode-text-field><div id="resourceGroup-error" class="error" role="alert" data-error-for="resourceGroup"></div></div>
						<div class="field"><label for="storageAccount">Storage Account</label><vscode-text-field id="storageAccount" placeholder="copilottokenstorage" aria-describedby="storageAccount-error"></vscode-text-field><div id="storageAccount-error" class="error" role="alert" data-error-for="storageAccount"></div></div>
						<div class="field"><label for="aggTable">Aggregate Table</label><vscode-text-field id="aggTable" placeholder="usageAggDaily" aria-describedby="aggTable-error"></vscode-text-field><div id="aggTable-error" class="error" role="alert" data-error-for="aggTable"></div></div>
						<div class="field"><label for="eventsTable">Events Table (optional)</label><vscode-text-field id="eventsTable" placeholder="usageEvents" aria-describedby="eventsTable-error"></vscode-text-field><div id="eventsTable-error" class="error" role="alert" data-error-for="eventsTable"></div></div>

					</div>
				</div>
				<div class="card">
					<h3>Authentication</h3>
					<div class="field">
						<label for="authMode">Auth mode</label>
						<vscode-dropdown id="authMode" aria-describedby="authHelper">
							<vscode-option value="entraId">Entra ID (role-based access)</vscode-option>
							<vscode-option value="sharedKey">Storage Shared Key</vscode-option>
						</vscode-dropdown>
						<div class="helper" id="authHelper"></div>
					</div>
					<div class="actions">
						<vscode-button id="updateKeyBtn" appearance="secondary" aria-label="Update Storage Account Shared Key">Update shared key</vscode-button>
					</div>
					<div class="helper" id="sharedKeyStatus"></div>
				</div>
			</section>
			<section id="advanced" class="section">
				<div class="card">
					<h3>Advanced</h3>
					<div class="field"><label for="datasetId">Dataset ID</label><vscode-text-field id="datasetId" placeholder="my-team-copilot" aria-describedby="datasetId-help datasetId-error"></vscode-text-field><div id="datasetId-error" class="error" role="alert" data-error-for="datasetId"></div></div>
					<div id="datasetId-help" class="helper">Dataset ID groups your usage data. Examples: "my-team", "project-alpha", "personal-usage"</div>
					<div class="field"><label for="lookbackDays">Lookback days <span class="range">(1-90)</span></label><vscode-text-field id="lookbackDays" type="number" placeholder="30" aria-describedby="lookbackDays-help lookbackDays-error"></vscode-text-field><div id="lookbackDays-error" class="error" role="alert" data-error-for="lookbackDays"></div></div>
					<div id="lookbackDays-help" class="helper">How far back to sync: 7 days = current week, 30 days = current month, 90 days = full quarter. Smaller values sync faster.</div>
				</div>
			</section>
			<section id="review" class="section">
				<div class="card">
					<h3>Review & Apply</h3>
					<div class="helper">Review your configuration changes below, then confirm and save.</div>
					<div id="reviewSummary"></div>
					<div class="field inline"><vscode-checkbox id="confirmApply" aria-describedby="confirmApply-help">I understand this will overwrite backend settings.</vscode-checkbox></div>
					<div id="confirmApply-help" class="helper" style="display:none;">Confirm you understand before saving</div>
					<div class="actions">
						<vscode-button appearance="primary" id="saveBtnReview" disabled aria-label="Save backend settings and apply changes">Save & Apply</vscode-button>
						<vscode-button id="discardBtnReview" appearance="secondary" aria-label="Discard unsaved changes">Discard</vscode-button>
					</div>
				</div>
			</section>
		</main>
	</div>
	<script type="module" nonce="${nonce}">
		const { provideVSCodeDesignSystem, vsCodeButton, vsCodeBadge } = await import('${toolkitUri}');
		provideVSCodeDesignSystem().register(vsCodeButton(), vsCodeBadge());
	</script>
		<script nonce="${nonce}">
		const vscodeApi = acquireVsCodeApi();
		const initial = ${initialState};
		let currentState = initial;
		const aliasRegex = new RegExp(${safeJsonForInlineScript('^[A-Za-z0-9][A-Za-z0-9_-]*$')});

		function byId(id) { return document.getElementById(id); }

		function setFieldValues(state) {
			byId('enabledToggle').checked = !!state.draft.enabled;
			byId('sharingProfile').value = state.draft.sharingProfile;
			byId('authMode').value = state.draft.authMode;
			byId('subscriptionId').value = state.draft.subscriptionId || '';
			byId('resourceGroup').value = state.draft.resourceGroup || '';
			byId('storageAccount').value = state.draft.storageAccount || '';
			byId('aggTable').value = state.draft.aggTable || '';
			byId('eventsTable').value = state.draft.eventsTable || '';
			byId('datasetId').value = state.draft.datasetId || '';
			byId('lookbackDays').value = state.draft.lookbackDays ?? '';
			byId('userIdentityMode').value = state.draft.userIdentityMode;
			byId('userId').value = state.draft.userId || '';
			updateUserIdPlaceholder();
			byId('privacyBadge').innerText = 'Privacy: ' + state.privacyBadge;
			byId('authBadge').innerText = state.authStatus;
			byId('backendStateBadge').innerText = state.draft.enabled ? 'Backend: Enabled' : 'Backend: Disabled';
			
			// Update overview details
			const detailsDiv = byId('overviewDetails');
			if (state.draft.enabled) {
				detailsDiv.style.display = 'grid';
				byId('overviewProfile').textContent = state.draft.sharingProfile;
				byId('overviewDataset').textContent = state.draft.datasetId || 'not set';
				byId('statusMessage').textContent = state.message || '';
			} else {
				detailsDiv.style.display = 'none';
				byId('statusMessage').textContent = state.message || 'Backend is off. All data stays local; no Azure writes.';
			}
			byId('sharedKeyStatus').textContent = state.draft.authMode === 'sharedKey'
				? (hasSharedKey() ? 'Shared key stored securely for this storage account.' : 'Shared key not stored yet. Add it to enable connection testing.')
				: 'Uses your signed-in identity. No secret stored.';
			byId('confirmApply').checked = false;
			updateIdentityVisibility();
			updateAuthUi();
			updateEnabledState();
			updateReviewSummary();
		}

		function setErrors(errors = {}) {
			document.querySelectorAll('.error').forEach((el) => { el.textContent = ''; });
			// Clear all aria-invalid attributes
			document.querySelectorAll('vscode-text-field, vscode-dropdown').forEach((el) => {
				el.removeAttribute('aria-invalid');
			});
			Object.entries(errors).forEach(([key, message]) => {
				const target = document.querySelector(\`[data-error-for="\${key}"]\`);
				if (target) { 
					target.textContent = message;
					// Set aria-invalid on the field
					const field = byId(key);
					if (field) {
						field.setAttribute('aria-invalid', 'true');
					}
				}
			});
		}

		function readDraft() {
			const profile = byId('sharingProfile').value;
			// Derive shareWorkspaceMachineNames from profile
			const shareWorkspaceMachineNames = profile === 'soloFull' || profile === 'teamPseudonymous' || profile === 'teamIdentified';
			return {
				enabled: byId('enabledToggle').checked,
				authMode: byId('authMode').value,
				sharingProfile: profile,
				shareWorkspaceMachineNames,
				includeMachineBreakdown: true, // Always enabled
				datasetId: byId('datasetId').value,
				lookbackDays: Number(byId('lookbackDays').value),
				subscriptionId: byId('subscriptionId').value,
				resourceGroup: byId('resourceGroup').value,
				storageAccount: byId('storageAccount').value,
				aggTable: byId('aggTable').value,
				eventsTable: byId('eventsTable').value,
				userIdentityMode: byId('userIdentityMode').value,
				userId: byId('userId').value
			};
		}

		function validateLocal(draft) {
			const errors = {};
			if (!draft.datasetId || !draft.datasetId.trim()) errors.datasetId = 'Required';
			else if (!aliasRegex.test(draft.datasetId.trim())) errors.datasetId = 'Use letters, numbers, dashes, underscores';
			if (draft.enabled) {
				['subscriptionId','resourceGroup','storageAccount','aggTable'].forEach(f => {
					if (!draft[f] || !draft[f].trim()) errors[f] = 'Required';
				});
			}
			['aggTable','eventsTable'].forEach(f => {
				if (draft[f] && !aliasRegex.test(draft[f].trim())) errors[f] = 'Use letters, numbers, dashes, underscores';
			});
			if (draft.lookbackDays < 1 || draft.lookbackDays > 90 || Number.isNaN(draft.lookbackDays)) {
				errors.lookbackDays = '1-90';
			}
			if (draft.sharingProfile === 'teamIdentified') {
				const id = (draft.userId || '').trim();
				if (!id) {
					errors.userId = 'Alias or object ID required';
				} else if (draft.userIdentityMode === 'entraObjectId' && !/^[-0-9a-fA-F]{36}$/.test(id)) {
					errors.userId = 'Use an Entra object ID (GUID)';
				}
			}
			return { valid: Object.keys(errors).length === 0, errors };
		}

		function updateValidity() {
			const draft = readDraft();
			const validation = validateLocal(draft);
			setErrors(validation.errors);
			const allowSave = validation.valid && byId('confirmApply').checked;
			byId('saveBtnReview').disabled = !allowSave;
		}

		function updateIdentityVisibility() {
			const isIdentified = byId('sharingProfile').value === 'teamIdentified';
			byId('identityCard').style.display = isIdentified ? 'block' : 'none';
			updateUserIdPlaceholder();
		}

		function updateUserIdPlaceholder() {
			const mode = byId('userIdentityMode').value;
			const userIdField = byId('userId');
			if (mode === 'entraObjectId') {
				userIdField.setAttribute('placeholder', 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx');
			} else {
				userIdField.setAttribute('placeholder', 'alex-dev');
			}
		}

		function hasSharedKey() {
			const storage = (byId('storageAccount').value || '').trim();
			const storedFor = (currentState?.draft?.storageAccount || '').trim();
			return !!currentState.sharedKeySet && storage && storage === storedFor;
		}

		function updateEnabledState() {
			const enabled = byId('enabledToggle').checked;
			const azureSection = document.getElementById('azure');
			const sharingSection = document.getElementById('sharing');
			const advancedSection = document.getElementById('advanced');
			
			// Disable Azure settings and Auth card if backend is disabled
			const azureCards = azureSection.querySelectorAll('.card');
			azureCards.forEach((card, index) => {
				if (index > 0) { // Skip the first card (Enable backend toggle)
					if (enabled) {
						card.classList.remove('disabled-section');
					} else {
						card.classList.add('disabled-section');
					}
				}
			});
			
			// Disable Sharing and Advanced sections if backend is disabled
			if (enabled) {
				sharingSection.querySelectorAll('.card').forEach(c => c.classList.remove('disabled-section'));
				advancedSection.querySelectorAll('.card').forEach(c => c.classList.remove('disabled-section'));
			} else {
				sharingSection.querySelectorAll('.card').forEach(c => c.classList.add('disabled-section'));
				advancedSection.querySelectorAll('.card').forEach(c => c.classList.add('disabled-section'));
			}
		}

		function updateReviewSummary() {
			const draft = readDraft();
			const summary = byId('reviewSummary');
			if (!summary) return;
			
			let html = '';
			
			if (!draft.enabled) {
				html = '<div class="change-item danger"><div class="change-label">⚠️ Backend Disabled</div><div class="change-value">All token usage data will stay local-only. No sync to Azure.</div></div>';
			} else {
				html += '<div class="change-item"><div class="change-label">✓ Backend Enabled</div><div class="change-value">Token usage will sync to Azure Storage</div></div>';
				
				if (draft.subscriptionId && draft.resourceGroup && draft.storageAccount) {
					html += '<div class="change-item"><div class="change-label">Azure Resources</div><div class="change-value">Subscription: ' + draft.subscriptionId + '<br>Resource Group: ' + draft.resourceGroup + '<br>Storage Account: ' + draft.storageAccount + '</div></div>';
				} else {
					html += '<div class="change-item warning"><div class="change-label">⚠️ Azure Resources</div><div class="change-value">Not fully configured - some fields are missing</div></div>';
				}
				
				const authLabel = draft.authMode === 'sharedKey' ? 'Storage Shared Key' : 'Entra ID (RBAC)';
				html += '<div class="change-item"><div class="change-label">Authentication</div><div class="change-value">' + authLabel + '</div></div>';
				
				const profileLabels = {
					'off': 'Off (Local-only)',
					'soloFull': 'Solo (Personal)',
					'teamAnonymized': 'Team Anonymized',
					'teamPseudonymous': 'Team Pseudonymous',
					'teamIdentified': 'Team Identified'
				};
				const profileLabel = profileLabels[draft.sharingProfile] || draft.sharingProfile;
				let nameSync = 'Hashed IDs';
				if (draft.sharingProfile === 'soloFull' || draft.sharingProfile === 'teamPseudonymous' || draft.sharingProfile === 'teamIdentified') {
					nameSync = 'Readable names';
				}
				html += '<div class="change-item"><div class="change-label">Privacy & Sharing</div><div class="change-value">Profile: ' + profileLabel + '<br>Workspace/Machine Names: ' + nameSync + '<br>Per-machine breakdown: Always enabled</div></div>';
				
				if (draft.sharingProfile === 'teamIdentified' && draft.userId) {
					html += '<div class="change-item"><div class="change-label">User Identity</div><div class="change-value">' + draft.userId + ' (' + (draft.userIdentityMode === 'entraObjectId' ? 'Entra Object ID' : 'Team Alias') + ')</div></div>';
				}
				
				html += '<div class="change-item"><div class="change-label">Dataset & Lookback</div><div class="change-value">Dataset ID: ' + (draft.datasetId || 'default') + '<br>Lookback: ' + (draft.lookbackDays || 30) + ' days</div></div>';
			}
			
			summary.innerHTML = html;
		}

		function updateAuthUi() {
			const mode = byId('authMode').value;
			byId('updateKeyBtn').style.display = mode === 'sharedKey' ? 'inline-flex' : 'none';
			byId('sharedKeyStatus').style.display = mode === 'sharedKey' ? 'block' : 'none';
			if (mode === 'sharedKey') {
				byId('authHelper').textContent = 'Uses Storage Account Shared Key. Stored securely in VS Code on this device only.';
			} else {
				byId('authHelper').textContent = 'Uses your signed-in identity. Requires role-based access to the storage account. No secrets stored.';
			}
			updateConnectionAvailability();
		}

		function updateConnectionAvailability() {
			const enabled = byId('enabledToggle').checked;
			const offline = !navigator.onLine;
			const mode = byId('authMode').value;
			const needsKey = mode === 'sharedKey' && !hasSharedKey();
			const disabled = !enabled || offline || needsKey;
			byId('offlineBanner').classList.toggle('offline', offline);
			byId('testConnectionBtn').disabled = disabled;
			byId('testResult').className = 'status-line muted';
			if (!enabled) {
				byId('testResult').textContent = 'Enable the backend to test the connection.';
			} else if (offline) {
				byId('testResult').textContent = '✗ Offline. Connection testing unavailable until you reconnect.';
			} else if (needsKey) {
				byId('testResult').textContent = 'Add a shared key to test the connection.';
			} else {
				byId('testResult').textContent = 'Verifies credentials can read and write to storage tables.';
			}
		}

		function switchSection(target) {
			document.querySelectorAll('.section').forEach(sec => sec.classList.remove('active'));
			document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.remove('selected'));
			const sec = document.getElementById(target);
			const btn = document.querySelector(\`.nav-btn[data-target="\${target}"]\`);
			if (sec && btn) { sec.classList.add('active'); btn.classList.add('selected'); }
		}

		function bindNav() {
			document.querySelectorAll('.nav-btn').forEach(btn => {
				btn.addEventListener('click', () => switchSection(btn.getAttribute('data-target')));
			});
		}

		function bindActions() {
			const markDirty = () => vscodeApi.postMessage({ command: 'markDirty' });
			const trackIds = ['sharingProfile','authMode','subscriptionId','resourceGroup','storageAccount','aggTable','eventsTable','datasetId','lookbackDays','enabledToggle','userIdentityMode','userId'];
			trackIds.forEach(id => {
				const el = byId(id);
				if (!el) return;
				['input','change'].forEach(evt => el.addEventListener(evt, () => { markDirty(); updateIdentityVisibility(); updateAuthUi(); updateEnabledState(); updateReviewSummary(); updateValidity(); }));
			});
			byId('confirmApply').addEventListener('change', updateValidity);
			byId('saveBtnReview').addEventListener('click', () => vscodeApi.postMessage({ command: 'save', draft: readDraft() }));
			byId('discardBtnReview').addEventListener('click', () => vscodeApi.postMessage({ command: 'discard' }));
			byId('testConnectionBtn').addEventListener('click', () => vscodeApi.postMessage({ command: 'testConnection', draft: readDraft() }));
			byId('updateKeyBtn').addEventListener('click', () => vscodeApi.postMessage({ command: 'updateSharedKey', storageAccount: byId('storageAccount').value, draft: readDraft() }));
			byId('setupBtn').addEventListener('click', () => vscodeApi.postMessage({ command: 'launchWizard' }));
			byId('launchWizardLink').addEventListener('click', (e) => {
				e.preventDefault();
				vscodeApi.postMessage({ command: 'launchWizard' });
			});
			byId('clearSettingsBtn').addEventListener('click', () => vscodeApi.postMessage({ command: 'clearAzureSettings' }));
		}

		window.addEventListener('message', (event) => {
			const msg = event.data;
			if (msg.type === 'state') {
				currentState = msg.state;
				setFieldValues(currentState);
				setErrors(msg.errors || {});
				updateValidity();
				byId('statusMessage').textContent = msg.message || '';
			}
			if (msg.type === 'testResult') {
				const { ok, message } = msg.result;
				byId('testResult').className = ok ? 'status-line ok' : 'status-line error';
				byId('testResult').textContent = ok ? '✓ ' + message : '✗ ' + message;
			}
			if (msg.type === 'sharedKeyResult') {
				const { ok, message } = msg.result;
				byId('testResult').className = ok ? 'status-line ok' : 'status-line error';
				byId('testResult').textContent = ok ? '✓ ' + message : '✗ Shared key update failed: ' + message;
			}
		});

		updateConnectionAvailability();
		window.addEventListener('offline', updateConnectionAvailability);
		window.addEventListener('online', updateConnectionAvailability);
		setFieldValues(initial);
		setErrors(initial.errors || {});
		bindNav();
		bindActions();
		updateValidity();
	</script>
</body>
</html>`;
	}
}

/**
 * Export renderHtml for testing purposes.
 * This allows integration tests to verify the HTML structure and JavaScript functionality.
 */
export function renderBackendConfigHtml(webview: vscode.Webview, state: BackendConfigPanelState): string {

	const panel = new BackendConfigPanel(vscode.Uri.file('/test'), {
		getState: async () => state,
		onSave: async () => ({ state, errors: {} }),
		onDiscard: async () => state,
		onStayLocal: async () => state,
		onTestConnection: async () => ({ ok: true, message: 'Test' }),
		onUpdateSharedKey: async () => ({ ok: true, message: 'Test' }),
		onLaunchWizard: async () => state,
		onClearAzureSettings: async () => state
	});
	return (panel as any).renderHtml(webview, state);
}
