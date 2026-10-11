import { escapeHtml } from '../shared/formatUtils';
import { toSafeHttpUrl, toSafeNumber } from './agentSessionsSanitizer';
import { sanitizePrOutcomeCounts } from './agenticSignals';

/**
 * Sanitization for the Repository PRs snapshot received from the extension host.
 *
 * Titles, owners and repository names come from the GitHub API and are untrusted, so every
 * string is escaped here, at the trust boundary. Split out of `main.ts` to keep that file under
 * the `max-lines` ceiling and so it can be unit tested — same pattern as
 * `agentSessionsSanitizer.ts` in this folder.
 */

export type RepoPrDetail = {
  number: number;
  title: string;
  url: string;
  aiType: 'copilot' | 'claude' | 'openai' | 'other-ai';
  role: 'author' | 'reviewer-requested';
};

export type RepoPrInfo = {
  owner: string;
  repo: string;
  repoUrl: string;
  totalPrs: number;
  aiAuthoredPrs: number;
  aiReviewRequestedPrs: number;
  aiDetails: RepoPrDetail[];
  userAuthoredPrs?: number;
  userMergedPrs?: number;
  aiMergedPrs?: number;
  aiRevertedPrs?: number;
  otherMergedPrs?: number;
  otherRevertedPrs?: number;
  error?: string;
};

export type RepoPrStatsResult = {
  repos: RepoPrInfo[];
  authenticated: boolean;
  since: string;
  error?: string;
  /** When the snapshot was fetched from GitHub; empty string when it has never been fetched. */
  fetchedAt?: string;
  /** How often the snapshot is refreshed, so the UI can say when the next refresh is due. */
  refreshIntervalMs?: number;
};


/** Validate and escape the Repository PRs snapshot. */
export function sanitizeRepoPrStatsData(input: unknown): RepoPrStatsResult {
	const src = (input && typeof input === 'object') ? (input as Record<string, unknown>) : {};
	const repos = Array.isArray(src.repos) ? src.repos : [];
	return {
		authenticated: Boolean(src.authenticated),
		since: typeof src.since === 'string' || typeof src.since === 'number' ? src.since : Date.now(),
		error: typeof src.error === 'string' ? escapeHtml(src.error) : undefined,
		fetchedAt: typeof src.fetchedAt === 'string' ? src.fetchedAt : '',
		refreshIntervalMs: toSafeNumber(src.refreshIntervalMs),
		repos: repos.map((repo) => {
			const r = (repo && typeof repo === 'object') ? (repo as Record<string, unknown>) : {};
			const aiDetails = Array.isArray(r.aiDetails) ? r.aiDetails : [];
			return {
				repoUrl: toSafeHttpUrl(r.repoUrl),
				owner: escapeHtml(typeof r.owner === 'string' ? r.owner : ''),
				repo: escapeHtml(typeof r.repo === 'string' ? r.repo : ''),
				error: typeof r.error === 'string' ? escapeHtml(r.error) : '',
				totalPrs: toSafeNumber(r.totalPrs),
				aiAuthoredPrs: toSafeNumber(r.aiAuthoredPrs),
				aiReviewRequestedPrs: toSafeNumber(r.aiReviewRequestedPrs),
				userAuthoredPrs: toSafeNumber(r.userAuthoredPrs),
				userMergedPrs: toSafeNumber(r.userMergedPrs),
				...sanitizePrOutcomeCounts(r),
				aiDetails: aiDetails.map((d) => {
					const detail = (d && typeof d === 'object') ? (d as Record<string, unknown>) : {};
					const validAiTypes = ['copilot', 'claude', 'openai', 'other-ai'] as const;
					const validRoles = ['author', 'reviewer-requested'] as const;
					const aiType = validAiTypes.includes(detail.aiType as typeof validAiTypes[number])
						? detail.aiType as typeof validAiTypes[number]
						: 'other-ai';
					const role = validRoles.includes(detail.role as typeof validRoles[number])
						? detail.role as typeof validRoles[number]
						: 'author';
					return {
						number: toSafeNumber(detail.number),
						title: escapeHtml(typeof detail.title === 'string' ? detail.title : ''),
						url: toSafeHttpUrl(detail.url),
						aiType,
						role,
					};
				}),
			};
		}),
	} as RepoPrStatsResult;
}
