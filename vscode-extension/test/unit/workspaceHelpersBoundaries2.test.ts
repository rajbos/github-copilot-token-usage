/**
 * Second wave of boundary / branch-pinning tests for src/workspaceHelpers.ts, written to kill
 * the Stryker mutants that survived workspaceHelpers.test.ts + workspaceHelpersBoundaries.test.ts
 * (refs #2341). Each test pins an observable behaviour; see the PR description for the mutants
 * judged equivalent (and therefore deliberately not tested).
 */
import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	detectEditorSource,
	detectRelocatedAgentHomeFromPath,
	extractCustomAgentName,
	extractMcpServerName,
	extractRepositoryFromContentReferences,
	extractWorkspaceIdFromSessionPath,
	findRepositoryRemoteForFolder,
	getEditorNameFromRoot,
	getEditorTypeFromPath,
	getModeType,
	getRepoDisplayName,
	normalizePathForComparison,
	parseCodeWorkspaceFolders,
	parseGitRemoteUrl,
	resetClaudeCodeEditorVariantCacheForTests,
	resolveExactWorkspacePath,
	resolveSessionWorkspaceName,
	resolveWorkspaceFolderFromSessionPath,
	refineEditorLabelForInteractionModeSplit,
	scanWorkspaceCustomizationFiles,
	detectClaudeCodeEditorVariant,
} from '../../../src/workspaceHelpers';

function withTmp<T>(fn: (dir: string) => T): T {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-bound2-'));
	try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

async function withTmpAsync<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-bound2-'));
	try { return await fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function write(file: string, content = 'x'): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

/** True when the temp filesystem distinguishes case, i.e. the case-insensitive segment walk is reachable. */
function isCaseSensitiveFs(dir: string): boolean {
	write(path.join(dir, 'CaseProbe'));
	return !fs.existsSync(path.join(dir, 'caseprobe'));
}

// ── extractWorkspaceIdFromSessionPath ────────────────────────────────────────

test('extractWorkspaceIdFromSessionPath: returns the segment after workspaceStorage, case-insensitively', () => {
	assert.equal(extractWorkspaceIdFromSessionPath('/u/Code/User/workspaceStorage/abc123/chatSessions/s.json'), 'abc123');
	assert.equal(extractWorkspaceIdFromSessionPath('/u/Code/User/WorkspaceStorage/ABC/s.json'), 'ABC');
});

test('extractWorkspaceIdFromSessionPath: undefined when the marker is absent or has no following segment', () => {
	assert.equal(extractWorkspaceIdFromSessionPath('/u/Code/User/globalStorage/abc/s.json'), undefined);
	assert.equal(extractWorkspaceIdFromSessionPath('/u/Code/User/workspaceStorage'), undefined);
	assert.equal(extractWorkspaceIdFromSessionPath(''), undefined);
});

// ── resolveExactWorkspacePath / scanWorkspaceCustomizationFiles ──────────────

test('resolveExactWorkspacePath: case-insensitive walk rejects files used as directories and missing parents', () => {
	withTmp(dir => {
		if (!isCaseSensitiveFs(dir)) { return; } // segment walk is only reachable when the direct path misses
		write(path.join(dir, 'Docs', 'Guide.md'));
		write(path.join(dir, 'Plain'), 'file');
		// last segment resolves to a file: allowed
		assert.equal(resolveExactWorkspacePath(dir, 'docs/guide.md', true), path.join(dir, 'Docs', 'Guide.md'));
		// intermediate segment that is a file is not descended into
		assert.equal(resolveExactWorkspacePath(dir, 'plain/child.md', true), undefined);
		// missing intermediate directory
		assert.equal(resolveExactWorkspacePath(dir, 'nope/guide.md', true), undefined);
		// missing last segment inside an existing directory
		assert.equal(resolveExactWorkspacePath(dir, 'docs/other.md', true), undefined);
		// a missing workspace root never resolves
		assert.equal(resolveExactWorkspacePath(path.join(dir, 'gone'), 'docs/guide.md', true), undefined);
		// case-sensitive lookups never fall back to the segment walk
		assert.equal(resolveExactWorkspacePath(dir, 'docs/guide.md', false), undefined);
	});
});

test('resolveExactWorkspacePath: an existing exact path is returned unchanged in both modes', () => {
	withTmp(dir => {
		write(path.join(dir, 'a', 'b.md'));
		const expected = path.join(dir, 'a', 'b.md');
		assert.equal(resolveExactWorkspacePath(dir, 'a/b.md', false), expected);
		assert.equal(resolveExactWorkspacePath(dir, 'a/b.md', true), expected);
		assert.equal(resolveExactWorkspacePath(dir, 'a/zzz.md', false), undefined);
		assert.equal(resolveExactWorkspacePath(dir, 'a/zzz.md', true), undefined);
	});
});

test('scanWorkspaceCustomizationFiles: empty, missing and non-directory roots yield nothing', () => {
	assert.deepEqual(scanWorkspaceCustomizationFiles(''), []);
	withTmp(dir => {
		assert.deepEqual(scanWorkspaceCustomizationFiles(path.join(dir, 'missing')), []);
		// a file that happens to be named like a customization file is not a workspace folder
		const file = path.join(dir, 'AGENTS.md');
		write(file);
		assert.deepEqual(scanWorkspaceCustomizationFiles(file), []);
		// …but the folder holding it is scanned
		assert.deepEqual(scanWorkspaceCustomizationFiles(dir).map(e => e.relativePath), ['AGENTS.md']);
	});
});

test('scanWorkspaceCustomizationFiles: excluded directories are not descended into', () => {
	withTmp(dir => {
		write(path.join(dir, 'node_modules', 'pkg', 'AGENTS.md'));
		write(path.join(dir, 'sub', 'AGENTS.md'));
		assert.deepEqual(scanWorkspaceCustomizationFiles(dir).map(e => e.relativePath), ['sub/AGENTS.md']);
	});
});

// ── getModeType / extractCustomAgentName ─────────────────────────────────────

test('getModeType: object modes resolve by kind', () => {
	assert.equal(getModeType({}), 'ask');
	assert.equal(getModeType({ kind: 'ask' }), 'ask');
	assert.equal(getModeType({ kind: 'edit' }), 'edit');
	assert.equal(getModeType({ kind: 'unknown-kind' }), 'ask');
	assert.equal(getModeType({ kind: 'agent' }), 'agent');
	assert.equal(getModeType({ kind: 'agent', id: 'agent' }), 'agent');
	assert.equal(getModeType({ kind: 'agent', id: '' }), 'agent');
	assert.equal(getModeType({ kind: 'agent', id: 'file:///x/plan-agent/Plan.agent.md' }), 'plan');
	assert.equal(getModeType({ kind: 'agent', id: 'file:///x/.github/agents/Reviewer.agent.md' }), 'customAgent');
	assert.equal(getModeType({ kind: 'agent', id: 'some-other-mode' }), 'agent');
});

test('extractCustomAgentName: URI decoding, plain paths and rejects', () => {
	assert.equal(extractCustomAgentName('file:///home/u/.github/agents/My%20Agent.agent.md'), 'My Agent');
	assert.equal(extractCustomAgentName('/home/u/agents/Plain.agent.md'), 'Plain');
	assert.equal(extractCustomAgentName(''), null);
	assert.equal(extractCustomAgentName('/home/u/agents/Plain.md'), null);
	// a traversal URI is rejected by the safe resolver
	assert.equal(extractCustomAgentName('file:///home/../etc/x.agent.md'), null);
	// has the marker but the file name does not end with it
	assert.equal(extractCustomAgentName('/home/u/Foo.agent.md.bak'), null);
});

// ── getEditorNameFromRoot ────────────────────────────────────────────────────

test('getEditorNameFromRoot: each Insiders spelling is recognised on its own', () => {
	assert.equal(getEditorNameFromRoot('/home/u/.config/Code - Insiders'), 'VS Code Insiders');
	assert.equal(getEditorNameFromRoot('/home/u/.config/code-insiders'), 'VS Code Insiders');
	assert.equal(getEditorNameFromRoot('/home/u/.config/vscode_insiders_data'), 'VS Code Insiders');
});

test('getEditorNameFromRoot: empty is Unknown and the generic VS Code endings still resolve', () => {
	assert.equal(getEditorNameFromRoot(''), 'Unknown');
	assert.equal(getEditorNameFromRoot('/home/u/.config/Code'), 'VS Code');
	assert.equal(getEditorNameFromRoot('/home/u/.config/Code/User'), 'VS Code');
	assert.equal(getEditorNameFromRoot('/home/u/.config/something'), 'Unknown');
});

// ── getRepoDisplayName / parseGitRemoteUrl ───────────────────────────────────

test('getRepoDisplayName: empty and Unknown map to Unknown, URL shapes map to owner/repo', () => {
	assert.equal(getRepoDisplayName(''), 'Unknown');
	assert.equal(getRepoDisplayName('Unknown'), 'Unknown');
	assert.equal(getRepoDisplayName('https://github.com/owner/repo'), 'owner/repo');
	assert.equal(getRepoDisplayName('https://github.com/owner/repo.git'), 'owner/repo');
	assert.equal(getRepoDisplayName('https://user@github.com/owner/repo.git'), 'owner/repo');
	assert.equal(getRepoDisplayName('git@github.com:owner/repo.git'), 'owner/repo');
	assert.equal(getRepoDisplayName('git://example.org/deep/group/owner/repo'), 'owner/repo');
});

test('getRepoDisplayName: only a trailing .git is stripped', () => {
	assert.equal(getRepoDisplayName('https://github.com/owner/foo.gitignore'), 'owner/foo.gitignore');
	assert.equal(getRepoDisplayName('https://github.com/owner/foo.git.git'), 'owner/foo.git');
});

test('getRepoDisplayName: non-URL fallbacks ignore empty path segments', () => {
	assert.equal(getRepoDisplayName('owner/repo/'), 'owner/repo');
	assert.equal(getRepoDisplayName('a/owner/repo//'), 'owner/repo');
	assert.equal(getRepoDisplayName('justrepo'), 'justrepo');
});

test('parseGitRemoteUrl: section header and url must start the (trimmed) line', () => {
	assert.equal(parseGitRemoteUrl('[remote "origin"]\n\turl = https://h/o/r.git\n'), 'https://h/o/r.git');
	assert.equal(parseGitRemoteUrl('  [REMOTE  "origin"]  \n  URL=https://h/o/r\n'), 'https://h/o/r');
	// commented-out or prefixed headers do not open the origin section
	assert.equal(parseGitRemoteUrl('# [remote "origin"]\nurl = https://h/o/r\n'), undefined);
	assert.equal(parseGitRemoteUrl('x[remote "origin"]\nurl = https://h/o/r\n'), undefined);
	// text after the header means it is not the section header
	assert.equal(parseGitRemoteUrl('[remote "origin"] trailing\nurl = https://h/o/r\n'), undefined);
	// an indented key that merely ends with "url" is not the url key
	assert.equal(parseGitRemoteUrl('[remote "origin"]\n\tpushurl = https://h/o/push\n'), undefined);
	// leaving the origin section stops the search
	assert.equal(parseGitRemoteUrl('[remote "origin"]\n[remote "up"]\nurl = https://h/o/up\n'), undefined);
	// value is trimmed
	assert.equal(parseGitRemoteUrl('[remote "origin"]\nurl =   https://h/o/r   \n'), 'https://h/o/r');
});

// ── extractMcpServerName ─────────────────────────────────────────────────────

test('extractMcpServerName: display name from the map is split at the colon and trimmed', () => {
	assert.equal(extractMcpServerName('mcp_x_tool', { mcp_x_tool: 'My Server : Do Thing' }), 'My Server');
});

test('extractMcpServerName: the mcp prefix is only stripped at the start of the name', () => {
	assert.equal(extractMcpServerName('amcp_srv_tool'), 'amcp');
	assert.equal(extractMcpServerName('mcp_srv_tool'), 'srv');
	assert.equal(extractMcpServerName('mcp.srv.tool'), 'srv');
});

// ── extractRepositoryFromContentReferences / findRepositoryRemoteForFolder ───

test('extractRepositoryFromContentReferences: non-object items are skipped, both reference kinds are read', async () => {
	await withTmpAsync(async dir => {
		const repo = path.join(dir, 'repo');
		write(path.join(repo, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/o/viaref\n');
		write(path.join(repo, 'src', 'a.ts'));
		const file = path.join(repo, 'src', 'a.ts');
		const junk = [null, 'text', 42, { kind: 'reference' }, { kind: 'other', reference: { fsPath: file } }] as any[];
		assert.equal(await extractRepositoryFromContentReferences(junk), undefined);
		assert.equal(await extractRepositoryFromContentReferences([...junk, { kind: 'reference', reference: { fsPath: file } }] as any), 'https://github.com/o/viaref');
		assert.equal(await extractRepositoryFromContentReferences([...junk, { kind: 'inlineReference', inlineReference: { fsPath: file } }] as any), 'https://github.com/o/viaref');
		// reference data is not used for an inlineReference item, and vice versa
		assert.equal(await extractRepositoryFromContentReferences([{ kind: 'inlineReference', reference: { fsPath: file } }] as any), undefined);
		assert.equal(await extractRepositoryFromContentReferences([{ kind: 'reference', inlineReference: { fsPath: file } }] as any), undefined);
		// an empty fsPath is ignored rather than treated as a path
		assert.equal(await extractRepositoryFromContentReferences([{ kind: 'reference', reference: { fsPath: '' } }] as any), undefined);
		assert.equal(await extractRepositoryFromContentReferences('nope' as any), undefined);
		assert.equal(await extractRepositoryFromContentReferences([]), undefined);
	});
});

test('extractRepositoryFromContentReferences: worktree .git pointer files are followed', async () => {
	await withTmpAsync(async dir => {
		const main = path.join(dir, 'main');
		write(path.join(main, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/o/main\n');
		fs.mkdirSync(path.join(main, '.git', 'worktrees', 'wt'), { recursive: true });
		const wtAbs = path.join(dir, 'wt-abs');
		write(path.join(wtAbs, '.git'), `gitdir: ${path.join(main, '.git', 'worktrees', 'wt')}   \n`);
		write(path.join(wtAbs, 'f.ts'));
		assert.equal(await extractRepositoryFromContentReferences([{ kind: 'reference', reference: { fsPath: path.join(wtAbs, 'f.ts') } }] as any), 'https://github.com/o/main');

		// no space after "gitdir:" and a relative target
		const wtRel = path.join(dir, 'wt-rel');
		write(path.join(wtRel, '.git'), `gitdir:${path.relative(wtRel, path.join(main, '.git', 'worktrees', 'wt')).split(path.sep).join('/')}\n`);
		write(path.join(wtRel, 'f.ts'));
		assert.equal(await extractRepositoryFromContentReferences([{ kind: 'reference', reference: { fsPath: path.join(wtRel, 'f.ts') } }] as any), 'https://github.com/o/main');

		// a pointer that is not on its own line start is ignored
		const wtBad = path.join(dir, 'wt-bad');
		write(path.join(wtBad, '.git'), `see gitdir: ${path.join(main, '.git', 'worktrees', 'wt')}\n`);
		write(path.join(wtBad, 'f.ts'));
		assert.equal(await extractRepositoryFromContentReferences([{ kind: 'reference', reference: { fsPath: path.join(wtBad, 'f.ts') } }] as any), undefined);

		// a .git file without a gitdir line is ignored
		const wtNone = path.join(dir, 'wt-none');
		write(path.join(wtNone, '.git'), 'not a pointer\n');
		write(path.join(wtNone, 'f.ts'));
		assert.equal(await extractRepositoryFromContentReferences([{ kind: 'reference', reference: { fsPath: path.join(wtNone, 'f.ts') } }] as any), undefined);
	});
});

test('findRepositoryRemoteForFolder: a trailing separator and sub-folders resolve to the enclosing repository', async () => {
	await withTmpAsync(async dir => {
		const repo = path.join(dir, 'repo');
		write(path.join(repo, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/o/enclosing\n');
		fs.mkdirSync(path.join(repo, 'a', 'b'), { recursive: true });
		assert.equal(await findRepositoryRemoteForFolder(repo + path.sep), 'https://github.com/o/enclosing');
		assert.equal(await findRepositoryRemoteForFolder(path.join(repo, 'a', 'b')), 'https://github.com/o/enclosing');
		// the nearest .git is the boundary: a nested repo without an origin has no remote
		write(path.join(repo, 'nested', '.git', 'config'), '[core]\n');
		assert.equal(await findRepositoryRemoteForFolder(path.join(repo, 'nested')), undefined);
	});
});

// ── parseCodeWorkspaceFolders ────────────────────────────────────────────────

test('parseCodeWorkspaceFolders: only existing *.code-workspace files with a folders array are read', () => {
	withTmp(dir => {
		const abs = path.join(dir, 'abs-folder');
		const body = JSON.stringify({ folders: [{ path: abs }] });
		const good = path.join(dir, 'ok.code-workspace');
		write(good, body);
		assert.deepEqual(parseCodeWorkspaceFolders(good), [abs]);

		const wrongExt = path.join(dir, 'ok.json');
		write(wrongExt, body);
		assert.deepEqual(parseCodeWorkspaceFolders(wrongExt), []);
		assert.deepEqual(parseCodeWorkspaceFolders(''), []);
		assert.deepEqual(parseCodeWorkspaceFolders(path.join(dir, 'missing.code-workspace')), []);

		for (const [name, content] of Object.entries({
			notArray: '{"folders":"x"}',
			noFolders: '{}',
			arrayRoot: '[{"path":"/x"}]',
			nullRoot: 'null',
			numberRoot: '42',
			invalid: '{oops',
		})) {
			const f = path.join(dir, `${name}.code-workspace`);
			write(f, content);
			assert.deepEqual(parseCodeWorkspaceFolders(f), [], name);
		}
	});
});

test('parseCodeWorkspaceFolders: null/non-object entries are skipped without dropping valid ones', () => {
	withTmp(dir => {
		const abs = path.join(dir, 'abs');
		const f = path.join(dir, 'w.code-workspace');
		write(f, JSON.stringify({ folders: [null, 'text', 7, {}, { path: 5 }, { uri: 'http://example.com/x' }, { uri: 5 }, { path: abs }] }));
		assert.deepEqual(parseCodeWorkspaceFolders(f), [abs]);
	});
});

test('parseCodeWorkspaceFolders: relative paths resolve against the workspace file, file:// uris are decoded', () => {
	withTmp(dir => {
		fs.mkdirSync(path.join(dir, 'rel', 'child'), { recursive: true });
		fs.mkdirSync(path.join(dir, 'with space'), { recursive: true });
		const f = path.join(dir, 'w.code-workspace');
		const uri = 'file://' + (process.platform === 'win32' ? '/' : '') + path.join(dir, 'with space').split(path.sep).join('/').replace(/ /g, '%20');
		write(f, JSON.stringify({ folders: [{ path: 'rel/child' }, { uri }] }));
		const out = parseCodeWorkspaceFolders(f);
		assert.equal(out.length, 2);
		assert.equal(fs.realpathSync.native(out[0]), fs.realpathSync.native(path.join(dir, 'rel', 'child')));
		assert.equal(out[1], fs.realpathSync.native(path.join(dir, 'with space')));
	});
});

// ── resolveWorkspaceFolderFromSessionPath ────────────────────────────────────

test('resolveWorkspaceFolderFromSessionPath: workspace.json keys and meta.json keys resolve and are cached', () => {
	withTmp(dir => {
		const target = fs.realpathSync.native(fs.mkdtempSync(path.join(dir, 'target-')));
		const workspaceKeys = ['folder', 'workspace', 'configuration', 'uri', 'path'];
		const metaKeys = ['folder', 'uri', 'workspace', 'path'];
		for (const key of workspaceKeys) {
			const id = `w-${key}`;
			write(path.join(dir, 'workspaceStorage', id, 'workspace.json'), JSON.stringify({ [key]: target }));
			const cache = new Map<string, string | undefined>();
			const session = path.join(dir, 'workspaceStorage', id, 'chatSessions', 's.json');
			assert.equal(resolveWorkspaceFolderFromSessionPath(session, cache), target, `workspace.json ${key}`);
			assert.equal(cache.get(id), target);
		}
		for (const key of metaKeys) {
			const id = `m-${key}`;
			write(path.join(dir, 'workspaceStorage', id, 'meta.json'), JSON.stringify({ [key]: target }));
			const cache = new Map<string, string | undefined>();
			const session = path.join(dir, 'workspaceStorage', id, 'chatSessions', 's.json');
			assert.equal(resolveWorkspaceFolderFromSessionPath(session, cache), target, `meta.json ${key}`);
		}
	});
});

test('resolveWorkspaceFolderFromSessionPath: workspace.json wins over meta.json, empty results are cached as undefined', () => {
	withTmp(dir => {
		const a = fs.realpathSync.native(fs.mkdtempSync(path.join(dir, 'a-')));
		const b = fs.realpathSync.native(fs.mkdtempSync(path.join(dir, 'b-')));
		write(path.join(dir, 'workspaceStorage', 'both', 'workspace.json'), JSON.stringify({ folder: a }));
		write(path.join(dir, 'workspaceStorage', 'both', 'meta.json'), JSON.stringify({ folder: b }));
		const cache = new Map<string, string | undefined>();
		assert.equal(resolveWorkspaceFolderFromSessionPath(path.join(dir, 'workspaceStorage', 'both', 'chat', 's.json'), cache), a);

		write(path.join(dir, 'workspaceStorage', 'empty', 'workspace.json'), JSON.stringify({ unrelated: 1 }));
		assert.equal(resolveWorkspaceFolderFromSessionPath(path.join(dir, 'workspaceStorage', 'empty', 'chat', 's.json'), cache), undefined);
		assert.equal(cache.has('empty'), true);
		assert.equal(cache.get('empty'), undefined);

		// no json files at all: undefined and cached
		assert.equal(resolveWorkspaceFolderFromSessionPath(path.join(dir, 'workspaceStorage', 'none', 'chat', 's.json'), cache), undefined);
		assert.equal(cache.has('none'), true);
		// a deleted folder keeps the parsed path as-is
		const gone = path.join(dir, 'deleted-folder');
		write(path.join(dir, 'workspaceStorage', 'gone', 'workspace.json'), JSON.stringify({ folder: gone }));
		assert.equal(resolveWorkspaceFolderFromSessionPath(path.join(dir, 'workspaceStorage', 'gone', 'chat', 's.json'), cache), gone);
		// a path without a workspaceStorage id never touches the cache
		const before = cache.size;
		assert.equal(resolveWorkspaceFolderFromSessionPath(path.join(dir, 'elsewhere', 's.json'), cache), undefined);
		assert.equal(resolveWorkspaceFolderFromSessionPath(path.join(dir, 'workspaceStorage'), cache), undefined);
		assert.equal(cache.size, before);
	});
});

test('resolveWorkspaceFolderFromSessionPath: a throwing cache marks the workspace id as unresolved', () => {
	class FlakyCache extends Map<string, string | undefined> {
		private thrown = false;
		override has(key: string): boolean {
			if (!this.thrown) { this.thrown = true; throw new Error('boom'); }
			return super.has(key);
		}
	}
	const cache = new FlakyCache();
	cache.set('seed', 'x');
	const res = resolveWorkspaceFolderFromSessionPath('/u/Code/User/WorkspaceStorage/hash1/chat/s.json', cache);
	assert.equal(res, undefined);
	assert.equal(Map.prototype.has.call(cache, 'hash1'), true);
	assert.equal(Map.prototype.get.call(cache, 'hash1'), undefined);
	assert.equal(Map.prototype.has.call(cache, 'undefined'), false);
	assert.equal(cache.size, 2);
});

test('resolveSessionWorkspaceName: precedence is folder path, repository, then storage lookup', () => {
	withTmp(dir => {
		const target = fs.realpathSync.native(fs.mkdtempSync(path.join(dir, 'my-proj-')));
		write(path.join(dir, 'workspaceStorage', 'id1', 'workspace.json'), JSON.stringify({ folder: target }));
		const session = path.join(dir, 'workspaceStorage', 'id1', 'chat', 's.json');
		const name = path.basename(target);
		assert.equal(resolveSessionWorkspaceName({}, session, new Map()), name);
		assert.equal(resolveSessionWorkspaceName({ repository: 'o/r' }, session, new Map()), 'o/r');
		assert.equal(resolveSessionWorkspaceName({ workspaceFolderPath: target, repository: 'o/r' }, session), name);
		assert.equal(resolveSessionWorkspaceName({}, session), undefined);
		assert.equal(resolveSessionWorkspaceName({}, path.join(dir, 'x', 's.json'), new Map()), undefined);
	});
});

// ── editor detection ─────────────────────────────────────────────────────────

test('SSMS requires a sessions folder; the copilot-chat folder alone is not enough', () => {
	assert.equal(getEditorTypeFromPath('/home/u/SSMSGitHubCopilot/copilot-chat/hash/chat.json'), 'Unknown');
	assert.equal(getEditorTypeFromPath('/home/u/SSMSGitHubCopilot/copilot-chat/hash/sessions/s1'), 'SSMS');
	assert.equal(getEditorTypeFromPath('/home/u/.vs/sol/copilot-chat/hash/sessions/s1'), 'Visual Studio');
});

test('virtual-scheme paths are matched at the start only', () => {
	assert.equal(getEditorTypeFromPath('devin://trajectory/abc'), 'Devin');
	assert.equal(getEditorTypeFromPath('windsurf://trajectory/abc'), 'Windsurf');
	assert.equal(getEditorTypeFromPath('/x/y/devin://'), 'Unknown');
	assert.equal(getEditorTypeFromPath('/x/y/windsurf://'), 'Unknown');
	assert.equal(detectEditorSource('devin://trajectory/abc'), 'Devin');
	assert.equal(detectEditorSource('windsurf://trajectory/abc'), 'Windsurf');
	assert.equal(detectEditorSource('/x/y/zzz-windsurf://'), 'Windsurf'); // loose substring match in detectEditorSource
});

test('detectRelocatedAgentHomeFromPath: unset or blank homes never match', () => {
	assert.equal(detectRelocatedAgentHomeFromPath('/x/sessions/a.jsonl', {}), undefined);
	assert.equal(detectRelocatedAgentHomeFromPath('/x/logs/session/a.json', {}), undefined);
	assert.equal(detectRelocatedAgentHomeFromPath('/x/state.db#abc', {}), undefined);
	// blank (whitespace-only) values are treated as unset, not as a relative home
	assert.equal(detectRelocatedAgentHomeFromPath('   /sessions/a.jsonl', { CODEX_HOME: '   ' }), undefined);
	assert.equal(detectRelocatedAgentHomeFromPath(normalizePathForComparison(path.join('   ', 'state.db')) + '#abc', { HERMES_HOME: '   ' }), undefined);
});

test('detectRelocatedAgentHomeFromPath: CODEX_HOME only owns sessions/, archived_sessions/ and state_<N>.sqlite# directly under it', () => {
	const home = path.join(os.tmpdir(), 'relocated-codex');
	const base = normalizePathForComparison(home);
	const env = { CODEX_HOME: home };
	assert.equal(detectRelocatedAgentHomeFromPath(`${base}/sessions/2026/a.jsonl`, env), 'Codex CLI');
	assert.equal(detectRelocatedAgentHomeFromPath(`${base}/archived_sessions/a.jsonl`, env), 'Codex CLI');
	assert.equal(detectRelocatedAgentHomeFromPath(`${base}/state_5.sqlite#thread`, env), 'Codex CLI');
	assert.equal(detectRelocatedAgentHomeFromPath(`${base}/state_.sqlite#thread`, env), undefined);
	assert.equal(detectRelocatedAgentHomeFromPath(`${base}/state_5.sqlite`, env), undefined);
	// the owned folder must be a direct child, not nested somewhere deeper
	assert.equal(detectRelocatedAgentHomeFromPath(`${base}/other/sessions/a.jsonl`, env), undefined);
	assert.equal(detectRelocatedAgentHomeFromPath(`${base}/x_sessions/a.jsonl`, env), undefined);
	// a path outside the home is never owned
	assert.equal(detectRelocatedAgentHomeFromPath(`${base}-other/sessions/a.jsonl`, env), undefined);
});

test('detectRelocatedAgentHomeFromPath: VIBE_HOME expands only a leading ~, HERMES_HOME owns state.db# paths', () => {
	const tilde = detectRelocatedAgentHomeFromPath(
		normalizePathForComparison(path.join(os.homedir(), 'my-vibe', 'logs', 'session', 's.json')),
		{ VIBE_HOME: '~/my-vibe' },
	);
	assert.equal(tilde, 'Mistral Vibe');

	const odd = path.join(os.tmpdir(), 'a~b-vibe');
	assert.equal(
		detectRelocatedAgentHomeFromPath(normalizePathForComparison(path.join(odd, 'logs', 'session', 's.json')), { VIBE_HOME: odd }),
		'Mistral Vibe',
	);
	assert.equal(
		detectRelocatedAgentHomeFromPath(normalizePathForComparison(path.join(odd, 'logs', 'other', 's.json')), { VIBE_HOME: odd }),
		undefined,
	);

	const hermes = path.join(os.tmpdir(), 'custom-hermes-dir');
	assert.equal(
		detectRelocatedAgentHomeFromPath(`${normalizePathForComparison(path.join(hermes, 'state.db'))}#sid`, { HERMES_HOME: hermes }),
		'Hermes',
	);
	assert.equal(
		detectRelocatedAgentHomeFromPath(`${normalizePathForComparison(path.join(hermes, 'state.db'))}`, { HERMES_HOME: hermes }),
		undefined,
	);
});

test('detectClaudeCodeEditorVariant: scans past null / entrypoint-less lines and returns the first entrypoint', () => {
	withTmp(dir => {
		resetClaudeCodeEditorVariantCacheForTests();
		const cli = path.join(dir, 'cli.jsonl');
		write(cli, 'null\n\n{"type":"summary"}\nnot json\n{"entrypoint":"cli"}\n{"entrypoint":"claude-desktop"}\n');
		assert.equal(detectClaudeCodeEditorVariant(cli), 'Claude Code CLI');

		const desktop = path.join(dir, 'desktop.jsonl');
		write(desktop, '{"type":"summary"}\n{"entrypoint":"claude-desktop"}\n');
		assert.equal(detectClaudeCodeEditorVariant(desktop), 'Claude Desktop');

		const ext = path.join(dir, 'ext.jsonl');
		write(ext, '{"type":"summary"}\n{"entrypoint":"vscode"}\n{"entrypoint":"cli"}\n');
		assert.equal(detectClaudeCodeEditorVariant(ext), 'Claude Code');

		const none = path.join(dir, 'none.jsonl');
		write(none, '{"type":"summary"}\n');
		assert.equal(detectClaudeCodeEditorVariant(none), 'Claude Code');
		// a file with no entrypoint yet is re-read once it gains one
		fs.appendFileSync(none, '{"entrypoint":"cli"}\n');
		assert.equal(detectClaudeCodeEditorVariant(none), 'Claude Code CLI');
		assert.equal(detectClaudeCodeEditorVariant(path.join(dir, 'missing.jsonl')), 'Claude Code');
		resetClaudeCodeEditorVariantCacheForTests();
	});
});

test('refineEditorLabelForInteractionModeSplit: client_name must start its line and match exactly after trimming', () => {
	withTmp(dir => {
		const events = path.join(dir, 'session-state', 'abc', 'events.jsonl');
		const yaml = path.join(dir, 'session-state', 'abc', 'workspace.yaml');
		write(events);
		write(yaml, 'id: abc\nclient_name: github/autopilot\n');
		assert.equal(refineEditorLabelForInteractionModeSplit(events, 'Copilot CLI'), 'Copilot App');
		write(yaml, 'client_name:   github/autopilot   \n');
		assert.equal(refineEditorLabelForInteractionModeSplit(events, 'Copilot CLI'), 'Copilot App');
		write(yaml, 'other_client_name: github/autopilot\n');
		assert.equal(refineEditorLabelForInteractionModeSplit(events, 'Copilot CLI'), 'Copilot CLI');
		write(yaml, 'client_name: github/cli\n');
		assert.equal(refineEditorLabelForInteractionModeSplit(events, 'Copilot CLI'), 'Copilot CLI');
		fs.rmSync(yaml);
		assert.equal(refineEditorLabelForInteractionModeSplit(events, 'Copilot CLI'), 'Copilot CLI');
		assert.equal(refineEditorLabelForInteractionModeSplit(events, 'Claude Code'), 'Claude (VS Code)');
		assert.equal(refineEditorLabelForInteractionModeSplit(events, 'Cursor'), 'Cursor');
	});
});
