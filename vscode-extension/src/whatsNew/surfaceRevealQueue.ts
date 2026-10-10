/**
 * Host-side bookkeeping for "take me there" requests (View index, What's New):
 * which request is waiting for which panel, and when it may be delivered.
 *
 * Pure — generic over the panel type, with an injectable clock — so the
 * timing-sensitive handshake can be unit tested without VS Code. The host
 * (`openViewSurface` in extension.ts) drives it:
 *
 *   1. `request()` before calling a view's opener: a panel the opener creates
 *      may report ready before the opener resolves.
 *   2. `opened()` once the opener resolved, with the panel it left behind.
 *      Returns the navigation to post now when the panel was reused (no ready
 *      handshake will follow), else null.
 *   3. `ready()` when a panel's webview reports `surfaceNavReady`. Returns
 *      the navigation to post, or null.
 *   4. `handled()` when the webview reports `surfaceRevealHandled` — the
 *      reveal landed, nothing is left to replay.
 *
 * A request only ever reaches the panel it was meant for: once `opened()`
 * names that panel, a ready from any other panel (say, one the user reopened
 * by hand) drops it. Before that, a newly created panel qualifies, and a ready
 * from the panel that was already open is held for `opened()` to settle. And a request expires after `ttlMs`, so it can never redirect a
 * panel the user later opens on their own.
 */
type Pending<TNav, TPanel> = {
	/** Unique per request; echoed back in the acknowledgement so a stale one cannot clear a newer request. */
	id: number;
	nav: TNav;
	requestedAt: number;
	/** The panel the request is for, once the opener has returned it. */
	panel?: TPanel;
	/** The panel that was open before, if any; while `panel` is unset, a ready from it does not count. */
	replacedPanel?: TPanel;
};

export class SurfaceRevealQueue<TKey extends string, TNav, TPanel> {
	private readonly pending = new Map<TKey, Pending<TNav, TPanel>>();
	private nextId = 1;

	constructor(
		private readonly ttlMs: number,
		private readonly now: () => number = Date.now,
	) {}

	/**
	 * Holds `nav` for `view`, replacing any older request. `existingPanel` is the
	 * panel open right now, if any. Returns the request's id.
	 */
	request(view: TKey, nav: TNav, existingPanel: TPanel | undefined): number {
		const id = this.nextId++;
		this.pending.set(view, { id, nav, requestedAt: this.now(), replacedPanel: existingPanel });
		return id;
	}

	/** Id of the request currently held for `view`; post it alongside the navigation. */
	currentId(view: TKey): number | undefined {
		return this.pending.get(view)?.id;
	}

	/** Forgets any request for `view` — e.g. the view is being opened with no target. */
	clear(view: TKey): void {
		this.pending.delete(view);
	}

	/**
	 * Binds the request for `view` to `panel` as soon as the opener has created
	 * it — before the opener's own await on data resolves — so a panel the user
	 * closes and reopens by hand in that window can never claim the request.
	 * Ignored once the request is already bound.
	 */
	bind(view: TKey, panel: TPanel): void {
		const entry = this.pending.get(view);
		if (entry && entry.panel === undefined && panel !== entry.replacedPanel) {
			entry.panel = panel;
		}
	}

	/**
	 * The opener for `view` resolved and left `panel` open (or none). Returns
	 * the navigation to post now when the panel was reused — no ready handshake
	 * may follow — else null. It returns the request *currently* held, so an
	 * opener that resolves after a newer request replaced its own delivers the
	 * newer one, never a stale one. The request stays held until the webview
	 * acknowledges it.
	 */
	opened(view: TKey, panel: TPanel | undefined): TNav | null {
		const entry = this.pending.get(view);
		if (!entry) { return null; } // already delivered through ready() and handled
		if (this.isExpired(entry)) {
			this.pending.delete(view);
			return null;
		}
		if (!panel || (entry.panel !== undefined && panel !== entry.panel)) {
			// No panel, or not the one the request was bound to (the user closed it
			// and opened another by hand): drop the request rather than redirect.
			this.pending.delete(view);
			return null;
		}
		const reused = entry.panel === undefined && panel === entry.replacedPanel;
		entry.panel = panel;
		return reused ? entry.nav : null;
	}

	/** A panel for `view` reported ready. Returns the navigation to post to it, or null. */
	ready(view: TKey, panel: TPanel): TNav | null {
		const entry = this.pending.get(view);
		if (!entry) { return null; }
		if (this.isExpired(entry)) {
			this.pending.delete(view);
			return null;
		}
		if (entry.panel === undefined && panel === entry.replacedPanel) {
			// The opener has not returned yet, so it is not known whether it will
			// reuse this panel or replace it. Hold the request: `opened()` decides.
			return null;
		}
		if (entry.panel !== undefined && panel !== entry.panel) {
			// Some other panel than the one the request was for — e.g. the user
			// closed it and reopened the view by hand. Never redirect that one.
			this.pending.delete(view);
			return null;
		}
		return entry.nav;
	}

	/**
	 * The webview for `view` reports the reveal with `requestId` landed. An
	 * acknowledgement for an older request — one a newer request has since
	 * replaced — leaves the newer request alone.
	 */
	handled(view: TKey, requestId?: number): void {
		const entry = this.pending.get(view);
		if (entry && (requestId === undefined || requestId === entry.id)) {
			this.pending.delete(view);
		}
	}

	private isExpired(entry: Pending<TNav, TPanel>): boolean {
		return this.now() - entry.requestedAt > this.ttlMs;
	}

	/** The navigation still held for `view`, if any. For tests and diagnostics. */
	peek(view: TKey): TNav | undefined {
		return this.pending.get(view)?.nav;
	}
}
