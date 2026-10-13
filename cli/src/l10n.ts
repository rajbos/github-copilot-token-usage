/**
 * The CLI's (and desktop app's) localization: the shared, host-neutral lookup in src/localization.ts bound to
 * the product's string bundles. Those ship as the VS Code extension's `package.nls*.json`
 * (VS Code requires them there), so they are read as data from that folder; no extension
 * code is imported.
 */
import englishBundleData from '../../vscode-extension/package.nls.json';
import zhCnBundleData from '../../vscode-extension/package.nls.zh-cn.json';
import { createLocalization } from '../../src/localization';

/** Locale id (lowercase, from the package.nls.<locale>.json filename) → bundle. */
export const CLI_LOCALE_BUNDLES: Record<string, Record<string, string>> = {
	'zh-cn': zhCnBundleData as Record<string, string>,
};

const localization = createLocalization({
	english: englishBundleData as Record<string, string>,
	locales: CLI_LOCALE_BUNDLES,
});

export const createTranslator = localization.createTranslator;
export const resolvedLocale = localization.resolvedLocale;
