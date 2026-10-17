#!/usr/bin/env node
/**
 * Generates the webview bundles' built-in English fallback from
 * `package.nls.json`.
 *
 * Why this exists: the English text used to be written twice — once in
 * `package.nls.json`, which the host resolves and ships in the panel payload,
 * and again in a hand-written `DEFAULT_LOCALIZATION` literal inside
 * `localization.ts`, which the bundle falls back to when no payload arrived.
 * Nothing compared the two. They happened to agree, but a one-sided edit would
 * have made a panel render different English depending on whether the host
 * dictionary turned up — and three of the four hosts that ship these bundles
 * relied entirely on the fallback until very recently.
 *
 * Generating it removes the second author rather than policing them. What
 * remains hand-maintained is `webviewKeys.json`: *which* keys the webviews
 * need, which is a real editorial decision and not derivable from the bundle
 * (the nls file also holds ~380 host-only keys).
 *
 * Why a trimmed JSON rather than importing `package.nls.json` directly in the
 * webview: that would inline all 528 keys into each of the 12 bundles, roughly
 * +53 KB every time. The generated file carries only the keys the webviews
 * actually declare.
 *
 * Usage:
 *   node scripts/generate-webview-strings.mjs            # write the file
 *   node scripts/generate-webview-strings.mjs --check    # fail if stale (CI)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const extRoot = path.resolve(scriptDir, '..');
const sharedDir = path.join(extRoot, 'src', 'webview', 'shared');

const keysPath = path.join(sharedDir, 'webviewKeys.json');
const outputPath = path.join(sharedDir, 'webviewStrings.generated.json');
const englishPath = path.join(extRoot, 'package.nls.json');

export function buildWebviewStrings() {
	const keys = JSON.parse(fs.readFileSync(keysPath, 'utf8'));
	const english = JSON.parse(fs.readFileSync(englishPath, 'utf8'));

	const missing = keys.filter((key) => !(key in english));
	if (missing.length > 0) {
		throw new Error(
			`webviewKeys.json lists ${missing.length} key(s) with no package.nls.json entry:\n  ${missing.join('\n  ')}`,
		);
	}
	const duplicates = keys.filter((key, i) => keys.indexOf(key) !== i);
	if (duplicates.length > 0) {
		throw new Error(`webviewKeys.json has duplicate key(s): ${[...new Set(duplicates)].join(', ')}`);
	}

	// Key order follows the manifest, so a reordered manifest produces a
	// reviewable diff rather than a reshuffled file.
	const strings = {};
	for (const key of keys) {
		strings[key] = english[key];
	}
	return `${JSON.stringify(strings, null, 2)}\n`;
}

function main() {
	const content = buildWebviewStrings();
	const check = process.argv.includes('--check');
	// Read directly and treat "missing" as an outcome of the read, rather than
	// asking existsSync first: the check-then-read pair is a file-system race
	// (CodeQL flagged it), and "not there" is the only failure worth tolerating.
	let current = null;
	try {
		current = fs.readFileSync(outputPath, 'utf8');
	} catch (error) {
		if (error.code !== 'ENOENT') { throw error; }
	}

	if (check) {
		if (current !== content) {
			console.error(
				`❌ ${path.relative(extRoot, outputPath)} is out of date.\n` +
				'   Run "npm run generate:webview-strings" and commit the result.\n',
			);
			process.exit(1);
		}
		console.log(`✅ ${path.relative(extRoot, outputPath)} is up to date (${Object.keys(JSON.parse(content)).length} keys).`);
		return;
	}

	fs.writeFileSync(outputPath, content);
	const verb = current === content ? 'unchanged' : 'updated';
	console.log(`✅ ${path.relative(extRoot, outputPath)} ${verb} (${Object.keys(JSON.parse(content)).length} keys).`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1] === fileURLToPath(import.meta.url)) {
	main();
}
