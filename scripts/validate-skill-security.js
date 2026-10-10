#!/usr/bin/env node
'use strict';

/**
 * Skill security classification gate.
 *
 * A skill under `.github/skills/<name>/` that ships scripts is either
 *   - modelled: it carries a `SECURITY.md` next to its `SKILL.md`, or
 *   - declared in `.github/skills/skill-security-classification.json` as
 *     `exempt` (with a reason) or `pending` (with a tracking issue number).
 * Never both, and never neither. The triggers that make a skill require a
 * `SECURITY.md` are listed in AGENTS.md ("Skill security classification").
 *
 * Always checks every skill, not just changed ones, so editing only the
 * classification file cannot leave a stale entry behind.
 *
 * Usage:
 *   node scripts/validate-skill-security.js [--skills-dir <dir>]
 *
 * Exit codes: 0 = consistent, 1 = violations found.
 */

const fs = require('fs');
const path = require('path');

const CLASSIFICATION_FILE = 'skill-security-classification.json';
const SCHEMA_VERSION = 1;
const SCRIPT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.ps1', '.sh', '.py']);
// Never descended into: dependencies, VCS data, and test directories.
const SKIPPED_DIRS = new Set(['node_modules', '.git', 'tests']);
const TEST_FILE = /\.(test|spec)\./i;

/** The sections of the lightweight SECURITY.md template. Keep in step with AGENTS.md. */
const REQUIRED_HEADINGS = [
	'What the scripts do and talk to',
	'Credentials used and where they come from',
	'Untrusted inputs parsed',
	'What it writes and where',
	'External programs run',
	'Mitigations in the code',
	'Known gaps',
];

/** Shipped, non-test script files of a skill, as paths relative to the skill dir. */
function findShippedScripts(skillDir) {
	const found = [];
	const walk = (dir, rel) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const relPath = rel ? `${rel}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				if (!SKIPPED_DIRS.has(entry.name)) {
					walk(path.join(dir, entry.name), relPath);
				}
			} else if (
				entry.isFile()
				&& SCRIPT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
				&& !TEST_FILE.test(entry.name)
			) {
				found.push(relPath);
			}
		}
	};
	walk(skillDir, '');
	return found.sort();
}

/**
 * Level-2 headings of a markdown document mapped to their body text. A heading
 * inside fenced code does not start a section; the fenced lines themselves stay
 * part of the current section's body, so a section holding only a code block counts as written.
 */
function parseSections(markdown) {
	const sections = new Map();
	let current = null;
	let fence = null;
	for (const line of markdown.split(/\r?\n/)) {
		const fenceMatch = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
		if (fenceMatch) {
			const marker = fenceMatch[1];
			if (!fence) { fence = marker; }
			// A fence closes only on the same character, at least as long, with nothing after it.
			else if (marker[0] === fence[0] && marker.length >= fence.length && fenceMatch[2].trim() === '') { fence = null; }
		}
		const heading = !fence && /^##\s+(.+?)\s*#*\s*$/.exec(line);
		if (heading) {
			current = heading[1].trim().toLowerCase();
			sections.set(current, '');
		} else if (current !== null) {
			sections.set(current, `${sections.get(current)}${line}\n`);
		}
	}
	return sections;
}

/** Removes HTML comments, repeating until none remain so nested markers such as `<!<!---->--` cannot survive. */
function stripHtmlComments(text) {
	let previous;
	do {
		previous = text;
		text = text.replace(/<!--[\s\S]*?-->/g, '');
	} while (text !== previous);
	return text;
}

function validateSecurityMd(skill, content) {
	const errors = [];
	const sections = parseSections(content);
	for (const heading of REQUIRED_HEADINGS) {
		const body = sections.get(heading.toLowerCase());
		if (body === undefined) {
			errors.push(`${skill}: SECURITY.md is missing the required heading "## ${heading}"`);
		} else if (stripHtmlComments(body).trim() === '') {
			errors.push(`${skill}: SECURITY.md section "## ${heading}" is empty (write "None." if it genuinely does not apply)`);
		}
	}
	return errors;
}

function validateEntry(skill, entry) {
	if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
		return [`${skill}: classification entry must be an object with a "status"`];
	}
	if (entry.status === 'exempt') {
		if (typeof entry.reason !== 'string' || entry.reason.trim() === '') {
			return [`${skill}: "exempt" entry needs a non-empty "reason"`];
		}
		return [];
	}
	if (entry.status === 'pending') {
		if (!Number.isInteger(entry.issue) || entry.issue <= 0) {
			return [`${skill}: "pending" entry needs "issue" set to a positive integer issue number`];
		}
		return [];
	}
	return [`${skill}: classification status must be "exempt" or "pending", got ${JSON.stringify(entry.status)}`];
}

function loadClassification(skillsDir) {
	const file = path.join(skillsDir, CLASSIFICATION_FILE);
	let parsed;
	try {
		parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch (error) {
		return { errors: [`${CLASSIFICATION_FILE}: cannot read or parse (${error.message})`] };
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return { errors: [`${CLASSIFICATION_FILE}: must be a JSON object`] };
	}
	const errors = [];
	if (parsed.schemaVersion !== SCHEMA_VERSION) {
		errors.push(`${CLASSIFICATION_FILE}: "schemaVersion" must be ${SCHEMA_VERSION}`);
	}
	if (!parsed.skills || typeof parsed.skills !== 'object' || Array.isArray(parsed.skills)) {
		errors.push(`${CLASSIFICATION_FILE}: "skills" must be an object keyed by skill directory name`);
		return { errors };
	}
	return { errors, skills: parsed.skills };
}

/** Checks every skill under `skillsDir`; returns the list of violations (empty = pass). */
function validateSkillSecurity(skillsDir) {
	const { errors, skills: entries } = loadClassification(skillsDir);
	if (!entries) { return errors; }

	const skillNames = fs.readdirSync(skillsDir, { withFileTypes: true })
		.filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
		.map((d) => d.name)
		.sort();

	const skillNameSet = new Set(skillNames);
	for (const name of Object.keys(entries)) {
		if (skillNameSet.has(name)) continue;
		const exists = fs.existsSync(path.join(skillsDir, name));
		errors.push(`${name}: classification entry names a skill directory that ${exists ? 'exists but is not a directory' : 'does not exist'}`);
	}

	for (const skill of skillNames) {
		const skillDir = path.join(skillsDir, skill);
		const securityPath = path.join(skillDir, 'SECURITY.md');
		const hasSecurityMd = fs.existsSync(securityPath);
		const entry = Object.prototype.hasOwnProperty.call(entries, skill) ? entries[skill] : undefined;
		const classified = entry !== undefined;

		if (classified) { errors.push(...validateEntry(skill, entry)); }

		if (hasSecurityMd) {
			if (classified) {
				errors.push(`${skill}: has a SECURITY.md and is still listed in ${CLASSIFICATION_FILE}; remove the entry`);
			}
			errors.push(...validateSecurityMd(skill, fs.readFileSync(securityPath, 'utf8')));
		} else if (!classified) {
			const scripts = findShippedScripts(skillDir);
			if (scripts.length > 0) {
				errors.push(
					`${skill}: ships scripts (${scripts.slice(0, 3).join(', ')}${scripts.length > 3 ? ', ...' : ''}) but has neither a SECURITY.md nor an entry in ${CLASSIFICATION_FILE}`,
				);
			}
		}
	}
	return errors;
}

function main(argv) {
	const dirFlag = argv.indexOf('--skills-dir');
	const skillsDir = path.resolve(
		dirFlag !== -1 && argv[dirFlag + 1]
			? argv[dirFlag + 1]
			: path.join(__dirname, '..', '.github', 'skills'),
	);
	if (!fs.existsSync(skillsDir)) {
		console.error(`Skills directory not found: ${skillsDir}`);
		return 1;
	}
	const errors = validateSkillSecurity(skillsDir);
	if (errors.length > 0) {
		console.error('Skill security classification failed:');
		for (const error of errors) { console.error(`  - ${error}`); }
		console.error('See "Skill security classification" in AGENTS.md.');
		return 1;
	}
	console.log('Skill security classification OK.');
	return 0;
}

if (require.main === module) {
	process.exitCode = main(process.argv.slice(2));
}

module.exports = {
	REQUIRED_HEADINGS,
	findShippedScripts,
	parseSections,
	validateSecurityMd,
	validateEntry,
	validateSkillSecurity,
};
