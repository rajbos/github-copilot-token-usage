import { after } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Throwaway fixture directories for unit tests.
 *
 * Tests used to `fs.mkdtempSync(path.join(process.cwd(), '…'))`, which drops the
 * directory straight into `vscode-extension/` and leaves it there — a `git add -A`
 * after a test run then sweeps dozens of them into the commit. Create fixtures
 * through these helpers instead: they live outside the working directory (or, when
 * the subject under test forbids that, under one ignored parent) and are removed
 * when the test file finishes, pass or fail.
 *
 * `os.tmpdir()` is resolved through `realpathSync` so the returned path is the
 * canonical one (on macOS `/var/…` is a symlink to `/private/var/…`), keeping
 * paths a test derives from the fixture comparable to the one it was handed.
 */

const TMP_ROOT = fs.realpathSync(os.tmpdir());

const createdDirs: string[] = [];

/**
 * Creates a unique empty fixture directory and schedules it for removal.
 *
 * @param prefix name prefix, e.g. `'ctt-cache-test-'`; a random suffix is appended.
 */
export function makeTmpFixtureDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(TMP_ROOT, prefix));
	createdDirs.push(dir);
	return dir;
}

/**
 * Reserves a unique fixture path **without** creating it, for tests that need a
 * directory which does not exist. Anything created at that path later is still
 * cleaned up.
 */
export function reserveTmpFixturePath(prefix: string): string {
	const dir = path.join(TMP_ROOT, `${prefix}${process.pid}-${Math.random().toString(36).slice(2, 10)}`);
	createdDirs.push(dir);
	return dir;
}

/**
 * Root for fixtures that must live **outside** the OS temp directory: the secure
 * file-read guard in `src/utils/safeFileRead.ts` refuses to read session files
 * from there, so a parser test needs its fixtures somewhere else. One ignored
 * parent directory keeps them out of `git status` instead of scattering
 * `claude-test-*` siblings across `vscode-extension/`.
 */
const WORKSPACE_FIXTURE_ROOT = path.join(process.cwd(), '.test-fixtures');

/**
 * Creates a unique fixture directory under `vscode-extension/.test-fixtures/`,
 * for tests whose subject refuses to read out of the OS temp directory. Removed
 * when the test file finishes, like {@link makeTmpFixtureDir}.
 */
export function makeWorkspaceFixtureDir(prefix: string): string {
	fs.mkdirSync(WORKSPACE_FIXTURE_ROOT, { recursive: true });
	const dir = fs.mkdtempSync(path.join(WORKSPACE_FIXTURE_ROOT, prefix));
	createdDirs.push(dir);
	return dir;
}

// Registered at import time so it lands in the file's root test context; a hook
// added later, from inside a running test, would not reliably fire.
after(async () => {
	for (const dir of createdDirs.splice(0)) {
		await fs.promises.rm(dir, { recursive: true, force: true });
	}
});
