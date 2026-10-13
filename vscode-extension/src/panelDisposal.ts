/** Anything with a `dispose()` — a `vscode.WebviewPanel`, or a test fake. */
export interface DisposablePanel {
	dispose(): void;
}

/**
 * Disposes every defined panel. One panel throwing never prevents the rest from being released;
 * the first error is rethrown afterwards so it is not swallowed.
 */
export function disposePanels(panels: ReadonlyArray<DisposablePanel | undefined>): void {
	let firstError: unknown;
	let failed = false;
	for (const panel of panels) {
		try {
			panel?.dispose();
		} catch (error) {
			if (!failed) { firstError = error; failed = true; }
		}
	}
	if (failed) { throw firstError; }
}
