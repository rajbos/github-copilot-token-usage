#!/usr/bin/env node
'use strict';
/**
 * Fetch GitHub Copilot's *server-side* repository memories — "what has the coding
 * agent already learned about this repo?"
 *
 * This repo already reports Copilot's **local** memory files (the Markdown notes
 * `GitHub.copilot-chat`'s memory-tool writes under `workspaceStorage/<hash>/`, see
 * `src/copilotMemoryFiles.ts` and the `memory-files` CLI command). Those are
 * per-machine. GitHub additionally keeps a *server-side*, per-repository memory store
 * for the Copilot coding agent (SWE agent) — the same list that renders under
 * `Settings -> Copilot -> Memory` on a repository, currently in preview. Nothing in
 * this repo reads that store yet; this script is the discovery probe for it.
 *
 * ## API contract
 *
 * Reverse-engineered from the shipped Copilot CLI bundle
 * (`~/.copilot/pkg/universal/<version>/index.js`), which is the authoritative
 * consumer — there is no public documentation for these routes. The base URL is the
 * public Copilot API host, hard-coded below as COPILOT_API_BASE. (The Copilot CLI also
 * supports deriving it from a configured agent endpoint; this probe deliberately does
 * not, and is public-GitHub only throughout.)
 *
 *   GET  {base}/agents/swe/internal/memory/v0/{owner}/{repo}/enabled
 *        -> 200 `{ "enabled": boolean }`
 *   GET  {base}/agents/swe/internal/memory/v0/{owner}/{repo}/recent?limit=N
 *        -> 200 `MemoryResponse[]`, or 204 No Content when the repo has none.
 *        The CLI requests `limit=20` — that is its own constant, not a server cap.
 *   PUT  {base}/agents/swe/internal/memory/v0/{owner}/{repo}
 *        -> stores one memory. Deliberately NOT implemented here: this script is
 *           read-only, so running it can never pollute a repository's memory store.
 *
 * Required headers are `Authorization: Bearer <token>` and `Copilot-Integration-Id`.
 * Note the `Bearer` scheme specifically — `gh api` sends `Authorization: token <t>`,
 * which these routes reject with 401, so the request is made with `fetch` directly
 * rather than through `gh api`.
 *
 * `MemoryResponse`, as observed on a live repository:
 *   { id, subject, fact, citations: string[], reason, scope: "repository",
 *     source: { interactionId, agent, baseModel },
 *     billingOrganizationId, billingEnterpriseId }
 * Note there is no timestamp: the server returns "recent" in its own usefulness
 * ranking (matching the web UI's "Ranked by usefulness"), so memories cannot be
 * aged locally — only their citations can be checked for staleness. `source` also
 * carries no `integrationId`, despite the CLI's own write payload sending one.
 * Unknown fields are printed rather than dropped, so schema drift shows up here
 * instead of being silently projected away.
 *
 * ## Credentials
 *
 * The token is read from `gh auth token` and used only as a request header. It is
 * never printed, written to disk, or included in any output — including `--json`
 * and error output, where only the HTTP status and response body are surfaced.
 *
 * Usage:
 *   node scripts/fetch-copilot-memories.js [--repo owner/name] [--limit N] [--json]
 */

const { execFileSync } = require('child_process');

const COPILOT_API_BASE = 'https://api.githubcopilot.com';
const MEMORY_PATH_PREFIX = 'agents/swe/internal/memory/v0';
/** The Copilot CLI's own default; mirrored so our output matches what an agent would actually see. */
const DEFAULT_LIMIT = 20;
/**
 * The integration id must be one the memory service recognizes, otherwise every route
 * answers `403 memory is disabled for this client` — `vscode-chat`, for instance, is
 * rejected. This is the Copilot CLI's own id, so it is known-good for these routes.
 */
const INTEGRATION_ID = 'copilot-developer-cli';

/**
 * How long either request may take before it is aborted.
 *
 * A stalled connection would otherwise leave this diagnostic waiting forever with nothing
 * on screen — the worst possible behaviour for a script whose whole job is to tell you what
 * the API returned. Mirrors DEFAULT_MEMORY_TIMEOUT_MS in `src/copilotServerMemories.ts`.
 */
const REQUEST_TIMEOUT_MS = 15_000;

function parseArgs(argv) {
	const options = { repo: undefined, limit: DEFAULT_LIMIT, json: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--json') {
			options.json = true;
		} else if (arg === '--repo') {
			// A missing value must be rejected, not stored as undefined: main() falls back to
			// the origin remote when `repo` is unset, so `--repo` as the final argument would
			// silently report on the current checkout instead of the repository the user
			// thought they had named — a wrong answer presented as a right one.
			const value = argv[++i];
			if (value === undefined) {
				throw new Error('--repo requires a value (owner/name).');
			}
			options.repo = value;
		} else if (arg === '--limit') {
			// `Number(undefined)` is NaN, so a missing value already fails the check below;
			// rejecting it explicitly keeps the two options reading the same way.
			const raw = argv[++i];
			if (raw === undefined) {
				throw new Error('--limit requires a value.');
			}
			const value = Number(raw);
			if (!Number.isInteger(value) || value < 1) {
				throw new Error('--limit must be a positive integer');
			}
			options.limit = value;
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}
	return options;
}

/** Hosts whose remotes name a repository on GitHub.com. */
const GITHUB_HOSTS = new Set(['github.com', 'www.github.com', 'ssh.github.com']);

/**
 * URL schemes a git remote may legitimately use to reach GitHub. Checking the host alone
 * would accept `file://github.com/owner/repo`, which names a local remote, not a GitHub one
 * — and this script would then send its token to the API for that unrelated slug. Mirrors
 * GIT_REMOTE_SCHEMES in `src/copilotServerMemories.ts`; the two authenticated entry points
 * must not diverge.
 */
const GIT_REMOTE_SCHEMES = new Set(['https:', 'http:', 'ssh:', 'git:', 'git+ssh:']);

/**
 * Reduce a remote URL to the parts that are safe to print: scheme, host and path.
 *
 * A git remote can carry an embedded credential, and this script promises above that it never
 * prints one. An error message quoting the remote verbatim would break that promise for the
 * remote shapes most likely to be misconfigured, so everything that can hold a secret is
 * removed first — the `user:password@` userinfo, and also the query and fragment, since
 * `https://host/o/r?token=secret` is just as much a leak and a remote never needs either for
 * the host/owner/repo this message is about. Dropping them wholesale beats trying to
 * recognize which parameter is the secret one.
 */
function redactRemoteUrl(remoteUrl) {
	const scpMatch = /^([^@/]+)@([^/:]+):(.+)$/.exec(remoteUrl);
	if (scpMatch) {
		// scp-style (`user@host:path`) carries a username but never a password.
		return `***@${scpMatch[2]}:${stripSecretBearingSuffix(scpMatch[3])}`;
	}
	try {
		const url = new URL(remoteUrl);
		url.username = url.username ? '***' : '';
		url.password = '';
		// Userinfo is not the only place a credential hides: `?token=…` and `#…` can carry
		// one too, and a remote never needs either for the host/owner/repo this message is
		// about. Dropping them wholesale beats trying to recognize which parameter is secret.
		url.search = '';
		url.hash = '';
		return url.toString();
	} catch {
		// An unparseable string cannot be redacted with confidence, so none of it is shown.
		return '<unparseable remote URL>';
	}
}

/** Drop a `?query` or `#fragment` from a path, either of which can carry a token. */
function stripSecretBearingSuffix(remotePath) {
	return remotePath.replace(/[?#].*$/, '');
}

/**
 * Parse `owner/name` from a remote URL, accepting the scp-style SSH
 * (`git@github.com:owner/name.git`), `ssh://` and HTTPS
 * (`https://github.com/owner/name`) spellings.
 *
 * The host is matched exactly rather than found as a substring: `https://notgithub.com/o/r`
 * contains "github.com/o/r", and accepting it would send this script's token to the Copilot
 * API asking about an unrelated repository. Mirrors `parseRepoFromRemoteUrl()` in
 * `src/copilotServerMemories.ts` — kept as its own copy because this probe is a dependency-free
 * CommonJS script that deliberately does not need the TypeScript build.
 *
 * Returns undefined rather than throwing so the git-shelling wrapper below owns the one
 * error message, and this half stays a pure function the tests can exercise directly.
 */
function parseRepoFromRemote(url) {
	const scpMatch = /^(?:[^@/]+@)?([^/:]+):(?!\/)(.+)$/.exec(url);
	let host = '';
	let repoPath = '';
	if (scpMatch) {
		host = scpMatch[1];
		repoPath = scpMatch[2];
	} else {
		try {
			const parsed = new URL(url);
			if (!GIT_REMOTE_SCHEMES.has(parsed.protocol)) { return undefined; }
			host = parsed.hostname;
			repoPath = parsed.pathname;
		} catch {
			return undefined;
		}
	}

	const segments = stripSecretBearingSuffix(repoPath)
		.replace(/^\/+/, '')
		.replace(/\/+$/, '')
		.replace(/\.git$/i, '')
		.split('/');
	// The slug goes straight into the request URL, so each segment must look like a GitHub
	// name. Without the suffix strip above, `git@github.com:owner/repo.git?token=secret`
	// would yield a "name" carrying that credential and send it to the API — past the
	// redaction, which only guards what gets printed.
	if (!GITHUB_HOSTS.has(host.toLowerCase()) || !isValidRepoSlug(segments.join('/'))) {
		return undefined;
	}
	return `${segments[0]}/${segments[1]}`;
}

/**
 * Is this an `owner/name` slug safe to interpolate into a request URL?
 *
 * The slug goes straight into the request path, so an unconstrained segment is an
 * injection point: a stray `?`, `%2f`, `@` or space would let it steer the request
 * somewhere other than the repository it names. GitHub's own names use this character set,
 * so anything outside it is rejected rather than escaped. Mirrors `isValidRepoSlug()` in
 * `src/copilotServerMemories.ts`; the duplication is deliberate, since this probe is
 * dependency-free CommonJS that does not need the TypeScript build.
 */
function isValidRepoSlug(slug) {
	const segments = slug.split('/');
	return segments.length === 2
		&& segments.every((segment) => /^[A-Za-z0-9._-]+$/.test(segment) && segment !== '.' && segment !== '..');
}

function resolveRepoFromGit() {
	const url = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
	const repo = parseRepoFromRemote(url);
	if (!repo) {
		throw new Error(`Could not parse a GitHub owner/repo from the origin remote: ${redactRemoteUrl(url)}`);
	}
	return repo;
}


/** Read the GitHub token from the `gh` CLI. The value is returned for header use only. */
function readToken() {
	// Pinned to github.com rather than the GitHub CLI's default host: `gh auth token` honours
	// GH_HOST and the active CLI context, so on a machine configured for GHES it would return
	// an Enterprise token, and this script would send it to api.githubcopilot.com — a host it
	// was never issued for. The remote parser only accepts github.com repositories anyway.
	const token = execFileSync('gh', ['auth', 'token', '--hostname', 'github.com'], { encoding: 'utf8' }).trim();
	if (!token) {
		throw new Error('No github.com token — run `gh auth login --hostname github.com` first.');
	}
	return token;
}

function memoryUrl(repo, suffix, limit) {
	const url = new URL(`${COPILOT_API_BASE}/${MEMORY_PATH_PREFIX}/${repo}/${suffix}`);
	if (limit !== undefined) {
		url.searchParams.set('limit', String(limit));
	}
	return url.toString();
}

/**
 * Issue one authenticated GET. Returns the parsed body plus the status, so callers can
 * distinguish "no memories" (204) from "memories" (200) from an error, the way the CLI does.
 * On a non-OK status the body text is returned rather than thrown, so the caller can report
 * *why* — a 401 (token lacks Copilot access) and a 404 (memory not enabled for this repo)
 * are very different answers to "are there memories here?".
 */
async function getJson(url, token) {
	let response;
	try {
		response = await fetch(url, {
			headers: {
				Authorization: `Bearer ${token}`,
				'Copilot-Integration-Id': INTEGRATION_ID,
				Accept: 'application/json',
			},
			// Bounded for the same reason the shared module bounds its requests: without a
			// signal a stalled socket hangs the process indefinitely. Degrades to no signal
			// where AbortSignal.timeout is unavailable, so an older runtime behaves as before
			// rather than failing outright.
			signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : undefined,
		});
	} catch (error) {
		// Reported rather than thrown: main() prints both routes' outcomes, and a failure on
		// one should not hide the other.
		return { status: 0, body: null, error: `Request failed: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (response.status === 204) {
		return { status: 204, body: null };
	}
	const text = await response.text();
	if (!response.ok) {
		return { status: response.status, body: null, error: text };
	}
	try {
		return { status: response.status, body: JSON.parse(text) };
	} catch {
		return { status: response.status, body: null, error: `Non-JSON response: ${text.slice(0, 500)}` };
	}
}

/**
 * Reduce a server-supplied string to a single line of printable text.
 *
 * Memory text is agent-written from repository content, so a `fact` can carry an ESC/OSC
 * sequence that reprograms the reader's terminal when printed verbatim — set its title,
 * drive the clipboard, hide text that is really there. This diagnostic is authenticated and
 * may well be pointed at a shared or untrusted repository, so its output must not be able to
 * act on the machine reading it. `JSON.stringify` already escapes the `source`/`extra`
 * fields; these are the ones printed raw. Mirrors sanitizeForDisplay() in
 * `src/copilotServerMemories.ts`.
 */
function sanitizeForDisplay(value) {
	return String(value)
		.replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function printReport(repo, enabled, memories) {
	process.stdout.write(`\nCopilot Server Memories — ${sanitizeForDisplay(repo)}\n`);
	process.stdout.write('='.repeat(50) + '\n\n');
	process.stdout.write(`Memory enabled for repo: ${enabled === undefined ? 'unknown' : enabled}\n`);
	process.stdout.write(`Memories returned:       ${memories.length}\n\n`);

	for (const memory of memories) {
		const citations = Array.isArray(memory.citations) && memory.citations.length > 0
			? memory.citations.join(', ')
			: '<none>';
		process.stdout.write(`• ${sanitizeForDisplay(memory.subject ?? '<no subject>')}\n`);
		process.stdout.write(`    fact:      ${sanitizeForDisplay(memory.fact ?? '')}\n`);
		process.stdout.write(`    citations: ${sanitizeForDisplay(citations)}\n`);
		if (memory.reason) {
			process.stdout.write(`    reason:    ${sanitizeForDisplay(memory.reason)}\n`);
		}
		if (memory.source) {
			process.stdout.write(`    source:    ${JSON.stringify(memory.source)}\n`);
		}
		// Surface anything the CLI's known shape does not cover — discovering these
		// extra fields (the web UI shows a model name and an integration label) is
		// the whole reason this probe exists.
		const known = new Set(['id', 'subject', 'fact', 'citations', 'reason', 'source']);
		const extra = Object.keys(memory).filter((key) => !known.has(key));
		if (extra.length > 0) {
			process.stdout.write(`    extra:     ${JSON.stringify(Object.fromEntries(extra.map((k) => [k, memory[k]])))}\n`);
		}
		process.stdout.write('\n');
	}
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	// A `--repo` value is not a remote, so it never went through parseRepoFromRemote()'s
	// validation — yet it reaches the same URL builder. Vet it on the same terms, or a
	// malformed value (extra segments, a query, a fragment) would steer the authenticated
	// request somewhere other than the repository it names.
	if (options.repo !== undefined && !isValidRepoSlug(options.repo)) {
		// Deliberately does not echo the value: a rejected slug is untrusted input that may
		// carry a credential, and this script promises above never to print one.
		throw new Error('--repo must be owner/name.');
	}
	const repo = options.repo ?? resolveRepoFromGit();
	const token = readToken();

	const enabledResult = await getJson(memoryUrl(repo, 'enabled'), token);
	const recentResult = await getJson(memoryUrl(repo, 'recent', options.limit), token);

	const enabled = enabledResult.body && typeof enabledResult.body.enabled === 'boolean'
		? enabledResult.body.enabled
		: undefined;
	const memories = Array.isArray(recentResult.body) ? recentResult.body : [];

	if (options.json) {
		process.stdout.write(JSON.stringify({
			repo,
			enabled: { status: enabledResult.status, ...(enabledResult.error ? { error: enabledResult.error } : {}), value: enabled },
			recent: { status: recentResult.status, ...(recentResult.error ? { error: recentResult.error } : {}), memories },
		}, null, 2) + '\n');
		return;
	}

	if (enabledResult.error) {
		// The response body is network-controlled too — a server or an intercepting proxy can
		// put control characters in an error just as a memory can. Same guard as the fields.
		process.stdout.write(`\n[enabled] HTTP ${enabledResult.status}: ${sanitizeForDisplay(enabledResult.error)}\n`);
	}
	if (recentResult.error) {
		process.stdout.write(`[recent]  HTTP ${recentResult.status}: ${sanitizeForDisplay(recentResult.error)}\n`);
	}
	printReport(repo, enabled, memories);
	if (recentResult.status === 204) {
		process.stdout.write('Server returned 204 No Content — this repository has no stored memories.\n');
	}
}

// Only run when invoked directly. Without this guard, merely requiring the file — which a
// test doing so to reach the helpers below would — performs a live authenticated request.
if (require.main === module) {
	main().catch((error) => {
		// Sanitized as well: this message can quote a redacted git remote, and a remote URL is
	// just a string in a config file that something else may have written.
	process.stderr.write(`${sanitizeForDisplay(error.message)}\n`);
		process.exitCode = 1;
	});
}

module.exports = { redactRemoteUrl, parseRepoFromRemote, isValidRepoSlug, sanitizeForDisplay, resolveRepoFromGit, memoryUrl, parseArgs };
