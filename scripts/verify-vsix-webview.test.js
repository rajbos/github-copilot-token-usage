'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

const {
  parseCsprojBundles,
  parseCsprojVsixItems,
  parseEsbuildViews,
  deriveExpected,
  readZipEntries,
  verifyVsix,
} = require('./verify-vsix-webview.js');

const SCRIPT = path.join(__dirname, 'verify-vsix-webview.js');
const REAL_CSPROJ = path.join(
  __dirname, '..', 'visualstudio-extension', 'src', 'AIEngineeringFluency', 'AIEngineeringFluency.csproj',
);
const REAL_ESBUILD = path.join(__dirname, '..', 'vscode-extension', 'esbuild.js');

// ── Synthetic zip builder (no committed binaries) ────────────────────────────

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** files: [{name, data: Buffer|string, deflate?: boolean}] */
function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const data = Buffer.from(f.data);
    const method = f.deflate === false ? 0 : 8;
    const body = method === 8 ? zlib.deflateRawSync(data) : data;
    const crc = crc32(data);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, body);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);

    offset += lh.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const CSPROJ = `
<Target Name="CopyWebviewBundles">
  <ItemGroup>
    <_WebviewBundle Include="..\\..\\..\\vscode-extension\\dist\\webview\\chart.js" />
    <_WebviewBundle Include="..\\..\\..\\vscode-extension\\dist\\webview\\usage.js" />
    <_WebviewBundle Include="..\\..\\..\\vscode-extension\\dist\\webview\\modelPricing.json" />
    <_WebviewBundle Include="..\\..\\..\\src\\fluencyLevelData.json" />
  </ItemGroup>
</Target>
<Target Name="AddWebviewBundlesToVsix">
  <ItemGroup>
    <VSIXSourceItem Include="$(MSBuildProjectDirectory)\\webview\\chart.js"><VSIXSubPath>webview\\</VSIXSubPath></VSIXSourceItem>
    <VSIXSourceItem Include="$(MSBuildProjectDirectory)\\webview\\usage.js"><VSIXSubPath>webview\\</VSIXSubPath></VSIXSourceItem>
    <VSIXSourceItem Include="$(MSBuildProjectDirectory)\\webview\\modelPricing.json"><VSIXSubPath>webview\\</VSIXSubPath></VSIXSourceItem>
    <VSIXSourceItem Include="$(MSBuildProjectDirectory)\\webview\\fluencyLevelData.json"><VSIXSubPath>webview\\</VSIXSubPath></VSIXSourceItem>
  </ItemGroup>
</Target>`;

const ESBUILD = `
entryPoints: {
  chart: 'src/webview/chart/main.ts',
  usage: 'src/webview/usage/main.ts',
  'fluency-level-viewer': 'src/webview/fluency-level-viewer/main.ts',
},`;

const EXPECTED = ['chart.js', 'fluencyLevelData.json', 'modelPricing.json', 'usage.js'];

function goodFiles() {
  return [
    { name: 'extension.vsixmanifest', data: '<x/>' },
    { name: 'webview/chart.js', data: 'console.log("chart")' },
    { name: 'webview/usage.js', data: 'console.log("usage")', deflate: false },
    { name: 'webview/modelPricing.json', data: '{"a":1}' },
    { name: 'webview/fluencyLevelData.json', data: '[]' },
  ];
}

// ── Source-list derivation ───────────────────────────────────────────────────

test('parses csproj bundle and VSIX item lists', () => {
  assert.deepEqual([...parseCsprojBundles(CSPROJ)].sort(), EXPECTED);
  assert.deepEqual([...parseCsprojVsixItems(CSPROJ)].sort(), EXPECTED);
});

test('parses esbuild entry points including quoted keys', () => {
  assert.deepEqual([...parseEsbuildViews(ESBUILD)].sort(), ['chart', 'fluency-level-viewer', 'usage']);
});

test('deriveExpected returns the csproj list with no problems when sources agree', () => {
  const { expected, problems } = deriveExpected(CSPROJ, ESBUILD);
  assert.deepEqual(expected, EXPECTED);
  assert.deepEqual(problems, []);
});

test('deriveExpected flags csproj/VSIX list drift and non-entry-point bundles', () => {
  const drifted = CSPROJ
    .replace(/<VSIXSourceItem[^\n]*usage\.js[^\n]*\n/, '')
    .replace('</ItemGroup>\n</Target>\n<Target Name="AddWebviewBundlesToVsix">',
      '<_WebviewBundle Include="..\\dist\\webview\\ghost.js" /></ItemGroup></Target><Target Name="AddWebviewBundlesToVsix">');
  const { problems } = deriveExpected(drifted, ESBUILD);
  assert.ok(problems.some((p) => p.includes('usage.js') && p.includes('not packed')), problems.join('\n'));
  assert.ok(problems.some((p) => p.includes('ghost.js') && p.includes('not an esbuild entry point')), problems.join('\n'));
});

test('deriveExpected throws on an unparseable csproj or esbuild.js', () => {
  assert.throws(() => deriveExpected('<Project/>', ESBUILD), /_WebviewBundle/);
  assert.throws(() => deriveExpected(CSPROJ, 'nothing'), /entryPoints/);
});

test('the real csproj, VSIX item list and esbuild.js agree with each other', () => {
  const { expected, problems } = deriveExpected(
    fs.readFileSync(REAL_CSPROJ, 'utf8'),
    fs.readFileSync(REAL_ESBUILD, 'utf8'),
  );
  assert.deepEqual(problems, []);
  assert.ok(expected.length >= 7, `expected at least the 7 view bundles, got ${expected.join(', ')}`);
});

// ── Zip reading / verification ───────────────────────────────────────────────

test('readZipEntries reads stored and deflated entries', () => {
  const entries = readZipEntries(makeZip(goodFiles()));
  assert.ok(entries.has('webview/chart.js'));
  assert.equal(entries.get('webview/usage.js').method, 0);
  assert.equal(entries.get('webview/chart.js').method, 8);
});

test('readZipEntries rejects non-zip input', () => {
  assert.throws(() => readZipEntries(Buffer.from('definitely not a zip file at all')), /Not a zip/);
});

test('verifyVsix passes when every expected file is present and non-empty', () => {
  const r = verifyVsix(makeZip(goodFiles()), EXPECTED);
  assert.equal(r.ok, true);
  assert.deepEqual(r.failures, []);
});

test('verifyVsix reports a missing file', () => {
  const files = goodFiles().filter((f) => f.name !== 'webview/usage.js');
  const r = verifyVsix(makeZip(files), EXPECTED);
  assert.equal(r.ok, false);
  assert.deepEqual(r.failures, ['webview/usage.js: MISSING from the VSIX']);
});

test('verifyVsix reports an entirely empty webview folder (the failure this guards)', () => {
  const r = verifyVsix(makeZip([{ name: 'extension.vsixmanifest', data: '<x/>' }]), EXPECTED);
  assert.equal(r.failures.length, EXPECTED.length);
  assert.ok(r.failures.every((f) => f.includes('MISSING')));
});

test('verifyVsix reports zero-byte files, stored or deflated', () => {
  const files = goodFiles();
  files[1] = { name: 'webview/chart.js', data: '' };
  files[2] = { name: 'webview/usage.js', data: '', deflate: false };
  const r = verifyVsix(makeZip(files), EXPECTED);
  assert.deepEqual(r.failures, [
    'webview/chart.js: present but EMPTY',
    'webview/usage.js: present but EMPTY',
  ]);
});

test('verifyVsix rejects invalid JSON sidecars', () => {
  const files = goodFiles();
  files[3] = { name: 'webview/modelPricing.json', data: '{not json' };
  const r = verifyVsix(makeZip(files), EXPECTED);
  assert.deepEqual(r.failures, ['webview/modelPricing.json: not valid JSON']);
});

test('verifyVsix does not accept files outside webview/', () => {
  const files = goodFiles().map((f) => ({ ...f, name: f.name.replace('webview/', 'other/') }));
  assert.equal(verifyVsix(makeZip(files), EXPECTED).ok, false);
});

test('verifyVsix decodes percent-encoded OPC part names', () => {
  const files = goodFiles();
  files[1] = { name: 'webview/ch%61rt.js', data: 'x' };
  assert.equal(verifyVsix(makeZip(files), EXPECTED).ok, true);
});

// ── CLI (exit codes against the real source lists) ───────────────────────────

function runCli(zip) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vsix-verify-'));
  try {
    const file = path.join(dir, 'test.vsix');
    fs.writeFileSync(file, zip);
    return spawnSync(process.execPath, [SCRIPT, file], { encoding: 'utf8' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('CLI exits 0 for a VSIX with all real expected files and 1 when one is empty', () => {
  const { expected } = deriveExpected(
    fs.readFileSync(REAL_CSPROJ, 'utf8'),
    fs.readFileSync(REAL_ESBUILD, 'utf8'),
  );
  const files = expected.map((f) => ({ name: `webview/${f}`, data: f.endsWith('.json') ? '{}' : 'x' }));
  const ok = runCli(makeZip(files));
  assert.equal(ok.status, 0, ok.stderr);

  files[0] = { ...files[0], data: '' };
  const bad = runCli(makeZip(files));
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /EMPTY/);
});

test('CLI exits 2 for a missing file argument or a non-zip file', () => {
  assert.equal(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' }).status, 2);
  assert.equal(runCli(Buffer.from('not a zip, just some bytes padding padding')).status, 2);
});

test('failure output lists the VSIX entries so wrong-path vs missing can be told apart', () => {
  const r = runCli(makeZip([{ name: 'extension.vsixmanifest', data: '<x/>' }, { name: 'Webview/Chart.js', data: 'x' }]));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /extension\.vsixmanifest/);
  assert.match(r.stderr, /Webview\/Chart\.js/);
});

test('AddWebviewBundlesToVsix depends on CopyWebviewBundles (VSIX is written before BeforeTargets="Build" runs)', () => {
  const csproj = fs.readFileSync(REAL_CSPROJ, 'utf8');
  const m = csproj.match(/<Target\s+Name="AddWebviewBundlesToVsix"[^>]*>/);
  assert.ok(m, 'AddWebviewBundlesToVsix target not found');
  assert.match(m[0], /DependsOnTargets="[^"]*\bCopyWebviewBundles\b[^"]*"/);
});
