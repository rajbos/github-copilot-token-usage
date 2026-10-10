import test from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTranslator } from '../../src/l10nCore';
import { buildWebviewLocalization } from '../../src/webviewLocalization';
import { webviewLocalizationKeys } from '../../src/webview/shared/localization';

// The JetBrains (Kotlin) and Visual Studio (C#) hosts cannot run our TypeScript, so
// they read `localization.<locale>.json` sidecars that esbuild generates and put
// the content in the panel payload. These tests pin that those sidecars come from
// the same sources as what the VS Code / Electron hosts send through
// buildWebviewLocalization(), and that the hosts consume exactly the locales we
// generate. Drift between them used to be invisible: a host with a stale or missing
// dictionary just renders English. See docs/adr/LOCALIZATION-ARCHITECTURE.md.

// Tests run compiled out of `out/`, so __dirname is not next to the source.
const extensionRoot = join(__dirname, '../../../../');
const repoRoot = join(extensionRoot, '..');

// eslint-disable-next-line @typescript-eslint/no-require-imports
const sidecarModule = require(join(extensionRoot, 'scripts', 'webviewLocalizationSidecars.js')) as {
	SIDECAR_LOCALE_BUNDLES: Record<string, string>;
	buildLocalizationSidecars: () => Record<string, Record<string, string>>;
};

const sidecars = sidecarModule.buildLocalizationSidecars();
const shippedLocales = Object.keys(sidecarModule.SIDECAR_LOCALE_BUNDLES).sort();

function dictionaryKeys(dictionary: Record<string, string>): string[] {
	return Object.keys(dictionary).filter(k => k !== '__language__').sort();
}

test('sidecars: a dictionary is generated for every shipped locale', () => {
	assert.deepEqual(Object.keys(sidecars).sort(), shippedLocales);
	assert.ok(shippedLocales.includes('en'), 'English must always ship; it is every host\'s fallback');
});

for (const locale of shippedLocales) {
	test(`sidecar ${locale}: key set equals the webview dictionary keys`, () => {
		const expected = [...webviewLocalizationKeys()].sort();
		assert.deepEqual(dictionaryKeys(sidecars[locale]), expected);
	});

	test(`sidecar ${locale}: declares its own language`, () => {
		assert.equal(sidecars[locale]['__language__'], locale);
	});

	test(`sidecar ${locale}: text equals what the VS Code host sends`, () => {
		// Same values buildWebviewLocalization() puts in the VS Code / Electron payload.
		const hostPayload = buildWebviewLocalization(createTranslator(locale));
		const sidecar = { ...sidecars[locale] };
		delete sidecar['__language__'];
		assert.deepEqual(sidecar, hostPayload);
	});
}

test('sidecars: the zh-cn dictionary is actually translated, not a copy of English', () => {
	const differing = dictionaryKeys(sidecars['zh-cn']).filter(k => sidecars['zh-cn'][k] !== sidecars['en'][k]);
	assert.ok(differing.length > 50, `only ${differing.length} zh-cn strings differ from English`);
});

// Hosts name the sidecar files in their own build scripts. A locale added to the
// generator but not to a host (or the reverse) ships a host that cannot load it.
function sidecarLocalesNamedIn(relativePath: string): string[] {
	const text = readFileSync(join(repoRoot, relativePath), 'utf8');
	const found = new Set<string>();
	for (const match of text.matchAll(/localization\.([a-z]{2,3}(?:-[a-z0-9]+)*)\.json/gi)) {
		found.add(match[1].toLowerCase());
	}
	return [...found].sort();
}

test('JetBrains build copies exactly the generated sidecar locales', () => {
	assert.deepEqual(sidecarLocalesNamedIn('jetbrains-plugin/build.gradle.kts'), shippedLocales);
});

test('Visual Studio project packages exactly the generated sidecar locales', () => {
	assert.deepEqual(
		sidecarLocalesNamedIn('visualstudio-extension/src/AIEngineeringFluency/AIEngineeringFluency.csproj'),
		shippedLocales,
	);
});
