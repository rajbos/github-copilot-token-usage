/**
 * GitHub Copilot **server-side** repository memories — discovery and analysis.
 *
 * Companion to `copilotMemoryFiles.ts`, which covers the *local* half: the Markdown
 * notes Copilot Chat's memory-tool writes under `workspaceStorage/<hash>/` on this
 * machine. This module covers the other half: the per-repository memory store GitHub
 * keeps server-side for the Copilot coding agent, the same list that renders under a
 * repository's `Settings -> Copilot -> Memory` page (in preview at time of writing).
 *
 * The two differ in a way that matters for how they may be surfaced. Local memory
 * files are reported **metadata-only** — their content is deliberately never read.
 * Server memories *are* content: the API returns the fact text, its citations and the
 * reasoning behind it, and there is nothing else to report. So this module reads and
 * renders that content, and the metadata-only rule from `copilotMemoryFiles.ts` does
 * not carry over. Nothing here is uploaded anywhere; it is fetched for the signed-in
 * user and analyzed in-process.
 *
 * ## Why analyze rather than just list
 *
 * A live repository's store is not a tidy set of facts. On this repository the store
 * held 340 memories in which the same graphify-setup fact appeared 14 times in
 * slightly different words, and roughly a third of all memories cited `AGENTS.md` or
 * another instruction file — the agent paying, repeatedly, to re-learn something it
 * had already been told. That repetition is the useful signal: a fact the agent keeps
 * rediscovering from code is a fact that belongs in a checked-in customization file
 * (`AGENTS.md`, `.github/copilot-instructions.md`, `.github/instructions/*`), where
 * every agent reads it for free on every run. {@link analyzeServerMemories} turns the
 * raw list into exactly that recommendation.
 *
 * ## API
 *
 * There is no public documentation for these routes; the contract below was taken
 * from the shipped Copilot CLI bundle (`~/.copilot/pkg/universal/<version>/index.js`),
 * which is their authoritative consumer, and verified against live repositories.
 *
 *   GET {base}/agents/swe/internal/memory/v0/{owner}/{repo}/enabled
 *       -> 200 `{ enabled: boolean }`
 *   GET {base}/agents/swe/internal/memory/v0/{owner}/{repo}/recent?limit=N
 *       -> 200 `ServerMemory[]`, or 204 No Content when the repository has none
 *
 * A PUT on the collection stores a memory. It is intentionally not implemented here:
 * this repository only ever reports on a memory store, so no code path of ours can
 * write to one.
 *
 * Two non-obvious requirements, both of which fail in ways that look like "there are
 * no memories" rather than like an error:
 *   - The scheme must be `Bearer`. A GitHub OAuth token works, but the `token` scheme
 *     that `gh api` sends is rejected with 401, as is `gh api`'s automatic
 *     `X-GitHub-Api-Version` header (`400 invalid apiVersion`).
 *   - `Copilot-Integration-Id` must name an integration the memory service recognizes.
 *     An unrecognized id (`vscode-chat`, for one) returns `403 memory is disabled for
 *     this client`, which reads like a repository setting but is not.
 */
import type {
	ServerMemory,
	ServerMemoriesAnalysis,
	ServerMemoriesAnalysisView,
	ServerMemoryPromotionGroup,
	ServerMemoryStaleCitation,
} from './types';

/** Copilot API host the memory routes live under. */
export const COPILOT_API_BASE = 'https://api.githubcopilot.com';

/** Path prefix for the SWE-agent memory routes, including the API generation (`v0`). */
export const MEMORY_API_PREFIX = 'agents/swe/internal/memory/v0';

/**
 * Integration id sent as `Copilot-Integration-Id`. This is the Copilot CLI's own id,
 * chosen because it is known to be accepted by these routes — an unrecognized id turns
 * every request into a 403 that is easily misread as "memory is off for this repo".
 */
export const MEMORY_INTEGRATION_ID = 'copilot-developer-cli';

/**
 * How many memories to request. The Copilot CLI asks for 20 because that is all it
 * wants to paste into a prompt; we are reporting on the whole store, so we ask for far
 * more. The server caps the response on its own (a live repository returned 340 for
 * both `limit=500` and `limit=1000`), so this is an upper bound, not a page size —
 * there is no pagination cursor on these routes.
 */
export const DEFAULT_MEMORY_LIMIT = 500;

/**
 * How long either memory request may take before it is aborted.
 *
 * A timeout is not merely polite here. The extension host guards against concurrent
 * fetches with an in-flight promise, so a request that *stalls* rather than fails never
 * settles, the guard never clears, and every later refresh skips the fetch — leaving the
 * section empty or stale until the window is reloaded. One hung socket would disable the
 * feature for the rest of the session. Fifteen seconds is far longer than this API takes
 * in practice while still bounding that failure.
 */
export const DEFAULT_MEMORY_TIMEOUT_MS = 15_000;

/**
 * Path fragments that mean "this fact is already written down somewhere an agent reads
 * anyway". A memory citing one of these is not a promotion candidate — at best it is
 * redundant with the instruction file it cites.
 *
 * `docs/` is included because this repository's `AGENTS.md` points agents at
 * `docs/README.md` as the documentation index, so a fact cited to `docs/` is reachable
 * from the instruction files rather than only from code.
 */
const INSTRUCTION_PATH_PATTERN = /(^|\/)(AGENTS\.md|CLAUDE\.md|copilot-instructions\.md)$|(^|\/)\.github\/(instructions|skills|agents)\/|(^|\/)docs\//i;

/** Citations the agent writes for facts learned from a person, which have no file to check. */
const USER_INPUT_CITATION_PATTERN = /^user input:/i;

/** Dependencies {@link fetchRepoMemories} needs from its host, so the module itself stays testable. */
export interface ServerMemoryFetchDeps {
	/**
	 * Returns a GitHub token for the signed-in user. Kept as a callback rather than a
	 * plain string so each host supplies it its own way — the CLI shells out to
	 * `gh auth token`, the extension uses VS Code's GitHub authentication provider —
	 * and so the token is only materialized at request time.
	 */
	getToken: () => Promise<string>;
	/** Injected for tests; defaults to the global `fetch`. */
	fetchFn?: typeof fetch;
	/** Overrides the API host, for a proxy or an enterprise endpoint. */
	apiBase?: string;
	/** Overrides {@link DEFAULT_MEMORY_TIMEOUT_MS}. */
	timeoutMs?: number;
}

/** Outcome of one memory-store read, including the failures that are not errors. */
export interface RepoMemoriesResult {
	/** `owner/name` the store was read for. */
	repo: string;
	/**
	 * Whether the repository has memory enabled, or `undefined` when the `enabled`
	 * route itself failed — deliberately tri-state, because "we could not ask" is a
	 * different answer from "the repository has it switched off".
	 */
	enabled: boolean | undefined;
	memories: ServerMemory[];
	/**
	 * The response filled the requested `limit`, so the store may hold more than was read.
	 * These routes have no pagination cursor, so this is the only signal available — and
	 * without it the counts derived from a clipped page would be reported as totals.
	 */
	truncated?: boolean;
	/** A human-readable reason the read did not produce memories, if it did not. */
	error?: string;
}

/** Build one memory-route URL. `suffix` is `'enabled'`, `'recent'`, or `''` for the collection. */
export function buildMemoryApiUrl(repo: string, suffix: string, limit?: number, apiBase: string = COPILOT_API_BASE): string {
	const url = new URL(`${apiBase}/${MEMORY_API_PREFIX}/${repo}/${suffix}`);
	if (limit !== undefined) {
		url.searchParams.set('limit', String(limit));
	}
	return url.toString();
}

/** Hosts whose remotes name a repository on GitHub.com. */
const GITHUB_HOSTS = new Set(['github.com', 'www.github.com', 'ssh.github.com']);

/**
 * URL schemes a git remote may legitimately use to reach GitHub.
 *
 * Checking the host alone is not enough: `file://github.com/owner/repo` and
 * `ftp://github.com/owner/repo` both pass a hostname test while naming something that is
 * not a GitHub remote at all. Accepting one would make us send the user's token to the
 * Copilot API asking about a repository this checkout has no relationship to.
 */
const GIT_REMOTE_SCHEMES = new Set(['https:', 'http:', 'ssh:', 'git:', 'git+ssh:']);

/**
 * Parse `owner/name` out of a git remote URL, accepting the SSH
 * (`git@github.com:owner/name.git`), `ssh://` and HTTPS
 * (`https://github.com/owner/name`) spellings. Returns `undefined` for a remote that is
 * not a GitHub.com repository, so a caller can report "not a GitHub repo" rather than
 * issuing a doomed request.
 *
 * The host is matched **exactly**, not merely found in the string. A substring match
 * would accept `https://notgithub.com/owner/repo` and `https://github.com.evil.test/x/y`,
 * and the caller would then send the user's token to api.githubcopilot.com asking for an
 * unrelated repository's memories — surfacing another repo's facts as if they were this
 * checkout's.
 */
export function parseRepoFromRemoteUrl(remoteUrl: string): string | undefined {
	const trimmed = remoteUrl.trim();
	if (!trimmed) { return undefined; }

	// scp-style SSH (`[user@]host:owner/name`) is not a URL and must be split by hand; the
	// colon separating host from path is the first one, and a `//` marks a real URL instead.
	const scpMatch = /^(?:[^@/]+@)?([^/:]+):(?!\/)(.+)$/.exec(trimmed);
	const { host, path } = scpMatch
		? { host: scpMatch[1], path: scpMatch[2] }
		: parseUrlHostAndPath(trimmed);
	if (!host || !GITHUB_HOSTS.has(host.toLowerCase())) { return undefined; }

	// Trailing slashes come off before the `.git` suffix, not after: `…/name.git/` is a real
	// remote spelling, and stripping in the other order leaves the `.git` on the name.
	const segments = path
		// A `?query` or `#fragment` is not part of the repository name. The scp-style branch
		// never goes through the URL parser, so without this
		// `git@github.com:owner/repo.git?token=secret` yields a "name" of
		// `repo.git?token=secret`, and buildMemoryApiUrl() then sends that credential to the
		// Copilot API inside the request URL — right past the redaction that only guards
		// diagnostics. Both branches are stripped here so neither can carry one through.
		.replace(/[?#].*$/, '')
		.replace(/^\/+/, '')
		.replace(/\/+$/, '')
		.replace(/\.git$/i, '')
		.split('/');
	// Exactly owner/name — anything deeper is a URL into a repository (a blob, an issue),
	// not the repository remote itself — and each segment must look like a GitHub name.
	return segments.length === 2 && segments.every(isValidRepoSegment)
		? `${segments[0]}/${segments[1]}`
		: undefined;
}

/**
 * Does this look like a GitHub owner or repository name?
 *
 * The slug is interpolated into the request URL, so an unconstrained segment is an
 * injection point: a stray `?`, `%2f`, `@` or space would let a remote steer the request
 * somewhere other than the repository it names. GitHub's own names are limited to this
 * character set, so anything outside it is rejected rather than escaped, and the relative
 * path segments `.` and `..` are excluded explicitly since the charset would otherwise
 * admit them.
 */
function isValidRepoSegment(segment: string): boolean {
	return /^[A-Za-z0-9._-]+$/.test(segment) && segment !== '.' && segment !== '..';
}

/**
 * Is this an `owner/name` slug safe to interpolate into a request URL?
 *
 * Exported because a slug does not only arrive from a git remote: both the CLI and the
 * probe accept `--repo`, and an unvalidated value there reaches the same URL builder that
 * {@link parseRepoFromRemoteUrl} guards so carefully. Validating once here, and enforcing it
 * in {@link fetchRepoMemories}, means no caller can skip the check by taking a different
 * route to the same request.
 */
export const INVALID_REPO_LABEL = '<invalid repository>';

/**
 * A repository label safe to print. Returns the slug when it is well formed, and a fixed
 * placeholder otherwise.
 *
 * A rejected `--repo` value is untrusted input that may itself carry a credential
 * (`owner/repo?token=secret`), so echoing it back in an error would leak exactly what the
 * validation just refused to send — the same mistake `redactRemoteUrl()` exists to prevent
 * for git remotes, one step further along.
 */
export function safeRepoLabel(slug: string): string {
	return isValidRepoSlug(slug) ? slug : INVALID_REPO_LABEL;
}

export function isValidRepoSlug(slug: string): boolean {
	const segments = slug.split('/');
	return segments.length === 2 && segments.every(isValidRepoSegment);
}

/** Host and path of a parseable absolute URL, or empty strings when it is not one. */
function parseUrlHostAndPath(candidate: string): { host: string; path: string } {
	try {
		const url = new URL(candidate);
		if (!GIT_REMOTE_SCHEMES.has(url.protocol)) { return { host: '', path: '' }; }
		return { host: url.hostname, path: url.pathname };
	} catch {
		return { host: '', path: '' };
	}
}

/**
 * Read one repository's memory store.
 *
 * Never throws: every failure — no token, a rejected integration id, a repository the
 * token cannot see — comes back as a `RepoMemoriesResult` with an `error` and no
 * memories. This is a reporting feature layered onto an undocumented preview API, so a
 * server-side change must degrade the memory section rather than fail the command or
 * the view around it.
 */
export async function fetchRepoMemories(
	repo: string,
	deps: ServerMemoryFetchDeps,
	limit: number = DEFAULT_MEMORY_LIMIT,
): Promise<RepoMemoriesResult> {
	const fetchFn = deps.fetchFn ?? fetch;
	const apiBase = deps.apiBase ?? COPILOT_API_BASE;
	const timeoutMs = deps.timeoutMs ?? DEFAULT_MEMORY_TIMEOUT_MS;

	// Refuse to build a URL from a slug we have not vetted. A remote-derived slug is already
	// validated, but `--repo` is not a remote — this is the one place every path converges.
	if (!isValidRepoSlug(repo)) {
		// Neither the label nor the message may carry the rejected value: a caller that prints
		// this result would otherwise surface the credential the request was blocked over.
		return { repo: INVALID_REPO_LABEL, enabled: undefined, memories: [], error: 'Not a valid owner/name repository.' };
	}

	let token: string;
	try {
		token = await deps.getToken();
	} catch (error) {
		return { repo, enabled: undefined, memories: [], error: `Could not get a GitHub token: ${errorMessage(error)}` };
	}
	if (!token) {
		return { repo, enabled: undefined, memories: [], error: 'No GitHub token available.' };
	}

	const headers = {
		Authorization: `Bearer ${token}`,
		'Copilot-Integration-Id': MEMORY_INTEGRATION_ID,
		Accept: 'application/json',
	};

	const enabled = await readEnabledFlag(buildMemoryApiUrl(repo, 'enabled', undefined, apiBase), headers, fetchFn, timeoutMs);
	// Only on an explicit `false` — `undefined` means the enablement check itself failed, and
	// the store may well still answer. A disabled repository can reject the `recent` route
	// with a 403, which would come back as an `error` and render as "could not be read"; the
	// renderer checks `error` before `enabled`, so the honest "memory is turned off here"
	// answer would lose to a misleading one. Skipping the request also saves a pointless
	// authenticated round trip.
	if (enabled === false) {
		return { repo, enabled: false, memories: [] };
	}

	let response: Response;
	try {
		response = await fetchFn(buildMemoryApiUrl(repo, 'recent', limit, apiBase), { headers, signal: requestTimeoutSignal(timeoutMs) });
	} catch (error) {
		return { repo, enabled, memories: [], error: `Memory request failed: ${errorMessage(error)}` };
	}

	// 204 is the server's "this repository has no memories" — a successful empty read,
	// not a failure, and it has no body to parse.
	if (response.status === 204) {
		return { repo, enabled, memories: [] };
	}
	if (!response.ok) {
		const body = await safeText(response);
		return { repo, enabled, memories: [], error: `HTTP ${response.status}: ${body}` };
	}

	let parsed: unknown;
	try {
		parsed = await response.json();
	} catch (error) {
		return { repo, enabled, memories: [], error: `Malformed memory response: ${errorMessage(error)}` };
	}
	if (!Array.isArray(parsed)) {
		return { repo, enabled, memories: [], error: 'Memory response was not an array.' };
	}
	// `recent` is bounded by `limit` and these routes carry no pagination cursor, so a store
	// larger than the limit comes back silently clipped. Compare against the raw array, not
	// the filtered one: dropping a malformed record must not disguise a full page as a
	// partial one. The caller needs this because every number downstream — totalMemories,
	// the subject count, the stale scan, the promotion ranking — would otherwise be
	// presented as describing the whole store when it describes a prefix of it.
	return { repo, enabled, memories: parsed.filter(isServerMemory), truncated: parsed.length >= limit };
}

/** Read the `enabled` flag, collapsing every failure to `undefined` ("could not ask"). */
async function readEnabledFlag(url: string, headers: Record<string, string>, fetchFn: typeof fetch, timeoutMs: number): Promise<boolean | undefined> {
	try {
		const response = await fetchFn(url, { headers, signal: requestTimeoutSignal(timeoutMs) });
		if (!response.ok) { return undefined; }
		const body = await response.json() as { enabled?: unknown };
		return typeof body?.enabled === 'boolean' ? body.enabled : undefined;
	} catch {
		return undefined;
	}
}

/**
 * An abort signal that fires after `timeoutMs`, or undefined where the runtime has no
 * `AbortSignal.timeout` — in which case the request simply runs unbounded, as it did
 * before, rather than failing outright.
 */
function requestTimeoutSignal(timeoutMs: number): AbortSignal | undefined {
	return typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined;
}

async function safeText(response: Response): Promise<string> {
	try { return (await response.text()).slice(0, 500); } catch { return '<unreadable body>'; }
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Narrow one element of the API response to a {@link ServerMemory}.
 *
 * Only the fields this module actually uses are required. The response carries more
 * than that (`scope`, `billingOrganizationId`, `billingEnterpriseId`, and a `source`
 * whose exact members have already drifted from what the CLI writes), and this is an
 * undocumented preview API, so an unexpectedly-shaped record is dropped rather than
 * allowed to crash a report — and an added field is simply carried along.
 */
function isServerMemory(value: unknown): value is ServerMemory {
	if (typeof value !== 'object' || value === null) { return false; }
	const candidate = value as Partial<ServerMemory>;
	return typeof candidate.id === 'string'
		&& typeof candidate.subject === 'string'
		&& typeof candidate.fact === 'string'
		// Every element must be a string, not merely the array itself an array: the analysis
		// calls `.trim()` on each citation, so a single `null` element would throw out of
		// `analyzeServerMemories()` and take the whole report with it — rejecting the CLI
		// command, or blanking the webview section, over one malformed record.
		&& Array.isArray(candidate.citations)
		&& candidate.citations.every(citation => typeof citation === 'string');
}

/** Does this citation point at a file an agent already reads as instructions? */
export function isInstructionCitation(citation: string): boolean {
	const filePath = citationFilePath(citation);
	// The same safety gate the staleness scan applies, for the same reason: a citation that
	// does not name a file inside this checkout is evidence about this repository of no kind.
	// Without it `../../AGENTS.md` or `/etc/AGENTS.md` marks a memory "already documented",
	// which both inflates documentedCount and — worse — suppresses an otherwise valid
	// promotion group, since one documented member disqualifies the whole subject. A
	// server-supplied citation could therefore quietly switch the feature off, subject by
	// subject, and the report would look entirely healthy while doing it.
	if (!filePath || !isSafeRepoRelativePath(filePath)) { return false; }
	return INSTRUCTION_PATH_PATTERN.test(filePath);
}

/**
 * Extract the file path from a citation, which the agent writes as `path/file.ts:12-30`
 * or `path/file.ts:12`. Returns `undefined` for a `User input: ...` citation, which
 * names no file and must not be treated as one — a fact learned from a person has no
 * path to check for staleness and no instruction file to have come from.
 *
 * Windows drive letters are handled by ignoring a single-character first segment, so
 * `C:/x/y.ts` does not get truncated to `C`.
 */
export function citationFilePath(citation: string): string | undefined {
	const trimmed = citation.trim();
	if (!trimmed || USER_INPUT_CITATION_PATTERN.test(trimmed)) { return undefined; }
	const colonIndex = trimmed.indexOf(':', trimmed.length > 1 && trimmed[1] === ':' ? 2 : 0);
	const filePath = (colonIndex === -1 ? trimmed : trimmed.slice(0, colonIndex)).trim();
	return filePath || undefined;
}

/**
 * Is this citation path safe to resolve against a checkout root and probe on disk?
 *
 * Citations are server-supplied, and the agent that wrote them takes repository content as
 * input, so a citation is untrusted text — not a guaranteed repo-relative path. Passing one
 * straight to `path.resolve(root, …)` lets `/etc/passwd:1` or `../../../outside.txt:1`
 * escape the checkout entirely, turning the staleness check into an arbitrary-path existence
 * probe whose answer is then reported back as a "stale citation" flag.
 *
 * The check lives here rather than in each host's `fileExists` callback deliberately: the
 * same mistake was made independently in the CLI and the extension, which is exactly what a
 * trust boundary enforced at two call sites produces. Guaranteeing it in the one place that
 * *calls* the callback makes every present and future consumer safe by construction.
 *
 * A rejected citation is treated as un-checkable rather than as missing — the same way a
 * `User input:` citation is — so a suspicious path never counts toward staleness.
 */
export function isSafeRepoRelativePath(citationPath: string): boolean {
	if (!citationPath) { return false; }
	// POSIX absolute, UNC, and Windows drive-qualified paths all escape `root` outright.
	if (/^[/\\]/.test(citationPath) || /^[A-Za-z]:/.test(citationPath)) { return false; }
	// Any `..` segment can climb out, on either separator.
	return !citationPath.split(/[/\\]/).includes('..');
}

/** The `fs`/`path` surface {@link createRepoFileExists} needs, injected so it can be tested. */
export interface RepoFileExistsDeps {
	realpathSync: (target: string) => string;
	resolve: (...parts: string[]) => string;
	relative: (from: string, to: string) => string;
	isAbsolute: (target: string) => boolean;
}

/**
 * Build the `fileExists` callback for a checkout, one that cannot be walked out of.
 *
 * {@link isSafeRepoRelativePath} is a *lexical* check: it rejects absolute paths and `..`
 * segments, which is necessary but not sufficient. `existsSync` follows symlinks, so a
 * repository containing `link-to-outside -> /etc` makes the citation
 * `link-to-outside/passwd:1` lexically innocent and yet a probe of a path outside the
 * checkout — and the answer comes back to the server's author as a stale-citation flag.
 *
 * So the real path is resolved and required to stay under the real root. The root is
 * realpath'd too, since a checkout can itself live behind a symlink (a macOS `/tmp` path,
 * a linked worktree) and comparing a real path against a symlinked root would then reject
 * everything.
 *
 * A path that does not exist throws from `realpathSync` and is reported as missing, which
 * is exactly what the staleness check wants. A path that exists but resolves outside is
 * reported missing too: we will not confirm to a remote server that a file beyond the
 * checkout is there.
 *
 * Lives here rather than in each host because the same mistake has now been made
 * independently in both, and the callers are the ones this helper exists to protect.
 */
export function createRepoFileExists(repoRoot: string, deps?: RepoFileExistsDeps): (relativePath: string) => boolean {
	const io: RepoFileExistsDeps = deps ?? defaultRepoFileExistsDeps();
	let realRoot: string;
	try {
		realRoot = io.realpathSync(io.resolve(repoRoot));
	} catch {
		// An unresolvable root (deleted, permission-denied) still gives a usable lexical base.
		realRoot = io.resolve(repoRoot);
	}

	return (relativePath: string): boolean => {
		// Re-checked here, not just in the caller, so the helper is safe on its own terms.
		if (!isSafeRepoRelativePath(relativePath)) { return false; }
		try {
			const real = io.realpathSync(io.resolve(realRoot, relativePath));
			const rel = io.relative(realRoot, real);
			return rel === '' || (!rel.startsWith('..') && !io.isAbsolute(rel));
		} catch {
			return false;
		}
	};
}

function defaultRepoFileExistsDeps(): RepoFileExistsDeps {
	const fs = require('fs') as typeof import('fs');
	const path = require('path') as typeof import('path');
	return {
		realpathSync: (target) => fs.realpathSync(target),
		resolve: (...parts) => path.resolve(...parts),
		relative: (from, to) => path.relative(from, to),
		isAbsolute: (target) => path.isAbsolute(target),
	};
}

/**
 * Normalize a subject for grouping. The agent writes free-text 1-2 word subjects, so
 * the same topic arrives as `Usage tab groups`, `usage tab groups` and `usage tabs` —
 * case and punctuation differences alone accounted for several apparent "distinct"
 * subjects on a live store.
 */
function normalizeSubject(subject: string): string {
	// Unicode-aware on purpose. An `[^a-z0-9]` class deletes every non-ASCII letter, so a
	// repository whose agent writes Chinese or Japanese subjects would collapse all of them
	// to the empty string and group entirely unrelated memories into one bogus "subject",
	// while accented Latin subjects would silently lose characters. Both corrupt
	// `distinctSubjects` and the promotion ranking that is the whole point of the report.
	return subject.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Dependencies {@link analyzeServerMemories} needs, kept injectable so the analysis is pure. */
export interface ServerMemoryAnalysisDeps {
	/**
	 * Whether a repo-relative citation path still exists in the working tree. Injected
	 * rather than calling `fs` directly so the analysis can be unit-tested without a
	 * fixture tree, and so a host that has no checkout (or only a virtual one) can opt
	 * out of staleness detection by returning `true`.
	 *
	 * The caller guarantees this is only ever invoked with a path that passed
	 * {@link isSafeRepoRelativePath} — never absolute, never containing a `..` segment —
	 * so an implementation may resolve it against its checkout root directly.
	 */
	fileExists: (repoRelativePath: string) => boolean;
}

/**
 * Turn a raw memory list into the report the feature actually shows.
 *
 * The headline output is {@link ServerMemoriesAnalysis.promotionGroups}: memories
 * grouped by normalized subject, keeping only groups where *no* member cites an
 * instruction file, ranked by how many times the agent has re-learned the same thing.
 * A group of one is a fact learned once; a group of fourteen is the agent burning a
 * code-review pass rediscovering something `AGENTS.md` could have told it. Both are
 * promotion candidates, but the repeats are the ones worth acting on first, so the
 * ranking is by repeat count rather than by recency — which is also the only ranking
 * available, since the API returns no timestamps.
 */
/** What one pass over the memory list establishes, before any grouping or ranking. */
interface MemoryScan {
	/** Memories grouped by normalized subject, in first-seen order. */
	bySubject: Map<string, ServerMemory[]>;
	/** Ids of memories citing an instruction file — already written down somewhere. */
	documentedIds: Set<string>;
	/**
	 * Ids of memories with at least one citation naming a verifiable file in this repository.
	 * The promotion pitch is "the agent keeps re-deriving this from code, so write it down",
	 * which is only true of a fact that came from code and can be checked against it.
	 */
	codeDerivedIds: Set<string>;
	staleCitations: ServerMemoryStaleCitation[];
}

/** Classify every memory once: subject, whether it is documented, code-derived, and stale. */
function scanMemories(memories: ServerMemory[], deps: ServerMemoryAnalysisDeps): MemoryScan {
	const scan: MemoryScan = {
		bySubject: new Map<string, ServerMemory[]>(),
		documentedIds: new Set<string>(),
		codeDerivedIds: new Set<string>(),
		staleCitations: [],
	};

	for (const memory of memories) {
		const key = normalizeSubject(memory.subject);
		const group = scan.bySubject.get(key);
		if (group) { group.push(memory); } else { scan.bySubject.set(key, [memory]); }

		const checkable: string[] = [];
		for (const citation of memory.citations) {
			if (isInstructionCitation(citation)) { scan.documentedIds.add(memory.id); }
			const filePath = citationFilePath(citation);
			// Only repo-relative paths are ever handed to the host's `fileExists`: see
			// isSafeRepoRelativePath() for why this guard belongs here and not in the callback.
			if (filePath && isSafeRepoRelativePath(filePath)) { checkable.push(filePath); }
		}

		// `checkable` holds only citations that name a safe repo-relative path. A memory with
		// none — one citing `User input: ...`, or nothing but an absolute/traversing path — has
		// no code evidence behind it at all.
		if (checkable.length > 0) { scan.codeDerivedIds.add(memory.id); }

		const missing = checkable.filter(filePath => !deps.fileExists(filePath));
		if (missing.length > 0) {
			scan.staleCitations.push({
				id: memory.id,
				subject: memory.subject,
				fact: memory.fact,
				missingPaths: missing,
				// A memory every one of whose checkable citations has vanished is not just
				// partly out of date — there is nothing left in the tree backing it, so it
				// is the one an agent should stop being told.
				fullyStale: missing.length === checkable.length,
			});
		}
	}
	return scan;
}

/**
 * Rank the subjects worth writing into an instruction file.
 *
 * A subject qualifies only when nothing in it already cites an instruction file (it would
 * be redundant) and something in it cites verifiable code (otherwise the "the agent keeps
 * re-deriving this" pitch is simply untrue). Ranked by how often the same thing has been
 * re-learned, which is also the only ranking available — the API returns no timestamps.
 */
function buildPromotionGroups(scan: MemoryScan): ServerMemoryPromotionGroup[] {
	const groups: ServerMemoryPromotionGroup[] = [];
	for (const [subjectKey, group] of scan.bySubject) {
		if (group.some(memory => scan.documentedIds.has(memory.id))) { continue; }
		if (!group.some(memory => scan.codeDerivedIds.has(memory.id))) { continue; }
		groups.push({
			subject: subjectKey,
			displaySubject: group[0].subject,
			repeatCount: group.length,
			// The longest fact is kept as the representative: when the agent restates one
			// fact many times the wordings differ mainly by how much detail survived, and
			// the fullest wording is the most useful starting text for an instruction file.
			representativeFact: group.reduce((longest, m) => (m.fact.length > longest.length ? m.fact : longest), group[0].fact),
			citations: Array.from(new Set(group.flatMap(m => m.citations))).sort(),
			memoryIds: group.map(m => m.id),
		});
	}
	groups.sort((a, b) => b.repeatCount - a.repeatCount || a.subject.localeCompare(b.subject));
	return groups;
}

export function analyzeServerMemories(
	result: RepoMemoriesResult,
	deps: ServerMemoryAnalysisDeps,
): ServerMemoriesAnalysis {
	const memories = result.memories;
	const scan = scanMemories(memories, deps);
	const promotionGroups = buildPromotionGroups(scan);

	return {
		repo: result.repo,
		enabled: result.enabled,
		error: result.error,
		truncated: result.truncated === true,
		totalMemories: memories.length,
		distinctSubjects: scan.bySubject.size,
		documentedCount: scan.documentedIds.size,
		promotionCandidateCount: promotionGroups.reduce((sum, g) => sum + g.repeatCount, 0),
		repeatedGroupCount: promotionGroups.filter(g => g.repeatCount > 1).length,
		promotionGroups,
		// Memories with no verifiable file citation — user-stated preferences and the like.
		// Never promoted; surfaced so the report does not appear to have simply lost them.
		unverifiableCount: memories.filter(memory => !scan.codeDerivedIds.has(memory.id)).length,
		staleCitations: scan.staleCitations,
		fullyStaleCount: scan.staleCitations.filter(c => c.fullyStale).length,
		byAgent: countBy(memories, m => m.source?.agent),
		byModel: countBy(memories, m => m.source?.baseModel),
	};
}

/**
 * Count occurrences of a server-supplied key.
 *
 * Accumulates in a `Map`, not a plain object. An object inherits from
 * `Object.prototype`, so `counts[key]` for any of its members — `toString`, `valueOf`,
 * `hasOwnProperty`, `constructor` — reads the inherited function rather than undefined;
 * it is truthy, `?? 0` keeps it, and the count becomes a string. A skip-list of the three
 * pollution-dangerous keys (the earlier fix here) covered only part of that set, because
 * the problem is inheritance generally and not prototype pollution specifically. A Map has
 * no inherited keys at all, so every name counts correctly and none of them can reach a
 * shared prototype. `Object.fromEntries` then materializes own data properties, including
 * for `__proto__`, leaving `Object.prototype` untouched.
 *
 * The runtime `typeof` check is not redundant with the type: `source` comes from the
 * server and `isServerMemory()` does not validate its members, so a non-string can arrive
 * — and coercing an arbitrary object to a key can itself throw.
 */
function countBy(memories: ServerMemory[], keyOf: (memory: ServerMemory) => string | undefined): Record<string, number> {
	const counts = new Map<string, number>();
	for (const memory of memories) {
		const key = keyOf(memory);
		if (typeof key !== 'string' || key === '') { continue; }
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return Object.fromEntries(counts);
}

/** How many promotion groups the webview projection carries. */
export const VIEW_PROMOTION_GROUP_LIMIT = 10;

/**
 * Project the analysis down to what the Usage Analysis webview renders.
 *
 * Unlike {@link toMemoryFilesAnalysisView}, this keeps fact text — for server memories
 * the fact *is* the finding, and a promotion suggestion the user cannot read is not a
 * suggestion. What it drops is bulk: only the top {@link VIEW_PROMOTION_GROUP_LIMIT}
 * groups travel, since a store of several hundred memories would otherwise push a
 * payload far larger than the rest of the view through `postMessage`.
 */
export function toServerMemoriesAnalysisView(analysis: ServerMemoriesAnalysis | null): ServerMemoriesAnalysisView | null {
	if (!analysis) { return null; }
	return {
		repo: analysis.repo,
		enabled: analysis.enabled,
		error: analysis.error,
		truncated: analysis.truncated,
		totalMemories: analysis.totalMemories,
		distinctSubjects: analysis.distinctSubjects,
		documentedCount: analysis.documentedCount,
		promotionCandidateCount: analysis.promotionCandidateCount,
		repeatedGroupCount: analysis.repeatedGroupCount,
		fullyStaleCount: analysis.fullyStaleCount,
		topPromotionGroups: analysis.promotionGroups.slice(0, VIEW_PROMOTION_GROUP_LIMIT).map(group => ({
			displaySubject: group.displaySubject,
			repeatCount: group.repeatCount,
			representativeFact: group.representativeFact,
			citationCount: group.citations.length,
		})),
	};
}

/**
 * Render the promotion groups as a Markdown block ready to paste into `AGENTS.md` or
 * `.github/copilot-instructions.md`.
 *
 * Deliberately produced as text for a human to edit and commit rather than written to
 * the instruction file directly: these facts are an agent's unverified observations —
 * some of a live store's memories cited files that no longer exist — and an
 * instruction file is the one place in the repository where a wrong statement is read
 * by every agent on every run.
 */
export function renderPromotionMarkdown(analysis: ServerMemoriesAnalysis, limit: number = VIEW_PROMOTION_GROUP_LIMIT): string {
	const groups = analysis.promotionGroups.slice(0, limit);
	if (groups.length === 0) {
		// "Every memory is already documented" is only true when there were memories to begin
		// with. A disabled repository and an empty store also produce zero groups, and
		// reporting either as "nothing left to write down" is a flattering lie.
		if (analysis.enabled === false) {
			return '_Memory is turned off for this repository, so there is nothing to promote._\n';
		}
		if (analysis.totalMemories === 0) {
			return '_This repository has no stored memories yet, so there is nothing to promote._\n';
		}
		return '_No promotion candidates: every stored memory already cites an instruction file._\n';
	}
	const lines = [
		`<!-- Suggested from ${analysis.totalMemories}${analysis.truncated ? '+ (truncated)' : ''} Copilot server memories for ${flattenForMarkdown(analysis.repo)}.`,
		'     Each fact is an agent observation — verify it against the citations before committing. -->',
		'',
	];
	for (const group of groups) {
		const seen = group.repeatCount > 1 ? ` _(re-learned ${group.repeatCount}x)_` : '';
		lines.push(`- **${flattenForMarkdown(group.displaySubject)}**${seen} — ${flattenForMarkdown(group.representativeFact)}`);
		if (group.citations.length > 0) {
			lines.push(`  - Sources: ${group.citations.slice(0, 5).map(flattenForMarkdown).join(', ')}`);
		}
	}
	lines.push('');
	return lines.join('\n');
}

/**
 * Reduce a server-supplied string to something that cannot restructure the Markdown it is
 * embedded in.
 *
 * Memory text is written by an agent, and an agent's input includes repository content, so
 * it must be treated as untrusted. This output is explicitly offered as paste-ready for
 * `AGENTS.md` — the one file whose every line is read by every agent on every run — so a
 * fact that escapes its list item does not merely render oddly, it becomes an instruction.
 *
 * Two escapes matter and both are closed here:
 *   - **Line breaks.** A newline ends the list item, so `fact\n## Ignore the above` would
 *     land in the file as a heading of its own. Every line terminator, including the
 *     Unicode separators U+2028/U+2029, is folded into a single space.
 *   - **`-->`.** The header is an HTML comment holding the "verify before committing"
 *     caveat; a repo slug or fact containing `-->` would close it early and promote the
 *     remainder to live document text. The sequence is broken rather than dropped so the
 *     tampering stays visible to whoever reviews the block.
 *
 * Markdown emphasis characters are deliberately left alone: they can only make a line
 * render oddly, which a human pasting the block will see, and escaping them would make
 * ordinary facts about `*` globs or `_` names unreadable.
 */
function flattenForMarkdown(value: string): string {
	return sanitizeForDisplay(value)
		.replace(/--+>/g, '-- >')
		.replace(/<!--+/g, '< !--');
}

/**
 * Reduce a server-supplied string to a single line of printable text.
 *
 * Every consumer of this data eventually writes it somewhere that interprets control
 * characters — a terminal for the CLI report and the probe, a Markdown file for
 * `--promote`. Memory text is agent-written from repository content, so an ESC/OSC/CSI
 * sequence can arrive in a `fact` and, printed verbatim, reprogram the reader's terminal:
 * set its title, drive the clipboard, or hide text that is actually there. A report whose
 * job is to tell you what an agent learned must not be able to act on the machine reading
 * it.
 *
 * So: strip C0 controls (including ESC and BEL), DEL and the C1 range, then collapse all
 * remaining whitespace — which also removes the line breaks that would otherwise let a fact
 * escape its list item or report line. Tabs and newlines are collapsed rather than kept,
 * because every caller renders one line per field.
 */
export function sanitizeForDisplay(value: string): string {
	return value
		.replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

