/**
 * Host-driven "take me to this section" navigation, shared by every panel that
 * has no navigation protocol of its own (the usage panel has `switchTab`).
 *
 * The host posts `{ command: 'revealSurface', tab?, subtab?, anchor?, selector? }`.
 * The panel then does what a user would: clicks the tab's group button (when the
 * tab sits in a grouped leaf bar), clicks the tab, clicks the sub-tab, and
 * scrolls the section into view. Clicking rather than flipping classes is
 * deliberate — a tab's click handler is where lazy loaders and the
 * `viewTabOpened` bookkeeping live, so a programmatic switch that skipped it
 * would land on an empty tab.
 *
 * A freshly created panel cannot receive the request before its script has run,
 * so {@link installSurfaceNavigation} reports `surfaceNavReady` once the listener
 * is in place and the host replays anything it was holding for that view.
 */
import { registerMessageHandler } from './messageHandler';

export type SurfaceRevealRequest = {
	command: 'revealSurface';
	/** The host's id for this request, echoed back in the acknowledgement. */
	requestId?: number;
	/** `data-tab` value of the tab to open. */
	tab?: string;
	/** `data-subtab` value of a sub-tab inside that tab. */
	subtab?: string;
	/** Element id to scroll to. Preferred over `selector`. */
	anchor?: string;
	/** CSS selector to scroll to, for sections that have no id. First match wins. */
	selector?: string;
};

// Method syntax on purpose: parameters stay bivariant, so a panel whose API takes its own message union still fits.
type PostMessageApi = { postMessage(message: unknown): void };

/** The tab-button classes the panels use. A `data-tab` on anything else (e.g. a panel) is not a button. */
const TAB_BUTTON_SELECTORS = ['.tab-button', '.tab', '.eff-tab', '.tab-btn', '.wn-tab'];

/**
 * How long one reveal may wait in total for its tab, sub-tab and section to
 * appear (panels render after their data arrives — the dashboard can take a
 * while to load from a backend). One budget shared by every step, matching the
 * host's SURFACE_REVEAL_TTL_MS for the request itself.
 */
const REVEAL_BUDGET_MS = 60_000;

/**
 * How long a landed section must stay in the DOM before the reveal is reported
 * done. Long enough for a panel's cached-then-fresh re-render (the dashboard)
 * to replace it, so the reveal follows the fresh node instead of being lost.
 */
const SETTLE_MS = 2_000;

/** How long to let a tab switch paint before measuring where to scroll. */
const PAINT_DELAY_MS = 50;

/** Bumped by every new request, so a newer reveal supersedes one still waiting. */
let revealGeneration = 0;
const POLL_INTERVAL_MS = 100;

function cssString(value: string): string {
	return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
		? CSS.escape(value)
		: value.replace(/["\\]/g, '\\$&');
}

/**
 * Resolves with the first element `find` returns, polling until it appears,
 * the timeout passes, or `isAbandoned` reports that nobody needs the answer
 * any more — so a superseded or cancelled reveal stops polling straight away
 * instead of running out its whole budget.
 */
export function waitForElement<T extends Element>(
	find: () => T | null,
	timeoutMs: number,
	isAbandoned: () => boolean = () => false,
): Promise<T | null> {
	const first = find();
	if (first) { return Promise.resolve(first); }
	return new Promise((resolve) => {
		const started = Date.now();
		const timer = setInterval(() => {
			if (isAbandoned()) {
				clearInterval(timer);
				resolve(null);
				return;
			}
			const found = find();
			if (found || Date.now() - started >= timeoutMs) {
				clearInterval(timer);
				resolve(found);
			}
		}, POLL_INTERVAL_MS);
	});
}

function findTabButton(tab: string): HTMLElement | null {
	const value = cssString(tab);
	const selector = TAB_BUTTON_SELECTORS.map((cls) => `${cls}[data-tab="${value}"]`).join(', ');
	return document.querySelector<HTMLElement>(selector);
}

/**
 * Grouped panels (usage, diagnostics) hide every leaf bar but the active
 * group's. Open the group the tab lives in first, so the user sees the tab bar
 * they landed on.
 */
function openGroupOf(tabButton: HTMLElement): void {
	const group = tabButton.closest<HTMLElement>('[data-group]')?.dataset.group;
	if (!group || tabButton.classList.contains('group-tab')) { return; }
	const groupButton = document.querySelector<HTMLElement>(`.group-tab[data-group="${cssString(group)}"]`);
	if (groupButton && !groupButton.classList.contains('active')) { groupButton.click(); }
}

/** In-flight flashes: the inline styles to restore, and the timer that restores them. */
const activeFlashes = new WeakMap<HTMLElement, { boxShadow: string; transition: string; timer: ReturnType<typeof setTimeout> }>();

/**
 * Briefly outlines the section that was scrolled to, so the eye finds it. A
 * second flash on the same element restarts the timer but keeps the styles
 * captured by the first, so the outline can never become the "original".
 */
export function flashSection(target: HTMLElement): void {
	const inFlight = activeFlashes.get(target);
	if (inFlight) { clearTimeout(inFlight.timer); }
	const original = inFlight ?? { boxShadow: target.style.boxShadow, transition: target.style.transition };
	target.style.transition = 'box-shadow 0.3s ease';
	target.style.boxShadow = '0 0 0 2px var(--vscode-focusBorder, #3794ff)';
	const timer = setTimeout(() => {
		target.style.boxShadow = original.boxShadow;
		target.style.transition = original.transition;
		activeFlashes.delete(target);
	}, 2000);
	activeFlashes.set(target, { boxShadow: original.boxShadow, transition: original.transition, timer });
}

/**
 * A section can sit inside a tab panel that is currently hidden — e.g. the
 * dashboard's Azure sections while its Team Server tab is showing. Click the
 * tab that controls the nearest hidden ancestor (found by `aria-controls`), so
 * the scroll lands on something visible.
 */
function revealHiddenAncestors(target: HTMLElement): void {
	for (let node: HTMLElement | null = target; node; node = node.parentElement) {
		if (!node.id) { continue; }
		const hidden = node.hidden || getComputedStyle(node).display === 'none';
		if (!hidden) { continue; }
		const controller = document.querySelector<HTMLElement>(`[aria-controls="${cssString(node.id)}"]`);
		controller?.click();
	}
}

/**
 * How far a deep link may take the user's eye: instant when they asked the OS for
 * reduced motion (as the dashboard and diagnostics animations already respect), else smooth.
 */
export function preferredScrollBehavior(): ScrollBehavior {
	const reduce = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
		&& window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	return reduce ? 'auto' : 'smooth';
}

/** How to find the element a request scrolls to, or null when it names none. */
function targetFinder(request: SurfaceRevealRequest): (() => HTMLElement | null) | null {
	const { anchor, selector } = request;
	if (anchor) { return () => document.getElementById(anchor); }
	if (selector) { return () => document.querySelector<HTMLElement>(selector); }
	return null;
}

/**
 * Carries out a reveal. Resolves `true` once every requested step was found
 * and acted on, `false` if one never appeared within the budget or a newer
 * request took over — in which case nothing has been acknowledged and the
 * host still holds the request.
 */
export async function revealSurface(
	request: SurfaceRevealRequest,
	budgetMs = REVEAL_BUDGET_MS,
	settleMs = SETTLE_MS,
): Promise<boolean> {
	const generation = ++revealGeneration;
	const deadline = Date.now() + budgetMs;
	const remaining = (): number => Math.max(0, deadline - Date.now());
	const superseded = (): boolean => generation !== revealGeneration;
	if (!(await openTabs(request, remaining, superseded))) { return false; }
	const find = targetFinder(request);
	if (!find) { return true; }
	const found = await waitForElement(find, remaining(), superseded);
	if (!found || superseded()) { return false; }
	revealHiddenAncestors(found);
	// Let the tab switch paint before scrolling, or the scroll measures the old
	// layout. Then look the section up again: a panel can replace its whole DOM
	// in that window (the dashboard swaps cached data for fresh), which would
	// leave `found` detached and the scroll landing nowhere.
	await new Promise((resolve) => setTimeout(resolve, PAINT_DELAY_MS));
	if (superseded()) { return false; }
	const target = found.isConnected ? found : await waitForElement(find, remaining(), superseded);
	if (!target || superseded()) { return false; }
	landOn(target);
	return settle(target, find, settleMs, remaining, superseded);
}

/** Clicks the request's tab (after its group) and sub-tab once they exist. False if one never appears. */
async function openTabs(request: SurfaceRevealRequest, remaining: () => number, superseded: () => boolean): Promise<boolean> {
	const tab = request.tab;
	if (tab) {
		const tabButton = await waitForElement(() => findTabButton(tab), remaining(), superseded);
		if (!tabButton || superseded()) { return false; }
		openGroupOf(tabButton);
		tabButton.click();
	}
	const subtabId = request.subtab;
	if (subtabId) {
		const subtab = await waitForElement(() =>
			document.querySelector<HTMLElement>(`.subtab[data-subtab="${cssString(subtabId)}"]`), remaining(), superseded);
		if (!subtab || superseded()) { return false; }
		subtab.click();
	}
	return true;
}

/**
 * Stays with a landed section for `settleMs` before reporting success: a panel
 * that first renders cached data and then fresh data (the dashboard) replaces the
 * node just scrolled to. Follow it to the fresh node and land again, so the
 * request is only acknowledged once the landing has stuck.
 */
async function settle(
	landed: HTMLElement,
	find: () => HTMLElement | null,
	settleMs: number,
	remaining: () => number,
	superseded: () => boolean,
): Promise<boolean> {
	let target = landed;
	let settledSince = Date.now();
	while (Date.now() - settledSince < settleMs) {
		await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
		if (superseded()) { return false; }
		if (target.isConnected) { continue; }
		const replacement = await waitForElement(find, remaining(), superseded);
		if (!replacement || superseded()) { return false; }
		target = replacement;
		landOn(target);
		settledSince = Date.now();
	}
	return true;
}

function landOn(target: HTMLElement): void {
	revealHiddenAncestors(target);
	target.scrollIntoView({ behavior: preferredScrollBehavior(), block: 'start' });
	flashSection(target);
}

/**
 * Abandons any reveal still waiting for its tab or section — the user went to
 * the view itself since, and a late scroll would yank them away from it.
 */
export function cancelReveal(): void {
	revealGeneration++;
}

/**
 * Wires a panel up for host-driven navigation. Call once at module load, with
 * the panel's view id as the host knows it.
 */
export function installSurfaceNavigation(vscode: PostMessageApi, view: string): void {
	registerMessageHandler<{ command?: string } & Omit<Partial<SurfaceRevealRequest>, 'command'>>((message) => {
		if (message?.command === 'cancelReveal') {
			cancelReveal();
			return;
		}
		if (message?.command === 'revealSurface') {
			// Acknowledge only once the reveal landed: until then the host keeps the
			// request, so a reload of this panel (its ready handshake) can retry it.
			void revealSurface(message as SurfaceRevealRequest).then((landed) => {
				if (landed) {
					const { requestId } = message;
					vscode.postMessage({ command: 'surfaceRevealHandled', view, ...(typeof requestId === 'number' ? { requestId } : {}) });
				}
			});
		}
	});
	vscode.postMessage({ command: 'surfaceNavReady', view });
}
