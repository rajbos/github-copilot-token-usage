/**
 * `memory-files` command — Copilot memory-files hygiene report for the CLI.
 *
 * Scans this machine's VS Code "User" directories (Code, Code - Insiders,
 * Code - Exploration, VSCodium, Cursor) for GitHub Copilot agent memory files
 * (`memory-tool/memories/`) and reports counts, staleness and unusually large
 * files. See docs/features/COPILOT-MEMORY-FILES-INSIGHT.md for background.
 *
 * Metadata only — file *content* is never read or printed beyond the
 * filename-derived title.
 */
import { execFileSync } from 'child_process';
import { Command } from 'commander';
import { shouldOutputJson } from '../commandUtils';
import { discoverAllMemoryFiles, analyzeMemoryFiles, DEFAULT_STALE_DAYS, DEFAULT_LARGE_FILE_BYTES } from '../../../src/copilotMemoryFiles';
import {
	fetchRepoMemories,
	analyzeServerMemories,
	parseRepoFromRemoteUrl,
	renderPromotionMarkdown,
	isValidRepoSlug,
	createRepoFileExists,
	sanitizeForDisplay,
	INVALID_REPO_LABEL,
	DEFAULT_MEMORY_LIMIT,
} from '../../../src/copilotServerMemories';
import type { MemoryFilesAnalysis, ServerMemoriesAnalysis } from '../../../src/types';

const DEFAULT_LARGE_KB = DEFAULT_LARGE_FILE_BYTES / 1024;

/**
 * Parse a CLI numeric option strictly: the whole trimmed string must be an integer
 * (optionally signed), so trailing garbage like `30days` or `5kb` is rejected instead
 * of being silently truncated by `parseInt`. Returns `NaN` for anything that isn't a
 * clean integer, which the caller falls back to the default for.
 */
function parseStrictInt(value: string): number {
	const trimmed = value.trim();
	return /^-?\d+$/.test(trimmed) ? parseInt(trimmed, 10) : NaN;
}

/**
 * Resolve `--stale-days`/`--large-kb` CLI option strings to their clamped numeric values.
 *
 * An explicit `0` is a valid (if degenerate) threshold and must be clamped to the `1` floor,
 * not silently replaced by the default — `parseInt(...) || DEFAULT` would do exactly that
 * since `0` is falsy. Only a genuinely non-numeric value (missing/garbage input, or a value
 * with trailing non-digit characters such as `30days`) falls back to the default.
 */
export function resolveMemoryFilesThresholds(options: { staleDays?: string; largeKb?: string }): { staleDays: number; largeFileBytes: number } {
	const parsedStaleDays = parseStrictInt(options.staleDays ?? String(DEFAULT_STALE_DAYS));
	const staleDays = Math.max(1, Number.isNaN(parsedStaleDays) ? DEFAULT_STALE_DAYS : parsedStaleDays);
	const parsedLargeKb = parseStrictInt(options.largeKb ?? String(DEFAULT_LARGE_KB));
	const largeFileBytes = Math.max(1, Number.isNaN(parsedLargeKb) ? DEFAULT_LARGE_KB : parsedLargeKb) * 1024;
	return { staleDays, largeFileBytes };
}

export const memoryFilesCommand = new Command('memory-files')
	.description('Report on GitHub Copilot agent memory files on this machine (counts, staleness, size)')
	.option('--json', 'Output raw JSON (for machine consumption)')
	.option('--stale-days <days>', `Days since last edit before a memory file is flagged stale (default: ${DEFAULT_STALE_DAYS})`, String(DEFAULT_STALE_DAYS))
	.option('--large-kb <kb>', `Size in KB above which a memory file is flagged large (default: ${DEFAULT_LARGE_KB})`, String(DEFAULT_LARGE_KB))
	.option('--server', "Also fetch this repository's server-side Copilot memories (requires network and the GitHub CLI)")
	.option('--repo <owner/name>', "Repository to read server memories for (default: this checkout's origin remote)")
	.option('--limit <n>', `Maximum server memories to request (default: ${DEFAULT_MEMORY_LIMIT})`, String(DEFAULT_MEMORY_LIMIT))
	.option('--promote', 'Print the server-memory promotion candidates as a Markdown block for AGENTS.md')
	.action(async (options) => {
		const { staleDays, largeFileBytes } = resolveMemoryFilesThresholds(options);

		const files = discoverAllMemoryFiles();
		const analysis = analyzeMemoryFiles(files, { staleDays, largeFileBytes });

		// `--promote` and `--repo` are only meaningful against a server store, so either one
		// implies `--server` rather than silently doing nothing.
		const wantsServer = Boolean(options.server || options.promote || options.repo);
		const parsedLimit = parseStrictInt(options.limit ?? String(DEFAULT_MEMORY_LIMIT));
		const limit = Math.max(1, Number.isNaN(parsedLimit) ? DEFAULT_MEMORY_LIMIT : parsedLimit);
		const serverAnalysis = wantsServer
			? await buildServerMemoriesAnalysis(process.cwd(), options.repo, limit)
			: undefined;

		if (shouldOutputJson(options)) {
			process.stdout.write(JSON.stringify(wantsServer ? { ...analysis, serverMemories: serverAnalysis ?? null } : analysis));
			return;
		}

		if (options.promote) {
			if (!serverAnalysis) {
				process.stdout.write('Not a GitHub repository checkout — pass --repo owner/name.\n');
			} else if (serverAnalysis.error) {
				// A failed read must not fall through to renderPromotionMarkdown(): with no
				// memories it prints "every stored memory already cites an instruction file",
				// so a 401, a missing `gh` or a dropped connection would read as "you have
				// nothing left to document" — the most misleading answer this command can give.
				process.stderr.write(`Could not read ${sanitizeForDisplay(serverAnalysis.repo)}: ${sanitizeForDisplay(serverAnalysis.error)}\n`);
				process.exitCode = 1;
			} else {
				process.stdout.write(renderPromotionMarkdown(serverAnalysis));
			}
			return;
		}

		printMemoryFilesReport(analysis);
		if (wantsServer) {
			printServerMemoriesReport(serverAnalysis);
		}
	});

/**
 * Run a command and return its trimmed stdout, or `undefined` if it is missing or fails.
 *
 * Used for the optional `git`/`gh` lookups behind `--server`: neither is a dependency of
 * this CLI, so an absent binary must downgrade the server section to an explanatory
 * message rather than crash a report whose local half works fine without them.
 */
function tryRun(command: string, args: string[], cwd: string): string | undefined {
	try {
		return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
	} catch {
		return undefined;
	}
}

/**
 * Resolve the repository root and `owner/name` for the current working directory.
 *
 * The root matters as much as the slug: citation staleness is checked by resolving each
 * repo-relative citation path against it, so running the command from a subdirectory must
 * not make every citation look missing.
 */
function resolveRepoContext(cwd: string): { root: string; repo: string } | undefined {
	const root = tryRun('git', ['rev-parse', '--show-toplevel'], cwd);
	const remote = tryRun('git', ['remote', 'get-url', 'origin'], cwd);
	if (!root || !remote) { return undefined; }
	const repo = parseRepoFromRemoteUrl(remote);
	return repo ? { root, repo } : undefined;
}

/**
 * Fetch and analyze the current repository's server-side memory store.
 *
 * Returns `undefined` only when there is no repository to ask about; every other failure
 * (no `gh`, no Copilot access, memory disabled) comes back as an analysis carrying an
 * `error`, so the report can say *why* it is empty.
 */
async function buildServerMemoriesAnalysis(cwd: string, repoOverride: string | undefined, limit: number): Promise<ServerMemoriesAnalysis | undefined> {
	const context = resolveRepoContext(cwd);
	const repo = repoOverride ?? context?.repo;
	if (!repo) { return undefined; }
	// `--repo` never went through the remote parser's validation but reaches the same URL
	// builder. fetchRepoMemories() rejects an invalid slug too; failing here as well turns a
	// typo into an immediate, specific message instead of a generic read failure.
	if (repoOverride !== undefined && !isValidRepoSlug(repoOverride)) {
		// The rejected value is untrusted and may carry a credential, so neither the label nor
		// the message echoes it — `--json` serializes both.
		return { repo: INVALID_REPO_LABEL, enabled: undefined, error: '--repo must be owner/name.', truncated: false,
			totalMemories: 0, distinctSubjects: 0, documentedCount: 0, promotionCandidateCount: 0,
			repeatedGroupCount: 0, promotionGroups: [], unverifiableCount: 0, staleCitations: [], fullyStaleCount: 0,
			byAgent: {}, byModel: {} };
	}
	const root = context?.root ?? cwd;
	const analyzingThisCheckout = !repoOverride || repoOverride === context?.repo;

	const result = await fetchRepoMemories(repo, {
		getToken: async () => {
			// Pinned to github.com, not the GitHub CLI's default host. `gh auth token` honours
			// GH_HOST and the CLI's active context, so on a machine configured for GHES it
			// would hand back an Enterprise token — which this would then send to
			// api.githubcopilot.com, a host it was never issued for. The remote parser only
			// accepts github.com repositories, so pinning here keeps both ends consistent, and
			// a user with no github.com auth fails closed with the message below.
			const token = tryRun('gh', ['auth', 'token', '--hostname', 'github.com'], cwd);
			if (!token) { throw new Error('No github.com token from the GitHub CLI — install it and run `gh auth login --hostname github.com`.'); }
			return token;
		},
	}, limit);

	return analyzeServerMemories(result, {
		// Only check citations against the working tree when the analyzed repo is the one
		// checked out here. With `--repo` pointing elsewhere, the local tree says nothing
		// about that repo's files, so every citation would look missing — report none instead.
		//
		// createRepoFileExists() rather than a bare existsSync(): that follows symlinks, so a
		// repository symlink out of the checkout would let a citation probe an arbitrary path.
		fileExists: analyzingThisCheckout ? createRepoFileExists(root) : () => true,
	});
}

function printServerMemoriesReport(analysis: ServerMemoriesAnalysis | undefined): void {
	process.stdout.write('\nCopilot Server Memories (this repository)\n');
	process.stdout.write('='.repeat(50) + '\n\n');

	if (!analysis) {
		process.stdout.write('Not a GitHub repository checkout — pass --repo owner/name to pick one.\n');
		return;
	}
	if (analysis.error) {
		process.stdout.write(`Could not read ${sanitizeForDisplay(analysis.repo)}: ${sanitizeForDisplay(analysis.error)}\n`);
		return;
	}

	// Every field below comes from the server. Memory text is agent-written from repository
	// content, so a fact can carry an ESC/OSC sequence that reprograms the reader's terminal
	// when printed verbatim — a report about what an agent learned must not be able to act on
	// the machine reading it. JSON mode is safe by construction; this path was not.
	process.stdout.write(`Repository:           ${sanitizeForDisplay(analysis.repo)}\n`);
	process.stdout.write(`Memory enabled:       ${analysis.enabled ?? 'unknown'}\n`);
	// Say so when the page was full: these routes have no pagination cursor, so every number
	// below describes the prefix that was read, not the whole store.
	process.stdout.write(`Stored memories:      ${analysis.totalMemories}${analysis.truncated ? '+ (truncated at the request limit)' : ''} across ${analysis.distinctSubjects} subjects\n`);
	process.stdout.write(`Already documented:   ${analysis.documentedCount} (cite AGENTS.md or another instruction file)\n`);
	// Reported rather than silently dropped: a reader comparing the totals should be able to
	// see where the difference went.
	if (analysis.unverifiableCount > 0) {
		process.stdout.write(`Not promotable:       ${analysis.unverifiableCount} (no verifiable file citation, e.g. "User input: ...")\n`);
	}
	process.stdout.write(`Promotion candidates: ${analysis.promotionCandidateCount} in ${analysis.promotionGroups.length} groups, ${analysis.repeatedGroupCount} re-learned more than once\n`);
	process.stdout.write(`Stale citations:      ${analysis.staleCitations.length} memories, ${analysis.fullyStaleCount} with no surviving source\n\n`);
	if (analysis.truncated) {
		process.stdout.write('Note: the server returned a full page, so more memories may exist than are counted here.\n'
			+ '      Raise --limit to read further.\n\n');
	}

	if (analysis.totalMemories === 0) {
		// A zero count is not evidence the store is empty: fetchRepoMemories() deliberately
		// skips the `recent` request when the repository has memory switched off, so a
		// disabled repository reaches here too and deserves the accurate answer.
		process.stdout.write(analysis.enabled === false
			? 'Memory is turned off for this repository.\n'
			: 'This repository has no stored memories yet.\n');
		return;
	}

	process.stdout.write('Top promotion candidates (consider adding these to AGENTS.md):\n');
	for (const group of analysis.promotionGroups.slice(0, 10)) {
		const repeats = group.repeatCount > 1 ? ` (re-learned ${group.repeatCount}x)` : '';
		process.stdout.write(`  • ${sanitizeForDisplay(group.displaySubject)}${repeats}\n`);
		process.stdout.write(`      ${sanitizeForDisplay(group.representativeFact)}\n`);
	}
	process.stdout.write('\n  Run with --promote for a Markdown block you can paste in.\n');

	if (analysis.fullyStaleCount > 0) {
		process.stdout.write('\nMemories whose every cited file is gone:\n');
		for (const stale of analysis.staleCitations.filter(c => c.fullyStale).slice(0, 10)) {
			process.stdout.write(`  • ${sanitizeForDisplay(stale.subject)}: ${sanitizeForDisplay(stale.missingPaths.join(', '))}\n`);
		}
	}
	process.stdout.write('\n');
}

function printMemoryFilesReport(analysis: MemoryFilesAnalysis): void {
	process.stdout.write(`\nCopilot Memory Files Report\n`);
	process.stdout.write('='.repeat(50) + '\n\n');

	if (analysis.totalFiles === 0) {
		process.stdout.write('No Copilot memory files found on this machine.\n');
		return;
	}

	process.stdout.write(`Total memory files: ${analysis.totalFiles}\n`);
	process.stdout.write(`Total size:          ${(analysis.totalBytes / 1024).toFixed(1)} KB\n`);
	process.stdout.write(`Stale (>${analysis.staleDays}d):        ${analysis.staleFileCount}\n`);
	process.stdout.write(`Large (>${Math.round(analysis.largeFileBytes / 1024)}KB):      ${analysis.largeFileCount}\n\n`);

	process.stdout.write('By workspace:\n');
	for (const ws of analysis.byWorkspace) {
		const label = ws.workspaceName ?? ws.workspaceHash ?? 'unknown';
		process.stdout.write(`  • ${label}\n`);
		process.stdout.write(`      repo-scope: ${ws.repoCount}, session-scope: ${ws.sessionCount}, global-scope: ${ws.userCount}, size: ${(ws.totalBytes / 1024).toFixed(1)} KB\n`);
		if (ws.staleFiles.length > 0) {
			process.stdout.write(`      stale: ${ws.staleFiles.map(f => f.title).join(', ')}\n`);
		}
	}
	process.stdout.write('\n');
}
