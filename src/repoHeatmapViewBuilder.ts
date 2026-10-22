/**
 * Builds the Repository Heatmap view's payload (`window.__INITIAL_REPO_HEATMAP__`): every
 * file an agent touched, grouped by repository and folder, filterable by the standard
 * period selector.
 *
 * Pure (no `vscode`, no filesystem): hosts gather {@link RepoHeatmapSessionInput}s by running
 * `extractFileActivity()` over their session files, then call {@link buildRepoHeatmapViewData}
 * once and {@link summarizeRepoHeatmap} on every period/filter change.
 *
 * File paths stay local. This payload is for the local views only and must never be uploaded
 * (sharing-server receives numeric rollups, not paths).
 */
import type { ChartTimeWindow } from './types';
import { FILE_ACTIVITY_KINDS, type FileActivityKind, type FileTouch } from './fileActivity';
import { getTimeWindowStartDayKey } from './timeWindows';
import { toLocalDayKey } from './utils/dayKeys';
import { repoDisplayName } from './repeatedTasks';
import { isUnsafeObjectKey } from './utils/protoGuard';

/** Per-kind counters in {@link FILE_ACTIVITY_KINDS} order: read, edited, created, deleted. */
export type KindCounts = [number, number, number, number];

/** One session's file activity plus what the builder needs to anchor it to a repository. */
export interface RepoHeatmapSessionInput {
	/** Git remote URL (or name) of the session's repository, when resolved. */
	repository?: string | null;
	/** Local workspace folder of the session; paths under it are made repository-relative. */
	workspaceFolderPath?: string | null;
	/** Local day (YYYY-MM-DD) of the session's last activity; used for touches without a timestamp. */
	fallbackDayKey: string;
	touches: FileTouch[];
}

export interface RepoHeatmapFile {
	/** Repository-relative path with `/` separators. */
	path: string;
	/** Counters per local day (YYYY-MM-DD). */
	days: Record<string, KindCounts>;
	/** True when every delete of this file was inferred from a shell command. */
	inferredDeletes?: boolean;
}

export interface RepoHeatmapRepo {
	key: string;
	label: string;
	files: RepoHeatmapFile[];
	/** Files dropped after {@link MAX_FILES_PER_REPO}, least-touched first. */
	truncatedFiles: number;
}

export interface RepoHeatmapViewData {
	repos: RepoHeatmapRepo[];
	/** Touches outside every session's workspace (home-dir files, other repos): not shown. */
	outsideRepoTouches: number;
	lastUpdated: string;
	hasData: boolean;
}

export const MAX_FILES_PER_REPO = 3000;

const EMPTY_COUNTS = (): KindCounts => [0, 0, 0, 0];
const KIND_INDEX: Record<FileActivityKind, number> = { read: 0, edited: 1, created: 2, deleted: 3 };

// ── Path anchoring ───────────────────────────────────────────────────────────

function slashes(p: string): string { return p.replace(/\\/g, '/').replace(/\/+$/, ''); }

function isAbsolute(p: string): boolean { return p.startsWith('/') || /^[a-zA-Z]:\//.test(p); }

/**
 * Makes `filePath` relative to `root` (case-insensitive, as Windows drives are). Returns
 * undefined when the file lives outside the root. A relative input is taken as already
 * relative to the workspace (shell deletes are logged relative to the working directory).
 */
export function toRepoRelativePath(filePath: string, root: string | null | undefined): string | undefined {
	const p = slashes(filePath);
	if (!isAbsolute(p)) {
		const rel = p.replace(/^\.\//, '');
		// `../x` escapes the workspace.
		return rel === '..' || rel.startsWith('../') ? undefined : rel;
	}
	if (!root) { return undefined; }
	const r = slashes(root);
	if (p.toLowerCase().startsWith(`${r.toLowerCase()}/`)) { return p.slice(r.length + 1); }
	return undefined;
}

/**
 * Agent worktree layouts: the checkout lives in a per-session folder and the repository's name
 * is part of the path. `root` is the worktree folder; `repoName` the repository it belongs to.
 *   `.claude/worktrees/<repo>/<name>`, `.copilot/copilot-worktrees/<repo>/<name>`, `<repo>.worktrees/<name>`
 */
const WORKTREE_PATTERNS: RegExp[] = [
	/^(.*\/\.claude\/worktrees\/([^/]+)\/[^/]+)(?:\/|$)/i,
	/^(.*\/\.copilot\/copilot-worktrees\/([^/]+)\/[^/]+)(?:\/|$)/i,
	/^(.*\/([^/]+)\.worktrees\/[^/]+)(?:\/|$)/i,
];

/** The worktree folder and repository name of a path inside an agent worktree, else undefined. */
export function agentWorktreeInfo(filePath: string): { root: string; repoName: string } | undefined {
	const p = slashes(filePath);
	for (const pattern of WORKTREE_PATTERNS) {
		const m = pattern.exec(p);
		if (m) { return { root: m[1], repoName: m[2] }; }
	}
	return undefined;
}

interface RepoIdentity { key: string; label: string }

const nameIdentity = (repoName: string): RepoIdentity => ({ key: `name:${repoName.toLowerCase()}`, label: repoName });

function repoIdentity(session: RepoHeatmapSessionInput): RepoIdentity {
	if (session.repository) { return { key: session.repository, label: repoDisplayName(session.repository) }; }
	const folder = session.workspaceFolderPath ? slashes(session.workspaceFolderPath) : '';
	// Worktrees of a repository without a resolvable remote still belong together.
	const worktree = folder ? agentWorktreeInfo(folder) : undefined;
	if (worktree) { return nameIdentity(worktree.repoName); }
	if (folder) { return { key: folder.toLowerCase(), label: folder.split('/').pop() || folder }; }
	return { key: 'Unknown', label: 'Unknown' };
}

interface TouchTarget extends RepoIdentity { rel: string }

/**
 * Where one touch lands. A file inside an agent worktree other than the session's own folder
 * (a multi-root group folder, or a sibling worktree) belongs to that worktree's repository;
 * anything else is anchored to the session's workspace. Undefined: outside every known workspace.
 */
function resolveTouchTarget(session: RepoHeatmapSessionInput, identity: RepoIdentity, touch: FileTouch): TouchTarget | undefined {
	const abs = slashes(touch.path);
	const worktree = isAbsolute(abs) ? agentWorktreeInfo(abs) : undefined;
	const sessionRoot = session.workspaceFolderPath ? slashes(session.workspaceFolderPath).toLowerCase() : '';
	if (worktree && worktree.root.toLowerCase() !== sessionRoot) {
		return { ...nameIdentity(worktree.repoName), rel: abs.slice(worktree.root.length + 1) };
	}
	const rel = toRepoRelativePath(touch.path, session.workspaceFolderPath);
	return rel ? { ...identity, rel } : undefined;
}

// ── Payload ──────────────────────────────────────────────────────────────────

function touchDayKey(touch: FileTouch, fallback: string): string {
	return touch.ts !== undefined ? toLocalDayKey(new Date(touch.ts)) : fallback;
}

interface FileAcc { days: Record<string, KindCounts>; inferred: number; deletes: number }

function addTouch(files: Map<string, FileAcc>, relPath: string, dayKey: string, touch: FileTouch): void {
	let acc = files.get(relPath);
	if (!acc) { acc = { days: {}, inferred: 0, deletes: 0 }; files.set(relPath, acc); }
	const counts = (acc.days[dayKey] ??= EMPTY_COUNTS());
	counts[KIND_INDEX[touch.kind]]++;
	if (touch.kind === 'deleted') { acc.deletes++; if (touch.inferred) { acc.inferred++; } }
}

function totalOf(acc: FileAcc): number {
	let n = 0;
	for (const c of Object.values(acc.days)) { n += c[0] + c[1] + c[2] + c[3]; }
	return n;
}

function toRepo(key: string, label: string, files: Map<string, FileAcc>): RepoHeatmapRepo {
	const ranked = [...files.entries()].sort((a, b) => totalOf(b[1]) - totalOf(a[1]) || a[0].localeCompare(b[0]));
	const kept = ranked.slice(0, MAX_FILES_PER_REPO);
	return {
		key, label,
		files: kept.map(([path, acc]) => ({
			path,
			days: acc.days,
			...(acc.deletes > 0 && acc.inferred === acc.deletes ? { inferredDeletes: true } : {}),
		})),
		truncatedFiles: ranked.length - kept.length,
	};
}

type RepoAcc = { label: string; files: Map<string, FileAcc> };

function mergeFileAcc(into: FileAcc, from: FileAcc): void {
	for (const [day, c] of Object.entries(from.days)) {
		const target = (into.days[day] ??= EMPTY_COUNTS());
		for (let i = 0; i < 4; i++) { target[i] += c[i]; }
	}
	into.inferred += from.inferred;
	into.deletes += from.deletes;
}

/**
 * Folds worktree-name repositories (no remote known) into the one remote-keyed repository whose
 * name matches, so `ai-engineering-fluency` worktrees join `owner/ai-engineering-fluency`.
 * Ambiguous names (two remotes ending the same way) stay separate rather than guess.
 */
function mergeNameKeyedRepos(repos: Map<string, RepoAcc>): void {
	for (const [key, acc] of [...repos.entries()]) {
		if (!key.startsWith('name:')) { continue; }
		const name = key.slice('name:'.length);
		const matches = [...repos.entries()].filter(([k, r]) => !k.startsWith('name:') && r.label.split('/').pop()?.toLowerCase() === name);
		if (matches.length !== 1) { continue; }
		const target = matches[0][1].files;
		for (const [path, file] of acc.files) {
			const existing = target.get(path);
			if (existing) { mergeFileAcc(existing, file); } else { target.set(path, file); }
		}
		repos.delete(key);
	}
}

/** Folds every session's touches into per-repository, per-file, per-day counters. */
export function buildRepoHeatmapViewData(sessions: RepoHeatmapSessionInput[], now: Date): RepoHeatmapViewData {
	const repos = new Map<string, RepoAcc>();
	let outside = 0;
	for (const session of sessions) {
		const identity = repoIdentity(session);
		for (const touch of session.touches) {
			const target = resolveTouchTarget(session, identity, touch);
			// Repository and path names come from session metadata and logs — see protoGuard.ts.
			if (!target || isUnsafeObjectKey(target.key) || isUnsafeObjectKey(target.rel)) { outside++; continue; }
			let repo = repos.get(target.key);
			if (!repo) { repo = { label: target.label, files: new Map() }; repos.set(target.key, repo); }
			addTouch(repo.files, target.rel, touchDayKey(touch, session.fallbackDayKey), touch);
		}
	}
	mergeNameKeyedRepos(repos);
	const out = [...repos.entries()].map(([key, r]) => toRepo(key, r.label, r.files));
	// Busiest repository first: the view opens on it.
	out.sort((a, b) => repoTouchTotal(b) - repoTouchTotal(a) || a.label.localeCompare(b.label));
	return { repos: out, outsideRepoTouches: outside, lastUpdated: now.toISOString(), hasData: out.length > 0 };
}

function repoTouchTotal(repo: RepoHeatmapRepo): number {
	let n = 0;
	for (const f of repo.files) { for (const c of Object.values(f.days)) { n += c[0] + c[1] + c[2] + c[3]; } }
	return n;
}

// ── Period filtering and folder grouping ─────────────────────────────────────

export interface RepoHeatmapCell {
	/** File name (last path segment). */
	name: string;
	path: string;
	counts: KindCounts;
	/** Sum of the counts for the kinds selected by the filter. */
	total: number;
	inferredDeletes: boolean;
}

export interface RepoHeatmapFolder {
	/** Repository-relative folder, `.` for the repository root. */
	folder: string;
	files: RepoHeatmapCell[];
	counts: KindCounts;
	total: number;
}

export interface RepoHeatmapSummary {
	folders: RepoHeatmapFolder[];
	counts: KindCounts;
	fileCount: number;
	/** Largest per-cell `total`, the scale for cell colour. */
	maxCellTotal: number;
}

/** Local-day lower bound (inclusive) of a period; `0000-00-00` for all time. */
export function periodStartDayKey(period: ChartTimeWindow, now: Date): string {
	return getTimeWindowStartDayKey(period, now);
}

function sumKinds(counts: KindCounts, kinds: ReadonlySet<FileActivityKind>): number {
	let n = 0;
	for (const kind of FILE_ACTIVITY_KINDS) { if (kinds.has(kind)) { n += counts[KIND_INDEX[kind]]; } }
	return n;
}

function fileCellIn(file: RepoHeatmapFile, startKey: string, todayKey: string, kinds: ReadonlySet<FileActivityKind>): RepoHeatmapCell | undefined {
	const counts = EMPTY_COUNTS();
	for (const [day, c] of Object.entries(file.days)) {
		if (day < startKey || day > todayKey) { continue; }
		for (let i = 0; i < 4; i++) { counts[i] += c[i]; }
	}
	const total = sumKinds(counts, kinds);
	if (total === 0) { return undefined; }
	const name = file.path.split('/').pop() ?? file.path;
	return { name, path: file.path, counts, total, inferredDeletes: file.inferredDeletes === true };
}

function folderOf(path: string): string {
	const i = path.lastIndexOf('/');
	return i < 0 ? '.' : path.slice(0, i);
}

/**
 * One repository's files for a period and kind filter, grouped by folder. Folders sort by
 * activity (busiest first); files inside a folder likewise. A file only appears when it has
 * activity of a selected kind in the period.
 */
export function summarizeRepoHeatmap(
	repo: RepoHeatmapRepo,
	period: ChartTimeWindow,
	now: Date,
	kinds: ReadonlySet<FileActivityKind> = new Set(FILE_ACTIVITY_KINDS),
): RepoHeatmapSummary {
	const startKey = periodStartDayKey(period, now);
	const todayKey = toLocalDayKey(now);
	const byFolder = new Map<string, RepoHeatmapFolder>();
	const counts = EMPTY_COUNTS();
	let fileCount = 0, maxCellTotal = 0;
	for (const file of repo.files) {
		const cell = fileCellIn(file, startKey, todayKey, kinds);
		if (!cell) { continue; }
		fileCount++;
		maxCellTotal = Math.max(maxCellTotal, cell.total);
		const folder = folderOf(file.path);
		let group = byFolder.get(folder);
		if (!group) { group = { folder, files: [], counts: EMPTY_COUNTS(), total: 0 }; byFolder.set(folder, group); }
		group.files.push(cell);
		group.total += cell.total;
		for (let i = 0; i < 4; i++) { group.counts[i] += cell.counts[i]; counts[i] += cell.counts[i]; }
	}
	const folders = [...byFolder.values()];
	for (const f of folders) { f.files.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name)); }
	folders.sort((a, b) => b.total - a.total || a.folder.localeCompare(b.folder));
	return { folders, counts, fileCount, maxCellTotal };
}
