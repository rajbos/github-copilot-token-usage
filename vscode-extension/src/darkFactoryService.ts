/**
 * Orchestration for the Dark Factory readiness scan.
 *
 * Turns a list of workspace paths into a {@link DarkFactoryReport}: it decides
 * which paths are repositories worth scanning, collects the filesystem tier
 * (`src/darkFactorySignals.ts`), joins whatever GitHub evidence the extension
 * has *already* fetched, and hands the result to the pure scorer
 * (`src/darkFactoryReadiness.ts`).
 *
 * It issues no network calls of its own. The only GitHub-derived signal it
 * uses is the pull-request statistics the Usage Analysis view already loads,
 * so opening the readiness view costs no extra API requests and cannot slow
 * the Fluency Score view down. Everything else in the API tier stays `unknown`,
 * which is the honest state for evidence nothing looked at.
 */
import * as path from 'path';
import {
	agentPullRequestObservation,
	buildDarkFactoryReport,
	scoreDarkFactoryReadiness,
	type DarkFactoryPrStats,
	type DarkFactoryRepoSignals,
} from '../../src/darkFactoryReadiness';
import { collectDarkFactoryFileSignals, isGitRepoRoot, readGitOriginUrl, resolveRepoIdentity } from '../../src/darkFactorySignals';
import type { DarkFactoryReport } from '../../src/types';
import { buildGitHubHosts, parseGitHubRemote, type RepoPrStatsResult } from './githubPrService';

/**
 * Repositories scanned per run. The filesystem tier is cheap per repository,
 * but a workspace can contribute hundreds of paths, so the scan is bounded and
 * reports how many it skipped rather than silently truncating.
 */
export const MAX_SCANNED_REPOS = 25;

/** `globalState` key holding the last readiness report, shown instantly on the next open. */
export const DARK_FACTORY_CACHE_KEY = 'darkFactory.reportCache';

/** A cached report older than this is re-scanned in the background (a manual refresh always is). */
export const DARK_FACTORY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Narrow an untrusted persisted value to a usable report, or `undefined` when it is not one. */
export function parseCachedReport(value: unknown): DarkFactoryReport | undefined {
	if (!value || typeof value !== 'object') { return undefined; }
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) { return undefined; }
	const candidate = value as Partial<DarkFactoryReport>;
	if (!Array.isArray(candidate.repos) || typeof candidate.scannedAt !== 'string') { return undefined; }
	return Number.isFinite(Date.parse(candidate.scannedAt)) ? (value as DarkFactoryReport) : undefined;
}

/**
 * Identity of what a scan would cover: the ordered repository roots chosen from the
 * caller's paths. A cached report is only valid for the scope it was produced for, so
 * switching workspaces (or gaining a repository) is a cache miss, not a stale replay.
 */
export function readinessScopeKey(workspacePaths: readonly string[]): string {
	// The skipped count is part of the scope: crossing the scan cap changes the overview
	// without changing the selected roots.
	const { roots, skipped } = selectRepoRoots(workspacePaths);
	return `${roots.join('|')}#${skipped}`;
}

/** The persisted cache entry: a report plus the scope it was scanned for. */
export interface DarkFactoryCacheEntry { scopeKey: string; report: DarkFactoryReport }

/**
 * Read a persisted entry, returning its report only when it matches `scopeKey`.
 * A report carrying GitHub-derived evidence is withheld unless `apiEvidenceAllowed`,
 * so signing out cannot be undone by reopening the view.
 */
export function parseCacheEntry(value: unknown, scopeKey: string, apiEvidenceAllowed = true): DarkFactoryReport | undefined {
	if (!value || typeof value !== 'object') { return undefined; }
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) { return undefined; }
	const entry = value as Partial<DarkFactoryCacheEntry>;
	if (entry.scopeKey !== scopeKey) { return undefined; }
	const report = parseCachedReport(entry.report);
	return report && (apiEvidenceAllowed || !report.apiSignalsIncluded) ? report : undefined;
}

/** Whether a report is old enough (or its timestamp odd enough) that it should be re-scanned. */
export function isReportStale(report: DarkFactoryReport, now: Date = new Date()): boolean {
	const age = now.getTime() - Date.parse(report.scannedAt);
	return !(age >= 0 && age <= DARK_FACTORY_CACHE_TTL_MS);
}

/** Resolve `owner/repo` from a repository's `origin` remote, when it is a GitHub one. */
function resolveNameWithOwner(repoRoot: string, hosts: Set<string>): string | undefined {
	const origin = readGitOriginUrl(repoRoot);
	if (!origin) { return undefined; }
	const parsed = parseGitHubRemote(origin, hosts);
	return parsed ? `${parsed.owner}/${parsed.repo}` : undefined;
}

/**
 * Reduce the caller's workspace paths to distinct git repository roots, keeping
 * the caller's ordering so the paths it considers most relevant survive the cap.
 */
export function selectRepoRoots(workspacePaths: readonly string[]): { roots: string[]; skipped: number } {
	const seen = new Set<string>();
	// Linked worktrees share one git directory; group them so a repository is
	// listed once. The representative is always one of the caller's own paths: the
	// main checkout when it is among them, otherwise the first (most relevant)
	// worktree seen. Never a checkout the user did not open, which could be on
	// another branch.
	const groups = new Map<string, { root: string; isMain: boolean }>();
	for (const workspacePath of workspacePaths) {
		if (!workspacePath || workspacePath.startsWith('<unresolved:')) { continue; }
		const resolved = path.resolve(workspacePath);
		if (seen.has(resolved)) { continue; }
		seen.add(resolved);
		if (!isGitRepoRoot(resolved)) { continue; }
		const { key, isMainCheckout } = resolveRepoIdentity(resolved);
		const existing = groups.get(key);
		if (!existing || (isMainCheckout && !existing.isMain)) {
			groups.set(key, { root: resolved, isMain: isMainCheckout });
		}
	}
	const all = [...groups.values()].map(group => group.root);
	const roots = all.slice(0, MAX_SCANNED_REPOS);
	return { roots, skipped: all.length - roots.length };
}

/** Index the already-fetched pull-request statistics by `owner/repo` for a cheap join. */
export function indexPrStats(prStats: RepoPrStatsResult | undefined): Map<string, DarkFactoryPrStats> {
	const index = new Map<string, DarkFactoryPrStats>();
	if (!prStats?.authenticated) { return index; }
	for (const repo of prStats.repos) {
		index.set(`${repo.owner}/${repo.repo}`.toLowerCase(), {
			totalPrs: repo.totalPrs,
			aiAuthoredPrs: repo.aiAuthoredPrs,
			error: repo.error,
		});
	}
	return index;
}

/** Options for {@link scanDarkFactoryReadiness}. */
export interface DarkFactoryScanOptions {
	/** Candidate paths, most relevant first — only git repository roots are scanned. */
	workspacePaths: readonly string[];
	/** Pull-request statistics already fetched by the Usage Analysis view, when available. */
	prStats?: RepoPrStatsResult;
	/** Configured GitHub Enterprise URI, so enterprise remotes resolve to `owner/repo` too. */
	enterpriseUri?: string;
	/** Injected clock, for deterministic tests. */
	now?: () => Date;
}

/**
 * Run the readiness scan across the caller's workspace paths.
 *
 * Synchronous filesystem work only — no `git` subprocesses and no HTTP — so it
 * is safe to run while building a webview's initial payload.
 */
export function scanDarkFactoryReadiness(options: DarkFactoryScanOptions): DarkFactoryReport {
	const { roots, skipped } = selectRepoRoots(options.workspacePaths);
	const hosts = buildGitHubHosts(options.enterpriseUri);
	const prIndex = indexPrStats(options.prStats);

	const reports = roots.map(repoRoot => {
		const { observations, facts } = collectDarkFactoryFileSignals(repoRoot);
		const nameWithOwner = resolveNameWithOwner(repoRoot, hosts);
		const prObservation = agentPullRequestObservation(nameWithOwner ? prIndex.get(nameWithOwner.toLowerCase()) : undefined);

		const signals: DarkFactoryRepoSignals = {
			name: path.basename(repoRoot),
			repoRoot,
			nameWithOwner,
			observations: { ...observations, 'agent-authored-pull-requests': prObservation },
			facts,
		};
		return scoreDarkFactoryReadiness(signals);
	});

	return buildDarkFactoryReport(reports, {
		scannedAt: (options.now?.() ?? new Date()).toISOString(),
		apiSignalsIncluded: prIndex.size > 0,
		skippedRepoCount: skipped,
	});
}
