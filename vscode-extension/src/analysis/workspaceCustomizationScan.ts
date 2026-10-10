/**
 * Customization-file discovery for one workspace, free of any `vscode` dependency.
 *
 * Finding a workspace's Copilot customization files (instructions, prompts, agents, skills,
 * MCP config, ...) means a recursive directory walk. It is implemented with synchronous fs
 * calls, and on a real machine with a few hundred workspaces (some with deep trees) a single
 * refresh spent over a minute inside it — all of it on the extension host's one thread, so
 * every webview click queued behind it. It therefore lives here, where the analysis worker can
 * run it, with the host falling back to calling it in-process only when no worker is available.
 */
import * as path from 'path';

import type { CustomizationFileEntry } from '../../../src/types';
import { parseCodeWorkspaceFolders, scanWorkspaceCustomizationFiles } from '../../../src/workspaceHelpers';

/** Scans every folder of a `.code-workspace` and merges the results, de-duplicated by absolute path. */
function mergeCodeWorkspaceCustomizationFiles(codeWorkspacePath: string): CustomizationFileEntry[] {
	const allFiles: CustomizationFileEntry[] = [];
	const seen = new Set<string>();
	for (const folder of parseCodeWorkspaceFolders(codeWorkspacePath)) {
		try {
			for (const file of scanWorkspaceCustomizationFiles(folder)) {
				const key = path.normalize(file.path);
				if (!seen.has(key)) { seen.add(key); allFiles.push(file); }
			}
		} catch { /* skip per-folder scan errors */ }
	}
	return allFiles;
}

/**
 * The customization files for a (normalized) workspace path. A `.code-workspace` file is scanned
 * through its member folders; if that yields nothing the path itself is scanned, as before.
 * Synchronous and potentially slow — call it from a worker, not from the extension host.
 */
export function scanCustomizationFilesForWorkspace(workspacePath: string): CustomizationFileEntry[] {
	if (workspacePath.endsWith('.code-workspace')) {
		const merged = mergeCodeWorkspaceCustomizationFiles(workspacePath);
		if (merged.length > 0) { return merged; }
	}
	return scanWorkspaceCustomizationFiles(workspacePath);
}
