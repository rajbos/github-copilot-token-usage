/**
 * The one place a webview bundle applies everything locale-related from its
 * initial payload.
 *
 * Every bundle used to repeat the same four lines — initialize the dictionary,
 * dig `__language__` out of it, set the current language — and only two of the
 * twelve also called `setFormatLocale()`, so the other ten formatted numbers
 * and dates with whatever locale the runtime happened to default to.
 *
 * Two fields, not one, because they answer different questions
 * (docs/adr/LOCALIZATION-ARCHITECTURE.md, S4):
 *
 *   - `language` — *which strings*. Resolved to a locale we actually ship a
 *     bundle for, so English text is never labelled `lang="fr"`.
 *   - `locale` — *how numbers and dates are written*. Comes from the user's
 *     regional settings, which are legitimately independent: a German
 *     developer running an English VS Code wants `1.234,56` and English UI.
 */
import { initializeWebviewLocalization, setCurrentLanguage } from './localization';
import { setFormatLocale } from './formatUtils';

/** The locale-related fields a host puts on a panel's initial payload. */
export interface WebviewLocaleFields {
	localization?: Record<string, string>;
	/** Display language, e.g. `en` or `zh-cn`. */
	language?: string;
	/** Regional formatting locale, e.g. `de-DE`. Undefined means "runtime default". */
	locale?: string;
}

/**
 * Apply a payload's localization dictionary, display language and formatting
 * locale in one call. Safe to call with `undefined` or a payload missing any
 * of them.
 *
 * **Each field is applied only when the payload actually carries it**, because
 * this runs on refresh payloads as well as initial ones. A webview is told its
 * locale once, by whichever payload got there first, and a later refresh that
 * simply does not mention the subject must not be read as "revert to the
 * default".
 *
 * That is the normal refresh shape for the JetBrains host: its initial HTML
 * injects the localization dictionary, but `TokenTrackerPanel.pushStatsToWebview()`
 * then dispatches stats plus settings with no `locale`, `language` or
 * `localization` at all. Resetting on absence turned every one of those
 * refreshes into "back to English, back to the runtime number format".
 *
 * Skipping a field costs nothing on a first call: `currentLanguage` already
 * starts at `'en'` and `currentLocale` already starts undefined, so an initial
 * payload that omits them lands on exactly the values the old unconditional
 * version would have written.
 */
export function applyWebviewLocale(data: WebviewLocaleFields | undefined | null): void {
	if (!data) { return; }

	if (data.localization) {
		initializeWebviewLocalization(data.localization);
	}

	// `__language__` is the older channel: the JetBrains and Visual Studio hosts
	// receive the dictionary as a prebuilt JSON sidecar and have no separate
	// field to put the language in, so it rides inside the dictionary for them.
	// A real `language` field always wins.
	const language = data.language ?? data.localization?.['__language__'];
	if (language) {
		setCurrentLanguage(language);
	}

	if (data.locale) {
		setFormatLocale(data.locale);
	}
}
