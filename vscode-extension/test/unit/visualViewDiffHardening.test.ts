import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';

// The visual-view-diff skill builds and renders the code under review, so the
// paths its registry and fixtures name, the environment the build sees and the
// directories it clears are all pinned down here (issue #2310).
const requireFromHere = createRequire(__filename);

function findRepoRoot(): string {
	let dir = __dirname;
	for (let i = 0; i < 10; i++) {
		if (fs.existsSync(path.join(dir, '.github', 'skills', 'visual-view-diff', 'lib', 'harness.js'))) {
			return dir;
		}
		dir = path.dirname(dir);
	}
	throw new Error(`Could not locate the repo root from ${__dirname}`);
}

const SKILL_DIR = path.join(findRepoRoot(), '.github', 'skills', 'visual-view-diff');

const harness = requireFromHere(path.join(SKILL_DIR, 'lib', 'harness.js')) as {
	resolveInside: (root: string, relativePath: unknown, label: string, anchor?: string) => string;
	anchorFor: (dir: string, anchors: string[]) => string;
	loadFixture: (fixturePath: string, repoRoot: string) => unknown;
	buildPageHtml: (options: { globalName: string; fixture: unknown; theme: string; bundlePath: string; repoRoot: string }) => string;
};

const visualDiff = requireFromHere(path.join(SKILL_DIR, 'visual-diff.js')) as {
	buildEnv: (source: Record<string, string | undefined>, platform?: string) => Record<string, string>;
	prepareOutRoot: (outRoot: string, defaultOutRoot: string) => void;
	requireOptionValues: (args: Record<string, string | boolean>) => Record<string, string | boolean>;
	resolveBaseRef: (requested?: unknown) => { ref: string; sha: string };
};

const config = requireFromHere(path.join(SKILL_DIR, 'lib', 'config.js')) as {
	readConfig: (skillDir: string, configPath?: string) => { views: Array<Record<string, unknown>> };
};

type RenderResult = { status: string; error?: string };
const renderViews = requireFromHere(path.join(SKILL_DIR, 'render-views.js')) as {
	renderView: (options: Record<string, unknown>) => Promise<RenderResult>;
};

const configLib = requireFromHere(path.join(SKILL_DIR, 'lib', 'config.js')) as {
	parseThemes: (value: unknown) => string[];
	parseNumberOption: (value: unknown, name: string, range: { fallback: number | undefined; min: number; max: number }) => number | undefined;
};

type RouteHandler = (route: { request: () => { url: () => string }; continue: () => string; abort: (reason: string) => string }) => string;
const browserLib = requireFromHere(path.join(SKILL_DIR, 'lib', 'browser.js')) as {
	blockNetwork: (page: unknown) => Promise<void>;
};

function tempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'vvd-hardening-'));
}

/** A fake repo root with one in-root JSON file and a secret beside it. */
function fakeRepo(): { root: string; parent: string } {
	const parent = tempDir();
	const root = path.join(parent, 'repo');
	fs.mkdirSync(path.join(root, 'src'), { recursive: true });
	fs.writeFileSync(path.join(root, 'src', 'data.json'), JSON.stringify({ ok: true }));
	fs.writeFileSync(path.join(parent, 'secret.json'), JSON.stringify({ token: 'SENTINEL-SECRET' }));
	return { root, parent };
}

function writeFixture(dir: string, ref: string): string {
	const file = path.join(dir, 'fixture.json');
	fs.writeFileSync(file, JSON.stringify({ data: { $fromRepoJson: ref } }));
	return file;
}

test('resolveInside accepts paths under the root', () => {
	const { root, parent } = fakeRepo();
	try {
		assert.equal(harness.resolveInside(root, 'src/data.json', 'x'), path.join(root, 'src', 'data.json'));
		assert.equal(harness.resolveInside(root, 'src/../src/data.json', 'x'), path.join(root, 'src', 'data.json'));
		assert.equal(harness.resolveInside(root, 'not-there-yet.json', 'x'), path.join(root, 'not-there-yet.json'));
	} finally {
		fs.rmSync(parent, { recursive: true, force: true });
	}
});

test('resolveInside rejects traversal, absolute paths, the root itself and non-strings', () => {
	const { root, parent } = fakeRepo();
	try {
		const bad: unknown[] = [
			'../secret.json',
			'src/../../secret.json',
			'..',
			'.',
			'',
			path.join(parent, 'secret.json'),
			'/etc/passwd',
			undefined,
			42,
		];
		for (const value of bad) {
			assert.throws(() => harness.resolveInside(root, value, '$fromRepoJson'), /\$fromRepoJson/, JSON.stringify(value));
		}
	} finally {
		fs.rmSync(parent, { recursive: true, force: true });
	}
});

test('resolveInside rejects a symlink inside the root that points outside it', (t) => {
	const { root, parent } = fakeRepo();
	try {
		try {
			fs.symlinkSync(path.join(parent, 'secret.json'), path.join(root, 'src', 'link.json'), 'file');
		} catch {
			t.skip('symlinks are not permitted on this machine');
			return;
		}
		assert.throws(() => harness.resolveInside(root, 'src/link.json', 'x'), /resolves outside/);
	} finally {
		fs.rmSync(parent, { recursive: true, force: true });
	}
});

test('loadFixture resolves $fromRepoJson inside the repo and refuses to embed files outside it', () => {
	const { root, parent } = fakeRepo();
	const fixtures = tempDir();
	try {
		assert.deepEqual(harness.loadFixture(writeFixture(fixtures, 'src/data.json'), root), { data: { ok: true } });
		for (const ref of ['../secret.json', path.join(parent, 'secret.json')]) {
			assert.throws(() => harness.loadFixture(writeFixture(fixtures, ref), root), /resolves outside|must be a relative path/, ref);
		}
	} finally {
		fs.rmSync(parent, { recursive: true, force: true });
		fs.rmSync(fixtures, { recursive: true, force: true });
	}
});

test('the bundle build sees an allowlisted environment, never the caller\'s tokens', () => {
	const source = {
		PATH: '/bin',
		Path: 'C:\\bin',
		SystemRoot: 'C:\\Windows',
		HOME: '/home/u',
		GITHUB_TOKEN: 'ghs_secret',
		GH_PAT: 'pat',
		NODE_OPTIONS: '--require /evil.js',
		AZURE_STORAGE_KEY: 'k',
		UNSET: undefined,
		home: '/elsewhere',
	};
	// Windows environment names are case-insensitive, so `Path` and `SystemRoot`
	// are the allowlisted variables there.
	assert.deepEqual(Object.keys(visualDiff.buildEnv(source, 'win32')).sort(), ['HOME', 'PATH', 'Path', 'SystemRoot', 'home']);
	// Elsewhere case variants are distinct variables and are not forwarded.
	for (const platform of ['linux', 'darwin']) {
		assert.deepEqual(Object.keys(visualDiff.buildEnv(source, platform)).sort(), ['HOME', 'PATH'], platform);
	}
});

test('--base refuses a value git would read as an option', () => {
	for (const bad of ['-h', '--output=/tmp/x', '', true]) {
		assert.throws(() => visualDiff.resolveBaseRef(bad), /--base must name a commit/, String(bad));
	}
});

test('a value option given without a value is an error, not a silent default', () => {
	for (const name of ['base', 'out', 'theme', 'view']) {
		assert.throws(() => visualDiff.requireOptionValues({ [name]: true }), new RegExp(`--${name} needs a value`));
	}
	assert.deepEqual(visualDiff.requireOptionValues({ base: 'main', 'allow-missing': true }), { base: 'main', 'allow-missing': true });
});

test('--out refuses a symlinked output root, even the default one', (t) => {
	const dir = tempDir();
	try {
		const target = path.join(dir, 'target');
		fs.mkdirSync(path.join(target, 'current'), { recursive: true });
		const link = path.join(dir, 'visual-output');
		try {
			fs.symlinkSync(target, link, 'junction');
		} catch {
			t.skip('symlinks are not permitted on this machine');
			return;
		}
		fs.writeFileSync(path.join(target, '.visual-view-diff-output'), '');
		assert.throws(() => visualDiff.prepareOutRoot(link, link), /symbolic link/);
		assert.ok(fs.existsSync(path.join(target, 'current')), 'the symlink target is left untouched');
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('--out is only cleared when the skill owns it', () => {
	const dir = tempDir();
	try {
		const fresh = path.join(dir, 'fresh');
		visualDiff.prepareOutRoot(fresh, path.join(dir, 'default'));
		assert.ok(fs.existsSync(path.join(fresh, '.visual-view-diff-output')), 'a new directory is marked as ours');

		const foreign = path.join(dir, 'foreign');
		fs.mkdirSync(path.join(foreign, 'current'), { recursive: true });
		assert.throws(() => visualDiff.prepareOutRoot(foreign, path.join(dir, 'default')), /refusing to delete/);
		assert.ok(!fs.existsSync(path.join(foreign, '.visual-view-diff-output')), 'a refused directory is left untouched');

		const fallback = path.join(dir, 'default');
		fs.mkdirSync(path.join(fallback, 'diff'), { recursive: true });
		assert.doesNotThrow(() => visualDiff.prepareOutRoot(fallback, fallback), 'the default visual-output/ is always ours');

		fs.mkdirSync(path.join(fresh, 'baseline'));
		assert.doesNotThrow(() => visualDiff.prepareOutRoot(fresh, path.join(dir, 'default')), 'a marked directory can be reused');
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('--out never follows a symlinked marker or entry', (t) => {
	const dir = tempDir();
	try {
		const outside = path.join(dir, 'outside.txt');
		fs.writeFileSync(outside, 'KEEP');
		const out = path.join(dir, 'out');
		fs.mkdirSync(path.join(out, 'current'), { recursive: true });
		const marker = path.join(out, '.visual-view-diff-output');
		try {
			fs.symlinkSync(outside, marker, 'file');
		} catch {
			t.skip('symlinks are not permitted on this machine');
			return;
		}
		// A marker that is a link does not make the directory ours, and is not written through.
		assert.throws(() => visualDiff.prepareOutRoot(out, path.join(dir, 'default')), /link or special file/);
		assert.equal(fs.readFileSync(outside, 'utf8'), 'KEEP');
		assert.ok(fs.existsSync(path.join(out, 'current')), 'nothing is deleted when the marker is refused');

		// The same holds for the default root, and for a dangling link.
		fs.rmSync(marker);
		fs.symlinkSync(path.join(dir, 'missing.txt'), marker, 'file');
		assert.throws(() => visualDiff.prepareOutRoot(out, out), /link or special file/);
		assert.ok(!fs.existsSync(path.join(dir, 'missing.txt')), 'a dangling marker link is not created through');

		// An entry the run overwrites later is removed as a link, never through it.
		fs.rmSync(marker);
		fs.mkdirSync(marker);
		fs.symlinkSync(outside, path.join(out, '.baseline-registry.json'), 'file');
		fs.symlinkSync(outside, path.join(out, 'timings.md'), 'file');
		visualDiff.prepareOutRoot(out, path.join(dir, 'default'));
		assert.equal(fs.readFileSync(outside, 'utf8'), 'KEEP');
		for (const name of ['.baseline-registry.json', 'timings.md', 'current']) {
			assert.equal(fs.lstatSync(path.join(out, name), { throwIfNoEntry: false }), undefined, `${name} is cleared`);
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('--out claims its marker atomically and releases it when refusing', () => {
	const dir = tempDir();
	try {
		const fresh = path.join(dir, 'fresh');
		visualDiff.prepareOutRoot(fresh, path.join(dir, 'default'));
		assert.ok(fs.lstatSync(path.join(fresh, '.visual-view-diff-output')).isDirectory(), 'the marker is a real directory');
		assert.doesNotThrow(() => visualDiff.prepareOutRoot(fresh, path.join(dir, 'default')), 'and claims the root on the next run');

		const foreign = path.join(dir, 'foreign');
		fs.mkdirSync(path.join(foreign, 'diff'), { recursive: true });
		assert.throws(() => visualDiff.prepareOutRoot(foreign, path.join(dir, 'default')), /refusing to delete/);
		assert.throws(() => visualDiff.prepareOutRoot(foreign, path.join(dir, 'default')), /refusing to delete/, 'a refused run does not leave a marker behind that would let the next one through');
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('a committed registry cannot choose the fixture directory; a generated one can', () => {
	const dir = tempDir();
	try {
		const views = [{ id: 'v', bundle: 'v', global: '__G__', fixture: 'v.json', fixtureDir: '/etc' }];
		fs.writeFileSync(path.join(dir, 'views.config.json'), JSON.stringify({ defaults: {}, views }));
		assert.equal(config.readConfig(dir).views[0].fixtureDir, undefined, 'stripped from the skill registry');
		assert.equal(config.readConfig(dir, path.join(dir, 'views.config.json')).views[0].fixtureDir, '/etc', 'kept for an explicit --config');
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('renderView refuses a fixture outside its fixture directory before opening a page', async (t) => {
	const { root, parent } = fakeRepo();
	try {
		const dist = path.join(root, 'dist');
		const fixtures = path.join(root, 'fixtures');
		fs.mkdirSync(dist);
		fs.mkdirSync(fixtures);
		fs.writeFileSync(path.join(dist, 'v.js'), '');
		const browser = { newPage: () => { throw new Error('no page should be opened'); } };
		const render = (fixture: string) => renderViews.renderView({
			browser, view: { id: 'v', bundle: 'v', global: '__G__', fixture, fixtureDir: fixtures },
			state: null, theme: 'dark', outDir: parent, tmpDir: parent, defaults: {}, distDir: dist, repoRoot: root,
		});
		for (const fixture of ['../../secret.json', path.join(parent, 'secret.json')]) {
			const result = await render(fixture);
			assert.equal(result.status, 'error', fixture);
			assert.match(String(result.error), /fixture/, fixture);
		}
		const bundleEscape = await renderViews.renderView({
			browser, view: { id: 'v', bundle: '../../secret', global: '__G__', fixture: 'f.json', fixtureDir: fixtures },
			state: null, theme: 'dark', outDir: parent, tmpDir: parent, defaults: {}, distDir: dist, repoRoot: root,
		});
		assert.match(String(bundleEscape.error), /bundle .* resolves outside/);
		try {
			fs.symlinkSync(path.join(parent, 'secret.json'), path.join(fixtures, 'link.json'), 'file');
		} catch {
			t.skip('symlinks are not permitted on this machine');
			return;
		}
		assert.match(String((await render('link.json')).error), /resolves outside/);
	} finally {
		fs.rmSync(parent, { recursive: true, force: true });
	}
});

test('--theme accepts exactly dark, light or both', () => {
	assert.deepEqual(configLib.parseThemes(undefined), ['dark']);
	assert.deepEqual(configLib.parseThemes('dark'), ['dark']);
	assert.deepEqual(configLib.parseThemes('light'), ['light']);
	assert.deepEqual(configLib.parseThemes('both'), ['dark', 'light']);
	for (const bad of ['../../x', 'dark/../light', 'Dark', '', true, 'dark,light']) {
		assert.throws(() => configLib.parseThemes(bad), /--theme must be dark, light or both/, String(bad));
	}
});

test('the page builder refuses a theme that is not dark or light', () => {
	for (const theme of ['../../../package', 'both', '']) {
		assert.throws(() => harness.buildPageHtml({
			globalName: '__G__', fixture: {}, theme, bundlePath: path.join(SKILL_DIR, 'dist', 'x.js'), repoRoot: findRepoRoot(),
		}), /theme must be 'dark' or 'light'/, theme);
	}
});

test('numeric diff options are range-checked instead of becoming NaN', () => {
	const threshold = { fallback: 0.02, min: 0, max: 1 };
	assert.equal(configLib.parseNumberOption(undefined, 'threshold', threshold), 0.02);
	assert.equal(configLib.parseNumberOption('0.1', 'threshold', threshold), 0.1);
	for (const bad of ['abc', '', '1.5', '-0.1', 'NaN', 'Infinity', true]) {
		assert.throws(() => configLib.parseNumberOption(bad, 'threshold', threshold), /--threshold must be a number from 0 to 1/, String(bad));
	}
	assert.equal(configLib.parseNumberOption(undefined, 'noise-floor', { fallback: undefined, min: 0, max: Number.MAX_SAFE_INTEGER }), undefined);
});

/** A stand-in Playwright context that records the handlers blockNetwork registers. */
function fakeContext(withWebSocketRouting: boolean) {
	const routes: Array<{ pattern: unknown; handler: RouteHandler }> = [];
	const sockets: Array<{ pattern: unknown; handler: (ws: { close: () => void }) => void }> = [];
	const context: Record<string, unknown> = {
		route: async (pattern: unknown, handler: RouteHandler) => { routes.push({ pattern, handler }); },
	};
	if (withWebSocketRouting) {
		context.routeWebSocket = async (pattern: unknown, handler: (ws: { close: () => void }) => void) => { sockets.push({ pattern, handler }); };
	}
	return { page: { context: () => context }, routes, sockets };
}

test('blockNetwork lets local pages load and aborts every outbound request', async () => {
	const { page, routes } = fakeContext(true);
	await browserLib.blockNetwork(page);
	assert.equal(routes.length, 1);
	assert.equal(routes[0].pattern, '**/*', 'every request is routed');
	const decide = (url: string) => routes[0].handler({
		request: () => ({ url: () => url }),
		continue: () => 'continue',
		abort: (reason: string) => `abort:${reason}`,
	});
	for (const local of ['file:///C:/repo/vscode-extension/dist/webview/details.js', 'data:image/png;base64,AAAA', 'blob:null/1234', 'FILE:///x']) {
		assert.equal(decide(local), 'continue', local);
	}
	for (const remote of ['https://example.com/x.js', 'http://127.0.0.1:8080/', 'http://localhost/', 'ws://example.com/', 'ftp://example.com/', 'https://file.example.com/data:']) {
		assert.equal(decide(remote), 'abort:blockedbyclient', remote);
	}
});

test('blockNetwork closes every WebSocket', async () => {
	const { page, sockets } = fakeContext(true);
	await browserLib.blockNetwork(page);
	assert.equal(sockets.length, 1);
	assert.ok(sockets[0].pattern instanceof RegExp && (sockets[0].pattern as RegExp).test('wss://example.com/socket'), 'every WebSocket URL matches');
	let closed = 0;
	sockets[0].handler({ close: () => { closed++; } });
	assert.equal(closed, 1, 'the socket is closed, never connected to a server');
});

test('blockNetwork fails closed when Playwright cannot route WebSockets', async () => {
	const { page } = fakeContext(false);
	await assert.rejects(browserLib.blockNetwork(page), /cannot block WebSockets/);
});

test('resolveInside refuses a containment root that is itself a symlink out of its checkout', (t) => {
	const { root, parent } = fakeRepo();
	try {
		const fixtures = path.join(root, 'fixtures');
		try {
			// The reviewed tree replaces `fixtures/` with a link to the directory holding the secret.
			fs.symlinkSync(parent, fixtures, 'junction');
		} catch {
			t.skip('symlinks are not permitted on this machine');
			return;
		}
		assert.throws(() => harness.resolveInside(fixtures, 'secret.json', 'fixture', root), /goes through a symbolic link/);
		// Without the anchor the link's target becomes the root, which is exactly the hole.
		assert.equal(harness.resolveInside(fixtures, 'secret.json', 'fixture'), path.join(fixtures, 'secret.json'), 'documents why callers must pass the anchor');
	} finally {
		fs.rmSync(parent, { recursive: true, force: true });
	}
});

test('resolveInside refuses a containment root reached through a symlinked parent', (t) => {
	const { root, parent } = fakeRepo();
	const elsewhere = tempDir();
	try {
		fs.mkdirSync(path.join(elsewhere, 'fixtures'));
		fs.writeFileSync(path.join(elsewhere, 'fixtures', 'x.json'), '{}');
		try {
			fs.symlinkSync(elsewhere, path.join(root, 'skill'), 'junction');
		} catch {
			t.skip('symlinks are not permitted on this machine');
			return;
		}
		assert.throws(() => harness.resolveInside(path.join(root, 'skill', 'fixtures'), 'x.json', 'fixture', root), /goes through a symbolic link/);
	} finally {
		fs.rmSync(parent, { recursive: true, force: true });
		fs.rmSync(elsewhere, { recursive: true, force: true });
	}
});

test('resolveInside accepts a real root under its anchor and refuses one outside it', () => {
	const { root, parent } = fakeRepo();
	try {
		assert.equal(harness.resolveInside(path.join(root, 'src'), 'data.json', 'fixture', root), path.join(root, 'src', 'data.json'));
		assert.throws(() => harness.resolveInside(parent, 'secret.json', 'fixture', root), /is not inside/);
	} finally {
		fs.rmSync(parent, { recursive: true, force: true });
	}
});

test('anchorFor picks the checkout a directory belongs to', () => {
	const repo = path.resolve('/r');
	const worktree = path.join(repo, 'visual-output', '.baseline-worktree');
	assert.equal(harness.anchorFor(path.join(worktree, 'fixtures'), [worktree, repo]), worktree, 'the baseline worktree, not the repo it sits in');
	assert.equal(harness.anchorFor(path.join(repo, 'fixtures'), [worktree, repo]), repo);
	assert.equal(harness.anchorFor(repo, [worktree, repo]), repo);
	assert.equal(harness.anchorFor(path.resolve('/other/dist'), [worktree, repo]), path.resolve('/other/dist'), 'an operator-chosen directory is its own anchor');
	assert.equal(harness.anchorFor(path.resolve('/r..x/dist'), [repo]), path.resolve('/r..x/dist'), 'a sibling whose name starts with the anchor is not inside it');
});
