/**
 * Runs the shared-source unit tests (<repo>/src/test) inside the extension's own unit run.
 *
 * Tests that only exercise editor-neutral modules in the repo-root `src/` live next to that
 * code (`src/test`) and need no VS Code harness — `npm run test:src` runs them on their own.
 * CI, the coverage thresholds and `npm run test:node` however all glob this folder
 * (`out/vscode-extension/test/unit/*.test.js`), so requiring the compiled shared tests from
 * here keeps them in those runs without touching the workflow files.
 *
 * Test files are required in sorted order; each one registers its own tests with node:test.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

// Compiled output mirrors the repo layout (tsconfig.tests.json's rootDir is the repo root):
// out/vscode-extension/test/unit/<this file> -> out/src/test/*.test.js
const SHARED_TEST_DIR = path.join(__dirname, '../../../src/test');

if (!fs.existsSync(SHARED_TEST_DIR)) {
	throw new Error(`Compiled shared-src tests not found at ${SHARED_TEST_DIR} — run \`npm run compile-tests\` first.`);
}

for (const file of fs.readdirSync(SHARED_TEST_DIR).filter(name => name.endsWith('.test.js')).sort()) {
	require(path.join(SHARED_TEST_DIR, file));
}
