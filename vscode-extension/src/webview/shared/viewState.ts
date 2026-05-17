/**
 * Shared webview state persistence utility.
 *
 * VS Code webview panels created with `retainContextWhenHidden: false` (the default)
 * destroy their JavaScript context when the tab is hidden and recreate it when shown
 * again. `vscode.setState()` / `vscode.getState()` survive this cycle and also persist
 * across VS Code restarts, making them the correct mechanism for preserving user UI
 * selections (active tab, sort order, selected view, etc.).
 *
 * Use `createViewStateManager` in every webview that has user-selectable state.
 * See `.github/instructions/vscode-extension.instructions.md` for the full pattern.
 */

/** Minimal subset of the VS Code webview API needed for state persistence. */
export interface WebviewStateApi<T> {
	setState: (newState: T) => void;
	getState: () => T | undefined;
}

/**
 * Creates a typed state manager for a VS Code webview panel.
 *
 * @param vscode - The result of `acquireVsCodeApi()` (or any compatible object).
 * @param defaults - Default state values used when nothing has been saved yet,
 *                   and to fill in any keys missing from an older saved state.
 *
 * @example
 * ```ts
 * const state = createViewStateManager(vscode, { tab: 'report' as string, sort: 'asc' as 'asc' | 'desc' });
 *
 * // In bootstrap / init — always safe, even on first run:
 * const { tab, sort } = state.restore();
 *
 * // When the user changes a tab:
 * state.patch({ tab: newTab });
 *
 * // When saving the whole state at once:
 * state.save({ tab: currentTab, sort: currentSort });
 * ```
 */
export function createViewStateManager<T extends Record<string, unknown>>(
	vscode: WebviewStateApi<T>,
	defaults: T
): {
	/**
	 * Returns saved state merged with defaults. Safe to call even when nothing
	 * has been persisted yet, or when the saved state predates newly added fields.
	 */
	restore(): T;
	/** Replaces the entire persisted state object. */
	save(state: T): void;
	/**
	 * Merges a partial update into the current saved state and persists the result.
	 * Returns the new full state. Use this for incremental field updates so that
	 * unrelated saved fields are not lost.
	 */
	patch(partial: Partial<T>): T;
} {
	return {
		restore(): T {
			const saved = vscode.getState();
			// Merge with defaults so that any newly added fields get their default value
			// even when an older saved state doesn't include them yet.
			return { ...defaults, ...(saved ?? {}) };
		},
		save(state: T): void {
			vscode.setState(state);
		},
		patch(partial: Partial<T>): T {
			const current = vscode.getState() ?? { ...defaults };
			const next = { ...defaults, ...current, ...partial } as T;
			vscode.setState(next);
			return next;
		},
	};
}
