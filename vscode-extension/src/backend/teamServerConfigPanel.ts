import * as vscode from 'vscode';
import * as crypto from 'crypto';

function getNonce(): string {
	return crypto.randomBytes(16).toString('hex');
}

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
		const config = vscode.workspace.getConfiguration('copilotTokenTracker');
		const enabled: boolean = config.get<boolean>('backend.sharingServer.enabled', false);
		const endpointUrl: string = config.get<string>('backend.sharingServer.endpointUrl', '');

		this.panel = vscode.window.createWebviewPanel(
			'copilotTeamServerConfig',
			'AI Engineering Fluency: Configure Team Server',
			{ viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
			{ enableScripts: true, retainContextWhenHidden: false }
		);

		this.panel.webview.html = this.renderHtml(this.panel.webview, enabled, endpointUrl);

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

		const config = vscode.workspace.getConfiguration('copilotTokenTracker');
		await config.update('backend.sharingServer.enabled', enabled, vscode.ConfigurationTarget.Global);
		await config.update('backend.sharingServer.endpointUrl', endpointUrl, vscode.ConfigurationTarget.Global);

		vscode.window.showInformationMessage('Team Server configuration saved.');
		this.panel?.dispose();
	}

	private renderHtml(webview: vscode.Webview, enabled: boolean, endpointUrl: string): string {
		const nonce = getNonce();
		const csp = `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';`;

		const enabledChecked = enabled ? 'checked' : '';
		const safeEndpoint = endpointUrl.replace(/"/g, '&quot;');

		return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Configure Team Server</title>
  <style nonce="${nonce}">
    :root {
      --vscode-font-family: var(--vscode-font-family, system-ui, sans-serif);
      --vscode-font-size: var(--vscode-font-size, 13px);
    }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background-color: var(--vscode-editor-background);
      padding: 24px;
      max-width: 560px;
    }
    h1 {
      font-size: 1.2em;
      margin-bottom: 24px;
      font-weight: 600;
    }
    .field {
      margin-bottom: 20px;
    }
    .field label {
      display: block;
      margin-bottom: 6px;
      font-weight: 500;
    }
    .field input[type="text"] {
      width: 100%;
      box-sizing: border-box;
      padding: 6px 8px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, #ccc);
      border-radius: 2px;
      font-size: inherit;
      font-family: inherit;
    }
    .field input[type="text"]:focus {
      outline: 1px solid var(--vscode-focusBorder);
      border-color: var(--vscode-focusBorder);
    }
    .field input[type="text"].error {
      border-color: var(--vscode-inputValidation-errorBorder, #e51400);
    }
    .field-hint {
      font-size: 0.9em;
      color: var(--vscode-descriptionForeground);
      margin-top: 4px;
    }
    .error-msg {
      color: var(--vscode-inputValidation-errorForeground, #e51400);
      background: var(--vscode-inputValidation-errorBackground, #f2dede);
      border: 1px solid var(--vscode-inputValidation-errorBorder, #e51400);
      border-radius: 2px;
      padding: 4px 8px;
      margin-top: 4px;
      font-size: 0.9em;
      display: none;
    }
    .toggle-row {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .toggle-row label {
      margin: 0;
      cursor: pointer;
    }
    .actions {
      display: flex;
      gap: 10px;
      margin-top: 28px;
    }
    button {
      padding: 6px 16px;
      font-size: inherit;
      font-family: inherit;
      border: none;
      border-radius: 2px;
      cursor: pointer;
    }
    button.primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    button.primary:hover {
      background: var(--vscode-button-hoverBackground);
    }
    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    button.secondary:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
  </style>
</head>
<body>
  <h1>Configure Team Server</h1>

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

  <div class="actions">
    <button class="primary" id="btn-save">Save</button>
    <button class="secondary" id="btn-cancel">Cancel</button>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    document.getElementById('btn-save').addEventListener('click', () => {
      const enabled = document.getElementById('chk-enabled').checked;
      const endpointUrl = document.getElementById('txt-endpoint').value.trim();
      clearErrors();
      vscode.postMessage({ command: 'save', enabled, endpointUrl });
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
  </script>
</body>
</html>`;
	}
}
