/**
 * Boundary / branch-pinning tests for src/workspaceHelpers.ts, written to kill surviving
 * Stryker mutants (refs #2341). Complements workspaceHelpers.test.ts.
 */
import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import customizationPatternsData from '../../../src/customizationPatterns.json';
import {
	detectEditorSource,
	detectRelocatedAgentHomeFromPath,
	escapeRegexSpecials,
	extractCustomAgentName,
	extractMcpServerName,
	getEditorNameFromRoot,
	getEditorTypeFromPath,
	getModeType,
	getRepoDisplayName,
	globToRegExp,
	normalizeMcpToolName,
	parseCodeWorkspaceFolders,
	parseGitRemoteUrl,
	replaceGlobstars,
	replaceQuestionMarks,
	replaceWildcards,
	resolveDebugLogCandidatePaths,
	resolveExactWorkspacePath,
	resolveSessionWorkspaceName,
	resolveWorkspaceFolderFromSessionPath,
	resolveWorkspaceFolderWithFallback,
	scanWorkspaceCustomizationFiles,
	extractRepositoryFromContentReferences,
	findRepositoryRemoteForFolder,
	refineEditorLabelForInteractionModeSplit,
} from '../../../src/workspaceHelpers';

function withTmp<T>(fn: (dir: string) => T): T {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-bound-'));
	try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function write(file: string, content = 'x'): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

// ── glob helpers ─────────────────────────────────────────────────────────────

test('escapeRegexSpecials escapes each special character', () => {
	assert.equal(escapeRegexSpecials('a.b+c^d=e!f:g${h}(i)|j[k]l\\m'), 'a\\.b\\+c\\^d\\=e\\!f\\:g\\$\\{h\\}\\(i\\)\\|j\\[k\\]l\\\\m');
	assert.equal(escapeRegexSpecials('plain-text_1'), 'plain-text_1');
});

test('replaceGlobstars: middle, leading and trailing double-star handling', () => {
	assert.equal(replaceGlobstars('a/**/b'), 'a/__GLOBSTAR__/b');
	assert.equal(replaceGlobstars('**/b'), '__GLOBSTAR__/b');
	assert.equal(replaceGlobstars('a/**'), 'a/__GLOBSTAR__');
	assert.equal(replaceGlobstars('**'), '__GLOBSTAR__');
	assert.equal(replaceGlobstars('a**b'), 'a__GLOBSTAR__b');
});

test('replaceWildcards / replaceQuestionMarks replace every occurrence', () => {
	assert.equal(replaceWildcards('*a*'), '[^/]*a[^/]*');
	assert.equal(replaceQuestionMarks('a?b?'), 'a.b.');
});

test('globToRegExp: anchors, wildcards, globstars, ? and case flag', () => {
	const star = globToRegExp('.github/*.md');
	assert.equal(star.source.startsWith('^'), true);
	assert.equal(star.source.endsWith('$'), true);
	assert.equal(star.test('.github/a.md'), true);
	assert.equal(star.test('.github/sub/a.md'), false);
	assert.equal(star.test('x.github/a.md'), false);
	assert.equal(star.test('.github/a.md.bak'), false);
	assert.equal(star.test('.githubXa.md'), false); // '.' is literal

	const deep = globToRegExp('src/**/x.ts');
	assert.equal(deep.test('src/x.ts'), true);
	assert.equal(deep.test('src/a/b/x.ts'), true);
	assert.equal(deep.test('lib/x.ts'), false);

	const trailing = globToRegExp('docs/**');
	assert.equal(trailing.test('docs/a/b/c.md'), true);
	assert.equal(trailing.test('doc/a.md'), false);

	const q = globToRegExp('a?c');
	assert.equal(q.test('abc'), true);
	assert.equal(q.test('ac'), false);
	assert.equal(q.test('abbc'), false);

	assert.equal(globToRegExp('A.md').test('a.md'), false);
	assert.equal(globToRegExp('A.md', true).test('a.md'), true);
	assert.equal(globToRegExp('A.md').flags, '');
	assert.equal(globToRegExp('A.md', true).flags, 'i');
	// Windows separators are normalised to '/'
	assert.equal(globToRegExp('a\\b.md').test('a/b.md'), true);
});

// ── resolveExactWorkspacePath ────────────────────────────────────────────────

test('resolveExactWorkspacePath: case sensitivity, nested segments, files-as-dirs', () => {
	withTmp(dir => {
		write(path.join(dir, '.GitHub', 'Agents', 'Foo.md'));
		assert.equal(resolveExactWorkspacePath(dir, '.GitHub/Agents/Foo.md', false), path.join(dir, '.GitHub', 'Agents', 'Foo.md'));
		// case-insensitive lookup resolves each segment to its real casing
		if (!fs.existsSync(path.join(dir, '.github', 'agents', 'foo.md'))) { // case-sensitive filesystem
			assert.equal(resolveExactWorkspacePath(dir, '.github/agents/foo.md', true), path.join(dir, '.GitHub', 'Agents', 'Foo.md'));
			// '.' segments are skipped
			assert.equal(resolveExactWorkspacePath(dir, './.github/./agents/foo.md', true), path.join(dir, '.GitHub', 'Agents', 'Foo.md'));
			assert.equal(resolveExactWorkspacePath(dir, '.github/agents/foo.md', false), undefined);
		}
		// when case-sensitive, wrong case is not found (on case-sensitive FS) or found directly
		assert.equal(resolveExactWorkspacePath(dir, 'missing/foo.md', true), undefined);
		assert.equal(resolveExactWorkspacePath(dir, 'missing/foo.md', false), undefined);
		// intermediate segment that is a file is rejected
		write(path.join(dir, 'Afile'), 'x');
		assert.equal(resolveExactWorkspacePath(dir, 'afile/child.md', true), undefined);
		assert.equal(resolveExactWorkspacePath(dir, 'Afile', true), path.join(dir, 'Afile'));
		// a last segment that is a file is accepted
		if (!fs.existsSync(path.join(dir, 'AFILE'))) { assert.equal(resolveExactWorkspacePath(dir, 'AFILE', true), path.join(dir, 'Afile')); }
		// intermediate directories with wrong child
		assert.equal(resolveExactWorkspacePath(dir, '.github/agents/nope.md', true), undefined);
	});
});

// ── scanWorkspaceCustomizationFiles: fallbacks and scan modes ───────────────

type Patterns = { patterns?: Array<Record<string, unknown>>; stalenessThresholdDays?: unknown; excludeDirs?: unknown };

function withPatterns<T>(patterns: Array<Record<string, unknown>>, fn: () => T, extra: Partial<Patterns> = {}): T {
	const cfg = customizationPatternsData as unknown as Patterns;
	const saved = { patterns: cfg.patterns, stalenessThresholdDays: cfg.stalenessThresholdDays, excludeDirs: cfg.excludeDirs };
	cfg.patterns = patterns;
	Object.assign(cfg, extra);
	try { return fn(); } finally {
		cfg.patterns = saved.patterns;
		cfg.stalenessThresholdDays = saved.stalenessThresholdDays;
		cfg.excludeDirs = saved.excludeDirs;
	}
}

test('scan: pattern without icon/label/type falls back to "", file name and "unknown"', () => {
	withTmp(dir => {
		write(path.join(dir, 'a.txt'));
		const res = withPatterns([{ path: 'a.txt', scanMode: 'exact' }], () => scanWorkspaceCustomizationFiles(dir));
		assert.equal(res.length, 1);
		assert.equal(res[0].icon, '');
		assert.equal(res[0].label, 'a.txt');
		assert.equal(res[0].type, 'unknown');
		assert.equal(res[0].name, 'a.txt');
		assert.equal(res[0].relativePath, 'a.txt');
		assert.equal(res[0].category, undefined);
	});
});

test('scan: empty-string icon and label are kept (nullish, not falsy, fallback)', () => {
	withTmp(dir => {
		write(path.join(dir, 'a.txt'));
		const res = withPatterns([{ path: 'a.txt', icon: '', label: '', type: 'x' }], () => scanWorkspaceCustomizationFiles(dir));
		assert.equal(res[0].icon, '');
		assert.equal(res[0].label, '');
		assert.equal(res[0].type, 'x');
	});
});

test('scan: scanMode defaults to exact and unknown modes yield nothing', () => {
	withTmp(dir => {
		write(path.join(dir, 'a.txt'));
		assert.equal(withPatterns([{ path: 'a.txt' }], () => scanWorkspaceCustomizationFiles(dir)).length, 1);
		assert.equal(withPatterns([{ path: 'a.txt', scanMode: 'bogus' }], () => scanWorkspaceCustomizationFiles(dir)).length, 0);
	});
});

test('scan: stalenessThresholdDays comes from config when numeric, else defaults to 90', () => {
	withTmp(dir => {
		const f = path.join(dir, 'a.txt');
		write(f);
		const old = new Date(Date.now() - 10 * 24 * 3600 * 1000);
		fs.utimesSync(f, old, old);
		const p = [{ path: 'a.txt' }];
		assert.equal(withPatterns(p, () => scanWorkspaceCustomizationFiles(dir)[0].isStale, { stalenessThresholdDays: 9 }), true);
		assert.equal(withPatterns(p, () => scanWorkspaceCustomizationFiles(dir)[0].isStale, { stalenessThresholdDays: 11 }), false);
		assert.equal(withPatterns(p, () => scanWorkspaceCustomizationFiles(dir)[0].isStale, { stalenessThresholdDays: '9' }), false);
	});
});

test('scan: invalid workspace inputs return []', () => {
	assert.deepEqual(scanWorkspaceCustomizationFiles(''), []);
	assert.deepEqual(scanWorkspaceCustomizationFiles(path.join(os.tmpdir(), 'wh-does-not-exist-xyz')), []);
	withTmp(dir => {
		const file = path.join(dir, 'f');
		write(file);
		assert.deepEqual(scanWorkspaceCustomizationFiles(file), []);
	});
});

test('scan oneLevel: skill display name is the folder, excluded dirs and non-files skipped', () => {
	withTmp(dir => {
		write(path.join(dir, 'skills', 'alpha', 'SKILL.md'));
		write(path.join(dir, 'skills', 'node_modules', 'SKILL.md'));
		fs.mkdirSync(path.join(dir, 'skills', 'beta', 'SKILL.md'), { recursive: true }); // dir, not a file
		fs.mkdirSync(path.join(dir, 'skills', 'gamma'), { recursive: true }); // no candidate
		const run = (type: string) => withPatterns(
			[{ path: 'skills/*/SKILL.md', scanMode: 'oneLevel', type }],
			() => scanWorkspaceCustomizationFiles(dir),
			{ excludeDirs: ['node_modules'] }
		);
		const skill = run('skill');
		assert.deepEqual(skill.map(s => s.name), ['alpha']);
		assert.equal(skill[0].label, 'alpha');
		assert.equal(skill[0].relativePath, 'skills/alpha/SKILL.md');
		const other = run('agent');
		assert.deepEqual(other.map(s => s.name), ['SKILL.md']);
		// without excludeDirs array the excluded dir is included
		const notExcluded = withPatterns([{ path: 'skills/*/SKILL.md', scanMode: 'oneLevel', type: 'skill' }], () => scanWorkspaceCustomizationFiles(dir), { excludeDirs: 'nope' });
		assert.deepEqual(notExcluded.map(s => s.name).sort(), ['alpha', 'node_modules']);
	});
});

test('scan oneLevel: no star, missing base dir, root-level star and trailing suffix', () => {
	withTmp(dir => {
		write(path.join(dir, 'one', 'x.md'));
		const scan = (p: string) => withPatterns([{ path: p, scanMode: 'oneLevel' }], () => scanWorkspaceCustomizationFiles(dir));
		assert.deepEqual(scan('nostar.md'), []);
		assert.deepEqual(scan('missing/*/x.md'), []);
		assert.deepEqual(scan('*/x.md').map(e => e.relativePath), ['one/x.md']);
		// base path is a file, not a directory
		write(path.join(dir, 'afile'));
		assert.deepEqual(scan('afile/*/x.md'), []);
	});
});

test('scan recursive: maxDepth boundary, default depth 6, excludeDirs, regex match', () => {
	withTmp(dir => {
		write(path.join(dir, 'a.md'));
		write(path.join(dir, 'd1', 'b.md'));
		write(path.join(dir, 'd1', 'd2', 'c.md'));
		write(path.join(dir, 'd1', 'd2', 'd3', 'd.md'));
		write(path.join(dir, 'node_modules', 'e.md'));
		const rec = (extra: Record<string, unknown>) => withPatterns(
			[{ path: '**/*.md', scanMode: 'recursive', ...extra }],
			() => scanWorkspaceCustomizationFiles(dir).map(e => e.relativePath).sort(),
			{ excludeDirs: ['node_modules'] }
		);
		assert.deepEqual(rec({ maxDepth: 0 }), ['a.md']);
		assert.deepEqual(rec({ maxDepth: 1 }), ['a.md', 'd1/b.md']);
		assert.deepEqual(rec({ maxDepth: 2 }), ['a.md', 'd1/b.md', 'd1/d2/c.md']);
		assert.deepEqual(rec({ maxDepth: 3 }), ['a.md', 'd1/b.md', 'd1/d2/c.md', 'd1/d2/d3/d.md']);
		assert.deepEqual(rec({}), ['a.md', 'd1/b.md', 'd1/d2/c.md', 'd1/d2/d3/d.md']);
		assert.deepEqual(rec({ maxDepth: '1' }), ['a.md', 'd1/b.md', 'd1/d2/c.md', 'd1/d2/d3/d.md']);
		// case-insensitive flag
		write(path.join(dir, 'UP.MD'));
		assert.equal(rec({ maxDepth: 0 }).includes('UP.MD'), false);
		assert.equal(rec({ maxDepth: 0, caseInsensitive: true }).includes('UP.MD'), true);
	});
});

test('scan recursive: default depth of 6 includes level 6 and excludes level 7', () => {
	withTmp(dir => {
		let p = dir;
		for (let i = 1; i <= 7; i++) { p = path.join(p, `l${i}`); write(path.join(p, `f${i}.md`)); }
		const found = withPatterns([{ path: '**/*.md', scanMode: 'recursive' }], () => scanWorkspaceCustomizationFiles(dir).map(e => e.name).sort());
		assert.deepEqual(found, ['f1.md', 'f2.md', 'f3.md', 'f4.md', 'f5.md', 'f6.md']);
	});
});

test('scan: duplicate matches across patterns are deduplicated by path', () => {
	withTmp(dir => {
		write(path.join(dir, 'a.txt'));
		const res = withPatterns([{ path: 'a.txt', label: 'first' }, { path: 'a.txt', label: 'second' }], () => scanWorkspaceCustomizationFiles(dir));
		assert.equal(res.length, 1);
		assert.equal(res[0].label, 'second');
	});
});

// ── debug log candidates ─────────────────────────────────────────────────────

test('resolveDebugLogCandidatePaths: exact paths and ordering', () => {
	const id = '12345678-1234-1234-1234-123456789abc';
	const ws = path.join('/home', 'u', 'workspaceStorage', 'hash1');
	const res = resolveDebugLogCandidatePaths(`${ws}/chatSessions/${id}.json`);
	assert.deepEqual(res, ['GitHub.copilot-chat', 'github.copilot-chat', 'GitHub.copilot', 'github.copilot']
		.map(f => path.join(ws, f, 'debug-logs', id, 'main.jsonl')));
	// uppercase UUID is accepted
	assert.ok(resolveDebugLogCandidatePaths(`${ws}/chatSessions/${id.toUpperCase()}.json`));
	// UUID with extra chars on either side is rejected (anchors)
	assert.equal(resolveDebugLogCandidatePaths(`${ws}/chatSessions/x${id}.json`), undefined);
	assert.equal(resolveDebugLogCandidatePaths(`${ws}/chatSessions/${id}0.json`), undefined);
	assert.equal(resolveDebugLogCandidatePaths(`${ws}/chatSessions/${id.slice(0, -1)}.json`), undefined);
	// workspaceStorage must be followed by a hash folder and a further segment
	assert.equal(resolveDebugLogCandidatePaths(`/home/u/workspaceStorage/${id}.json`), undefined);
	assert.equal(resolveDebugLogCandidatePaths(`/home/u/xworkspaceStorage/h/${id}.json`), undefined);
	// session file directly under the hash dir
	assert.deepEqual(resolveDebugLogCandidatePaths(`/home/u/workspaceStorage/h/${id}.json`)?.[0],
		path.join('/home/u/workspaceStorage/h', 'GitHub.copilot-chat', 'debug-logs', id, 'main.jsonl'));
});

// ── mode helpers ─────────────────────────────────────────────────────────────

test('getModeType: every branch', () => {
	assert.equal(getModeType(undefined), 'ask');
	assert.equal(getModeType(null), 'ask');
	assert.equal(getModeType(''), 'ask');
	assert.equal(getModeType('edit'), 'edit');
	assert.equal(getModeType('agent'), 'agent');
	assert.equal(getModeType('other'), 'ask');
	assert.equal(getModeType({} as never), 'ask');
	assert.equal(getModeType({ kind: 'edit' } as never), 'edit');
	assert.equal(getModeType({ kind: 'ask' } as never), 'ask');
	assert.equal(getModeType({ kind: 'weird' } as never), 'ask');
	assert.equal(getModeType({ kind: 'agent' } as never), 'agent');
	assert.equal(getModeType({ kind: 'agent', id: 'agent' } as never), 'agent');
	assert.equal(getModeType({ kind: 'agent', id: 'file:///x/plan-agent/Plan.agent.md' } as never), 'plan');
	assert.equal(getModeType({ kind: 'agent', id: 'file:///x/My.agent.md' } as never), 'customAgent');
	assert.equal(getModeType({ kind: 'agent', id: 'something-else' } as never), 'agent');
});

test('extractCustomAgentName: extensions, URIs and invalid input', () => {
	assert.equal(extractCustomAgentName(''), null);
	assert.equal(extractCustomAgentName('foo.md'), null);
	assert.equal(extractCustomAgentName('/x/My.agent.md'), 'My');
	assert.equal(extractCustomAgentName('/x/A.agent.md'), 'A');
	assert.equal(extractCustomAgentName('file:///x/Cool.agent.md'), 'Cool');
	assert.equal(extractCustomAgentName('/x/TestEngineerAgent.md.agent.md'), 'TestEngineerAgent.md'); // the .md.agent.md branch is unreachable (equivalent)
	assert.equal(extractCustomAgentName('/x/a.agent.md.bak'), null);
});

// ── editor detection ─────────────────────────────────────────────────────────

test('getEditorNameFromRoot: marker priorities and negatives', () => {
	const cases: Array<[string, string]> = [
		['', 'Unknown'],
		['/x/com.microsoft.copilot.eclipse.core', 'Eclipse'],
		['/home/u/.devin', 'Devin'],
		['/opt/devin-desktop', 'Devin'],
		['/home/u/.local/share/devin/cli', 'Devin CLI'],
		['/home/u/.copilot/jb', 'JetBrains'],
		['/home/u/.copilot', 'Copilot CLI'],
		['/home/u/copilot', 'Copilot CLI'],
		['/home/u/.config/Code/User/globalStorage/saoudrizwan.claude-dev', 'Cline'],
		['/home/u/.local/share/opencode', 'OpenCode'],
		['/home/u/.local/share/kilo', 'Kilo Code'],
		['/home/u/.local/share/kilobyte', 'Unknown'],
		['/home/u/.hermes', 'Hermes'],
		['/home/u/.codex', 'Codex CLI'],
		['/home/u/.kiro', 'Kiro CLI'],
		['/home/u/.config/kiro/user/', 'Kiro'],
		['/home/u/.config/kiro', 'Kiro'],
		['/x/kiro.kiroagent', 'Kiro'],
		['/home/u/.continue', 'Continue'],
		['/home/u/.vibe', 'Mistral Vibe'],
		['/home/u/.gemini/antigravity', 'Antigravity'],
		['/home/u/.gemini', 'Gemini CLI'],
		['/home/u/.pi/agent', 'Pi'],
		['/AppData/Roaming/Code - Insiders', 'VS Code Insiders'],
		['/AppData/Roaming/Code-Insiders', 'VS Code Insiders'],
		['/AppData/Roaming/Code - Exploration', 'VS Code Exploration'],
		['/AppData/Roaming/Code%20-%20Exploration', 'VS Code Exploration'],
		['/AppData/Roaming/VSCodium', 'VSCodium'],
		['/AppData/Roaming/Cursor', 'Cursor'],
		['/Users/u/.vs/proj/copilot-chat', 'Copilot CLI'],
		['C:\\Users\\u\\AppData\\Roaming\\Code', 'VS Code'],
		['/home/u/.config/Code/User', 'VS Code'],
		['/home/u/.config/Codex', 'Unknown'],
		['/home/u/.config/Code/', 'VS Code'],
		['/home/u/.config/other', 'Unknown'],
	];
	for (const [input, expected] of cases) {
		assert.equal(getEditorNameFromRoot(input), expected, `root ${input}`);
	}
	assert.equal(getEditorNameFromRoot('/x/.vs/solution'), 'Unknown');
});

test('getEditorTypeFromPath: path markers', () => {
	const cases: Array<[string, string]> = [
		['devin://trajectory/1', 'Devin'],
		['windsurf://x/1', 'Windsurf'],
		['/x/com.microsoft.copilot.eclipse/y', 'Eclipse'],
		['/home/u/.copilot/jb/s/1', 'JetBrains'],
		['/home/u/.copilot/session-store.db#abc', 'Copilot CLI'],
		['/home/u/.copilot/session-state/abc/events.jsonl', 'Copilot CLI'],
		['/home/u/.crush/crush.db#1', 'Crush'],
		['/home/u/.local/share/kilo/kilo.db#ses_1', 'Kilo Code'],
		['/home/u/.hermes/hermes/state.db#1', 'Hermes'],
		['/home/u/devin/cli/sessions.db#1', 'Devin CLI'],
		['/home/u/.codex/sessions/a.jsonl', 'Codex CLI'],
		['/home/u/.config/Cursor/User/globalStorage/state.vscdb#x', 'Cursor'],
		['/home/u/.pi/agent/sessions/a.jsonl', 'Pi'],
		['/home/u/.kiro/sessions/cli/a.jsonl', 'Kiro CLI'],
		['/home/u/x/kiro.kiroagent/workspace-sessions/a.json', 'Kiro'],
		['/home/u/.config/Code/User/globalStorage/saoudrizwan.claude-dev/tasks/1/a.json', 'Cline'],
		['/home/u/.continue/sessions/a.json', 'Continue'],
		['/home/u/claude-code-sessions/a.json', 'Claude Desktop Cowork'],
		['/home/u/local-agent-mode-sessions/a.json', 'Claude Desktop Cowork'],
		['/home/u/.vibe/logs/session/a.json', 'Mistral Vibe'],
		['/home/u/.gemini/antigravity/brain/a.pb', 'Antigravity'],
		['/home/u/.gemini/tmp/h/chats/session-1.jsonl', 'Gemini CLI'],
		['/home/u/.gemini/tmp/h/chats/session-1.json', 'Unknown'],
		['/home/u/.gemini/tmp/h/chats/other.jsonl', 'Unknown'],
		['/home/u/.gemini/h/chats/session-1.jsonl', 'Unknown'],
		['/home/u/.config/Code - Insiders/User/a.json', 'VS Code Insiders'],
		['/home/u/.config/Code%20-%20Insiders/User/a.json', 'VS Code Insiders'],
		['/home/u/.config/Code - Exploration/User/a.json', 'VS Code Exploration'],
		['/home/u/.config/Code%20-%20Exploration/User/a.json', 'VS Code Exploration'],
		['/home/u/.config/VSCodium/User/a.json', 'VSCodium'],
		['/home/u/.config/Cursor/User/a.json', 'Cursor'],
		['/home/u/.vscode-server-insiders/data/a.json', 'VS Code Server (Insiders)'],
		['/home/u/.vscode-server/data/a.json', 'VS Code Server'],
		['/home/u/.vscode-remote/data/a.json', 'VS Code Server'],
		['/x/SSMS/1/SSMSGitHubCopilot/copilot-chat/h/sessions/a', 'SSMS'],
		['/x/sol/.vs/copilot-chat/h/sessions/a', 'Visual Studio'],
		['/x/vsgithubcopilot/copilot-chat/h/sessions/a', 'Visual Studio'],
		['/x/sol/.vs/copilot-chat/h/other/a', 'Unknown'],
		['/x/sol/.vs/h/sessions/a', 'Unknown'],
		['/x/copilot-chat/h/sessions/a', 'Unknown'],
		['/home/u/.config/Code/User/workspaceStorage/h/a.json', 'VS Code'],
		['/home/u/other/a.json', 'Unknown'],
	];
	for (const [input, expected] of cases) {
		assert.equal(getEditorTypeFromPath(input), expected, `path ${input}`);
	}
	assert.equal(getEditorTypeFromPath('/anything/a.db', p => p === '/anything/a.db'), 'OpenCode');
	assert.equal(getEditorTypeFromPath('/anything/b.db', p => p === '/anything/a.db'), 'Unknown');
});

test('detectEditorSource: loose substring matching', () => {
	const cases: Array<[string, string]> = [
		['devin://x', 'Devin'],
		['windsurf://x', 'Windsurf'],
		['/x/com.microsoft.copilot.eclipse/y', 'Eclipse'],
		['/home/u/.copilot/jb/s', 'JetBrains'],
		['/x/Cursor/a', 'Cursor'],
		['/x/Code - Insiders/a', 'VS Code Insiders'],
		['/x/code-insiders/a', 'VS Code Insiders'],
		['/x/vscodium/a', 'VSCodium'],
		['/x/.devin/a', 'Devin'],
		['/x/windsurf/a', 'Windsurf'],
		['/x/SSMSGitHubCopilot/copilot-chat/h/sessions/a', 'SSMS'],
		['/x/.vs/copilot-chat/h/sessions/a', 'Visual Studio'],
		['/x/Code/a', 'VS Code'],
		['/x/other/a', 'Unknown'],
	];
	for (const [input, expected] of cases) {
		assert.equal(detectEditorSource(input), expected, `source ${input}`);
	}
	assert.equal(detectEditorSource('/q/a.db', () => true), 'OpenCode');
});

test('detectRelocatedAgentHomeFromPath: codex, vibe and hermes homes', () => {
	assert.equal(detectRelocatedAgentHomeFromPath('/data/cx/sessions/a.jsonl', { CODEX_HOME: '/data/cx' }), 'Codex CLI');
	assert.equal(detectRelocatedAgentHomeFromPath('/data/cx/archived_sessions/a.jsonl', { CODEX_HOME: '/data/cx' }), 'Codex CLI');
	assert.equal(detectRelocatedAgentHomeFromPath('/data/cx/state_5.sqlite#abc', { CODEX_HOME: '/data/cx' }), 'Codex CLI');
	assert.equal(detectRelocatedAgentHomeFromPath('/data/cx/state_x.sqlite#abc', { CODEX_HOME: '/data/cx' }), undefined);
	assert.equal(detectRelocatedAgentHomeFromPath('/data/cx/other/a.jsonl', { CODEX_HOME: '/data/cx' }), undefined);
	assert.equal(detectRelocatedAgentHomeFromPath('/data/cx/sessions/a.jsonl', { CODEX_HOME: '   ' }), undefined);
	assert.equal(detectRelocatedAgentHomeFromPath('/data/cx/sessions/a.jsonl', { CODEX_HOME: '' }), undefined);
	assert.equal(detectRelocatedAgentHomeFromPath('/data/cx2/sessions/a.jsonl', { CODEX_HOME: '/data/cx' }), undefined);
	const vibe = path.resolve('/data/vibe').replace(/\\/g, '/').toLowerCase();
	assert.equal(detectRelocatedAgentHomeFromPath(`${vibe}/logs/session/a.json`, { VIBE_HOME: '/data/vibe' }), 'Mistral Vibe');
	assert.equal(detectRelocatedAgentHomeFromPath(`${vibe}/logs/other/a.json`, { VIBE_HOME: '/data/vibe' }), undefined);
	assert.equal(detectRelocatedAgentHomeFromPath(`${vibe}/logs/session/a.json`, {}), undefined);
	assert.equal(detectRelocatedAgentHomeFromPath('/data/hm/state.db#abc', { HERMES_HOME: '/data/hm' }), 'Hermes');
	assert.equal(detectRelocatedAgentHomeFromPath('/data/hm/state.db/abc', { HERMES_HOME: '/data/hm' }), undefined);
	assert.equal(detectRelocatedAgentHomeFromPath('/data/hm/state.db#abc', { HERMES_HOME: ' ' }), undefined);
	assert.equal(detectRelocatedAgentHomeFromPath('/data/hm/state.db#abc', {}), undefined);
});

test('refineEditorLabelForInteractionModeSplit: labels and workspace.yaml marker', () => {
	assert.equal(refineEditorLabelForInteractionModeSplit('/x/a.jsonl', 'Claude Code'), 'Claude (VS Code)');
	assert.equal(refineEditorLabelForInteractionModeSplit('/x/a.jsonl', 'Cursor'), 'Cursor');
	assert.equal(refineEditorLabelForInteractionModeSplit('/nonexistent/a.jsonl', 'Copilot CLI'), 'Copilot CLI');
	withTmp(dir => {
		const file = path.join(dir, 'events.jsonl');
		write(file);
		write(path.join(dir, 'workspace.yaml'), 'id: 1\nclient_name: github/autopilot\n');
		assert.equal(refineEditorLabelForInteractionModeSplit(file, 'Copilot CLI'), 'Copilot App');
		assert.equal(refineEditorLabelForInteractionModeSplit(file, 'Cursor'), 'Cursor');
		write(path.join(dir, 'workspace.yaml'), 'client_name: something-else\n');
		assert.equal(refineEditorLabelForInteractionModeSplit(file, 'Copilot CLI'), 'Copilot CLI');
		write(path.join(dir, 'workspace.yaml'), 'id: 1\n');
		assert.equal(refineEditorLabelForInteractionModeSplit(file, 'Copilot CLI'), 'Copilot CLI');
	});
});

// ── repo URL helpers ─────────────────────────────────────────────────────────

test('getRepoDisplayName: URL shapes', () => {
	assert.equal(getRepoDisplayName(''), 'Unknown');
	assert.equal(getRepoDisplayName('Unknown'), 'Unknown');
	assert.equal(getRepoDisplayName('git@github.com:owner/repo.git'), 'owner/repo');
	assert.equal(getRepoDisplayName('git@github.com:owner/repo'), 'owner/repo');
	assert.equal(getRepoDisplayName('https://github.com/owner/repo.git'), 'owner/repo');
	assert.equal(getRepoDisplayName('https://github.com/a/b/owner/repo'), 'owner/repo');
	assert.equal(getRepoDisplayName('https://github.com/solo'), 'solo');
	assert.equal(getRepoDisplayName('https://github.com/'), '');
	assert.equal(getRepoDisplayName('git://host/owner/repo'), 'owner/repo');
	assert.equal(getRepoDisplayName('/local/path/owner/repo'), 'owner/repo');
	assert.equal(getRepoDisplayName('repo'), 'repo');
	assert.equal(getRepoDisplayName('a/repo.git'), 'a/repo');
	assert.equal(getRepoDisplayName('a.git.git'), 'a.git');
});

test('parseGitRemoteUrl: sections, trimming, case', () => {
	const cfg = '[core]\n\turl = nope\n[remote "origin"]\n\turl = https://x/y.git  \n\tfetch = +refs\n[remote "upstream"]\n\turl = https://u/v\n';
	assert.equal(parseGitRemoteUrl(cfg), 'https://x/y.git');
	assert.equal(parseGitRemoteUrl('[remote "upstream"]\nurl = https://u/v\n'), undefined);
	assert.equal(parseGitRemoteUrl('[remote "origin"]\nfetch = x\n[remote "other"]\nurl = https://u/v\n'), undefined);
	assert.equal(parseGitRemoteUrl('[REMOTE  "origin"]\nURL=https://a/b\n'), 'https://a/b');
	assert.equal(parseGitRemoteUrl('url = https://a/b\n'), undefined);
	assert.equal(parseGitRemoteUrl('  [remote "origin"]  \r\n  url = https://a/b\r\n'), 'https://a/b');
	assert.equal(parseGitRemoteUrl('[remote "origin"]\n#url = https://a/b\n'), undefined);
	assert.equal(parseGitRemoteUrl(''), undefined);
});

// ── MCP helpers ──────────────────────────────────────────────────────────────

test('normalizeMcpToolName: every prefix rule and passthrough', () => {
	const rules: Array<[string, string]> = [
		['mcp_github_github_x', 'mcp_io_github_git_x'],
		['github-mcp-server-x', 'mcp_io_github_git_x'],
		['mcp_github_mcp_s2_x', 'mcp_io_github_git_x'],
		['mcp_github_mcp_se_x', 'mcp_io_github_git_x'],
		['mcp.github.github.x', 'mcp.io.github.git.x'],
		['mcp__plugin_context7_context7__x', 'context7-x'],
		['mcp__context7__x', 'context7-x'],
		['mcp_context7_x', 'context7-x'],
		['mcp_io_github_ups_x', 'context7-x'],
		['mcp__microsoft_playwright-mcp__x', 'microsoft_playwright-mcp-x'],
		['mcp__playwright__x', 'microsoft_playwright-mcp-x'],
		['mcp_playwright_x', 'microsoft_playwright-mcp-x'],
		['mcp_microsoft_pla_x', 'microsoft_playwright-mcp-x'],
		['mcp_tavily-mcp_x', 'io_github_tavily-ai_tavily-mcp-x'],
		['mcp_tavily_x', 'io_github_tavily-ai_tavily-mcp-x'],
		['mcp__claude-in-chrome__x', 'mcp__claude_browser__x'],
		['mcp__Claude_Browser__x', 'mcp__claude_browser__x'],
		['unrelated_tool', 'unrelated_tool'],
		['xmcp__playwright__x', 'xmcp__playwright__x'],
	];
	for (const [input, expected] of rules) { assert.equal(normalizeMcpToolName(input), expected, input); }
});

test('extractMcpServerName: fallbacks, double-underscore and generic forms', () => {
	assert.equal(extractMcpServerName('mcp_io_github_git_zzz_unlisted'), 'GitHub MCP (Local)');
	assert.equal(extractMcpServerName('mcp.io.github.git.zzz_unlisted'), 'GitHub MCP (Local)');
	assert.equal(extractMcpServerName('mcp_github_github_zzz_unlisted'), 'GitHub MCP (Remote)');
	assert.equal(extractMcpServerName('mcp.github.github.zzz_unlisted'), 'GitHub MCP (Remote)');
	assert.equal(extractMcpServerName('mcp__github__create_issue'), 'github');
	assert.equal(extractMcpServerName('mcp__solo'), 'solo');
	assert.equal(extractMcpServerName('mcp____tool'), 'unknown');
	assert.equal(extractMcpServerName('mcp__'), 'unknown');
	assert.equal(extractMcpServerName('mcp_myserver_do_thing_zzz'), 'myserver');
	assert.equal(extractMcpServerName('mcp.myserver.do_thing_zzz'), 'myserver');
	assert.equal(extractMcpServerName('mcp_'), 'unknown');
	assert.equal(extractMcpServerName('plain_zzz'), 'plain');
	assert.equal(extractMcpServerName('x', { x: 'Server A: Tool' }), 'Server A');
	assert.equal(extractMcpServerName('mcp_q_zzz', { mcp_q_zzz: 'NoColon' }), 'q');
});

// ── code-workspace + workspace folder resolution ────────────────────────────

test('parseCodeWorkspaceFolders: validation branches and relative path resolution', () => {
	withTmp(dir => {
		const abs = path.join(dir, 'abs');
		fs.mkdirSync(abs);
		fs.mkdirSync(path.join(dir, 'rel'));
		const file = path.join(dir, 'x.code-workspace');
		fs.writeFileSync(file, JSON.stringify({ folders: [{ path: abs }, { path: 'rel' }, { uri: 'vscode://nope' }, { name: 'n' }, 5, null] }));
		assert.deepEqual(parseCodeWorkspaceFolders(file), [fs.realpathSync.native(abs), fs.realpathSync.native(path.join(dir, 'rel'))]);
		const missingDir = path.join(dir, 'ghost');
		fs.writeFileSync(file, JSON.stringify({ folders: [{ path: missingDir }] }));
		assert.deepEqual(parseCodeWorkspaceFolders(file), [missingDir]);
		fs.writeFileSync(file, '{"folders": {}}');
		assert.deepEqual(parseCodeWorkspaceFolders(file), []);
		fs.writeFileSync(file, 'null');
		assert.deepEqual(parseCodeWorkspaceFolders(file), []);
		fs.writeFileSync(file, '[1]');
		assert.deepEqual(parseCodeWorkspaceFolders(file), []);
		fs.writeFileSync(file, '{bad');
		assert.deepEqual(parseCodeWorkspaceFolders(file), []);
		assert.deepEqual(parseCodeWorkspaceFolders(path.join(dir, 'y.json')), []);
		assert.deepEqual(parseCodeWorkspaceFolders(path.join(dir, 'nope.code-workspace')), []);
		assert.deepEqual(parseCodeWorkspaceFolders(''), []);
	});
});

test('resolveWorkspaceFolderFromSessionPath: workspace.json vs meta.json, caching, negatives', () => {
	withTmp(dir => {
		const target = path.join(dir, 'proj');
		fs.mkdirSync(target);
		const storage = path.join(dir, 'User', 'workspaceStorage');
		const wsA = path.join(storage, 'aaa');
		write(path.join(wsA, 'workspace.json'), JSON.stringify({ folder: `file:///${target.replace(/\\/g, '/')}` }));
		write(path.join(wsA, 'chatSessions', 's.json'));
		const cache = new Map<string, string | undefined>();
		const real = fs.realpathSync.native(target);
		assert.equal(resolveWorkspaceFolderFromSessionPath(path.join(wsA, 'chatSessions', 's.json'), cache), real);
		assert.equal(cache.get('aaa'), real);
		// cache is honoured even if the file is removed
		fs.rmSync(path.join(wsA, 'workspace.json'));
		assert.equal(resolveWorkspaceFolderFromSessionPath(path.join(wsA, 'chatSessions', 's.json'), cache), real);

		// meta.json only
		const wsB = path.join(storage, 'bbb');
		write(path.join(wsB, 'meta.json'), JSON.stringify({ folder: `file:///${target.replace(/\\/g, '/')}` }));
		const cacheB = new Map<string, string | undefined>();
		assert.equal(resolveWorkspaceFolderFromSessionPath(path.join(wsB, 's.json'), cacheB), real);

		// neither json -> undefined and cached as undefined
		const wsC = path.join(storage, 'ccc');
		write(path.join(wsC, 's.json'));
		const cacheC = new Map<string, string | undefined>();
		assert.equal(resolveWorkspaceFolderFromSessionPath(path.join(wsC, 's.json'), cacheC), undefined);
		assert.equal(cacheC.has('ccc'), true);
		assert.equal(cacheC.get('ccc'), undefined);

		// case-insensitive marker, and not workspace-scoped -> not cached
		const cacheD = new Map<string, string | undefined>();
		assert.equal(resolveWorkspaceFolderFromSessionPath(path.join(dir, 'other', 's.json'), cacheD), undefined);
		assert.equal(cacheD.size, 0);
		assert.equal(resolveWorkspaceFolderFromSessionPath(storage, cacheD), undefined);
		assert.equal(cacheD.size, 0);
	});
});

test('resolveWorkspaceFolderWithFallback / resolveSessionWorkspaceName precedence', () => {
	const cache = new Map<string, string | undefined>();
	assert.equal(resolveWorkspaceFolderWithFallback('/x/y.json', cache, '/fallback'), '/fallback');
	assert.equal(resolveWorkspaceFolderWithFallback('/x/y.json', cache), undefined);
	assert.equal(resolveSessionWorkspaceName({ workspaceFolderPath: '/a/b/proj', repository: 'o/r' }, '/x/y.json'), 'proj');
	assert.equal(resolveSessionWorkspaceName({ repository: 'o/r' }, '/x/y.json', cache), 'o/r');
	assert.equal(resolveSessionWorkspaceName({}, '/x/y.json'), undefined);
	assert.equal(resolveSessionWorkspaceName({}, '/x/y.json', cache), undefined);
	withTmp(dir => {
		const target = path.join(dir, 'myproj');
		fs.mkdirSync(target);
		const ws = path.join(dir, 'workspaceStorage', 'h1');
		write(path.join(ws, 'workspace.json'), JSON.stringify({ folder: `file:///${target.replace(/\\/g, '/')}` }));
		assert.equal(resolveSessionWorkspaceName({}, path.join(ws, 's.json'), new Map()), 'myproj');
	});
});

// ── git remote discovery ─────────────────────────────────────────────────────

test('findRepositoryRemoteForFolder / extractRepositoryFromContentReferences', async () => {
	await withTmpAsync(async dir => {
		const repo = path.join(dir, 'repo');
		write(path.join(repo, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/o/r.git\n');
		write(path.join(repo, 'src', 'deep', 'f.ts'));
		assert.equal(await findRepositoryRemoteForFolder(repo), 'https://github.com/o/r.git');
		assert.equal(await findRepositoryRemoteForFolder(repo + path.sep), 'https://github.com/o/r.git');
		assert.equal(await findRepositoryRemoteForFolder(path.join(repo, 'src', 'deep')), 'https://github.com/o/r.git');
		// nested repository without origin does not borrow the outer one
		write(path.join(repo, 'nested', '.git', 'config'), '[core]\n');
		assert.equal(await findRepositoryRemoteForFolder(path.join(repo, 'nested')), undefined);

		const fsPath = path.join(repo, 'src', 'deep', 'f.ts');
		assert.equal(await extractRepositoryFromContentReferences([{ kind: 'reference', reference: { fsPath } }] as never), 'https://github.com/o/r.git');
		assert.equal(await extractRepositoryFromContentReferences([{ kind: 'inlineReference', inlineReference: { path: fsPath } }] as never), 'https://github.com/o/r.git');
		assert.equal(await extractRepositoryFromContentReferences([{ kind: 'other', reference: { fsPath } }] as never), undefined);
		assert.equal(await extractRepositoryFromContentReferences([{ kind: 'reference', reference: { fsPath: '' } }] as never), undefined);
		assert.equal(await extractRepositoryFromContentReferences([null, 'x', { kind: 'reference' }] as never), undefined);
		assert.equal(await extractRepositoryFromContentReferences([] as never), undefined);
		assert.equal(await extractRepositoryFromContentReferences(undefined as never), undefined);
	});
});

test('extractRepositoryFromContentReferences: git worktree pointer resolves via main repo config', async () => {
	await withTmpAsync(async dir => {
		const main = path.join(dir, 'main');
		write(path.join(main, '.git', 'config'), '[remote "origin"]\nurl = https://github.com/w/t.git\n');
		fs.mkdirSync(path.join(main, '.git', 'worktrees', 'wt'), { recursive: true });
		const wt = path.join(dir, 'wt');
		write(path.join(wt, '.git'), `gitdir: ${path.join(main, '.git', 'worktrees', 'wt')}\n`);
		write(path.join(wt, 'f.ts'));
		assert.equal(await extractRepositoryFromContentReferences([{ kind: 'reference', reference: { fsPath: path.join(wt, 'f.ts') } }] as never), 'https://github.com/w/t.git');
		// relative gitdir
		const wt2 = path.join(main, 'wt2');
		fs.mkdirSync(path.join(main, '.git', 'worktrees', 'wt2'), { recursive: true });
		write(path.join(wt2, '.git'), 'gitdir: ../.git/worktrees/wt2\n');
		write(path.join(wt2, 'f.ts'));
		assert.equal(await findRepositoryRemoteForFolder(wt2), 'https://github.com/w/t.git');
		// .git file without gitdir line
		const wt3 = path.join(dir, 'wt3');
		write(path.join(wt3, '.git'), 'nonsense\n');
		assert.equal(await findRepositoryRemoteForFolder(wt3), undefined);
	});
});

async function withTmpAsync<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-bound-'));
	try { return await fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
