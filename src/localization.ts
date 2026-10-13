/**
 * Host-neutral localization: resolves a key against a set of string bundles and fills in
 * `{0}`/`{1}` placeholders. The bundles themselves (the extension's `package.nls*.json`)
 * are handed in by each host, so this module imports no host code or data — the extension
 * binds them in `vscode-extension/src/l10nCore.ts`, the CLI in `cli/src/l10n.ts`.
 */
import type { Translate } from './types';

export type StringBundle = Record<string, string>;

export interface LocalizationBundles {
	/** The English bundle — also the final fallback for every other locale. */
	english: StringBundle;
	/** Locale id (lowercase, from the package.nls.<locale>.json filename) → bundle. */
	locales: Record<string, StringBundle>;
}

export interface Localization {
	/** The id of the bundle that serves `language`, or undefined when none does. */
	resolveLocaleId(language: string): string | undefined;
	/**
	 * The locale strings are actually rendered in: a locale id or `en`, so it is safe to
	 * interpolate (e.g. into `<html lang>`).
	 */
	resolvedLocale(language: string): string;
	resolveLocaleBundle(language: string): StringBundle | undefined;
	/** `key` in `language`, falling back to English and finally to the key itself. */
	translate(language: string, key: string, ...args: Array<string | number | boolean>): string;
	/** A {@link Translate} bound to one language — what pure modules are injected with. */
	createTranslator(language: string): Translate;
}

/** Replace {0}, {1}, ... placeholders, mirroring vscode.l10n.t() formatting. */
export function formatMessage(template: string, args: Array<string | number | boolean>): string {
	return template.replace(/\{(\d+)\}/g, (match, index) => {
		const i = Number(index);
		return i < args.length ? String(args[i]) : match;
	});
}

/**
 * `zh-Hans` for any Simplified Chinese tag, `en-Latn` for any English one, and
 * so on — or undefined for a tag Intl cannot parse.
 *
 * `Intl.Locale` throws on a malformed tag, which is also what keeps a hostile
 * value like `constructor` from reaching the comparison in resolveLocaleId.
 */
function languageAndScript(tag: string): string | undefined {
	try {
		const maximized = new Intl.Locale(tag).maximize();
		return `${maximized.language}-${maximized.script}`;
	} catch {
		return undefined;
	}
}

export function createLocalization({ english, locales }: LocalizationBundles): Localization {
	const missingKeyWarnings = new Set<string>();

	function resolveLocaleId(language: string): string | undefined {
		const lang = (language || '').toLowerCase();
		// Own-property check, not a bare lookup: `locales` is a plain object, so a lowercase
		// prototype key ('constructor', '__proto__') reads back truthy and would be reported as a
		// shipped locale — which for `<html lang>` means emitting lang="constructor".
		if (Object.prototype.hasOwnProperty.call(locales, lang)) {
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
		for (const locale of Object.keys(locales)) {
			if (languageAndScript(locale) === wanted) {
				return locale;
			}
		}
		return undefined;
	}

	function resolveLocaleBundle(language: string): StringBundle | undefined {
		const id = resolveLocaleId(language);
		return id === undefined ? undefined : locales[id];
	}

	function translate(language: string, key: string, ...args: Array<string | number | boolean>): string {
		const template = resolveLocaleBundle(language)?.[key] ?? english[key];
		if (template === undefined) {
			if (!missingKeyWarnings.has(key)) {
				missingKeyWarnings.add(key);
				console.warn(`[ai-engineering-fluency] No localization found for key "${key}" — add it to package.nls.json.`);
			}
			return key;
		}
		return formatMessage(template, args);
	}

	return {
		resolveLocaleId,
		resolvedLocale: (language) => resolveLocaleId(language) ?? 'en',
		resolveLocaleBundle,
		translate,
		createTranslator: (language) => (key, ...args) => translate(language, key, ...args),
	};
}
