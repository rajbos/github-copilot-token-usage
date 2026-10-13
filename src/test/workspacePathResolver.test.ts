import test from 'node:test';
import * as assert from 'node:assert/strict';
import { resolveFileUri } from '../workspacePathResolver';

// ---------------------------------------------------------------------------
// Non-file URIs and edge cases
// ---------------------------------------------------------------------------

test('resolveFileUri: returns undefined for empty string', () => {
    assert.equal(resolveFileUri(''), undefined);
});

test('resolveFileUri: returns undefined for non-file URI', () => {
    assert.equal(resolveFileUri('https://example.com/path'), undefined);
    assert.equal(resolveFileUri('vscode-userdata:/settings.json'), undefined);
});

test('resolveFileUri: returns undefined for null-ish inputs', () => {
    assert.equal(resolveFileUri(undefined as unknown as string), undefined);
    assert.equal(resolveFileUri(null as unknown as string), undefined);
});

// ---------------------------------------------------------------------------
// POSIX absolute paths
// ---------------------------------------------------------------------------

test('resolveFileUri: resolves POSIX path', () => {
    assert.equal(resolveFileUri('file:///home/user/projects/repo'), '/home/user/projects/repo');
});

test('resolveFileUri: resolves POSIX path with subdirectories', () => {
    assert.equal(
        resolveFileUri('file:///usr/local/share/myproject'),
        '/usr/local/share/myproject'
    );
});

// ---------------------------------------------------------------------------
// Windows absolute paths
// ---------------------------------------------------------------------------

test('resolveFileUri: resolves Windows path — strips leading slash', () => {
    const result = resolveFileUri('file:///C:/Users/user/projects/repo');
    assert.equal(result, 'C:/Users/user/projects/repo');
});

test('resolveFileUri: resolves Windows path with lowercase drive letter', () => {
    const result = resolveFileUri('file:///d:/workspace/project');
    assert.equal(result, 'd:/workspace/project');
});

test('resolveFileUri: resolves Windows path — uppercase drive letter', () => {
    const result = resolveFileUri('file:///Z:/data');
    assert.equal(result, 'Z:/data');
});

// ---------------------------------------------------------------------------
// UNC paths
// ---------------------------------------------------------------------------

test('resolveFileUri: resolves UNC path (double-slash authority)', () => {
    const result = resolveFileUri('file:////server/share/folder');
    // On Windows we expect backslashes; on POSIX forward slashes.
    const expected = process.platform === 'win32'
        ? '\\\\server\\share\\folder'
        : '//server/share/folder';
    assert.equal(result, expected);
});

// ---------------------------------------------------------------------------
// Percent-encoded characters
// ---------------------------------------------------------------------------

test('resolveFileUri: decodes encoded spaces (%20)', () => {
    assert.equal(
        resolveFileUri('file:///home/user/my%20project'),
        '/home/user/my project'
    );
});

test('resolveFileUri: decodes encoded spaces in Windows path', () => {
    assert.equal(
        resolveFileUri('file:///C:/Users/my%20user/workspace'),
        'C:/Users/my user/workspace'
    );
});

test('resolveFileUri: decodes multiple encoded characters', () => {
    assert.equal(
        resolveFileUri('file:///home/user/project%20files%20%26%20data'),
        '/home/user/project files & data'
    );
});

test('resolveFileUri: decodes encoded parentheses', () => {
    assert.equal(
        resolveFileUri('file:///home/user/project%28v2%29'),
        '/home/user/project(v2)'
    );
});

// ---------------------------------------------------------------------------
// Path traversal prevention (security)
// ---------------------------------------------------------------------------

test('resolveFileUri: rejects path traversal with .. after decoding', () => {
    // Literal '..' in the path
    assert.equal(resolveFileUri('file:///home/user/../etc/passwd'), undefined);
});

test('resolveFileUri: rejects encoded path traversal (%2e%2e)', () => {
    // %2e is '.' — so %2e%2e is '..' after decoding
    assert.equal(resolveFileUri('file:///home/user/%2e%2e/etc/passwd'), undefined);
});

test('resolveFileUri: rejects Windows-style path traversal', () => {
    assert.equal(resolveFileUri('file:///C:/Users/user/../../Windows/System32'), undefined);
});

test('resolveFileUri: rejects traversal with encoded dots in Windows path', () => {
    assert.equal(resolveFileUri('file:///C:/foo/%2e%2e/bar'), undefined);
});

test('resolveFileUri: rejects path traversal at root', () => {
    assert.equal(resolveFileUri('file:///../etc/passwd'), undefined);
});

// ---------------------------------------------------------------------------
// Malformed URIs
// ---------------------------------------------------------------------------

test('resolveFileUri: returns undefined for malformed percent-encoding', () => {
    // %GG is not valid hex
    assert.equal(resolveFileUri('file:///home/user/%GGbroken'), undefined);
});

test('resolveFileUri: returns undefined for truncated percent sequence', () => {
    // Trailing % without two hex digits
    assert.equal(resolveFileUri('file:///home/user/path%'), undefined);
});

// ---------------------------------------------------------------------------
// Real-world workspace.json patterns
// ---------------------------------------------------------------------------

test('resolveFileUri: handles real VS Code Windows workspace URI', () => {
    const result = resolveFileUri('file:///C:/Users/RobBos/projects/my-repo');
    assert.equal(result, 'C:/Users/RobBos/projects/my-repo');
});

test('resolveFileUri: handles real VS Code Linux workspace URI', () => {
    const result = resolveFileUri('file:///home/robros/projects/my-repo');
    assert.equal(result, '/home/robros/projects/my-repo');
});

test('resolveFileUri: handles real VS Code macOS workspace URI', () => {
    const result = resolveFileUri('file:///Users/robros/Developer/my-repo');
    assert.equal(result, '/Users/robros/Developer/my-repo');
});

test('resolveFileUri: handles encoded path on Windows', () => {
    const result = resolveFileUri('file:///C:/Users/Rob%20Bos/projects/ai-engineering-fluency');
    assert.equal(result, 'C:/Users/Rob Bos/projects/ai-engineering-fluency');
});
