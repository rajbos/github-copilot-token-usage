import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import * as cp from 'node:child_process';

// The detector is plain CommonJS developer tooling that runs from the repo root,
// outside the extension's TypeScript program, so it is loaded by path (mirrors
// webviewContract.test.ts).
const requireFromHere = createRequire(__filename);

function findRepoRoot(): string {
	let dir = __dirname;
	for (let i = 0; i < 10; i++) {
		if (fs.existsSync(path.join(dir, 'scripts', 'check-code-duplication.js'))) {
			return dir;
		}
		dir = path.dirname(dir);
	}
	throw new Error(`Could not locate the repo root from ${__dirname}`);
}

const REPO_ROOT = findRepoRoot();
const dup = requireFromHere(
	path.join(REPO_ROOT, 'scripts', 'check-code-duplication.js')
) as {
	normalizeLine: (raw: string) => string;
	isNoise: (line: string) => boolean;
	classifyLine: (raw: string, inBlock: boolean) => { noise: boolean; inBlock: boolean; text?: string };
	tokenizeFile: (absPath: string) => { text: string; line: number }[] | null;
	globToRegExp: (glob: string) => RegExp;
	globBase: (glob: string) => string;
	escapeMarkdownCell: (s: string) => string;
	escapeHtml: (s: string) => string;
	findDuplicates: (
		fileTokens: { relPath: string; tokens: { text: string; line: number }[] }[],
		minLines: number
	) => { lines: number; occurrences: { file: string; startLine: number; endLine: number }[]; preview: string }[];
	totalDuplicatedLines: (groups: { lines: number; occurrences: unknown[] }[]) => number;
	renderMarkdown: (groups: unknown[], scanned: number, threshold: number | null) => string;
	renderJson: (groups: unknown[], scanned: number, threshold: number | null) => string;
	parseArgs: (argv: string[]) => { minLines: number; includes: string[]; json: boolean; failThreshold: number | null; maxGroups: number | null; baseline: string | null };
	applyBaseline: (args: { baseline: string | null; minLines: number; minLinesExplicit: boolean; maxGroups: number | null; failThreshold: number | null }, read?: (f: string) => string) => { minLines: number; maxGroups: number | null; failThreshold: number | null };
	gateViolations: (groups: { lines: number; occurrences: unknown[] }[], args: { maxGroups: number | null; failThreshold: number | null }) => string[];
	DEFAULT_INCLUDES: string[];
	MIN_LINES_DEFAULT: number;
};

function makeFileTokens(relPath: string, source: string) {
	const tokens: { text: string; line: number }[] = [];
	const lines = source.split(/\r?\n/);
	let inBlock = false;
	for (let i = 0; i < lines.length; i++) {
		const c = dup.classifyLine(lines[i], inBlock);
		inBlock = c.inBlock;
		if (c.noise) { continue; }
		tokens.push({ text: c.text as string, line: i + 1 });
	}
	return { relPath, tokens };
}

test('normalizeLine: collapses internal whitespace and trims ends', () => {
	assert.equal(dup.normalizeLine('\t  foo   bar  '), 'foo bar');
	assert.equal(dup.normalizeLine('a\tb\n'), 'a b');
});

test('isNoise: treats blank and comment-only lines as noise, code as signal', () => {
	assert.ok(dup.isNoise(''));
	assert.ok(dup.isNoise('   '));
	assert.ok(dup.isNoise('// a comment'));
	assert.ok(dup.isNoise('/* block open'));
	assert.ok(dup.isNoise('* mid block'));
	assert.ok(dup.isNoise('*/ block close'));
	assert.ok(!dup.isNoise('const x = 1;'));
	assert.ok(!dup.isNoise('return x; // trailing'));
});

test('classifyLine: tracks block-comment state across lines so unprefixed body lines are noise', () => {
	// Inside an open block comment, an unprefixed body line is noise.
	assert.deepEqual(dup.classifyLine('this is prose', true), { noise: true, inBlock: true });
	// A line comment after the close stays noise and closes the block.
	assert.deepEqual(dup.classifyLine('*/ // trailing', true), { noise: true, inBlock: false });
	// Code after the close on the same line is kept.
	const c = dup.classifyLine('*/ const x = 1;', true);
	assert.equal(c.noise, false);
	assert.equal(c.inBlock, false);
	assert.equal(c.text, 'const x = 1;');
	// A block comment opening with no code is noise and enters the block.
	assert.deepEqual(dup.classifyLine('/* header', false), { noise: true, inBlock: true });
	// A whole-line `/* ... */` block is noise.
	assert.deepEqual(dup.classifyLine('/* one liner */', false), { noise: true, inBlock: false });
	// Code preceding an open + code after close on the same line is kept.
	const m = dup.classifyLine('const a = 1; /* c */ const b = 2;', false);
	assert.equal(m.noise, false);
	assert.equal(m.inBlock, false);
	assert.equal(m.text, 'const a = 1; const b = 2;');
});

test('tokenizeFile: drops unprefixed body lines inside a block comment', () => {
	const tmp = fs.mkdtempSync(path.join(requireFromHere('node:os').tmpdir(), 'dup-'));
	try {
		const file = path.join(tmp, 'block.ts');
		fs.writeFileSync(file, '/**\n * a documentation block\n * with prose lines\n */\nconst real = 1;\n');
		const tokens = dup.tokenizeFile(file);
		assert.ok(tokens);
		assert.equal(tokens.length, 1);
		assert.equal(tokens[0].text, 'const real = 1;');
		assert.equal(tokens[0].line, 5);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test('findDuplicates: does not flag overlapping windows of one repeated run as a clone', () => {
	// Seven identical meaningful lines with min-lines 6 produce windows starting
	// on token indices 0 and 1; that is one block, not a within-file duplicate.
	const run = Array.from({ length: 7 }, () => 'const same = 1;').join('\n');
	const fileA = makeFileTokens('a.ts', `${run}\n`);
	const groups = dup.findDuplicates([fileA], 6);
	assert.equal(groups.length, 0, 'a single repeated run should not be reported as an intra-file clone');
});

test('globBase: returns the static directory prefix before the first wildcard', () => {
	assert.equal(dup.globBase('src/**/*.ts'), 'src');
	assert.equal(dup.globBase('src/foo*/*.ts'), 'src');
	assert.equal(dup.globBase('a/b/c/*.ts'), 'a/b/c');
	assert.equal(dup.globBase('*.ts'), '');
	assert.equal(dup.globBase('no/wildcard.ts'), 'no/wildcard.ts');
});

test('globToRegExp: matches double-star recursively and single-star within a segment', () => {
	const re = dup.globToRegExp('src/**/*.ts');
	assert.ok(re.test('src/a.ts'));
	assert.ok(re.test('src/adapters/claude.ts'));
	assert.ok(!re.test('vscode-extension/src/a.ts'));
	const re2 = dup.globToRegExp('*.ts');
	assert.ok(re2.test('a.ts'));
	assert.ok(!re2.test('a.js'));
});

test('findDuplicates: detects an identical block copied between two files', () => {
	const block = [
		'function sharedHelper(a: number, b: number): number {',
		'const sum = a + b;',
		'const product = a * b;',
		'if (sum > product) { return sum; }',
		'return product;',
		'}',
		'',
		'export { sharedHelper };',
	].join('\n');
	const fileA = makeFileTokens('a.ts', `// header\n${block}\nconst extra = 1;\n`);
	const fileB = makeFileTokens('b.ts', `/* file b */\n${block}\nconst other = 2;\n`);
	const groups = dup.findDuplicates([fileA, fileB], 6);
	assert.ok(groups.length >= 1, 'expected at least one duplicate group');
	const top = groups[0];
	assert.ok(top.lines >= 6, 'group should span at least the min lines');
	const files = top.occurrences.map((o) => o.file).sort();
	assert.deepEqual(files, ['a.ts', 'b.ts']);
});

test('findDuplicates: does not flag a block that appears only once', () => {
	const fileA = makeFileTokens('a.ts', 'function unique() { return 1; }\nconst x = 2;\nconst y = 3;\nconst z = 4;\nconst w = 5;\nconst v = 6;\n');
	const fileB = makeFileTokens('b.ts', 'function different() { return 9; }\nconst p = 8;\nconst q = 7;\nconst r = 6;\nconst s = 5;\nconst t = 4;\n');
	const groups = dup.findDuplicates([fileA, fileB], 6);
	assert.equal(groups.length, 0);
});

test('findDuplicates: extends to the maximal shared block, not just the window', () => {
	const shared = [
		'const a = 1;',
		'const b = 2;',
		'const c = 3;',
		'const d = 4;',
		'const e = 5;',
		'const f = 6;',
		'const g = 7;',
		'const h = 8;',
		'const i = 9;',
	].join('\n');
	const fileA = makeFileTokens('a.ts', `export const before = 0;\n${shared}\nexport const after = 10;\n`);
	const fileB = makeFileTokens('b.ts', `export const otherBefore = -1;\n${shared}\nexport const otherAfter = 11;\n`);
	const groups = dup.findDuplicates([fileA, fileB], 6);
	assert.ok(groups.length >= 1);
	// The maximal block is the 9 shared lines (the surrounding `export const`
	// lines differ, so they are not part of the clone).
	assert.equal(groups[0].lines, 9);
});

test('findDuplicates: catches a copy that differs only by indentation and comments', () => {
	const clean = [
		'function parse(line: string): number {',
		'const trimmed = line.trim();',
		'const value = parseInt(trimmed, 10);',
		'if (Number.isNaN(value)) { return 0; }',
		'return value;',
		'}',
	].join('\n');
	const recommented = [
		'function parse(line: string): number {',
		'    // trim before parsing',
		'    const trimmed = line.trim();',
		'    const value = parseInt(trimmed, 10);',
		'    // guard against NaN',
		'    if (Number.isNaN(value)) { return 0; }',
		'    return value;',
		'}',
	].join('\n');
	const fileA = makeFileTokens('a.ts', `${clean}\n`);
	const fileB = makeFileTokens('b.ts', `${recommented}\n`);
	const groups = dup.findDuplicates([fileA, fileB], 6);
	assert.ok(groups.length >= 1, 're-indented/re-commented copy should still be detected');
	assert.ok(groups[0].lines >= 6);
});

test('totalDuplicatedLines: sums lines * occurrences across groups', () => {
	const groups = [
		{ lines: 10, occurrences: [1, 2] },
		{ lines: 5, occurrences: [1, 2, 3] },
	];
	assert.equal(dup.totalDuplicatedLines(groups), 10 * 2 + 5 * 3);
});

test('renderMarkdown: reports a summary table and the no-findings state', () => {
	const empty = dup.renderMarkdown([], 5, null);
	assert.match(empty, /Code Duplication Analysis/);
	assert.match(empty, /No duplicate blocks found/);
	assert.match(empty, /\| 5 \| 0 \| 0 \|/);
	const withFindings = dup.renderMarkdown(
		[{ lines: 8, occurrences: [{ file: 'a.ts', startLine: 1, endLine: 8 }], preview: 'const x' }],
		5,
		null
	);
	assert.match(withFindings, /Top duplicate groups/);
	assert.match(withFindings, /All duplicate groups/);
});

test('renderJson: emits parseable JSON with the expected shape', () => {
	const json = dup.renderJson(
		[{ lines: 7, occurrences: [{ file: 'a.ts', startLine: 1, endLine: 7 }], preview: 'p' }],
		3,
		100
	);
	const parsed = JSON.parse(json);
	assert.equal(parsed.filesScanned, 3);
	assert.equal(parsed.threshold, 100);
	assert.equal(parsed.groups[0].lines, 7);
});

test('parseArgs: applies defaults and parses flags', () => {
	const a = dup.parseArgs([]);
	assert.equal(a.minLines, dup.MIN_LINES_DEFAULT);
	assert.ok(a.includes.length >= 3);
	assert.equal(a.json, false);
	assert.equal(a.failThreshold, null);
	const b = dup.parseArgs(['--min-lines', '8', '--json', '--fail-threshold', '200', '--include', 'src/**/*.ts']);
	assert.equal(b.minLines, 8);
	assert.equal(b.json, true);
	assert.equal(b.failThreshold, 200);
	assert.deepEqual(b.includes, ['src/**/*.ts']);
});

test('globToRegExp: a --include value cannot inject an arbitrary regex', () => {
	// A glob containing regex metacharacters is rejected by the safe-alphabet
	// sanitizer before a RegExp is built, so it can never inject a live regex
	// operator. Parentheses are not part of the glob grammar and are refused.
	assert.throws(() => dup.globToRegExp('src/(weird).ts'), /Invalid --include glob/);
});

test('globToRegExp: rejects a glob smuggling a regex alternation operator', () => {
	assert.throws(() => dup.globToRegExp('src/a|b.ts'), /Invalid --include glob/);
});

test('escapeMarkdownCell: escapes backslash first, then the pipe delimiter', () => {
	assert.equal(dup.escapeMarkdownCell('plain'), 'plain');
	assert.equal(dup.escapeMarkdownCell('a|b'), 'a\\|b');
	// A backslash must be doubled before the pipe escape, so `\|` cannot smuggle
	// a literal pipe through as a column separator.
	assert.equal(dup.escapeMarkdownCell('a\\|b'), 'a\\\\\\|b');
});

test('escapeHtml: HTML-escapes ampersand, angle brackets for safe <code> use', () => {
	assert.equal(dup.escapeHtml('plain'), 'plain');
	assert.equal(dup.escapeHtml('a<b>c&d'), 'a&lt;b&gt;c&amp;d');
});

test('renderMarkdown: previews are escaped for the table cell', () => {
	const md = dup.renderMarkdown(
		[{ lines: 8, occurrences: [{ file: 'a.ts', startLine: 1, endLine: 8 }], preview: 'a|b\\c`tick' }],
		5,
		null
	);
	// The preview is rendered inside an HTML <code> element (not a backtick
	// span) with pipes/backslashes escaped and HTML-entities applied, so a
	// source backtick or template literal cannot close the code span.
	assert.match(md, /<code>a\\\|b\\\\c`tick…<\/code>/);
	assert.ok(!md.includes('| a|b\\c`tick'));
});

test('the detector runs end-to-end against a fixture and reports a clone', () => {
	// A behavior assertion against a temp fixture, independent of the current
	// repo duplication baseline, so a legitimate cleanup never fails this suite.
	const { spawnSync } = requireFromHere('node:child_process') as typeof import('node:child_process');
	const tmp = fs.mkdtempSync(path.join(requireFromHere('node:os').tmpdir(), 'dup-e2e-'));
	try {
		const block = [
			'function sharedHelper(a: number, b: number): number {',
			'const sum = a + b;',
			'const product = a * b;',
			'if (sum > product) { return sum; }',
			'return product;',
			'}',
			'export { sharedHelper };',
		].join('\n');
		fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
		fs.writeFileSync(path.join(tmp, 'src', 'a.ts'), `// header\n${block}\nconst extra = 1;\n`);
		fs.writeFileSync(path.join(tmp, 'src', 'b.ts'), `/* file b */\n${block}\nconst other = 2;\n`);
		const result = spawnSync(
			process.execPath,
			[path.join(REPO_ROOT, 'scripts', 'check-code-duplication.js'), '--min-lines', '6', '--include', 'src/**/*.ts', '--json', '--root', tmp],
			{ cwd: tmp, encoding: 'utf8' }
		);
		assert.equal(result.status, 0, `detector should run report-only; stderr: ${result.stderr}`);
		const parsed = JSON.parse(result.stdout);
		assert.equal(parsed.filesScanned, 2);
		assert.ok(Array.isArray(parsed.groups));
		assert.ok(parsed.groups.length >= 1, 'the fixture has a copied block');
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test('the detector exits 1 against a fixture when --fail-threshold is exceeded', () => {
	const { spawnSync } = requireFromHere('node:child_process') as typeof import('node:child_process');
	const tmp = fs.mkdtempSync(path.join(requireFromHere('node:os').tmpdir(), 'dup-thr-'));
	try {
		const block = [
			'function sharedHelper(a: number, b: number): number {',
			'const sum = a + b;',
			'const product = a * b;',
			'if (sum > product) { return sum; }',
			'return product;',
			'}',
			'export { sharedHelper };',
		].join('\n');
		fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
		fs.writeFileSync(path.join(tmp, 'src', 'a.ts'), `${block}\n`);
		fs.writeFileSync(path.join(tmp, 'src', 'b.ts'), `${block}\n`);
		const result = spawnSync(
			process.execPath,
			[path.join(REPO_ROOT, 'scripts', 'check-code-duplication.js'), '--min-lines', '6', '--fail-threshold', '1', '--include', 'src/**/*.ts', '--json', '--root', tmp],
			{ cwd: tmp, encoding: 'utf8' }
		);
		assert.equal(result.status, 1, 'threshold of 1 is exceeded by the fixture clone');
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test('the detector runs against the repo as a smoke check (no baseline assertion)', () => {
	// Independent of the duplication baseline: only asserts the tool runs and
	// emits a valid shape, so source cleanup never breaks this suite.
	const { spawnSync } = requireFromHere('node:child_process') as typeof import('node:child_process');
	const result = spawnSync(
		process.execPath,
		[path.join(REPO_ROOT, 'scripts', 'check-code-duplication.js'), '--min-lines', '14', '--json'],
		{ cwd: REPO_ROOT, encoding: 'utf8' }
	);
	assert.equal(result.status, 0, `detector should run report-only; stderr: ${result.stderr}`);
	const parsed = JSON.parse(result.stdout);
	assert.ok(parsed.filesScanned > 0, 'should scan at least some source files');
	assert.ok(Array.isArray(parsed.groups));
});

test('parseArgs: parses --max-groups and --baseline', () => {
	const a = dup.parseArgs(['--max-groups', '12', '--baseline', 'b.json']);
	assert.equal(a.maxGroups, 12);
	assert.ok(a.baseline && a.baseline.endsWith('b.json'));
	assert.equal(dup.parseArgs([]).maxGroups, null);
});

test('DEFAULT_INCLUDES: covers the non-extension source trees too', () => {
	for (const t of ['sharing-server/src', 'desktop/src', 'release-video/src']) {
		assert.ok(dup.DEFAULT_INCLUDES.some((g) => g.startsWith(t)), t);
	}
});

test('applyBaseline: supplies limits but explicit flags win', () => {
	const read = () => JSON.stringify({ minLines: 14, maxGroups: 5, maxDuplicatedLines: 100 });
	const a = dup.applyBaseline({ baseline: 'x', minLines: 6, minLinesExplicit: false, maxGroups: null, failThreshold: null }, read);
	assert.deepEqual([a.maxGroups, a.failThreshold], [5, 100]);
	const b = dup.applyBaseline({ baseline: 'x', minLines: 6, minLinesExplicit: false, maxGroups: 9, failThreshold: 7 }, read);
	assert.deepEqual([b.maxGroups, b.failThreshold], [9, 7]);
	const none = dup.applyBaseline({ baseline: null, minLines: 6, minLinesExplicit: false, maxGroups: null, failThreshold: null }, read);
	assert.equal(none.maxGroups, null);
});

test('applyBaseline: rejects a malformed baseline', () => {
	assert.throws(() => dup.applyBaseline({ baseline: 'x', minLines: 6, minLinesExplicit: false, maxGroups: null, failThreshold: null }, () => '{"minLines":14,"maxGroups":-1,"maxDuplicatedLines":3}'));
	assert.throws(() => dup.applyBaseline({ baseline: 'x', minLines: 6, minLinesExplicit: false, maxGroups: null, failThreshold: null }, () => '{"minLines":14,"maxGroups":1}'));
	assert.throws(() => dup.applyBaseline({ baseline: 'x', minLines: 6, minLinesExplicit: false, maxGroups: null, failThreshold: null }, () => 'not json'));
});

test('gateViolations: flags growth in groups or lines, passes at the limit', () => {
	const g = [{ lines: 10, occurrences: [{}, {}] }, { lines: 5, occurrences: [{}, {}] }]; // 2 groups, 30 lines
	assert.deepEqual(dup.gateViolations(g, { maxGroups: 2, failThreshold: 30 }), []);
	assert.equal(dup.gateViolations(g, { maxGroups: 1, failThreshold: 30 }).length, 1);
	assert.equal(dup.gateViolations(g, { maxGroups: 2, failThreshold: 29 }).length, 1);
	assert.equal(dup.gateViolations(g, { maxGroups: 1, failThreshold: 1 }).length, 2);
	assert.deepEqual(dup.gateViolations(g, { maxGroups: null, failThreshold: null }), []);
});

test('the detector enforces the committed baseline against the repo', () => {
	const script = path.join(REPO_ROOT, 'scripts', 'check-code-duplication.js');
	const baseline = path.join(REPO_ROOT, 'scripts', 'code-duplication-baseline.json');
	const ok = cp.spawnSync(process.execPath, [script, '--min-lines', '14', '--baseline', baseline, '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
	assert.equal(ok.status, 0, ok.stderr);
	const bad = cp.spawnSync(process.execPath, [script, '--min-lines', '14', '--baseline', baseline, '--max-groups', '0', '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
	assert.equal(bad.status, 1);
	assert.match(bad.stderr, /duplicate groups/);
});

test('applyBaseline: applies the baseline minLines unless --min-lines was passed', () => {
	const read = () => JSON.stringify({ minLines: 14, maxGroups: 5, maxDuplicatedLines: 100 });
	const base = { baseline: 'x', minLines: 6, minLinesExplicit: false, maxGroups: null, failThreshold: null };
	assert.equal(dup.applyBaseline({ ...base }, read).minLines, 14);
	assert.equal(dup.applyBaseline({ ...base, minLines: 14, minLinesExplicit: true }, read).minLines, 14);
});

test('applyBaseline: an explicit --min-lines that conflicts with the baseline is an error', () => {
	const read = () => JSON.stringify({ minLines: 14, maxGroups: 5, maxDuplicatedLines: 100 });
	assert.throws(
		() => dup.applyBaseline({ baseline: 'x', minLines: 6, minLinesExplicit: true, maxGroups: null, failThreshold: null }, read),
		/conflicts with baseline/,
	);
});

test('applyBaseline: a baseline without a valid minLines is rejected', () => {
	const bad = () => JSON.stringify({ maxGroups: 5, maxDuplicatedLines: 100 });
	assert.throws(() => dup.applyBaseline({ baseline: 'x', minLines: 6, minLinesExplicit: false, maxGroups: null, failThreshold: null }, bad), /minLines/);
});

test('--help lists each option once', () => {
	const r = cp.spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'check-code-duplication.js'), '--help'], { encoding: 'utf8' });
	for (const opt of ['--max-groups', '--baseline', '--min-lines', '--fail-threshold']) {
		assert.equal(r.stdout.split(/\r?\n/).filter((l) => l.trimStart().startsWith(opt + ' ')).length, 1, opt);
	}
});

test('the detector with only --baseline scans at the baseline minLines and passes', () => {
	const script = path.join(REPO_ROOT, 'scripts', 'check-code-duplication.js');
	const baseline = path.join(REPO_ROOT, 'scripts', 'code-duplication-baseline.json');
	const ok = cp.spawnSync(process.execPath, [script, '--baseline', baseline, '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
	assert.equal(ok.status, 0, ok.stderr);
	const conflict = cp.spawnSync(process.execPath, [script, '--min-lines', '6', '--baseline', baseline], { encoding: 'utf8' });
	assert.equal(conflict.status, 2);
	assert.match(conflict.stderr, /conflicts with baseline/);
});
