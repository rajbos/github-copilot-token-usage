import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type * as vscode from 'vscode';

interface HookDefinition {
	event: 'SessionStart' | 'UserPromptSubmit';
	bashScript: string;
	ps1Script: string;
}

const HOOK_DEFINITIONS: Record<string, HookDefinition> = {
	'missing-instructions': {
		event: 'SessionStart',
		bashScript: `#!/bin/bash
# AI Engineering Fluency — Session Reminder: missing-instructions
INPUT=$(cat)
CWD=$(echo "$INPUT" | grep -o '"cwd":"[^"]*"' | cut -d'"' -f4)
WORKSPACE_HASH=$(echo "$CWD" | cksum | cut -d' ' -f1)
STATE_DIR="$HOME/.copilot/hooks/.nudge-state"
STATE_FILE="$STATE_DIR/missing-instructions-$WORKSPACE_HASH"
COOLDOWN_DAYS=7

[ -f ".github/copilot-instructions.md" ] && printf '{"continue":true}' && exit 0

NOW=$(date +%s 2>/dev/null || echo 0)
LAST=$(cat "$STATE_FILE" 2>/dev/null || echo 0)
AGE=$(( (NOW - LAST) / 86400 ))
[ "$AGE" -lt "$COOLDOWN_DAYS" ] && printf '{"continue":true}' && exit 0

mkdir -p "$STATE_DIR" && echo "$NOW" > "$STATE_FILE"
printf '{"systemMessage":"💡 No .github/copilot-instructions.md found. Add one to give Copilot project-specific context and improve AI response quality."}'
`,
		ps1Script: `# AI Engineering Fluency — Session Reminder: missing-instructions
$inputData = [Console]::In.ReadToEnd()
$data = $inputData | ConvertFrom-Json -ErrorAction SilentlyContinue
if ($data.cwd) { $cwd = $data.cwd } else { $cwd = "" }
$workspaceHash = [System.Math]::Abs($cwd.GetHashCode()).ToString()
$stateDir = Join-Path $env:USERPROFILE ".copilot\hooks\.nudge-state"
$stateFile = Join-Path $stateDir "missing-instructions-$workspaceHash"
$cooldownDays = 7

if (Test-Path ".github\copilot-instructions.md") { Write-Output '{"continue":true}'; exit 0 }

$now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
if (Test-Path $stateFile) { $last = [long](Get-Content $stateFile -Raw).Trim() } else { $last = 0 }
$age = [Math]::Floor(($now - $last) / 86400)
if ($age -lt $cooldownDays) { Write-Output '{"continue":true}'; exit 0 }

if (-not (Test-Path $stateDir)) { New-Item -ItemType Directory -Force -Path $stateDir | Out-Null }
$now | Out-File -FilePath $stateFile -Encoding utf8 -NoNewline
Write-Output '{"systemMessage":"💡 No .github/copilot-instructions.md found. Add one to give Copilot project-specific context and improve AI response quality."}'
`,
	},
	'no-context-refs': {
		event: 'UserPromptSubmit',
		bashScript: `#!/bin/bash
# AI Engineering Fluency — Session Reminder: no-context-refs
INPUT=$(cat)
CWD=$(echo "$INPUT" | grep -o '"cwd":"[^"]*"' | cut -d'"' -f4)
WORKSPACE_HASH=$(echo "$CWD" | cksum | cut -d' ' -f1)
STATE_DIR="$HOME/.copilot/hooks/.nudge-state"
STATE_FILE="$STATE_DIR/no-context-refs-$WORKSPACE_HASH"
COOLDOWN_DAYS=3

PROMPT=$(echo "$INPUT" | grep -o '"prompt":"[^"]*"' | head -1 | cut -d'"' -f4)
[ \${#PROMPT} -lt 80 ] && printf '{"continue":true}' && exit 0
echo "$PROMPT" | grep -qiE '(#[a-z]|@workspace|@terminal|@vscode)' && printf '{"continue":true}' && exit 0

NOW=$(date +%s 2>/dev/null || echo 0)
LAST=$(cat "$STATE_FILE" 2>/dev/null || echo 0)
AGE=$(( (NOW - LAST) / 86400 ))
[ "$AGE" -lt "$COOLDOWN_DAYS" ] && printf '{"continue":true}' && exit 0

mkdir -p "$STATE_DIR" && echo "$NOW" > "$STATE_FILE"
printf '{"systemMessage":"💡 Tip: Add context references like #file or @workspace to get more accurate, project-specific responses."}'
`,
		ps1Script: `# AI Engineering Fluency — Session Reminder: no-context-refs
$inputData = [Console]::In.ReadToEnd()
$data = $inputData | ConvertFrom-Json -ErrorAction SilentlyContinue
if ($data.cwd) { $cwd = $data.cwd } else { $cwd = "" }
$workspaceHash = [System.Math]::Abs($cwd.GetHashCode()).ToString()
$stateDir = Join-Path $env:USERPROFILE ".copilot\hooks\.nudge-state"
$stateFile = Join-Path $stateDir "no-context-refs-$workspaceHash"
$cooldownDays = 3

if ($data.prompt) { $prompt = $data.prompt } else { $prompt = "" }
if ($prompt.Length -lt 80) { Write-Output '{"continue":true}'; exit 0 }
if ($prompt -match '(#[a-zA-Z]|@workspace|@terminal|@vscode)') { Write-Output '{"continue":true}'; exit 0 }

$now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
if (Test-Path $stateFile) { $last = [long](Get-Content $stateFile -Raw).Trim() } else { $last = 0 }
$age = [Math]::Floor(($now - $last) / 86400)
if ($age -lt $cooldownDays) { Write-Output '{"continue":true}'; exit 0 }

if (-not (Test-Path $stateDir)) { New-Item -ItemType Directory -Force -Path $stateDir | Out-Null }
$now | Out-File -FilePath $stateFile -Encoding utf8 -NoNewline
Write-Output '{"systemMessage":"💡 Tip: Add context references like #file or @workspace to get more accurate, project-specific responses."}'
`,
	},
	'no-mcp-config': {
		event: 'SessionStart',
		bashScript: `#!/bin/bash
# AI Engineering Fluency — Session Reminder: no-mcp-config
INPUT=$(cat)
CWD=$(echo "$INPUT" | grep -o '"cwd":"[^"]*"' | cut -d'"' -f4)
WORKSPACE_HASH=$(echo "$CWD" | cksum | cut -d' ' -f1)
STATE_DIR="$HOME/.copilot/hooks/.nudge-state"
STATE_FILE="$STATE_DIR/no-mcp-config-$WORKSPACE_HASH"
COOLDOWN_DAYS=7

[ -f ".vscode/mcp.json" ] && printf '{"continue":true}' && exit 0

NOW=$(date +%s 2>/dev/null || echo 0)
LAST=$(cat "$STATE_FILE" 2>/dev/null || echo 0)
AGE=$(( (NOW - LAST) / 86400 ))
[ "$AGE" -lt "$COOLDOWN_DAYS" ] && printf '{"continue":true}' && exit 0

mkdir -p "$STATE_DIR" && echo "$NOW" > "$STATE_FILE"
printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"No MCP server configuration (.vscode/mcp.json) detected. MCP servers can connect Copilot to databases, APIs, and external tools."}}'
`,
		ps1Script: `# AI Engineering Fluency — Session Reminder: no-mcp-config
$inputData = [Console]::In.ReadToEnd()
$data = $inputData | ConvertFrom-Json -ErrorAction SilentlyContinue
if ($data.cwd) { $cwd = $data.cwd } else { $cwd = "" }
$workspaceHash = [System.Math]::Abs($cwd.GetHashCode()).ToString()
$stateDir = Join-Path $env:USERPROFILE ".copilot\hooks\.nudge-state"
$stateFile = Join-Path $stateDir "no-mcp-config-$workspaceHash"
$cooldownDays = 7

if (Test-Path ".vscode\mcp.json") { Write-Output '{"continue":true}'; exit 0 }

$now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
if (Test-Path $stateFile) { $last = [long](Get-Content $stateFile -Raw).Trim() } else { $last = 0 }
$age = [Math]::Floor(($now - $last) / 86400)
if ($age -lt $cooldownDays) { Write-Output '{"continue":true}'; exit 0 }

if (-not (Test-Path $stateDir)) { New-Item -ItemType Directory -Force -Path $stateDir | Out-Null }
$now | Out-File -FilePath $stateFile -Encoding utf8 -NoNewline
Write-Output '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"No MCP server configuration (.vscode/mcp.json) detected. MCP servers can connect Copilot to databases, APIs, and external tools."}}'
`,
	},
};

export class HookManager {
	constructor(
		private readonly globalState: vscode.Memento,
		private readonly log: (message: string) => void,
	) {}

	public getHooksDirectory(): string {
		return path.join(os.homedir(), '.copilot', 'hooks');
	}

	public getInstalledHooks(): string[] {
		return this.globalState.get<string[]>('installedCopilotHooks', []);
	}

	public async installHook(hookId: string): Promise<void> {
		const def = HOOK_DEFINITIONS[hookId];
		if (!def) {
			throw new Error(`Unknown hook ID: ${hookId}`);
		}

		const hooksDir = this.getHooksDirectory();
		await fs.promises.mkdir(hooksDir, { recursive: true });

		const bashPath = path.join(hooksDir, `${hookId}.sh`);
		const ps1Path = path.join(hooksDir, `${hookId}.ps1`);

		// Write scripts to disk first
		await fs.promises.writeFile(bashPath, def.bashScript, { encoding: 'utf8', mode: 0o755 });
		await fs.promises.writeFile(ps1Path, def.ps1Script, 'utf8');

		// Rebuild hooks config on disk
		const installed = [...new Set([...this.getInstalledHooks(), hookId])];
		await this.writeHooksConfig(installed, hooksDir);

		// Update globalState only after all disk writes succeed
		await this.globalState.update('installedCopilotHooks', installed);
		this.log(`Installed Copilot hook: ${hookId}`);
	}

	public async uninstallHook(hookId: string): Promise<void> {
		const hooksDir = this.getHooksDirectory();

		const bashPath = path.join(hooksDir, `${hookId}.sh`);
		const ps1Path = path.join(hooksDir, `${hookId}.ps1`);

		for (const filePath of [bashPath, ps1Path]) {
			try {
				await fs.promises.unlink(filePath);
			} catch {
				// Ignore missing files
			}
		}

		const installed = this.getInstalledHooks().filter(id => id !== hookId);
		await this.writeHooksConfig(installed, hooksDir);

		// Update globalState only after all disk writes succeed
		await this.globalState.update('installedCopilotHooks', installed);
		this.log(`Uninstalled Copilot hook: ${hookId}`);
	}

	private async writeHooksConfig(installed: string[], hooksDir: string): Promise<void> {
		const sessionStartHooks: object[] = [];
		const userPromptSubmitHooks: object[] = [];

		for (const hookId of installed) {
			const def = HOOK_DEFINITIONS[hookId];
			if (!def) { continue; }

			// Use forward slashes for bash path, native separators for PowerShell path
			const bashPath = path.join(hooksDir, `${hookId}.sh`).replace(/\\/g, '/');
			const ps1Path = path.join(hooksDir, `${hookId}.ps1`);

			const entry = {
				type: 'command',
				command: `bash "${bashPath}"`,
				windows: `powershell -NoProfile -ExecutionPolicy Bypass -NonInteractive -File "${ps1Path}"`,
			};

			if (def.event === 'SessionStart') {
				sessionStartHooks.push(entry);
			} else {
				userPromptSubmitHooks.push(entry);
			}
		}

		const hooks: Record<string, object[]> = {};
		if (sessionStartHooks.length > 0) {
			hooks['SessionStart'] = sessionStartHooks;
		}
		if (userPromptSubmitHooks.length > 0) {
			hooks['UserPromptSubmit'] = userPromptSubmitHooks;
		}

		const configPath = path.join(hooksDir, 'fluency-reminders.json');
		if (Object.keys(hooks).length === 0) {
			try {
				await fs.promises.unlink(configPath);
			} catch {
				// Ignore missing file
			}
		} else {
			await fs.promises.writeFile(configPath, JSON.stringify({ hooks }, null, 2), 'utf8');
		}
	}
}
