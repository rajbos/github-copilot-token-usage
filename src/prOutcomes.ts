/**
 * What happens to pull requests after they merge: an escaped-defect proxy.
 *
 * GitHub's Agentic Engineering System asks that escaped defects stay flat or
 * fall as agent use expands. A local tool cannot see incidents or customer
 * reports, but it can see reverts: a merged pull request that a later pull
 * request reverted. This module finds those in the pull-request list the
 * extension already fetches (`GET /pulls?state=all`), so it costs no extra
 * API calls, and splits them into agent-authored pull requests and the
 * baseline of everyone else's.
 *
 * Known blind spots — the number is a lower bound: reverts pushed straight to
 * the branch, fix-forwards, and reverts whose title and body were rewritten
 * are not detected. Pure — no network, no VS Code API.
 */

/** The fields of a `GET /pulls` list item this module reads. */
export interface PrListItem {
	number: number;
	title?: string | null;
	body?: string | null;
	created_at?: string | null;
	merged_at?: string | null;
}

export interface PrOutcomeCounts {
	/** Agent-authored pull requests that merged (reverts themselves excluded). */
	aiMergedPrs: number;
	/** …of which a later pull request reverted. */
	aiRevertedPrs: number;
	/** Everyone else's merged pull requests (reverts themselves excluded) — the baseline. */
	otherMergedPrs: number;
	otherRevertedPrs: number;
	/** Agent-authored pull requests opened in the more recent half of the window… */
	aiAuthoredRecent: number;
	/** …and in the earlier half, to see whether review load is rising. */
	aiAuthoredEarlier: number;
}

const REVERT_TITLE = /^Revert\s+"(.*)"\s*$/is;
/** GitHub's revert button writes `Reverts owner/repo#123` into the body. */
const REVERTS_BODY = /\bReverts\s+(?:([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+))?#(\d+)\b/i;

/** True when a pull request is itself a revert. */
export function isRevertPr(pr: Pick<PrListItem, 'title'>): boolean {
	return REVERT_TITLE.test(pr.title?.trim() ?? '');
}

/**
 * Numbers of pull requests in `prs` that a merged revert pull request in
 * `prs` reverted. A body reference to another repository is ignored; a revert
 * without a body reference is matched by the quoted title against merged pull
 * requests merged before it.
 */
export function findRevertedPrNumbers(prs: readonly PrListItem[], nameWithOwner: string): Set<number> {
	const reverted = new Set<number>();
	const slug = nameWithOwner.toLowerCase();
	const merged = prs.filter(pr => pr.merged_at);
	for (const revert of merged) {
		const titleMatch = REVERT_TITLE.exec(revert.title?.trim() ?? '');
		if (!titleMatch) { continue; }
		const bodyMatch = REVERTS_BODY.exec(revert.body ?? '');
		if (bodyMatch) {
			if (!bodyMatch[1] || bodyMatch[1].toLowerCase() === slug) { reverted.add(Number(bodyMatch[2])); }
			continue;
		}
		const quoted = titleMatch[1].trim();
		const revertedAt = Date.parse(revert.merged_at!);
		const original = merged
			.filter(pr => pr.number !== revert.number && pr.title?.trim() === quoted && Date.parse(pr.merged_at!) <= revertedAt)
			.sort((a, b) => Date.parse(b.merged_at!) - Date.parse(a.merged_at!))[0];
		if (original) { reverted.add(original.number); }
	}
	return reverted;
}

/** Which half of the window a pull request was opened in, or undefined when its date is unusable. */
function windowHalf(pr: PrListItem, midpoint: number): 'recent' | 'earlier' | undefined {
	const created = Date.parse(pr.created_at ?? '');
	if (!Number.isFinite(created)) { return undefined; }
	return created >= midpoint ? 'recent' : 'earlier';
}

/**
 * Count merged and reverted pull requests for agents and for everyone else,
 * and split agent-authored pull requests across the two halves of the window.
 */
export function summarizePrOutcomes<T extends PrListItem>(
	prs: readonly T[],
	isAgentAuthored: (pr: T) => boolean,
	nameWithOwner: string,
	window: { sinceMs: number; nowMs: number },
): PrOutcomeCounts {
	const reverted = findRevertedPrNumbers(prs, nameWithOwner);
	const midpoint = window.sinceMs + (window.nowMs - window.sinceMs) / 2;
	const counts: PrOutcomeCounts = {
		aiMergedPrs: 0, aiRevertedPrs: 0, otherMergedPrs: 0, otherRevertedPrs: 0, aiAuthoredRecent: 0, aiAuthoredEarlier: 0,
	};
	for (const pr of prs) {
		const agent = isAgentAuthored(pr);
		const half = agent ? windowHalf(pr, midpoint) : undefined;
		if (half === 'recent') { counts.aiAuthoredRecent++; }
		if (half === 'earlier') { counts.aiAuthoredEarlier++; }
		if (!pr.merged_at || isRevertPr(pr)) { continue; }
		const wasReverted = reverted.has(pr.number) ? 1 : 0;
		if (agent) {
			counts.aiMergedPrs++;
			counts.aiRevertedPrs += wasReverted;
		} else {
			counts.otherMergedPrs++;
			counts.otherRevertedPrs += wasReverted;
		}
	}
	return counts;
}
