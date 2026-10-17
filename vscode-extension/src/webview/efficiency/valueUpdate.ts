import type { ValueSignals } from '../../../../src/efficiencyAnalysis';

/**
 * Host → webview Value update for the Efficiency panel.
 *
 * The Value tab's PR metrics come from the Repository PRs snapshot, which is loaded from the
 * *Usage Analysis* panel — so it routinely lands after the Efficiency panel has already
 * rendered. With `retainContextWhenHidden` the retained document is never re-created, so
 * without this message the Value tab keeps its "open Usage Analysis → Repository PRs" hint
 * until the user presses Refresh.
 */
export interface EfficiencyValueSignalsMessage {
	command: 'valueSignalsUpdated';
	value: ValueSignals;
}

/** Webview → host readiness announcement, mirroring `usageWebviewReady`. */
export interface EfficiencyWebviewReadyMessage {
	command: 'efficiencyWebviewReady';
	/** Why readiness was announced — surfaced in the extension Output channel for diagnosis. */
	reason: EfficiencyWebviewReadyReason;
}

export type EfficiencyWebviewReadyReason = 'listener-registered' | 'content-rendered';

/**
 * Creates the readiness notifier for the extension-host replay channel.
 *
 * Announced twice on purpose, for the same reason the Usage Analysis panel does it:
 *  - `listener-registered` fires at module evaluation, the earliest point the document can
 *    receive anything, so a Value update already sitting in the replay buffer arrives at once.
 *  - `content-rendered` fires once the first render has put `#eff-tab-content` in the DOM, so a
 *    replay triggered by the first announcement — which necessarily happens before `bootstrap()`
 *    has rendered anything — cannot be the only chance to update the fragment.
 */
export function createEfficiencyWebviewReadyNotifier(
	postMessage: (message: EfficiencyWebviewReadyMessage) => void,
): (reason: EfficiencyWebviewReadyReason) => void {
	return (reason) => { postMessage({ command: 'efficiencyWebviewReady', reason }); };
}

function isNullableNumber(value: unknown): boolean {
	return value === null || (typeof value === 'number' && Number.isFinite(value));
}

/**
 * Validates a `valueSignalsUpdated` payload before it is allowed to replace rendered metrics.
 *
 * The `postMessage` wire is untyped, so a shape check here is the only thing standing between a
 * malformed payload and a Value tab full of `undefined`s.
 */
export function isValueSignalsPayload(value: unknown): value is ValueSignals {
	if (!value || typeof value !== 'object') { return false; }
	const v = value as Record<string, unknown>;
	const nullableNumbers = ['userPrs', 'mergedPrs', 'aiPrs', 'prsPerWeek', 'costPerMergedPr', 'applyRate', 'locPerDollar'];
	if (!nullableNumbers.every((key) => isNullableNumber(v[key]))) { return false; }
	const numbers = ['appliedBlocks', 'totalBlocks', 'linesChanged', 'periodCost'];
	if (!numbers.every((key) => typeof v[key] === 'number' && Number.isFinite(v[key] as number))) { return false; }
	// `prsSince` has to be a *parseable* date, not merely a string: the Value tab renders it
	// through `new Date(...)`, so an unparseable one would show up as "Invalid Date".
	if (v.prsSince === null) { return true; }
	return typeof v.prsSince === 'string' && Number.isFinite(Date.parse(v.prsSince));
}
