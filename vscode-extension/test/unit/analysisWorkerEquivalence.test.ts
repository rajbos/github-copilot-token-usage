import test, { before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import tokenEstimatorsData from '../../../src/tokenEstimators.json';
import modelPricingData from '../../../src/modelPricing.json';
import toolNamesData from '../../../src/toolNames.json';
import type { ModelPricing, SessionFileDetails, TokenEstimator } from '../../../src/types';
import { buildAdapterRegistry, createDataAccessInstances } from '../../../src/adapters';
import { estimateTokensFromText } from '../../../src/tokenEstimation';
import { isMcpTool, extractMcpServerName } from '../../../src/workspaceHelpers';
import { analyzeSessionFile, quickAnalyzeSessionContent, type SessionAnalyzerDeps } from '../../src/analysis/sessionFileAnalyzer';
import { AnalysisWorkerPool } from '../../src/analysis/analysisWorkerPool';
import { computeSessionFileDetails } from '../../src/analysis/sessionDetailsAnalyzer';
import { scanCustomizationFilesForWorkspace } from '../../src/analysis/workspaceCustomizationScan';
import type { CopilotCliOtelSessionUsage } from '../../../src/copilotCliOtel';

/**
 * The worker is only safe to ship if it produces exactly what the in-process analyzer does,
 * and only worth shipping if it really keeps the host's event loop free. These build the real
 * worker bundle (same esbuild settings as esbuild.js) and test both claims against it.
 */
const EXTENSION_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const FIXTURES = [
	path.join(EXTENSION_ROOT, 'test', 'fixtures', 'sample-session-data', 'chatSessions', 'session-01-today.json'),
	path.join(EXTENSION_ROOT, 'test', 'fixtures', 'sample-session-data', 'chatSessions', 'session-03-twelve-days-ago.json'),
	path.join(EXTENSION_ROOT, '..', 'cli', 'src', 'test', 'fixtures', 'vscode-delta-session.jsonl'),
	path.join(EXTENSION_ROOT, 'test', 'fixtures', 'sample-session-data', 'xss-hostile-claude-session.jsonl'),
];

let scratchDir: string;
let workerPath: string;
const savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

before(async () => {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const esbuild = require('esbuild') as typeof import('esbuild');
	scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'analysis-worker-'));
	// The worker looks Copilot CLI usage up in the session-store database under the user's home. Point home at an
	// empty directory so these tests never read (or depend on) the developer's real ~/.copilot.
	const emptyHome = path.join(scratchDir, 'home');
	fs.mkdirSync(emptyHome, { recursive: true });
	process.env.HOME = emptyHome;
	process.env.USERPROFILE = emptyHome;
	workerPath = path.join(scratchDir, 'analysisWorker.js');
	await esbuild.build({
		entryPoints: [path.join(EXTENSION_ROOT, 'src', 'analysis', 'analysisWorker.ts')],
		bundle: true,
		format: 'cjs',
		platform: 'node',
		outfile: workerPath,
		alias: { vscode: path.join(EXTENSION_ROOT, 'src', 'analysis', 'vscodeStub.ts') },
		nodePaths: [path.join(EXTENSION_ROOT, 'node_modules')],
		logLevel: 'silent',
		banner: { js: 'var __importMetaUrl = require("url").pathToFileURL(__filename).href;' },
		define: { 'import.meta.url': '__importMetaUrl' },
	});
});

after(() => {
	for (const key of ['HOME', 'USERPROFILE'] as const) {
		if (savedHome[key] === undefined) { delete process.env[key]; } else { process.env[key] = savedHome[key]; }
	}
	if (scratchDir) { fs.rmSync(scratchDir, { recursive: true, force: true }); }
});

function makePool(size = 2, resolveOtelUsage?: (sessionFile: string) => Promise<CopilotCliOtelSessionUsage | null>): AnalysisWorkerPool {
	return new AnalysisWorkerPool({ workerPath, extensionPath: EXTENSION_ROOT, size, log: () => undefined, warn: () => undefined, resolveOtelUsage });
}

function buildInProcessDeps(): SessionAnalyzerDeps {
	const tokenEstimators = tokenEstimatorsData.estimators as Record<string, TokenEstimator>;
	const toolNameMap = toolNamesData as { [key: string]: string };
	const extensionUri = { fsPath: EXTENSION_ROOT, path: EXTENSION_ROOT, scheme: 'file' };
	return {
		warn: () => undefined,
		tokenEstimators,
		modelPricing: modelPricingData.pricing as { [key: string]: ModelPricing },
		toolNameMap,
		ecosystems: buildAdapterRegistry({
			...createDataAccessInstances(extensionUri),
			estimateTokens: (text, model) => estimateTokensFromText(text, model ?? 'gpt-4', tokenEstimators),
			isMcpTool: (tool) => isMcpTool(tool),
			extractMcpServerName: (tool) => extractMcpServerName(tool, toolNameMap),
		}),
	};
}

/** The skeleton the host prepares before handing a session to the details pass. */
function detailsSkeleton(file: string, stat: fs.Stats): SessionFileDetails {
	return {
		file, size: stat.size, modified: stat.mtime.toISOString(), interactions: 0,
		contextReferences: { file: 0, selection: 0, implicitSelection: 0, symbol: 0, codebase: 0, workspace: 0, terminal: 0, vscode: 0, terminalLastCommand: 0, terminalSelection: 0, clipboard: 0, changes: 0, outputPanel: 0, problemsPanel: 0, pullRequest: 0, byKind: {}, copilotInstructions: 0, agentsMd: 0, byPath: {} },
		firstInteraction: null, lastInteraction: null, editorSource: 'test',
	};
}

/** JSON round-trip drops `undefined`-valued keys, which structured cloning would keep. */
const normalize = <T>(value: T): T => JSON.parse(JSON.stringify(value));

test('worker output is identical to the in-process analyzer', async (t) => {
	const pool = makePool();
	const deps = buildInProcessDeps();
	try {
		const present = FIXTURES.filter((f) => fs.existsSync(f));
		assert.ok(present.length >= 2, 'expected at least the sample chat sessions to exist');
		for (const file of present) {
			await t.test(path.basename(file), async () => {
				const stat = fs.statSync(file);
				const [viaWorker, inProcess] = await Promise.all([
					pool.analyze(file, stat.mtimeMs, stat.size, 'owner/repo'),
					analyzeSessionFile(deps, file, stat.mtimeMs, stat.size, { repository: 'owner/repo' }),
				]);
				assert.deepEqual(normalize(viaWorker), normalize(inProcess));
				assert.equal(viaWorker.repository, 'owner/repo', 'a previously discovered repository must survive a re-parse');
			});
			await t.test(`${path.basename(file)} (details)`, async () => {
				const stat = fs.statSync(file);
				const [viaWorker, inProcess] = await Promise.all([
					pool.computeDetails(file, stat.mtime.getTime(), stat.size, detailsSkeleton(file, stat)),
					computeSessionFileDetails(deps, file, stat, detailsSkeleton(file, stat)),
				]);
				assert.deepEqual(normalize(viaWorker), normalize(inProcess));
				assert.ok(viaWorker.cacheUpdate, 'a readable session produces a cache update');
			});
		}
	} finally {
		await pool.dispose();
	}
});

test('one malformed timestamp in a session does not reject the session or its details', async () => {
	// Session logs are external input. A bad timestamp used to make toISOString() throw and fail the whole file.
	const file = path.join(scratchDir, 'bad-timestamp.json');
	const good = Date.now() - 60_000;
	fs.writeFileSync(file, JSON.stringify({ requests: [
		{ requestId: 'r1', modelId: 'copilot/gpt-4o', timestamp: 'definitely not a date', message: { text: 'one', parts: [{ text: 'one', kind: 'text' }] }, response: [] },
		{ requestId: 'r2', modelId: 'copilot/gpt-4o', timestamp: good, message: { text: 'two', parts: [{ text: 'two', kind: 'text' }] }, response: [] },
	] }));
	const stat = fs.statSync(file);
	const deps = buildInProcessDeps();
	const analyzed = await analyzeSessionFile(deps, file, stat.mtimeMs, stat.size);
	assert.equal(analyzed.interactions, 2);
	assert.equal(analyzed.lastInteraction, new Date(good).toISOString(), 'the valid timestamp is used');
	const details = await computeSessionFileDetails(deps, file, stat, detailsSkeleton(file, stat));
	assert.ok(details.cacheUpdate, 'the details pass succeeds too');
	assert.equal(details.details.lastInteraction, new Date(good).toISOString());
});

test('an unparseable session yields the same partial details and no cache update on both sides', async () => {
	const broken = path.join(scratchDir, 'broken-session.json');
	fs.writeFileSync(broken, '{"requests": [ this is not json');
	const stat = fs.statSync(broken);
	const pool = makePool(1);
	try {
		const [viaWorker, inProcess] = await Promise.all([
			pool.computeDetails(broken, stat.mtime.getTime(), stat.size, detailsSkeleton(broken, stat)),
			computeSessionFileDetails(buildInProcessDeps(), broken, stat, detailsSkeleton(broken, stat)),
		]);
		assert.equal(inProcess.cacheUpdate, null, 'a parse failure must not be cached');
		assert.deepEqual(normalize(viaWorker), normalize(inProcess));
	} finally {
		await pool.dispose();
	}
});

test('a Copilot CLI OTel lookup is answered by the host, so workers never scan the OTel export themselves', async () => {
	// A worker has its own module state, so left alone it would build its own copy of the (potentially multi-GB)
	// OTel index. The host answers instead; here a spy stands in for the host and returns a distinctive usage.
	const sessionId = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
	const dir = path.join(scratchDir, 'session-state', sessionId);
	fs.mkdirSync(dir, { recursive: true });
	const eventsFile = path.join(dir, 'events.jsonl');
	fs.writeFileSync(eventsFile, JSON.stringify({ type: 'user.message', timestamp: new Date().toISOString(), data: { content: 'hi' } }) + '\n');
	const stat = fs.statSync(eventsFile);

	const asked: string[] = [];
	const pool = makePool(1, async (sessionFile) => { asked.push(sessionFile); return null; });
	try {
		await pool.analyze(eventsFile, stat.mtimeMs, stat.size);
		assert.ok(asked.includes(eventsFile), 'the worker asked the host about the OTel usage of this session');
	} finally {
		await pool.dispose();
	}

	// A lookup that fails on the host must fail the request. The analysis code tolerates many errors (an unreadable
	// file yields zeros), and without this the half-answered result would be cached as if it were complete.
	const failing = makePool(1, async () => { throw new Error('index unavailable'); });
	try {
		await assert.rejects(
			failing.analyze(eventsFile, stat.mtimeMs, stat.size),
			(e: unknown) => /index unavailable/.test(String((e as Error).message)) && (e as { code?: string }).code === 'EOTELLOOKUP',
		);
	} finally {
		await failing.dispose();
	}
});

test('folder-scan analysis: the worker returns exactly what the in-process analysis returns', async () => {
	const pool = makePool(1);
	const deps = buildInProcessDeps();
	try {
		for (const file of FIXTURES.filter((f) => fs.existsSync(f))) {
			const content = fs.readFileSync(file, 'utf8');
			const [viaWorker, inProcess] = await Promise.all([
				pool.quickAnalyze(file, content, fs.statSync(file).mtimeMs, fs.statSync(file).size),
				quickAnalyzeSessionContent(deps, file, content),
			]);
			assert.deepEqual(normalize(viaWorker), normalize(inProcess), path.basename(file));
		}
	} finally {
		await pool.dispose();
	}
});

test('OTel usage returned by the host reaches the worker analysis result', async () => {
	// The positive half of the host round trip: not just that the worker asks, but that a non-null answer is
	// delivered intact and used (it overrides the ratio-based estimate, exactly as it does in-process).
	const sessionId = '7a8b9c0d-1e2f-4a3b-9c4d-5e6f7a8b9c0d';
	const dir = path.join(scratchDir, 'session-state', sessionId);
	fs.mkdirSync(dir, { recursive: true });
	const eventsFile = path.join(dir, 'events.jsonl');
	fs.writeFileSync(eventsFile, JSON.stringify({ type: 'user.message', timestamp: new Date().toISOString(), data: { content: 'hello' } }) + '\n');
	const stat = fs.statSync(eventsFile);

	const exact: CopilotCliOtelSessionUsage = { modelUsage: {}, actualTokens: 123_456, cacheReadTokens: 789, nanoAiu: 4_000_000_000 };
	const withExact = makePool(1, async () => exact);
	const withoutExact = makePool(1, async () => null);
	try {
		const [enriched, estimated] = await Promise.all([
			withExact.analyze(eventsFile, stat.mtimeMs, stat.size),
			withoutExact.analyze(eventsFile, stat.mtimeMs, stat.size),
		]);
		assert.equal(enriched.actualTokens, 123_456, 'the exact token count from the host replaced the estimate');
		assert.equal(enriched.cacheReadTokens, 789);
		assert.ok((enriched.copilotExactCostDollars ?? 0) > 0, 'the exact cost derived from the host nano-AIU value is present');
		assert.notEqual(estimated.actualTokens, 123_456, 'without the host answer the result is the plain estimate');
		assert.equal(estimated.copilotExactCostDollars, undefined);
	} finally {
		await withExact.dispose();
		await withoutExact.dispose();
	}
});

test('a Copilot CLI session keeps its App / Scout label when analysed in the worker, because the host passes what discovery learned', async () => {
	// Discovery runs only on the host. The worker's adapter never sees it, so without the hint every database-only
	// CLI session would come back labelled as plain terminal CLI (and counted as `cli`, not `cliApp`, usage).
	const sessionId = '8a9b0c1d-2e3f-4a5b-8c6d-7e8f9a0b1c2d';
	const dbSession = path.join(process.env.HOME as string, '.copilot', `session-store.db#${sessionId}`);
	const stat = { size: 1, mtime: new Date() } as unknown as fs.Stats;
	const pool = makePool(1);
	try {
		const label = async (...kinds: Array<'app' | 'scout'>) =>
			(await pool.computeDetails(dbSession, stat.mtime.getTime(), 1, detailsSkeleton(dbSession, stat), kinds)).details.editorName;
		assert.equal(await label(), 'Copilot CLI');
		assert.equal(await label('app'), 'Copilot CLI (App)');
		assert.equal(await label('scout'), 'MS Scout (Copilot CLI)');
		assert.equal(await label('app', 'scout'), 'MS Scout (Copilot CLI)', 'both flags travel; the label keeps Scout precedence');
	} finally {
		await pool.dispose();
	}
});

test('a missing file rejects through the worker with the original ENOENT code', async () => {
	const pool = makePool(1);
	try {
		await assert.rejects(
			pool.analyze(path.join(scratchDir, 'does-not-exist.json'), 1, 1),
			(e: unknown) => (e as { code?: string }).code === 'ENOENT',
		);
	} finally {
		await pool.dispose();
	}
});

test('workspace customization scan: the worker finds exactly what the in-process scan finds', async () => {
	// Layout: a plain workspace with instructions + a prompt, and a multi-root .code-workspace
	// pointing at it — the two shapes ensureWorkspaceCustomizationCached() has to handle.
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'customization-scan-'));
	const pool = makePool(1);
	try {
		const repo = path.join(root, 'repo');
		fs.mkdirSync(path.join(repo, '.github', 'instructions'), { recursive: true });
		fs.mkdirSync(path.join(repo, '.github', 'prompts'), { recursive: true });
		fs.mkdirSync(path.join(repo, 'node_modules', 'dep', '.github'), { recursive: true });
		fs.writeFileSync(path.join(repo, '.github', 'copilot-instructions.md'), '# instructions');
		fs.writeFileSync(path.join(repo, '.github', 'instructions', 'ts.instructions.md'), '---\napplyTo: "**/*.ts"\n---\n');
		fs.writeFileSync(path.join(repo, '.github', 'prompts', 'review.prompt.md'), 'review');
		fs.writeFileSync(path.join(repo, 'node_modules', 'dep', '.github', 'copilot-instructions.md'), 'must be excluded');
		const multiRoot = path.join(root, 'team.code-workspace');
		fs.writeFileSync(multiRoot, JSON.stringify({ folders: [{ path: 'repo' }] }));
		const emptyDir = path.join(root, 'empty');
		fs.mkdirSync(emptyDir);

		for (const workspace of [repo, multiRoot, emptyDir, path.join(root, 'missing')]) {
			const expected = scanCustomizationFilesForWorkspace(workspace);
			const viaWorker = await pool.scanCustomizationFiles(workspace);
			assert.deepEqual(normalize(viaWorker), normalize(expected), `scan of ${path.basename(workspace)}`);
		}
		const repoFiles = await pool.scanCustomizationFiles(repo);
		assert.ok(repoFiles.some((f) => f.relativePath === '.github/copilot-instructions.md'), 'finds the repo instructions');
		assert.ok(repoFiles.every((f) => !f.relativePath.includes('node_modules')), 'honours the excluded directories');
		const multiFiles = await pool.scanCustomizationFiles(multiRoot);
		assert.ok(multiFiles.length > 0, 'a .code-workspace is scanned through its member folders');
	} finally {
		await pool.dispose();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('a request waiting on a slow host lookup does not hold up the requests behind it', async () => {
	// The first Copilot CLI lookup that needs the OTel export can take a minute on the host. Requests that do not
	// need it must keep flowing through the same worker meanwhile (a strictly in-order worker froze a whole refresh).
	const sessionId = '5f6e7d8c-9b0a-4c1d-8e2f-3a4b5c6d7e8f';
	const dir = path.join(scratchDir, 'session-state', sessionId);
	fs.mkdirSync(dir, { recursive: true });
	const slowFile = path.join(dir, 'events.jsonl');
	fs.writeFileSync(slowFile, JSON.stringify({ type: 'user.message', timestamp: new Date().toISOString(), data: { content: 'hi' } }) + '\n');
	const slowStat = fs.statSync(slowFile);
	const plain = FIXTURES[0];
	const plainStat = fs.statSync(plain);

	const pool = makePool(1, async () => { await new Promise((resolve) => setTimeout(resolve, 1200)); return null; });
	try {
		await pool.analyze(plain, 1, 1); // warm the worker
		const startedAt = Date.now();
		const finished: Record<string, number> = {};
		await Promise.all([
			pool.analyze(slowFile, slowStat.mtimeMs, slowStat.size).then(() => { finished.slow = Date.now() - startedAt; }),
			pool.analyze(plain, plainStat.mtimeMs, plainStat.size).then(() => { finished.plain = Date.now() - startedAt; }),
		]);
		assert.ok(finished.slow >= 1100, `the slow lookup really was slow (${finished.slow}ms)`);
		assert.ok(finished.plain < 800, `the plain request must not wait for it (took ${finished.plain}ms)`);
	} finally {
		await pool.dispose();
	}
});

test('the host event loop stays responsive while the worker parses a large session', async () => {
	// The reason the worker exists. A large session (tens of MB of chat JSON) takes the host well over
	// a second of uninterrupted CPU to parse; a click arriving meanwhile would wait that long. Here the
	// parse runs on the worker, and a ticker on this (the "host") thread records how long it was ever
	// starved. The bar is far below the parse time, so a regression that moves parsing back onto this
	// thread fails it, while ordinary CI scheduling noise does not.
	const bigSession = path.join(scratchDir, 'big-session.json');
	const requests = Array.from({ length: 20000 }, (_, i) => ({
		requestId: `req_${i}`,
		modelId: 'copilot/gpt-4o',
		message: { text: `question ${i} ${'lorem ipsum dolor sit amet '.repeat(20)}`, parts: [{ text: `question ${i} ${'lorem ipsum dolor sit amet '.repeat(20)}`, kind: 'text' }] },
		response: [{ kind: 'markdownContent', content: { value: `answer ${i} ${'consectetur adipiscing elit '.repeat(60)}` } }],
		timestamp: Date.now() - (20000 - i) * 1000,
	}));
	fs.writeFileSync(bigSession, JSON.stringify({ requests }));
	const stat = fs.statSync(bigSession);
	assert.ok(stat.size > 15_000_000, `fixture should be large (got ${stat.size} bytes)`);

	const pool = makePool(1);
	const deps = buildInProcessDeps();
	try {
		// Warm the worker (module load, adapter registry) so startup cost is not mistaken for a parse stall.
		await pool.analyze(FIXTURES[0], 1, 1);

		// What the host would have suffered: the same parse in-process, timed as one blocking stretch.
		const inProcessStart = Date.now();
		await analyzeSessionFile(deps, bigSession, stat.mtimeMs, stat.size);
		const inProcessMs = Date.now() - inProcessStart;

		let last = Date.now();
		let worstGap = 0;
		const ticker = setInterval(() => { const now = Date.now(); worstGap = Math.max(worstGap, now - last); last = now; }, 10);
		try {
			last = Date.now();
			const result = await pool.analyze(bigSession, stat.mtimeMs, stat.size);
			assert.equal(result.interactions, 20000);
			// A parse that blocked this thread resolves before the overdue tick can run; count the stretch since
			// the last tick that did, or such a regression would read as "never starved".
			worstGap = Math.max(worstGap, Date.now() - last);
		} finally {
			clearInterval(ticker);
		}
		assert.ok(inProcessMs > 400, `fixture must be heavy enough to matter (in-process parse took only ${inProcessMs}ms)`);
		assert.ok(
			worstGap < Math.max(250, inProcessMs / 3),
			`host loop was starved for ${worstGap}ms while the worker parsed (the same parse in-process takes ${inProcessMs}ms)`,
		);
	} finally {
		await pool.dispose();
	}
});
