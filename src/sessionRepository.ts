/**
 * The git remote a session worked in, derived from the files it referenced.
 *
 * Shared by the VS Code extension's session details analyzer (which reads the same references
 * while it walks a session for other details) and the CLI, which has no adapter metadata for
 * VS Code `chatSessions` files and needs the remote for workspace grouping parity
 * (src/workspaceGrouping.ts) and the Chart's "By Repository" split (#2316). One definition of
 * "what counts as a content reference" keeps the two surfaces from drifting apart.
 */
import * as fs from 'fs';

import { findWorkspacePathForDiscoveredPath, type IEcosystemAdapter } from './ecosystemAdapter';
import { isJsonlContent, isUuidPointerFile, reconstructJsonlStateAsync } from './tokenEstimation';
import {
	extractRepositoryFromContentReferences,
	findRepositoryRemoteForFolder,
	getRepoNameFromWorkspacePath,
	resolveWorkspaceFolderWithFallback,
} from './workspaceHelpers';

type ContentReferences = Parameters<typeof extractRepositoryFromContentReferences>[0];

/** A VS Code chat request's own content references (attached files, symbols). */
export function requestContentReferences(request: unknown): ContentReferences {
	const refs = (request as { contentReferences?: unknown } | null | undefined)?.contentReferences;
	return Array.isArray(refs) ? refs : [];
}

/**
 * Path-like arguments of a Copilot CLI `tool.execution_start` event, as content references:
 * the CLI log has no attachment list, so the files its tools touched stand in for one.
 */
export function toolArgumentPathReferences(args: unknown): ContentReferences {
	if (!args || typeof args !== 'object') { return []; }
	const refs: ContentReferences = [];
	for (const val of Object.values(args as Record<string, unknown>)) {
		if (typeof val === 'string' && val.length > 3 && (val.includes('/') || val.includes('\\'))) {
			refs.push({ kind: 'reference', reference: { fsPath: val } });
		}
	}
	return refs;
}

/** A session title from its first user message, as the extension's metadata scan shortens it. */
function titleFromFirstMessage(message: string): string {
	const trimmed = message.trim();
	return trimmed.length > 60 ? trimmed.slice(0, 60) + '…' : trimmed;
}

/**
 * References and title of a Copilot CLI events log, one parse per line. The title follows the
 * extension's metadata scan: the last `rename_session` title, else the first user message.
 */
function scanCliEvents(lines: string[]): { refs: ContentReferences; title?: string } {
	const refs: ContentReferences = [];
	let renamed: string | undefined;
	let firstMessage: string | undefined;
	for (const line of lines) {
		const event = parseCliEvent(line);
		if (!event) { continue; }
		refs.push(...(event.type === 'tool.execution_start' ? toolArgumentPathReferences(event.data?.arguments) : []));
		renamed = renameSessionTitle(event) ?? renamed;
		if (firstMessage === undefined && event.type === 'user.message') { firstMessage = nonEmptyString(event.data?.content); }
	}
	const title = renamed ?? (firstMessage ? titleFromFirstMessage(firstMessage) : undefined);
	return title ? { refs, title } : { refs };
}

type CliEvent = { type?: unknown; data?: { toolName?: unknown; arguments?: { title?: unknown }; content?: unknown } };

function parseCliEvent(line: string): CliEvent | undefined {
	try { return JSON.parse(line) as CliEvent; } catch { return undefined; }
}

/** The title a `rename_session` tool call sets, as the extension's metadata scan reads it. */
function renameSessionTitle(event: CliEvent): string | undefined {
	return event.type === 'tool.execution_start' && event.data?.toolName === 'rename_session'
		? nonEmptyString(event.data.arguments?.title)
		: undefined;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === 'string' && value ? value : undefined;
}

/**
 * Every content reference in a session file's content, and its custom title when it records one
 * — VS Code JSON, VS Code delta JSONL or Copilot CLI JSONL — from one parse of the content.
 * The format is decided by the first line: a delta-based (VS Code Chat) log is rebuilt once by
 * reconstructJsonlStateAsync(); a Copilot CLI log is read line by line, keeping only references.
 */
export async function scanSessionContent(content: string, parsedJson?: unknown, sessionFile?: string): Promise<SessionContentScan> {
	if (isUuidPointerFile(content)) { return { refs: [] }; }
	// A `.jsonl` file is JSONL even when it holds a single line, as the extension's analyzer treats it.
	if (sessionFile?.endsWith('.jsonl') || isJsonlContent(content)) { return scanJsonlContent(content); }
	try {
		return scanRequestsHolder((parsedJson ?? JSON.parse(content)) as RequestsHolder | undefined);
	} catch {
		return { refs: [] };
	}
}

type SessionContentScan = { refs: ContentReferences; title?: string };
type RequestsHolder = { requests?: unknown; customTitle?: unknown };

/** References and custom title of a VS Code session object (a JSON file, or a rebuilt delta log). */
function scanRequestsHolder(holder: RequestsHolder | undefined): SessionContentScan {
	// External data: a schema-drifted snapshot may carry a non-array `requests`.
	const requests = holder?.requests;
	const refs = Array.isArray(requests) ? requests.flatMap(requestContentReferences) : [];
	const title = nonEmptyString(holder?.customTitle);
	return title ? { refs, title } : { refs };
}

async function scanJsonlContent(content: string): Promise<SessionContentScan> {
	const lines = content.trim().split('\n').filter(l => l.trim());
	let isDelta = false;
	try { isDelta = typeof JSON.parse(lines[0] ?? '')?.kind === 'number'; } catch { /* not delta */ }
	if (!isDelta) { return scanCliEvents(lines); }
	const { sessionState } = await reconstructJsonlStateAsync(lines);
	return scanRequestsHolder(sessionState as RequestsHolder | undefined);
}

/** Every content reference in a session file's content: VS Code JSON, VS Code delta JSONL or Copilot CLI JSONL. */
export async function collectSessionContentReferences(content: string, parsedJson?: unknown): Promise<ContentReferences> {
	return (await scanSessionContent(content, parsedJson)).refs;
}

/**
 * The remote of the repository a session worked in. When its workspace folder is known, that is
 * the remote of the folder's own repository (`findRepositoryRemoteForFolder()`, walking up for a
 * sub-folder workspace or an in-repo worktree) — authoritative, unlike referenced files, which can
 * live in another repository or in a nested clone inside the workspace. Only when the workspace is
 * unknown do the referenced files decide (the session is not attributed to a workspace then).
 */
export async function extractRepositoryFromSessionContent(content: string, parsedJson?: unknown, workspacePath?: string): Promise<string | undefined> {
	if (workspacePath) { return findRepositoryRemoteForFolder(workspacePath); }
	return extractWorkspaceRepository(await collectSessionContentReferences(content, parsedJson));
}

/**
 * The same rule for references the caller already collected (the Details pass): the workspace's
 * own remote when the workspace is known, else the remote of the referenced files.
 */
export async function extractWorkspaceRepository(refs: ContentReferences, workspacePath?: string): Promise<string | undefined> {
	if (workspacePath) { return findRepositoryRemoteForFolder(workspacePath); }
	return refs.length > 0 ? extractRepositoryFromContentReferences(refs) : undefined;
}

/**
 * The Details pass's repository for an adapter session: the adapter's recorded repository
 * whenever it has one — with or without a workspace, since the adapter contract defines the two
 * fields independently (Copilot CLI rows store `repository` and `cwd` separately) — else a
 * worktree-aware name derived from the workspace path. Undefined when the session has neither.
 */
export function repositoryFromEcosystemMeta(meta: { repository?: string; workspacePath?: string }): string | undefined {
	if (meta.repository) { return meta.repository; }
	return meta.workspacePath ? getRepoNameFromWorkspacePath(meta.workspacePath) : undefined;
}

/**
 * Lookups shared by the sessions of one walk. Thousands of historical sessions usually belong
 * to a handful of workspaces, so without it every session re-reads its workspaceStorage
 * `workspace.json` and re-scans the same folder's `.git` ancestors. Create one per walk (not per
 * process), so a long-lived host still sees a changed remote on its next walk.
 */
export interface SessionAttributesCache {
	/** workspaceStorage id → workspace folder, as resolveWorkspaceFolderWithFallback() caches it. */
	readonly workspaceFolders: Map<string, string | undefined>;
	/** Workspace folder → its repository remote; a promise, so concurrent sessions share one lookup. */
	readonly folderRemotes: Map<string, Promise<string | undefined>>;
}

export function createSessionAttributesCache(): SessionAttributesCache {
	return { workspaceFolders: new Map(), folderRemotes: new Map() };
}

function folderRemote(folder: string, cache: SessionAttributesCache | undefined): Promise<string | undefined> {
	if (!cache) { return findRepositoryRemoteForFolder(folder); }
	let remote = cache.folderRemotes.get(folder);
	if (!remote) {
		remote = findRepositoryRemoteForFolder(folder);
		cache.folderRemotes.set(folder, remote);
	}
	return remote;
}

/** What {@link resolveSessionAttributes} found for one session. */
export interface SessionAttributes {
	/** The session's git remote; `''` when none was found. */
	repository: string;
	/**
	 * The session's own title, when the source records one: the adapter's title, or a VS Code
	 * session's custom title. The task heuristic reads it for sessions whose analysis classified
	 * no turns — the case where it matters, since a file-based session with turns always gets a
	 * turn classification.
	 */
	title?: string;
}

/**
 * The repository and title of a session file, for hosts without the extension's analyzer (the
 * CLI, and the desktop app through it). The repository follows the extension analyzer's
 * precedence: the adapter's recorded remote; else the remote of the session's workspace folder;
 * and only when the workspace is unknown, the remote of the files it referenced. One read of
 * the session (one getMeta() call for adapter sessions). Returns `undefined` when the session
 * could not be read (callers should not cache that). Pass one {@link SessionAttributesCache}
 * for a whole walk, so each workspace is resolved once.
 */
export async function resolveSessionAttributes(ecosystems: IEcosystemAdapter[], sessionFile: string, content?: string, cache?: SessionAttributesCache): Promise<SessionAttributes | undefined> {
	try {
		const eco = ecosystems.find(e => e.handles(sessionFile));
		if (eco) {
			const meta = await eco.getMeta(sessionFile);
			const repository = meta.repository || (meta.workspacePath ? await folderRemote(meta.workspacePath, cache) : undefined);
			return { repository: repository ?? '', ...(meta.title ? { title: meta.title } : {}) };
		}
		const fileContent = content ?? await fs.promises.readFile(sessionFile, 'utf8');
		const { refs, title } = await scanSessionContent(fileContent, undefined, sessionFile);
		// workspaceStorage first, then an adapter that discovers this file without handling it
		// (e.g. a Copilot CLI events.jsonl next to its workspace.yaml) — the extension's order.
		const workspace = resolveWorkspaceFolderWithFallback(sessionFile, cache?.workspaceFolders ?? new Map())
			?? await findWorkspacePathForDiscoveredPath(ecosystems, sessionFile);
		// The same rule as extractWorkspaceRepository(): the workspace's own remote when known.
		const repository = workspace ? await folderRemote(workspace, cache) : await extractWorkspaceRepository(refs);
		return { repository: repository ?? '', ...(title ? { title } : {}) };
	} catch {
		return undefined;
	}
}
