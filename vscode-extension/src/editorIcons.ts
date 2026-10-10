/**
 * Single source of truth for editor display-name → emoji icon mappings.
 *
 * Imported by both the extension host (extension.ts) and the webview bundles
 * (webview/shared/formatUtils.ts, webview/diagnostics/main.ts) so there is
 * exactly one place to add or change an icon.
 */

export const EDITOR_ICON_MAP: Record<string, string> = {
	'Antigravity': '🚀',
	'Claude Code': '🟠',
	'Claude Code CLI': '🟠',
	'Claude Desktop': '🟠',
	'Claude Desktop Cowork': '🟠',
	'Cline': '🤖',
	'Codex CLI': '🌀',
	'Continue': '▶️',
	'Copilot CLI': '🤖',
	'Copilot CLI (App)': '🤖',
	'Crush': '🦾',
	'Cursor': '🖱️',
	'Devin': '🧠',
	'Devin CLI': '🧠',
	'Eclipse': '🌑',
	'Gemini CLI': '💎',
	'Hermes': '🪽',
	'JetBrains': '🧩',
	'Kilo Code': '🟣',
	'Kiro': '👻',
	'Kiro CLI': '👻',
	'Mistral Vibe': '🔥',
	'MS Scout (Copilot CLI)': '🔭',
	'OpenCode': '🟢',
	'Pi': 'π',
	'SSMS': '🗄️',
	'Unknown': '❓',
	'Visual Studio': '🪟',
	'VS Code': '💙',
	'VS Code Exploration': '🧪',
	'VS Code Insiders': '💚',
	'VS Code Server': '☁️',
	'VS Code Server (Insiders)': '☁️',
	'VSCodium': '🔷',
	'Windsurf': '🏄',
};

/** Returns the emoji icon for a known editor display name. Falls back to '📝'. */
export function getEditorIconByName(editor: string): string {
	return EDITOR_ICON_MAP[editor] ?? '📝';
}
