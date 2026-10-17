/**
 * Worktree background scan — pure decision logic for the once-daily, leader-only disk-usage
 * scan of git worktrees.
 *
 * All VS Code API calls (leader election via cacheManager, the drip-throttled disk walk, the
 * native "found X of stale worktree data" notification) live in `extension.ts`
 * (`CopilotTokenTracker.maybeStartBackgroundWorktreeScan` and friends). This module only holds
 * the parts that are pure functions of their inputs, so they can be unit-tested directly,
 * following the same pattern as `insightsEngine.ts`.
 */
import { normalizePathForDedup, normalizeToRepoRoot } from '../../src/workspaceHelpers';

/** One worktree's findings, as persisted after the background scan completes. */
export interface WorktreeBackgroundScanEntry {
	path: string;
	repoLabel: string;
	branch: string;
	lastCommit: string;
	lastCommitDate: string | null;
	pushed: "yes" | "no" | "?";
	files: number;
	folders: number;
	bytes: number;
}

/** Aggregate + per-worktree findings from the most recently completed background scan. */
export interface WorktreeBackgroundScanResult {
	/** ISO timestamp of when this scan completed. */
	scannedAt: string;
	totalBytes: number;
	worktreeCount: number;
	worktrees: WorktreeBackgroundScanEntry[];
}

/** How often the background scan is allowed to run, at most once per day. */
export const WORKTREE_BACKGROUND_SCAN_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Minimum stale-worktree footprint before we bother the user with a notification at all. */
export const WORKTREE_SCAN_NOTIFY_MIN_BYTES = 200 * 1024 * 1024; // 200 MB

/** Re-notify once the total has drifted by at least this fraction since the last notification. */
export const WORKTREE_SCAN_NOTIFY_DELTA_RATIO = 0.1;

/**
 * Whether it's time to kick off another daily background scan: never run before, or the
 * interval has elapsed since the last one started. Gated on when the scan *started* (not
 * completed) so a scan interrupted by a window closing mid-drip isn't immediately re-triggered
 * by the next window to become leader.
 */
export function shouldRunDailyWorktreeScan(
	lastRunStartedAt: string | undefined,
	now: number,
	intervalMs: number = WORKTREE_BACKGROUND_SCAN_INTERVAL_MS,
): boolean {
	if (!lastRunStartedAt) { return true; }
	const startedMs = Date.parse(lastRunStartedAt);
	if (!Number.isFinite(startedMs)) { return true; }
	return now - startedMs >= intervalMs;
}

/**
 * Whether a just-completed scan's total should surface a notification: the total must clear the
 * minimum footprint, and either this is the first notification ever or the total has moved by at
 * least `deltaRatio` since the last total the user was actually notified about.
 */
export function shouldNotifyWorktreeFindings(
	totalBytes: number,
	lastNotifiedBytes: number | undefined,
	minBytes: number = WORKTREE_SCAN_NOTIFY_MIN_BYTES,
	deltaRatio: number = WORKTREE_SCAN_NOTIFY_DELTA_RATIO,
): boolean {
	if (totalBytes < minBytes) { return false; }
	if (lastNotifiedBytes === undefined || lastNotifiedBytes <= 0) { return true; }
	const delta = Math.abs(totalBytes - lastNotifiedBytes) / lastNotifiedBytes;
	return delta >= deltaRatio;
}

/**
 * Human-readable byte size for notification text (e.g. "1.3 GB", "450 MB"). Kept separate from
 * the webview's `formatFileSize` (in `webview/shared/formatUtils.ts`), which pulls in
 * browser-only dependencies not safe to import from the extension host.
 */
export function formatBytesForNotification(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) { return "0 B"; }
	if (bytes < 1024) { return `${bytes} B`; }
	const units = ["KB", "MB", "GB", "TB"];
	let value = bytes / 1024;
	let unitIndex = 0;
	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024;
		unitIndex++;
	}
	const decimals = value < 10 ? 1 : 0;
	return `${value.toFixed(decimals)} ${units[unitIndex]}`;
}

/** Sum of known (non-negative) bytes across scanned worktrees; entries still pending (-1) contribute 0. */
export function sumWorktreeBytes(worktrees: { bytes: number }[]): number {
	return worktrees.reduce((sum, w) => sum + (w.bytes > 0 ? w.bytes : 0), 0);
}

/** One candidate worktree parsed out of a `cleanupPushedWorktrees` webview message. */
export interface CleanupWorktreeCandidate {
	path: string;
	branch: string;
	repoLabel: string;
}

/** Result of parsing a `cleanupPushedWorktrees` webview message. */
export interface ParsedCleanupPushedWorktreesMessage {
	candidates: CleanupWorktreeCandidate[];
	scopeRepoLabel?: string;
}

/**
 * Parses the bulk-cleanup message into its candidate list and optional repo scope label.
 * `scopeRepoLabel` is only trusted (and returned) when it matches every parsed candidate's
 * `repoLabel` — a mismatched or mixed-repo list falls back to unscoped (`undefined`) rather than
 * letting the confirmation dialog claim a narrower scope than what will actually be deleted.
 *
 * Pulled out of `CopilotTokenTracker.diagHandleCleanupPushedWorktrees` in `extension.ts` so this
 * parsing/validation logic is unit-testable without needing a full extension host instance,
 * following the same pattern as the rest of this module.
 */
export function parseCleanupPushedWorktreesMessage(message: any): ParsedCleanupPushedWorktreesMessage {
	const candidates: CleanupWorktreeCandidate[] = Array.isArray(message?.worktrees)
		? message.worktrees
			.filter((w: any) => w && typeof w.path === "string" && w.path.trim())
			.map((w: any) => ({
				path: String(w.path).trim(),
				branch: typeof w.branch === "string" && w.branch ? w.branch : "?",
				repoLabel: typeof w.repoLabel === "string" && w.repoLabel ? w.repoLabel : "",
			}))
		: [];
	const requestedScope: string | undefined = typeof message?.repoLabel === "string" && message.repoLabel ? message.repoLabel : undefined;
	const scopeRepoLabel = requestedScope && candidates.every((c) => c.repoLabel === requestedScope) ? requestedScope : undefined;
	return { candidates, scopeRepoLabel };
}

/**
 * Appends candidates to a running cleanup's queue, skipping paths already in it (processed or
 * waiting). Returns only the entries actually added, so the webview can mirror the queue.
 */
export function enqueueCleanupCandidates(queue: CleanupWorktreeCandidate[], incoming: CleanupWorktreeCandidate[]): CleanupWorktreeCandidate[] {
	const known = new Set(queue.map((c) => c.path.toLowerCase()));
	const added = incoming.filter((c) => !known.has(c.path.toLowerCase()) && known.add(c.path.toLowerCase()));
	queue.push(...added);
	return added;
}

/** Confirmation prompt title, naming the repository when the cleanup is scoped to one. */
export function buildCleanupConfirmTitle(count: number, scopeRepoLabel?: string): string {
	const scopeText = scopeRepoLabel ? ` in "${scopeRepoLabel}"` : "";
	return `Clean up ${count} pushed worktree${count === 1 ? "" : "s"}${scopeText}?`;
}

/** Evidence that a session workspace lives under the same repo root as a worktree candidate. */
export interface WorktreeSessionRepoEvidence {
	sessionWorkspacePath: string;
	repoRoot: string;
}

/**
 * Validate a worktree root against one or more session workspace paths.
 *
 * This accepts any session workspace path that normalizes to the same repo root as the worktree
 * candidate, so a repo-scoped session can prove the repo even when the worktree itself is a
 * transient subfolder.
 */
export function validateWorktreeRepoRootFromSessionPaths(
	worktreePath: string,
	sessionWorkspacePaths: (string | undefined)[],
): WorktreeSessionRepoEvidence | undefined {
	const worktreeRepoRoot = normalizePathForDedup(normalizeToRepoRoot(worktreePath));
	for (const sessionWorkspacePath of sessionWorkspacePaths) {
		const value = typeof sessionWorkspacePath === "string" ? sessionWorkspacePath.trim() : "";
		if (!value) { continue; }
		const sessionRepoRoot = normalizePathForDedup(normalizeToRepoRoot(value));
		if (sessionRepoRoot === worktreeRepoRoot) {
			return { sessionWorkspacePath: value, repoRoot: normalizeToRepoRoot(value) };
		}
	}
	return undefined;
}
