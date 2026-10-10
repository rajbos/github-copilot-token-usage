import * as vscode from 'vscode';
import { getNonce } from '../utils/webviewUtils';
import { readExplicitSharingProfile } from './settings';
import { applySettingsAtomically } from './settingsBatch';
import { inferSharingProfile } from './settingsValidation';
import type { BackendUserIdentityMode } from './identity';

export class TeamServerConfigPanel implements vscode.Disposable {
	private static current: TeamServerConfigPanel | undefined;

	private panel: vscode.WebviewPanel | undefined;
	private readonly disposables: vscode.Disposable[] = [];
	private disposed = false;

	public static show(context: vscode.ExtensionContext): void {
		if (TeamServerConfigPanel.current && !TeamServerConfigPanel.current.disposed) {
			TeamServerConfigPanel.current.panel?.reveal();
			return;
		}
		const instance = new TeamServerConfigPanel(context.extensionUri);
		TeamServerConfigPanel.current = instance;
		instance.open();
	}

	constructor(private readonly extensionUri: vscode.Uri) {}

	public isDisposed(): boolean {
		return this.disposed;
	}

	public dispose(): void {
		this.disposed = true;
		for (const d of this.disposables) {
			d.dispose();
		}
		this.disposables.length = 0;
		if (this.panel) {
			this.panel.dispose();
			this.panel = undefined;
		}
		if (TeamServerConfigPanel.current === this) {
			TeamServerConfigPanel.current = undefined;
		}
	}

	private open(): void {
		const config = vscode.workspace.getConfiguration('aiEngineeringFluency');
		const enabled: boolean = config.get<boolean>('backend.sharingServer.enabled', false);
		const endpointUrl: string = config.get<string>('backend.sharingServer.endpointUrl', '');
		// Preselect the explicit profile, or — when none is set — what an enabled Team Server infers
		// (the same inference getBackendSettings applies, including legacy shareWithTeam). Reading
		// get()'s 'off' default here would make an unchanged save persist an explicit 'off' and
		// silently disable uploads.
		const sharingProfile: string = readExplicitSharingProfile(config) ?? inferSharingProfile(
			undefined,
			true,
			config.get<boolean>('backend.shareWithTeam', false),
			config.get<BackendUserIdentityMode>('backend.userIdentityMode', 'pseudonymous'),
		);

		this.panel = vscode.window.createWebviewPanel(
			'copilotTeamServerConfig',
			'AI Engineering Fluency: Configure Team Server',
			{ viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
			{ enableScripts: true, retainContextWhenHidden: false }
		);

		this.panel.webview.html = this.renderHtml(this.panel.webview, enabled, endpointUrl, sharingProfile);

		this.disposables.push(
			this.panel.onDidDispose(() => this.dispose()),
			this.panel.webview.onDidReceiveMessage(async (message) => this.handleMessage(message))
		);
	}

	private async handleMessage(message: any): Promise<void> {
		if (message?.command !== 'save') {
			return;
		}
		const enabled: boolean = Boolean(message.enabled);
		const endpointUrl: string = String(message.endpointUrl ?? '').trim();
		const sharingProfile: string = String(message.sharingProfile ?? 'off');

		if (enabled && !endpointUrl) {
			this.panel?.webview.postMessage({ command: 'validationError', field: 'endpointUrl', text: 'Endpoint URL is required when Team Server is enabled.' });
			return;
		}

		try {
			new URL(endpointUrl || 'http://placeholder'); // validate URL only when non-empty
		} catch {
			if (endpointUrl) {
				this.panel?.webview.postMessage({ command: 'validationError', field: 'endpointUrl', text: 'Endpoint URL must be a valid URL (e.g. https://your-server.example.com).' });
				return;
			}
		}

		const validProfiles = ['off', 'soloFull', 'teamAnonymized', 'teamPseudonymous', 'teamIdentified'];
		const safeProfile = validProfiles.includes(sharingProfile) ? sharingProfile : 'off';

		// Every settings write triggers a sync, and the sharing profile is shared with Azure, so the
		// writes are applied as one batch: the settings-change sync runs once, after the last write,
		// never against a half-applied configuration. The order is also safe on its own (Team
		// Server off, then profile, endpoint, and on last) as a second line of defence.
		const config = vscode.workspace.getConfiguration('aiEngineeringFluency');
		const target = vscode.ConfigurationTarget.Global;
		await applySettingsAtomically(async () => {
			if (!enabled || config.get<boolean>('backend.sharingServer.enabled', false)) {
				await config.update('backend.sharingServer.enabled', false, target);
			}
			await config.update('backend.sharingProfile', safeProfile, target);
			await config.update('backend.sharingServer.endpointUrl', endpointUrl, target);
			if (enabled) {
				await config.update('backend.sharingServer.enabled', true, target);
			}
		});

		vscode.window.showInformationMessage('Team Server configuration saved.');
		this.panel?.dispose();
	}

	private renderHtml(_webview: vscode.Webview, enabled: boolean, endpointUrl: string, sharingProfile: string): string {
		const nonce = getNonce();
		const csp = `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';`;
		const enabledChecked = enabled ? 'checked' : '';
		const safeEndpoint = endpointUrl.replace(/"/g, '&quot;');
		const profileOptions = [
			{ value: 'off', label: 'Off — no user-level data synced' },
			{ value: 'soloFull', label: 'Solo Full — personal, full fidelity' },
			{ value: 'teamAnonymized', label: 'Team Anonymized — team data, no per-user key' },
			{ value: 'teamPseudonymous', label: 'Team Pseudonymous — stable anonymous per-user key' },
			{ value: 'teamIdentified', label: 'Team Identified — explicit user identity' },
		].map(o => `<option value="${o.value}"${sharingProfile === o.value ? ' selected' : ''}>${o.label}</option>`).join('\n\t\t\t\t');
		return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Configure Team Server</title>
  ${renderTeamPanelStyle(nonce)}
</head>
${renderTeamPanelBody(nonce, enabledChecked, safeEndpoint, profileOptions)}
</html>`;
	}
}

function renderTeamPanelStyle(nonce: string): string {
	return `<style nonce="${nonce}">
${renderTeamPanelBaseStyles()}
${renderTeamPanelInteractiveStyles()}
  </style>`;
}

function renderTeamPanelBaseStyles(): string {
	return `    :root {
      --vscode-font-family: var(--vscode-font-family, system-ui, sans-serif);
      --vscode-font-size: var(--vscode-font-size, 13px);
    }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background-color: var(--vscode-editor-background);
      padding: 24px;
      max-width: 1040px;
    }
    h1 { font-size: 1.2em; margin-bottom: 24px; font-weight: 600; }
    h2 { font-size: 1.05em; margin: 0 0 10px; font-weight: 600; }
    h3 { font-size: 0.95em; margin: 18px 0 8px; font-weight: 600; }
    .layout { display: flex; flex-wrap: wrap; gap: 32px; align-items: flex-start; }
    .form-col { flex: 1 1 360px; min-width: 280px; }
    .info-col {
      flex: 2 1 320px; min-width: 280px; padding-left: 28px;
      border-left: 1px solid var(--vscode-panel-border, #454545);
    }
    @media (max-width: 720px) {
      .info-col { padding-left: 0; border-left: none; border-top: 1px solid var(--vscode-panel-border, #454545); padding-top: 20px; }
    }
    .field { margin-bottom: 20px; }
    .field label { display: block; margin-bottom: 6px; font-weight: 500; }
    .field input[type="text"] {
      width: 100%; box-sizing: border-box; padding: 6px 8px;
      background: var(--vscode-input-background); color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, #ccc); border-radius: 2px;
      font-size: inherit; font-family: inherit;
    }
    .field input[type="text"]:focus { outline: 1px solid var(--vscode-focusBorder); border-color: var(--vscode-focusBorder); }
    .field input[type="text"].error { border-color: var(--vscode-inputValidation-errorBorder, #e51400); }
    .field-hint { font-size: 0.9em; color: var(--vscode-descriptionForeground); margin-top: 4px; }
    .error-msg {
      color: var(--vscode-inputValidation-errorForeground, #e51400);
      background: var(--vscode-inputValidation-errorBackground, #f2dede);
      border: 1px solid var(--vscode-inputValidation-errorBorder, #e51400);
      border-radius: 2px; padding: 4px 8px; margin-top: 4px; font-size: 0.9em; display: none;
    }`;
}

function renderTeamPanelInteractiveStyles(): string {
	return `    .toggle-row { display: flex; align-items: center; gap: 10px; }
    .toggle-row label { margin: 0; cursor: pointer; }
    .actions { display: flex; gap: 10px; margin-top: 28px; }
    button {
      padding: 6px 16px; font-size: inherit; font-family: inherit;
      border: none; border-radius: 2px; cursor: pointer;
    }
    button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    button.primary:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .field select {
      width: 100%; box-sizing: border-box; padding: 6px 8px;
      background: var(--vscode-input-background); color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, #ccc); border-radius: 2px;
      font-size: inherit; font-family: inherit;
    }
    .field select:focus { outline: 1px solid var(--vscode-focusBorder); border-color: var(--vscode-focusBorder); }
    .info-lead { color: var(--vscode-descriptionForeground); margin: 0 0 14px; line-height: 1.5; }
    .info-card {
      background: var(--vscode-textCodeBlock-background, #2d2d30);
      border: 1px solid var(--vscode-panel-border, #454545);
      border-radius: 4px; padding: 10px 12px; margin-bottom: 10px; font-size: 0.92em; line-height: 1.5;
    }
    .info-card .row { margin-bottom: 4px; }
    .info-card .row strong { font-weight: 600; }
    .fields-table { width: 100%; border-collapse: collapse; font-size: 0.88em; margin-bottom: 12px; }
    .fields-table th, .fields-table td {
      text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border, #454545);
    }
    .fields-table th { font-weight: 600; color: var(--vscode-descriptionForeground); }
    .callout {
      background: var(--vscode-inputValidation-infoBackground, #063b49);
      border: 1px solid var(--vscode-inputValidation-infoBorder, #007acc);
      border-radius: 2px; padding: 8px 10px; font-size: 0.88em; margin-bottom: 8px;
    }
    .dashboard-preview {
      border: 1px solid var(--vscode-panel-border, #454545); border-radius: 4px;
      padding: 14px; background: var(--vscode-editorWidget-background, #252526);
    }
    .dashboard-preview .dp-note { font-size: 0.85em; color: var(--vscode-descriptionForeground); margin-bottom: 10px; }
    .dp-summary { display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
    .dp-tile {
      flex: 1 1 90px; background: var(--vscode-textCodeBlock-background, #2d2d30);
      border-radius: 3px; padding: 8px 10px;
    }
    .dp-tile .dp-label { font-size: 0.78em; color: var(--vscode-descriptionForeground); }
    .dp-tile .dp-value { font-size: 1.1em; font-weight: 700; color: var(--vscode-charts-blue, #3794ff); }
    .dp-bar-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; font-size: 0.82em; }
    .dp-bar-label { flex: 0 0 90px; color: var(--vscode-descriptionForeground); }
    .dp-bar-track { flex: 1; background: var(--vscode-editorWidget-background, #333); border-radius: 3px; height: 10px; overflow: hidden; }
    .dp-bar-fill { height: 100%; background: var(--vscode-charts-blue, #3794ff); border-radius: 3px; }
    .dp-bar-pct { flex: 0 0 36px; text-align: right; color: var(--vscode-descriptionForeground); }
    .dp-trend { display: flex; align-items: flex-end; gap: 4px; height: 60px; margin-top: 12px; }
    .dp-trend-bar { flex: 1; background: var(--vscode-charts-purple, #c586c0); border-radius: 2px 2px 0 0; }`;
}

function renderTeamPanelBody(nonce: string, enabledChecked: string, safeEndpoint: string, profileOptions: string): string {
	return `<body>
  <h1>Configure Team Server</h1>
  <div class="layout">
    <div class="form-col">
      <div class="field">
        <div class="toggle-row">
          <input type="checkbox" id="chk-enabled" ${enabledChecked}>
          <label for="chk-enabled">Enable Team Server backend</label>
        </div>
        <p class="field-hint">When enabled, session data is pushed to your self-hosted sharing server.</p>
      </div>
      <div class="field">
        <label for="txt-endpoint">Server endpoint URL</label>
        <input type="text" id="txt-endpoint" placeholder="https://your-server.example.com" value="${safeEndpoint}">
        <div class="error-msg" id="err-endpoint"></div>
        <p class="field-hint">The base URL of your team sharing server (no trailing slash required).</p>
      </div>
      <div class="field">
        <label for="sel-profile">Sharing profile</label>
        <select id="sel-profile">
					${profileOptions}
        </select>
        <p class="field-hint">See "What data is shared" on the right for what each profile sends.</p>
      </div>
      <div class="actions">
        <button class="primary" id="btn-save">Save</button>
        <button class="secondary" id="btn-cancel">Cancel</button>
      </div>
    </div>
    ${renderTeamInfoColumn()}
  </div>
  ${renderTeamPanelScript(nonce)}
</body>`;
}

function renderTeamInfoColumn(): string {
	return `<div class="info-col">
      <h2>What data is shared</h2>
      <p class="info-lead">The extension reuses your existing GitHub sign-in — no new credentials are created. On a periodic timer (at most every 5 minutes) it sends aggregated usage rollups (never raw prompts or completions) to the server URL above.</p>
      <div class="info-card">
        <div class="row"><strong>Your identity:</strong> every upload is authenticated with your GitHub token, so the server always knows which GitHub account sent it. Unlike the Azure Storage backend, the Team Server has no anonymous mode — the sharing profile below controls whether readable workspace/machine <em>names</em> are included (together with the "share readable names" setting) and whether a per-user dimension is added, not whether you're identifiable.</div>
      </div>
      <div class="info-card" id="profile-explainer"></div>
      <h3>Fields sent per upload</h3>
      <table class="fields-table">
        <tr><th>Field</th><th>Example</th></tr>
        <tr><td>day, model</td><td>2026-09-07, claude-sonnet-5</td></tr>
        <tr><td>inputTokens, outputTokens, interactions</td><td>8123456, 55400, 6</td></tr>
        <tr><td>workspaceId, machineId</td><td>opaque IDs — always included, not raw file paths</td></tr>
        <tr><td>workspaceName, machineName</td><td>optional, only when the profile enables names</td></tr>
        <tr><td>editor</td><td>Copilot CLI, VS Code, Claude Desktop, ...</td></tr>
        <tr><td>datasetId, fluencyMetrics</td><td>your configured dataset tag; fluency score breakdown</td></tr>
      </table>
      <div class="callout">Prompt and response content is never uploaded — only the aggregate counts above.</div>
      <h2>What you'll get</h2>
      <div class="dashboard-preview">
        <p class="dp-note">Illustrative preview of the team dashboard members sign into with GitHub — not live data.</p>
        <div class="dp-summary">
          <div class="dp-tile"><div class="dp-label">Input Tokens</div><div class="dp-value">8.1M</div></div>
          <div class="dp-tile"><div class="dp-label">Output Tokens</div><div class="dp-value">55.4K</div></div>
          <div class="dp-tile"><div class="dp-label">Interactions</div><div class="dp-value">6</div></div>
          <div class="dp-tile"><div class="dp-label">Days Active</div><div class="dp-value">1</div></div>
        </div>
        <div class="dp-bar-row"><span class="dp-bar-label">Copilot CLI</span><div class="dp-bar-track"><div class="dp-bar-fill" data-width="89"></div></div><span class="dp-bar-pct">89%</span></div>
        <div class="dp-bar-row"><span class="dp-bar-label">Claude Desktop</span><div class="dp-bar-track"><div class="dp-bar-fill" data-width="10"></div></div><span class="dp-bar-pct">10%</span></div>
        <div class="dp-bar-row"><span class="dp-bar-label">VS Code</span><div class="dp-bar-track"><div class="dp-bar-fill" data-width="1"></div></div><span class="dp-bar-pct">1%</span></div>
        <div class="dp-trend">
          <div class="dp-trend-bar" data-height="20"></div>
          <div class="dp-trend-bar" data-height="35"></div>
          <div class="dp-trend-bar" data-height="15"></div>
          <div class="dp-trend-bar" data-height="55"></div>
          <div class="dp-trend-bar" data-height="70"></div>
          <div class="dp-trend-bar" data-height="40"></div>
          <div class="dp-trend-bar" data-height="90"></div>
        </div>
      </div>
    </div>`;
}

function renderTeamPanelScript(nonce: string): string {
	return `<script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const PROFILE_EXPLAINERS = {
      off: '<div class="row"><strong>Off</strong> — sync is disabled entirely. Nothing is sent to the Team Server for this profile.</div>',
      soloFull: '<div class="row"><strong>Solo Full</strong> — readable workspace and machine names are always included, since only you see this data. No separate per-user dimension is added (you are the only user).</div>',
      teamAnonymized: '<div class="row"><strong>Team Anonymized</strong> — workspace/machine <em>names</em> are withheld; only the opaque IDs are sent, and no per-user dimension is added. Note this does not hide who uploaded it — see "Your identity" above.</div>',
      teamPseudonymous: '<div class="row"><strong>Team Pseudonymous</strong> — adds a per-user dimension to the rollups. Workspace/machine names follow the "share readable names" setting below (off by default).</div>',
      teamIdentified: '<div class="row"><strong>Team Identified</strong> — adds a per-user dimension to the rollups. Workspace/machine names follow the "share readable names" setting below (off by default). Combined with your always-on GitHub identity, this is the most transparent profile.</div>',
    };
    function updateProfileExplainer() {
      const profile = document.getElementById('sel-profile').value;
      document.getElementById('profile-explainer').innerHTML = PROFILE_EXPLAINERS[profile] || PROFILE_EXPLAINERS.teamAnonymized;
    }
    document.getElementById('sel-profile').addEventListener('change', updateProfileExplainer);
    updateProfileExplainer();
    document.querySelectorAll('.dp-bar-fill[data-width]').forEach((el) => { el.style.width = el.getAttribute('data-width') + '%'; });
    document.querySelectorAll('.dp-trend-bar[data-height]').forEach((el) => { el.style.height = el.getAttribute('data-height') + '%'; });
    document.getElementById('btn-save').addEventListener('click', () => {
      const enabled = document.getElementById('chk-enabled').checked;
      const endpointUrl = document.getElementById('txt-endpoint').value.trim();
      const sharingProfile = document.getElementById('sel-profile').value;
      clearErrors();
      vscode.postMessage({ command: 'save', enabled, endpointUrl, sharingProfile });
    });
    document.getElementById('btn-cancel').addEventListener('click', () => {
      vscode.postMessage({ command: 'cancel' });
    });
    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.command === 'validationError' && msg.field === 'endpointUrl') {
        const input = document.getElementById('txt-endpoint');
        const errEl = document.getElementById('err-endpoint');
        input.classList.add('error');
        errEl.textContent = msg.text;
        errEl.style.display = 'block';
        input.focus();
      }
    });
    function clearErrors() {
      const input = document.getElementById('txt-endpoint');
      const errEl = document.getElementById('err-endpoint');
      input.classList.remove('error');
      errEl.style.display = 'none';
    }
  </script>`;
}
