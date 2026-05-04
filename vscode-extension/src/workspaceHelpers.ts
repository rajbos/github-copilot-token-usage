/**
 * Workspace resolution and utility helper functions.
 * Pure functions extracted from CopilotTokenTracker.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { CustomizationFileEntry } from './types';
import * as packageJson from '../package.json';
import customizationPatternsData from './customizationPatterns.json';


/**
 * Resolve the workspace folder full path from a session file path.
 * Looks for a `workspaceStorage/<id>/` segment and reads `workspace.json` or `meta.json`.
 * Synchronous by design to keep the analysis flow simple and cached.
 */
// Helper: read a workspaceStorage JSON file and extract a candidate folder path from configured keys
export function parseWorkspaceStorageJsonFile(jsonPath: string, candidateKeys: string[]): string | undefined {
	try {
		const raw = fs.readFileSync(jsonPath, 'utf8');
		const obj = JSON.parse(raw);
		for (const key of candidateKeys) {
			const candidate = obj[key];
			if (typeof candidate !== 'string') { continue; }
			const pathCandidate = candidate.replace(/^file:\/\//, '');
			// Prefer vscode.Uri.parse -> fsPath when possible
			try {
				const uri = vscode.Uri.parse(candidate);
				if (uri.fsPath && uri.fsPath.length > 0) {
					return uri.fsPath;
				}
			} catch { }
			try {
				return decodeURIComponent(pathCandidate);
			} catch {
				return pathCandidate;
			}
		}
	} catch {
		// ignore parse/read errors
	}
	return undefined;
}

/**
 * Extract workspace ID from a session file path, if it's workspace-scoped.
 * Returns the workspace ID or undefined if not a workspace-scoped session.
 */
export function extractWorkspaceIdFromSessionPath(sessionFilePath: string): string | undefined {
	try {
		const normalized = sessionFilePath.replace(/\\/g, '/');
		const parts = normalized.split('/').filter(p => p.length > 0);
		const idx = parts.findIndex(p => p.toLowerCase() === 'workspacestorage');
		if (idx === -1 || idx + 1 >= parts.length) {
			return undefined; // Not a workspace-scoped session file
		}
		return parts[idx + 1];
	} catch {
		return undefined;
	}
}

/**
 * Convert a simple glob pattern to a RegExp.
 * Supports: ** (match multiple path segments), * (match within a segment), ?.
 */
export function globToRegExp(glob: string, caseInsensitive: boolean = false): RegExp {
	// Normalize to posix-style
	let pattern = glob.replace(/\\/g, '/');
	// Escape regex special chars
	pattern = pattern.replace(/([.+^=!:${}()|[\]\\])/g, '\\$1');
	// Replace /**/ or ** with placeholder
	pattern = pattern.replace(/(^|\/)\*\*\/(?!$)/g, '$1__GLOBSTAR__/');
	pattern = pattern.replace(/\*\*/g, '__GLOBSTAR__');
	// Replace single * with [^/]* and ? with .
	pattern = pattern.replace(/\*/g, '[^/]*').replace(/\?/g, '.');
	// Replace globstar placeholder with .* (allow path separators)
	pattern = pattern.replace(/__GLOBSTAR__\//g, '(?:.*?/?)').replace(/__GLOBSTAR__/g, '.*');
	// Anchor
	const flags = caseInsensitive ? 'i' : '';
	return new RegExp('^' + pattern + '$', flags);
}

/**
 * Resolve an exact relative path in a workspace.
 * When `caseInsensitive` is true, path segments are matched case-insensitively.
 */
export function resolveExactWorkspacePath(workspaceFolderPath: string, relativePattern: string, caseInsensitive: boolean): string | undefined {
	const directPath = path.join(workspaceFolderPath, relativePattern);
	if (!caseInsensitive) {
		return fs.existsSync(directPath) ? directPath : undefined;
	}

	if (fs.existsSync(directPath)) {
		return directPath;
	}

	const normalized = relativePattern.replace(/\\/g, '/');
	const segments = normalized.split('/').filter(seg => seg.length > 0 && seg !== '.');

	let current = workspaceFolderPath;
	for (let index = 0; index < segments.length; index++) {
		const segment = segments[index];
		const isLast = index === segments.length - 1;

		if (!fs.existsSync(current)) {
			return undefined;
		}

		let entries: fs.Dirent[] = [];
		try {
			entries = fs.readdirSync(current, { withFileTypes: true });
		} catch {
			return undefined;
		}

		const matchedEntry = entries.find(entry => entry.name.toLowerCase() === segment.toLowerCase());
		if (!matchedEntry) {
			return undefined;
		}

		const matchedPath = path.join(current, matchedEntry.name);
		if (!isLast) {
			let stat: fs.Stats;
			try {
				stat = fs.statSync(matchedPath);
			} catch {
				return undefined;
			}
			if (!stat.isDirectory()) {
				return undefined;
			}
		}

		current = matchedPath;
	}

	return fs.existsSync(current) ? current : undefined;
}

/**
 * Scan a workspace folder for customization files according to `customizationPatterns.json`.
 */
export function scanWorkspaceCustomizationFiles(workspaceFolderPath: string): CustomizationFileEntry[] {
	const results: CustomizationFileEntry[] = [];
	if (!workspaceFolderPath || !fs.existsSync(workspaceFolderPath)) { return results; }

	const cfg = customizationPatternsData as any;
	const stalenessDays = typeof cfg.stalenessThresholdDays === 'number' ? cfg.stalenessThresholdDays : 90;
	const excludeDirs: string[] = Array.isArray(cfg.excludeDirs) ? cfg.excludeDirs : [];

	for (const pattern of (cfg.patterns || [])) {
		try {
			const scanMode = pattern.scanMode || 'exact';
			const relativePattern = pattern.path as string;
			if (scanMode === 'exact') {
				const caseInsensitive = !!pattern.caseInsensitive;
				const absPath = resolveExactWorkspacePath(workspaceFolderPath, relativePattern, caseInsensitive);
				if (absPath) {
					const stat = fs.statSync(absPath);
					results.push({
						path: absPath,
						relativePath: path.relative(workspaceFolderPath, absPath).replace(/\\/g, '/'),
						type: pattern.type || 'unknown',
						icon: pattern.icon || '',
						label: pattern.label || path.basename(absPath),
						name: path.basename(absPath),
						lastModified: stat.mtime.toISOString(),
						isStale: (Date.now() - stat.mtime.getTime()) > stalenessDays * 24 * 60 * 60 * 1000,
						category: pattern.category as 'copilot' | 'non-copilot' | undefined
					});
				}
			} else if (scanMode === 'oneLevel') {
				// Split at the first '*' wildcard to find base directory and remaining path
				// e.g., ".github/skills/*/SKILL.md" -> base: ".github/skills/", remaining: "/SKILL.md"
				const normalizedPattern = relativePattern.replace(/\\/g, '/');
				const starIndex = normalizedPattern.indexOf('*');
				if (starIndex === -1) { continue; } // No wildcard, skip

				// Split the pattern at the '*'
				const beforeStar = normalizedPattern.substring(0, starIndex);
				const afterStar = normalizedPattern.substring(starIndex + 1);

				// The base directory is everything before the '*' (trim trailing slash)
				const baseDirPath = beforeStar.replace(/\/$/, '');
				const baseDir = baseDirPath ? path.join(workspaceFolderPath, baseDirPath) : workspaceFolderPath;

				if (!fs.existsSync(baseDir)) { continue; }
				const baseStat = fs.statSync(baseDir);
				if (!baseStat.isDirectory()) { continue; }

				// Enumerate directories in the base directory
				const entries = fs.readdirSync(baseDir, { withFileTypes: true });
				const fullPattern = afterStar.startsWith('/') ? afterStar.substring(1) : afterStar;
				for (const entry of entries) {
					// Only consider directories at this level (unless afterStar is just a filename)
					if (excludeDirs.includes(entry.name)) { continue; }

					// Construct the full path with this entry replacing the '*'
					const candidatePath = path.join(baseDir, entry.name, fullPattern);

					// Check if this path exists
					if (fs.existsSync(candidatePath)) {
						const stat = fs.statSync(candidatePath);
						if (stat.isFile()) {
							// For skills, use the directory name (parent of SKILL.md) as the display name
							const displayName = pattern.type === 'skill' ? entry.name : path.basename(candidatePath);

							results.push({
								path: candidatePath,
								relativePath: path.relative(workspaceFolderPath, candidatePath).replace(/\\/g, '/'),
								type: pattern.type || 'unknown',
								icon: pattern.icon || '',
								label: pattern.label || displayName,
								name: displayName,
								lastModified: stat.mtime.toISOString(),
								category: pattern.category as 'copilot' | 'non-copilot' | undefined,
								isStale: (Date.now() - stat.mtime.getTime()) > stalenessDays * 24 * 60 * 60 * 1000
							});
						}
					}
				}
			} else if (scanMode === 'recursive') {
				const maxDepth = typeof pattern.maxDepth === 'number' ? pattern.maxDepth : 6;
				const caseInsensitive = !!pattern.caseInsensitive;
				const regex = globToRegExp(relativePattern, caseInsensitive);
				// Walk recursively
				const walk = (dir: string, depth: number) => {
					if (depth < 0) { return; }
					let children: fs.Dirent[] = [];
					try { children = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
					for (const child of children) {
						const name = child.name;
						if (child.isDirectory()) {
							if (excludeDirs.includes(name)) { continue; }
							walk(path.join(dir, name), depth - 1);
						} else if (child.isFile()) {
							const rel = path.relative(workspaceFolderPath, path.join(dir, name)).replace(/\\/g, '/');
							if (regex.test(rel)) {
								const abs = path.join(dir, name);
								const stat = fs.statSync(abs);
								results.push({
									path: abs,
									relativePath: rel,
									type: pattern.type || 'unknown',
									icon: pattern.icon || '',
									label: pattern.label || path.basename(abs),
									name: path.basename(abs),
									lastModified: stat.mtime.toISOString(),
									isStale: (Date.now() - stat.mtime.getTime()) > stalenessDays * 24 * 60 * 60 * 1000,
									category: pattern.category as 'copilot' | 'non-copilot' | undefined
								});
							}
						}
					}
				};
				walk(workspaceFolderPath, maxDepth);
			}
		} catch (e) {
			// ignore per-pattern errors
		}
	}

	// Deduplicate by absolute path
	const uniq: { [p: string]: CustomizationFileEntry } = {};
	for (const r of results) { uniq[path.normalize(r.path)] = r; }
	return Object.values(uniq);
}

// Helper method to get repository URL from package.json
export function getRepositoryUrl(): string {
	const repoUrl = packageJson.repository?.url?.replace(/^git\+/, '').replace(/\.git$/, '');
	return repoUrl || 'https://github.com/rajbos/ai-engineering-fluency';
}

/**
 * Determine the editor type from a session file path
 * Returns: 'VS Code', 'VS Code Insiders', 'VSCodium', 'Cursor', 'Copilot CLI', or 'Unknown'
 */
/**
 * Detect the actual mode type from inputState.mode object.
 * Returns 'ask', 'edit', 'agent', 'plan', or 'customAgent'.
 */
export function getModeType(mode: any): 'ask' | 'edit' | 'agent' | 'plan' | 'customAgent' {
	if (!mode || !mode.kind) {
		return 'ask';
	}

	// Check kind first - edit and ask are straightforward
	if (mode.kind === 'edit') { return 'edit'; }
	if (mode.kind === 'ask') { return 'ask'; }

	// For agent kind, check the mode.id to differentiate
	if (mode.kind === 'agent') {
		if (!mode.id || mode.id === 'agent') {
			// Standard agent mode (no special id or id='agent')
			return 'agent';
		}

		// Check for plan mode (vscode-userdata:/.../plan-agent/Plan.agent.md)
		if (typeof mode.id === 'string' && mode.id.includes('plan-agent/Plan.agent.md')) {
			return 'plan';
		}

		// Check for custom agent (file:// URI to .agent.md)
		if (typeof mode.id === 'string' && mode.id.includes('.agent.md')) {
			return 'customAgent';
		}

		// Fallback to standard agent for any other agent kind
		return 'agent';
	}

	// Default to ask for unknown modes
	return 'ask';
}

/**
 * Extract custom agent name from a file:// URI pointing to a .agent.md file.
 * Returns the filename without the .agent.md extension.
 */
export function extractCustomAgentName(modeId: string): string | null {
	if (!modeId || !modeId.includes('.agent.md')) {
		return null;
	}

	try {
		// Handle both file:/// URIs and regular paths
		const cleanPath = modeId.replace('file:///', '').replace('file://', '');
		const decodedPath = decodeURIComponent(cleanPath);
		const parts = decodedPath.split(/[\\/]/);
		const filename = parts[parts.length - 1];

		// Remove .agent.md extension
		if (filename.endsWith('.agent.md')) {
			return filename.slice(0, -9); // Remove '.agent.md' (9 chars)
		}
		if (filename.endsWith('.md.agent.md')) {
			// Handle case like TestEngineerAgent.md.agent.md
			return filename.slice(0, -10).replace('.md', '');
		}
	} catch (e) {
		return null;
	}

	return null;
}

/**
 * Determine a friendly editor name from an editor root path (folder name)
 * e.g. 'C:\...\AppData\Roaming\Code' -> 'VS Code'
 */
export function getEditorNameFromRoot(rootPath: string): string {
	if (!rootPath) { return 'Unknown'; }
	const lower = rootPath.toLowerCase();
	// Check obvious markers first
	if (lower.includes('.copilot/jb') || lower.includes('.copilot\\jb')) { return 'JetBrains'; }
	if (lower.includes('.copilot') || lower.includes('copilot')) { return 'Copilot CLI'; }
	if (lower.includes('opencode')) { return 'OpenCode'; }
	if (lower.includes('.continue')) { return 'Continue'; }
	if (lower.includes('.vibe')) { return 'Mistral Vibe'; }
	if (lower.includes('.gemini')) { return 'Gemini CLI'; }
	if (lower.includes('code - insiders') || lower.includes('code-insiders') || lower.includes('insiders')) { return 'VS Code Insiders'; }
	if (lower.includes('code - exploration') || lower.includes('code%20-%20exploration')) { return 'VS Code Exploration'; }
	if (lower.includes('vscodium')) { return 'VSCodium'; }
	if (lower.includes('cursor')) { return 'Cursor'; }
        if (lower.includes('.vs') && lower.includes('copilot-chat')) { return 'Visual Studio'; }
	// Generic 'code' match (catch AppData\Roaming\Code)
	if (lower.endsWith('code') || lower.includes(path.sep + 'code' + path.sep) || lower.includes('/code/')) { return 'VS Code'; }
	return 'Unknown';
}

/**
 * Extract a friendly display name from a repository URL.
 * Supports HTTPS, SSH, and git:// URLs.
 * @param repoUrl The full repository URL
 * @returns A shortened display name like "owner/repo"
 */
export function getRepoDisplayName(repoUrl: string): string {
	if (!repoUrl || repoUrl === 'Unknown') { return 'Unknown'; }

	// Remove .git suffix if present
	let url = repoUrl.replace(/\.git$/, '');

	// Handle SSH URLs like git@github.com:owner/repo
	if (url.includes('@') && url.includes(':')) {
		const colonIndex = url.lastIndexOf(':');
		const atIndex = url.lastIndexOf('@');
		if (colonIndex > atIndex) {
			return url.substring(colonIndex + 1);
		}
	}

	// Handle HTTPS/git URLs - extract path after the host
	try {
		if (url.includes('://')) {
			const urlObj = new URL(url);
			const pathParts = urlObj.pathname.split('/').filter(p => p);
			if (pathParts.length >= 2) {
				return `${pathParts[pathParts.length - 2]}/${pathParts[pathParts.length - 1]}`;
			}
			return urlObj.pathname.replace(/^\//, '');
		}
	} catch {
		// URL parsing failed, continue to fallback
	}

	// Fallback: return the last part of the path
	const parts = url.split('/').filter(p => p);
	if (parts.length >= 2) {
		return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
	}
	return url;
}

/**
 * Parse the remote origin URL from a .git/config file content.
 * Looks for [remote "origin"] section and extracts the url value.
 * @param gitConfigContent The content of a .git/config file
 * @returns The remote origin URL if found, undefined otherwise
 */
export function parseGitRemoteUrl(gitConfigContent: string): string | undefined {
	// Look for [remote "origin"] section and extract url
	const lines = gitConfigContent.split('\n');
	let inOriginSection = false;

	for (const line of lines) {
		const trimmed = line.trim();

		// Check if we're entering the [remote "origin"] section
		if (trimmed.match(/^\[remote\s+"origin"\]$/i)) {
			inOriginSection = true;
			continue;
		}

		// Check if we're leaving the section (new section starts)
		if (inOriginSection && trimmed.startsWith('[')) {
			inOriginSection = false;
			continue;
		}

		// Look for url = ... in the origin section
		if (inOriginSection) {
			const urlMatch = trimmed.match(/^url\s*=\s*(.+)$/i);
			if (urlMatch) {
				return urlMatch[1].trim();
			}
		}
	}

	return undefined;
}

/**
 * Check if a tool name indicates it's an MCP (Model Context Protocol) tool.
 * MCP tools are identified by names starting with "mcp." or "mcp_"
 * Claude Code uses double-underscore format: "mcp__server__tool"
 */
export function isMcpTool(toolName: string): boolean {
	return toolName.startsWith('mcp.') || toolName.startsWith('mcp_') || toolName.startsWith('mcp__');
}

/**
 * Normalize an MCP tool name so that equivalent tools from different servers
 * (local stdio vs remote) are counted under a single canonical key in "By Tool" views.
 * Maps mcp_github_github_<action> → mcp_io_github_git_<action>.
 */
export function normalizeMcpToolName(toolName: string): string {
	if (toolName.startsWith('mcp_github_github_')) {
		return 'mcp_io_github_git_' + toolName.substring('mcp_github_github_'.length);
	}
	if (toolName.startsWith('mcp.github.github.')) {
		return 'mcp.io.github.git.' + toolName.substring('mcp.github.github.'.length);
	}
	return toolName;
}

/**
 * Extract server name from an MCP tool name.
 * MCP tool names follow the format: mcp.server.tool or mcp_server_tool
 * Claude Code uses double-underscore format: mcp__server__tool
 * For example: "mcp.io.github.git.assign_copilot_to_issue" → "GitHub MCP"
 * Uses the display name from toolNames.json (the part before the colon).
 * Falls back to extracting the second segment if no mapping exists.
 */
export function extractMcpServerName(toolName: string, toolNameMap: { [key: string]: string } = {}): string {
	// First, try to get the display name from toolNames.json and extract the server part
	const displayName = toolNameMap[toolName] ?? toolNameMap[toolName.toLowerCase()];
	if (displayName && displayName.includes(':')) {
		// Extract the part before the colon (e.g., "GitHub MCP" from "GitHub MCP: Issue Read")
		return displayName.split(':')[0].trim();
	}

	// Fallback: recognize known MCP server prefixes for unlisted tools
	if (toolName.startsWith('mcp_io_github_git_') || toolName.startsWith('mcp.io.github.git.')) {
		return 'GitHub MCP (Local)';
	}
	if (toolName.startsWith('mcp_github_github_') || toolName.startsWith('mcp.github.github.')) {
		return 'GitHub MCP (Remote)';
	}

	// Claude Code double-underscore format: mcp__server__tool
	// e.g. "mcp__github__create_issue" → "github"
	if (toolName.startsWith('mcp__')) {
		const withoutPrefix = toolName.slice('mcp__'.length);
		const serverEnd = withoutPrefix.indexOf('__');
		const serverName = serverEnd >= 0 ? withoutPrefix.slice(0, serverEnd) : withoutPrefix;
		return serverName || 'unknown';
	}

	// Generic fallback: extract from tool name structure (mcp_ or mcp.)
	const withoutPrefix = toolName.replace(/^mcp[._]/, '');
	const parts = withoutPrefix.split(/[._]/);
	return parts[0] || 'unknown';
}

/**
 * Extract repository remote URL from file paths found in contentReferences.
 * Looks for .git/config file in the workspace root to get the origin remote URL.
 * @param contentReferences Array of content reference objects from session data
 * @returns The repository remote URL if found, undefined otherwise
 */
export async function extractRepositoryFromContentReferences(contentReferences: any[]): Promise<string | undefined> {
	if (!Array.isArray(contentReferences)) {
		return undefined;
	}

	const filePaths: string[] = [];

	// Collect all file paths from contentReferences
	for (const contentRef of contentReferences) {
		if (!contentRef || typeof contentRef !== 'object') {
			continue;
		}

		let reference = null;
		const kind = contentRef.kind;

		if (kind === 'reference' && contentRef.reference) {
			reference = contentRef.reference;
		} else if (kind === 'inlineReference' && contentRef.inlineReference) {
			reference = contentRef.inlineReference;
		}

		if (reference) {
			// Prefer fsPath (native format) over path (URI format)
			const rawPath = reference.fsPath || reference.path;
			if (typeof rawPath === 'string' && rawPath.length > 0) {
				// Convert VS Code URI path format to native path on Windows
				// URI paths look like "/c:/Users/..." but should be "c:/Users/..." on Windows
				let normalizedPath = rawPath;
				if (process.platform === 'win32' && normalizedPath.match(/^\/[a-zA-Z]:/)) {
					normalizedPath = normalizedPath.substring(1); // Remove leading slash
				}
				filePaths.push(normalizedPath);
			}
		}
	}

	if (filePaths.length === 0) {
		return undefined;
	}

	// Find the most likely workspace root by looking for common parent directories
	// Try each file path and look for a .git/config file in parent directories
	const checkedRoots = new Set<string>();

	for (const filePath of filePaths) {
		// Normalize path separators to forward slashes for consistent splitting
		const normalizedPath = filePath.replace(/\\/g, '/');
		const pathParts = normalizedPath.split('/').filter(p => p.length > 0);

		// Walk up the directory tree looking for .git/config
		for (let i = pathParts.length - 1; i >= 1; i--) {
			// Reconstruct path - on Windows, first part is drive letter (e.g., "c:")
			let potentialRoot = pathParts.slice(0, i).join('/');

			// On Windows, ensure we have a valid absolute path
			if (process.platform === 'win32' && pathParts[0].match(/^[a-zA-Z]:$/)) {
				// Path starts with drive letter, already valid
			} else if (process.platform !== 'win32' && !potentialRoot.startsWith('/')) {
				// On Unix, prepend / for absolute path
				potentialRoot = '/' + potentialRoot;
			}

			// Skip if we've already checked this root
			if (checkedRoots.has(potentialRoot)) {
				continue;
			}
			checkedRoots.add(potentialRoot);

			const gitConfigPath = path.join(potentialRoot, '.git', 'config');
			try {
				const gitConfig = await fs.promises.readFile(gitConfigPath, 'utf8');
				const remoteUrl = parseGitRemoteUrl(gitConfig);
				if (remoteUrl) {
					return remoteUrl;
				}
			} catch {
				// No .git/config at this level, continue up the tree
			}

			// Also check if .git is a file (git worktree) — contains "gitdir: <path>"
			const gitFilePath = path.join(potentialRoot, '.git');
			try {
				const gitFileContent = await fs.promises.readFile(gitFilePath, 'utf8');
				const match = gitFileContent.match(/^gitdir:\s*(.+)$/m);
				if (match) {
					const gitdirPath = match[1].trim();
					const basePath = potentialRoot.replace(/\//g, path.sep);
					const resolvedGitdir = path.isAbsolute(gitdirPath)
						? gitdirPath
						: path.resolve(basePath, gitdirPath);
					// Standard worktree: gitdir = <main>/.git/worktrees/<name>
					// Main .git dir is 2 levels up; its config holds the remote URL
					const mainGitDir = path.resolve(resolvedGitdir, '..', '..');
					const mainConfigPath = path.join(mainGitDir, 'config');
					const gitConfig = await fs.promises.readFile(mainConfigPath, 'utf8');
					const remoteUrl = parseGitRemoteUrl(gitConfig);
					if (remoteUrl) {
						return remoteUrl;
					}
				}
			} catch {
				// Not a worktree or can't read gitdir, continue
			}
		}
	}

	return undefined;
}

export function resolveWorkspaceFolderFromSessionPath(sessionFilePath: string, workspaceIdToFolderCache: Map<string, string | undefined>): string | undefined {
	try {
		// Normalize and split path into segments
		const normalized = sessionFilePath.replace(/\\/g, '/');
		const parts = normalized.split('/').filter(p => p.length > 0);
		const idx = parts.findIndex(p => p.toLowerCase() === 'workspacestorage');
		if (idx === -1 || idx + 1 >= parts.length) {
			return undefined; // Not a workspace-scoped session file
		}

		const workspaceId = parts[idx + 1];
		// Return cached value if present
		if (workspaceIdToFolderCache.has(workspaceId)) {
			return workspaceIdToFolderCache.get(workspaceId);
		}

		// Construct the workspaceStorage folder path by slicing the original normalized path
		// This preserves absolute-root semantics on both Windows and Unix.
		const workspaceSegment = `workspaceStorage/${workspaceId}`;
		const lowerNormalized = normalized.toLowerCase();
		const segmentIndex = lowerNormalized.indexOf(workspaceSegment.toLowerCase());
		if (segmentIndex === -1) {
			// Should not happen if parts detection succeeded, but guard just in case
			workspaceIdToFolderCache.set(workspaceId, undefined);
			return undefined;
		}
		const folderPathNormalized = normalized.substring(0, segmentIndex + workspaceSegment.length);
		const workspaceStorageFolder = path.normalize(folderPathNormalized);

		const workspaceJsonPath = path.join(workspaceStorageFolder, 'workspace.json');
		const metaJsonPath = path.join(workspaceStorageFolder, 'meta.json');

		let folderFsPath: string | undefined;

		if (fs.existsSync(workspaceJsonPath)) {
			folderFsPath = parseWorkspaceStorageJsonFile(workspaceJsonPath, ['folder', 'workspace', 'configuration', 'uri', 'path']);
		} else if (fs.existsSync(metaJsonPath)) {
			folderFsPath = parseWorkspaceStorageJsonFile(metaJsonPath, ['folder', 'uri', 'workspace', 'path']);
		}

		// Normalize to undefined if folderFsPath is falsy
		if (!folderFsPath || folderFsPath.length === 0) {
			workspaceIdToFolderCache.set(workspaceId, undefined);
			return undefined;
		}

		// Canonicalize path casing using the real filesystem path.
		// Different VS Code variants (Stable, Insiders, Cursor) may store the same folder with
		// different drive-letter or path casing in their workspace.json (e.g. "C:\Users\" vs "c:\users\").
		// realpathSync.native returns the true OS-level casing, so the same physical folder always
		// produces the same Map key and is deduplicated correctly.
		try {
			folderFsPath = fs.realpathSync.native(folderFsPath);
		} catch {
			// Path may not exist on disk (deleted/moved repo); keep the parsed path as-is.
		}

		workspaceIdToFolderCache.set(workspaceId, folderFsPath);
		return folderFsPath;
	} catch (err) {
		// On any error, cache undefined to avoid repeated failures
		try {
			const parts = sessionFilePath.replace(/\\/g, '/').split('/').filter(p => p.length > 0);
			const idx = parts.findIndex(p => p.toLowerCase() === 'workspacestorage');
			if (idx !== -1 && idx + 1 < parts.length) {
				workspaceIdToFolderCache.set(parts[idx + 1], undefined);
			}
		} catch { }
		return undefined;
	}
}

export function getEditorTypeFromPath(filePath: string, isOpenCodeSessionFile?: (p: string) => boolean): string {
	const normalizedPath = filePath.toLowerCase().replace(/\\/g, '/');

	// Check JetBrains before Copilot CLI: both live under ~/.copilot/ but jb/
	// is a sibling of session-state/ and must be attributed to the JetBrains IDE.
	if (normalizedPath.includes('/.copilot/jb/')) {
		return 'JetBrains';
	}
	if (normalizedPath.includes('/.copilot/session-state/')) {
		return 'Copilot CLI';
	}
	if (isOpenCodeSessionFile?.(filePath)) {
		return 'OpenCode';
	}
	if (normalizedPath.includes('/.crush/crush.db#')) {
		return 'Crush';
	}
	if (normalizedPath.includes('/.continue/sessions/')) {
		return 'Continue';
	}
	if (normalizedPath.includes('/local-agent-mode-sessions/')) {
		return 'Claude Desktop Cowork';
	}
	if (normalizedPath.includes('/.claude/projects/')) {
		return 'Claude Code';
	}
	if (normalizedPath.includes('/.vibe/logs/session/')) {
		return 'Mistral Vibe';
	}
	if (normalizedPath.includes('/.gemini/tmp/') && normalizedPath.includes('/chats/session-') && normalizedPath.endsWith('.jsonl')) {
		return 'Gemini CLI';
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
        if (normalizedPath.includes('/.vs/') && normalizedPath.includes('/copilot-chat/') && normalizedPath.includes('/sessions/')) {
                return 'Visual Studio';
        }
	if (normalizedPath.includes('/code/')) {
		return 'VS Code';
	}

	return 'Unknown';
}

/**
 * Detect which editor the session file belongs to based on its path.
 */
export function detectEditorSource(filePath: string, isOpenCodeSessionFile?: (p: string) => boolean): string {
	const lowerPath = filePath.toLowerCase().replace(/\\/g, '/');
	if (lowerPath.includes('/.copilot/jb/')) { return 'JetBrains'; }
	if (lowerPath.includes('/.copilot/session-state/')) { return 'Copilot CLI'; }
	if (isOpenCodeSessionFile?.(filePath)) { return 'OpenCode'; }
	if (lowerPath.includes('/.crush/crush.db#')) { return 'Crush'; }
	if (lowerPath.includes('/.continue/sessions/')) { return 'Continue'; }
	if (lowerPath.includes('/local-agent-mode-sessions/')) { return 'Claude Desktop Cowork'; }
	if (lowerPath.includes('/.claude/projects/')) { return 'Claude Code'; }
	if (lowerPath.includes('/.vibe/logs/session/')) { return 'Mistral Vibe'; }
	if (lowerPath.includes('/.gemini/tmp/') && lowerPath.includes('/chats/session-') && lowerPath.endsWith('.jsonl')) { return 'Gemini CLI'; }
	if (lowerPath.includes('cursor')) { return 'Cursor'; }
	if (lowerPath.includes('code - insiders') || lowerPath.includes('code-insiders')) { return 'VS Code Insiders'; }
	if (lowerPath.includes('vscodium')) { return 'VSCodium'; }
	if (lowerPath.includes('windsurf')) { return 'Windsurf'; }
        if (lowerPath.includes('/.vs/') && lowerPath.includes('/copilot-chat/') && lowerPath.includes('/sessions/')) { return 'Visual Studio'; }
	if (lowerPath.includes('code')) { return 'VS Code'; }
	return 'Unknown';
}
