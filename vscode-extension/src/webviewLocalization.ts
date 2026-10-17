/**
 * Builds the localization dictionary a webview panel receives in its initial
 * payload.
 *
 * Why this is its own module rather than a method on the extension: **four**
 * products ship the same webview bundles — the VS Code extension, the desktop
 * Electron app, the JetBrains plugin and the Visual Studio extension — and each
 * one has to put this dictionary in the payload itself. Before this existed,
 * only the VS Code extension did (12 injection sites); the other three supplied
 * it zero times.
 *
 * That failed silently rather than loudly. Every bundle guards with
 * `if (initialData?.localization)`, so a host that omits it does not crash — it
 * skips initialization and renders `DEFAULT_LOCALIZATION` English forever. The
 * fallback table is compiled into each `dist/webview/*.js`, and those are the
 * artifacts the IDE hosts redistribute, so it was the only string table three
 * of our four products ever consulted. Roughly eleven views had complete
 * Simplified Chinese that nobody outside VS Code could see.
 *
 * Keeping the construction here means a host cannot forget it and no host
 * maintains its own copy of the key list — a mirror would drift exactly like
 * the agents/skills mirror AGENTS.md already warns about.
 *
 * See docs/adr/LOCALIZATION-ARCHITECTURE.md (S2).
 */
import type { Translate } from './l10nCore';
import { webviewLocalizationKeys } from './webview/shared/localization';

/**
 * Resolve every webview-facing key through `translate`.
 *
 * The key list is `DEFAULT_LOCALIZATION`'s own keys rather than a separate
 * manifest, so the set a host *sends* and the set the webview *falls back to*
 * cannot drift apart — they are the same list by construction. This replaced a
 * hand-written literal of 147 `'key': t('key')` lines spread over seven methods
 * (six of which existed only to keep the seventh under `max-lines-per-function`).
 * `test/unit/webview-localization.test.ts` pins the values against
 * `package.nls.json` in both directions.
 *
 * Values are returned unformatted: templates carrying `{0}`/`{1}` are resolved
 * webview-side by `localizeFormat()` with the live arguments, which the host
 * does not have.
 */
export function buildWebviewLocalization(translate: Translate): Record<string, string> {
	const dictionary: Record<string, string> = {};
	for (const key of webviewLocalizationKeys()) {
		dictionary[key] = translate(key);
	}
	return dictionary;
}
