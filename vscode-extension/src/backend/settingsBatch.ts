/**
 * Coordinates multi-key backend settings writes with the settings-change listener.
 *
 * Every `aiEngineeringFluency.backend.*` write fires a configuration change, and the extension
 * reacts to each one with an immediate forced sync. A save that writes several keys one after
 * another (profile, endpoint, enable flags, …) would therefore sync against each half-applied
 * intermediate state — e.g. uploading under the old sharing profile, or to a new endpoint before
 * the new profile lands. Wrapping those writes in {@link applySettingsAtomically} holds the
 * listener's reaction back until the last write finishes, then runs it once. Change events that
 * VS Code delivers after the batch has ended already observe the final settings, because the sync
 * reads its settings when it runs rather than from the event.
 */

let depth = 0;
let deferred: (() => void) | undefined;

/** Runs `write` with settings-change reactions deferred until it (and any nested batch) finishes. */
export async function applySettingsAtomically<T>(write: () => Promise<T>): Promise<T> {
	depth++;
	try {
		return await write();
	} finally {
		depth--;
		if (depth === 0 && deferred) {
			const run = deferred;
			deferred = undefined;
			run();
		}
	}
}

/**
 * Called by the settings-change listener. Returns `true` and remembers `react` (replacing any
 * earlier deferred reaction — only the final state matters) while a batch is in progress, so the
 * caller must not run it now; returns `false` when no batch is active.
 */
export function deferWhileApplyingSettings(react: () => void): boolean {
	if (depth === 0) { return false; }
	deferred = react;
	return true;
}
