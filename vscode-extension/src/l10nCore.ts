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
 * `src/insightsEngine.ts` is the motivating case (see issue #2081): its 50+ insight
 * definitions are user-facing prose, but the module's own header comment
 * commits it to staying VS Code-free. It receives `InsightContext.translate`,
 * which `extension.ts` fills with the real `t()` and tests fill with
 * `createTranslator('en')` / `createTranslator('zh-cn')` from this module — so
 * unit tests assert against the real shipped bundles rather than a stub.
 *
 * The lookup itself is host-neutral and lives in `src/localization.ts`; this module
 * binds it to the extension's inlined bundles (the CLI binds the same bundles in
 * `cli/src/l10n.ts`). `l10n.ts` is a thin VS Code-aware wrapper over it and must
 * not duplicate the logic here.
 */
import englishBundleData from '../package.nls.json';
import zhCnBundleData from '../package.nls.zh-cn.json';
import type { Translate } from '../../src/types';
import { createLocalization } from '../../src/localization';

/** The English bundle — also the final fallback for every other locale. */
export const ENGLISH_BUNDLE = englishBundleData as Record<string, string>;

const localization = createLocalization({
	english: ENGLISH_BUNDLE,
	// Locale id (lowercase, from the package.nls.<locale>.json filename) → bundle.
	locales: { 'zh-cn': zhCnBundleData as Record<string, string> },
});

/** A key-based translation function: the shape pure modules are handed. Declared in src/types.ts. */
export type { Translate };

/** Replace {0}, {1}, ... placeholders, mirroring vscode.l10n.t() formatting. */
export { formatMessage } from '../../src/localization';

/** The id of the inlined bundle that serves `language`, or undefined when none does. */
export const resolveLocaleId = localization.resolveLocaleId;

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
 * The result is always either a shipped locale id or `en`, so it is safe
 * to interpolate.
 */
export const resolvedLocale = localization.resolvedLocale;

export const resolveLocaleBundle = localization.resolveLocaleBundle;

/**
 * Resolve `key` against the bundle serving `language`, falling back to English
 * and finally to the key itself for genuinely unknown keys (logged once per key).
 *
 * This is the whole of the lookup; `l10n.ts`'s `t()` adds only the VS Code
 * `l10n.t()` precedence check and the `vscode.env.language` argument.
 */
export const translate = localization.translate;

/**
 * A {@link Translate} bound to one language — what pure modules are injected with.
 *
 * Note this skips the `vscode.l10n.t()` precedence check that `t()` performs,
 * because consulting it requires the VS Code API. That check only ever matters
 * if real `l10n/bundle.l10n.<lang>.json` files are shipped one day (none are
 * today); until then `t()` and a translator bound to `vscode.env.language`
 * resolve identically. `extension.ts` injects the real `t()` rather than a
 * translator from here, so it keeps the full resolution order; tests and the
 * extension-side callers use this (the CLI and desktop app use the binding in `cli/src/l10n.ts`).
 */
export const createTranslator = localization.createTranslator;
