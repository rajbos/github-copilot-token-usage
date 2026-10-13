import * as vscode from 'vscode';
import { DEFAULT_TOOL_FAMILIES, mergeToolFamilies, type ToolFamily } from '../../src/toolFamilies';

// The family definitions and merge logic are editor-neutral and live in src/toolFamilies.ts
// (shared with the desktop app); only the settings lookup below needs the VS Code API.
export { DEFAULT_TOOL_FAMILIES, mergeToolFamilies, type ToolFamily };

/** Read and merge tool families from VS Code settings. Falls back to defaults on error. */
export function getToolFamilies(): ToolFamily[] {
	try {
		const raw = vscode.workspace.getConfiguration('aiEngineeringFluency').get<ToolFamily[]>('toolFamilies', []);
		return mergeToolFamilies(Array.isArray(raw) ? raw : []);
	} catch {
		return [...DEFAULT_TOOL_FAMILIES];
	}
}
