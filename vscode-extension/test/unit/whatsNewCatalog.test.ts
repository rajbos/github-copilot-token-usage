import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
	WHATS_NEW_MAX_RELEASES,
	WHATS_NEW_RELEASES,
	findFeature,
	type FeatureViewId,
} from '../../src/whatsNew/catalog';
import { compareVersions } from '../../src/whatsNew/announcer';
import { SWITCHABLE_TABS } from '../../src/webview/usage/switchableTabs';

import { ENGLISH_BUNDLE } from '../../src/l10nCore';

/**
 * The shipped English for a catalog key.
 *
 * catalog.ts holds `package.nls.json` keys rather than prose — it is a pure
 * module and cannot resolve strings itself. Asserting on the resolved text
 * keeps these checks about editorial quality while also failing if a key has
 * no bundle entry at all.
 */
function englishFor(key: string): string {
	const value = ENGLISH_BUNDLE[key];
	assert.ok(value !== undefined, `${key} has no package.nls.json entry`);
	return value;
}


const extensionPackageJson = JSON.parse(
	fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'),
) as { version: string };

/**
 * The catalog is hand-maintained data that drives real UI, so these guard the
 * mistakes a human actually makes while editing it: a duplicated id (which
 * silently suppresses an announcement for everyone who saw the original), a
 * tab name that no longer exists (a "Take me there" button that goes nowhere),
 * or a release list that stopped being newest-first.
 */
test('catalog integrity', async (t) => {
	await t.test('feature ids are unique across every release', () => {
		const seen = new Set<string>();
		for (const release of WHATS_NEW_RELEASES) {
			for (const feature of release.features) {
				assert.ok(!seen.has(feature.id), `duplicate feature id: ${feature.id}`);
				seen.add(feature.id);
			}
		}
	});

	await t.test('releases are listed newest first', () => {
		for (let i = 1; i < WHATS_NEW_RELEASES.length; i++) {
			const newer = WHATS_NEW_RELEASES[i - 1].version;
			const older = WHATS_NEW_RELEASES[i].version;
			assert.ok(compareVersions(newer, older) > 0, `${newer} should sort above ${older}`);
		}
	});

	await t.test('the current extension version has a catalog entry', () => {
		assert.ok(
			WHATS_NEW_RELEASES.some((release) => release.version === extensionPackageJson.version),
			`missing What's New catalog entry for version ${extensionPackageJson.version}`,
		);
	});

	await t.test('every release carries a headline and a usable date', () => {
		for (const release of WHATS_NEW_RELEASES) {
			// Resolved, not raw: the catalog holds nls keys now, so this checks the
			// shipped English is real prose *and* that the key resolves at all.
			const headline = englishFor(release.headlineKey);
			assert.ok(headline.trim().length > 20, `${release.version} needs a real headline`);
			if (release.date !== null) {
				assert.match(release.date, /^\d{4}-\d{2}-\d{2}$/, `${release.version} date must be YYYY-MM-DD`);
			}
		}
	});

	await t.test('at most one release is marked unreleased', () => {
		const unreleased = WHATS_NEW_RELEASES.filter((r) => r.date === null);
		assert.ok(unreleased.length <= 1, `expected at most one unreleased entry, got ${unreleased.length}`);
	});

	await t.test('an unreleased entry, if present, matches the current extension version', () => {
		const unreleased = WHATS_NEW_RELEASES.filter((release) => release.date === null);
		for (const release of unreleased) {
			assert.equal(
				release.version,
				extensionPackageJson.version,
				`only the current version ${extensionPackageJson.version} may be left unreleased`,
			);
		}
	});

	await t.test('every feature is described in prose, not changelog shorthand', () => {
		for (const release of WHATS_NEW_RELEASES) {
			for (const feature of release.features) {
				assert.ok(englishFor(feature.titleKey).trim().length > 0, `${feature.id} needs a title`);
				assert.ok(englishFor(feature.descriptionKey).trim().length > 40, `${feature.id} needs a real description`);
			}
		}
	});

	await t.test('every feature points at a view the extension actually ships', () => {
		const views: FeatureViewId[] = [
			'details', 'chart', 'usage', 'maturity', 'efficiency',
			'environmental', 'diagnostics', 'logviewer', 'fluency-level-viewer', 'dashboard', 'whatsnew',
		];
		for (const release of WHATS_NEW_RELEASES) {
			for (const feature of release.features) {
				assert.ok(views.includes(feature.surface.view), `${feature.id}: unknown view ${feature.surface.view}`);
			}
		}
	});

	await t.test('every Usage Analysis feature names a tab the host can actually switch to', () => {
		// A tab outside this set makes the notification's "Take me there" button
		// silently do nothing — the failure mode the contract check exists for,
		// but one step further out where only data can be wrong.
		for (const release of WHATS_NEW_RELEASES) {
			for (const feature of release.features) {
				if (feature.surface.view !== 'usage' || !feature.surface.tab) { continue; }
				assert.ok(
					SWITCHABLE_TABS.has(feature.surface.tab),
					`${feature.id}: '${feature.surface.tab}' is not a switchable Usage Analysis tab`,
				);
			}
		}
	});

	await t.test('the catalog holds enough history for the What\'s New view', () => {
		assert.ok(
			WHATS_NEW_RELEASES.length >= Math.min(WHATS_NEW_MAX_RELEASES, 3),
			'keep at least a few releases so the view is not near-empty',
		);
	});
});

test('findFeature', async (t) => {
	await t.test('returns the feature and the release it shipped in', () => {
		const first = WHATS_NEW_RELEASES.find((r) => r.features.length > 0);
		assert.ok(first, 'catalog needs at least one feature to test against');
		const found = findFeature(first.features[0].id);
		assert.equal(found?.feature.id, first.features[0].id);
		assert.equal(found?.release.version, first.version);
	});

	await t.test('returns null for an unknown id', () => {
		assert.equal(findFeature('nope.not-a-feature'), null);
	});
});
