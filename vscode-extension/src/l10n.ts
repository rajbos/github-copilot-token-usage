/**
 * Key-based localization for the extension's runtime strings.
 *
 * Why not call `vscode.l10n.t()` directly? That API only resolves through
 * `l10n/bundle.l10n.<lang>.json` files (enabled via the `l10n` field in
 * package.json). This extension keeps its strings in `package.nls.json`,
 * which VS Code only consults for static `%key%` references in
 * package.json — never for the runtime API. On an English (default
 * language) VS Code, `l10n.t(key)` returns the message argument unchanged,
 * so key-based calls like `l10n.t('statusBar.loadingText')` surface the raw
 * key in the UI.
 *
 * This module makes the existing `package.nls*.json` files the single source
 * of truth for runtime strings too: esbuild inlines them into the bundle and
 * `t()` resolves keys from the bundle matching `vscode.env.language`,
 * falling back to English and finally to the key itself.
 *
 * `vscode.l10n.t()` is still consulted first, so if proper l10n bundles are
 * ever shipped, real VS Code-provided translations take precedence.
 *
 * The bundle lookup itself lives in `l10nCore.ts`, which imports no `vscode`
 * — this file adds only the two things that genuinely need the API: the
 * `vscode.l10n.t()` precedence check and `vscode.env.language`. Modules that
 * must stay VS Code-free (see `insightsEngine.ts`) take a `Translate` from
 * there instead of importing this file.
 */
import * as vscode from 'vscode';
import { translate } from './l10nCore';

export type { Translate } from './l10nCore';

/**
 * Re-exported from `l10nCore` so existing callers keep working. It lives there
 * because the desktop, JetBrains and Visual Studio hosts need it to declare
 * `<html lang>` and cannot import `vscode`.
 */
export { resolvedLocale } from './l10nCore';

/**
 * Look up a localized string by its package.nls.json key. Resolution order:
 * VS Code's own l10n bundle (if one is ever provided), the inlined bundle for
 * the current VS Code display language, the inlined English bundle, and
 * finally the key itself for genuinely unknown keys (logged once per key).
 */
export function t(key: string, ...args: Array<string | number | boolean>): string {
	const value = args.length > 0 ? vscode.l10n.t(key, ...args) : vscode.l10n.t(key);
	if (value !== key) {
		return value;
	}
	return translate(vscode.env.language, key, ...args);
}
