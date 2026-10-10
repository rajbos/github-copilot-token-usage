/**
 * Bundle resolution for the extension's runtime strings — the vscode-free half
 * of the localization stack.
 *
 * Why this is a separate module from `l10n.ts`: the only thing `t()` needs the
 * VS Code API for is *which language to render in* (`vscode.env.language`) and
 * the `vscode.l10n.t()` precedence check. Looking a key up in the inlined
 * `package.nls*.json` bundles and substituting `{0}`/`{1}` placeholders needs
 * neither. Splitting them lets modules that are deliberately pure — no `vscode`
 * import, so they stay unit-testable with plain mocked data — still resolve
 * real localized strings by being handed a translator, rather than being forced
 * to either import `vscode` or ship hardcoded English.
 *
 * `insightsEngine.ts` is the motivating case (see issue #2081): its 50+ insight
 * definitions are user-facing prose, but the module's own header comment
 * commits it to staying VS Code-free. It receives `InsightContext.translate`,
 * which `extension.ts` fills with the real `t()` and tests fill with
 * `createTranslator('en')` / `createTranslator('zh-cn')` from this module — so
 * unit tests assert against the real shipped bundles rather than a stub.
 *
 * This module is the single source of truth for bundle lookup; `l10n.ts` is a
 * thin VS Code-aware wrapper over it and must not duplicate the logic here.
 */
import englishBundleData from '../package.nls.json';
import zhCnBundleData from '../package.nls.zh-cn.json';

/** The English bundle — also the final fallback for every other locale. */
export const ENGLISH_BUNDLE = englishBundleData as Record<string, string>;

/** Locale id (lowercase, from the package.nls.<locale>.json filename) → bundle. */
const LOCALE_BUNDLES: Record<string, Record<string, string>> = {
	'zh-cn': zhCnBundleData as Record<string, string>
};

const missingKeyWarnings = new Set<string>();

/** A key-based translation function: the shape pure modules are handed. */
export type Translate = (key: string, ...args: Array<string | number | boolean>) => string;

/** Replace {0}, {1}, ... placeholders, mirroring vscode.l10n.t() formatting. */
export function formatMessage(template: string, args: Array<string | number | boolean>): string {
	return template.replace(/\{(\d+)\}/g, (match, index) => {
		const i = Number(index);
		return i < args.length ? String(args[i]) : match;
	});
}

/** The id of the inlined bundle that serves `language`, or undefined when none does. */
export function resolveLocaleId(language: string): string | undefined {
	const lang = (language || '').toLowerCase();
	// Own-property check, not a bare lookup: LOCALE_BUNDLES is a plain object, so a lowercase
	// prototype key ('constructor', '__proto__') reads back truthy and would be reported as a
	// shipped locale — which for `<html lang>` means emitting lang="constructor".
	if (Object.prototype.hasOwnProperty.call(LOCALE_BUNDLES, lang)) {
		return lang;
	}
	// Otherwise match on language + script, after asking Intl to fill in what the
	// tag left implicit. Comparing raw tags is not enough: `zh-Hans`, `zh-Hans-CN`
	// and a bare `zh` are all Simplified Chinese and should get `zh-cn`, but none
	// of them is a prefix match for it.
	//
	// Script, not region, is the deciding part. `zh-SG` is Simplified Chinese in
	// Singapore — closer to our `zh-cn` bundle than English is — while `zh-TW`
	// and `zh-HK` are Traditional and must never get it, which comparing full
	// maximized tags would get right by luck and comparing languages would get
	// wrong.
	const wanted = languageAndScript(lang);
	if (wanted === undefined) {
		return undefined;
	}
	for (const locale of Object.keys(LOCALE_BUNDLES)) {
		if (languageAndScript(locale) === wanted) {
			return locale;
		}
	}
	return undefined;
}

/**
 * `zh-Hans` for any Simplified Chinese tag, `en-Latn` for any English one, and
 * so on — or undefined for a tag Intl cannot parse.
 *
 * `Intl.Locale` throws on a malformed tag, which is also what keeps a hostile
 * value like `constructor` from reaching the comparison above.
 */
function languageAndScript(tag: string): string | undefined {
	try {
		const maximized = new Intl.Locale(tag).maximize();
		return `${maximized.language}-${maximized.script}`;
	} catch {
		return undefined;
	}
}

/**
 * The locale the runtime strings are actually rendered in.
 *
 * Not the same question as "what is the host's display language": resolution
 * falls back to the English bundle for every language this extension has no
 * `package.nls.<locale>.json` for, so on a French or Brazilian-Portuguese
 * install the strings on screen are English. Anything that has to *declare* the
 * language of rendered text — a webview's `<html lang>` above all — must ask
 * this rather than the raw display language, or it labels English text as
 * French and sends assistive technology down the wrong pronunciation rules,
 * which is the very mismatch declaring the language is meant to fix.
 *
 * Lives here rather than in `l10n.ts` so the desktop, JetBrains and Visual
 * Studio hosts — which cannot import `vscode` — can declare `<html lang>`
 * correctly too. `l10n.ts` re-exports it for existing callers.
 *
 * The result is always either an id from LOCALE_BUNDLES or `en`, so it is safe
 * to interpolate.
 */
export function resolvedLocale(language: string): string {
	return resolveLocaleId(language) ?? 'en';
}

export function resolveLocaleBundle(language: string): Record<string, string> | undefined {
	const id = resolveLocaleId(language);
	return id === undefined ? undefined : LOCALE_BUNDLES[id];
}

/**
 * Resolve `key` against the bundle serving `language`, falling back to English
 * and finally to the key itself for genuinely unknown keys (logged once per key).
 *
 * This is the whole of the lookup; `l10n.ts`'s `t()` adds only the VS Code
 * `l10n.t()` precedence check and the `vscode.env.language` argument.
 */
export function translate(language: string, key: string, ...args: Array<string | number | boolean>): string {
	const template = resolveLocaleBundle(language)?.[key] ?? ENGLISH_BUNDLE[key];
	if (template === undefined) {
		if (!missingKeyWarnings.has(key)) {
			missingKeyWarnings.add(key);
			console.warn(`[ai-engineering-fluency] No localization found for key "${key}" — add it to package.nls.json.`);
		}
		return key;
	}
	return formatMessage(template, args);
}

/**
 * A {@link Translate} bound to one language — what pure modules are injected with.
 *
 * Note this skips the `vscode.l10n.t()` precedence check that `t()` performs,
 * because consulting it requires the VS Code API. That check only ever matters
 * if real `l10n/bundle.l10n.<lang>.json` files are shipped one day (none are
 * today); until then `t()` and a translator bound to `vscode.env.language`
 * resolve identically. `extension.ts` injects the real `t()` rather than a
 * translator from here, so production keeps the full resolution order and only
 * tests use this.
 */
export function createTranslator(language: string): Translate {
	return (key, ...args) => translate(language, key, ...args);
}
