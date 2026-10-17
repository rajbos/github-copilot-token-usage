#!/usr/bin/env node
'use strict';

/**
 * Unit tests for the credential-safety and remote-parsing helpers in
 * scripts/fetch-copilot-memories.js.
 *
 * Run with:  node --test scripts/fetch-copilot-memories.test.js
 *
 * The script promises in its header that it never prints a token or a credential. That
 * promise is only as good as `redactRemoteUrl()`, and a git remote is exactly the place an
 * embedded credential hides, so the redaction is pinned here rather than trusted. Requiring
 * the script is safe: it guards `main()` behind `require.main === module`, so importing it
 * performs no network request.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { redactRemoteUrl, parseRepoFromRemote, isValidRepoSlug, sanitizeForDisplay, memoryUrl, parseArgs } = require('./fetch-copilot-memories.js');

test('redactRemoteUrl strips an embedded password from an https remote', () => {
	// The reported case: a non-GitHub remote carrying real credentials, quoted back in an
	// error message. The secret must not survive into anything printable.
	const redacted = redactRemoteUrl('https://user:secret@example.com/owner/repo');
	assert.ok(!redacted.includes('secret'), `password leaked: ${redacted}`);
	assert.ok(!redacted.includes('user:'), `username leaked: ${redacted}`);
	assert.equal(redacted, 'https://***@example.com/owner/repo');
});

test('redactRemoteUrl strips a token used as the username', () => {
	// `https://<token>@github.com/...` is how a PAT is usually embedded, with no password half.
	const redacted = redactRemoteUrl('https://ghp_exampletoken@github.com/o/r.git');
	assert.ok(!redacted.includes('ghp_exampletoken'), `token leaked: ${redacted}`);
	assert.equal(redacted, 'https://***@github.com/o/r.git');
});

test('redactRemoteUrl masks the scp-style user without mangling the path', () => {
	assert.equal(redactRemoteUrl('git@github.com:o/r.git'), '***@github.com:o/r.git');
});

test('redactRemoteUrl strips a credential carried in the query or fragment', () => {
	// Userinfo is not the only hiding place: a token in `?token=` or `#` leaks just as badly,
	// and a remote needs neither for the host/owner/repo an error message is about.
	const query = redactRemoteUrl('https://gitlab.com/o/r?token=secret');
	assert.ok(!query.includes('secret'), `query credential leaked: ${query}`);
	assert.equal(query, 'https://gitlab.com/o/r');

	const fragment = redactRemoteUrl('https://gitlab.com/o/r#secret');
	assert.ok(!fragment.includes('secret'), `fragment credential leaked: ${fragment}`);

	// And on the scp-style branch, which does not go through the URL parser.
	const scp = redactRemoteUrl('git@host.test:o/r.git?token=secret');
	assert.ok(!scp.includes('secret'), `scp query credential leaked: ${scp}`);
});

test('redactRemoteUrl leaves a credential-free remote readable', () => {
	// Redaction must not cost diagnosability in the ordinary case.
	assert.equal(redactRemoteUrl('https://github.com/o/r'), 'https://github.com/o/r');
});

test('redactRemoteUrl drops a remote it cannot parse rather than guessing', () => {
	// An unparseable string cannot be redacted with confidence, so none of it is shown.
	assert.equal(redactRemoteUrl('not a url at all'), '<unparseable remote URL>');
});

test('parseRepoFromRemote strips a credential-bearing suffix from the slug', () => {
	// The scp-style branch skips the URL parser, so without the strip this yields a "name"
	// of `repo.git?token=secret` — which then goes into the API request URL, past the
	// redaction that only guards what gets printed.
	assert.equal(parseRepoFromRemote('git@github.com:owner/repo.git?token=secret'), 'owner/repo');
	assert.equal(parseRepoFromRemote('https://github.com/owner/repo.git?token=secret'), 'owner/repo');
	assert.equal(parseRepoFromRemote('git@github.com:owner/repo#secret'), 'owner/repo');
});

test('parseRepoFromRemote rejects transports that are not git remotes', () => {
	// Same guard as the shared parser: the two authenticated entry points must not diverge.
	assert.equal(parseRepoFromRemote('file://github.com/owner/repo'), undefined);
	assert.equal(parseRepoFromRemote('ftp://github.com/owner/repo'), undefined);
	assert.equal(parseRepoFromRemote('https://github.com/owner/repo'), 'owner/repo');
	assert.equal(parseRepoFromRemote('ssh://git@github.com/owner/repo.git'), 'owner/repo');
	assert.equal(parseRepoFromRemote('git@github.com:owner/repo.git'), 'owner/repo');
});

test('parseRepoFromRemote matches the host exactly and validates each segment', () => {
	assert.equal(parseRepoFromRemote('git@github.com:rajbos/ai-engineering-fluency.git'), 'rajbos/ai-engineering-fluency');
	assert.equal(parseRepoFromRemote('https://github.com/rajbos/ai_engineering.fluency'), 'rajbos/ai_engineering.fluency');
	// A substring host match would accept these and query an unrelated repository.
	assert.equal(parseRepoFromRemote('https://notgithub.com/owner/repo'), undefined);
	assert.equal(parseRepoFromRemote('https://github.com.evil.test/owner/repo'), undefined);
	// Deeper paths are URLs into a repo, not a remote; odd characters could steer the request.
	assert.equal(parseRepoFromRemote('https://github.com/owner/repo/blob/main/x.ts'), undefined);
	assert.equal(parseRepoFromRemote('git@github.com:owner/re%2fpo'), undefined);
	assert.equal(parseRepoFromRemote('git@github.com:owner/..'), undefined);
});

test('isValidRepoSlug gates the --repo value the same way a remote is gated', () => {
	// `--repo` skips parseRepoFromRemote() entirely but reaches the same URL builder, so a
	// malformed value would otherwise steer the authenticated request.
	assert.equal(isValidRepoSlug('rajbos/ai-engineering-fluency'), true);
	assert.equal(isValidRepoSlug('owner/repo?token=secret'), false);
	assert.equal(isValidRepoSlug('owner/repo/extra'), false);
	assert.equal(isValidRepoSlug('owner'), false);
	assert.equal(isValidRepoSlug('owner/..'), false);
});

test('a rejected --repo value is never echoed back', () => {
	// Validating the value and then printing it would leak exactly the credential the
	// rejection just refused to send — the same mistake redactRemoteUrl() exists to prevent
	// for remotes, one step further along.
	const { parseArgs: _parseArgs } = require('./fetch-copilot-memories.js');
	assert.ok(_parseArgs);
	const src = require('node:fs').readFileSync(require('node:path').join(__dirname, 'fetch-copilot-memories.js'), 'utf8');
	const thrown = /--repo must be owner\/name\.'\)/.test(src);
	assert.ok(thrown, 'the --repo rejection must use a generic message');
	assert.ok(!/--repo must be owner\/name, got/.test(src), 'the rejection must not interpolate the value');
});

test('the token lookup is pinned to github.com, not the CLI default host', () => {
	// `gh auth token` honours GH_HOST and the active CLI context, so on a machine configured
	// for GHES an unpinned lookup returns an Enterprise token — which this script would then
	// send to api.githubcopilot.com, a host it was never issued for.
	const src = require('node:fs').readFileSync(require('node:path').join(__dirname, 'fetch-copilot-memories.js'), 'utf8');
	assert.ok(
		/\['auth', 'token', '--hostname', 'github\.com'\]/.test(src),
		'the token lookup must name the public host explicitly',
	);
	assert.ok(!/\['auth', 'token'\]/.test(src), 'no unpinned token lookup may remain');
});

test('sanitizeForDisplay strips terminal control sequences', () => {
	// Memory text is agent-written from repository content, and HTTP error bodies come from the
	// network, so either can carry an ESC/OSC sequence. Printed verbatim it can set the
	// terminal title, drive the clipboard, or hide text that is really there — this probe is
	// authenticated and may well be pointed at a shared repository.
	const ESC = String.fromCharCode(27);
	const BEL = String.fromCharCode(7);
	const hostile = `fact${ESC}]0;PWNED${BEL} and${ESC}[31m red`;
	const clean = sanitizeForDisplay(hostile);
	const hasControl = (v) => v.split('').some((ch) => {
		const code = ch.charCodeAt(0);
		return code < 32 || (code >= 127 && code <= 159);
	});
	assert.ok(!hasControl(clean), `control characters survived: ${JSON.stringify(clean)}`);
	assert.equal(clean, 'fact ]0;PWNED and [31m red');
	// Ordinary text keeps its meaning.
	assert.equal(sanitizeForDisplay('  a normal — fact  '), 'a normal — fact');
});

test('every raw write in the report path goes through the sanitizer', () => {
	// A source scan because the printing happens against a live response. The memory fields
	// were guarded first and the HTTP error bodies were missed, so this pins the whole set
	// rather than the fields alone.
	const src = require('node:fs').readFileSync(require('node:path').join(__dirname, 'fetch-copilot-memories.js'), 'utf8');
	for (const field of ['repo)', 'memory.subject', 'memory.fact', 'citations)', 'memory.reason', 'enabledResult.error', 'recentResult.error', 'error.message']) {
		assert.ok(
			src.includes(`sanitizeForDisplay(${field}`),
			`${field} must be written through sanitizeForDisplay()`,
		);
	}
});

test('both authenticated requests are bounded by a timeout', () => {
	// A stalled socket would otherwise leave this diagnostic waiting forever with nothing on
	// screen — the worst possible behaviour for a script whose job is to report what the API
	// returned. The shared module was bounded first and this mirrored copy was missed, so the
	// assertion is on the request path rather than on one call.
	const src = require('node:fs').readFileSync(require('node:path').join(__dirname, 'fetch-copilot-memories.js'), 'utf8');
	assert.ok(/AbortSignal\?\.timeout === 'function'/.test(src), 'the signal must degrade where AbortSignal.timeout is absent');
	assert.ok(/signal: typeof AbortSignal/.test(src), 'the fetch must carry a signal');
	// Every fetch call site must carry the signal, not just some line of the file: the first
	// version of this assertion matched the bounded code too and so proved nothing.
	const callSites = [...src.matchAll(/fetch\(/g)].map((m) => m.index);
	assert.ok(callSites.length > 0, 'expected at least one fetch call');
	for (const at of callSites) {
		const call = src.slice(at, src.indexOf('});', at));
		assert.ok(call.includes('signal:'), `an unbounded fetch remains at offset ${at}`);
	}
});

test('memoryUrl builds the v0 routes and adds limit only when given', () => {
	assert.equal(
		memoryUrl('o/n', 'enabled'),
		'https://api.githubcopilot.com/agents/swe/internal/memory/v0/o/n/enabled',
	);
	assert.equal(
		memoryUrl('o/n', 'recent', 20),
		'https://api.githubcopilot.com/agents/swe/internal/memory/v0/o/n/recent?limit=20',
	);
});

test('parseArgs rejects a non-positive or non-integer limit', () => {
	assert.deepEqual(parseArgs(['--repo', 'o/n', '--json']), { repo: 'o/n', limit: 20, json: true });
	assert.throws(() => parseArgs(['--limit', '0']), /positive integer/);
	// A trailing flag with no value must be rejected, not silently ignored: main() falls back
	// to the origin remote when `repo` is unset, so `--repo` at the end of the line would
	// report on the current checkout instead of the repository the user meant to name.
	assert.throws(() => parseArgs(['--repo']), /--repo requires a value/);
	assert.throws(() => parseArgs(['--json', '--repo']), /--repo requires a value/);
	assert.throws(() => parseArgs(['--limit']), /--limit requires a value/);
	// And a valid trailing value still parses.
	assert.deepEqual(parseArgs(['--repo', 'o/n']), { repo: 'o/n', limit: 20, json: false });
	assert.throws(() => parseArgs(['--limit', 'abc']), /positive integer/);
	assert.throws(() => parseArgs(['--nope']), /Unknown argument/);
});
