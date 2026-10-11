/**
 * One join key for a repository, so session activity, the AI Readiness scan
 * and pull-request statistics can be matched up.
 *
 * Sessions record the workspace's git remote URL, the readiness scan records
 * `owner/repo` (when the origin is a GitHub remote) and the PR collector
 * records the owner and name separately. The readiness scan and the PR
 * collector only ever see GitHub hosts (github.com plus the configured GitHub
 * Enterprise host), so a GitHub remote reduces to a lowercase `owner/repo`.
 * A remote on any other host keeps its host in the key (`gitlab.com/o/r`):
 * it is still grouped on its own, but can never be merged with a GitHub
 * repository that happens to share its `owner/repo`.
 *
 * Pure — no VS Code API, no filesystem — so the CLI can reuse it.
 */

/** Hosts whose repositories share the readiness scan's and PR collector's `owner/repo` namespace. */
export const DEFAULT_GITHUB_HOSTS: ReadonlySet<string> = new Set(['github.com']);

/** URL schemes git uses for network remotes. `file:` and local paths are not remotes. */
const REMOTE_PROTOCOLS = new Set(['https:', 'http:', 'ssh:', 'git:']);

/**
 * scp-like remote: `[user@]host:path`. The host must be at least two characters
 * so a Windows drive (`C:\repo`, `C:/repo`) is never read as one, and the path
 * must not start with `/` (git treats `host:/path` the same, but a local
 * `/abs/path` has no host part at all and never matches).
 */
const SCP_LIKE_REMOTE = /^(?:[^@/\s:]+@)?([A-Za-z0-9][A-Za-z0-9.-]+):(?!\/\/)\/?([^\s]+)$/;

interface ParsedRemote {
	host: string;
	segments: string[];
}

/** Host and path segments of a network git remote, or undefined for anything else. */
function parseRemote(remoteUrl: string): ParsedRemote | undefined {
	// Query strings and fragments are dropped first so a credential smuggled into
	// a remote (`…/repo.git?token=…`) never becomes part of a label.
	const cleaned = remoteUrl.trim().replace(/[?#].*$/, '');
	if (!cleaned) { return undefined; }
	let host: string;
	let path: string;
	if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(cleaned)) {
		let url: URL;
		try { url = new URL(cleaned); } catch { return undefined; }
		if (!REMOTE_PROTOCOLS.has(url.protocol) || !url.hostname) { return undefined; }
		// User info (`https://user:token@host/…`) is never part of the result: only host and path are read.
		host = url.hostname;
		path = url.pathname;
	} else {
		const match = SCP_LIKE_REMOTE.exec(cleaned);
		if (!match) { return undefined; }
		[, host, path] = match;
	}
	const segments = path.replace(/\/+$/, '').replace(/\.git$/i, '').split('/').filter(s => s.length > 0);
	if (segments.length < 2 || !segments.every(isNameSegment)) { return undefined; }
	return { host: host.toLowerCase(), segments };
}

/**
 * Display name for a git remote URL, or undefined when it is not a network
 * remote. Handles HTTPS, `ssh://`, `git://` and scp-style (`git@host:owner/repo.git`)
 * remotes. A remote on one of `githubHosts` reads `owner/repo`; any other host
 * reads `host/path` (all path segments, so GitLab subgroups stay distinct).
 * Local paths and `file://` remotes are rejected: they name a directory, not a
 * repository identity.
 */
export function repoDisplayFromRemote(
	remoteUrl: string | undefined | null,
	githubHosts: ReadonlySet<string> = DEFAULT_GITHUB_HOSTS,
): string | undefined {
	if (!remoteUrl) { return undefined; }
	const parsed = parseRemote(remoteUrl);
	if (!parsed) { return undefined; }
	if (githubHosts.has(parsed.host)) {
		return parsed.segments.length === 2 ? parsed.segments.join('/') : undefined;
	}
	return [parsed.host, ...parsed.segments].join('/');
}

/** Lowercase join key for a git remote URL. See {@link repoDisplayFromRemote}. */
export function repoKeyFromRemote(
	remoteUrl: string | undefined | null,
	githubHosts: ReadonlySet<string> = DEFAULT_GITHUB_HOSTS,
): string | undefined {
	return repoDisplayFromRemote(remoteUrl, githubHosts)?.toLowerCase();
}

/** Display form (`owner/repo`) of a GitHub slug, or undefined when it is not exactly two name segments. */
export function repoDisplayFromSlug(slug: string | undefined | null): string | undefined {
	const parts = slug?.trim().split('/');
	return parts && parts.length === 2 && parts.every(isNameSegment) ? `${parts[0]}/${parts[1]}` : undefined;
}

/** Lowercase join key for a GitHub `owner/repo` slug (readiness `nameWithOwner`, PR stats). */
export function repoKeyFromSlug(slug: string | undefined | null): string | undefined {
	return repoDisplayFromSlug(slug)?.toLowerCase();
}

/**
 * Display name for a session's recorded repository. Most sessions record their
 * workspace's git remote URL; a Copilot CLI store session records the GitHub
 * `owner/repo` slug instead, which the caller says with `isGitHubSlug`. Only a
 * value known to be a slug is read as one: a generic `a/b` string may be a
 * relative local path, and is rejected like any other non-remote.
 */
export function repoDisplayFromSession(
	repository: string | undefined | null,
	isGitHubSlug: boolean,
	githubHosts: ReadonlySet<string> = DEFAULT_GITHUB_HOSTS,
): string | undefined {
	return isGitHubSlug ? repoDisplayFromSlug(repository) : repoDisplayFromRemote(repository, githubHosts);
}

/**
 * GitHub hosts for the join: github.com plus the host of a configured GitHub
 * Enterprise URI. An invalid URI falls back to github.com only.
 */
export function githubHostsFor(enterpriseUri: string | undefined): ReadonlySet<string> {
	const hosts = new Set(DEFAULT_GITHUB_HOSTS);
	if (enterpriseUri) {
		try {
			const host = new URL(enterpriseUri).hostname.toLowerCase();
			if (host) { hosts.add(host); }
		} catch { /* invalid URI: github.com only */ }
	}
	return hosts;
}

function isNameSegment(segment: string): boolean {
	return /^[A-Za-z0-9._-]+$/.test(segment) && segment !== '.' && segment !== '..';
}
