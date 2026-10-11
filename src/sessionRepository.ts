/**
 * The git remote a session worked in, derived from the files it referenced.
 *
 * Shared by the VS Code extension's session details analyzer (which reads the same references
 * while it walks a session for other details) and the CLI, which has no adapter metadata for
 * VS Code `chatSessions` files and needs the remote for workspace grouping parity
 * (src/workspaceGrouping.ts). One definition of "what counts as a content reference" keeps the
 * two surfaces from drifting apart.
 */
import { isJsonlContent, isUuidPointerFile, reconstructJsonlStateAsync } from './tokenEstimation';
import { extractRepositoryFromContentReferences, findRepositoryRemoteForFolder } from './workspaceHelpers';

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

function cliEventReferences(line: string): ContentReferences {
	try {
		const event = JSON.parse(line);
		return event?.type === 'tool.execution_start' ? toolArgumentPathReferences(event.data?.arguments) : [];
	} catch {
		return [];
	}
}

/** Every content reference in a session file's content: VS Code JSON, VS Code delta JSONL or Copilot CLI JSONL. */
export async function collectSessionContentReferences(content: string, parsedJson?: unknown): Promise<ContentReferences> {
	if (isUuidPointerFile(content)) { return []; }
	if (isJsonlContent(content)) {
		const lines = content.trim().split('\n').filter(l => l.trim());
		let isDelta = false;
		try { isDelta = typeof JSON.parse(lines[0] ?? '')?.kind === 'number'; } catch { /* not delta */ }
		if (!isDelta) { return lines.flatMap(cliEventReferences); }
		const { sessionState } = await reconstructJsonlStateAsync(lines);
		// External data: a schema-drifted snapshot may reconstruct a non-array `requests`.
		const requests: unknown = sessionState?.requests;
		return Array.isArray(requests) ? requests.flatMap(requestContentReferences) : [];
	}
	try {
		const requests = (parsedJson as { requests?: unknown } | undefined ?? JSON.parse(content))?.requests;
		return Array.isArray(requests) ? requests.flatMap(requestContentReferences) : [];
	} catch {
		return [];
	}
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
