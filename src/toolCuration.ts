/**
 * Tool Curation analysis module.
 *
 * Compares the set of *available* tools (MCP servers, extension-contributed tools,
 * skill files discovered on disk) against the tools actually *used* within a
 * look-back window, and produces actionable recommendations to reduce prompt-bloat
 * and unused context overhead.
 *
 * This module is intentionally pure (no direct VS Code API calls) so it can be
 * unit-tested with mocked data and re-used by the CLI.  VS Code-specific data
 * (e.g. `vscode.lm.tools`) is collected in extension.ts and passed in.
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

import type {
	AvailableToolEntry,
	ToolCurationAnalysis,
	ToolCurationRecommendation,
	UsageAnalysisPeriod,
} from './types';
import { isMcpTool, extractMcpServerName } from './workspaceHelpers';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Rough characters-per-token ratio used to estimate prompt token overhead. */
const CHARS_PER_TOKEN = 4;

/** Minimum number of MCP tool calls in the window to consider a server "used". */
const MCP_SERVER_USE_THRESHOLD = 1;

// ---------------------------------------------------------------------------
// Runtime tool enumeration (VS Code only — pass `[]` from CLI)
// ---------------------------------------------------------------------------

/**
 * Minimal shape of a VS Code LanguageModelToolInformation entry.
 * Declared locally to avoid a hard dependency on the `vscode` module, which is
 * unavailable when this module is imported by the CLI.
 */
export interface RuntimeToolInfo {
	name: string;
	description: string;
	tags?: readonly string[];
}

/**
 * Convert VS Code runtime tool info (`vscode.lm.tools`) into `AvailableToolEntry` objects.
 * Call this from extension.ts and pass the result to `analyzeToolCuration`.
 */
export function enumerateRuntimeTools(tools: readonly RuntimeToolInfo[]): AvailableToolEntry[] {
	return tools.map((t): AvailableToolEntry => {
		if (isMcpTool(t.name)) {
			return {
				name: t.name,
				description: t.description,
				source: 'mcp',
				server: extractMcpServerName(t.name),
			};
		}
		return {
			name: t.name,
			description: t.description,
			source: 'builtin',
		};
	});
}

// ---------------------------------------------------------------------------
// Extension-contributed MCP servers (VS Code only — pass `[]` from CLI)
// ---------------------------------------------------------------------------

/**
 * Minimal shape of a VS Code Extension object needed for MCP server enumeration.
 * Declared locally to avoid a hard dependency on the `vscode` module.
 */
export interface ExtensionInfo {
	id: string;
	displayName?: string;
	isActive: boolean;
	packageJSON?: {
		displayName?: string;
		contributes?: {
			mcpServers?: Record<string, { label?: string; [key: string]: unknown }>;
		};
	};
}

/**
 * Enumerate MCP servers contributed by installed VS Code extensions via their
 * `contributes.mcpServers` package.json entry.
 *
 * These servers may not be actively running yet (e.g. the server hasn't been started
 * for the current session), so they won't appear in `vscode.lm.tools`. Call this
 * alongside `enumerateRuntimeTools` and deduplicate by server name before merging.
 *
 * @param extensions  Pass `vscode.extensions.all` from extension.ts.
 * @param enabledServerNames  Set of MCP server names that currently have at least one
 *   enabled tool in `vscode.lm.tools`. Used to mark each entry's `enabled` flag so
 *   the UI can tell "installed but tools disabled" apart from "installed and enabled".
 *   Pass an empty set if you don't have this information.
 */
export function enumerateExtensionMcpServers(
	extensions: readonly ExtensionInfo[],
	enabledServerNames: ReadonlySet<string> = new Set(),
): AvailableToolEntry[] {
	const entries: AvailableToolEntry[] = [];
	for (const ext of extensions) {
		const mcpServers = ext.packageJSON?.contributes?.mcpServers;
		if (!mcpServers || typeof mcpServers !== 'object') { continue; }
		for (const serverName of Object.keys(mcpServers)) {
			const serverDef = mcpServers[serverName];
			const label = serverDef?.label ?? serverName;
			const displayName = ext.packageJSON?.displayName ?? ext.displayName ?? ext.id;
			entries.push({
				name: `mcp__${serverName}`,
				description: `MCP server "${label}" provided by extension ${displayName}`,
				source: 'mcp',
				server: serverName,
				extensionId: ext.id,
				enabled: enabledServerNames.has(serverName),
				extensionActive: ext.isActive,
			});
		}
	}
	return entries;
}

// ---------------------------------------------------------------------------
// Settings-based MCP servers (VS Code only — pass `{}` from CLI)
// ---------------------------------------------------------------------------

/**
 * Build `AvailableToolEntry` stubs for MCP servers configured in VS Code's
 * `mcp.servers` setting (user or workspace scope).
 *
 * This covers servers added via the VS Code UI or settings.json directly,
 * which is separate from the file-based `.vscode/mcp.json` approach.
 *
 * Pass `vscode.workspace.getConfiguration('mcp').get<Record<string, unknown>>('servers', {})`.
 */
export function buildMcpEntriesFromSettings(servers: Record<string, unknown>): AvailableToolEntry[] {
	if (!servers || typeof servers !== 'object') { return []; }
	return Object.keys(servers).map((serverName): AvailableToolEntry => ({
		name: `mcp__${serverName}`,
		description: `MCP server: ${serverName}`,
		source: 'mcp',
		server: serverName,
	}));
}

// ---------------------------------------------------------------------------
// MCP JSON parsing (works in both VS Code and CLI)
// ---------------------------------------------------------------------------

interface McpJsonServer {
	command?: string;
	url?: string;
	[key: string]: unknown;
}

interface McpJsonFile {
	servers?: Record<string, McpJsonServer>;
	inputs?: unknown[];
}

/**
 * Parse a `.vscode/mcp.json` file and return the configured server names.
 * Returns an empty array when the file does not exist or cannot be parsed.
 */
export function parseMcpJson(mcpJsonPath: string): string[] {
	try {
		if (!fs.existsSync(mcpJsonPath)) { return []; }
		const raw = fs.readFileSync(mcpJsonPath, 'utf-8');
		const parsed = JSON.parse(raw) as McpJsonFile;
		const servers = parsed?.servers;
		if (!servers || typeof servers !== 'object') { return []; }
		return Object.keys(servers);
	} catch {
		return [];
	}
}

/**
 * Candidate MCP config file paths for a workspace folder, in priority order.
 *
 * Covers:
 * - VS Code:         `<folder>/.vscode/mcp.json`
 * - Visual Studio:   `<folder>/.mcp.json`, `<folder>/.vs/mcp.json`
 * - Cursor:          `<folder>/.cursor/mcp.json`
 */
function mcpConfigPathsForFolder(folder: string): string[] {
	return [
		path.join(folder, '.vscode', 'mcp.json'),
		path.join(folder, '.mcp.json'),
		path.join(folder, '.vs', 'mcp.json'),
		path.join(folder, '.cursor', 'mcp.json'),
	];
}

/**
 * User-level MCP config paths (Visual Studio reads `%USERPROFILE%\.mcp.json`).
 * Returns an empty array when the HOME/USERPROFILE env var is not set.
 */
function userMcpConfigPaths(): string[] {
	const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
	if (!home) { return []; }
	return [path.join(home, '.mcp.json')];
}

/**
 * Build `AvailableToolEntry` stubs for MCP servers discovered from config files.
 * Because mcp.json doesn't enumerate per-tool capabilities we create one entry
 * per server (source = 'mcp') so the curation report can flag entire servers.
 *
 * Checks (in order, deduplicating by server name):
 * - `<folder>/.vscode/mcp.json`  (VS Code)
 * - `<folder>/.mcp.json`         (Visual Studio repo-root)
 * - `<folder>/.vs/mcp.json`      (Visual Studio solution-scoped)
 * - `<folder>/.cursor/mcp.json`  (Cursor)
 * - `%USERPROFILE%/.mcp.json`    (Visual Studio user-global)
 */
export function buildMcpEntriesFromJson(workspaceFolderPaths: string[]): AvailableToolEntry[] {
	const entries: AvailableToolEntry[] = [];
	// Track server → all config file paths (deduplicate per file too)
	const serverConfigFiles = new Map<string, string[]>();
	const seenServers = new Set<string>();

	const allPaths: string[] = [
		...workspaceFolderPaths.flatMap(mcpConfigPathsForFolder),
		...userMcpConfigPaths(),
	];

	for (const mcpPath of allPaths) {
		for (const serverName of parseMcpJson(mcpPath)) {
			if (!serverConfigFiles.has(serverName)) {
				serverConfigFiles.set(serverName, []);
			}
			const files = serverConfigFiles.get(serverName)!;
			if (!files.includes(mcpPath)) { files.push(mcpPath); }
			if (!seenServers.has(serverName)) {
				seenServers.add(serverName);
				// Placeholder entry — configFiles will be set after all paths scanned
				entries.push({
					name: `mcp__${serverName}`,
					description: `MCP server: ${serverName}`,
					source: 'mcp',
					server: serverName,
					configFiles: files,  // same array reference — will grow as more paths are found
				});
			}
		}
	}

	return entries;
}

// ---------------------------------------------------------------------------
// Skill discovery (works in both VS Code and CLI)
// ---------------------------------------------------------------------------

/**
 * Parse YAML frontmatter from a SKILL.md file and extract the `description` field.
 *
 * Handles:
 * - Inline values:            `description: Some text`
 * - Quoted inline values:     `description: "Some text"`
 * - Folded block scalars:     `description: >-` / `description: >`
 * - Literal block scalars:    `description: |-` / `description: |` / `description: |>`
 *
 * For folded scalars (starting with `>`) continuation lines are joined with a single
 * space (standard YAML folded behaviour).  For literal scalars (starting with `|`)
 * continuation lines are joined with a newline.
 *
 * Falls back to the first Markdown heading (`# Title`) when the frontmatter has no
 * `description` key, and to `fallback` when neither can be found.
 */
function readSkillDescription(skillMdPath: string, fallback: string): string {
	try {
		const content = fs.readFileSync(skillMdPath, 'utf-8');
		const desc = extractDescriptionFromSkillContent(content);
		if (desc) { return desc; }
	} catch {
		// ignore read errors
	}
	return fallback;
}

/**
 * Extract the description value from the text content of a SKILL.md file.
 * Exported for unit testing.
 */
export function extractDescriptionFromSkillContent(content: string): string | undefined {
	// --- Attempt to parse YAML frontmatter block ---
	const frontmatter = extractFrontmatter(content);
	if (frontmatter !== undefined) {
		const desc = parseFrontmatterDescription(frontmatter);
		if (desc) { return desc; }
	}

	// --- Fallback: description: anywhere in the file (no frontmatter delimiters) ---
	// Match only an inline value — skip block scalar indicators
	const inlineMatch = /^description:\s+(?!>|[|])(.+)/im.exec(content);
	if (inlineMatch) {
		return inlineMatch[1].trim().replace(/^["']|["']$/g, '');
	}

	// --- Final fallback: first Markdown heading ---
	const headingMatch = /^#\s+(.+)/m.exec(content);
	if (headingMatch) { return headingMatch[1].trim(); }

	return undefined;
}

/** Return the raw frontmatter text (between the two `---` fences), or undefined. */
function extractFrontmatter(content: string): string | undefined {
	// Allow an optional BOM and optional leading whitespace before the first fence
	const stripped = content.replace(/^\uFEFF/, '').trimStart();
	if (!/^---(?:\r?\n|$)/.test(stripped)) { return undefined; }
	const afterOpen = stripped.slice(3);
	// The closing fence must be `---` on its own line; allow EOF without trailing newline
	const closeIdx = afterOpen.search(/\n---(?:\r?\n|$)/m);
	if (closeIdx === -1) { return undefined; }
	return afterOpen.slice(0, closeIdx);
}

/**
 * Extract the `description` value from a raw YAML frontmatter string.
 * Handles inline, folded (>/->) and literal (|/|-/|>) block styles.
 */
/** Collect indented body lines following a block scalar indicator, with all lines trimmed to remove leading/trailing whitespace. */
function collectBlockScalarLines(lines: string[], startIdx: number, keyIndent: number): string[] {
	const bodyLines: string[] = [];
	for (let j = startIdx; j < lines.length; j++) {
		const bodyLine = lines[j];
		if (bodyLine.trim() === '') { bodyLines.push(''); continue; }
		const bodyIndent = bodyLine.match(/^(\s*)/)?.[1].length ?? 0;
		if (bodyIndent <= keyIndent) { break; }
		bodyLines.push(bodyLine.trim());
	}
	// Trim trailing blank lines
	while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1] === '') { bodyLines.pop(); }
	return bodyLines;
}

function parseFrontmatterDescription(frontmatter: string): string | undefined {
	const lines = frontmatter.split(/\r?\n/);

	for (let i = 0; i < lines.length; i++) {
		const keyMatch = /^(\s*)description:\s*(.*)/i.exec(lines[i]);
		if (!keyMatch) { continue; }

		const indent = keyMatch[1].length;
		const valueRaw = keyMatch[2].trim();

		// Block scalar indicator: >, >-, |, |-, |>
		const blockMatch = /^([|>])[-+>]?\s*$/.exec(valueRaw);
		if (blockMatch) {
			const bodyLines = collectBlockScalarLines(lines, i + 1, indent);
			if (bodyLines.length === 0) { return undefined; }
			return blockMatch[1] === '>' ? bodyLines.join(' ') : bodyLines.join('\n');
		}

		// Inline value (possibly quoted)
		return valueRaw ? valueRaw.replace(/^["']|["']$/g, '') : undefined;
	}

	return undefined;
}

function readJsonFile(filePath: string): unknown {
	try {
		if (!fs.existsSync(filePath)) { return undefined; }
		const raw = fs.readFileSync(filePath, 'utf-8');
		return JSON.parse(raw);
	} catch {
		return undefined;
	}
}

/** Collect skill entries from a single `.github/skills` directory. */
function collectSkillsFromDirectory(folder: string, skillsDir: string, seenPaths: Set<string>, pluginName?: string): AvailableToolEntry[] {
	let skillDirs: fs.Dirent[];
	try {
		skillDirs = fs.readdirSync(skillsDir, { withFileTypes: true });
	} catch {
		return [];
	}

	const entries: AvailableToolEntry[] = [];
	for (const entry of skillDirs) {
		if (!entry.isDirectory()) { continue; }
		const skillMdPath = path.join(skillsDir, entry.name, 'SKILL.md');
		if (!fs.existsSync(skillMdPath) || seenPaths.has(skillMdPath)) { continue; }
		seenPaths.add(skillMdPath);
		const description = readSkillDescription(skillMdPath, `Skill: ${entry.name}`);
		const relativePath = path.relative(folder, skillMdPath).replace(/\\/g, '/');
		const entry2: AvailableToolEntry = { name: entry.name, description, source: 'skill', skillPath: relativePath, configFiles: [skillMdPath] };
		if (pluginName) { entry2.pluginName = pluginName; }
		entries.push(entry2);
	}
	return entries;
}

const SKILL_DIR_SCAN_EXCLUDES = new Set([
	'.git',
	'node_modules',
	'dist',
	'out',
	'build',
	'.next',
	'.venv',
	'venv',
	'target',
	'.idea',
	'.vscode',
]);

const DEFAULT_NESTED_SKILLS_SCAN_DEPTH = 4;
const MAX_NESTED_SKILLS_SCAN_DIRS = 400;

function findNestedSkillsDirectories(rootDir: string, maxDepth = DEFAULT_NESTED_SKILLS_SCAN_DEPTH): string[] {
	const found: string[] = [];
	const visited = new Set<string>();
	let scannedDirs = 0;

	const walk = (currentDir: string, depth: number): void => {
		if (depth > maxDepth || visited.has(currentDir) || scannedDirs >= MAX_NESTED_SKILLS_SCAN_DIRS) { return; }
		visited.add(currentDir);
		scannedDirs++;

		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(currentDir, { withFileTypes: true });
		} catch {
			return;
		}

		for (const entry of entries) {
			if (!entry.isDirectory()) { continue; }
			if (SKILL_DIR_SCAN_EXCLUDES.has(entry.name)) { continue; }
			const child = path.join(currentDir, entry.name);
			if (entry.name === 'skills') {
				found.push(child);
				continue;
			}
			walk(child, depth + 1);
		}
	};

	walk(rootDir, 0);
	return found;
}

function collectSkillsFromRoot(relativeTo: string, rootDir: string, seenPaths: Set<string>): AvailableToolEntry[] {
	if (!fs.existsSync(rootDir)) { return []; }

	const entries: AvailableToolEntry[] = [];
	entries.push(...collectSkillsFromDirectory(relativeTo, rootDir, seenPaths));

	for (const skillsDir of findNestedSkillsDirectories(rootDir)) {
		entries.push(...collectSkillsFromDirectory(relativeTo, skillsDir, seenPaths));
	}

	return entries;
}

function resolveSkillPath(rawPath: string, home: string): string {
	let resolved = rawPath.trim();
	if (!resolved) { return ''; }

	if (resolved.startsWith('~')) {
		if (resolved === '~') {
			resolved = home;
		} else if (resolved.startsWith('~/') || resolved.startsWith('~\\')) {
			resolved = path.join(home, resolved.slice(2));
		}
	}

	resolved = resolved.replace(/\$\{env:([^}]+)\}/gi, (_m, varName: string) => process.env[varName] ?? '');
	resolved = resolved.replace(/%([^%]+)%/g, (_m, varName: string) => process.env[varName] ?? '');

	if (!path.isAbsolute(resolved)) {
		resolved = path.resolve(home, resolved);
	}

	return resolved;
}

function getVsCodeSettingsFiles(home: string): string[] {
	const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
	const isWindows = process.platform === 'win32';

	if (isWindows) {
		return [
			path.join(appData, 'Code', 'User', 'settings.json'),
			path.join(appData, 'Code - Insiders', 'User', 'settings.json'),
		];
	}

	if (process.platform === 'darwin') {
		return [
			path.join(home, 'Library', 'Application Support', 'Code', 'User', 'settings.json'),
			path.join(home, 'Library', 'Application Support', 'Code - Insiders', 'User', 'settings.json'),
		];
	}

	return [
		path.join(home, '.config', 'Code', 'User', 'settings.json'),
		path.join(home, '.config', 'Code - Insiders', 'User', 'settings.json'),
	];
}

function getConfiguredAgentSkillLocations(home: string): string[] {
	const locations = new Set<string>();

	for (const settingsFile of getVsCodeSettingsFiles(home)) {
		const parsed = readJsonFile(settingsFile) as { [key: string]: unknown } | undefined;
		const raw = parsed?.['chat.agentSkillsLocations'];
		if (!Array.isArray(raw)) { continue; }
		for (const item of raw) {
			if (typeof item !== 'string') { continue; }
			const resolved = resolveSkillPath(item, home);
			if (resolved) { locations.add(resolved); }
		}
	}

	return [...locations];
}

/**
 * Workspace-relative skill directory names checked by VS Code and Visual Studio.
 *
 * VS Code / GitHub Copilot:  `.github/skills/`
 * Visual Studio (also):      `.claude/skills/`, `.agents/skills/`
 */
const WORKSPACE_SKILL_DIRS = ['.github/skills', '.claude/skills', '.agents/skills'];

/**
 * User-level skill directories (Visual Studio: `~/.copilot/skills/`, `~/.claude/skills/`, `~/.agents/skills/`).
 * Returns an empty array when the HOME/USERPROFILE env var is not set.
 */
function userSkillDirs(): string[] {
	const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
	if (!home) { return []; }
	return [
		path.join(home, '.copilot', 'skills'),
		path.join(home, '.claude', 'skills'),
		path.join(home, '.agents', 'skills'),
	];
}

/**
 * Decode a `file://` URI (as stored in `installed.json`) to a local filesystem
 * path.  Returns `undefined` if the URI is malformed or not a `file:` URI.
 */
function fileUriToPath(uri: string): string | undefined {
	try {
		const url = new URL(uri);
		if (url.protocol !== 'file:') { return undefined; }
		return path.normalize(fileURLToPath(url));
	} catch {
		return undefined;
	}
}

/**
 * Given a plugin directory, read `plugin.json` and return the resolved
 * absolute paths of all declared `"skills"` entries.  Falls back to
 * `./skills/` when the key is absent.
 */
function resolvePluginSkillDirs(pluginDir: string): string[] {
	const pluginJson = readJsonFile(path.join(pluginDir, 'plugin.json')) as { skills?: unknown } | undefined;

	let declaredSkills: string[];
	if (Array.isArray(pluginJson?.skills)) {
		declaredSkills = (pluginJson.skills as unknown[]).filter((s): s is string => typeof s === 'string');
	} else if (typeof pluginJson?.skills === 'string') {
		declaredSkills = [pluginJson.skills];
	} else {
		declaredSkills = ['./skills/'];
	}

	return declaredSkills
		.map(s => path.resolve(pluginDir, s))
		.filter(p => fs.existsSync(p));
}

/**
 * Read `installed.json` from an `agent-plugins` home directory and resolve the
 * declared `"skills"` paths from each plugin's `plugin.json`, mirroring the
 * VS Code loading behaviour.
 *
 * VS Code does NOT scan the entire cloned repo.  It reads `installed.json` to
 * find which plugin directories are installed, then reads each plugin's
 * `plugin.json` to find the `"skills"` array, and only scans those declared
 * sub-directories.  This function replicates that logic so we only report
 * skills that are actually loaded.
 */
function resolveInstalledPluginSkillDirs(agentPluginsHome: string): { dir: string; pluginName: string }[] {
	const installedJson = readJsonFile(path.join(agentPluginsHome, 'installed.json')) as { installed?: unknown[] } | undefined;
	if (!Array.isArray(installedJson?.installed)) { return []; }

	const results: { dir: string; pluginName: string }[] = [];
	for (const entry of installedJson.installed) {
		if (typeof entry !== 'object' || entry === null) { continue; }
		const rec = entry as Record<string, unknown>;
		const pluginUriStr = rec['pluginUri'];
		if (typeof pluginUriStr !== 'string') { continue; }
		const pluginDir = fileUriToPath(pluginUriStr);
		if (!pluginDir || !fs.existsSync(pluginDir)) { continue; }
		const pluginName = typeof rec['name'] === 'string' && rec['name'] ? rec['name'] : path.basename(pluginDir);
		for (const dir of resolvePluginSkillDirs(pluginDir)) {
			results.push({ dir, pluginName });
		}
	}
	return results;
}

function userAgentPluginSkillDirs(): { dir: string; pluginName: string }[] {
	const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
	if (!home) { return []; }
	const pluginHomes = [
		path.join(home, '.vscode', 'agent-plugins'),
		path.join(home, '.vscode-insiders', 'agent-plugins'),
	];
	const results: { dir: string; pluginName: string }[] = [];
	for (const pluginHome of pluginHomes) {
		results.push(...resolveInstalledPluginSkillDirs(pluginHome));
	}
	return results;
}

/**
 * Scan workspace folders and user-level directories for skill files
 * (`SKILL.md`) and return them as `AvailableToolEntry` objects.
 *
 * Workspace locations (relative to each workspace folder):
 *   `.github/skills/`  (VS Code, Visual Studio)
 *   `.claude/skills/`  (Visual Studio)
 *   `.agents/skills/`  (Visual Studio)
 *
 * User-level locations:
 *   `~/.copilot/skills/`  (Visual Studio)
 *   `~/.claude/skills/`   (Visual Studio)
 *   `~/.agents/skills/`   (Visual Studio)
 */
export function discoverSkillEntries(
	workspaceFolderPaths: string[],
	options?: { additionalSkillDirs?: string[] },
): AvailableToolEntry[] {
	const entries: AvailableToolEntry[] = [];
	const seenPaths = new Set<string>();

	// Workspace-scoped skill directories
	for (const folder of workspaceFolderPaths) {
		for (const relDir of WORKSPACE_SKILL_DIRS) {
			const skillsDir = path.join(folder, ...relDir.split('/'));
			if (!fs.existsSync(skillsDir)) { continue; }
			entries.push(...collectSkillsFromDirectory(folder, skillsDir, seenPaths));
		}
	}

	// User-scoped skill directories (not tied to any workspace folder)
	const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
	for (const skillsDir of userSkillDirs()) {
		entries.push(...collectSkillsFromRoot(home, skillsDir, seenPaths));
	}

	// VS Code agent-plugin skill directories — resolved by reading installed.json
	// and each plugin's plugin.json, matching VS Code's actual loading behaviour.
	// This ensures we only report skills that are genuinely loaded into sessions,
	// not every SKILL.md that happens to exist in a cloned plugin repository.
	for (const { dir, pluginName } of userAgentPluginSkillDirs()) {
		entries.push(...collectSkillsFromDirectory(home, dir, seenPaths, pluginName));
	}

	// chat.agentSkillsLocations from VS Code stable/insiders settings + extension-provided paths.
	const optionDirs = Array.isArray(options?.additionalSkillDirs)
		? options.additionalSkillDirs
		: [];
	const configuredDirs = [
		...getConfiguredAgentSkillLocations(home),
		...optionDirs
			.filter((dir): dir is string => typeof dir === 'string')
			.map(dir => resolveSkillPath(dir, home))
			.filter(Boolean),
	];
	for (const configuredDir of configuredDirs) {
		entries.push(...collectSkillsFromRoot(home, configuredDir, seenPaths));
	}

	return entries;
}

/**
 * Look up one skill's description directly in a set of candidate workspace folders,
 * without a full `discoverSkillEntries()` scan.
 *
 * Skill *usage* is aggregated from session history across every workspace a skill was
 * ever invoked from, but `discoverSkillEntries()` only sees the workspace folder(s)
 * currently open in the editor — so a skill invoked from a repo that isn't open right
 * now would otherwise show no description even though its SKILL.md still exists on disk.
 * This does a handful of direct file-existence checks (no directory scanning) against
 * each candidate workspace's known skill-dir conventions, so it's cheap enough to call
 * per-skill as a targeted fallback.
 */
export function findSkillDescriptionInWorkspaces(skillName: string, workspaceFolderPaths: Iterable<string>): string | undefined {
	for (const folder of workspaceFolderPaths) {
		for (const relDir of WORKSPACE_SKILL_DIRS) {
			const skillMdPath = path.join(folder, ...relDir.split('/'), skillName, 'SKILL.md');
			try {
				if (!fs.existsSync(skillMdPath)) { continue; }
				const desc = extractDescriptionFromSkillContent(fs.readFileSync(skillMdPath, 'utf-8'));
				if (desc) { return desc; }
			} catch {
				// try the next candidate
			}
		}
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Core curation analysis
// ---------------------------------------------------------------------------

/**
 * Estimate the number of prompt tokens consumed per interaction by a set of
 * tool descriptions. Uses a simple characters-per-token approximation.
 */
function estimateDescriptionTokens(tools: AvailableToolEntry[]): number {
	return Math.round(
		tools.reduce((sum, t) => sum + (t.name.length + t.description.length + 10), 0) / CHARS_PER_TOKEN
	);
}

function buildUsedCounts(usagePeriod: UsageAnalysisPeriod): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const [tool, count] of Object.entries(usagePeriod.toolCalls.byTool)) {
		counts[tool] = (counts[tool] ?? 0) + count;
	}
	for (const [tool, count] of Object.entries(usagePeriod.mcpTools.byTool)) {
		counts[tool] = (counts[tool] ?? 0) + count;
	}
	// Skills are invoked behind a generic wrapper tool call on some editors (e.g. Claude
	// Code's "Skill" tool), so the real skill name only ever shows up here, never in
	// toolCalls.byTool. Without this, every discovered skill looks permanently unused.
	for (const [name, count] of Object.entries(usagePeriod.skillCalls?.byName ?? {})) {
		counts[name] = (counts[name] ?? 0) + count;
	}
	return counts;
}

function computeUnderusedMcpServers(
	availableTools: AvailableToolEntry[],
	usedNames: Set<string>,
	usagePeriod: UsageAnalysisPeriod,
): { server: string; availableToolCount: number; usedToolCount: number; configFiles?: string[]; extensionId?: string; enabled?: boolean; extensionActive?: boolean }[] {
	const mcpServers = new Set<string>();
	for (const t of availableTools) {
		if (t.source === 'mcp' && t.server) { mcpServers.add(t.server); }
	}
	return Array.from(mcpServers).map(server => {
		const serverTools = availableTools.filter(t => t.source === 'mcp' && t.server === server);
		// For stub entries (created from mcp.json where name === `mcp__${server}`), `usedNames`
		// contains full tool names like `mcp__server__toolname`, so an exact match will never
		// fire.  Fall back to server-level usage count from `byServer` for these stubs.
		const usedServerTools = serverTools.filter(t => {
			const isStub = t.name === `mcp__${server}`;
			if (isStub) {
				return (usagePeriod.mcpTools.byServer[server] ?? 0) >= MCP_SERVER_USE_THRESHOLD;
			}
			return usedNames.has(t.name);
		});
		// Collect all distinct config files across all entries for this server
		const configFiles = [...new Set(serverTools.flatMap(t => t.configFiles ?? []))];
		// Pick up extensionId / enabled / extensionActive if any entry for this server was contributed by an extension
		const extEntry = serverTools.find(t => t.extensionId);
		const extensionId = extEntry?.extensionId;
		const enabled = extEntry?.enabled;
		const extensionActive = extEntry?.extensionActive;
		return {
			server,
			availableToolCount: serverTools.length,
			usedToolCount: usedServerTools.length,
			configFiles: configFiles.length > 0 ? configFiles : undefined,
			extensionId,
			enabled,
			extensionActive,
		};
	})
	// Keep disabled extension servers out (they consume no prompt budget).
	// Fully-used servers are still included so the UI can show them with the toggle.
	.filter(s => s.enabled !== false);
}

function buildBloatEstimate(
	unusedTools: AvailableToolEntry[],
): { totalTokens: number; byServer: Record<string, number> } {
	const unusedByServer: Record<string, AvailableToolEntry[]> = {};
	for (const t of unusedTools) {
		const key = t.server ?? t.source;
		if (!unusedByServer[key]) { unusedByServer[key] = []; }
		unusedByServer[key].push(t);
	}
	const byServer: Record<string, number> = {};
	for (const [key, tools] of Object.entries(unusedByServer)) {
		byServer[key] = estimateDescriptionTokens(tools);
	}
	return { totalTokens: Object.values(byServer).reduce((s, n) => s + n, 0), byServer };
}

function buildCurationRecommendations(
	underusedMcpServers: { server: string; availableToolCount: number; usedToolCount: number }[],
	unusedTools: AvailableToolEntry[],
	windowDays: number,
): ToolCurationRecommendation[] {
	const recs: ToolCurationRecommendation[] = [];
	for (const s of underusedMcpServers) {
		if (s.usedToolCount === 0) {
			const serverUnused = unusedTools.filter(t => t.source === 'mcp' && t.server === s.server);
			recs.push({
				type: 'disable-mcp-server',
				target: s.server,
				reason: `No tools from the "${s.server}" MCP server were used in the last ${windowDays} days.`,
				estimatedTokenSavings: estimateDescriptionTokens(serverUnused),
			});
		}
	}
	for (const skill of unusedTools.filter(t => t.source === 'skill')) {
		recs.push({
			type: 'refine-skill',
			target: skill.name,
			reason: `The "${skill.name}" skill was not invoked in the last ${windowDays} days. Consider updating its description or removing it to reduce instruction-file bloat.`,
		});
	}
	return recs;
}

function computeUnderusedAgentPlugins(
	availableTools: AvailableToolEntry[],
	usedNames: Set<string>,
): ToolCurationAnalysis['underusedAgentPlugins'] {
	const pluginNamesBySkill = new Map<string, Set<string>>();
	for (const t of availableTools) {
		if (t.source !== 'skill' || !t.pluginName) { continue; }
		const pluginNames = pluginNamesBySkill.get(t.name) ?? new Set<string>();
		pluginNames.add(t.pluginName);
		pluginNamesBySkill.set(t.name, pluginNames);
	}

	const pluginMap = new Map<string, { available: number; used: number }>();
	for (const t of availableTools) {
		if (t.source !== 'skill' || !t.pluginName) { continue; }
		const rec = pluginMap.get(t.pluginName) ?? { available: 0, used: 0 };
		rec.available++;
		// Skill usage telemetry is keyed by skill name only. When multiple plugins share
		// the same name we conservatively avoid attributing that usage to a specific plugin.
		if (usedNames.has(t.name) && (pluginNamesBySkill.get(t.name)?.size ?? 0) === 1) {
			rec.used++;
		}
		pluginMap.set(t.pluginName, rec);
	}
	return Array.from(pluginMap.entries())
		.map(([pluginName, { available, used }]) => ({ pluginName, availableSkillCount: available, usedSkillCount: used }))
		.sort((a, b) => a.usedSkillCount - b.usedSkillCount);
}

/**
 * @param availableTools  - Tools visible in the current environment (runtime + mcp.json + skills).
 * @param usagePeriod     - Aggregated usage from the look-back window (use `last30Days` or custom).
 * @param windowDays      - Look-back window used to label the result (informational only).
 */
export function analyzeToolCuration(
	availableTools: AvailableToolEntry[],
	usagePeriod: UsageAnalysisPeriod,
	windowDays: number,
): ToolCurationAnalysis {
	const usedCounts = buildUsedCounts(usagePeriod);
	const usedToolsArray = Object.entries(usedCounts)
		.map(([name, count]) => ({ name, count }))
		.sort((a, b) => b.count - a.count);
	const usedNames = new Set(Object.keys(usedCounts));

	const unusedTools = availableTools.filter(t => {
		if (t.source === 'skill') {
			// Skills are discovered by directory name; use exact match against the set of
			// invoked tool names so that short names like "pdf" don't false-match unrelated tools.
			return !usedNames.has(t.name);
		}
		if (t.source === 'mcp' && t.server) {
			// Disabled extension-contributed servers don't consume prompt budget — don't count
			// them as "unused" or include them in bloat estimates.
			if (t.enabled === false) { return false; }
			// Stub entries (name === `mcp__<server>`) represent the whole server — use server-level count.
			// Per-tool entries (name === `mcp__<server>__<tool>`) support exact per-tool matching.
			const isStub = t.name === `mcp__${t.server}`;
			if (isStub) {
				return (usagePeriod.mcpTools.byServer[t.server] ?? 0) < MCP_SERVER_USE_THRESHOLD;
			}
			return !usedNames.has(t.name);
		}
		return !usedNames.has(t.name);
	});

	const underusedMcpServers = computeUnderusedMcpServers(availableTools, usedNames, usagePeriod);
	const underusedAgentPlugins = computeUnderusedAgentPlugins(availableTools, usedNames);
	const estimatedPromptBloat = buildBloatEstimate(unusedTools);
	const recommendations = buildCurationRecommendations(underusedMcpServers, unusedTools, windowDays);

	return {
		windowDays,
		availableTools,
		usedTools: usedToolsArray,
		unusedTools,
		underusedMcpServers,
		underusedAgentPlugins,
		estimatedPromptBloat,
		recommendations,
	};
}

// ---------------------------------------------------------------------------
// Assembly shared by every host (extension, CLI, desktop)
// ---------------------------------------------------------------------------

/**
 * The tool sources a host gathered. Only the extension can enumerate `runtime` tools
 * (`vscode.lm.tools`), extension-contributed and settings-configured MCP servers; the
 * CLI and desktop app pass what they can read from disk and leave the rest out.
 */
export interface AvailableToolSources {
	runtime?: AvailableToolEntry[];
	mcpJson?: AvailableToolEntry[];
	extensionMcp?: AvailableToolEntry[];
	settingsMcp?: AvailableToolEntry[];
	skills?: AvailableToolEntry[];
}

/**
 * Merges the gathered sources into one available-tool list. An MCP server is listed once,
 * from the most authoritative source that has it: runtime, then mcp.json, then
 * extension-contributed, then settings.
 */
export function mergeAvailableToolEntries(sources: AvailableToolSources): AvailableToolEntry[] {
	const runtime = sources.runtime ?? [];
	const claimed = new Set(runtime.filter(e => e.source === 'mcp').map(e => e.server));
	const unclaimed = (entries: AvailableToolEntry[] | undefined): AvailableToolEntry[] => {
		const kept = (entries ?? []).filter(e => !claimed.has(e.server));
		for (const e of kept) { claimed.add(e.server); }
		return kept;
	};
	const mcpJson = unclaimed(sources.mcpJson);
	const extensionMcp = unclaimed(sources.extensionMcp);
	const settingsMcp = unclaimed(sources.settingsMcp);
	return [...runtime, ...mcpJson, ...extensionMcp, ...settingsMcp, ...(sources.skills ?? [])];
}

/**
 * The Usage Analysis view's `curationAnalysis`: the merged sources analysed against the
 * window's usage, or `null` when the host found no tools to analyse.
 */
export function buildCurationAnalysis(
	sources: AvailableToolSources,
	usagePeriod: UsageAnalysisPeriod,
	windowDays: number,
): ToolCurationAnalysis | null {
	const availableTools = mergeAvailableToolEntries(sources);
	return availableTools.length > 0 ? analyzeToolCuration(availableTools, usagePeriod, windowDays) : null;
}
