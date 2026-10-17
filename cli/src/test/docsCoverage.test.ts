/**
 * Keeps the user-facing CLI reference (docs/cli/README.md) in step with the
 * commands and options the CLI actually registers. Adding a command or option
 * without documenting it in that command's own section fails this test.
 */

import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import type { Command, Option } from 'commander';

import { createProgram } from '../program';

// The same program the executable builds, so a command or option registered in
// program.ts but missing from the docs fails here without editing this test.
const PROGRAM = createProgram();
const COMMANDS: readonly Command[] = PROGRAM.commands;

function flagOf(option: Option): string | undefined {
	return option.long ?? option.short;
}

// Bundled to cli/out/test/, so the repository root is three levels up.
const DOCS_PATH = path.resolve(__dirname, '..', '..', '..', 'docs', 'cli', 'README.md');

function readDocs(): string {
	return fs.readFileSync(DOCS_PATH, 'utf8');
}

const GLOBAL_OPTIONS_MARKER = 'Global options';

/**
 * The docs for one command: every `### ...` section whose heading names the command
 * in backticks, up to the next heading. A shared section such as
 * "Integration commands: `chart`, `usage-analysis`, `all`" counts for each command it names.
 */
function commandSection(docs: string, name: string): string {
	return docs
		.split(/^(?=#{2,3} )/m)
		.filter(section => section.startsWith('### ') && section.split('\n', 1)[0].includes(`\`${name}\``))
		.join('\n');
}

/** The global-options table: from its intro line to the next horizontal rule. */
function globalOptionsSection(docs: string): string {
	const start = docs.indexOf(GLOBAL_OPTIONS_MARKER);
	if (start < 0) { return ''; }
	const end = docs.indexOf('\n---', start);
	return docs.slice(start, end < 0 ? undefined : end);
}

test('docs/cli/README.md has a section for every CLI command', () => {
	const docs = readDocs();
	assert.ok(COMMANDS.length > 0, 'program registers no commands');
	for (const cmd of COMMANDS) {
		const section = commandSection(docs, cmd.name());
		assert.ok(section, `command "${cmd.name()}" has no "### " section naming it in ${DOCS_PATH}`);
		for (const alias of cmd.aliases()) {
			// Whole word, so `env` isn't satisfied by "environmental".
			assert.ok(new RegExp(`(^|[^\\w-])${alias}([^\\w-]|$)`, 'm').test(section), `alias "${alias}" is not documented in the "${cmd.name()}" section`);
		}
	}
});

test('each command section documents every option of that command', () => {
	const docs = readDocs();
	for (const cmd of COMMANDS) {
		const section = commandSection(docs, cmd.name());
		for (const option of cmd.options) {
			const flag = flagOf(option);
			assert.ok(flag, `option on "${cmd.name()}" has no flag`);
			assert.ok(section.includes(flag), `option "${flag}" is not documented in the "${cmd.name()}" section`);
		}
	}
});

test('the global options table documents every root option', () => {
	const section = globalOptionsSection(readDocs());
	assert.ok(section, `no "${GLOBAL_OPTIONS_MARKER}" table in ${DOCS_PATH}`);
	for (const option of PROGRAM.options) {
		const flag = flagOf(option);
		assert.ok(flag && section.includes(flag), `global option "${flag}" is not in the global options table`);
	}
});

test('commandSection is scoped: a flag documented only for another command does not count', () => {
	const docs = [
		'### `usage` — Report', '`--models`', '',
		'### `stats` — Overview', '`--json`', '',
		'### Integration commands: `chart`, `all`', '`--json`', '',
		'## Configuration', '`--models`',
	].join('\n');
	assert.ok(!commandSection(docs, 'usage').includes('--json'));
	assert.ok(commandSection(docs, 'stats').includes('--json'));
	assert.ok(commandSection(docs, 'all').includes('--json'));
	assert.ok(!commandSection(docs, 'stats').includes('--models'));
	assert.equal(commandSection(docs, 'usage-analysis'), '');
});
