import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Regression guard for the "GitHub Copilot Token Tracker" → "AI Engineering
 * Fluency" rename (see CHANGELOG.md). Two classes of stale reference kept
 * slipping through a mechanical prose scrub because they're identifier-shaped
 * rather than plain prose:
 *
 *  1. Repo-relative paths under the old `visualstudio-extension/src/
 *     CopilotTokenTracker/` directory, which no longer exists (the real path
 *     is `visualstudio-extension/src/AIEngineeringFluency/`).
 *  2. Docs quoting literal UI text (the VS Code output-channel name, the
 *     command-palette category, the VS output pane/menu name) that the
 *     rename already changed at the source of truth
 *     (`vscode-extension/package.nls.json` / `package.json`).
 *
 * The file lists below are deliberately a curated, defined set (per
 * AGENTS.md's "keep the extraction conservative" guidance) — the exact
 * locations known to quote these paths/strings — rather than a repo-wide
 * glob, to keep the false-positive rate at zero. If a new doc starts quoting
 * one of these paths or strings, add it to the relevant list below.
 */

/**
 * Walks up from the compiled test to the repo root.
 *
 * Tests compile into `vscode-extension/out/vscode-extension/test/unit`, so a
 * hardcoded `../../../..` is both unreadable and wrong the moment the output
 * layout shifts. Look for the marker file instead.
 */
function findRepoRoot(): string {
	let dir = __dirname;
	for (let i = 0; i < 10; i++) {
		if (fs.existsSync(path.join(dir, 'AGENTS.md')) && fs.existsSync(path.join(dir, 'vscode-extension'))) {
			return dir;
		}
		dir = path.dirname(dir);
	}
	throw new Error(`Could not locate the repo root from ${__dirname}`);
}

const REPO_ROOT = findRepoRoot();

function readRepoFile(relPath: string): string {
	return fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
}

// ---------------------------------------------------------------------------
// Finding 1 — dead directory paths
// ---------------------------------------------------------------------------

/**
 * Files known to quote repo-relative paths that once pointed under the
 * (now-deleted) `visualstudio-extension/src/CopilotTokenTracker/` directory.
 * Every one of them was fixed to point at
 * `visualstudio-extension/src/AIEngineeringFluency/` (or the equivalent
 * `.csproj`/file name) in the same change that added this test.
 *
 * `scripts/repo-stats.ps1` deliberately isn't included here even though it
 * had the same stale reference: the path it quotes
 * (`visualstudio-extension/src/AIEngineeringFluency/webview`) is a
 * gitignored, generated-only build-output directory (see .gitignore) that
 * legitimately does not exist on a fresh checkout or in CI, so asserting its
 * on-disk presence would be a false positive unrelated to the rename.
 */
const PATH_SCANNED_FILES = [
	'.claude/agents/prep-release.md',
	'.github/agents/prep-release.agent.md',
	'.claude/skills/sync-host-views/SKILL.md',
	'.github/skills/sync-host-views/SKILL.md',
	'.github/instructions/jetbrains-plugin.instructions.md',
	'.github/skills/README.md',
];

/** A path reference must start with one of these to be treated as repo-relative. */
const KNOWN_TOP_LEVEL_DIRS = [
	'src/', 'cli/', 'vscode-extension/', 'visualstudio-extension/',
	'jetbrains-plugin/', 'docs/', 'scripts/', '.github/',
];

/**
 * Backtick-quoted strings that look path-like but are not real paths on
 * disk — deliberate template placeholders in the scanned files. Keyed by
 * the exact scanned-file path so a coincidental match elsewhere still fails
 * loudly. Add here (with a comment) only when a false positive is a
 * confirmed placeholder, never to silence a real dead path.
 */
const PATH_PLACEHOLDER_ALLOWLIST: Record<string, string[]> = {
	// "Adding new skills" template step — a literal name-your-own-skill placeholder.
	'.github/skills/README.md': ['.github/skills/new-skill-name/'],
};

/** Release-tag prefixes like `cli/v`, `cli/v0.2.10`, `cli/vX.Y.Z` — not paths. */
function looksLikeVersionTag(pathLikeCandidate: string): boolean {
	const segments = pathLikeCandidate.split('/');
	const last = segments[segments.length - 1];
	return last === 'v' || /^v(\d|X)/i.test(last);
}

function extractBacktickedPaths(content: string): { line: number; candidate: string }[] {
	const results: { line: number; candidate: string }[] = [];
	const lines = content.split('\n');
	lines.forEach((lineText, idx) => {
		const backtickPattern = /`([^`\n]+)`/g;
		let match: RegExpExecArray | null;
		while ((match = backtickPattern.exec(lineText))) {
			// Strip a trailing markdown anchor/query fragment, if any.
			const candidate = match[1].trim().split('#')[0].split('?')[0];
			if (!KNOWN_TOP_LEVEL_DIRS.some((dir) => candidate.startsWith(dir))) { continue; }
			if (/[<>*]/.test(candidate) || candidate.includes(' ') || candidate.includes('...')) { continue; } // glob/placeholder shapes
			if (looksLikeVersionTag(candidate)) { continue; }
			results.push({ line: idx + 1, candidate });
		}
	});
	return results;
}

test('doc references: backtick-quoted repo-relative paths resolve on disk', () => {
	const failures: string[] = [];

	for (const relFile of PATH_SCANNED_FILES) {
		const content = readRepoFile(relFile);
		const allowlisted = new Set(PATH_PLACEHOLDER_ALLOWLIST[relFile] ?? []);

		for (const { line, candidate } of extractBacktickedPaths(content)) {
			if (allowlisted.has(candidate)) { continue; }
			const absolute = path.join(REPO_ROOT, candidate);
			if (!fs.existsSync(absolute)) {
				failures.push(
					`${relFile}:${line} references \`${candidate}\`, which does not exist. ` +
					`(The GitHub Copilot Token Tracker -> AI Engineering Fluency rename moved ` +
					`visualstudio-extension/src/CopilotTokenTracker/ to ` +
					`visualstudio-extension/src/AIEngineeringFluency/ — check for a leftover old path, ` +
					`or add a confirmed placeholder to PATH_PLACEHOLDER_ALLOWLIST in this test.)`
				);
			}
		}
	}

	assert.equal(
		failures.length, 0,
		`Found ${failures.length} dead path reference(s):\n${failures.join('\n')}`
	);
});

// ---------------------------------------------------------------------------
// Finding 2 — docs quoting UI strings the rename already changed
// ---------------------------------------------------------------------------

/**
 * Files known to quote the VS Code output-channel name, command-palette
 * category, or the Visual Studio output pane / menu / toolbar name as
 * literal UI text.
 */
const UI_STRING_SCANNED_FILES = [
	'.github/instructions/vscode-extension.instructions.md',
	'.claude/skills/copilot-log-analysis/SKILL.md',
	'.github/skills/copilot-log-analysis/SKILL.md',
	'.claude/skills/load-cache-data/SKILL.md',
	'.github/skills/load-cache-data/SKILL.md',
	'docs/USAGE-ANALYSIS.md',
	'docs/specs/backend.md',
	'docs/features/FLUENCY-LEVEL-VIEWER-TEST-PLAN.md',
	'docs/adr/history/LIGHT-THEME-SUPPORT.md',
	'.claude/skills/azure-storage-loader/SKILL.md',
	'.github/skills/azure-storage-loader/SKILL.md',
	'visualstudio-extension/DEBUGGING-GUIDE.md',
	'visualstudio-extension/docs/DEBUGGING.md',
];

/**
 * Line-level exceptions for files in UI_STRING_SCANNED_FILES that are
 * legitimately allowed to keep the old product name (history, not a stale
 * UI-string quote). None are needed today — every file above was fixed —
 * but keep this named/commented so a deliberate future exception (e.g. a
 * changelog entry moved into one of these files) is a one-line addition
 * instead of a workaround. Matched as an exact-substring-of-line check.
 *
 * Files that are *entirely* out of scope for this reason already aren't
 * listed in UI_STRING_SCANNED_FILES at all:
 *   - CHANGELOG.md files (historical release notes)
 *   - docs/README.md (deliberate dual "old / new name" sentence)
 *   - docs/logFilesSchema/jetbrains-session-schema.json (captured tool output
 *     inside an example fixture payload)
 */
const UI_STRING_LINE_ALLOWLIST: Record<string, string[]> = {};

/** The pre-rename product name. A fixed historical fact — never updated for a future rename. */
const OLD_PRODUCT_NAME = 'Copilot Token Tracker';

function readJson(relPath: string): any {
	return JSON.parse(readRepoFile(relPath));
}

test('doc references: quoted UI strings match the current product name', () => {
	const packageJson = readJson('vscode-extension/package.json');
	const packageNls = readJson('vscode-extension/package.nls.json');

	const currentOutputChannelName: string = packageNls.outputChannelName;
	const currentCategories: Set<string> = new Set(
		(packageJson.contributes?.commands ?? [])
			.map((cmd: { category?: string }) => cmd.category)
			.filter(Boolean)
	);

	// Sanity-check the source of truth itself before trusting it in messages below.
	assert.ok(currentOutputChannelName, 'vscode-extension/package.nls.json is missing outputChannelName');
	assert.equal(
		currentCategories.size, 1,
		`Expected every vscode-extension/package.json command to share one category, found: ${[...currentCategories].join(', ')}`
	);
	const currentCategory = [...currentCategories][0];
	assert.notEqual(currentOutputChannelName, OLD_PRODUCT_NAME, 'source of truth still says the old product name — update this test, not the allowlist');
	assert.notEqual(currentCategory, OLD_PRODUCT_NAME, 'source of truth still says the old product name — update this test, not the allowlist');

	const failures: string[] = [];

	for (const relFile of UI_STRING_SCANNED_FILES) {
		const lines = readRepoFile(relFile).split('\n');
		const allowlisted = UI_STRING_LINE_ALLOWLIST[relFile] ?? [];

		lines.forEach((lineText, idx) => {
			if (!lineText.includes(OLD_PRODUCT_NAME)) { return; }
			if (allowlisted.some((snippet) => lineText.includes(snippet))) { return; }
			failures.push(
				`${relFile}:${idx + 1} quotes the old product name "${OLD_PRODUCT_NAME}". ` +
				`Source of truth: vscode-extension/package.nls.json outputChannelName is ` +
				`"${currentOutputChannelName}", vscode-extension/package.json command category is ` +
				`"${currentCategory}". If this is a deliberate exception (history, a dual-name ` +
				`sentence, fixture data), add it to UI_STRING_LINE_ALLOWLIST in this test.`
			);
		});
	}

	assert.equal(
		failures.length, 0,
		`Found ${failures.length} stale UI-string reference(s):\n${failures.join('\n')}`
	);
});

test('doc references: CLI comment matches the real npx package name', () => {
	const cliPackageJson = readJson('cli/package.json');

	// `npx <x>` resolves <x> against the npm PACKAGE name, not the bin name. Those differ
	// here — the package is scoped (@rajbos/...) while the bin is bare — so validating
	// against `bin` would happily accept `npx ai-engineering-fluency`, which resolves to a
	// different (unscoped) package entirely. An earlier revision of this test made exactly
	// that mistake and passed on a wrong invocation; assert against `name`.
	const packageName: string = cliPackageJson.name;
	assert.ok(packageName, 'cli/package.json has no "name" field to validate against');

	const staleNames = ['copilot-token-tracker-cli', 'copilot-token-tracker'];
	for (const stale of staleNames) {
		assert.notEqual(packageName, stale, `source of truth still says the old package name — update this test`);
	}

	const cliTsContent = readRepoFile('cli/src/cli.ts');

	// Every `npx …` invocation in the file must name the real package.
	const npxInvocations = [...cliTsContent.matchAll(/npx\s+(@?[\w./-]+)/g)];
	assert.ok(npxInvocations.length > 0, 'expected at least one `npx …` invocation in cli/src/cli.ts');
	for (const match of npxInvocations) {
		assert.equal(
			match[1],
			packageName,
			`cli/src/cli.ts documents "npx ${match[1]}", which does not resolve to this package. ` +
			`Source of truth: cli/package.json "name" is "${packageName}" ` +
			`(note: the bin name is NOT what npx resolves).`
		);
	}
});
