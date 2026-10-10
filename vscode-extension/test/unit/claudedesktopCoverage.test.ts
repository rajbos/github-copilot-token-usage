import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { ClaudeDesktopDataAccess } from '../../../src/claudedesktop';

/**
 * Exercises getDesktopLocalCoverage against a real temporary directory tree.
 *
 * The session base directory is overridden rather than derived from the OS so the algorithm is
 * covered identically on every platform (the real derivation returns nothing outside Windows/macOS).
 */
class TestClaudeDesktop extends ClaudeDesktopDataAccess {
	constructor(private readonly dirs: string[]) { super(); }
	override getDesktopSessionDirs(): string[] { return this.dirs; }
}

interface Fixture {
	root: string;
	sessionsDir: string;
	machineDir: string;
	projectsDir: string;
	cleanup: () => void;
}

function makeFixture(): Fixture {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctt-desktop-coverage-'));
	// Mirrors the real layout: <base>/<app-uuid>/<machine-uuid>/local_<id>.json
	const sessionsDir = path.join(root, 'claude-code-sessions');
	const machineDir = path.join(sessionsDir, 'app-uuid', 'machine-uuid');
	const projectsDir = path.join(root, 'projects');
	fs.mkdirSync(machineDir, { recursive: true });
	fs.mkdirSync(projectsDir, { recursive: true });
	return {
		root, sessionsDir, machineDir, projectsDir,
		cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
	};
}

function writeMetadata(fx: Fixture, id: string, cliSessionId?: string): void {
	fs.writeFileSync(
		path.join(fx.machineDir, `local_${id}.json`),
		JSON.stringify({ sessionId: id, cliSessionId, title: `Session ${id}` })
	);
}

/** Write the transcript the modern layout expects: ~/.claude/projects/<slug>/<cliSessionId>.jsonl */
function writeSharedTranscript(fx: Fixture, slug: string, cliSessionId: string): void {
	const dir = path.join(fx.projectsDir, slug);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, `${cliSessionId}.jsonl`), '{"type":"user"}\n');
}

test('getDesktopLocalCoverage: resolves transcripts in the shared ~/.claude/projects tree', async () => {
	const fx = makeFixture();
	try {
		writeMetadata(fx, 'a', 'cli-a');
		writeSharedTranscript(fx, 'C--Users-dev-repo', 'cli-a');

		const access = new TestClaudeDesktop([fx.sessionsDir]);
		assert.deepEqual(await access.getDesktopLocalCoverage(fx.projectsDir), {
			knownSessions: 1, withTranscript: 1, missingTranscript: 0,
		});
	} finally {
		fx.cleanup();
	}
});

test('getDesktopLocalCoverage: counts a pruned transcript as missing, not as an error', async () => {
	const fx = makeFixture();
	try {
		writeMetadata(fx, 'a', 'cli-a');
		writeSharedTranscript(fx, 'C--Users-dev-repo', 'cli-a');
		// Claude Code pruned this one past its retention window: metadata survives, transcript is gone.
		writeMetadata(fx, 'b', 'cli-b');

		const access = new TestClaudeDesktop([fx.sessionsDir]);
		assert.deepEqual(await access.getDesktopLocalCoverage(fx.projectsDir), {
			knownSessions: 2, withTranscript: 1, missingTranscript: 1,
		});
	} finally {
		fx.cleanup();
	}
});

test('getDesktopLocalCoverage: resolves the legacy nested local_<id>/ transcript layout', async () => {
	const fx = makeFixture();
	try {
		// Legacy sessions carry no cliSessionId and keep the transcript beside the metadata.
		writeMetadata(fx, 'legacy');
		const nested = path.join(fx.machineDir, 'local_legacy', '.claude', 'projects', 'hash');
		fs.mkdirSync(nested, { recursive: true });
		fs.writeFileSync(path.join(nested, 'uuid.jsonl'), '{"type":"user"}\n');

		const access = new TestClaudeDesktop([fx.sessionsDir]);
		assert.deepEqual(await access.getDesktopLocalCoverage(fx.projectsDir), {
			knownSessions: 1, withTranscript: 1, missingTranscript: 0,
		});
	} finally {
		fx.cleanup();
	}
});

test('getDesktopLocalCoverage: an empty legacy transcript does not count as coverage', async () => {
	const fx = makeFixture();
	try {
		writeMetadata(fx, 'legacy');
		const nested = path.join(fx.machineDir, 'local_legacy', '.claude', 'projects', 'hash');
		fs.mkdirSync(nested, { recursive: true });
		fs.writeFileSync(path.join(nested, 'uuid.jsonl'), '');

		const access = new TestClaudeDesktop([fx.sessionsDir]);
		assert.deepEqual(await access.getDesktopLocalCoverage(fx.projectsDir), {
			knownSessions: 1, withTranscript: 0, missingTranscript: 1,
		});
	} finally {
		fx.cleanup();
	}
});

test('getDesktopLocalCoverage: ignores files that are not local_<id>.json metadata records', async () => {
	const fx = makeFixture();
	try {
		writeMetadata(fx, 'a', 'cli-a');
		writeSharedTranscript(fx, 'slug', 'cli-a');
		fs.writeFileSync(path.join(fx.machineDir, 'settings.json'), '{}');
		fs.writeFileSync(path.join(fx.machineDir, 'local_notes.txt'), 'ignored');

		const access = new TestClaudeDesktop([fx.sessionsDir]);
		assert.deepEqual(await access.getDesktopLocalCoverage(fx.projectsDir), {
			knownSessions: 1, withTranscript: 1, missingTranscript: 0,
		});
	} finally {
		fx.cleanup();
	}
});

test('getDesktopLocalCoverage: unreadable metadata is counted as missing rather than throwing', async () => {
	const fx = makeFixture();
	try {
		fs.writeFileSync(path.join(fx.machineDir, 'local_broken.json'), '{ not json');

		const access = new TestClaudeDesktop([fx.sessionsDir]);
		assert.deepEqual(await access.getDesktopLocalCoverage(fx.projectsDir), {
			knownSessions: 1, withTranscript: 0, missingTranscript: 1,
		});
	} finally {
		fx.cleanup();
	}
});

test('getDesktopLocalCoverage: a missing ~/.claude/projects directory reports every record as missing', async () => {
	const fx = makeFixture();
	try {
		writeMetadata(fx, 'a', 'cli-a');
		writeMetadata(fx, 'b', 'cli-b');

		const access = new TestClaudeDesktop([fx.sessionsDir]);
		assert.deepEqual(await access.getDesktopLocalCoverage(path.join(fx.root, 'does-not-exist')), {
			knownSessions: 2, withTranscript: 0, missingTranscript: 2,
		});
	} finally {
		fx.cleanup();
	}
});

test('getDesktopLocalCoverage: a cliSessionId containing path separators cannot escape the projects dir', async () => {
	const fx = makeFixture();
	try {
		// A traversal id must not resolve, even though the target file exists.
		writeMetadata(fx, 'evil', '../../evil');
		fs.writeFileSync(path.join(fx.root, 'evil.jsonl'), '{"type":"user"}\n');
		fs.mkdirSync(path.join(fx.projectsDir, 'slug'), { recursive: true });

		const access = new TestClaudeDesktop([fx.sessionsDir]);
		assert.deepEqual(await access.getDesktopLocalCoverage(fx.projectsDir), {
			knownSessions: 1, withTranscript: 0, missingTranscript: 1,
		});
	} finally {
		fx.cleanup();
	}
});

test('getDesktopLocalCoverage: reports nothing when no Claude Desktop session directories exist', async () => {
	const access = new TestClaudeDesktop([]);
	assert.deepEqual(await access.getDesktopLocalCoverage(os.tmpdir()), {
		knownSessions: 0, withTranscript: 0, missingTranscript: 0,
	});
});
