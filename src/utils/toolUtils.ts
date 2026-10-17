/**
 * Utility helpers for resolving tool display names.
 * Handles pattern-based matching for tool IDs that cannot be listed exhaustively,
 * such as GUID-keyed MCP server registrations.
 */

/**
 * Check if a tool name indicates it's an MCP (Model Context Protocol) tool.
 * MCP tools are identified by names starting with "mcp." or "mcp_";
 * Claude Code uses the double-underscore format "mcp__server__tool".
 * Lives here (not in workspaceHelpers) so webview bundles can use it without
 * pulling in the `vscode` module.
 */
export function isMcpTool(toolName: string): boolean {
	return toolName.startsWith('mcp.') || toolName.startsWith('mcp_') || toolName.startsWith('mcp__');
}

/**
 * Matches Claude MCP tools registered under a tenant GUID, e.g.
 *   mcp__e292a297-0140-4fb7-a4de-39bd4e3f0fd6__sharepoint_search
 * The GUID is a tenant-specific server identifier (e.g. Microsoft 365 Connector).
 */
const GUID_MCP_PATTERN = /^mcp__[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}__(.+)$/i;

function toTitleCase(s: string): string {
	return s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Resolve a GUID-based MCP tool name to a friendly display name.
 * Returns `undefined` when the ID does not match the GUID MCP pattern.
 *
 * Example:
 *   `mcp__e292a297-0140-4fb7-a4de-39bd4e3f0fd6__sharepoint_search`
 *   → `"Claude MCP: M365 Connector - Sharepoint Search"`
 */
export function resolveGuidMcpToolName(id: string): string | undefined {
	const match = GUID_MCP_PATTERN.exec(id);
	if (!match) { return undefined; }
	return `Claude MCP: M365 Connector - ${toTitleCase(match[1])}`;
}

/**
 * Returns `true` when a tool ID uses the GUID-keyed MCP server pattern.
 * Used to exclude these tools from the "unknown tools" list, since they are
 * handled by the regex resolver above rather than by an entry in toolNames.json.
 */
export function isGuidMcpTool(id: string): boolean {
	return GUID_MCP_PATTERN.test(id);
}

/**
 * Known third-party MCP tool families. Each MCP client/host mints its own
 * server-id segment for the *same* upstream server (e.g. VS Code truncates a
 * user-configured server name to 13 chars, Claude Code uses the literal
 * package/plugin id, a remote-vs-local registration gets a different name
 * entirely) — so the raw tool ID's prefix is effectively unbounded, while the
 * upstream server's actual tool/action names are a small, stable set.
 *
 * Rather than enumerate every prefix spelling in toolNames.json (which grows
 * forever as new hosts/configs appear — see issue #1760), we recognize a tool
 * by (a) a family keyword appearing anywhere in the id and (b) the id ending
 * in one of that family's known action names.
 */
interface McpToolFamily {
	/** Prefix used in the synthesized friendly name, e.g. "GitHub MCP". */
	displayName: string;
	/** Lowercase substrings that must appear in the normalized id. */
	keywords: string[];
	/** Known action/tool-name suffixes exposed by the upstream MCP server. */
	actions: Set<string>;
}

const MCP_TOOL_FAMILIES: McpToolFamily[] = [
	{
		displayName: 'GitHub MCP',
		keywords: ['github'],
		actions: new Set([
			'actions_list', 'add_comment_to_pending_review', 'add_issue_comment',
			'add_reply_to_pull_request_comment', 'assign_copilot_to_issue',
			'create_or_update_file', 'create_pull_request', 'create_repository',
			'get_commit', 'get_file_contents', 'get_job_logs', 'get_label', 'get_latest_release',
			'get_me', 'get_release_by_tag', 'get_repository_tree', 'get_tag',
			'issue_read', 'issue_write', 'label_write', 'list_branches',
			'list_code_scanning_alerts', 'list_commits', 'list_issue_fields',
			'list_issue_types', 'list_issues', 'list_label', 'list_pull_requests',
			'list_tags', 'projects_list', 'pull_request_read',
			'pull_request_review_write', 'request_copilot_review', 'search_code',
			'search_issues', 'search_pull_requests', 'search_repositories',
			'search_users', 'semantic_issue_similarity_search',
			'semantic_issues_search', 'sub_issue_write', 'update_pull_request',
		]),
	},
	{
		displayName: 'Playwright MCP',
		keywords: ['playwright'],
		actions: new Set([
			'browser_click', 'browser_close', 'browser_console_messages',
			'browser_evaluate', 'browser_fill_form', 'browser_find', 'browser_hover',
			'browser_install', 'browser_navigate', 'browser_network_request',
			'browser_network_requests', 'browser_press_key', 'browser_resize',
			'browser_run_code', 'browser_run_code_unsafe', 'browser_snapshot',
			'browser_tabs', 'browser_take_screenshot', 'browser_type', 'browser_wait_for',
		]),
	},
	{
		displayName: 'Context7 MCP',
		keywords: ['context7'],
		actions: new Set(['get_library_docs', 'query_docs', 'resolve_library_id']),
	},
	{
		displayName: 'Tavily MCP',
		keywords: ['tavily'],
		actions: new Set(['tavily_crawl', 'tavily_extract', 'tavily_research', 'tavily_search', 'crawl', 'extract', 'research', 'search']),
	},
	{
		displayName: 'Microsoft Docs MCP',
		keywords: ['microsoft_doc', 'microsoftdocs', 'microsoft_learn'],
		actions: new Set(['docs_fetch', 'docs_search', 'code_sample_search']),
	},
	{
		displayName: 'Claude Browser MCP',
		keywords: ['claude_browser', 'claude_in_chrome'],
		actions: new Set([
			'computer', 'find', 'get_page_text', 'javascript_tool', 'navigate',
			'preview_list', 'preview_logs', 'preview_start', 'preview_stop',
			'read_console_messages', 'read_network_requests', 'read_page',
			'resize_window', 'tabs_close', 'tabs_context', 'tabs_create', 'tabs_select',
		]),
	},
];

/** Lowercases and folds `.`/`-` separators to `_` so prefix/action matching is separator-agnostic. */
function normalizeMcpId(id: string): string {
	return id.toLowerCase().replace(/[.-]/g, '_');
}

/**
 * Resolve a tool ID to a friendly name by recognizing a known MCP tool family
 * (from a keyword anywhere in the id) plus a known action name (as the id's
 * suffix), regardless of the server-registration prefix in between.
 *
 * Returns `undefined` when the id doesn't match any known family+action pair,
 * so callers can fall back to an exact toolNames.json entry or the raw id.
 */
export function resolveMcpFamilyToolName(id: string): string | undefined {
	const normalized = normalizeMcpId(id);
	for (const family of MCP_TOOL_FAMILIES) {
		if (!family.keywords.some(keyword => normalized.includes(keyword))) { continue; }
		for (const action of family.actions) {
			if (normalized === action || normalized.endsWith(`_${action}`)) {
				return `${family.displayName}: ${toTitleCase(action)}`;
			}
		}
	}
	return undefined;
}

/**
 * Returns `true` when a tool ID resolves via a known MCP family+action pair.
 * Used to exclude these tools from the "unknown tools" list — a new
 * server-registration spelling for a tool we already recognize shouldn't
 * generate another "add missing friendly name" report.
 */
export function isMcpFamilyResolvedTool(id: string): boolean {
	return resolveMcpFamilyToolName(id) !== undefined;
}

/**
 * Insert underscores at camelCase/PascalCase word boundaries, e.g.
 * "ListAgents" -> "List_Agents" and "HTTPServer" -> "HTTP_Server".
 *
 * Different hosts report the same underlying tool under different naming
 * conventions — one client's `ListAgents` is another's `list_agents` (see
 * issue #1942) — so splitting camelCase before lowercasing/folding
 * separators lets `canonicalizeToolId` treat both spellings as the same id.
 *
 * Mirrors `_camel_to_snake()` in `.github/scripts/toolnames_utils.py`.
 * Keep the two in sync if either changes.
 */
function camelToSnake(value: string): string {
	return value
		.replace(/(?<=[a-z0-9])(?=[A-Z])/g, '_')
		.replace(/(?<=[A-Z])(?=[A-Z][a-z])/g, '_');
}

/**
 * Server-registration prefixes that different hosts use for the same MCP
 * server, mapped to one canonical prefix. Longest/most specific first — the
 * first match wins. This lets e.g. `mcp__Claude_Browser__browser_batch` resolve
 * to the existing `mcp__claude-in-chrome__browser_batch` entry (issue #2223).
 *
 * Mirrors `_CANONICAL_PREFIX_RULES` in `.github/scripts/toolnames_utils.py`,
 * which the "Toolnames Checkup" issue comment uses to report equivalent
 * entries. Keep the two in sync if either changes.
 */
const CANONICAL_PREFIX_RULES: ReadonlyArray<readonly [string, string]> = [
	// GitHub MCP server registrations (local stdio, remote, GitHub-official server)
	['mcp.io.github.git.', 'github_'],
	['mcp_io_github_git_', 'github_'],
	['mcp.github.github.', 'github_'],
	['mcp_github_github_', 'github_'],
	['github-mcp-server-', 'github_'],
	['mcp_github_mcp_s2_', 'github_'],
	['mcp_github_mcp_se_', 'github_'],
	// Context7 / UPS docs
	['mcp__plugin_context7_context7__', 'context7_'],
	['mcp__context7__', 'context7_'],
	['mcp_context7_', 'context7_'],
	['mcp_io_github_ups_', 'context7_'],
	['context7-', 'context7_'],
	// Playwright MCP
	['mcp__microsoft_playwright-mcp__', 'playwright_'],
	['microsoft_playwright-mcp-', 'playwright_'],
	['mcp__playwright__', 'playwright_'],
	['mcp_playwright_', 'playwright_'],
	['mcp_microsoft_pla_', 'playwright_'],
	// Tavily MCP
	['io_github_tavily-ai_tavily-mcp-', 'tavily_'],
	['mcp_tavily-mcp_', 'tavily_'],
	['mcp_tavily_', 'tavily_'],
	// Claude Browser MCP
	['mcp__claude-in-chrome__', 'claude_browser_'],
	['mcp__claude_browser__', 'claude_browser_'],
];

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Also matches numeric-suffixed collision variants: some hosts append a digit
 * to a server's registered name on a naming collision (e.g. "context7" and
 * "context73"). Mirrors `_compile_prefix_pattern()` in toolnames_utils.py.
 */
const CANONICAL_PREFIX_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = CANONICAL_PREFIX_RULES.map(
	([prefix, replacement]) => [
		new RegExp(`^${escapeRegExp(prefix.slice(0, -1))}\\d*${escapeRegExp(prefix.slice(-1))}`),
		replacement,
	] as const,
);

function foldToolId(value: string): string {
	return camelToSnake(value).toLowerCase().replace(/[.-]/g, '_');
}

/**
 * Canonical form of a tool ID for equivalence comparisons: known MCP server
 * prefixes collapsed to one canonical prefix, then camelCase-split,
 * lowercased, and `.`/`-` folded to `_`.
 *
 * Mirrors `canonicalize_tool_id()` in `.github/scripts/toolnames_utils.py`.
 */
export function canonicalizeToolId(id: string): string {
	const lowered = id.toLowerCase();
	for (const [pattern, replacement] of CANONICAL_PREFIX_PATTERNS) {
		const match = pattern.exec(lowered);
		if (match) {
			return replacement + foldToolId(id.slice(match[0].length));
		}
	}
	return foldToolId(id);
}

/** Canonical-key index per tool-name map, so lookups don't re-canonicalize every key each call. */
const canonicalIndexCache = new WeakMap<Record<string, string>, Map<string, string>>();

function getCanonicalIndex(toolNameMap: Record<string, string>): Map<string, string> {
	let index = canonicalIndexCache.get(toolNameMap);
	if (!index) {
		index = new Map();
		for (const [key, value] of Object.entries(toolNameMap)) {
			const canonical = canonicalizeToolId(key);
			if (!index.has(canonical)) { index.set(canonical, value); }
		}
		canonicalIndexCache.set(toolNameMap, index);
	}
	return index;
}

/** Friendly-name index per tool-name map: every display name, and its server part before `:`. */
const displayNameCache = new WeakMap<Record<string, string>, Set<string>>();

/**
 * Returns `true` when `name` is already a friendly display name from the map —
 * either a full value or the server part of one (the text before `:`).
 *
 * The "By Server" MCP tables key their rows on the server name that
 * `extractMcpServerName` derives from a tool's friendly name (e.g.
 * "CCD Session" from "CCD Session: Mark Chapter"), so those keys are already
 * friendly and must not be reported as tools missing a friendly name
 * (issue #2223).
 */
export function isKnownToolDisplayName(name: string, toolNameMap: Record<string, string>): boolean {
	let names = displayNameCache.get(toolNameMap);
	if (!names) {
		names = new Set();
		for (const value of Object.values(toolNameMap)) {
			if (typeof value !== 'string') { continue; }
			names.add(value.trim());
			const colonIdx = value.indexOf(':');
			if (colonIdx !== -1) { names.add(value.slice(0, colonIdx).trim()); }
		}
		displayNameCache.set(toolNameMap, names);
	}
	return names.has(name.trim());
}

/**
 * Look up a tool ID's friendly name in a toolNames.json-shaped map, trying
 * progressively looser matches: exact key, case-insensitive key, then a
 * canonicalized (MCP-prefix/camelCase/separator-normalized) key. The canonical
 * fallback recognizes e.g. `ListAgents` as the same tool as an existing
 * `list_agents` entry (issue #1942), and `mcp__Claude_Browser__browser_batch`
 * as the existing `mcp__claude-in-chrome__browser_batch` entry (issue #2223),
 * without needing a duplicate entry for every variant a host might use.
 *
 * Returns `undefined` when none of those match, so callers can fall back to
 * GUID/MCP-family resolution or flag the tool as unknown.
 */
export function lookupKnownToolName(id: string, toolNameMap: Record<string, string>): string | undefined {
	if (toolNameMap[id]) { return toolNameMap[id]; }
	const lower = id.toLowerCase();
	if (toolNameMap[lower]) { return toolNameMap[lower]; }
	return getCanonicalIndex(toolNameMap).get(canonicalizeToolId(id));
}
