import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';

// The publisher is plain CommonJS workflow tooling that runs from the repo
// root, outside the extension's TypeScript program, so it is loaded by path.
// It is the one piece of the screenshot flow that runs next to a
// write-capable token in CI, which is why its input handling is pinned down
// here rather than trusted to review alone.
const requireFromHere = createRequire(__filename);

function findRepoRoot(): string {
	let dir = __dirname;
	for (let i = 0; i < 10; i++) {
		if (fs.existsSync(path.join(dir, '.github', 'workflows', 'scripts', 'visual-diff-comment.js'))) {
			return dir;
		}
		dir = path.dirname(dir);
	}
	throw new Error(`Could not locate the repo root from ${__dirname}`);
}

const REPO_ROOT = findRepoRoot();

type Attachment = { kind: string; file: string; alt: string };
type Comparison = {
	view: string; state: string | null; theme: string; status: string;
	baseline?: string; current?: string; diff?: string;
	changedPixels?: number; changedPercent?: number;
	baselineSize?: string; currentSize?: string; resized?: boolean;
};
type Plan = { attachments: Attachment[]; inline: Map<string, Attachment[]> };

const publisher = requireFromHere(
	path.join(REPO_ROOT, '.github', 'workflows', 'scripts', 'visual-diff-comment.js')
) as {
	safeAlt: (text: string) => string;
	safeId: (text: string) => string;
	safeText: (text: string) => string;
	resolveAttachment: (rootDir: string, subDir: string, fileName: string) => string | null;
	normalizeComparison: (raw: Record<string, unknown>) => Comparison;
	planAttachments: (comparisons: Comparison[], roots: { root: string }, budget: number, titles: Map<string, string>) => Plan;
	renderBody: (
		report: { summary: Record<string, number>; comparisons: Comparison[] },
		opts: { marker: string; base: string; runUrl: string; artifact: string; maxAttachments: number },
		titles: Map<string, string>,
		plan: Plan,
		mode: { withImages: boolean },
	) => string;
};

/** A screenshots root with one valid before/after/diff triple and some traps. */
function screenshotsRoot(): { root: string; cleanup: () => void } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-diff-comment-'));
	for (const dir of ['baseline', 'current', 'diff']) {
		fs.mkdirSync(path.join(root, dir));
	}
	const png = Buffer.from('89504e470d0a1a0a', 'hex');
	fs.writeFileSync(path.join(root, 'baseline', 'usage--tools.dark.png'), png);
	fs.writeFileSync(path.join(root, 'current', 'usage--tools.dark.png'), png);
	fs.writeFileSync(path.join(root, 'diff', 'usage--tools.dark.diff.png'), png);
	// A symlink with a screenshot-looking name pointing outside the root. A
	// junction on Windows, where a real symlink needs Developer Mode or admin
	// rights the CI runner does not have; `lstat` reports both as links.
	fs.symlinkSync(os.tmpdir(), path.join(root, 'current', 'link.dark.png'), process.platform === 'win32' ? 'junction' : 'dir');
	// A directory with a screenshot-looking name.
	fs.mkdirSync(path.join(root, 'current', 'dir.dark.png'));
	return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const OPTS = { marker: 'visual-view-diff', base: '', runUrl: '', artifact: 'webview-screenshots', maxAttachments: 48 };

test('safeId keeps only what a view or state id may contain', () => {
	assert.equal(publisher.safeId('usage--tools'), 'usage--tools');
	assert.equal(publisher.safeId('evil<img src=x onerror=1>|@rajbos'), 'evil_img_src_x_onerror_1_rajbos');
	assert.equal(publisher.safeId('<!-- visual-view-diff -->'), '_--_visual-view-diff_--_');
});

test('safeText strips everything Markdown or HTML would act on', () => {
	const text = publisher.safeText('Tools & Skills <b>x</b> | [link](http://e.x) @someone `code` <!-- m -->\nnext');
	assert.ok(!/[<>|`[\]()@#*_~\n]/.test(text), `unsafe characters survived: ${text}`);
	assert.ok(text.includes('Tools & Skills'), 'readable punctuation is kept');
});

test('safeAlt never carries the # that separates alt text on --attach', () => {
	assert.ok(!publisher.safeAlt('Before: usage #1 (dark)').includes('#'));
	assert.equal(publisher.safeAlt('  a   b  '), 'a b');
});

test('resolveAttachment only accepts a regular PNG directly under the screenshot root', () => {
	const { root, cleanup } = screenshotsRoot();
	try {
		assert.equal(publisher.resolveAttachment(root, 'current', 'usage--tools.dark.png'), path.posix.join(root, 'current', 'usage--tools.dark.png'));
		assert.equal(publisher.resolveAttachment(root, 'current', '../../../etc/passwd'), null, 'traversal');
		assert.equal(publisher.resolveAttachment(root, 'current', '/proc/self/environ'), null, 'absolute');
		assert.equal(publisher.resolveAttachment(root, 'current', 'link.dark.png'), null, 'symlink');
		assert.equal(publisher.resolveAttachment(root, 'current', 'dir.dark.png'), null, 'directory');
		assert.equal(publisher.resolveAttachment(root, 'current', 'missing.dark.png'), null, 'absent');
		assert.equal(publisher.resolveAttachment(root, 'current', 'notes.txt'), null, 'not a png');
		assert.equal(publisher.resolveAttachment(root, 'elsewhere', 'usage--tools.dark.png'), null, 'unknown subdirectory');
	} finally {
		cleanup();
	}
});

test('normalizeComparison reduces a hostile report row to inert values', () => {
	const row = publisher.normalizeComparison({
		view: 'x<script>', state: '../etc', theme: 'neon', status: 'exploded',
		baseline: '/proc/self/environ', current: '../../x.png', diff: 'd.png',
		changedPixels: '12', changedPercent: -3, baselineSize: '1280×900; drop', currentSize: '1280×900',
	});
	assert.equal(row.view, 'x_script_');
	assert.equal(row.theme, 'dark');
	assert.equal(row.status, 'unchanged');
	assert.equal(row.baseline, 'environ', 'only the basename survives');
	assert.equal(row.current, 'x.png');
	assert.equal(row.changedPixels, 0);
	assert.equal(row.changedPercent, 0);
	assert.equal(row.baselineSize, '');
	assert.equal(row.currentSize, '1280×900');
});

test('planAttachments attaches a changed view as a complete before/after/diff triple or not at all', () => {
	const { root, cleanup } = screenshotsRoot();
	try {
		const good: Comparison = { view: 'usage', state: 'tools', theme: 'dark', status: 'changed', baseline: 'usage--tools.dark.png', current: 'usage--tools.dark.png', diff: 'usage--tools.dark.diff.png', changedPixels: 10, changedPercent: 1 };
		const missingDiff: Comparison = { ...good, state: 'other', diff: 'nope.diff.png' };
		const plan = publisher.planAttachments([good, missingDiff], { root }, 48, new Map());
		assert.equal(plan.attachments.length, 3);
		assert.deepEqual(plan.attachments.map((a) => a.kind), ['Before', 'After', 'Diff']);
		assert.ok(plan.inline.has('usage--tools.dark'));
		assert.ok(!plan.inline.has('usage--other.dark'), 'a row with an unresolvable file is not attached');
		for (const a of plan.attachments) {
			assert.ok(a.file.startsWith(root + '/'), `attachment stays under the root: ${a.file}`);
			assert.ok(!a.alt.includes('#'));
		}
	} finally {
		cleanup();
	}
});

test('planAttachments refuses a changed row that has no diff image', () => {
	const { root, cleanup } = screenshotsRoot();
	try {
		const noDiff: Comparison = { view: 'usage', state: 'tools', theme: 'dark', status: 'changed', baseline: 'usage--tools.dark.png', current: 'usage--tools.dark.png', changedPixels: 10, changedPercent: 1 };
		const plan = publisher.planAttachments([noDiff], { root }, 48, new Map());
		assert.equal(plan.attachments.length, 0, 'a before/after pair without its diff is malformed, not a partial triple');
		assert.equal(plan.inline.size, 0);
	} finally {
		cleanup();
	}
});

test('planAttachments honours the budget and selects light then dark by view', () => {
	const { root, cleanup } = screenshotsRoot();
	try {
		const rows: Comparison[] = [];
		for (const theme of ['light', 'dark']) {
			for (let i = 0; i < 20; i++) {
				rows.push({ view: `v${i}`, state: null, theme, status: 'changed', baseline: 'usage--tools.dark.png', current: 'usage--tools.dark.png', diff: 'usage--tools.dark.diff.png', changedPixels: i, changedPercent: i });
			}
		}
		const plan = publisher.planAttachments(rows, { root }, 48, new Map());
		assert.equal(plan.attachments.length, 48, 'never more than the budget');
		assert.equal(plan.inline.size, 16);
		const selected = [...plan.inline.keys()];
		assert.equal(selected.length % 2, 0, 'the budget includes complete light/dark view pairs');
		for (let i = 0; i < selected.length; i += 2) {
			assert.match(selected[i], /\.light$/, 'light is selected first for each view');
			assert.equal(selected[i].replace(/\.light$/, ''), selected[i + 1].replace(/\.dark$/, ''));
			assert.match(selected[i + 1], /\.dark$/, 'dark follows the matching light view');
		}
	} finally {
		cleanup();
	}
});

test('renderBody starts with the marker and never leaks unsafe text', () => {
	const { root, cleanup } = screenshotsRoot();
	try {
		const titles = new Map([['usage', 'Usage Analysis'], ['usage--tools', 'Tools & Integrations tab']]);
		const row: Comparison = { view: 'usage', state: 'tools', theme: 'dark', status: 'changed', baseline: 'usage--tools.dark.png', current: 'usage--tools.dark.png', diff: 'usage--tools.dark.diff.png', changedPixels: 10, changedPercent: 1, currentSize: '1280×900' };
		const plan = publisher.planAttachments([row], { root }, 48, titles);
		const summary = { changed: 1, unchanged: 0, added: 0, removed: 0 };
		const withImages = publisher.renderBody({ summary, comparisons: [row] }, OPTS, titles, plan, { withImages: true });
		assert.ok(withImages.startsWith('<!-- visual-view-diff -->\n'), 'the marker is the first line, which is what CI matches on');
		assert.ok(withImages.includes(`![Before: Usage Analysis › Tools & Integrations tab dark](${path.posix.join(root, 'baseline', 'usage--tools.dark.png')})`));
		const plain = publisher.renderBody({ summary, comparisons: [row] }, OPTS, titles, plan, { withImages: false });
		assert.ok(!plain.includes('!['), 'the fallback body embeds no images');
		assert.ok(plain.includes('webview-screenshots'), 'the fallback points at the artifact');
	} finally {
		cleanup();
	}
});

test('renderBody shows before, after and diff in a four-column table', () => {
	const { root, cleanup } = screenshotsRoot();
	try {
		const row: Comparison = { view: 'usage', state: 'tools', theme: 'dark', status: 'changed', baseline: 'usage--tools.dark.png', current: 'usage--tools.dark.png', diff: 'usage--tools.dark.diff.png', changedPixels: 10, changedPercent: 1 };
		const plan = publisher.planAttachments([row], { root }, 48, new Map());
		const summary = { changed: 1, unchanged: 0, added: 0, removed: 0 };
		const body = publisher.renderBody({ summary, comparisons: [row] }, OPTS, new Map(), plan, { withImages: true });
		assert.ok(body.includes('| Name | Before | After | Diff |'));
		const renderedRow = body.split('\n').find((line) => line.startsWith('| **usage › tools**'));
		assert.ok(renderedRow, 'the changed view is rendered as a table row');
		assert.ok(renderedRow.includes('![Before:'), 'the before image is in the table');
		assert.ok(renderedRow.includes('![After:'), 'the after image is in the table');
		assert.ok(renderedRow.includes('![Diff:'), 'the diff image is in the table');
		assert.ok(!body.includes('<details>'), 'the image table is not collapsed');
		for (const a of plan.attachments) {
			assert.ok(body.includes(`](${a.file})`), `every attachment is referenced: ${a.kind}`);
		}
	} finally {
		cleanup();
	}
});

test('renderBody survives a changed row with no pixel figures', () => {
	const row: Comparison = { view: 'usage', state: null, theme: 'dark', status: 'changed' };
	const files = ['Before', 'After', 'Diff'].map((kind) => ({ kind, file: `visual-output/x/${kind}.png`, alt: kind }));
	const plan: Plan = { attachments: files, inline: new Map([['usage.dark', files]]) };
	const summary = { changed: 1, unchanged: 0, added: 0, removed: 0 };
	const body = publisher.renderBody({ summary, comparisons: [row] }, OPTS, new Map(), plan, { withImages: true });
	assert.ok(body.includes('| `usage` | initial | dark | 🎨 changed | — '), 'a missing percentage renders as a dash, not a crash');
	const renderedRow = body.split('\n').find((line) => line.startsWith('| **usage**'));
	assert.ok(renderedRow, 'the changed view still gets its image row');
	for (const kind of ['Before', 'After', 'Diff']) {
		assert.ok(renderedRow.includes(`![${kind}](visual-output/x/${kind}.png)`), `the ${kind} image is in the row`);
	}
});

test('renderBody emits no image grid when no row has inline images', () => {
	const row: Comparison = { view: 'usage', state: null, theme: 'dark', status: 'changed', changedPercent: 1, changedPixels: 10 };
	const stray = [{ kind: 'Diff', file: 'visual-output/diff/other.png', alt: 'Diff' }];
	const plan: Plan = { attachments: stray, inline: new Map([['other.dark', stray]]) };
	const summary = { changed: 1, unchanged: 0, added: 0, removed: 0 };
	const body = publisher.renderBody({ summary, comparisons: [row] }, OPTS, new Map(), plan, { withImages: true });
	assert.ok(!body.includes('![') && !/^\|\s*\|$/m.test(body), 'no empty or zero-column table');
});

test('renderBody explains magenta only when the grid holds a diff', () => {
	const summary = { changed: 0, unchanged: 0, added: 1, removed: 0 };
	const added: Comparison = { view: 'usage', state: null, theme: 'dark', status: 'added' };
	const shot = [{ kind: 'After', file: 'visual-output/current/usage.dark.png', alt: 'New view' }];
	const addedOnly = publisher.renderBody({ summary, comparisons: [added] }, OPTS, new Map(), { attachments: shot, inline: new Map([['usage.dark', shot]]) }, { withImages: true });
	assert.ok(addedOnly.includes('Click an image for full size'));
	assert.ok(!addedOnly.includes('Magenta'), 'an added screenshot is not a diff');
	assert.ok(!addedOnly.includes('Before and after'), 'no fold without a changed view');

	const changed: Comparison = { view: 'usage', state: null, theme: 'light', status: 'changed', changedPercent: 1, changedPixels: 10 };
	const files = ['Before', 'After', 'Diff'].map((kind) => ({ kind, file: `visual-output/x/${kind}.png`, alt: kind }));
	const both = publisher.renderBody(
		{ summary: { ...summary, changed: 1 }, comparisons: [added, changed] }, OPTS, new Map(),
		{ attachments: [...shot, ...files], inline: new Map([['usage.dark', shot], ['usage.light', files]]) }, { withImages: true });
	assert.ok(both.includes('Magenta marks changed pixels'));
});

test('renderBody reports an all-clear without a table when nothing changed', () => {
	const summary = { changed: 0, unchanged: 3, added: 0, removed: 0 };
	const rows: Comparison[] = [1, 2, 3].map((i) => ({ view: `v${i}`, state: null, theme: 'dark', status: 'unchanged' }));
	const body = publisher.renderBody({ summary, comparisons: rows }, OPTS, new Map(), { attachments: [], inline: new Map() }, { withImages: true });
	assert.ok(body.includes('No visual changes: all 3 view screenshots'));
	assert.ok(!body.includes('| View |'));
});
