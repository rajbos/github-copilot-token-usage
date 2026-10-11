import { escapeHtml } from '../shared/formatUtils';
import { localize, localizeFormat } from '../shared/localization';

interface CcrLookup { owner: string; repo: string; prNumber: number; message?: unknown }

/**
 * Lookups started or answered this session, so a table re-render (sort / page) that recreates the
 * buttons can put back their "Checking…" or result text — see `replayCcrActivityResults`.
 */
const ccrLookups = new Map<string, CcrLookup>();

function ccrKey(owner: string, repo: string, prNumber: number): string {
	return `${owner}/${repo}#${prNumber}`;
}

/**
 * Inline "Check actual CCR activity" button + result placeholder for one reviewer-requested PR
 * detail row. On-demand only — see `handleCheckCcrActivity` in `extension.ts` for why this isn't
 * part of the bulk Repository PRs snapshot.
 *
 * `type="button"` is explicit: this markup can land inside a `<form>`-bearing ancestor elsewhere
 * on the panel, and a `<button>` with no type defaults to `type="submit"`, which would fire that
 * form instead of just running the click handler below.
 */
export function renderCcrCheckButtonHtml(owner: string, repo: string, prNumber: number): string {
	const o = escapeHtml(owner);
	const r = escapeHtml(repo);
	const label = escapeHtml(localize('usage.repoPrs.ccrCheckButton'));
	return ` <button type="button" class="btn-check-ccr" data-owner="${o}" data-repo="${r}" data-pr="${prNumber}" style="font-size:10px; padding:1px 6px; cursor:pointer; background:var(--bg-tertiary); color:var(--text-secondary); border:1px solid var(--border-color); border-radius:4px;">${label}</button><span class="ccr-activity-result" data-ccr-result="${o}/${r}#${prNumber}" style="margin-left:6px; font-size:11px; color:var(--text-secondary);"></span>`;
}

/**
 * Delegated click handler for `.btn-check-ccr` buttons inside `containerId`. Attached once to the
 * persistent container element, so it keeps working across re-renders that replace the container's
 * innerHTML (e.g. `updateReposPrPanel`) without needing to be rewired.
 */
export function wireCcrActivityButtons(containerId: string, postMessage: (message: unknown) => void): void {
	document.getElementById(containerId)?.addEventListener('click', (e: MouseEvent) => {
		const btn = (e.target as HTMLElement).closest<HTMLElement>('.btn-check-ccr');
		if (!btn) { return; }
		const owner = btn.getAttribute('data-owner');
		const repo = btn.getAttribute('data-repo');
		const prNumber = Number(btn.getAttribute('data-pr'));
		if (!owner || !repo || !Number.isFinite(prNumber)) { return; }
		btn.setAttribute('disabled', 'true');
		ccrLookups.set(ccrKey(owner, repo, prNumber), { owner, repo, prNumber });
		const resultEl = document.querySelector<HTMLElement>(`[data-ccr-result="${owner}/${repo}#${prNumber}"]`);
		if (resultEl) { resultEl.textContent = localize('usage.repoPrs.ccrChecking'); }
		postMessage({ command: 'checkCcrActivity', owner, repo, prNumber });
	});
}

/** Renders the response of an on-demand `checkCcrActivity` lookup next to the button that triggered it. */
export function renderCcrActivityResult(owner: string, repo: string, prNumber: number, message: any): void {
	ccrLookups.set(ccrKey(owner, repo, prNumber), { owner, repo, prNumber, message });
	const resultEl = document.querySelector<HTMLElement>(`[data-ccr-result="${owner}/${repo}#${prNumber}"]`);
	const btn = document.querySelector<HTMLButtonElement>(`.btn-check-ccr[data-owner="${owner}"][data-repo="${repo}"][data-pr="${prNumber}"]`);
	btn?.removeAttribute('disabled');
	if (!resultEl) { return; }
	if (message.command === 'ccrActivityError') {
		const reason = typeof message.error === 'string' ? message.error : localize('usage.repoPrs.ccrFailedToLoad');
		resultEl.textContent = `⚠️ ${reason}`;
		resultEl.style.color = 'var(--text-secondary)';
		return;
	}
	const reviews = Array.isArray(message.reviews) ? message.reviews : [];
	const requests = Array.isArray(message.requests) ? message.requests : [];
	if (reviews.length === 0) {
		resultEl.textContent = localize('usage.repoPrs.ccrNoReviews');
		return;
	}
	// The host already drops any review-request event with no real actor login (see
	// fetchPrCopilotReviewRequestsPage) rather than sending a placeholder — filter defensively
	// here too so a malformed message can't put a blank/"unknown" name in front of the user.
	const requesterNames: string[] = requests
		.map((req: any) => (typeof req.requestedBy === 'string' ? req.requestedBy : ''))
		.filter((name: string) => name.length > 0);
	const requesters = [...new Set(requesterNames)];
	const requestedBy = requesters.length > 0
		? localizeFormat('usage.repoPrs.ccrRequestedBy', requesters.join(', '))
		: '';
	const reviewCount = localizeFormat('usage.repoPrs.ccrReviewCount', String(reviews.length));

	// Built as real DOM nodes rather than an innerHTML/setHtml() string: every value here is plain
	// text (a review count, requester logins, a tooltip), so there is no HTML to render and no
	// reason to route it through the parser at all.
	resultEl.replaceChildren();
	resultEl.appendChild(document.createTextNode(`${reviewCount}${requestedBy} `));
	const infoIcon = document.createElement('span');
	infoIcon.title = localize('usage.repoPrs.ccrInfoTooltip');
	infoIcon.textContent = 'ℹ️';
	resultEl.appendChild(infoIcon);
}

/** Restores every pending or answered lookup onto freshly rendered buttons (after a table re-render). */
export function replayCcrActivityResults(): void {
	for (const lookup of [...ccrLookups.values()]) {
		if (lookup.message !== undefined) {
			renderCcrActivityResult(lookup.owner, lookup.repo, lookup.prNumber, lookup.message);
			continue;
		}
		const key = ccrKey(lookup.owner, lookup.repo, lookup.prNumber);
		const resultEl = document.querySelector<HTMLElement>(`[data-ccr-result="${key}"]`);
		if (resultEl) { resultEl.textContent = localize('usage.repoPrs.ccrChecking'); }
		resultEl?.previousElementSibling?.setAttribute('disabled', 'true');
	}
}
