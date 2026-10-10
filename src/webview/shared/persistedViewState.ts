/**
 * Storage-backed `getState` / `setState` for hosts that are not VS Code.
 *
 * VS Code persists `acquireVsCodeApi().setState()` itself (across hide/show and restarts). Hosts
 * that shim `acquireVsCodeApi` — the Electron desktop app — must provide the same guarantee, or
 * every UI choice stored through `createViewStateManager` (e.g. the Chart view's collapsed
 * "By Editor" section) silently resets whenever a panel is re-opened.
 */

/** The slice of `Storage` this helper needs. */
export interface StateStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

/**
 * Returns state accessors backed by `storage` under `key`. Storage that is missing, full or
 * holds corrupt JSON degrades to "no saved state" instead of throwing into the webview.
 */
export function createPersistedViewState<T>(storage: StateStorage | undefined, key: string): {
	getState: () => T | undefined;
	setState: (state: T) => void;
} {
	return {
		getState(): T | undefined {
			try {
				const raw = storage?.getItem(key);
				return raw ? (JSON.parse(raw) as T) : undefined;
			} catch {
				return undefined;
			}
		},
		setState(state: T): void {
			try {
				storage?.setItem(key, JSON.stringify(state));
			} catch {
				// Quota exceeded or storage disabled: UI state is a convenience, never fatal.
			}
		},
	};
}
