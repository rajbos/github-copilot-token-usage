import * as path from 'path';

/**
 * EditorTypeDetector provides utilities for detecting editor types
 * from file paths and directory names
 */
export class EditorTypeDetector {
	/**
	 * Determine the editor type from a session file path
	 * Returns: 'VS Code', 'VS Code Insiders', 'VSCodium', 'Cursor', 'Copilot CLI', or 'Unknown'
	 */
	public static getEditorTypeFromPath(filePath: string): string {
		const normalizedPath = filePath.toLowerCase().replace(/\\/g, '/');
		
		if (normalizedPath.includes('/.copilot/session-state/')) {
			return 'Copilot CLI';
		}
		if (normalizedPath.includes('/code - insiders/') || normalizedPath.includes('/code%20-%20insiders/')) {
			return 'VS Code Insiders';
		}
		if (normalizedPath.includes('/code - exploration/') || normalizedPath.includes('/code%20-%20exploration/')) {
			return 'VS Code Exploration';
		}
		if (normalizedPath.includes('/vscodium/')) {
			return 'VSCodium';
		}
		if (normalizedPath.includes('/cursor/')) {
			return 'Cursor';
		}
		if (normalizedPath.includes('.vscode-server-insiders/')) {
			return 'VS Code Server (Insiders)';
		}
		if (normalizedPath.includes('.vscode-server/') || normalizedPath.includes('.vscode-remote/')) {
			return 'VS Code Server';
		}
		if (normalizedPath.includes('/code/')) {
			return 'VS Code';
		}
		
		return 'Unknown';
	}

	/**
	 * Determine a friendly editor name from an editor root path (folder name)
	 * e.g. 'C:\...\AppData\Roaming\Code' -> 'VS Code'
	 */
	public static getEditorNameFromRoot(rootPath: string): string {
		if (!rootPath) { return 'Unknown'; }
		const lower = rootPath.toLowerCase();
		// Check obvious markers first
		if (lower.includes('.copilot') || lower.includes('copilot')) { return 'Copilot CLI'; }
		if (lower.includes('code - insiders') || lower.includes('code-insiders') || lower.includes('insiders')) { return 'VS Code Insiders'; }
		if (lower.includes('code - exploration') || lower.includes('code%20-%20exploration')) { return 'VS Code Exploration'; }
		if (lower.includes('vscodium')) { return 'VSCodium'; }
		if (lower.includes('cursor')) { return 'Cursor'; }
		// Generic 'code' match (catch AppData\Roaming\Code)
		if (lower.endsWith('code') || lower.includes(path.sep + 'code' + path.sep) || lower.includes('/code/')) { return 'VS Code'; }
		return 'Unknown';
	}
}
