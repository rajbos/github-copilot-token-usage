/**
 * Repeated-task detection (research feature).
 *
 * Clusters the first user prompt of each session to find tasks the user
 * keeps prompting for manually — candidates that would be better served by a
 * reusable skill, prompt file, or custom agent. Example: "run the tests and
 * fix the failures" typed at the start of five different sessions.
 *
 * Approach (deliberately cheap, no embeddings or LLM calls):
 * - Normalize each prompt: lowercase, strip punctuation, drop stopwords and
 *   very short tokens. Prompts that are already a slash command ("/fix ...")
 *   or too short to describe a task are excluded.
 * - Greedy clustering by Jaccard similarity on token sets (>= THRESHOLD).
 *   O(n²) over the analysis window's sessions, which is small in practice.
 * - A cluster with sessions in at least MIN_CLUSTER_SIZE distinct sessions is
 *   a repeated-task candidate.
 *
 * This module is intentionally pure (no VS Code API, no filesystem access) so
 * it can be unit-tested with mocked data and reused by the CLI and the webview.
 */
import type { RepeatedTaskCluster, RepeatedTaskReport, RepeatedTaskSessionRef } from './types';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Minimum token-set Jaccard similarity for two prompts to cluster together. */
export const PROMPT_SIMILARITY_THRESHOLD = 0.5;

/** Minimum number of sessions in a cluster before it is reported. */
export const MIN_CLUSTER_SIZE = 2;

/** Prompts shorter than this (after trimming) carry no task signal. */
const MIN_PROMPT_LENGTH = 15;

/** Prompts are stored/compared truncated to this length. */
export const MAX_PROMPT_LENGTH = 500;

/** Representative prompt shown in the UI is truncated to this length. */
const REPRESENTATIVE_LENGTH = 200;

/** Common English words that carry no task identity. */
const STOPWORDS = new Set([
	'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'else', 'for', 'to', 'of', 'in', 'on', 'at',
	'by', 'with', 'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'it', 'this',
	'that', 'these', 'those', 'i', 'me', 'my', 'we', 'you', 'your', 'they', 'them', 'their', 'he',
	'she', 'his', 'her', 'do', 'does', 'did', 'done', 'can', 'could', 'should', 'would', 'will',
	'shall', 'may', 'might', 'must', 'not', 'no', 'yes', 'please', 'also', 'just', 'so', 'than',
	'then', 'there', 'here', 'when', 'where', 'which', 'who', 'what', 'how', 'why', 'all', 'any',
	'some', 'into', 'out', 'up', 'down', 'over', 'under', 'again', 'once', 'now', 'still', 'make',
	'sure', 'let', 'us', 'go', 'ahead', 'ok', 'okay', 'thanks', 'thank', 'hi', 'hello', 'hey',
]);

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/** A session's prompt plus the display context needed for the report. */
export interface RepeatedTaskInput {
	prompt: string;
	session: RepeatedTaskSessionRef;
}

/**
 * Normalize a raw prompt into a set of content tokens.
 * Returns null when the prompt should be excluded entirely (slash commands —
 * already a reusable invocation — and prompts too short to describe a task).
 */
export function normalizePromptTokens(prompt: string): Set<string> | null {
	const trimmed = prompt.trim();
	if (trimmed.length < MIN_PROMPT_LENGTH || trimmed.startsWith('/')) { return null; }
	const tokens = trimmed
		.slice(0, MAX_PROMPT_LENGTH)
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, ' ')
		.split(/\s+/)
		.filter(t => t.length >= 3 && !STOPWORDS.has(t));
	if (tokens.length === 0) { return null; }
	return new Set(tokens);
}

/** Jaccard similarity of two token sets: |intersection| / |union|. */
export function tokenSimilarity(a: Set<string>, b: Set<string>): number {
	let intersection = 0;
	for (const t of a) { if (b.has(t)) { intersection++; } }
	const union = a.size + b.size - intersection;
	return union === 0 ? 0 : intersection / union;
}

// ---------------------------------------------------------------------------
// Clustering
// ---------------------------------------------------------------------------

/** Tokens shared by every member of the cluster, capped for display. */
function sharedKeywords(membersTokens: Set<string>[]): string[] {
	if (membersTokens.length === 0) { return []; }
	const counts = new Map<string, number>();
	for (const tokens of membersTokens) {
		for (const t of tokens) { counts.set(t, (counts.get(t) ?? 0) + 1); }
	}
	return [...counts.entries()]
		.filter(([, n]) => n === membersTokens.length)
		.sort((a, b) => b[0].length - a[0].length)
		.slice(0, 8)
		.map(([t]) => t);
}

interface TaskMember { input: RepeatedTaskInput; tokens: Set<string>; }
interface TaskClusterState { members: TaskMember[]; centroid: Set<string>; }

/** Find the most similar cluster above the threshold (null when none qualifies). */
function bestMatchingCluster(clusters: TaskClusterState[], tokens: Set<string>): TaskClusterState | null {
	let best: TaskClusterState | null = null;
	let bestSim = PROMPT_SIMILARITY_THRESHOLD;
	for (const c of clusters) {
		const sim = tokenSimilarity(c.centroid, tokens);
		if (best === null ? sim >= PROMPT_SIMILARITY_THRESHOLD : sim > bestSim) {
			best = c;
			bestSim = sim;
		}
	}
	return best;
}

/** Recompute the centroid as the strict-majority token set of the members. */
function recomputeCentroid(cluster: TaskClusterState): void {
	const counts = new Map<string, number>();
	for (const m of cluster.members) { for (const t of m.tokens) { counts.set(t, (counts.get(t) ?? 0) + 1); } }
	const majority = Math.floor(cluster.members.length / 2) + 1;
	cluster.centroid = new Set([...counts.entries()].filter(([, n]) => n >= majority).map(([t]) => t));
}

/** Assign one normalized prompt to its best cluster, or start a new cluster. */
function assignToCluster(clusters: TaskClusterState[], input: RepeatedTaskInput, tokens: Set<string>): void {
	const best = bestMatchingCluster(clusters, tokens);
	if (!best) {
		clusters.push({ members: [{ input, tokens }], centroid: tokens });
		return;
	}
	best.members.push({ input, tokens });
	recomputeCentroid(best);
}

/**
 * Cluster session prompts into repeated-task candidates.
 * Returns clusters largest-first; each cluster's sessions are most-recent-first.
 */
export function detectRepeatedTasks(inputs: RepeatedTaskInput[]): RepeatedTaskCluster[] {
	const members: TaskMember[] = [];
	for (const input of inputs) {
		const tokens = normalizePromptTokens(input.prompt);
		if (tokens) { members.push({ input, tokens }); }
	}
	return clusterMembers(members);
}

/** Cluster already-normalized prompts (see detectRepeatedTasks). */
function clusterMembers(members: readonly TaskMember[]): RepeatedTaskCluster[] {
	const clusters: TaskClusterState[] = [];

	// Sort by session file so identical data clusters identically across
	// refreshes even when session discovery order varies by adapter/OS.
	const sortedMembers = members.slice().sort((a, b) => a.input.session.file.localeCompare(b.input.session.file));

	for (const { input, tokens } of sortedMembers) {
		assignToCluster(clusters, input, tokens);
	}

	return clusters
		.filter(c => c.members.length >= MIN_CLUSTER_SIZE)
		.map(c => {
			const sessions = c.members
				.map(m => m.input.session)
				.sort((a, b) => (b.lastInteraction ?? '').localeCompare(a.lastInteraction ?? ''));
			const repositories = [...new Set(sessions.map(s => s.repository).filter((r): r is string => !!r))].sort();
			const representative = sessions[0];
			const representativeInput = c.members.find(m => m.input.session === representative)!.input.prompt.trim();
			return {
				representativePrompt: representativeInput.length > REPRESENTATIVE_LENGTH
					? representativeInput.slice(0, REPRESENTATIVE_LENGTH).replace(/\s+\S*$/, '') + '…'
					: representativeInput,
				sessionCount: c.members.length,
				repositories,
				sessions,
				sharedKeywords: sharedKeywords(c.members.map(m => m.tokens)),
			};
		})
		.sort((a, b) => b.sessionCount - a.sessionCount);
}

// ---------------------------------------------------------------------------
// Report building (shared by the VS Code extension and the CLI)
// ---------------------------------------------------------------------------

/** `scheme://host/...` remote URLs (not `file:`), and scp-like `user@host:path`. */
const REMOTE_URL_PATTERN = /^(?!file:)[a-z][a-z0-9+.-]*:\/\/[^/\s]+\/|^[^\s/@:]+@[^\s/:]+:/i;

/**
 * Short `owner/repo` display name for a repository remote URL
 * (`https://github.com/o/r.git`, `ssh://git@host/o/r`, `git@github.com:o/r`).
 * Anything that is not a remote URL — a bare name, `owner/repo`, a filesystem
 * path — is returned unchanged.
 */
export function repoDisplayName(repository: string): string {
	if (!REMOTE_URL_PATTERN.test(repository)) { return repository; }
	const m = repository.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/);
	return m ? m[1] : repository;
}

/** What a host knows about one parsed session, before clustering. */
export interface RepeatedTaskSessionSource {
	file: string;
	/** `SessionUsageAnalysis.firstUserPrompt`; sessions without one are skipped. */
	firstUserPrompt?: string | null;
	title?: string | null;
	/** ISO timestamp of the last interaction; falls back to `mtime` when absent. */
	lastInteraction?: string | null;
	/** File modification time in epoch milliseconds. */
	mtime: number;
	/** Repository remote URL or name; shortened with `repoDisplayName()`. */
	repository?: string | null;
}

/**
 * Map a parsed session to clustering input, or null when it has no usable
 * prompt: missing, or one `normalizePromptTokens()` excludes (slash command,
 * too short, stopwords only) and clustering would drop anyway.
 */
export function toRepeatedTaskInput(source: RepeatedTaskSessionSource): RepeatedTaskInput | null {
	return toTaskMember(source)?.input ?? null;
}

/** toRepeatedTaskInput() plus the prompt's normalized tokens, computed once. */
function toTaskMember(source: RepeatedTaskSessionSource): TaskMember | null {
	if (!source.firstUserPrompt) { return null; }
	const tokens = normalizePromptTokens(source.firstUserPrompt);
	if (!tokens) { return null; }
	return {
		tokens,
		input: {
			prompt: source.firstUserPrompt,
			session: {
				file: source.file,
				title: source.title ?? null,
				lastInteraction: source.lastInteraction ?? new Date(source.mtime).toISOString(),
				repository: source.repository ? repoDisplayName(source.repository) : undefined,
			},
		},
	};
}

/**
 * Build the repeated-task report from parsed sessions: cluster the first user
 * prompt of every session that has one. Returns undefined when no cluster
 * reaches MIN_CLUSTER_SIZE.
 */
export function buildRepeatedTaskReport(sources: readonly RepeatedTaskSessionSource[]): RepeatedTaskReport | undefined {
	const members: TaskMember[] = [];
	for (const source of sources) {
		const member = toTaskMember(source);
		if (member) { members.push(member); }
	}
	const clusters = clusterMembers(members);
	if (clusters.length === 0) { return undefined; }
	return { minClusterSize: MIN_CLUSTER_SIZE, sessionsScanned: members.length, clusters };
}
