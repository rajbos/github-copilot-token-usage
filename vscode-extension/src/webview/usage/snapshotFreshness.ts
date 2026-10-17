/**
 * The freshness banner shared by the two GitHub-activity panels (Repository PRs and Cloud Agent).
 *
 * Both panels are served from a cache that is revalidated at most once an hour, by whichever VS
 * Code window holds that cache's lock, so the banner has to be explicit about what the user is
 * actually looking at:
 *
 * - **never fetched** — no snapshot yet; the first refresh will fill it in;
 * - **fresh** — how old it is and when the next refresh is due;
 * - **stale/revalidating** — the TTL has passed, so what is on screen is the cached snapshot while
 *   a refresh happens. Saying so beats silently showing hour-old numbers as if they were live;
 * - **partial** — a listing did not complete or a fetch budget ran out, so the figures below are a
 *   lower bound rather than a total.
 *
 * It always offers **Refresh now**, which asks the host to revalidate immediately. The host applies
 * its own cooldown and cross-window lock, so a click is a request, not a guaranteed API call.
 *
 * Lives in its own module (like `readiness.ts` and `agentSessionsSanitizer.ts`) so these states can
 * be unit tested without rendering the whole Usage Analysis panel.
 */
import { escapeHtml, getTimeSince } from '../shared/formatUtils';
import { localize } from '../shared/localization';

/** The message command the Refresh now button posts to the extension host. */
export const REFRESH_GITHUB_ACTIVITY_COMMAND = 'refreshGitHubActivity';

/** `data-action` the delegated click handler in `main.ts` looks for. */
export const REFRESH_GITHUB_ACTIVITY_ACTION = 'refresh-github-activity';

/** Shared styling for the two GitHub-activity freshness banners. */
const BOX_STYLE = 'margin-bottom:12px; padding:8px 10px; background:var(--bg-tertiary); border:1px solid var(--border-color); border-radius:6px; font-size:11px; color:var(--text-secondary);';

/** The button that asks the host for an immediate revalidation of both GitHub-activity caches. */
function refreshButtonHtml(): string {
	return `<button type="button" data-action="${REFRESH_GITHUB_ACTIVITY_ACTION}"
    style="margin-left:8px; padding:2px 8px; font-size:11px; cursor:pointer; border-radius:4px; border:1px solid var(--border-color); background:var(--bg-secondary); color:var(--text-primary);"
    title="${escapeHtml(localize('usage.githubActivity.refreshNowTooltip'))}">${escapeHtml(localize('usage.githubActivity.refreshNow'))}</button>`;
}

/** The subset of a snapshot the banner reads — both result shapes structurally satisfy it. */
export interface SnapshotFreshness {
	/** ISO timestamp of the cached snapshot; empty/absent when it has never been fetched. */
	fetchedAt?: string;
	/** How often the host revalidates, so the banner can say when the next refresh is due. */
	refreshIntervalMs?: number;
	/** True when the figures behind this banner are a lower bound. */
	partial?: boolean;
}

/** Which state the banner is in, split out so it can be asserted without parsing HTML. */
export type SnapshotFreshnessState = 'never-fetched' | 'fresh' | 'stale';

/**
 * Classify a snapshot for the banner. A snapshot with no known interval never reads as stale.
 *
 * This deliberately mirrors the host's own `isRepoPrSnapshotFresh()` / `isAgentTasksSnapshotFresh()`,
 * so the banner never contradicts what the host is actually doing behind it. Both of the host's
 * "this can't be trusted" cases count as stale here too:
 *
 * - a **`fetchedAt` that cannot be parsed** — the host refreshes such a snapshot on every open, so
 *   calling it fresh would suppress the revalidating state while a refresh ran every single time;
 * - a **`fetchedAt` more than one interval in the future** — a clock change, which the host refuses
 *   to let pin the cache open. The banner would otherwise advertise a next-refresh time that has
 *   not happened yet.
 *
 * An interval of zero is the one genuine unknown: with no policy to measure against, the banner
 * says "next refresh after unknown" rather than guessing at staleness.
 */
export function snapshotFreshnessState(data: SnapshotFreshness, now: number): SnapshotFreshnessState {
	if (!data.fetchedAt) { return 'never-fetched'; }
	const fetchedMs = Date.parse(data.fetchedAt);
	const intervalMs = data.refreshIntervalMs ?? 0;
	if (intervalMs <= 0) { return 'fresh'; }
	if (!Number.isFinite(fetchedMs)) { return 'stale'; }
	const age = now - fetchedMs;
	return age >= intervalMs || age < -intervalMs ? 'stale' : 'fresh';
}

/**
 * Localize a `{0}`/`{1}` template and interpolate already-safe HTML fragments into it.
 *
 * Unlike `localizeFormat()`, the **template itself** is escaped before substitution. A bundle value
 * is first-party, but it is still data: a stray `<` in a translation should render as text, not as
 * markup, and a helper that only escapes the arguments quietly trusts every future translator.
 * The arguments are the trusted half here — every caller builds them from `escapeHtml()` output.
 */
function localizeHtmlTemplate(key: string, ...safeHtmlArgs: string[]): string {
	return escapeHtml(localize(key)).replace(/\{(\d+)\}/g, (match, index) => {
		const i = Number(index);
		return i < safeHtmlArgs.length ? safeHtmlArgs[i] : match;
	});
}

/** The status line for a snapshot that has been fetched at least once. */
function statusLineHtml(data: SnapshotFreshness, state: SnapshotFreshnessState): string {
	const age = `<strong>${escapeHtml(getTimeSince(data.fetchedAt!))}</strong>`;
	if (state === 'stale') {
		return `⏳ <strong>${escapeHtml(localize('usage.githubActivity.revalidatingTitle'))}</strong> `
			+ localizeHtmlTemplate('usage.githubActivity.revalidatingBody', age);
	}
	const fetchedMs = Date.parse(data.fetchedAt!);
	const intervalMs = data.refreshIntervalMs ?? 0;
	const nextRefresh = Number.isFinite(fetchedMs) && intervalMs > 0
		? new Date(fetchedMs + intervalMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
		: localize('usage.githubActivity.unknownNextRefresh');
	return localizeHtmlTemplate('usage.githubActivity.updated', age, escapeHtml(nextRefresh));
}

/**
 * Render the freshness banner.
 *
 * @param partialNoteKey Localization key for the panel-specific explanation of *why* the data can
 *   be a lower bound — {@link REPO_PR_PARTIAL_NOTE_KEY} or {@link AGENT_SESSIONS_PARTIAL_NOTE_KEY}.
 * @param now Injected for testing; defaults to the current time.
 */
export function snapshotFreshnessHtml(
	data: SnapshotFreshness,
	options: { partialNoteKey: string },
	now: number = Date.now(),
): string {
	const state = snapshotFreshnessState(data, now);
	if (state === 'never-fetched') {
		return `<div style="${BOX_STYLE}">🕒 <strong>${escapeHtml(localize('usage.githubActivity.notFetchedTitle'))}</strong> `
			+ `${escapeHtml(localize('usage.githubActivity.notFetchedBody'))}${refreshButtonHtml()}</div>`;
	}
	const partial = data.partial
		? `<div style="margin-top:4px;">⚠️ <strong>${escapeHtml(localize('usage.githubActivity.partialTitle'))}</strong> `
			+ `${escapeHtml(localize(options.partialNoteKey))}</div>`
		: '';
	return `<div style="${BOX_STYLE}">
    ${statusLineHtml(data, state)}
    ${escapeHtml(localize('usage.githubActivity.cachePolicy'))}${refreshButtonHtml()}
    ${partial}
  </div>`;
}

/**
 * Whether a payload means "this identity has nothing cached yet" rather than "here is its data".
 *
 * The host pushes an empty, never-fetched snapshot whenever it discards the GitHub activity caches
 * — a sign-out, an account or Enterprise-host switch, or Clear Cache. The Usage Analysis panel is
 * created with `retainContextWhenHidden`, so its own copy of the previous identity's rows survives
 * that discard; without re-arming the lazy-load flag on this signal the tab would consider itself
 * already loaded and never ask for the new identity's data.
 */
export function isEmptyActivitySnapshot(data: { fetchedAt?: string; authenticated?: boolean }): boolean {
	return !data.authenticated || !data.fetchedAt;
}

/**
 * Whether a repo row should show *only* its error, with no counts.
 *
 * Only when the listing produced nothing. A listing that collected some pages and then failed keeps
 * those entities deliberately, and the freshness banner is already calling the figures a lower
 * bound — blanking them would contradict it and discard the one thing the failed pass did collect.
 */
export function shouldRenderErrorOnlyRow(error: string | undefined, collected: number): boolean {
	return Boolean(error) && collected <= 0;
}

/** Localization key for why the Repository PRs figures can be a lower bound. */
export const REPO_PR_PARTIAL_NOTE_KEY = 'usage.githubActivity.partialRepoPrs';

/** Localization key for why the Cloud Agent figures can be a lower bound. */
export const AGENT_SESSIONS_PARTIAL_NOTE_KEY = 'usage.githubActivity.partialAgentTasks';
