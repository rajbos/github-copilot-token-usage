import test from 'node:test';
import * as assert from 'node:assert/strict';
import { githubHostsFor, repoDisplayFromRemote, repoDisplayFromSession, repoKeyFromRemote, repoKeyFromSlug } from '../../../src/repoKey';

test('repoDisplayFromRemote: GitHub HTTPS, SSH, scp-style and git:// remotes reduce to owner/repo', () => {
    assert.equal(repoDisplayFromRemote('https://github.com/Owner/Repo.git'), 'Owner/Repo');
    assert.equal(repoDisplayFromRemote('https://github.com/owner/repo'), 'owner/repo');
    assert.equal(repoDisplayFromRemote('git@github.com:owner/repo.git'), 'owner/repo');
    assert.equal(repoDisplayFromRemote('git://github.com/owner/repo.git/'), 'owner/repo');
    assert.equal(repoDisplayFromRemote('ssh://git@ghe.example.com/owner/repo.git', githubHostsFor('https://ghe.example.com')), 'owner/repo');
    assert.equal(repoDisplayFromRemote('git@GHE.example.com:owner/repo.git', githubHostsFor('https://ghe.example.com/')), 'owner/repo');
});

test('repoDisplayFromRemote: local paths and file remotes are not repository identities', () => {
    for (const local of [
        '/home/user/repo', '/home/user/repo.git', 'file:///home/user/repo', 'file://host/share/user/repo',
        'C:\\Users\\me\\repo', 'C:/Users/me/repo', '../user/repo', './user/repo', 'user/repo',
    ]) {
        assert.equal(repoDisplayFromRemote(local), undefined, local);
    }
});

test('repoDisplayFromRemote: other hosts keep their host, so the same owner/repo never merges across hosts', () => {
    assert.equal(repoDisplayFromRemote('https://gitlab.com/o/r.git'), 'gitlab.com/o/r');
    assert.equal(repoDisplayFromRemote('git@gitlab.com:o/r.git'), 'gitlab.com/o/r');
    assert.equal(repoDisplayFromRemote('https://gitlab.com/group/sub/r'), 'gitlab.com/group/sub/r');
    assert.notEqual(repoKeyFromRemote('https://gitlab.com/o/r'), repoKeyFromRemote('https://github.com/o/r'));
    assert.notEqual(repoKeyFromRemote('https://gitlab.com/o/r'), repoKeyFromSlug('o/r'));
    // A GitHub Enterprise remote only joins as owner/repo when that host is configured.
    assert.equal(repoKeyFromRemote('https://ghe.example.com/o/r'), 'ghe.example.com/o/r');
    assert.equal(repoKeyFromRemote('https://ghe.example.com/o/r', githubHostsFor('https://ghe.example.com')), 'o/r');
    // A GitHub URL with extra path segments is not a repository remote.
    assert.equal(repoDisplayFromRemote('https://github.com/o/r/tree/main'), undefined);
});

test('githubHostsFor: github.com plus a valid enterprise host', () => {
    assert.deepEqual([...githubHostsFor(undefined)], ['github.com']);
    assert.deepEqual([...githubHostsFor('not a url')], ['github.com']);
    assert.deepEqual([...githubHostsFor('https://GHE.example.com/api')].sort(), ['ghe.example.com', 'github.com']);
});

test('repoDisplayFromRemote: credentials in the URL never reach the label', () => {
    assert.equal(repoDisplayFromRemote('https://user:secret@github.com/owner/repo.git'), 'owner/repo');
    assert.equal(repoDisplayFromRemote('git@github.com:owner/repo.git?token=secret'), 'owner/repo');
    assert.equal(repoDisplayFromRemote('https://github.com/owner/repo#frag'), 'owner/repo');
});

test('repoDisplayFromRemote: empty or unusable input is undefined', () => {
    assert.equal(repoDisplayFromRemote(undefined), undefined);
    assert.equal(repoDisplayFromRemote(''), undefined);
    assert.equal(repoDisplayFromRemote('   '), undefined);
    assert.equal(repoDisplayFromRemote('not-a-remote'), undefined);
    assert.equal(repoDisplayFromRemote('https://github.com/owner/re po'), undefined);
});

test('repoKeyFromRemote and repoKeyFromSlug agree on the lowercase key', () => {
    assert.equal(repoKeyFromRemote('https://github.com/Owner/Repo.git'), 'owner/repo');
    assert.equal(repoKeyFromSlug('Owner/Repo'), 'owner/repo');
    assert.equal(repoKeyFromSlug(' owner/repo '), 'owner/repo');
});

test('repoKeyFromSlug: rejects anything that is not exactly owner/name', () => {
    assert.equal(repoKeyFromSlug(undefined), undefined);
    assert.equal(repoKeyFromSlug('repo'), undefined);
    assert.equal(repoKeyFromSlug('a/b/c'), undefined);
    assert.equal(repoKeyFromSlug('../repo'), undefined);
});

test('repoDisplayFromSession: a Copilot CLI slug is read as owner/repo only when the source says it is one', () => {
    assert.equal(repoDisplayFromSession('Owner/Repo', true), 'Owner/Repo');
    assert.equal(repoDisplayFromSession('owner/repo', false), undefined, 'an unmarked a/b string may be a relative path');
    assert.equal(repoDisplayFromSession('https://github.com/o/r.git', false), 'o/r');
    for (const bad of ['../repo', './repo', 'a/b/c', 'repo', '', undefined]) {
        assert.equal(repoDisplayFromSession(bad, true), undefined, String(bad));
    }
});
