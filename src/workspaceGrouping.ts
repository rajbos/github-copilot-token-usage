/**
 * Workspace grouping — folds worktrees, scratch clones, case variants and remote (WSL/SSH)
 * spellings of one repository into a single workspace group.
 *
 * Shared by the VS Code extension (Workspace Health / customization matrix) and the CLI
 * (`buildCustomizationMatrix`), so both surfaces count the same set of workspaces.
 *
 * The module is pure: it never touches the filesystem itself. Everything it needs to know
 * about the disk (does a folder exist, where does a worktree's `.git` pointer lead, what is a
 * folder's git remote) comes in through {@link WorkspaceGroupingProbes}, so every rule is
 * unit-testable offline. `workspaceGroupingProbes.ts` holds the real Node implementation.
 *
 * Grouping rules, strongest evidence first (see docs/features/WORKSPACE-GROUPING.md):
 *   1. same git remote identity (`owner/name`) → one group, displayed as the repository name;
 *   2. a worktree whose `.git` pointer resolves to a main checkout → grouped with that checkout;
 *   3. known worktree path conventions (`.claude/worktrees/<repo>/<name>`,
 *      `<repo>/.claude/worktrees/<name>`, `copilot-worktrees/<repo>/<name>`), case-only
 *      differences, and remote paths that share a basename with a local checkout;
 *   4. sibling artefact folders (`<repo>-wt`, `<repo>-refactor-wt`, `<repo>-85ed99`) whose
 *      stem is the basename of another workspace in the list;
 *   5. same basename — the weakest signal, applied last.
 * No rule ever merges two groups whose remotes say they are different repositories. A name
 * pattern on its own never invents a group: an artefact name with nothing to merge into is
 * left alone and reported by {@link detectArtefactWorkspaceNames} instead.
 */

/** One workspace folder as observed in session data. */
export interface WorkspaceUsageEntry {
	/** Absolute folder path, or an `<unresolved:…>` placeholder (passed through untouched). */
	path: string;
	sessionCount: number;
	interactionCount: number;
	/** Git remote URL recorded by the session (e.g. the `repository` field), if any. */
	repository?: string;
}

/** What the probes know about a folder's git setup. */
export interface WorkspaceGitInfo {
	/** Remote URL of `origin` (read from `.git/config`, or the main checkout's config for a worktree). */
	remote?: string;
	/** For a linked worktree: the main checkout's folder (parent of `<main>/.git/worktrees/<name>`). */
	mainWorktreePath?: string;
}

/** Filesystem access, injected so the grouping itself stays pure. */
export interface WorkspaceGroupingProbes {
	/** `process.platform` of the machine the paths came from. Drives case-folding and remote-path rules. */
	platform: string;
	/** True when the folder still exists. Defaults to "unknown → false". */
	pathExists?: (folderPath: string) => boolean;
	/** Git facts for a folder that still exists. Return undefined when unknown. */
	readGitInfo?: (folderPath: string) => WorkspaceGitInfo | undefined;
	/**
	 * The user's real home directory. `<home>/.claude/worktrees/<repo>/<name>` is the Claude
	 * desktop layout even when home is redirected (`D:\Profiles\dev`); without it only the
	 * conventional home shapes (`/home/<u>`, `C:\Users\<u>`, …) are recognised.
	 */
	homeDirectory?: string;
}

/** One group of workspace folders that belong to the same repository. */
export interface WorkspaceGroup {
	/** Path that represents the group (map key; customization files are scanned here). */
	canonicalPath: string;
	/** Name shown in the UI: the repository name when known, otherwise the canonical folder name. */
	displayName: string;
	/** Every input path merged into this group, sorted, including the canonical path when it was an input. */
	memberPaths: string[];
	sessionCount: number;
	interactionCount: number;
	/** Normalised `owner/name` repository identity, when one was known for any member. */
	repositoryId?: string;
}

/** A display name that still looks like a worktree / clone artefact after grouping. */
export interface ArtefactWorkspaceName {
	displayName: string;
	canonicalPath: string;
	reason: ArtefactNameReason;
}

export type ArtefactNameReason = 'hash-suffix' | 'generated-name' | 'worktree-suffix' | 'worktree-folder';

const UNRESOLVED_PREFIX = '<unresolved:';

// ── Path helpers (separator-agnostic: a Windows path must parse on any host) ──────────

/**
 * Path segments, collapsing separator runs. A UNC root (`\\server\share`, `//server/share`) keeps
 * both leading separators as two empty segments, so joining the segments back restores it.
 */
function splitSegments(p: string): string[] {
	const unc = /^[\\/]{2}(?![\\/])/.test(p);
	const segments = p.split(/[\\/]+/);
	return unc ? ['', ...segments] : segments;
}

function separatorOf(p: string): string {
	return p.includes('\\') && !p.startsWith('/') ? '\\' : '/';
}

function joinSegments(segments: string[], sep: string): string {
	const joined = segments.join(sep);
	// A POSIX absolute path splits into ['', 'home', …]; joining restores the leading '/'.
	return joined === '' ? sep : joined;
}

/** Last non-empty path segment. */
export function workspaceBasename(p: string): string {
	const segments = splitSegments(p).filter(s => s.length > 0);
	return segments.length > 0 ? segments[segments.length - 1] : p;
}

function isUnresolved(p: string): boolean {
	return p.startsWith(UNRESOLVED_PREFIX);
}

/** A POSIX-style path seen on Windows: a WSL / SSH / dev-container workspace. */
/**
 * A POSIX-style path seen on Windows: a WSL / SSH / dev-container workspace. `path.normalize()`
 * on Windows turns `/home/x` into `\home\x`, so a single leading separator of either kind
 * counts; a UNC network share (`\\server\share`, `//server/share`) is local and does not.
 */
function isRemotePath(p: string, platform: string): boolean {
	if (platform !== 'win32') { return false; }
	const isSeparator = (c: string): boolean => c === '/' || c === '\\';
	return isSeparator(p.charAt(0)) && !isSeparator(p.charAt(1));
}

function caseFolds(platform: string): boolean {
	return platform === 'win32' || platform === 'darwin';
}

/** Comparison key for "is this the same folder?" on the given platform. */
function samePathKey(p: string, platform: string): string {
	const slashed = p.replace(/\\/g, '/').replace(/\/+$/, '');
	return caseFolds(platform) ? slashed.toLowerCase() : slashed;
}

// ── Repository identity ──────────────────────────────────────────────────────

/** Host assumed for a bare `owner/name` (how Copilot records a GitHub repository). */
const DEFAULT_REMOTE_HOST = 'github.com';

/** Split a remote into host and path: `scheme://[user@]host[:port]/path`, `[user@]host:path`, or a bare path. */
function splitRemote(remote: string): { host?: string; path: string } {
	const url = remote.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/(.*)$/i);
	if (url) { return { host: url[1], path: url[2] }; }
	// scp-like `[user@]host:owner/name`, including an SSH-config alias (`work:acme/widget.git`).
	// Drive letters never get here: isLocalRemote() rejects them before this parser runs.
	const scp = remote.match(/^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/);
	if (scp) { return { host: scp[1], path: scp[2] }; }
	return { path: remote };
}

/**
 * A remote on the local filesystem (`/srv/repo.git`, `../repo.git`, `~/repo`, `C:\repos\x`,
 * `file://…`). It names no hosted repository, and read as a bare `owner/name` it could collide
 * with a real GitHub repository or with another folder's same relative remote.
 */
function isLocalRemote(remote: string): boolean {
	// Any leading drive designator is local, including drive-relative `C:repos/x.git`; a real
	// scp-style host needs a user (`git@…`) or a dot, so a single letter before `:` is never one.
	return /^(?:file:|[/\\~.]|[a-z]:)/i.test(remote) || (!remote.includes(':') && remote.includes('\\'));
}

/** Azure DevOps ssh and legacy `<org>.visualstudio.com` remotes, as `dev.azure.com/<org>/…`. */
function normalizeAzureDevOps(host: string | undefined, parts: string[]): { host: string | undefined; parts: string[] } {
	if (host === 'ssh.dev.azure.com' || host === 'vs-ssh.visualstudio.com') {
		return { host: 'dev.azure.com', parts: parts[0]?.toLowerCase() === 'v3' ? parts.slice(1) : parts };
	}
	if (host?.endsWith('.visualstudio.com')) {
		return { host: 'dev.azure.com', parts: [host.slice(0, -'.visualstudio.com'.length), ...parts] };
	}
	return { host, parts };
}

/**
 * Normalise a git remote to a lower-case `host/namespace/name` identity, so one repository
 * matches across https, ssh (`git@host:owner/name.git`) and `ssh://` forms while repositories on
 * different hosts or organisations stay distinct (`github.com/acme/widget` is not
 * `gitlab.com/acme/widget`). A bare `owner/name` is a GitHub repository. Azure DevOps https, ssh
 * (`v3/…`) and legacy `<org>.visualstudio.com` remotes all become
 * `dev.azure.com/<org>/<project>/<repo>`. Returns undefined for anything that is not a repository.
 */
export function repositoryIdentity(remote: string | undefined): string | undefined {
	const trimmed = remote?.trim();
	if (!trimmed || isLocalRemote(trimmed)) { return undefined; }
	const split = splitRemote(trimmed);
	const rawParts = split.path.replace(/[?#].*$/, '').split('/').filter(p => p.length > 0);
	if (rawParts.length > 0) { rawParts[rawParts.length - 1] = rawParts[rawParts.length - 1].replace(/\.git$/i, ''); }
	const normalized = normalizeAzureDevOps(split.host?.toLowerCase(), rawParts);
	const host = normalized.host;
	// `_git` is Azure DevOps URL syntax only; elsewhere (a GitLab subgroup) it is a real namespace.
	const parts = host === 'dev.azure.com' ? normalized.parts.filter(p => p !== '_git') : normalized.parts;
	if (!host && parts.length !== 2) { return undefined; }
	if (parts.length < 2 || parts.some(p => !p)) { return undefined; }
	return `${host ?? DEFAULT_REMOTE_HOST}/${parts.join('/')}`.toLowerCase();
}

function repositoryName(repositoryId: string): string {
	return repositoryId.slice(repositoryId.lastIndexOf('/') + 1);
}

// ── Artefact name patterns ────────────────────────────────────────────────────

/** `-85ed99`: a trailing run of 6+ hex chars containing at least one digit (so `-facade` is not a hash). */
const HASH_SUFFIX = /-(?=[0-9a-f]*\d)[0-9a-f]{6,}$/i;
/** `goofy-wozniak-42f712`: Claude Code / Docker-style generated worktree names. */
const GENERATED_NAME = /^[a-z]+-[a-z]+-(?=[0-9a-f]*\d)[0-9a-f]{6}$/i;
/** `repo-wt`, `repo-refactor-wt`. */
const WORKTREE_SUFFIX = /(^|-)wt$/i;
/** Parent folder names whose children are worktrees, never repositories. */
const WORKTREE_PARENTS = new Set(['worktrees', 'copilot-worktrees']);

/** Classify a folder / display name that looks like a worktree or clone artefact. */
export function classifyArtefactName(name: string): ArtefactNameReason | undefined {
	if (GENERATED_NAME.test(name)) { return 'generated-name'; }
	if (HASH_SUFFIX.test(name)) { return 'hash-suffix'; }
	if (WORKTREE_SUFFIX.test(name)) { return 'worktree-suffix'; }
	return undefined;
}

/**
 * Candidate repository names hidden inside an artefact folder name, most specific first:
 * `repo-refactor-wt` → [`repo-refactor`, `repo`], `repo-85ed99` → [`repo`].
 */
function artefactStems(name: string): Array<{ stem: string; siblingOnly: boolean }> {
	const stems: Array<{ stem: string; siblingOnly: boolean }> = [];
	// `acme-app-85ed99` and `goofy-wozniak-42f712` have the same shape; only the list can tell
	// them apart (a generated name's stem simply matches no other workspace). Scratch clones are
	// made anywhere, so a hash-suffixed name may match a checkout in any folder.
	if (HASH_SUFFIX.test(name)) {
		stems.push({ stem: name.replace(HASH_SUFFIX, ''), siblingOnly: false });
	}
	// A `-wt` folder is a worktree created next to its checkout: it only matches a sibling, so
	// `/unrelated/acme-feature-wt` never joins `/projects/acme`.
	if (/-wt$/i.test(name)) {
		const withoutWt = name.replace(/-wt$/i, '');
		stems.push({ stem: withoutWt, siblingOnly: true });
		const lastDash = withoutWt.lastIndexOf('-');
		if (lastDash > 0) { stems.push({ stem: withoutWt.slice(0, lastDash), siblingOnly: true }); }
	}
	return stems.filter(s => s.stem.length > 0);
}

/** The folder containing `p`, in comparable form. */
function parentKey(p: string, platform: string): string {
	const segments = splitSegments(p.replace(/(?<=[^\\/])[\\/]+$/, ''));
	return samePathKey(joinSegments(segments.slice(0, -1), separatorOf(p)), platform);
}

// ── Worktree path conventions ─────────────────────────────────────────────────

/**
 * True for a user home directory: `/home/<user>`, `/Users/<user>`, `/root`,
 * `C:\Users\<user>`, `C:\Documents and Settings\<user>`, or a WSL mount of one
 * (`/mnt/c/Users/<user>`).
 */
function looksLikeHomeDirectory(segments: string[]): boolean {
	let rest = segments.filter(s => s.length > 0).map(s => s.toLowerCase());
	if (rest.length > 0 && /^[a-z]:$/.test(rest[0])) { rest = rest.slice(1); }
	if (rest.length > 1 && rest[0] === 'mnt' && /^[a-z]$/.test(rest[1])) { rest = rest.slice(2); }
	if (rest.length === 1) { return rest[0] === 'root'; }
	return rest.length === 2 && ['home', 'users', 'documents and settings'].includes(rest[0]);
}

interface ConventionMatch {
	/** Repository name the convention names. */
	repoName: string;
	/** Path that stands for the repository when nothing better is in the list. */
	anchorPath: string;
	/** True when the anchor is a real checkout (worth scanning), not just a folder of worktrees. */
	anchorIsCheckout: boolean;
}

/**
 * Recognise a folder inside a known worktree layout:
 *  - `<root>/copilot-worktrees/<repo>/<name>[/…]` (Copilot app); the anchor is
 *    `<root>/repos/<repo>` when that checkout exists, else `<root>/copilot-worktrees/<repo>`.
 *  - `<home>/.claude/worktrees/<repo>/<name>[/…]` (Claude desktop app).
 *  - `<repo>/.claude/worktrees/<name>[/…]` (Claude Code CLI, worktree inside the repo).
 *
 * The two Claude layouts look alike when the cwd is a sub-folder of the worktree. The folder
 * above `.claude` decides: it is the repository when it is itself a known workspace
 * (`isWorkspace`) or holds a `.git`, the desktop layout when it is a home directory, and the
 * repository otherwise — so the call works without disk access (deleted folders, WSL paths).
 */
/** What `matchWorktreeConvention()` may consult; every field is optional and disk-free by default. */
export interface WorktreeConventionContext {
	pathExists?: (p: string) => boolean;
	/** True for a folder that is itself in the workspace list. */
	isWorkspace?: (p: string) => boolean;
	/** The user's real home directory (see WorkspaceGroupingProbes.homeDirectory). */
	homeDirectory?: string;
}

export function matchWorktreeConvention(folderPath: string, context: WorktreeConventionContext = {}): ConventionMatch | undefined {
	const segments = splitSegments(folderPath);
	const sep = separatorOf(folderPath);
	return matchCopilotWorktree(segments, sep, context.pathExists) ?? matchClaudeWorktree(segments, sep, context);
}

/** Same folder, ignoring separator style, trailing separators and case (home matching only). */
function sameFolder(a: string, b: string): boolean {
	const key = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
	return key(a) === key(b);
}

/** `<root>/copilot-worktrees/<repo>/<name>[/…]`. */
function matchCopilotWorktree(segments: string[], sep: string, pathExists?: (p: string) => boolean): ConventionMatch | undefined {
	const idx = segments.map(s => s.toLowerCase()).lastIndexOf('copilot-worktrees');
	if (idx === -1 || idx + 2 >= segments.length || segments[idx + 2] === '') { return undefined; }
	const repoName = segments[idx + 1];
	const reposPath = joinSegments([...segments.slice(0, idx), 'repos', repoName], sep);
	const reposExists = pathExists?.(reposPath) ?? false;
	const anchorPath = reposExists ? reposPath : joinSegments(segments.slice(0, idx + 2), sep);
	return { repoName, anchorPath, anchorIsCheckout: reposExists };
}

/** `<home>/.claude/worktrees/<repo>/<name>[/…]` or `<repo>/.claude/worktrees/<name>[/…]`. */
function matchClaudeWorktree(segments: string[], sep: string, context: WorktreeConventionContext): ConventionMatch | undefined {
	const { pathExists, isWorkspace, homeDirectory } = context;
	const lower = segments.map(s => s.toLowerCase());
	let i = lower.length - 2;
	while (i >= 1 && !(lower[i] === '.claude' && lower[i + 1] === 'worktrees')) { i--; }
	if (i < 1) { return undefined; }
	const after = segments.slice(i + 2).filter(s => s.length > 0);
	if (after.length === 0) { return undefined; }
	const repoRoot = joinSegments(segments.slice(0, i), sep);
	const repoRootIsRepository = (isWorkspace?.(repoRoot) ?? false) || (pathExists?.(`${repoRoot}${sep}.git`) ?? false);
	const isHome = homeDirectory ? sameFolder(repoRoot, homeDirectory) : false;
	if (!repoRootIsRepository && (isHome || looksLikeHomeDirectory(segments.slice(0, i)))) {
		// Desktop layout: `<home>/.claude/worktrees/<repo>/<name>`.
		return { repoName: after[0], anchorPath: joinSegments(segments.slice(0, i + 3), sep), anchorIsCheckout: false };
	}
	// In-repo layout: `<repo>/.claude/worktrees/<name>`.
	return { repoName: workspaceBasename(repoRoot), anchorPath: repoRoot, anchorIsCheckout: true };
}

/**
 * Every path `groupWorkspaces()` can ask `pathExists` about for these entries: the local
 * folders themselves and the checkouts and `.git` folders their worktree layouts point at.
 * Main checkouts reported by `readGitInfo` come on top. Lets a host check them all
 * asynchronously up front (prefetchWorkspaceGroupingProbes) instead of blocking on sync I/O.
 */
export function workspaceProbePaths(entries: WorkspaceUsageEntry[], platform: string, homeDirectory?: string): string[] {
	const paths = new Set<string>();
	for (const entry of entries) {
		if (isUnresolved(entry.path) || isRemotePath(entry.path, platform)) { continue; }
		paths.add(entry.path);
		const match = matchWorktreeConvention(entry.path, { pathExists: p => { paths.add(p); return false; }, homeDirectory });
		if (match) { paths.add(match.anchorPath); }
	}
	return [...paths];
}

/**
 * Usage entries for one folder that carry every git remote its sessions recorded: the counts go
 * on the first entry and each further remote adds an empty entry for the same path, so
 * `groupWorkspaces()` sees a folder reused for another repository as conflicting instead of
 * taking whichever remote a caller kept first.
 */
export function workspaceEntriesWithRemotes(
	folderPath: string, sessionCount: number, interactionCount: number, remotes: Iterable<string> = [],
): WorkspaceUsageEntry[] {
	const [first, ...rest] = [...new Set(remotes)];
	return [
		{ path: folderPath, sessionCount, interactionCount, ...(first ? { repository: first } : {}) },
		...rest.map(repository => ({ path: folderPath, sessionCount: 0, interactionCount: 0, repository })),
	];
}

// ── Union-find with a "different repositories" veto ───────────────────────────

class Groups {
	private readonly parent: number[];
	private readonly repoIds: Array<Set<string>>;

	constructor(repoIds: Array<string | undefined>) {
		this.parent = repoIds.map((_, i) => i);
		this.repoIds = repoIds.map(id => new Set(id ? [id] : []));
	}

	find(i: number): number {
		while (this.parent[i] !== i) {
			this.parent[i] = this.parent[this.parent[i]];
			i = this.parent[i];
		}
		return i;
	}

	/** True when both sides know their repository and the repositories differ. */
	conflicts(a: number, b: number): boolean {
		const ra = this.repoIds[this.find(a)];
		const rb = this.repoIds[this.find(b)];
		if (ra.size === 0 || rb.size === 0) { return false; }
		for (const id of ra) { if (rb.has(id)) { return false; } }
		return true;
	}

	/** Merge unless the remotes say these are different repositories. Returns whether merged. */
	union(a: number, b: number): boolean {
		const ra = this.find(a);
		const rb = this.find(b);
		if (ra === rb) { return true; }
		if (this.conflicts(ra, rb)) { return false; }
		const [root, child] = ra < rb ? [ra, rb] : [rb, ra];
		this.parent[child] = root;
		for (const id of this.repoIds[child]) { this.repoIds[root].add(id); }
		return true;
	}

	repositoryIds(i: number): Set<string> {
		return this.repoIds[this.find(i)];
	}
}

// ── Grouping ─────────────────────────────────────────────────────────────────

interface Node {
	path: string;
	sessionCount: number;
	interactionCount: number;
	/** False for synthetic anchors (convention / main-worktree paths), which carry no counts of their own. */
	isInput: boolean;
	/** Anchor that is a real checkout, preferred as the group's canonical path when it exists. */
	isCheckoutAnchor?: boolean;
	remote: boolean;
	mainWorktreePath?: string;
	convention?: ConventionMatch;
	/**
	 * Seen with two different remotes (a folder reused for another repository, or sessions
	 * disagreeing). Unlike a folder with no remote, it must not be attributed to either
	 * repository by name, so name-based rules leave its group alone.
	 */
	conflictingRemotes?: boolean;
}

function unionByKey(nodes: Node[], groups: Groups, keyOf: (n: Node, i: number) => string | undefined): void {
	const first = new Map<string, number>();
	nodes.forEach((n, i) => {
		const key = keyOf(n, i);
		if (key === undefined) { return; }
		const seen = first.get(key);
		if (seen === undefined) { first.set(key, i); } else { groups.union(seen, i); }
	});
}

/** The node list plus each node's repository identity, with duplicate paths folded together. */
class NodeList {
	readonly nodes: Node[] = [];
	readonly repoIds: Array<string | undefined> = [];
	private readonly indexByPath = new Map<string, number>();

	add(node: Node, repoId: string | undefined): number {
		const existing = this.indexByPath.get(node.path);
		if (existing === undefined) {
			this.nodes.push(node);
			this.repoIds.push(node.conflictingRemotes ? undefined : repoId);
			this.indexByPath.set(node.path, this.nodes.length - 1);
			return this.nodes.length - 1;
		}
		const n = this.nodes[existing];
		n.sessionCount += node.sessionCount;
		n.interactionCount += node.interactionCount;
		n.isInput = n.isInput || node.isInput;
		n.isCheckoutAnchor = n.isCheckoutAnchor || node.isCheckoutAnchor;
		if (node.conflictingRemotes) {
			// An observation that already disagreed with itself makes the whole folder conflicting.
			n.conflictingRemotes = true;
			this.repoIds[existing] = undefined;
		}
		this.mergeRepoId(existing, repoId);
		return existing;
	}

	/**
	 * A folder reused for another repository, or sessions disagreeing about its remote, makes
	 * its identity unknown rather than whichever remote happened to come first: keeping one
	 * would hide the conflict from the veto and allow a wrong merge.
	 */
	private mergeRepoId(idx: number, repoId: string | undefined): void {
		if (!repoId || this.nodes[idx].conflictingRemotes) { return; }
		const current = this.repoIds[idx];
		if (current === undefined) { this.repoIds[idx] = repoId; return; }
		if (current !== repoId) {
			this.repoIds[idx] = undefined;
			this.nodes[idx].conflictingRemotes = true;
		}
	}
}

function inputNode(
	entry: WorkspaceUsageEntry, probes: WorkspaceGroupingProbes,
	pathExists: (p: string) => boolean, isWorkspace: (p: string) => boolean,
): { node: Node; repoId?: string } {
	const remote = isRemotePath(entry.path, probes.platform);
	const git = !remote && pathExists(entry.path) ? probes.readGitInfo?.(entry.path) : undefined;
	// The session's recorded remote and the folder's current `.git/config` are two observations
	// of the same folder: when they disagree (the folder was reused), neither identity is kept.
	const sessionId = repositoryIdentity(entry.repository);
	const gitId = repositoryIdentity(git?.remote);
	const conflictingRemotes = sessionId !== undefined && gitId !== undefined && sessionId !== gitId;
	return {
		node: {
			path: entry.path,
			sessionCount: entry.sessionCount,
			interactionCount: entry.interactionCount,
			isInput: true,
			remote,
			mainWorktreePath: git?.mainWorktreePath,
			// Layout rules need no disk access, so they also apply to WSL / remote paths; only the
			// existence checks are skipped there, since the local probes cannot see that filesystem.
			convention: matchWorktreeConvention(entry.path, {
				pathExists: remote ? undefined : pathExists,
				isWorkspace,
				homeDirectory: probes.homeDirectory,
			}),
			...(conflictingRemotes ? { conflictingRemotes } : {}),
		},
		repoId: conflictingRemotes ? undefined : sessionId ?? gitId,
	};
}

/**
 * Anchors: a worktree's main checkout, and a convention's repository folder. They join the
 * node list (with zero counts) so a group can be represented by the real checkout.
 * An anchor starts without a repository identity: when it is also an input it keeps its own,
 * so a worktree reporting a different remote than its main checkout is vetoed, not merged.
 * Returns input index → anchor index.
 */
function addAnchors(list: NodeList, platform: string, probes: WorkspaceGroupingProbes): Map<number, number> {
	const anchorOf = new Map<number, number>();
	const inputCount = list.nodes.length;
	for (let i = 0; i < inputCount; i++) {
		const n = list.nodes[i];
		const anchorPath = n.mainWorktreePath ?? n.convention?.anchorPath;
		if (!anchorPath || samePathKey(anchorPath, platform) === samePathKey(n.path, platform)) { continue; }
		const isCheckoutAnchor = n.mainWorktreePath !== undefined || n.convention?.anchorIsCheckout === true;
		const anchor: Node = { path: anchorPath, sessionCount: 0, interactionCount: 0, isInput: false, isCheckoutAnchor, remote: isRemotePath(anchorPath, platform) };
		// A synthetic anchor never borrows the worktree's identity, but an existing checkout carries
		// its own probed remote, so a worktree of another repository is vetoed rather than merged.
		const anchorGit = !anchor.remote && probes.pathExists?.(anchorPath) ? probes.readGitInfo?.(anchorPath) : undefined;
		anchorOf.set(i, list.add(anchor, repositoryIdentity(anchorGit?.remote)));
	}
	return anchorOf;
}

/** Name a node goes by for name-based rules: the convention's repository, else its folder name. */
function nodeName(n: Node): string {
	return (n.convention?.repoName ?? workspaceBasename(n.path)).toLowerCase();
}

/**
 * Rules 3 (remote paths), 4 (sibling artefact folders) and 5 (same basename).
 *
 * Ambiguity is decided per name component, from the repository identities the strong rules
 * (1–3) established, before any name-based union happens: a component naming two different
 * repositories is ambiguous as a whole, so no folder in it is attributed to one of them by
 * whichever union ran first. Its remote-less local folders still fold together.
 */
function unionByName(nodes: Node[], groups: Groups, platform: string): void {
	const idsBefore = nodes.map((_n, i) => [...groups.repositoryIds(i)]);
	const componentIds = (indexes: number[]): Set<string> => new Set(indexes.flatMap(i => idsBefore[i]));
	// A group holding a folder with conflicting remotes takes no part in name-based merging.
	const conflictedRoots = new Set(nodes.flatMap((n, i) => (n.conflictingRemotes ? [groups.find(i)] : [])));
	const byName = new Map<string, number[]>();
	nodes.forEach((n, i) => {
		if (conflictedRoots.has(groups.find(i))) { return; }
		byName.set(nodeName(n), [...(byName.get(nodeName(n)) ?? []), i]);
	});

	// 4. Sibling artefact folders: the most specific stem that names local workspaces decides.
	nodes.forEach((n, i) => {
		if (n.remote || n.convention || conflictedRoots.has(groups.find(i))) { return; }
		const parent = parentKey(n.path, platform);
		const target = artefactStems(workspaceBasename(n.path))
			.map(({ stem, siblingOnly }) => (byName.get(stem.toLowerCase()) ?? [])
				.filter(c => c !== i && !nodes[c].remote && (!siblingOnly || parentKey(nodes[c].path, platform) === parent)))
			.find(list => list.length > 0);
		if (target && componentIds([i, ...target]).size <= 1) { target.forEach(c => groups.union(c, i)); }
	});
	// 3 + 5. Remote paths and same-named local folders, one name component at a time.
	for (const component of byName.values()) {
		const locals = component.filter(i => !nodes[i].remote);
		if (locals.length === 0) { continue; } // remote paths alone never merge by name
		if (componentIds(component).size <= 1) {
			component.forEach(i => groups.union(locals[0], i));
			continue;
		}
		const unidentified = locals.filter(i => idsBefore[i].length === 0);
		unidentified.forEach(i => groups.union(unidentified[0], i));
	}
}

/**
 * Group workspace folders that belong to the same repository.
 * Duplicate input paths are summed. `<unresolved:…>` entries come back as single-member
 * groups, untouched. Output is sorted by interactions, then sessions, then display name.
 */
export function groupWorkspaces(entries: WorkspaceUsageEntry[], probes: WorkspaceGroupingProbes): WorkspaceGroup[] {
	const { platform } = probes;
	const pathExists = probes.pathExists ?? (() => false);
	const list = new NodeList();
	const passthrough: WorkspaceGroup[] = [];
	// Every pass walks nodes in index order, so index them by path: the result then depends
	// only on the set of entries, never on the order they arrived in.
	const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	const workspaceKeys = new Set(sorted.filter(e => !isUnresolved(e.path)).map(e => samePathKey(e.path, platform)));
	const isWorkspace = (p: string): boolean => workspaceKeys.has(samePathKey(p, platform));
	for (const entry of sorted) {
		if (isUnresolved(entry.path)) {
			passthrough.push({
				canonicalPath: entry.path, displayName: entry.path, memberPaths: [entry.path],
				sessionCount: entry.sessionCount, interactionCount: entry.interactionCount,
			});
			continue;
		}
		const { node, repoId } = inputNode(entry, probes, pathExists, isWorkspace);
		list.add(node, repoId);
	}
	const anchorOf = addAnchors(list, platform, probes);
	const { nodes } = list;
	const groups = new Groups(list.repoIds);

	// A folder with conflicting remotes has no identity left for the veto to compare, so it is
	// kept out of every rule weaker than a remote match: it could otherwise carry one
	// repository's sessions into another's group.
	const conflicting = (i: number): boolean => nodes[i].conflictingRemotes === true;

	// 1. Same repository identity (a conflicting folder has none, so it never matches).
	unionByKey(nodes, groups, (_n, i) => list.repoIds[i]);
	// 2 + 3. Worktree pointer and path conventions → their anchor.
	for (const [i, anchorIdx] of anchorOf) {
		if (!conflicting(i) && !conflicting(anchorIdx)) { groups.union(anchorIdx, i); }
	}
	// 3. Case-only differences (same folder on a case-insensitive filesystem).
	if (caseFolds(platform)) {
		// Only local folders: a WSL / SSH path lives on a case-sensitive filesystem, where
		// `/home/dev/Repo` and `/home/dev/repo` can be two repositories.
		unionByKey(nodes, groups, (n, i) => (conflicting(i) || n.remote ? undefined : samePathKey(n.path, platform)));
	}
	// 3–5. Name-based rules, weakest last.
	unionByName(nodes, groups, platform);

	return [...buildGroups(nodes, groups, pathExists), ...passthrough].sort(compareGroups);
}

function compareGroups(a: WorkspaceGroup, b: WorkspaceGroup): number {
	return b.interactionCount - a.interactionCount
		|| b.sessionCount - a.sessionCount
		|| a.displayName.localeCompare(b.displayName)
		|| a.canonicalPath.localeCompare(b.canonicalPath);
}

function buildGroups(nodes: Node[], groups: Groups, pathExists: (p: string) => boolean): WorkspaceGroup[] {
	const members = new Map<number, number[]>();
	nodes.forEach((_n, i) => {
		const root = groups.find(i);
		const list = members.get(root) ?? [];
		list.push(i);
		members.set(root, list);
	});

	const result: WorkspaceGroup[] = [];
	for (const [root, indexes] of members) {
		const inputs = indexes.filter(i => nodes[i].isInput);
		if (inputs.length === 0) { continue; }
		const canonical = nodes[pickCanonical(indexes, nodes, pathExists)];
		const repoIds = [...groups.repositoryIds(root)].sort();
		const repositoryId = repoIds[0];
		const displayName = repositoryId
			? repositoryName(repositoryId)
			: canonical.convention?.repoName ?? workspaceBasename(canonical.path);
		result.push({
			canonicalPath: canonical.path,
			displayName,
			memberPaths: inputs.map(i => nodes[i].path).sort(),
			sessionCount: inputs.reduce((sum, i) => sum + nodes[i].sessionCount, 0),
			interactionCount: inputs.reduce((sum, i) => sum + nodes[i].interactionCount, 0),
			...(repositoryId ? { repositoryId } : {}),
		});
	}
	return result;
}

/**
 * Choose the folder that represents a group, deterministically:
 *  1. a main checkout another member is a worktree of (or a checkout a convention names) that exists on disk;
 *  2. a local folder whose name is not an artefact and that is not inside a worktree layout;
 *  3. any local folder; then remote ones.
 * Within a tier: most interactions, then most sessions, then the lexicographically smallest path.
 */
function pickCanonical(indexes: number[], nodes: Node[], pathExists: (p: string) => boolean): number {
	const tier = (i: number): number => {
		const n = nodes[i];
		if (n.isCheckoutAnchor && pathExists(n.path)) { return 0; }
		if (!n.isInput) { return 5; }
		if (n.remote) { return 4; }
		if (!n.convention && !n.mainWorktreePath && !classifyArtefactName(workspaceBasename(n.path))) { return 1; }
		return 2;
	};
	return [...indexes].sort((a, b) =>
		tier(a) - tier(b)
		|| nodes[b].interactionCount - nodes[a].interactionCount
		|| nodes[b].sessionCount - nodes[a].sessionCount
		|| (nodes[a].path < nodes[b].path ? -1 : nodes[a].path > nodes[b].path ? 1 : 0)
	)[0];
}

/**
 * Every folder a group covers: its canonical path first, then the merged input folders. The
 * canonical path can be a checkout found only through a worktree's `.git` pointer or layout,
 * with no sessions of its own, so it is not always one of `memberPaths`; a group made of one
 * worktree plus that checkout still covers two folders, and the UI should say so.
 */
export function groupFolders(group: Pick<WorkspaceGroup, 'canonicalPath' | 'memberPaths'>): string[] {
	return [group.canonicalPath, ...group.memberPaths.filter(m => m !== group.canonicalPath)];
}

// ── Customization files of a group ───────────────────────────────────────────

/** The fields of a customization file entry the merge looks at. */
export interface GroupCustomizationFile {
	type: string;
	relativePath: string;
	lastModified: string | null;
	isStale: boolean;
}

/**
 * Merge the customization scans of every folder in a group into the group's file list, so a
 * file present in any member counts for the repository (instructions in the main checkout and
 * a skill only in a worktree are both found). The same repo-relative file seen in several
 * folders is kept once: the fresh copy over a stale one, then the most recently modified.
 */
export function mergeGroupCustomizationFiles<T extends GroupCustomizationFile>(scans: Array<T[] | undefined>): T[] {
	const byKey = new Map<string, T>();
	const better = (a: T, b: T): boolean => {
		if (a.isStale !== b.isStale) { return !a.isStale; }
		return (a.lastModified ?? '') > (b.lastModified ?? '');
	};
	for (const files of scans) {
		for (const file of files ?? []) {
			const key = `${file.type}\u0000${file.relativePath.replace(/\\/g, '/').toLowerCase()}`;
			const current = byKey.get(key);
			if (!current || better(file, current)) { byKey.set(key, file); }
		}
	}
	return [...byKey.values()];
}

// ── Detection ────────────────────────────────────────────────────────────────

/**
 * Report groups whose display name still looks like a worktree or clone artefact, i.e. the
 * grouping found nothing to fold it into. Used by the unit-test corpus (which asserts this is
 * empty) and at runtime, so a new naming pattern on a real machine shows up as a count in
 * Workspace Health instead of as one more row someone has to notice.
 */
export function detectArtefactWorkspaceNames(groups: WorkspaceGroup[]): ArtefactWorkspaceName[] {
	const found: ArtefactWorkspaceName[] = [];
	for (const g of groups) {
		if (isUnresolved(g.canonicalPath)) { continue; }
		let reason = classifyArtefactName(g.displayName);
		if (!reason) {
			// Still named after its own folder although that folder sits anywhere below a
			// `worktrees` folder: a layout the conventions do not know yet (e.g. /tmp/worktrees/repo/feature).
			const segments = splitSegments(g.canonicalPath).filter(Boolean).map(s => s.toLowerCase());
			const insideWorktrees = segments.slice(0, -1).some(s => WORKTREE_PARENTS.has(s));
			if (insideWorktrees && g.displayName.toLowerCase() === segments[segments.length - 1]) {
				reason = 'worktree-folder';
			}
		}
		if (reason) { found.push({ displayName: g.displayName, canonicalPath: g.canonicalPath, reason }); }
	}
	return found;
}
