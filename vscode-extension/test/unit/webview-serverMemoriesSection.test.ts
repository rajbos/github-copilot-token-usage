import test from 'node:test';
import * as assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import type { ServerMemoriesAnalysisView } from '../../../src/types';
import { setFormatLocale } from '../../src/webview/shared/formatUtils';
import { initializeWebviewLocalization } from '../../src/webview/shared/localization';
import {
	buildServerMemoriesSectionHtml,
	sanitizeServerMemoriesAnalysis,
	serverMemoriesMessageForClick,
	wireServerMemoriesButtons,
	type ServerMemoriesMessage,
} from '../../src/webview/usage/serverMemories';

setFormatLocale('en-US');
initializeWebviewLocalization({});

function view(overrides: Partial<ServerMemoriesAnalysisView> = {}): ServerMemoriesAnalysisView {
	return {
		repo: 'owner/name',
		enabled: true,
		truncated: false,
		totalMemories: 30,
		distinctSubjects: 12,
		documentedCount: 3,
		promotionCandidateCount: 5,
		repeatedGroupCount: 1,
		fullyStaleCount: 0,
		topPromotionGroups: [
			{ displaySubject: 'caching', repeatCount: 3, representativeFact: 'Cache via snapshots.', citationCount: 2, subject: 'caching <now> & "x"', fingerprint: 'fp1', prompt: 'Move "caching" <now> & verify' },
			{ displaySubject: 'no prompt', repeatCount: 1, representativeFact: 'Legacy payload row.', citationCount: 1 },
		],
		repoRoot: 'C:\\code\\<repo>',
		workspaceFolderCount: 1,
		promotionTarget: { path: 'AGENTS.md', exists: true },
		documentedMemories: [
			{ subject: 'build', fact: 'Use build.ps1.', files: [{ path: 'AGENTS.md', openable: true }, { path: 'docs/gone.md', missing: true }] },
		],
		...overrides,
	};
}

function render(analysis: ServerMemoriesAnalysisView): Document {
	return new JSDOM(`<body>${buildServerMemoriesSectionHtml(analysis)}</body>`).window.document;
}

test('serverMemories section: names the repository and its checkout, HTML-escaped', () => {
	const html = buildServerMemoriesSectionHtml(view({ repo: 'o/<b>n</b>' }));
	assert.match(html, /<strong>o\/&lt;b&gt;n&lt;\/b&gt;<\/strong>/);
	assert.match(html, /<code>C:\\code\\&lt;repo&gt;<\/code>/);
	assert.match(html, /not specific to this VS Code workspace/);
	assert.match(html, /local notes, per machine and workspace/);
	assert.ok(!html.includes('<repo>'));
});

test('serverMemories section: falls back to the slug alone without a checkout path', () => {
	const html = buildServerMemoriesSectionHtml(view({ repoRoot: undefined }));
	assert.match(html, /Memories GitHub stores for <strong>owner\/name<\/strong>\. Shared by everyone/);
});

test('serverMemories section: multi-root note only when more than one folder is open', () => {
	assert.ok(!buildServerMemoriesSectionHtml(view()).includes('only the first folder'));
	assert.match(buildServerMemoriesSectionHtml(view({ workspaceFolderCount: 3 })), /This workspace has 3 folders; only the first folder backed by a GitHub repository is shown\./);
});

test('serverMemories section: the Ask Copilot button appears only on rows with a prompt', () => {
	const doc = render(view());
	const buttons = doc.querySelectorAll('.server-memory-draft-btn');
	assert.equal(buttons.length, 1);
	// Only the subject key travels; the host rebuilds the prompt and re-probes the target.
	assert.equal(buttons[0].getAttribute('data-subject'), 'caching <now> & "x"');
	assert.equal(buttons[0].getAttribute('data-prompt'), null, 'prompt text is not sent back to the host');
	assert.match(buttons[0].getAttribute('title') ?? '', /AGENTS\.md\. Nothing is sent until you press Enter/);
	assert.match(doc.body.innerHTML, /Suggested file: <code>AGENTS\.md<\/code>\./);
});

test('serverMemories section: an older payload with no prompts gets no action column', () => {
	const html = buildServerMemoriesSectionHtml(view({
		topPromotionGroups: [{ displaySubject: 's', repeatCount: 1, representativeFact: 'f', citationCount: 1 }],
		promotionTarget: undefined,
		documentedMemories: undefined,
		repoRoot: undefined,
	}));
	assert.ok(!html.includes('server-memory-draft-btn'));
	assert.ok(!html.includes('>Action<'));
	assert.ok(!html.includes('Already documented'));
});

test('serverMemories section: a missing target file is labelled as one Copilot will create', () => {
	assert.match(buildServerMemoriesSectionHtml(view({ promotionTarget: { path: 'AGENTS.md', exists: false } })), /does not exist yet/);
});

test('serverMemories section: documented table lists files with Open file only for resolvable ones', () => {
	const doc = render(view());
	const table = doc.querySelector('table.server-memories-documented');
	assert.ok(table);
	assert.match(table.textContent ?? '', /Use build\.ps1\./);
	assert.match(table.textContent ?? '', /docs\/gone\.md/);
	const open = doc.querySelectorAll('.server-memory-open-btn');
	assert.equal(open.length, 1);
	assert.equal(open[0].getAttribute('data-path'), 'AGENTS.md', 'the webview sends a repo-relative path; the host resolves it');
	assert.match(doc.body.textContent ?? '', /Already documented \(showing 1 of 3\)/);
});

test('serverMemories section: clicks map to draft and open messages', () => {
	const doc = render(view());
	assert.deepEqual(serverMemoriesMessageForClick(doc.querySelector('.server-memory-draft-btn')),
		{ command: 'draftServerMemoryPromotion', subject: 'caching <now> & "x"', fingerprint: 'fp1' });
	assert.deepEqual(serverMemoriesMessageForClick(doc.querySelector('.server-memory-open-btn')),
		{ command: 'openServerMemoryCitation', path: 'AGENTS.md' });
	assert.equal(serverMemoriesMessageForClick(doc.querySelector('table')), null);
	assert.equal(serverMemoriesMessageForClick(null), null);
});

test('serverMemories section: error and disabled states are unchanged', () => {
	const errorHtml = buildServerMemoriesSectionHtml(view({ error: 'HTTP 403' }));
	assert.match(errorHtml, /could not be read: HTTP 403/);
	assert.ok(!errorHtml.includes('server-memory-draft-btn'));
	const disabledHtml = buildServerMemoriesSectionHtml(view({ enabled: false }));
	assert.match(disabledHtml, /Memory is turned off/);
	assert.ok(!disabledHtml.includes('Already documented'));
	assert.equal(buildServerMemoriesSectionHtml(null), '');
});

test('sanitizeServerMemoriesAnalysis keeps the new fields and drops malformed ones', () => {
	const sanitized = sanitizeServerMemoriesAnalysis({
		...view(),
		promotionTarget: { path: '../evil.md', exists: true },
		workspaceFolderCount: 'two',
		topPromotionGroups: [{ displaySubject: 's', representativeFact: 'f', prompt: 42 }],
		documentedMemories: [{ subject: 's', fact: 'f', files: [{ path: 'AGENTS.md', openable: 'yes', missing: 1 }, { nope: true }] }, { subject: 1 }],
	});
	assert.ok(sanitized);
	assert.equal(sanitized.promotionTarget, undefined);
	assert.equal(sanitized.workspaceFolderCount, 0);
	assert.equal(sanitized.topPromotionGroups[0].prompt, undefined);
	assert.deepEqual(sanitized.documentedMemories, [{ subject: 's', fact: 'f', files: [{ path: 'AGENTS.md' }] }]);
	assert.equal(sanitized.repoRoot, 'C:\\code\\<repo>');
});

/** Run `fn` with `document` pointing at a JSDOM page holding the rendered section. */
function withSectionDocument(analysis: ServerMemoriesAnalysisView, fn: (doc: Document) => void): void {
	const dom = new JSDOM(`<body>${buildServerMemoriesSectionHtml(analysis)}</body>`);
	const globals = globalThis as { document?: Document };
	const previous = globals.document;
	globals.document = dom.window.document;
	try {
		fn(dom.window.document);
	} finally {
		globals.document = previous;
		dom.window.close();
	}
}

test('wireServerMemoriesButtons posts exactly one message per click', () => {
	withSectionDocument(view(), doc => {
		const posted: ServerMemoriesMessage[] = [];
		wireServerMemoriesButtons(message => posted.push(message));
		(doc.querySelector('.server-memory-draft-btn') as HTMLElement).click();
		(doc.querySelector('.server-memory-open-btn') as HTMLElement).click();
		(doc.querySelector('table') as HTMLElement).click();
		assert.deepEqual(posted, [
			{ command: 'draftServerMemoryPromotion', subject: 'caching <now> & "x"', fingerprint: 'fp1' },
			{ command: 'openServerMemoryCitation', path: 'AGENTS.md' },
		]);
	});
});

test('wireServerMemoriesButtons is idempotent across repeated renders of the same section', () => {
	withSectionDocument(view(), doc => {
		const posted: ServerMemoriesMessage[] = [];
		wireServerMemoriesButtons(message => posted.push(message));
		wireServerMemoriesButtons(message => posted.push(message));
		wireServerMemoriesButtons(message => posted.push(message));
		(doc.querySelector('.server-memory-draft-btn') as HTMLElement).click();
		assert.equal(posted.length, 1, 'a second wiring must not stack another listener');
	});
});

test('wireServerMemoriesButtons does nothing when the section is not rendered', () => {
	withSectionDocument(view({ error: 'x' }), doc => {
		doc.getElementById('section-server-memories')?.remove();
		assert.doesNotThrow(() => wireServerMemoriesButtons(() => assert.fail('nothing to click')));
	});
});

test('serverMemories section: a row with a prompt but no subject key gets no button', () => {
	// An older host projected prompts without subject keys; such a button could not be rebuilt
	// host-side, so it is not offered.
	const html = buildServerMemoriesSectionHtml(view({
		topPromotionGroups: [{ displaySubject: 's', repeatCount: 1, representativeFact: 'f', citationCount: 1, prompt: 'p' }],
	}));
	assert.ok(!html.includes('server-memory-draft-btn'));
});

test('serverMemories section: both tables use the shared data-table component', () => {
	const doc = render(view());
	assert.ok(doc.getElementById('paged-table-root-server-memories-promotion') ?? doc.querySelector('[id*="server-memories-promotion"]'));
	assert.ok(doc.querySelector('[id*="server-memories-documented"]'));
});

test('serverMemories section: summary counts of one use the singular verb', () => {
	const one = buildServerMemoriesSectionHtml(view({ documentedCount: 1, fullyStaleCount: 1, documentedMemories: [] }));
	assert.match(one, /1 already cites an instruction file/);
	assert.match(one, /1 cites only files that no longer exist/);
	const many = buildServerMemoriesSectionHtml(view({ documentedCount: 3, fullyStaleCount: 2 }));
	assert.match(many, /3 already cite an instruction file/);
	assert.match(many, /2 cite only files that no longer exist/);
});

test('serverMemories section: a missing cited file is marked and gets no Open file button', () => {
	const doc = render(view());
	const missing = doc.querySelectorAll('.server-memory-missing');
	assert.equal(missing.length, 1);
	assert.match(missing[0].parentElement?.textContent ?? '', /docs\/gone\.md\s*\(missing\)/);
	assert.equal(doc.querySelectorAll('.server-memory-open-btn').length, 1);
	assert.match(doc.body.textContent ?? '', /Keep memories whose cited file is marked missing/);
});

test('serverMemories section: a row without a fingerprint gets no button', () => {
	const html = buildServerMemoriesSectionHtml(view({
		topPromotionGroups: [{ displaySubject: 's', repeatCount: 1, representativeFact: 'f', citationCount: 1, subject: 's', prompt: 'p' }],
	}));
	assert.ok(!html.includes('server-memory-draft-btn'));
});

test('serverMemories section: a click on a text node resolves to its button, and non-elements are safe', () => {
	const doc = render(view());
	const label = doc.querySelector('.server-memory-draft-btn')?.firstChild;
	assert.ok(label && label.nodeType === 3, 'the button label is a Text node');
	assert.deepEqual(serverMemoriesMessageForClick(label), { command: 'draftServerMemoryPromotion', subject: 'caching <now> & "x"', fingerprint: 'fp1' });
	assert.equal(serverMemoriesMessageForClick(doc), null, 'a Document has no closest() and no parent element');
	assert.equal(serverMemoriesMessageForClick({} as EventTarget), null);
});

test('wireServerMemoriesButtons handles a click dispatched on a text node', () => {
	withSectionDocument(view(), doc => {
		const posted: ServerMemoriesMessage[] = [];
		wireServerMemoriesButtons(message => posted.push(message));
		const label = doc.querySelector('.server-memory-open-btn')?.firstChild;
		assert.ok(label);
		label.dispatchEvent(new doc.defaultView!.MouseEvent('click', { bubbles: true }));
		assert.deepEqual(posted, [{ command: 'openServerMemoryCitation', path: 'AGENTS.md' }]);
	});
});

test('serverMemories section: error and disabled states still name the repository and checkout', () => {
	for (const state of [view({ error: 'HTTP 403' }), view({ enabled: false })]) {
		const html = buildServerMemoriesSectionHtml(state);
		assert.match(html, /<strong>owner\/name<\/strong>/);
		assert.match(html, /C:\\code\\&lt;repo&gt;/);
	}
});
