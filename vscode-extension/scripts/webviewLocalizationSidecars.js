/**
 * Builds the per-locale webview localization dictionaries (`localization.<locale>.json`)
 * that the JetBrains and Visual Studio hosts read as sidecar files.
 *
 * Kept out of esbuild.js so the build and `test/unit/localization-sidecars.test.ts`
 * run the very same code: a test of a copy would pass while the real build drifted.
 * The key list is `src/webview/shared/webviewKeys.json`, the same manifest the generated
 * English fallback (DEFAULT_LOCALIZATION) is built from, and the text comes from
 * `package.nls*.json`, so the sidecars cannot cover different keys or text than the
 * VS Code / Electron hosts send via buildWebviewLocalization().
 */
'use strict';

const path = require('path');

const root = path.join(__dirname, '..');

/** Locale ids we ship a sidecar for, mapped to the nls bundle file that supplies them. */
const SIDECAR_LOCALE_BUNDLES = {
	'en': 'package.nls.json',
	'zh-cn': 'package.nls.zh-cn.json',
};

/**
 * Fully resolved key -> text maps, one per shipped locale, plus a `__language__` marker.
 * Untranslated keys carry their English text so hosts need no fallback logic.
 *
 * @returns {Record<string, Record<string, string>>}
 */
function buildLocalizationSidecars() {
	const keys = require(path.join(root, 'src', 'webview', 'shared', 'webviewKeys.json'));
	if (keys.length < 100) {
		throw new Error(`webviewKeys.json lists only ${keys.length} keys — refusing to ship a near-empty dictionary.`);
	}
	const englishBundle = require(path.join(root, SIDECAR_LOCALE_BUNDLES.en));
	const sidecars = {};
	for (const [locale, bundleFile] of Object.entries(SIDECAR_LOCALE_BUNDLES)) {
		const bundle = require(path.join(root, bundleFile));
		const dictionary = {};
		for (const key of keys) {
			dictionary[key] = bundle[key] ?? englishBundle[key] ?? key;
		}
		dictionary['__language__'] = locale;
		sidecars[locale] = dictionary;
	}
	return sidecars;
}

module.exports = { SIDECAR_LOCALE_BUNDLES, buildLocalizationSidecars };
