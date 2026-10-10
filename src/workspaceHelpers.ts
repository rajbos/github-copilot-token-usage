/**
 * Workspace resolution and utility helper functions.
 * Pure functions extracted from CopilotTokenTracker.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { CustomizationFileEntry } from './types';
import customizationPatternsData from './customizationPatterns.json';
import { parseWorkspaceStorageJsonFile, resolveFileUri } from './workspacePathResolver';

// Re-exported for backward compatibility: this helper now lives in workspacePathResolver.ts
// (a VS Code-free module) so that src/copilotMemoryFiles.ts — a shared Node module consumed
// by both the CLI and the extension — can use it without pulling in the `vscode` API.
export { parseWorkspaceStorageJsonFile };
import {
	fileUriToPath,
	getRepoNameFromWorkspacePath,
	hasWindowsDriveSegment,
	normalizePath,
	normalizePathForComparison,
	normalizePathForDedup,
	joinedChildPrefixForComparison,
	splitNormalizedPath,
	stripWindowsDriveUriPrefix,
	toPlatformPath
} from './utils/pathUtils';
import { withErrorRecoverySync } from './utils/errors';
import { isGuidMcpTool, lookupKnownToolName } from './utils/toolUtils';
import { isCopilotAppClientName } from './copilotCliStore';

export {
	dedupeByNormalizedKeyKeepGreatest,
	fileUriToPath,
	normalizePath,
	normalizePathForComparison,
	normalizePathForDedup,
	normalizePathSeparators,
	normalizeToRepoRoot,
	getRepoNameFromWorkspacePath
} from './utils/pathUtils';


// ── Local type definitions ────────────────────────────────────────────────

/** Represents a VS Code Copilot interaction mode object read from session data. */
interface ModeObject {
	kind?: string;
	id?: string;
}

/** A single file/path reference inside a chat content-reference item. */
interface ContentReferenceData {
	fsPath?: string;
	path?: string;
}

/**
 * A content-reference item as stored in Copilot session data.
 * The `kind` field determines which nested reference key is present.
 */
interface ContentReferenceItem {
	kind?: string;
	reference?: ContentReferenceData;
	inlineReference?: ContentReferenceData;
}

/** A single pattern entry in customizationPatterns.json. */
interface CustomizationPattern {
	id?: string;
	type?: string;
	category?: 'copilot' | 'non-copilot';
	icon?: string;
	label?: string;
	path: string;
	scanMode?: string;
	caseInsensitive?: boolean;
	maxDepth?: number;
}

/** Top-level structure of customizationPatterns.json. */
interface CustomizationPatternsConfig {
	stalenessThresholdDays?: number;
	excludeDirs?: string[];
	patterns?: CustomizationPattern[];
}

/**
 * Extract workspace ID from a session file path, if it's workspace-scoped.
 * Returns the workspace ID or undefined if not a workspace-scoped session.
 */
export function extractWorkspaceIdFromSessionPath(sessionFilePath: string): string | undefined {
	try {
		const parts = splitNormalizedPath(sessionFilePath);
		const idx = parts.findIndex(p => p.toLowerCase() === 'workspacestorage');
		if (idx === -1 || idx + 1 >= parts.length) {
			return undefined; // Not a workspace-scoped session file
		}
		return parts[idx + 1];
	} catch {
		return undefined;
	}
}

const DEBUG_LOG_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Extension-folder spellings Copilot Chat's debug-logs directory has shipped under. */
const DEBUG_LOG_EXTENSION_FOLDERS = ['GitHub.copilot-chat', 'github.copilot-chat', 'GitHub.copilot', 'github.copilot'];

/**
 * Returns the ordered list of candidate `main.jsonl` debug-log paths for a VS Code Copilot
 * Chat session file — callers try each in order and use the first one that exists. Returns
 * undefined for any session file that isn't UUID-named inside a `workspaceStorage/<hash>`
 * folder, the only shape that has a debug log (see
 * docs/logFilesSchema/vscode-chat-debug-log-format.md).
 *
 * Single source of truth for this path shape: shared by readTokensFromDebugLog() (one
 * session) and the TTFT bulk scan (many sessions) in extension.ts.
 */
export function resolveDebugLogCandidatePaths(sessionFilePath: string): string[] | undefined {
	const norm = normalizePath(sessionFilePath);
	const sessionId = path.basename(sessionFilePath, path.extname(sessionFilePath));
	if (!DEBUG_LOG_SESSION_ID_RE.test(sessionId)) { return undefined; }
	const wsHashMatch = norm.match(/^(.*\/workspaceStorage\/[^/]+)\//);
	if (!wsHashMatch) { return undefined; }
	const workspaceHashDir = sessionFilePath.substring(0, wsHashMatch[1].length);
	return DEBUG_LOG_EXTENSION_FOLDERS.map(extFolder => path.join(workspaceHashDir, extFolder, 'debug-logs', sessionId, 'main.jsonl'));
}

/** Escape all regex special characters in a literal string fragment. */
export function escapeRegexSpecials(pattern: string): string {
	return pattern.replace(/([.+^=!:${}()|[\]\\])/g, '\\$1');
}

/**
 * Replace globstar tokens with a placeholder so they survive the single-star
 * replacement step.  Two cases:
 *   - double-star between slashes (or at start) in the middle of a path -> optional sub-tree
 *   - standalone or trailing double-star                                 -> any depth remainder
 */
export function replaceGlobstars(pattern: string): string {
	let result = pattern.replace(/(^|\/)\*\*\/(?!$)/g, '$1__GLOBSTAR__/');
	result = result.replace(/\*\*/g, '__GLOBSTAR__');
	return result;
}

/** Replace single `*` with a segment-local wildcard `[^/]*`. */
export function replaceWildcards(pattern: string): string {
	return pattern.replace(/\*/g, '[^/]*');
}

/** Replace `?` with a single-character matcher `.`. */
export function replaceQuestionMarks(pattern: string): string {
	return pattern.replace(/\?/g, '.');
}

/** Expand the globstar placeholder back to its proper regex fragments. */
function expandGlobstarPlaceholder(pattern: string): string {
	let result = pattern.replace(/__GLOBSTAR__\//g, '(?:.*?/?)');
	result = result.replace(/__GLOBSTAR__/g, '.*');
	return result;
}

/**
 * Convert a simple glob pattern to a RegExp.
 * Supports: ** (match multiple path segments), * (match within a segment), ?.
 */
export function globToRegExp(glob: string, caseInsensitive: boolean = false): RegExp {
	const pattern = [
		normalizePath(glob),
	]
		.map(escapeRegexSpecials)
		.map(replaceGlobstars)
		.map(replaceWildcards)
		.map(replaceQuestionMarks)
		.map(expandGlobstarPlaceholder)[0];

	const flags = caseInsensitive ? 'i' : '';
	return new RegExp('^' + pattern + '$', flags);
}

/**
 * Resolve an exact relative path in a workspace.
 * When `caseInsensitive` is true, path segments are matched case-insensitively.
 */

/**
 * Try to resolve one path segment `segment` inside directory `current`.
 * When `isLast` is false, the resolved entry must be a directory.
 * Returns the resolved absolute path, or undefined if not found / wrong type.
 * @internal
 */
function resolvePathSegment(current: string, segment: string, isLast: boolean): string | undefined {
	if (!fs.existsSync(current)) { return undefined; }
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(current, { withFileTypes: true });
	} catch {
		return undefined;
	}
	const matchedEntry = entries.find(e => e.name.toLowerCase() === segment.toLowerCase());
	if (!matchedEntry) { return undefined; }
	const matchedPath = path.join(current, matchedEntry.name);
	if (isLast) { return matchedPath; }
	try {
		if (!fs.statSync(matchedPath).isDirectory()) { return undefined; }
	} catch {
		return undefined;
	}
	return matchedPath;
}

export function resolveExactWorkspacePath(workspaceFolderPath: string, relativePattern: string, caseInsensitive: boolean): string | undefined {
	const directPath = path.join(workspaceFolderPath, relativePattern);
	if (!caseInsensitive) {
		return fs.existsSync(directPath) ? directPath : undefined;
	}
	if (fs.existsSync(directPath)) { return directPath; }

	const segments = splitNormalizedPath(relativePattern).filter(seg => seg !== '.');
	let current = workspaceFolderPath;
	for (let index = 0; index < segments.length; index++) {
		const resolved = resolvePathSegment(current, segments[index], index === segments.length - 1);
		if (!resolved) { return undefined; }
		current = resolved;
	}
	return fs.existsSync(current) ? current : undefined;
}

// ── scanWorkspaceCustomizationFiles helpers ──────────────────────────────────────────

/** Shared context for building a CustomizationFileEntry from a matched path. */
interface PatternScanContext {
	workspaceFolderPath: string;
	pattern: CustomizationPattern;
	stalenessDays: number;
}

/** Build a CustomizationFileEntry for a matched absolute path. */
function buildCustomizationEntry(
	ctx: PatternScanContext,
	absPath: string,
	displayName?: string
): CustomizationFileEntry {
	const { workspaceFolderPath, pattern, stalenessDays } = ctx;
	const stat = fs.statSync(absPath);
	const name = displayName ?? path.basename(absPath);
	return {
		path: absPath,
		relativePath: normalizePath(path.relative(workspaceFolderPath, absPath)),
		type: pattern.type ?? 'unknown',
		icon: pattern.icon ?? '',
		label: pattern.label ?? name,
		name,
		lastModified: stat.mtime.toISOString(),
		isStale: (Date.now() - stat.mtime.getTime()) > stalenessDays * 24 * 60 * 60 * 1000,
		category: pattern.category
	};
}

/** Handle `scanMode: "exact"` — look for a single file at the given path. */
function scanExactPattern(ctx: PatternScanContext): CustomizationFileEntry | undefined {
	const { workspaceFolderPath, pattern, stalenessDays } = ctx;
	const absPath = resolveExactWorkspacePath(workspaceFolderPath, pattern.path, !!pattern.caseInsensitive);
	if (!absPath) { return undefined; }
	return buildCustomizationEntry({ workspaceFolderPath, pattern, stalenessDays }, absPath);
}

/** Handle `scanMode: "oneLevel"` — enumerate one directory level for wildcard matches. */
function scanOneLevelPattern(ctx: PatternScanContext, excludeDirs: string[]): CustomizationFileEntry[] {
	const { workspaceFolderPath, pattern, stalenessDays } = ctx;
	const normalizedPattern = normalizePath(pattern.path);
	const starIndex = normalizedPattern.indexOf('*');
	if (starIndex === -1) { return []; }

	const beforeStar = normalizedPattern.substring(0, starIndex);
	const afterStar = normalizedPattern.substring(starIndex + 1);
	const baseDirPath = beforeStar.replace(/\/$/, '');
	const baseDir = baseDirPath ? path.join(workspaceFolderPath, baseDirPath) : workspaceFolderPath;
	if (!fs.existsSync(baseDir) || !fs.statSync(baseDir).isDirectory()) { return []; }

	const entries = fs.readdirSync(baseDir, { withFileTypes: true });
	const suffix = afterStar.startsWith('/') ? afterStar.substring(1) : afterStar;
	const results: CustomizationFileEntry[] = [];
	for (const entry of entries) {
		if (excludeDirs.includes(entry.name)) { continue; }
		const candidatePath = path.join(baseDir, entry.name, suffix);
		if (!fs.existsSync(candidatePath)) { continue; }
		const stat = fs.statSync(candidatePath);
		if (!stat.isFile()) { continue; }
		const displayName = pattern.type === 'skill' ? entry.name : path.basename(candidatePath);
		results.push(buildCustomizationEntry(ctx, candidatePath, displayName));
	}
	return results;
}

/**
 * Recursively walk `dir` up to `depth` levels, collecting files that match `regex`.
 * @internal
 */
function walkDirectoryForPattern(
	dir: string,
	depth: number,
	ctx: PatternScanContext,
	regex: RegExp,
	excludeDirs: string[]
): CustomizationFileEntry[] {
	if (depth < 0) { return []; }
	const children = withErrorRecoverySync(
		() => fs.readdirSync(dir, { withFileTypes: true }),
		[] as fs.Dirent[],
		`walkDirectoryForPattern readdir(${dir})`
	);
	const results: CustomizationFileEntry[] = [];
	for (const child of children) {
		const childPath = path.join(dir, child.name);
		if (child.isDirectory() && !excludeDirs.includes(child.name)) {
			results.push(...walkDirectoryForPattern(childPath, depth - 1, ctx, regex, excludeDirs));
		} else if (child.isFile()) {
			const rel = normalizePath(path.relative(ctx.workspaceFolderPath, childPath));
			if (regex.test(rel)) {
				results.push(buildCustomizationEntry(ctx, childPath));
			}
		}
	}
	return results;
}

/** Handle `scanMode: "recursive"` — glob-match files at any depth. */
function scanRecursivePattern(ctx: PatternScanContext, excludeDirs: string[]): CustomizationFileEntry[] {
	const { workspaceFolderPath, pattern } = ctx;
	const maxDepth = typeof pattern.maxDepth === 'number' ? pattern.maxDepth : 6;
	const regex = globToRegExp(pattern.path, !!pattern.caseInsensitive);
	return walkDirectoryForPattern(workspaceFolderPath, maxDepth, ctx, regex, excludeDirs);
}

function _runPatternScan(ctx: PatternScanContext, excludeDirs: string[]): CustomizationFileEntry[] {
	const scanMode = ctx.pattern.scanMode ?? 'exact';
	if (scanMode === 'exact') {
		const entry = scanExactPattern(ctx);
		return entry ? [entry] : [];
	}
	if (scanMode === 'oneLevel') { return scanOneLevelPattern(ctx, excludeDirs); }
	if (scanMode === 'recursive') { return scanRecursivePattern(ctx, excludeDirs); }
	return [];
}

/**
 * Scan a workspace folder for customization files according to `customizationPatterns.json`.
 */
export function scanWorkspaceCustomizationFiles(workspaceFolderPath: string): CustomizationFileEntry[] {
	if (!workspaceFolderPath || !fs.existsSync(workspaceFolderPath)) { return []; }
	try { if (!fs.statSync(workspaceFolderPath).isDirectory()) { return []; } } catch { return []; }

	const cfg = customizationPatternsData as CustomizationPatternsConfig;
	const stalenessDays = typeof cfg.stalenessThresholdDays === 'number' ? cfg.stalenessThresholdDays : 90;
	const excludeDirs: string[] = Array.isArray(cfg.excludeDirs) ? cfg.excludeDirs : [];

	const results: CustomizationFileEntry[] = [];
	for (const pattern of (cfg.patterns ?? [])) {
		try {
			const ctx: PatternScanContext = { workspaceFolderPath, pattern, stalenessDays };
			results.push(..._runPatternScan(ctx, excludeDirs));
		} catch {
			// ignore per-pattern errors
		}
	}

	// Deduplicate by absolute path
	const uniq: Record<string, CustomizationFileEntry> = {};
	for (const r of results) { uniq[path.normalize(r.path)] = r; }
	return Object.values(uniq);
}

function getModeFromAgentKind(id: string | undefined): 'agent' | 'plan' | 'customAgent' {
	if (!id || id === 'agent') { return 'agent'; }
	if (id.includes('plan-agent/Plan.agent.md')) { return 'plan'; }
	if (id.includes('.agent.md')) { return 'customAgent'; }
	return 'agent';
}

/**
 * Detect the actual mode type from inputState.mode object.
 * Returns 'ask', 'edit', 'agent', 'plan', or 'customAgent'.
 */
export function getModeType(mode: ModeObject | string | null | undefined): 'ask' | 'edit' | 'agent' | 'plan' | 'customAgent' {
	if (!mode) { return 'ask'; }
	if (typeof mode === 'string') {
		if (mode === 'edit') { return 'edit'; }
		if (mode === 'agent') { return 'agent'; }
		return 'ask';
	}
	if (!mode.kind) { return 'ask'; }
	if (mode.kind === 'edit') { return 'edit'; }
	if (mode.kind === 'ask') { return 'ask'; }
	if (mode.kind === 'agent') { return getModeFromAgentKind(mode.id as string | undefined); }
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
		// Resolve file:// URIs via the safe resolver; treat other values as plain paths.
		const fsPath = modeId.startsWith('file://')
			? resolveFileUri(modeId)
			: modeId;
		if (!fsPath) { return null; }

		const filename = path.basename(fsPath);

		// Remove .agent.md extension
		if (filename.endsWith('.agent.md')) {
			return filename.slice(0, -9); // Remove '.agent.md' (9 chars)
		}
		if (filename.endsWith('.md.agent.md')) {
			// Handle case like TestEngineerAgent.md.agent.md
			return filename.slice(0, -10).replace('.md', '');
		}
	} catch {
		return null;
	}

	return null;
}

// ── getEditorNameFromRoot predicates ──────────────────────────────────────────────

/** Returns true when the root folder belongs to a JetBrains IDE Copilot store. */
function isJetBrainsRoot(lower: string): boolean {
	return lower.includes('.copilot/jb');
}

/** Returns true when the root folder belongs to Copilot CLI. */
function isCopilotCliRoot(lower: string): boolean {
	return lower.includes('.copilot') || lower.includes('copilot');
}

/** Returns true when the root folder belongs to VS Code Insiders. */
function isCodeInsidersRoot(lower: string): boolean {
	return lower.includes('code - insiders') || lower.includes('code-insiders') || lower.includes('insiders');
}

/** Returns true when the root folder belongs to VS Code Exploration. */
function isCodeExplorationRoot(lower: string): boolean {
	return lower.includes('code - exploration') || lower.includes('code%20-%20exploration');
}

/** Returns true when the root folder belongs to Visual Studio. */
function isVisualStudioRoot(lower: string): boolean {
	return lower.includes('.vs') && lower.includes('copilot-chat');
}

/** Returns true when the root folder belongs to VS Code. */
function isVSCodeRoot(lower: string): boolean {
	return lower.endsWith('code') || lower.includes('/code/');
}

/**
 * Detect non-VS-Code terminal/CLI tools from a lower-cased normalised root path.
 * Returns the editor name or undefined if none matched.
 * @internal
 */
function detectToolEditorFromRootPath(lower: string): string | undefined {
	// Cline's storage root lives inside a VS Code variant's globalStorage
	// (a path containing /code/ or /cursor/), so its specific extension-id
	// marker must be checked before the generic VS Code family matches.
	if (lower.includes('saoudrizwan.claude-dev')) { return 'Cline'; }
	if (lower.includes('opencode')) { return 'OpenCode'; }
	// Kilo Code (OpenCode fork) data root ~/.local/share/kilo.
	if (lower.endsWith('/kilo')) { return 'Kilo Code'; }
	// Hermes Agent's root is <HERMES_HOME> (Windows: %LOCALAPPDATA%/hermes, else ~/.hermes).
	// 'hermes' doesn't collide with 'copilot'/'code'/'cursor', but checked here alongside
	// the other CLI-tool root markers for consistency.
	if (lower.includes('hermes')) { return 'Hermes'; }
	// OpenAI Codex CLI home (~/.codex). The dot-prefix keeps this from colliding with
	// the generic 'code' substring checks further down ('.codex' never matches '/code/'
	// or endsWith('code')), but it must still run before isVSCodeRoot for clarity.
	if (lower.includes('.codex')) { return 'Codex CLI'; }
	// Kiro CLI root (~/.kiro) must be checked before the Kiro IDE root — both
	// contain 'kiro' but only the CLI root has the dot-prefixed folder.
	if (lower.includes('/.kiro')) { return 'Kiro CLI'; }
	if (lower.includes('kiro.kiroagent') || lower.includes('/kiro/user/') || lower.endsWith('/kiro')) { return 'Kiro'; }
	if (lower.includes('.continue')) { return 'Continue'; }
	if (lower.includes('.vibe')) { return 'Mistral Vibe'; }
	// Antigravity must be checked before generic .gemini (both live under ~/.gemini/).
	if (lower.includes('.gemini/antigravity')) { return 'Antigravity'; }
	if (lower.includes('.gemini')) { return 'Gemini CLI'; }
	if (lower.includes('.pi/agent')) { return 'Pi'; }
	return undefined;
}

/**
 * Determine a friendly editor name from an editor root path (folder name)
 * e.g. 'C:\\...\\AppData\\Roaming\\Code' -> 'VS Code'
 */
export function getEditorNameFromRoot(rootPath: string): string {
	if (!rootPath) { return 'Unknown'; }
	const lower = normalizePathForComparison(rootPath);
	// Eclipse roots contain "copilot" (com.microsoft.copilot.eclipse.core), so they
	// must be matched before the generic Copilot CLI check below.
	if (lower.includes('com.microsoft.copilot.eclipse')) { return 'Eclipse'; }
	// Devin (Cognition Labs' desktop IDE, a fork/rebrand of Windsurf) has its own
	// dataFolderName '.devin' / install marker 'devin-desktop'. Neither substring
	// collides with 'copilot' or 'code', but it is checked early for consistency
	// with the other editor-specific guards in this function.
	if (lower.includes('.devin') || lower.includes('devin-desktop')) { return 'Devin'; }
	// Devin CLI (separate ACP-based CLI agent tool, distinct from the Devin desktop app
	// above) stores its global sessions.db under a 'devin/cli' data dir. Checked before
	// the generic checks below since 'devin' alone would otherwise be ambiguous with the
	// desktop app guard above (that one requires '.devin' or 'devin-desktop' specifically).
	if (lower.includes('devin/cli')) { return 'Devin CLI'; }
	// Check obvious markers first (JetBrains must precede Copilot CLI)
	if (isJetBrainsRoot(lower)) { return 'JetBrains'; }
	if (isCopilotCliRoot(lower)) { return 'Copilot CLI'; }
	const toolEditor = detectToolEditorFromRootPath(lower);
	if (toolEditor) { return toolEditor; }
	if (isCodeInsidersRoot(lower)) { return 'VS Code Insiders'; }
	if (isCodeExplorationRoot(lower)) { return 'VS Code Exploration'; }
	if (lower.includes('vscodium')) { return 'VSCodium'; }
	if (lower.includes('cursor')) { return 'Cursor'; }
	if (isVisualStudioRoot(lower)) { return 'Visual Studio'; }
	// Generic 'code' match (catch AppData\\Roaming\\Code)
	if (isVSCodeRoot(lower)) { return 'VS Code'; }
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

// isMcpTool moved to utils/toolUtils.ts (webview-safe); re-exported so existing importers keep working.
export { isMcpTool } from './utils/toolUtils';

/**
 * Normalize an MCP tool name so that equivalent tools from different servers
 * (local stdio vs remote) are counted under a single canonical key in "By Tool" views.
 *
 * Each rule maps a known equivalent prefix to a canonical prefix. Rules are
 * evaluated in order; the first match wins.
 */
const MCP_NORMALIZATION_RULES: readonly [string, string][] = [
	// GitHub MCP (remote / server-name variants → local stdio form).
	['mcp_github_github_', 'mcp_io_github_git_'],
	['github-mcp-server-', 'mcp_io_github_git_'],
	['mcp_github_mcp_s2_', 'mcp_io_github_git_'],
	['mcp_github_mcp_se_', 'mcp_io_github_git_'],
	['mcp.github.github.', 'mcp.io.github.git.'],

	// Context7 / UPS docs.
	['mcp__plugin_context7_context7__', 'context7-'],
	['mcp__context7__', 'context7-'],
	['mcp_context7_', 'context7-'],
	['mcp_io_github_ups_', 'context7-'],

	// Playwright MCP.
	['mcp__microsoft_playwright-mcp__', 'microsoft_playwright-mcp-'],
	['mcp__playwright__', 'microsoft_playwright-mcp-'],
	['mcp_playwright_', 'microsoft_playwright-mcp-'],
	['mcp_microsoft_pla_', 'microsoft_playwright-mcp-'],

	// Tavily MCP.
	['mcp_tavily-mcp_', 'io_github_tavily-ai_tavily-mcp-'],
	['mcp_tavily_', 'io_github_tavily-ai_tavily-mcp-'],

	// Claude Browser MCP.
	['mcp__claude-in-chrome__', 'mcp__claude_browser__'],
	['mcp__Claude_Browser__', 'mcp__claude_browser__'],
];

/**
 * Normalize an MCP tool name so that equivalent tools from different servers
 * (local stdio vs remote) are counted under a single canonical key in "By Tool" views.
 *
 * Known equivalent prefix families that collapse to a single canonical form:
 * - GitHub MCP: mcp_github_github_, mcp_io_github_git_, github-mcp-server-,
 *   mcp_github_mcp_s2_, mcp_github_mcp_se_, mcp.github.github., mcp.io.github.git.
 * - Context7: context7-, mcp_context7_, mcp__context7__, mcp__plugin_context7_context7__,
 *   mcp_io_github_ups_
 * - Playwright: mcp_microsoft_pla_, microsoft_playwright-mcp-, mcp__playwright__,
 *   mcp_playwright_, mcp__microsoft_playwright-mcp__
 * - Tavily: mcp_tavily-mcp_, io_github_tavily-ai_tavily-mcp-, mcp_tavily_
 * - Claude Browser: mcp__claude-in-chrome__, mcp__claude_browser__, mcp__Claude_Browser__
 */
export function normalizeMcpToolName(toolName: string): string {
	for (const [prefix, canonicalPrefix] of MCP_NORMALIZATION_RULES) {
		if (toolName.startsWith(prefix)) {
			return canonicalPrefix + toolName.substring(prefix.length);
		}
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
	const displayName = lookupKnownToolName(toolName, toolNameMap);
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
		// GUID-keyed MCP servers (e.g. tenant-specific M365 Connector)
		if (isGuidMcpTool(toolName)) {
			return 'Claude MCP';
		}
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

// ── extractRepositoryFromContentReferences helpers ───────────────────────────────────────

/**
 * Normalize a raw content-reference path to a native OS path.
 * VS Code URI paths on Windows start with "/c:/..." and need the leading slash removed.
 */
function normalizeWindowsUriPath(rawPath: string): string {
	return stripWindowsDriveUriPrefix(rawPath);
}

/**
 * Collect all file-system paths from an array of content-reference items.
 * Handles both `reference` and `inlineReference` kinds.
 */
function collectFilePathsFromRefs(contentReferences: ContentReferenceItem[]): string[] {
	const filePaths: string[] = [];
	for (const contentRef of contentReferences) {
		if (!contentRef || typeof contentRef !== 'object') { continue; }
		const { kind } = contentRef;
		let ref: ContentReferenceData | undefined;
		if (kind === 'reference') { ref = contentRef.reference; }
		else if (kind === 'inlineReference') { ref = contentRef.inlineReference; }
		if (!ref) { continue; }
		// Prefer fsPath (native format) over path (URI format)
		const rawPath = ref.fsPath ?? ref.path;
		if (typeof rawPath === 'string' && rawPath.length > 0) {
			filePaths.push(normalizeWindowsUriPath(rawPath));
		}
	}
	return filePaths;
}

/**
 * Build a list of potential git root directories by walking up the directory tree.
 * Returns paths ordered from deepest to shallowest.
 */
function buildPotentialGitRoots(filePath: string): string[] {
	const pathParts = splitNormalizedPath(filePath);
	const isWindowsDrive = hasWindowsDriveSegment(pathParts[0]);
	const roots: string[] = [];
	for (let i = pathParts.length - 1; i >= 1; i--) {
		let potentialRoot = pathParts.slice(0, i).join('/');
		// On Unix, the leading '/' is lost when filtering empty path parts — restore it.
		if (!isWindowsDrive && !potentialRoot.startsWith('/')) {
			potentialRoot = '/' + potentialRoot;
		}
		roots.push(potentialRoot);
	}
	return roots;
}

/**
 * Try to read the remote origin URL from a standard `.git/config` file.
 * Returns undefined if the file does not exist or contains no origin remote.
 */
async function tryReadGitConfigRemote(potentialRoot: string): Promise<string | undefined> {
	try {
		const gitConfig = await fs.promises.readFile(path.join(potentialRoot, '.git', 'config'), 'utf8');
		return parseGitRemoteUrl(gitConfig);
	} catch {
		return undefined;
	}
}

/**
 * Try to read the remote origin URL from a git worktree `.git` file.
 * A worktree `.git` is a plain file containing `gitdir: <path>`.
 * Follows the pointer up two levels to the main git directory where `config` lives.
 * Returns undefined if not a worktree or the URL cannot be determined.
 */
async function tryReadWorktreeGitRemote(potentialRoot: string): Promise<string | undefined> {
	try {
		const gitFileContent = await fs.promises.readFile(path.join(potentialRoot, '.git'), 'utf8');
		const match = gitFileContent.match(/^gitdir:\s*(.+)$/m);
		if (!match) { return undefined; }
		const gitdirPath = match[1].trim();
		const basePath = toPlatformPath(potentialRoot);
		const resolvedGitdir = path.isAbsolute(gitdirPath)
			? gitdirPath
			: path.resolve(basePath, gitdirPath);
		// Standard worktree: gitdir = <main>/.git/worktrees/<name>
		// Main .git dir is 2 levels up; its config holds the remote URL.
		const mainConfigPath = path.join(path.resolve(resolvedGitdir, '..', '..'), 'config');
		const gitConfig = await fs.promises.readFile(mainConfigPath, 'utf8');
		return parseGitRemoteUrl(gitConfig);
	} catch {
		return undefined;
	}
}

/**
 * Extract repository remote URL from file paths found in contentReferences.
 * Walks up the directory tree for each referenced file looking for `.git/config`.
 * Supports both standard repos and git worktrees.
 * @param contentReferences Array of content reference objects from session data
 * @returns The repository remote URL if found, undefined otherwise
 */
export async function extractRepositoryFromContentReferences(contentReferences: ContentReferenceItem[]): Promise<string | undefined> {
	if (!Array.isArray(contentReferences)) { return undefined; }

	const filePaths = collectFilePathsFromRefs(contentReferences);
	if (filePaths.length === 0) { return undefined; }

	const checkedRoots = new Set<string>();
	for (const filePath of filePaths) {
		for (const potentialRoot of buildPotentialGitRoots(filePath)) {
			if (checkedRoots.has(potentialRoot)) { continue; }
			checkedRoots.add(potentialRoot);
			const remoteUrl = await tryReadGitConfigRemote(potentialRoot) ??
				await tryReadWorktreeGitRemote(potentialRoot);
			if (remoteUrl) { return remoteUrl; }
		}
	}
	return undefined;
}

function _resolveCodeWorkspaceEntry(entry: unknown, workspaceFileDir: string): string | undefined {
	if (typeof entry !== 'object' || entry === null) { return undefined; }
	const e = entry as { path?: unknown; uri?: unknown };
	let folderPath: string | undefined;
	// A relative `path` is relative to the .code-workspace file, not to this process's working directory.
	if (typeof e.path === 'string') { folderPath = path.isAbsolute(e.path) ? e.path : path.resolve(workspaceFileDir, e.path); }
	else if (typeof e.uri === 'string' && e.uri.startsWith('file://')) { folderPath = resolveFileUri(e.uri); }
	if (!folderPath) { return undefined; }
	try { return fs.realpathSync.native(folderPath); } catch { return folderPath; }
}

/**
 * Parse a `.code-workspace` multi-root workspace file and return the resolved folder paths.
 * Returns an empty array if the file cannot be read, is invalid JSON, or has no folders.
 */
export function parseCodeWorkspaceFolders(codeWorkspacePath: string): string[] {
	try {
		if (!codeWorkspacePath || !codeWorkspacePath.endsWith('.code-workspace') || !fs.existsSync(codeWorkspacePath)) {
			return [];
		}
		const raw = fs.readFileSync(codeWorkspacePath, 'utf8');
		const obj = JSON.parse(raw);
		if (typeof obj !== 'object' || obj === null || !Array.isArray(obj.folders)) {
			return [];
		}
		const folders: string[] = [];
		for (const entry of obj.folders) {
			const resolved = _resolveCodeWorkspaceEntry(entry, path.dirname(codeWorkspacePath));
			if (resolved) { folders.push(resolved); }
		}
		return folders;
	} catch {
		return [];
	}
}

export function resolveWorkspaceFolderFromSessionPath(sessionFilePath: string, workspaceIdToFolderCache: Map<string, string | undefined>): string | undefined {
	try {
		// Normalize and split path into segments
		const normalized = normalizePath(sessionFilePath);
		const parts = splitNormalizedPath(sessionFilePath);
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
			const parts = splitNormalizedPath(sessionFilePath);
			const idx = parts.findIndex(p => p.toLowerCase() === 'workspacestorage');
			if (idx !== -1 && idx + 1 < parts.length) {
				workspaceIdToFolderCache.set(parts[idx + 1], undefined);
			}
		} catch { }
		return undefined;
	}
}

/**
 * Resolves a session file's workspace folder for cross-editor workspace attribution
 * (e.g. the Copilot Customization Files health matrix). `resolveWorkspaceFolderFromSessionPath`
 * only understands VS Code's `workspaceStorage/<id>` layout, so non-VS Code editors
 * (Copilot CLI, JetBrains, Claude Code, etc.) never resolve through it and would otherwise
 * be silently dropped instead of counted or surfaced as "Unresolved". Falls back to a
 * workspace/cwd path already resolved onto the session data (e.g. Copilot CLI's
 * `workspace.yaml` `cwd` or `session-store.db` `cwd` column) when the VS Code lookup fails.
 */
export function resolveWorkspaceFolderWithFallback(
	sessionFilePath: string,
	workspaceIdToFolderCache: Map<string, string | undefined>,
	fallbackWorkspacePath?: string
): string | undefined {
	return resolveWorkspaceFolderFromSessionPath(sessionFilePath, workspaceIdToFolderCache) ?? fallbackWorkspacePath;
}

/**
 * Best-effort workspace display name for a session summary. Prefers an explicit
 * workspace folder path cached on the session, then the repository name, then
 * workspaceStorage folder resolution. Returns undefined when attribution is
 * unavailable.
 */
export function resolveSessionWorkspaceName(
	sessionData: { workspaceFolderPath?: string; repository?: string },
	sessionFilePath: string,
	workspaceIdToFolderCache?: Map<string, string | undefined>
): string | undefined {
	if (sessionData.workspaceFolderPath) { return getRepoNameFromWorkspacePath(sessionData.workspaceFolderPath); }
	if (sessionData.repository) { return sessionData.repository; }
	if (!workspaceIdToFolderCache) { return undefined; }
	try {
		const workspaceFolder = resolveWorkspaceFolderFromSessionPath(sessionFilePath, workspaceIdToFolderCache);
		if (workspaceFolder) { return getRepoNameFromWorkspacePath(workspaceFolder); }
	} catch { /* attribution is optional */ }
	return undefined;
}

// ── Editor-detection private predicates ──────────────────────────────────────

/** Returns true for Gemini CLI session paths (`.gemini/tmp/.../chats/session-*.jsonl`). */
function isGeminiCliPath(lowerPath: string): boolean {
	return lowerPath.includes('/.gemini/tmp/') &&
		lowerPath.includes('/chats/session-') &&
		lowerPath.endsWith('.jsonl');
}

/** Returns true for VS Code Insiders path segments (`/code - insiders/` or percent-encoded). */
function isCodeInsidersPath(lowerPath: string): boolean {
	return lowerPath.includes('/code - insiders/') || lowerPath.includes('/code%20-%20insiders/');
}

/** Returns true for VS Code Exploration path segments. */
function isCodeExplorationPath(lowerPath: string): boolean {
	return lowerPath.includes('/code - exploration/') || lowerPath.includes('/code%20-%20exploration/');
}

/** Returns true for VS Code Server path segments. */
function isVSCodeServerPath(lowerPath: string): boolean {
	return lowerPath.includes('.vscode-server/') || lowerPath.includes('.vscode-remote/');
}

/**
 * Returns true for Visual Studio path segments: `/copilot-chat/.../sessions/` under either
 * a solution's `/.vs/` folder or VS's own `/vsgithubcopilot/` AppData folder (solution-less chats).
 */
function isVisualStudioPath(lowerPath: string): boolean {
	if (!lowerPath.includes('/copilot-chat/') || !lowerPath.includes('/sessions/')) { return false; }
	return lowerPath.includes('/.vs/') || lowerPath.includes('/vsgithubcopilot/copilot-chat/');
}

/**
 * Returns true for SQL Server Management Studio Copilot Chat sessions
 * (`…/SSMS/<version>/SSMSGitHubCopilot/copilot-chat/<hash>/sessions/<uuid>`).
 * Checked before {@link isVisualStudioPath} so SSMS keeps its own label — the same
 * split `VisualStudioAdapter.getDisplayName()` makes.
 */
function isSsmsPath(lowerPath: string): boolean {
	return lowerPath.includes('/ssmsgithubcopilot/copilot-chat/') && lowerPath.includes('/sessions/');
}

/** Returns true for VS Code Insiders via loose substring match (used by detectEditorSource). */
function isCodeInsidersSource(lowerPath: string): boolean {
	return lowerPath.includes('code - insiders') || lowerPath.includes('code-insiders');
}

// ── getEditorTypeFromPath helpers ───────────────────────────────────────────

/**
 * Detect editors whose sessions live inside an editor's globalStorage folder
 * from a lower-cased normalised path.
 * Kiro CLI (~/.kiro/sessions/cli) and Kiro IDE (kiro.kiroagent global storage)
 * are tracked as separate editors. Cline task files live under a VS Code
 * variant's globalStorage (saoudrizwan.claude-dev), so its specific marker must
 * win before the generic /code/ and /cursor/ VS Code-variant matches in
 * detectVSCodeVariantFromPath.
 * @internal
 */
function detectGlobalStorageEditorFromPath(lowerPath: string): string | undefined {
	if (lowerPath.includes('/.kiro/sessions/cli/')) { return 'Kiro CLI'; }
	if (lowerPath.includes('/kiro.kiroagent/workspace-sessions/')) { return 'Kiro'; }
	if (lowerPath.includes('/saoudrizwan.claude-dev/tasks/')) { return 'Cline'; }
	return undefined;
}

/**
 * Detect JetBrains and Copilot CLI editors from a lower-cased normalised path.
 * JetBrains must be checked before Copilot CLI: both live under ~/.copilot/ but
 * jb/ is a sibling of session-state/ and must be attributed to the JetBrains IDE.
 * @internal
 */
function detectCopilotFamilyFromPath(lowerPath: string): string | undefined {
	if (lowerPath.includes('/.copilot/jb/')) { return 'JetBrains'; }
	if (lowerPath.includes('/.copilot/session-store.db#')) { return 'Copilot CLI'; }
	if (lowerPath.includes('/.copilot/session-state/')) { return 'Copilot CLI'; }
	return undefined;
}

/**
 * Peek at the start of a Claude Code session file (~/.claude/projects/**) to find the
 * `entrypoint` field and distinguish the standalone Claude Desktop app, the terminal CLI,
 * and the VS Code extension. All three write to the same directory and are indistinguishable
 * by path alone — only file content (the `entrypoint` field on early JSONL events) tells them
 * apart. Observed real-world values are "claude-desktop" and "cli" (not "claude-cli" — the
 * field is the short form); any other/unknown value (e.g. a VS Code extension entrypoint)
 * falls back to the generic "Claude Code" label.
 * Bounded to the first 64KB so classification stays cheap even for large session files.
 * @internal
 */
export function detectClaudeCodeEditorVariant(filePath: string): string {
	const known = claudeCodeVariantCache.get(filePath);
	if (known !== undefined) { return known; }
	const found = readClaudeCodeEditorVariant(filePath);
	if (found !== undefined) {
		// The entrypoint a session records never changes once written, so a definitive answer is kept. A file with
		// no entrypoint yet is deliberately not cached: it may gain one, and must be re-read when it does.
		if (claudeCodeVariantCache.size >= CLAUDE_CODE_VARIANT_CACHE_MAX) { claudeCodeVariantCache.clear(); }
		claudeCodeVariantCache.set(filePath, found);
		return found;
	}
	return 'Claude Code';
}

/**
 * Called once per Claude Code session file for *every* label lookup, from several views at once. Each call used to
 * open the file and read 64 KB synchronously on the extension host (the dominant cost of the host's longest
 * stalls on a machine with hundreds of Claude Code sessions), so the answer is remembered per path.
 */
const claudeCodeVariantCache = new Map<string, string>();
const CLAUDE_CODE_VARIANT_CACHE_MAX = 50_000;

/** Test hook: forget remembered variants so a test can rewrite a file at the same path. */
export function resetClaudeCodeEditorVariantCacheForTests(): void { claudeCodeVariantCache.clear(); }

/** Reads the entrypoint from the head of a session file; `undefined` when none is recorded (or it is unreadable). */
function readClaudeCodeEditorVariant(filePath: string): string | undefined {
	try {
		const fd = fs.openSync(filePath, 'r');
		try {
			const buffer = Buffer.alloc(65536);
			const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
			const chunk = buffer.toString('utf8', 0, bytesRead);
			for (const line of chunk.split('\n')) {
				const trimmed = line.trim();
				if (!trimmed) { continue; }
				let event: any;
				try { event = JSON.parse(trimmed); } catch { continue; } // partial/truncated line
				if (event?.entrypoint === 'claude-desktop') { return 'Claude Desktop'; }
				if (event?.entrypoint === 'cli') { return 'Claude Code CLI'; }
				if (event?.entrypoint) { return 'Claude Code'; }
			}
		} finally {
			fs.closeSync(fd);
		}
	} catch { /* file unreadable — fall back to default below */ }
	return undefined;
}

/**
 * $CODEX_HOME / $HERMES_HOME as their adapters use them (codexcli.ts getCodexHome,
 * hermes.ts getConfigDir): the raw value when non-blank — relative values stay relative,
 * no `~` expansion.
 */
function rawAgentHome(value: string | undefined): string | undefined {
	return value && value.trim() ? value : undefined;
}

/** Session entries Codex keeps directly under its home: rollout dirs and `state_<N>.sqlite#<id>` thread paths. */
const CODEX_HOME_OWNED_CHILD_RE = /^(sessions\/|archived_sessions\/|state_\d+\.sqlite#)/;

/** $VIBE_HOME as mistralvibe.ts getVibeHomeDir uses it: `~` expanded, then resolved to absolute. */
function vibeAgentHome(value: string | undefined): string | undefined {
	return value ? path.resolve(value.replace(/^~/, os.homedir())) : undefined;
}

/**
 * Detect CLI agents whose data root was relocated with $CODEX_HOME, $VIBE_HOME or
 * $HERMES_HOME to a folder not named like the default (.codex, .vibe, hermes), which the
 * default-name substring checks cannot recognise. Only the adapters' own session
 * sub-paths under the configured root match, so a broad root (e.g. the home dir) does
 * not swallow unrelated files. Each home is interpreted exactly as its adapter does and
 * prefixes are built with `path.join`, like the adapters' own paths, so edge cases such
 * as `.` or `/` line up with what the adapter discovers. Shared by the extension and the
 * CLI detectors.
 * @internal
 */
export function detectRelocatedAgentHomeFromPath(lowerPath: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
	const codexHome = rawAgentHome(env['CODEX_HOME']);
	const codexPrefix = codexHome === undefined ? undefined : joinedChildPrefixForComparison(codexHome);
	if (codexPrefix !== undefined && lowerPath.startsWith(codexPrefix) &&
		CODEX_HOME_OWNED_CHILD_RE.test(lowerPath.slice(codexPrefix.length))) { return 'Codex CLI'; }
	const vibeHome = vibeAgentHome(env['VIBE_HOME']);
	if (vibeHome && lowerPath.startsWith(joinedChildPrefixForComparison(path.join(vibeHome, 'logs', 'session')))) { return 'Mistral Vibe'; }
	const hermesHome = rawAgentHome(env['HERMES_HOME']);
	if (hermesHome && lowerPath.startsWith(`${normalizePathForComparison(path.join(hermesHome, 'state.db'))}#`)) { return 'Hermes'; }
	return undefined;
}

/**
 * Detect terminal CLI agents with dedicated data stores from a lower-cased normalised path.
 * @internal
 */
function detectCliAgentStoreFromPath(lowerPath: string): string | undefined {
	if (lowerPath.includes('/.crush/crush.db#')) { return 'Crush'; }
	// Kilo Code (OpenCode fork): virtual DB session paths <...>/.local/share/kilo/kilo.db#ses_<id>.
	// Checked here so it wins over any generic substring fallbacks further down.
	if (lowerPath.includes('/kilo/kilo.db#')) { return 'Kilo Code'; }
	// Hermes Agent's virtual path scheme is <HERMES_HOME>/state.db#<session_id>. HERMES_HOME
	// itself never contains 'code'/'copilot'/'cursor' (Windows: %LOCALAPPDATA%/hermes, else
	// ~/.hermes), but the check is placed here alongside the other DB-backed CLI adapters for
	// consistency and to keep it ahead of any future generic substring matches.
	if (lowerPath.includes('hermes/state.db#')) { return 'Hermes'; }
	// Devin CLI virtual paths: <...>/devin/cli/sessions.db#<id>. Checked here (not merely
	// the generic 'devin' substring match in detectIDEEditorSource) so it always wins over
	// the desktop app's devin:// scheme / Windsurf family checks, which are handled earlier
	// in getEditorTypeFromPath/detectEditorSource before this function is even called.
	if (lowerPath.includes('devin/cli/sessions.db#')) { return 'Devin CLI'; }
	// OpenAI Codex CLI: rollout JSONL files under ~/.codex/sessions|archived_sessions and
	// virtual thread paths ~/.codex/state_<N>.sqlite#<thread-id>. Must be detected here,
	// before the loose 'code' substring fallbacks in detectIDEEditorSource /
	// detectVSCodeVariantFromPath ('codex' contains 'code' and would misclassify as VS Code).
	if (lowerPath.includes('/.codex/')) { return 'Codex CLI'; }
	return detectRelocatedAgentHomeFromPath(lowerPath);
}

/**
 * Detect tool-specific (non-VS Code family) editors from a lower-cased normalised path.
 * Returns the editor name or undefined if none matched.
 * @internal
 */
function detectToolEditorFromPath(
	filePath: string,
	lowerPath: string,
	isOpenCodeSessionFile?: (p: string) => boolean
): string | undefined {
	const copilotFamily = detectCopilotFamilyFromPath(lowerPath);
	if (copilotFamily) { return copilotFamily; }
	if (isOpenCodeSessionFile?.(filePath)) { return 'OpenCode'; }
	const cliAgent = detectCliAgentStoreFromPath(lowerPath);
	if (cliAgent) { return cliAgent; }
	// Cursor virtual paths must be checked before the generic /cursor/ match in detectVSCodeVariantFromPath.
	if (lowerPath.includes('/cursor/user/globalstorage/state.vscdb#')) { return 'Cursor'; }
	if (lowerPath.includes('/.pi/agent/sessions/')) { return 'Pi'; }
	const globalStorageEditor = detectGlobalStorageEditorFromPath(lowerPath);
	if (globalStorageEditor) { return globalStorageEditor; }
	if (lowerPath.includes('/.continue/sessions/')) { return 'Continue'; }
	if (lowerPath.includes('/claude-code-sessions/')) { return 'Claude Desktop Cowork'; }
	if (lowerPath.includes('/local-agent-mode-sessions/')) { return 'Claude Desktop Cowork'; }
	if (lowerPath.includes('/.claude/projects/')) { return detectClaudeCodeEditorVariant(filePath); }
	if (lowerPath.includes('/.vibe/logs/session/')) { return 'Mistral Vibe'; }
	// Antigravity must be checked before Gemini CLI: both live under ~/.gemini/
	// but Antigravity sessions are under ~/.gemini/antigravity/brain/ which is more specific.
	if (lowerPath.includes('/.gemini/antigravity/brain/')) { return 'Antigravity'; }
	if (isGeminiCliPath(lowerPath)) { return 'Gemini CLI'; }
	return undefined;
}

/**
 * Detect VS Code family editors (including Cursor, VSCodium, VS Code Server, Visual Studio)
 * from a lower-cased normalised path.
 * Returns the editor name or undefined if none matched.
 * @internal
 */
function detectVSCodeVariantFromPath(lowerPath: string): string | undefined {
	if (isCodeInsidersPath(lowerPath)) { return 'VS Code Insiders'; }
	if (isCodeExplorationPath(lowerPath)) { return 'VS Code Exploration'; }
	if (lowerPath.includes('/vscodium/')) { return 'VSCodium'; }
	if (lowerPath.includes('/cursor/')) { return 'Cursor'; }
	if (lowerPath.includes('.vscode-server-insiders/')) { return 'VS Code Server (Insiders)'; }
	if (isVSCodeServerPath(lowerPath)) { return 'VS Code Server'; }
	if (isSsmsPath(lowerPath)) { return 'SSMS'; }
	if (isVisualStudioPath(lowerPath)) { return 'Visual Studio'; }
	if (lowerPath.includes('/code/')) { return 'VS Code'; }
	return undefined;
}

/**
 * Determine the editor type from a session file path.
 * Returns: 'VS Code', 'VS Code Insiders', 'VSCodium', 'Cursor', 'Copilot CLI',
 *          'JetBrains', 'OpenCode', 'Claude Code', 'Claude Desktop', 'Continue',
 *          'Mistral Vibe', 'Gemini CLI', 'Claude Desktop Cowork', 'Crush', 'Cline',
 *          or 'Unknown'.
 * Note: 'Claude Code' and 'Claude Desktop' share the same ~/.claude/projects/ directory
 * and are distinguished by the `entrypoint` field inside the session file, not the path
 * (see detectClaudeCodeEditorVariant). 'Claude Desktop Cowork' is a separate, unrelated
 * feature (claude-code-sessions, formerly local-agent-mode-sessions) and is still
 * detected purely by path.
 */
export function getEditorTypeFromPath(filePath: string, isOpenCodeSessionFile?: (p: string) => boolean): string {
	const lowerPath = normalizePathForComparison(filePath);
	// Devin (Cognition Labs' desktop IDE, a fork/rebrand of Windsurf) uses its own
	// devin://trajectory/{id} virtual path scheme — check before the windsurf:// check
	// since they are disjoint prefixes, order does not matter here, but keeping the
	// two paired makes the shared-lineage relationship clear.
	if (lowerPath.startsWith('devin://')) { return 'Devin'; }
	if (lowerPath.startsWith('windsurf://')) { return 'Windsurf'; }
	// Eclipse Copilot conversations live in the workspace metadata; check before
	// the generic VS Code match (the path can pass through a 'code' folder).
	if (lowerPath.includes('com.microsoft.copilot.eclipse')) { return 'Eclipse'; }
	return detectToolEditorFromPath(filePath, lowerPath, isOpenCodeSessionFile) ??
		detectVSCodeVariantFromPath(lowerPath) ??
		'Unknown';
}

/**
 * Maps the content-classified `ModeUsage` keys (see `MODE_USAGE_CONTENT_CLASSIFIED_KEYS` in
 * `vscode-extension/src/webview/shared/types.ts`) to the editor label
 * `refineEditorLabelForInteractionModeSplit` produces for them when synced to the sharing
 * server. `claudeDesktop` is intentionally absent: Claude Desktop already gets its own
 * stable path-based label ('Claude Desktop') via `detectClaudeCodeEditorVariant`, so it
 * needs no further refinement here.
 *
 * `workspaceHelpers.test.ts` asserts this map's keys plus `claudeDesktop` equal
 * `MODE_USAGE_CONTENT_CLASSIFIED_KEYS` — add a new content-classified interaction mode to
 * one and the test fails until the other side is updated too.
 */
export const SYNCED_INTERACTION_MODE_LABELS: Readonly<Record<string, string>> = {
	cliApp: 'Copilot App',
	claudeVsCode: 'Claude (VS Code)',
};

/**
 * Refines a `getEditorTypeFromPath` result with the same content-based signals the
 * "Interaction Modes" usage view already applies per-session (see
 * `usageAnalysis.ts::_asuApplyCopilotAppSplit` and `claudeCodeAdapter.ts::resolveModeBucket`),
 * so consumers that sync a single per-file editor label (e.g. the sharing-server upload)
 * can distinguish:
 *  - 'Copilot App' — a Copilot CLI session launched via the Copilot desktop app
 *    (`client_name: github/autopilot` in the session's sibling `workspace.yaml`).
 *    Only covers file-based (worktree) session-state sessions; DB-backed Copilot CLI
 *    sessions (session-store.db) still report 'Copilot CLI'.
 *  - 'Claude (VS Code)' — a Claude Code session embedded in VS Code, i.e. the generic
 *    'Claude Code' bucket `detectClaudeCodeEditorVariant` returns for any entrypoint other
 *    than the standalone desktop app or the terminal CLI.
 * Leaves every other editor label untouched.
 */
export function refineEditorLabelForInteractionModeSplit(filePath: string, baseLabel: string): string {
	if (baseLabel === 'Claude Code') { return SYNCED_INTERACTION_MODE_LABELS.claudeVsCode; }
	if (baseLabel === 'Copilot CLI' && isCopilotAppSessionFile(filePath)) { return SYNCED_INTERACTION_MODE_LABELS.cliApp; }
	return baseLabel;
}

/**
 * Synchronously checks the sibling `workspace.yaml` of a Copilot CLI session-state file for
 * `client_name: github/autopilot`, the marker the Copilot desktop app writes when it launches
 * the CLI. Mirrors the async check in `usageAnalysis.ts::_asuApplyCopilotAppSplit`, but sync
 * so it can be called from the otherwise-synchronous `getEditorTypeFromPath` family.
 * @internal
 */
function isCopilotAppSessionFile(filePath: string): boolean {
	try {
		const yamlPath = path.join(path.dirname(filePath), 'workspace.yaml');
		const content = fs.readFileSync(yamlPath, 'utf8');
		const clientMatch = content.match(/^client_name:\s*(.+)$/m);
		return !!clientMatch && isCopilotAppClientName(clientMatch[1].trim());
	} catch {
		return false;
	}
}

// ── detectEditorSource helper ──────────────────────────────────────────

/**
 * Detect VS Code family and related IDE editors via loose substring matching.
 * Used by detectEditorSource which uses broader (no-slash) patterns.
 * @internal
 */
function detectIDEEditorSource(lowerPath: string): string | undefined {
	if (lowerPath.includes('cursor')) { return 'Cursor'; }
	if (isCodeInsidersSource(lowerPath)) { return 'VS Code Insiders'; }
	if (lowerPath.includes('vscodium')) { return 'VSCodium'; }
	// Devin must be checked before the generic 'windsurf' substring match below is
	// irrelevant here (disjoint word), but Devin's own data folder is named '.devin'.
	if (lowerPath.includes('devin')) { return 'Devin'; }
	if (lowerPath.includes('windsurf')) { return 'Windsurf'; }
	if (isSsmsPath(lowerPath)) { return 'SSMS'; }
	if (isVisualStudioPath(lowerPath)) { return 'Visual Studio'; }
	if (lowerPath.includes('code')) { return 'VS Code'; }
	return undefined;
}

/**
 * Determine which editor the session file belongs to based on its path.
 */
export function detectEditorSource(filePath: string, isOpenCodeSessionFile?: (p: string) => boolean): string {
	const lowerPath = normalizePathForComparison(filePath);
	if (lowerPath.startsWith('devin://')) { return 'Devin'; }
	if (lowerPath.startsWith('windsurf://')) { return 'Windsurf'; }
	if (lowerPath.includes('com.microsoft.copilot.eclipse')) { return 'Eclipse'; }
	// Delegate to the shared tool-editor detector (handles JetBrains, Copilot CLI, OpenCode,
	// Crush, Pi, Continue, Claude, Vibe, Antigravity, Gemini CLI).
	return detectToolEditorFromPath(filePath, lowerPath, isOpenCodeSessionFile) ??
		detectIDEEditorSource(lowerPath) ?? 'Unknown';
}

