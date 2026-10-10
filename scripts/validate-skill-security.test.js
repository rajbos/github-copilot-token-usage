#!/usr/bin/env node
'use strict';

/**
 * Unit tests for scripts/validate-skill-security.js.
 *
 * Run with:  node --test scripts/validate-skill-security.test.js
 *
 * Every test builds a throwaway skills directory under the OS temp dir, so the
 * real .github/skills tree is never read or modified. The last test runs the
 * validator over the real tree, which is the same check CI runs.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
	REQUIRED_HEADINGS,
	findShippedScripts,
	parseSections,
	validateEntry,
	validateSkillSecurity,
} = require('./validate-skill-security.js');

const SCRIPT = path.join(__dirname, 'validate-skill-security.js');

const VALID_SECURITY_MD = `# Security model: demo\n\n${REQUIRED_HEADINGS.map((h) => `## ${h}\n\nSomething true.\n`).join('\n')}`;

/** Builds a skills dir from `{ skillName: { 'relative/file': content } }` plus a classification. */
function makeSkillsDir(skills, classification) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-security-test-'));
	for (const [name, files] of Object.entries(skills)) {
		for (const [rel, content] of Object.entries(files)) {
			const file = path.join(dir, name, rel);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, content);
		}
	}
	if (classification !== null) {
		fs.writeFileSync(
			path.join(dir, 'skill-security-classification.json'),
			typeof classification === 'string' ? classification : JSON.stringify(classification),
		);
	}
	return dir;
}

function withSkillsDir(skills, classification, fn) {
	const dir = makeSkillsDir(skills, classification);
	try {
		return fn(dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

const classification = (entries) => ({ schemaVersion: 1, skills: entries });
const exempt = { status: 'exempt', reason: 'repo-only, no triggers' };

test('passes when every script-shipping skill is modelled or exempt', () => {
	withSkillsDir({
		modelled: { 'SKILL.md': 'x', 'run.js': '', 'SECURITY.md': VALID_SECURITY_MD },
		exempted: { 'SKILL.md': 'x', 'tool.py': '' },
		guidance: { 'SKILL.md': 'x' },
	}, classification({ exempted: exempt }), (dir) => {
		assert.deepEqual(validateSkillSecurity(dir), []);
	});
});

test('fails a skill with scripts and neither SECURITY.md nor an entry', () => {
	withSkillsDir({ bare: { 'SKILL.md': 'x', 'run.ps1': '' } }, classification({}), (dir) => {
		const errors = validateSkillSecurity(dir);
		assert.equal(errors.length, 1);
		assert.match(errors[0], /^bare: ships scripts \(run\.ps1\)/);
	});
});

test('fails a skill that has a SECURITY.md and is still listed', () => {
	withSkillsDir({
		both: { 'SKILL.md': 'x', 'run.sh': '', 'SECURITY.md': VALID_SECURITY_MD },
	}, classification({ both: exempt }), (dir) => {
		const errors = validateSkillSecurity(dir);
		assert.equal(errors.length, 1);
		assert.match(errors[0], /both: has a SECURITY\.md and is still listed/);
	});
});

test('fails an entry that names a skill directory that does not exist', () => {
	withSkillsDir({}, classification({ ghost: exempt }), (dir) => {
		assert.match(validateSkillSecurity(dir).join('\n'), /ghost: .*does not exist/);
	});
});

test('fails an entry that names a plain file rather than a skill directory', () => {
	withSkillsDir({}, classification({ 'README.md': exempt }), (dir) => {
		fs.writeFileSync(path.join(dir, 'README.md'), 'x');
		assert.match(validateSkillSecurity(dir).join('\n'), /README\.md: .*exists but is not a directory/);
	});
});

test('validateEntry enforces exempt reason, pending issue and status', () => {
	assert.deepEqual(validateEntry('s', exempt), []);
	assert.deepEqual(validateEntry('s', { status: 'pending', issue: 42 }), []);
	assert.match(validateEntry('s', { status: 'exempt' })[0], /non-empty "reason"/);
	assert.match(validateEntry('s', { status: 'exempt', reason: '   ' })[0], /non-empty "reason"/);
	assert.match(validateEntry('s', { status: 'exempt', reason: 5 })[0], /non-empty "reason"/);
	assert.match(validateEntry('s', { status: 'pending' })[0], /positive integer/);
	assert.match(validateEntry('s', { status: 'pending', issue: 0 })[0], /positive integer/);
	assert.match(validateEntry('s', { status: 'pending', issue: -3 })[0], /positive integer/);
	assert.match(validateEntry('s', { status: 'pending', issue: 1.5 })[0], /positive integer/);
	assert.match(validateEntry('s', { status: 'pending', issue: '12' })[0], /positive integer/);
	assert.match(validateEntry('s', { status: 'required' })[0], /must be "exempt" or "pending"/);
	assert.match(validateEntry('s', {})[0], /must be "exempt" or "pending"/);
	assert.match(validateEntry('s', null)[0], /must be an object/);
	assert.match(validateEntry('s', 'exempt')[0], /must be an object/);
});

test('reports invalid entries found through the full validation', () => {
	withSkillsDir({
		a: { 'SKILL.md': 'x', 'a.js': '' },
		b: { 'SKILL.md': 'x', 'b.js': '' },
	}, classification({ a: { status: 'exempt', reason: '' }, b: { status: 'pending', issue: 0 } }), (dir) => {
		const errors = validateSkillSecurity(dir);
		assert.equal(errors.length, 2);
		assert.match(errors[0], /^a: /);
		assert.match(errors[1], /^b: /);
	});
});

test('fails a SECURITY.md that is missing a required heading', () => {
	const missing = VALID_SECURITY_MD.replace('## Known gaps', '## Something else');
	withSkillsDir({
		partial: { 'SKILL.md': 'x', 'run.js': '', 'SECURITY.md': missing },
	}, classification({}), (dir) => {
		const errors = validateSkillSecurity(dir);
		assert.equal(errors.length, 1);
		assert.match(errors[0], /missing the required heading "## Known gaps"/);
	});
});

test('fails a SECURITY.md with an empty required section', () => {
	const empty = VALID_SECURITY_MD.replace('## Known gaps\n\nSomething true.\n', '## Known gaps\n\n');
	withSkillsDir({
		hollow: { 'SKILL.md': 'x', 'run.js': '', 'SECURITY.md': empty },
	}, classification({}), (dir) => {
		assert.match(validateSkillSecurity(dir).join('\n'), /section "## Known gaps" is empty/);
	});
});

test('a section holding only an HTML comment counts as empty', () => {
	const commented = VALID_SECURITY_MD.replace('## Known gaps\n\nSomething true.\n', '## Known gaps\n\n<!-- TODO\nlater -->\n');
	assert.notEqual(commented, VALID_SECURITY_MD);
	assert.match(runOne({ 'SECURITY.md': commented }).join('\n'), /"## Known gaps" is empty/);
});

test('headings match case-insensitively, and a heading inside a code fence does not count', () => {
	const shouty = VALID_SECURITY_MD.replace('## Known gaps', '## KNOWN GAPS');
	assert.deepEqual(runOne({ 'SECURITY.md': shouty }), []);

	const fenced = VALID_SECURITY_MD.replace('## Known gaps\n\nSomething true.\n', '```\n## Known gaps\n```\n');
	assert.match(runOne({ 'SECURITY.md': fenced }).join('\n'), /Known gaps/);
});

/** Validates one skill that ships a script plus the given extra files; the temp dir is removed before returning. */
function runOne(extraFiles) {
	return withSkillsDir({ one: { 'SKILL.md': 'x', 'run.js': '', ...extraFiles } }, classification({}), validateSkillSecurity);
}

test('a SECURITY.md is validated even for a skill with no scripts', () => {
	withSkillsDir({
		docs: { 'SKILL.md': 'x', 'SECURITY.md': '# nothing here\n' },
	}, classification({}), (dir) => {
		assert.equal(validateSkillSecurity(dir).length, REQUIRED_HEADINGS.length);
	});
});

test('test files and test directories do not count as shipped scripts', () => {
	withSkillsDir({
		testsOnly: {
			'SKILL.md': 'x',
			'thing.test.js': '',
			'thing.spec.ts': '',
			'thing.test.integration.js': '',
			'tests/helper.js': '',
			'node_modules/dep/index.js': '',
			'README.md': 'x',
			'data.json': '{}',
		},
	}, classification({}), (dir) => {
		assert.deepEqual(findShippedScripts(path.join(dir, 'testsOnly')), []);
		assert.deepEqual(validateSkillSecurity(dir), []);
	});
});

test('every script extension counts, including nested ones', () => {
	withSkillsDir({
		nested: {
			'SKILL.md': 'x',
			'lib/a.js': '', 'lib/b.mjs': '', 'lib/c.cjs': '', 'lib/d.ts': '',
			'bin/e.ps1': '', 'bin/f.sh': '', 'bin/g.py': '',
		},
	}, classification({}), (dir) => {
		assert.equal(findShippedScripts(path.join(dir, 'nested')).length, 7);
		assert.match(validateSkillSecurity(dir)[0], /^nested: ships scripts/);
	});
});

test('fails when the classification file is missing, unparsable or malformed', () => {
	withSkillsDir({}, null, (dir) => {
		assert.match(validateSkillSecurity(dir)[0], /cannot read or parse/);
	});
	withSkillsDir({}, '{ not json', (dir) => {
		assert.match(validateSkillSecurity(dir)[0], /cannot read or parse/);
	});
	withSkillsDir({}, { schemaVersion: 2, skills: {} }, (dir) => {
		assert.match(validateSkillSecurity(dir).join('\n'), /schemaVersion/);
	});
	withSkillsDir({}, { schemaVersion: 1, skills: [] }, (dir) => {
		assert.match(validateSkillSecurity(dir).join('\n'), /"skills" must be an object/);
	});
	withSkillsDir({}, [], (dir) => {
		assert.match(validateSkillSecurity(dir)[0], /must be a JSON object/);
	});
});

test('parseSections maps level-2 headings to their bodies', () => {
	const sections = parseSections('# Title\n\n## One\na\n\n### sub\nb\n\n## Two ##\nc\n');
	assert.deepEqual([...sections.keys()], ['one', 'two']);
	assert.match(sections.get('one'), /a\n[\s\S]*### sub\nb/);
	assert.equal(sections.get('two').trim(), 'c');
});

test('parseSections closes a fence only on a marker of the same character and at least the same length', () => {
	// A shorter or different-character marker inside a longer fence does not close it.
	const longer = parseSections('## One\n````\n```\n## Hidden\n~~~~\n````\n## Two\nc\n');
	assert.deepEqual([...longer.keys()], ['one', 'two']);
	// A longer marker closes a shorter fence; an info string does not.
	const shorter = parseSections('## One\n```\n```js\n## Hidden\n````\n## Two\nc\n');
	assert.deepEqual([...shorter.keys()], ['one', 'two']);
});

test('CLI exits 1 with a readable message on violations and 0 when clean', () => {
	withSkillsDir({ bare: { 'SKILL.md': 'x', 'run.js': '' } }, classification({}), (dir) => {
		const result = spawnSync(process.execPath, [SCRIPT, '--skills-dir', dir], { encoding: 'utf8' });
		assert.equal(result.status, 1);
		assert.match(result.stderr, /bare: ships scripts/);
	});
	withSkillsDir({ ok: { 'SKILL.md': 'x' } }, classification({}), (dir) => {
		const result = spawnSync(process.execPath, [SCRIPT, '--skills-dir', dir], { encoding: 'utf8' });
		assert.equal(result.status, 0);
		assert.match(result.stdout, /OK/);
	});
});

test('the real .github/skills tree passes', () => {
	const result = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
	assert.equal(result.status, 0, result.stderr);
});
