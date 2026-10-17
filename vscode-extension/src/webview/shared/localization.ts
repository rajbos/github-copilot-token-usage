/**
 * Webview localization support.
 *
 * Webview bundles cannot import `vscode`, so they receive their strings as a
 * flat dictionary in the panel's initial payload and resolve them here. Every
 * host that ships these bundles has to supply that dictionary — see
 * `buildWebviewLocalization()` and docs/adr/LOCALIZATION-ARCHITECTURE.md.
 */
import defaultLocalizationData from './webviewStrings.generated.json';

/**
 * Built-in English fallback, used when the host sent no dictionary.
 *
 * Generated from `package.nls.json` by `scripts/generate-webview-strings.mjs`
 * — do not hand-edit. This used to be a second hand-written copy of the same
 * English text with nothing comparing the two, so they agreed only by luck
 * (S1). Which keys belong here is the one editorial decision left, and lives
 * in `webviewKeys.json`.
 */
const DEFAULT_LOCALIZATION: Record<string, string> = defaultLocalizationData;

/**
 * The keys the webviews ship a fallback for, as a real literal union.
 *
 * Inferred from the generated JSON, so unlike the interface this replaced it
 * cannot drift: that one declared 147 properties above an
 * `[key: string]: string` index signature which silently neutralized all of
 * them, letting any misspelled key type-check and then render raw at runtime.
 */
export type WebviewKey = keyof typeof defaultLocalizationData;

/**
 * A dictionary of webview strings.
 *
 * Deliberately not keyed by {@link WebviewKey}: the payload a host sends also
 * carries `__language__`, and a bundle may look up a key built at runtime. The
 * strict set is available as `WebviewKey` for callers that want it.
 */
export type WebviewLocalization = Record<string, string>;

let currentLocalization: WebviewLocalization = { ...DEFAULT_LOCALIZATION };

/**
 * Initialize webview localization with strings from the extension.
 * This should be called when the webview receives its initial state/data.
 * Entries whose value equals their key are raw localization keys passed
 * through unresolved (bundle load failure on the extension side) — ignore
 * them so the built-in defaults are used instead of showing raw keys.
 */
export function initializeWebviewLocalization(localization: Partial<WebviewLocalization>): void {
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(localization)) {
		if (typeof value === 'string' && value !== key) {
			resolved[key] = value;
		}
	}
	currentLocalization = { ...DEFAULT_LOCALIZATION, ...resolved } as WebviewLocalization;
}

/**
 * The keys this module ships a built-in English fallback for.
 *
 * Reads them off the generated object rather than repeating the list, and is
 * what `buildWebviewLocalization()` iterates — so the set a host *sends* and
 * the set a bundle *falls back to* are the same list by construction.
 */
export function webviewLocalizationKeys(): string[] {
	return Object.keys(DEFAULT_LOCALIZATION);
}

/**
 * Get a localized string for the webview.
 * Falls back to the default English string if not found.
 */
export function localize(key: string): string {
	return currentLocalization[key] || DEFAULT_LOCALIZATION[key] || key;
}

/**
 * Localize a string that carries `{0}`, `{1}`, … placeholders, mirroring the
 * formatting `vscode.l10n.t()` and the extension-side `l10n.t()` helper use.
 * Placeholders with no matching argument are left intact rather than replaced
 * with `undefined`, so a short-changed call degrades visibly instead of lying.
 */
export function localizeFormat(key: string, ...args: Array<string | number>): string {
	return localize(key).replace(/\{(\d+)\}/g, (match, index) => {
		const i = Number(index);
		return i < args.length ? String(args[i]) : match;
	});
}

/**
 * Get the current language identifier (e.g., 'en', 'zh-cn')
 * This is set when the webview receives its initial state.
 */
let currentLanguage: string = 'en';

export function setCurrentLanguage(language: string): void {
	currentLanguage = language;
}

export function getCurrentLanguage(): string {
	return currentLanguage;
}

/**
 * Check if the current language is right-to-left (RTL)
 */
export function isRTL(): boolean {
	const rtlLanguages = ['ar', 'he', 'fa', 'ur', 'ps', 'dv', 'yi'];
	return rtlLanguages.some(lang => currentLanguage.startsWith(lang));
}