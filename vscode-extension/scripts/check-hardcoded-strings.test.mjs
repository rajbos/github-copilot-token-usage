#!/usr/bin/env node
/**
 * Unit tests for check-hardcoded-strings.mjs — the AST-based detector that
 * flags UI-rendering string literals bypassing localize()/t()/vscode.l10n.t().
 *
 * Run with: node --test scripts/check-hardcoded-strings.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { looksProse, scanFile, scanInsightCatalog, hashLine, isLocalizationCall, isConsoleCall, newIndexesBeyondBaseline, violationLineHash, localizationHintForFile } from './check-hardcoded-strings.mjs';

// ── looksProse ───────────────────────────────────────────────────────────────

test('looksProse: prose strings are flagged', () => {
	assert.equal(looksProse('Refresh'), true);
	assert.equal(looksProse('Usage Analysis'), true);
	assert.equal(looksProse('One model solved the task on its own'), true);
});

test('looksProse: numbers, symbols, and empty strings are not prose', () => {
	assert.equal(looksProse(''), false);
	assert.equal(looksProse('42'), false);
	assert.equal(looksProse('%'), false);
	assert.equal(looksProse('{0}%'), false);
});

test('looksProse: URLs and protocol strings are not prose', () => {
	assert.equal(looksProse('https://example.com/docs'), false);
	assert.equal(looksProse('//example.com/path'), false);
	assert.equal(looksProse('vscode-resource://foo/bar'), false);
});

test('looksProse: CSS values are not prose', () => {
	assert.equal(looksProse('16px'), false);
	assert.equal(looksProse('1.5em'), false);
	assert.equal(looksProse('#fff'), false);
	assert.equal(looksProse('#ff00aa'), false);
	assert.equal(looksProse('rgba(0,0,0,0.5)'), false);
	assert.equal(looksProse('var(--foo-bar)'), false);
});

test('looksProse: kebab-case class/id tokens are not prose', () => {
	assert.equal(looksProse('nav-btn-refresh'), false);
	assert.equal(looksProse('usage-analysis-panel'), false);
});

test('looksProse: single-word camelCase identifiers are not prose, but camelCase with spaces is', () => {
	assert.equal(looksProse('myVariableName'), false);
	assert.equal(looksProse('myVariableName is set'), true);
});

test('looksProse: non-Latin scripts (e.g. Chinese) are recognized as prose too', () => {
	assert.equal(looksProse('刷新'), true);
	assert.equal(looksProse('こんにちは'), true);
});

// ── hashLine ─────────────────────────────────────────────────────────────────

test('hashLine: stable for identical content, differs for different content', () => {
	assert.equal(hashLine('el.title = "Refresh";'), hashLine('el.title = "Refresh";'));
	assert.notEqual(hashLine('el.title = "Refresh";'), hashLine('el.title = "Other";'));
});

// ── isLocalizationCall / isConsoleCall ────────────────────────────────────────

test('isLocalizationCall: recognizes localize/t/l10n.t call chains', () => {
	assert.equal(isLocalizationCall('localize'), true);
	assert.equal(isLocalizationCall('localizeFormat'), true);
	assert.equal(isLocalizationCall('t'), true);
	assert.equal(isLocalizationCall('l10n.t'), true);
	assert.equal(isLocalizationCall('vscode.l10n.t'), true);
	assert.equal(isLocalizationCall('somethingElse'), false);
	assert.equal(isLocalizationCall(null), false);
});

test('isConsoleCall: recognizes console.* call chains', () => {
	assert.equal(isConsoleCall('console.log'), true);
	assert.equal(isConsoleCall('console.warn'), true);
	assert.equal(isConsoleCall('console.error'), true);
	assert.equal(isConsoleCall('console.table'), false);
	assert.equal(isConsoleCall(null), false);
});

// ── scanFile (end-to-end AST scan against a real temp .ts file) ─────────────

function withTempFile(content, run) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-hardcoded-strings-test-'));
	const filePath = path.join(dir, 'fixture.ts');
	fs.writeFileSync(filePath, content);
	try {
		return run(filePath);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

test('scanFile: flags a hardcoded .textContent assignment', () => {
	withTempFile(`el.textContent = 'Refresh';\n`, (filePath) => {
		const violations = [];
		scanFile(filePath, new Set(), violations);
		assert.equal(violations.length, 1);
		assert.equal(violations[0].text, 'Refresh');
		assert.match(violations[0].reason, /assignment to \.textContent/);
	});
});

test('scanFile: does not flag a literal passed to localize()/t()/vscode.l10n.t()', () => {
	withTempFile(
		`el.textContent = localize('nav.btnRefresh');\nother.title = t('some.key');\nthird.title = vscode.l10n.t('another.key');\n`,
		(filePath) => {
			const violations = [];
			scanFile(filePath, new Set(), violations);
			assert.equal(violations.length, 0);
		},
	);
});

test('scanFile: does not flag console.log/warn/error arguments', () => {
	withTempFile(`console.log('Refreshing the view now');\nconsole.error('Something went wrong here');\n`, (filePath) => {
		const violations = [];
		scanFile(filePath, new Set(), violations);
		assert.equal(violations.length, 0);
	});
});

test('scanFile: flags prose text content inside an HTML template literal tag', () => {
	withTempFile('const html = `<h2>Usage Analysis</h2>`;\n', (filePath) => {
		const violations = [];
		scanFile(filePath, new Set(), violations);
		assert.equal(violations.length, 1);
		assert.equal(violations[0].text, 'Usage Analysis');
	});
});

test('scanFile: flags aria-label/title attribute values in a template literal, but not class/id attributes', () => {
	withTempFile(
		'const html = `<button class="nav-btn-refresh" id="refresh-btn" aria-label="Refresh the session list"></button>`;\n',
		(filePath) => {
			const violations = [];
			scanFile(filePath, new Set(), violations);
			assert.equal(violations.length, 1);
			assert.equal(violations[0].text, 'Refresh the session list');
		},
	);
});

test('scanFile: an inline "i18n-exempt" comment on the same line suppresses the finding', () => {
	withTempFile(`el.title = 'AI Engineering Fluency'; // i18n-exempt: brand name\n`, (filePath) => {
		const violations = [];
		scanFile(filePath, new Set(), violations);
		assert.equal(violations.length, 0);
	});
});

test('scanFile: an inline "i18n-exempt" comment on the line above suppresses the finding', () => {
	withTempFile(`// i18n-exempt: brand name\nel.title = 'AI Engineering Fluency';\n`, (filePath) => {
		const violations = [];
		scanFile(filePath, new Set(), violations);
		assert.equal(violations.length, 0);
	});
});

test('scanFile: an allowlisted literal is not flagged', () => {
	withTempFile(`el.title = 'AI Engineering Fluency';\n`, (filePath) => {
		const violations = [];
		scanFile(filePath, new Set(['AI Engineering Fluency']), violations);
		assert.equal(violations.length, 0);
	});
});

test('scanFile: numeric/CSS-only literals in a UI-rendering position are not flagged', () => {
	withTempFile(`el.title = '42';\nother.style.width = '16px';\n`, (filePath) => {
		const violations = [];
		scanFile(filePath, new Set(), violations);
		assert.equal(violations.length, 0);
	});
});

test('scanFile: flags a <vscode-button> label the same as a standard HTML tag', () => {
	withTempFile('const html = `<vscode-button>🔄 Refresh</vscode-button>`;\n', (filePath) => {
		const violations = [];
		scanFile(filePath, new Set(), violations);
		assert.equal(violations.length, 1);
		assert.equal(violations[0].text, '🔄 Refresh');
	});
});

test('scanFile: flags tag text embedded in a plain string literal, not only template literals', () => {
	withTempFile('setHtml(btn, "<span>Analyzing…</span>");\n', (filePath) => {
		const violations = [];
		scanFile(filePath, new Set(), violations);
		assert.equal(violations.length, 1);
		assert.equal(violations[0].text, 'Analyzing…');
	});
});

test('scanFile: flags prose that spans a template interpolation inside a tag', () => {
	withTempFile('const html = `<span>${count} turns remaining</span>`;\n', (filePath) => {
		const violations = [];
		scanFile(filePath, new Set(), violations);
		assert.equal(violations.length, 1);
		assert.match(violations[0].text, /turns remaining/);
	});
});

test('scanFile: flags the text argument of el(tag, className, text) and iconHeading(tag, icon, text)', () => {
	withTempFile(
		"const a = el('button', 'toggle', 'Day');\nconst b = iconHeading('h3', 'graph', 'Key Metrics');\n",
		(filePath) => {
			const violations = [];
			scanFile(filePath, new Set(), violations);
			const texts = violations.map((v) => v.text).sort();
			assert.deepEqual(texts, ['Day', 'Key Metrics']);
		},
	);
});

test('scanFile: does not flag a non-text argument position of el()/iconHeading()', () => {
	withTempFile("const a = el('button', 'toggle-day');\n", (filePath) => {
		const violations = [];
		scanFile(filePath, new Set(), violations);
		assert.equal(violations.length, 0);
	});
});

test('scanFile: flags element.setAttribute("title"|"aria-label"|"placeholder", value)', () => {
	withTempFile(
		"docLink.setAttribute('title', 'View official documentation');\ninput.setAttribute('aria-label', 'Search sessions');\n",
		(filePath) => {
			const violations = [];
			scanFile(filePath, new Set(), violations);
			const texts = violations.map((v) => v.text).sort();
			assert.deepEqual(texts, ['Search sessions', 'View official documentation']);
		},
	);
});

test('scanFile: does not flag setAttribute() for an unrelated attribute name', () => {
	withTempFile("docLink.setAttribute('href', 'Some non-attribute prose value');\n", (filePath) => {
		const violations = [];
		scanFile(filePath, new Set(), violations);
		assert.equal(violations.length, 0);
	});
});

test('scanFile: an "i18n-exempt" phrase without a leading // does not suppress the finding', () => {
	withTempFile("el.title = 'this literally contains the phrase i18n-exempt in it';\n", (filePath) => {
		const violations = [];
		scanFile(filePath, new Set(), violations);
		assert.equal(violations.length, 1);
	});
});

// ── newIndexesBeyondBaseline (baseline occurrence-count semantics) ───────────

test('newIndexesBeyondBaseline: a key baselined once still passes once', () => {
	const baseline = new Map([['file.ts::abc', 1]]);
	assert.deepEqual(newIndexesBeyondBaseline(['file.ts::abc'], baseline), [false]);
});

test('newIndexesBeyondBaseline: a second identical occurrence beyond the baselined count is new', () => {
	// Two distinct source lines with identical trimmed content hash the same — the baseline
	// recorded only one occurrence, so a genuinely new duplicate must still be caught.
	const baseline = new Map([['file.ts::abc', 1]]);
	const result = newIndexesBeyondBaseline(['file.ts::abc', 'file.ts::abc'], baseline);
	assert.deepEqual(result, [false, true]);
});

test('newIndexesBeyondBaseline: occurrences up to the baselined count all pass, beyond it are new', () => {
	const baseline = new Map([['file.ts::abc', 2]]);
	const keys = ['file.ts::abc', 'file.ts::abc', 'file.ts::abc'];
	assert.deepEqual(newIndexesBeyondBaseline(keys, baseline), [false, false, true]);
});

test('newIndexesBeyondBaseline: a key absent from the baseline is always new', () => {
	assert.deepEqual(newIndexesBeyondBaseline(['file.ts::zzz'], new Map()), [true]);
});

// ── round-2 fixes: conditional literals, string-literal keys, more sinks, more tags ──────────

test('scanFile: flags both branches of a ternary assigned to a UI-rendering property', () => {
	withTempFile("toggle.title = collapsed ? 'Show details' : 'Hide details';\n", (filePath) => {
		const violations = [];
		scanFile(filePath, new Set(), violations);
		const texts = violations.map((v) => v.text).sort();
		assert.deepEqual(texts, ['Hide details', 'Show details']);
	});
});

test('scanFile: flags an object literal property whose key is a string literal, not just an identifier', () => {
	withTempFile("const cfg = { 'textContent': 'Refresh' };\n", (filePath) => {
		const violations = [];
		scanFile(filePath, new Set(), violations);
		assert.equal(violations.length, 1);
		assert.equal(violations[0].text, 'Refresh');
	});
});

test('scanFile: flags createButton(id, label, appearance) legacy positional form', () => {
	withTempFile("const b = createButton('open-x', 'Take me there', 'secondary');\n", (filePath) => {
		const violations = [];
		scanFile(filePath, new Set(), violations);
		assert.equal(violations.length, 1);
		assert.equal(violations[0].text, 'Take me there');
	});
});

test('scanFile: does not flag createButton(config) single-argument config-object form', () => {
	withTempFile('const b = createButton(BUTTONS["btn-refresh"]);\n', (filePath) => {
		const violations = [];
		scanFile(filePath, new Set(), violations);
		assert.equal(violations.length, 0);
	});
});

test('scanFile: flags document.createTextNode(text)', () => {
	withTempFile("el.append(document.createTextNode(' By Editor'));\n", (filePath) => {
		const violations = [];
		scanFile(filePath, new Set(), violations);
		assert.equal(violations.length, 1);
		assert.equal(violations[0].text, 'By Editor');
	});
});

test('scanFile: flags text in additional VS Code toolkit custom elements (badge, checkbox, dropdown, link, option, text-field)', () => {
	withTempFile(
		'const html = `<vscode-badge>New</vscode-badge><vscode-link>Learn more</vscode-link>`;\n',
		(filePath) => {
			const violations = [];
			scanFile(filePath, new Set(), violations);
			const texts = violations.map((v) => v.text).sort();
			assert.deepEqual(texts, ['Learn more', 'New']);
		},
	);
});

test('scanFile: does not collapse two distinct same-text occurrences on the same line', () => {
	withTempFile('const html = `<button>Refresh</button><button>Refresh</button>`;\n', (filePath) => {
		const violations = [];
		scanFile(filePath, new Set(), violations);
		assert.equal(violations.length, 2);
		assert.equal(violations[0].text, 'Refresh');
		assert.equal(violations[1].text, 'Refresh');
		assert.notEqual(violations[0].offset, violations[1].offset);
	});
});

// ── round-3 fix: nested tags inside a tag body (icon-plus-text pattern) ──────

test('scanFile: flags a tag\'s own trailing text when it also contains a nested (icon) element', () => {
	withTempFile(
		'const html = `<button><span class="codicon codicon-x"></span> Corrections needed</button>`;\n',
		(filePath) => {
			const violations = [];
			scanFile(filePath, new Set(), violations);
			const texts = violations.map((v) => v.text.trim());
			assert.ok(texts.includes('Corrections needed'), `expected "Corrections needed" among: ${JSON.stringify(texts)}`);
		},
	);
});

test('scanFile: still catches a nested tag\'s own real text alongside the outer tag\'s trailing text', () => {
	withTempFile(
		'const html = `<button><span>Icon label</span> and more</button>`;\n',
		(filePath) => {
			const violations = [];
			scanFile(filePath, new Set(), violations);
			const texts = violations.map((v) => v.text.trim());
			assert.ok(texts.includes('Icon label'), `expected "Icon label" among: ${JSON.stringify(texts)}`);
			assert.ok(texts.some((t) => t.includes('and more')), `expected outer trailing text among: ${JSON.stringify(texts)}`);
		},
	);
});

test('scanFile: does not report the nested tag\'s own markup (e.g. the word "span") as if it were prose', () => {
	withTempFile(
		'const html = `<div><span class="codicon codicon-a"></span><span class="codicon codicon-b"></span></div>`;\n',
		(filePath) => {
			const violations = [];
			scanFile(filePath, new Set(), violations);
			assert.equal(violations.length, 0, `expected no violations, got: ${JSON.stringify(violations)}`);
		},
	);
});

test('scanFile: does not report an HTML comment\'s text nested inside a scanned tag as UI prose', () => {
	withTempFile(
		'const html = `<div><!-- Mode Usage Section --></div>`;\n',
		(filePath) => {
			const violations = [];
			scanFile(filePath, new Set(), violations);
			assert.equal(violations.length, 0, `expected no violations, got: ${JSON.stringify(violations)}`);
		},
	);
});

test('scanFile: nested-tag recursion does not hang or corrupt scanning of a later sibling tag', () => {
	withTempFile(
		'const html = `<button><span></span> First</button><button>Second</button>`;\n',
		(filePath) => {
			const violations = [];
			const start = Date.now();
			scanFile(filePath, new Set(), violations);
			assert.ok(Date.now() - start < 2000, 'scanFile should complete quickly, not hang');
			const texts = violations.map((v) => v.text.trim());
			assert.ok(texts.some((t) => t.includes('First')), `expected outer trailing text among: ${JSON.stringify(texts)}`);
			assert.ok(texts.includes('Second'), `expected the later sibling <button>Second</button> to still be found among: ${JSON.stringify(texts)}`);
		},
	);
});

// ── round-4 fixes: concatenation/fallback literals, dedup, exempt marker, multiline offset ──

test('scanFile: flags each static piece of a string-concatenation assignment', () => {
	withTempFile("el.textContent = '✗ Shared key update failed: ' + message;\n", (filePath) => {
		const violations = [];
		scanFile(filePath, new Set(), violations);
		const texts = violations.map((v) => v.text.trim());
		assert.ok(texts.includes('✗ Shared key update failed:'), `expected among: ${JSON.stringify(texts)}`);
	});
});

test('scanFile: flags the fallback literal of a ?? or || sink argument', () => {
	withTempFile("const span = el('span', 'feature-kind', KIND_LABEL[feature.kind] ?? 'New');\n", (filePath) => {
		const violations = [];
		scanFile(filePath, new Set(), violations);
		const texts = violations.map((v) => v.text.trim());
		assert.ok(texts.includes('New'), `expected among: ${JSON.stringify(texts)}`);
	});
	withTempFile("el.title = a.b || 'Fallback title';\n", (filePath) => {
		const violations = [];
		scanFile(filePath, new Set(), violations);
		const texts = violations.map((v) => v.text.trim());
		assert.ok(texts.includes('Fallback title'), `expected among: ${JSON.stringify(texts)}`);
	});
});

test('scanFile: does not double-report an innerHTML assignment whose value already contains a tag', () => {
	withTempFile("el.innerHTML = '<span>Refresh</span>';\n", (filePath) => {
		const violations = [];
		scanFile(filePath, new Set(), violations);
		assert.equal(violations.length, 1, `expected exactly one violation, got: ${JSON.stringify(violations)}`);
		assert.equal(violations[0].text, 'Refresh');
	});
});

test('scanFile: an innerHTML assignment with plain (non-tag) text is still flagged once', () => {
	withTempFile("el.innerHTML = 'Refresh';\n", (filePath) => {
		const violations = [];
		scanFile(filePath, new Set(), violations);
		assert.equal(violations.length, 1);
		assert.equal(violations[0].text, 'Refresh');
	});
});

test('scanFile: flags setHtml(el, text) plain-text payloads (no tag content, so the generic literal scan can\'t catch it)', () => {
	withTempFile("setHtml(root, 'Refresh');\n", (filePath) => {
		const violations = [];
		scanFile(filePath, new Set(), violations);
		assert.equal(violations.length, 1);
		assert.equal(violations[0].text, 'Refresh');
	});
});

test('scanFile: does not double-report setHtml(el, html) when the payload already contains a tag', () => {
	withTempFile('setHtml(root, "<span>Analyzing…</span>");\n', (filePath) => {
		const violations = [];
		scanFile(filePath, new Set(), violations);
		assert.equal(violations.length, 1, `expected exactly one violation, got: ${JSON.stringify(violations)}`);
		assert.equal(violations[0].text, 'Analyzing…');
	});
});

test('scanFile: a URL containing "//" does not activate the i18n-exempt escape hatch', () => {
	withTempFile("el.title = 'Read https://example.com/i18n-exempt for details';\n", (filePath) => {
		const violations = [];
		scanFile(filePath, new Set(), violations);
		assert.equal(violations.length, 1, 'the URL text itself should still be flagged, not silently exempted');
	});
});

test('scanFile: a multiline tag body attributes the violation to the text\'s own line, not the opening tag\'s line', () => {
	// This only exercises line attribution, not exemption: a `//` inside a template literal's own
	// backtick content is part of the rendered string, never a real comment, so there is no way to
	// place a genuine exempt comment next to "Refresh" here specifically (see the "genuine i18n-
	// exempt comment next to one operand of a multi-line concatenation" test below for a shape
	// where that IS achievable, and Known limitation 5 in this script's header for why not here).
	withTempFile(
		[
			'const html = `<button>',
			'  Refresh',
			'</button>`;',
			'',
		].join('\n'),
		(filePath) => {
			const violations = [];
			scanFile(filePath, new Set(), violations);
			assert.equal(violations.length, 1);
			assert.equal(violations[0].line, 2, `expected the violation on the "Refresh" line (2), got line ${violations[0].line}`);
		},
	);
});

test('scanFile: a genuine i18n-exempt comment next to one operand of a multi-line concatenation suppresses only that operand', () => {
	withTempFile(
		[
			"el.textContent =",
			"\t'Prefix ' +",
			"\t// i18n-exempt: brand-specific suffix",
			"\t'BrandName';",
			'',
		].join('\n'),
		(filePath) => {
			const violations = [];
			scanFile(filePath, new Set(), violations);
			const texts = violations.map((v) => v.text.trim());
			assert.ok(texts.includes('Prefix'), `expected the un-exempted operand to remain flagged, got: ${JSON.stringify(violations)}`);
			assert.ok(!texts.includes('BrandName'), `expected the exempted operand to be suppressed, got: ${JSON.stringify(violations)}`);
		},
	);
});

test('scanFile: an i18n-exempt marker embedded in a template literal\'s own rendered text is NOT a real comment and must not suppress the finding', () => {
	// "// i18n-exempt: ..." here is part of the STRING VALUE (it would render to users inside the
	// <button>), not a TypeScript comment — text inside a template literal can never be a real
	// comment. A naive line-text check can't tell the difference; the scanner-based check must.
	withTempFile(
		[
			'const html = `<button>',
			'  Refresh // i18n-exempt: brand-specific label',
			'</button>`;',
			'',
		].join('\n'),
		(filePath) => {
			const violations = [];
			scanFile(filePath, new Set(), violations);
			assert.equal(violations.length, 1, `the marker is inside the string, not a real comment, so this must still be flagged: ${JSON.stringify(violations)}`);
		},
	);
});

test('scanFile: a genuine // i18n-exempt comment on the line before a template literal is respected', () => {
	withTempFile(
		[
			'// i18n-exempt: brand-specific label',
			"el.title = `Refresh`;",
			'',
		].join('\n'),
		(filePath) => {
			const violations = [];
			scanFile(filePath, new Set(), violations);
			assert.equal(violations.length, 0, `expected the exemption to apply, got: ${JSON.stringify(violations)}`);
		},
	);
});

test('scanFile: a genuine /* ... */ block comment carrying the marker is also respected', () => {
	withTempFile("el.title = 'Refresh'; /* i18n-exempt: brand-specific label */\n", (filePath) => {
		const violations = [];
		scanFile(filePath, new Set(), violations);
		assert.equal(violations.length, 0, `expected the exemption to apply, got: ${JSON.stringify(violations)}`);
	});
});

// ── round-5 fix: independent per-run reporting (own-text split, not one combined blob) ──────

test('scanFile: two direct-text runs in the same tag body on different lines are reported as two independent violations', () => {
	withTempFile(
		[
			'const html = `<div>',
			'  First line',
			'  <span></span>',
			'  Second line',
			'</div>`;',
			'',
		].join('\n'),
		(filePath) => {
			const violations = [];
			scanFile(filePath, new Set(), violations);
			const byText = Object.fromEntries(violations.map((v) => [v.text.trim(), v.line]));
			assert.equal(byText['First line'], 2, `expected "First line" on line 2, got: ${JSON.stringify(violations)}`);
			assert.equal(byText['Second line'], 4, `expected "Second line" on line 4, got: ${JSON.stringify(violations)}`);
		},
	);
});

test('scanFile: a baselined run and a genuinely new run in the same tag body hash independently (regression for the combined-blob bug)', () => {
	// Simulates the baseline scenario: "First line" already known, "Second line" added later on a
	// different source line. Each run must get its own hash so adding "Second line" is detectable
	// even though "First line"'s own line is completely unchanged.
	withTempFile(
		[
			'const html = `<div>',
			'  First line',
			'  <span></span>',
			'  Second line',
			'</div>`;',
			'',
		].join('\n'),
		(filePath) => {
			const violations = [];
			scanFile(filePath, new Set(), violations);
			const lines = new Set(violations.map((v) => v.line));
			assert.ok(lines.has(2) && lines.has(4), `expected distinct lines 2 and 4 to both be reportable, got: ${JSON.stringify(violations)}`);
			assert.notEqual(
				hashLine(violations.find((v) => v.line === 2).text),
				hashLine(violations.find((v) => v.line === 4).text),
				'the two runs must not collapse onto an identical hash',
			);
		},
	);
});

test('scanFile: a nested tracked tag\'s full content is excluded from the outer tag\'s own text exactly once (no duplicate report)', () => {
	withTempFile('const html = `<button><span>Refresh</span></button>`;\n', (filePath) => {
		const violations = [];
		scanFile(filePath, new Set(), violations);
		assert.equal(violations.length, 1, `expected exactly one violation (the inner span's), got: ${JSON.stringify(violations)}`);
		assert.equal(violations[0].text, 'Refresh');
		assert.match(violations[0].reason, /<span>/);
	});
});

// ── round-6 fixes: more tags, unbounded recursion, closing-tag fragments, exempt-marker anchor ──

test('scanFile: flags text inside <b> and <code>, both used in the real codebase', () => {
	withTempFile('const html = `<p>Text is <b>bold text here</b> done</p>`;\n', (filePath) => {
		const violations = [];
		scanFile(filePath, new Set(), violations);
		const texts = violations.map((v) => v.text.trim());
		assert.ok(texts.includes('bold text here'), `expected among: ${JSON.stringify(texts)}`);
	});
	withTempFile('const html = `<p>run <code>/graphify</code> now</p>`;\n', (filePath) => {
		const violations = [];
		scanFile(filePath, new Set(), violations);
		const texts = violations.map((v) => v.text.trim());
		assert.ok(texts.includes('/graphify'), `expected among: ${JSON.stringify(texts)}`);
	});
});

test('scanFile: recursion is not capped at one level — a tag nested two levels deep still has its own text caught', () => {
	withTempFile('const html = `<button><span><strong>Refresh</strong></span></button>`;\n', (filePath) => {
		const violations = [];
		const start = Date.now();
		scanFile(filePath, new Set(), violations);
		assert.ok(Date.now() - start < 2000, 'scanFile should complete quickly, not hang');
		const texts = violations.map((v) => v.text.trim());
		assert.ok(texts.includes('Refresh'), `expected among: ${JSON.stringify(texts)}`);
	});
});

test('scanFile: a concatenated HTML-bearing sink\'s lone closing-tag fragment is not misreported as prose', () => {
	// '<button>' + label + '</button>': the first and third operands are pure markup fragments (no
	// static prose), and `label` is a variable — nothing here should be flagged. Specifically,
	// '</button>' must not trip looksProse() via the "button" substring the way a plain HTML_TAG
	// check limited to *opening* tags would miss.
	withTempFile("setHtml(root, '<button>' + label + '</button>');\n", (filePath) => {
		const violations = [];
		scanFile(filePath, new Set(), violations);
		assert.equal(violations.length, 0, `expected no violations, got: ${JSON.stringify(violations)}`);
	});
});

test('scanFile: a comment that merely mentions "i18n-exempt" without it starting the comment does not exempt anything', () => {
	withTempFile("el.title = 'Refresh'; // not i18n-exempt\n", (filePath) => {
		const violations = [];
		scanFile(filePath, new Set(), violations);
		assert.equal(violations.length, 1, `expected the violation to remain, got: ${JSON.stringify(violations)}`);
	});
	withTempFile("el.title = 'Refresh'; // see the i18n-exempt convention above\n", (filePath) => {
		const violations = [];
		scanFile(filePath, new Set(), violations);
		assert.equal(violations.length, 1, `expected the violation to remain, got: ${JSON.stringify(violations)}`);
	});
});

test('scanFile: a text run beginning right after an interpolation hole attributes its offset past the hole, not to it', () => {
	withTempFile('const html = `<button>${count}\n  Refresh\n</button>`;\n', (filePath) => {
		const violations = [];
		scanFile(filePath, new Set(), violations);
		const match = violations.find((v) => v.text.includes('Refresh'));
		assert.ok(match, `expected a violation containing "Refresh", got: ${JSON.stringify(violations)}`);
		assert.equal(match.line, 2, `expected the violation on the "Refresh" line (2), got line ${match.line}`);
	});
});

test('scanFile: a multiline template used directly as an assignment value attributes its report to the prose\'s own line, not the template\'s opening line', () => {
	withTempFile('el.title = `${label}\n  Refresh`;\n', (filePath) => {
		const violations = [];
		scanFile(filePath, new Set(), violations);
		assert.equal(violations.length, 1);
		assert.equal(violations[0].text, 'Refresh');
		assert.equal(violations[0].line, 2, `expected the violation on the "Refresh" line (2), got line ${violations[0].line}`);
	});
});

test('scanFile: catches direct text sitting outside any tag in a raw HTML fragment, without double-reporting it', () => {
	withTempFile(
		"setHtml(tabButton, '<span class=\"codicon codicon-lightbulb\"></span> Insights');\n",
		(filePath) => {
			const violations = [];
			scanFile(filePath, new Set(), violations);
			const matches = violations.filter((v) => v.text.trim() === 'Insights');
			assert.equal(matches.length, 1, `expected "Insights" reported exactly once, got: ${JSON.stringify(violations)}`);
		},
	);
});

// ── round-8 fixes: sentinel strings, escaped attributes, hole-split runs, comments-in-recursion, += ──

test('scanFile: a non-HTML sentinel string starting with "<letter" is not misclassified as a tag fragment', () => {
	withTempFile("if (!ws.workspacePath.startsWith('<unresolved:')) {}\n", (filePath) => {
		const violations = [];
		scanFile(filePath, new Set(), violations);
		assert.equal(violations.length, 0, `expected no violations for a non-HTML sentinel, got: ${JSON.stringify(violations)}`);
	});
});

test('scanFile: an HTML attribute matches even when the wrapping TS string escapes its own quote character', () => {
	withTempFile('const html = "<button aria-label=\\"Refresh\\"></button>";\n', (filePath) => {
		const violations = [];
		scanFile(filePath, new Set(), violations);
		const matches = violations.filter((v) => v.text === 'Refresh');
		assert.equal(matches.length, 1, `expected "Refresh" to be caught despite escaped quotes, got: ${JSON.stringify(violations)}`);
	});
});

test('scanFile: static prose on both sides of an interpolation hole in the same tag body is reported as two independently-anchored violations', () => {
	withTempFile('const html = `<button>Prefix ${count}\n  Refresh</button>`;\n', (filePath) => {
		const violations = [];
		scanFile(filePath, new Set(), violations);
		const prefix = violations.find((v) => v.text.trim() === 'Prefix');
		const refresh = violations.find((v) => v.text === 'Refresh');
		assert.ok(prefix, `expected "Prefix" to be reported, got: ${JSON.stringify(violations)}`);
		assert.ok(refresh, `expected "Refresh" to be reported, got: ${JSON.stringify(violations)}`);
		assert.equal(prefix.line, 1, `expected "Prefix" on line 1, got line ${prefix.line}`);
		assert.equal(refresh.line, 2, `expected "Refresh" on its own line (2), not "Prefix"'s line, got line ${refresh.line}`);
	});
});

test('scanFile: does not descend into a tag typed inside an HTML comment during nested-tag recursion', () => {
	withTempFile('const html = `<div><!-- <span>Refresh</span> --></div>`;\n', (filePath) => {
		const violations = [];
		scanFile(filePath, new Set(), violations);
		assert.equal(violations.length, 0, `expected the commented-out span not to be treated as real markup, got: ${JSON.stringify(violations)}`);
	});
});

test('scanFile: a compound += assignment to a UI-rendering property is flagged the same as a plain assignment', () => {
	withTempFile("element.textContent += 'Refresh';\n", (filePath) => {
		const violations = [];
		scanFile(filePath, new Set(), violations);
		assert.equal(violations.length, 1);
		assert.equal(violations[0].text, 'Refresh');
	});
});

test('scanFile: an HTML attribute value beginning with an interpolation hole attributes its offset past the hole, not to it', () => {
	withTempFile('const html = `<button aria-label="${label}\n  Refresh"></button>`;\n', (filePath) => {
		const violations = [];
		scanFile(filePath, new Set(), violations);
		const match = violations.find((v) => v.text.includes('Refresh'));
		assert.ok(match, `expected a violation containing "Refresh", got: ${JSON.stringify(violations)}`);
		assert.equal(match.line, 2, `expected the violation on the "Refresh" line (2), got line ${match.line}`);
	});
});

// ── round-9 fixes: multiline-run hashing, comment-blanked attributes, wrapper sinks, cross-chunk markup ──

test('violationLineHash: changing only a later line of a multiline direct-text run changes the hash', () => {
	const hashBefore = withTempFile('const html = `<div>\n  Line one\n  Line two\n</div>`;\n', (filePath) => {
		const violations = [];
		scanFile(filePath, new Set(), violations);
		assert.equal(violations.length, 1);
		assert.ok(violations[0].text.includes('\n'), `expected a multiline run, got: ${JSON.stringify(violations[0])}`);
		return violationLineHash(violations[0]);
	});
	const hashAfter = withTempFile('const html = `<div>\n  Line one\n  Line CHANGED\n</div>`;\n', (filePath) => {
		const violations = [];
		scanFile(filePath, new Set(), violations);
		return violationLineHash(violations[0]);
	});
	assert.notEqual(hashBefore, hashAfter, 'expected changing a later line of the same multiline run to change its baseline hash');
});

test('scanFile: an HTML attribute inside a commented-out element is not flagged (comments blanked before attribute scanning too)', () => {
	withTempFile('const html = `<div><!-- <button aria-label="Refresh"></button> --></div>`;\n', (filePath) => {
		const violations = [];
		scanFile(filePath, new Set(), violations);
		assert.equal(violations.length, 0, `expected the commented-out attribute not to be flagged, got: ${JSON.stringify(violations)}`);
	});
});

test('scanFile: recognizes buildCard/buildStatCard/statusBadgeHtml as text-argument sinks', () => {
	withTempFile("buildCard('id', 'Total Sessions', '5');\n", (filePath) => {
		const violations = [];
		scanFile(filePath, new Set(), violations);
		assert.ok(violations.some((v) => v.text === 'Total Sessions'), `expected among: ${JSON.stringify(violations)}`);
	});
	withTempFile("buildStatCard('Synced Tokens', '5');\n", (filePath) => {
		const violations = [];
		scanFile(filePath, new Set(), violations);
		assert.ok(violations.some((v) => v.text === 'Synced Tokens'), `expected among: ${JSON.stringify(violations)}`);
	});
	withTempFile("statusBadgeHtml('❌', 'Error');\n", (filePath) => {
		const violations = [];
		scanFile(filePath, new Set(), violations);
		assert.ok(violations.some((v) => v.text === 'Error'), `expected among: ${JSON.stringify(violations)}`);
	});
});

test('scanFile: a CSS/attribute chunk between two interpolation holes in an innerHTML template is not misreported as prose', () => {
	withTempFile(
		'el.innerHTML = `<div style="color:${color};margin-bottom:12px;">${label}</div>`;\n',
		(filePath) => {
			const violations = [];
			scanFile(filePath, new Set(), violations);
			assert.equal(violations.length, 0, `expected no violations for the CSS fragment, got: ${JSON.stringify(violations)}`);
		},
	);
});

test('scanFile: a ternary nested inside an innerHTML template\'s interpolation hole is still caught despite the enclosing markup', () => {
	withTempFile("el.innerHTML = `<div>${cond ? 'Refresh' : 'Retry'}</div>`;\n", (filePath) => {
		const violations = [];
		scanFile(filePath, new Set(), violations);
		const texts = violations.map((v) => v.text);
		assert.ok(texts.includes('Refresh'), `expected among: ${JSON.stringify(violations)}`);
		assert.ok(texts.includes('Retry'), `expected among: ${JSON.stringify(violations)}`);
	});
});

// ── round-10 fixes: comment-plus-trailing text, attribute hole-splitting, localization hint ──

test('scanFile: visible text following a bare HTML comment (with no other real tag) is still caught', () => {
	withTempFile("const html = '<!-- section --> Refresh';\n", (filePath) => {
		const violations = [];
		scanFile(filePath, new Set(), violations);
		assert.ok(violations.some((v) => v.text === 'Refresh'), `expected "Refresh" among: ${JSON.stringify(violations)}`);
	});
});

test('scanFile: a concatenated HTML-bearing sink still catches prose in an operand whose own opening tag has no closing tag in the same operand', () => {
	withTempFile("setHtml(root, '<button>Refresh' + label + '</button>');\n", (filePath) => {
		const violations = [];
		scanFile(filePath, new Set(), violations);
		assert.ok(violations.some((v) => v.text === 'Refresh'), `expected "Refresh" among: ${JSON.stringify(violations)}`);
	});
});

test('scanFile: an attribute value with static prose on both sides of an interpolation hole is reported as two independently-anchored violations', () => {
	withTempFile(
		'const html = `<button aria-label="Prefix ${count}\n  Refresh"></button>`;\n',
		(filePath) => {
			const violations = [];
			scanFile(filePath, new Set(), violations);
			const prefix = violations.find((v) => v.text.trim() === 'Prefix');
			const refresh = violations.find((v) => v.text === 'Refresh');
			assert.ok(prefix, `expected "Prefix" to be reported, got: ${JSON.stringify(violations)}`);
			assert.ok(refresh, `expected "Refresh" to be reported, got: ${JSON.stringify(violations)}`);
			assert.equal(prefix.line, 1, `expected "Prefix" on line 1, got line ${prefix.line}`);
			assert.equal(refresh.line, 2, `expected "Refresh" on its own line (2), not "Prefix"'s line, got line ${refresh.line}`);
		},
	);
});

test('localizationHintForFile: points webview files at localize(), everything else at t()', () => {
	assert.match(localizationHintForFile('src/webview/usage/main.ts'), /localize\(\)/);
	assert.match(localizationHintForFile('src/backend/configPanel.ts'), /t\(\)/);
	assert.match(localizationHintForFile('src/loadingHtml.ts'), /t\(\)/);
});

// ── scanInsightCatalog (the INSIGHT_CATALOG rule added with issue #2081) ─────

/** Wraps `entries` in a minimal INSIGHT_CATALOG so the scanner's scoping applies. */
function withCatalog(entries, run) {
	return withTempFile(`export const INSIGHT_CATALOG: InsightDefinition[] = [\n${entries}\n];\n`, run);
}

test('scanInsightCatalog: flags a hardcoded title', () => {
	withCatalog(`	{ id: 'x', titleKey: 'insight.x.title', buildBody: (ctx) => ctx.translate('insight.x.body') },
	{ id: 'y', title: 'Add copilot-instructions.md to your repos' },`, (filePath) => {
		const violations = [];
		scanInsightCatalog(filePath, new Set(), violations);
		assert.equal(violations.length, 1);
		assert.equal(violations[0].text, 'Add copilot-instructions.md to your repos');
		assert.match(violations[0].reason, /not passed through translate/);
	});
});

test('scanInsightCatalog: flags prose returned from buildBody, including template chunks', () => {
	withCatalog("	{ id: 'x', buildBody: (ctx) => `You ran ${n} edit-mode interactions in the last 30 days.` },", (filePath) => {
		const violations = [];
		scanInsightCatalog(filePath, new Set(), violations);
		// Both static chunks of the template are reportable prose.
		assert.equal(violations.length, 2);
		assert.equal(violations[0].text, 'You ran');
		assert.equal(violations[1].text, 'edit-mode interactions in the last 30 days.');
	});
});

test('scanInsightCatalog: does not flag localization keys or machine values', () => {
	withCatalog(`	{
		id: 'missing-instructions',
		category: 'customization',
		severity: 'opportunity',
		titleKey: 'insight.missingInstructions.title',
		buildBody: (ctx) => ctx.translate(plural('insight.missingInstructions.body', count), count),
		actionLabelKey: 'insight.action.viewWorkspaceHealth',
		actionCommand: 'aiEngineeringFluency.openHealthTab',
		secondaryActionLabelKey: 'insight.action.askCopilotToFix',
		secondaryActionCommand: 'aiEngineeringFluency.askCopilotAboutCorrections',
	},`, (filePath) => {
		const violations = [];
		scanInsightCatalog(filePath, new Set(), violations);
		assert.deepEqual(violations, []);
	});
});

test('scanInsightCatalog: does not flag literals used in comparisons', () => {
	// Session-log data values, not display text — `unusedTools.filter(t => t.source === 'skill')`.
	withCatalog("	{ id: 'x', appliesTo: (ctx) => ctx.tools.filter(t => t.source === 'skill').length > 0 && ctx.tier !== 'default' },", (filePath) => {
		const violations = [];
		scanInsightCatalog(filePath, new Set(), violations);
		assert.deepEqual(violations, []);
	});
});

test('scanInsightCatalog: ignores prose outside INSIGHT_CATALOG', () => {
	// The rest of insightsEngine.ts is scoring helpers and threshold constants
	// with their own string data; only the catalog is user-facing.
	withTempFile(`const SOMETHING_ELSE = 'This is a helper message, not an insight';\n`, (filePath) => {
		const violations = [];
		scanInsightCatalog(filePath, new Set(), violations);
		assert.deepEqual(violations, []);
	});
});

test('scanInsightCatalog: an inline i18n-exempt comment suppresses the finding', () => {
	withCatalog("	{ id: 'x', title: 'Deliberately English' }, // i18n-exempt: fixture", (filePath) => {
		const violations = [];
		scanInsightCatalog(filePath, new Set(), violations);
		assert.deepEqual(violations, []);
	});
});
