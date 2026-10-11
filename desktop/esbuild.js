const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const production = process.argv.includes('--production');
const watchMode = process.argv.includes('--watch');

// Webview bundles owned by the VS Code extension that the desktop app reuses.
const WEBVIEW_BUNDLES = [
  'details.js', 'environmental.js', 'chart.js', 'usage.js',
  'diagnostics.js', 'maturity.js', 'fluency-level-viewer.js',
];

async function main() {
  const distDir = path.join(__dirname, 'dist');
  const webviewDir = path.join(distDir, 'webview');
  fs.mkdirSync(webviewDir, { recursive: true });

  // Shared esbuild options for Node.js targets (main + preload)
  const sharedNodeOptions = {
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    minify: production,
    sourcemap: !production,
    alias: {
      vscode: path.join(__dirname, '..', 'cli', 'src', 'vscode-stub.ts'),
    },
    external: ['electron', 'electron-updater'],
    nodePaths: [
      path.join(__dirname, 'node_modules'),
      path.join(__dirname, '..', 'cli', 'node_modules'),
      path.join(__dirname, '..', 'vscode-extension', 'node_modules'),
    ],
    // .css is inlined as text: the --vscode-* theme tokens main.ts injects into each page.
    loader: { '.json': 'json', '.css': 'text' },
    banner: { js: 'var __importMetaUrl = require("url").pathToFileURL(__filename).href;' },
    define: { 'import.meta.url': '__importMetaUrl' },
    logLevel: 'info',
  };

  copyStaticAssets(distDir, webviewDir);

  if (!watchMode) {
    await Promise.all([
      esbuild.build({ ...sharedNodeOptions, entryPoints: ['src/main.ts'], outfile: 'dist/main.js' }),
      esbuild.build({ ...sharedNodeOptions, entryPoints: ['src/preload.ts'], outfile: 'dist/preload.js' }),
    ]);
    console.log(`Desktop built (${production ? 'production' : 'development'})`);
    return;
  }

  // Watch mode: rebuild on change, restart electron after each successful build
  let electronProcess = null;
  let restartTimer = null;

  async function killElectron() {
    if (!electronProcess) { return; }
    const proc = electronProcess;
    electronProcess = null;
    if (process.platform === 'win32' && proc.pid) {
      // Kill the entire process tree (renderer + GPU helper processes)
      spawn('taskkill', ['/pid', String(proc.pid), '/f', '/t'], { stdio: 'ignore' });
      await new Promise(r => proc.once('close', r));
    } else {
      proc.kill();
      await new Promise(r => proc.once('close', r));
    }
  }

  function scheduleRestart() {
    // Debounce: both main+preload contexts fire onEnd; only restart once
    if (restartTimer) { clearTimeout(restartTimer); }
    restartTimer = setTimeout(async () => {
      restartTimer = null;
      await killElectron();
      const electronBin = require('electron');
      electronProcess = spawn(String(electronBin), ['.'], { stdio: 'inherit', windowsHide: false });
      electronProcess.on('close', () => { electronProcess = null; });
    }, 300);
  }

  const rebuildPlugin = {
    name: 'restart-on-rebuild',
    setup(build) {
      build.onEnd((result) => {
        if (result.errors.length === 0) {
          scheduleRestart();
        } else {
          console.error('[watch] build errors — not restarting');
        }
      });
    },
  };

  const [mainCtx, preloadCtx] = await Promise.all([
    esbuild.context({ ...sharedNodeOptions, entryPoints: ['src/main.ts'], outfile: 'dist/main.js', plugins: [rebuildPlugin] }),
    esbuild.context({ ...sharedNodeOptions, entryPoints: ['src/preload.ts'], outfile: 'dist/preload.js', plugins: [rebuildPlugin] }),
  ]);

  await Promise.all([mainCtx.watch(), preloadCtx.watch()]);
  console.log('[watch] watching src/ for changes — Ctrl+C to stop');
}

/**
 * The desktop app does not build its own panel UI — it reuses the IIFE bundles
 * produced by the VS Code extension (each bundle already includes the
 * vscode-elements web components it uses). If those artifacts are missing
 * (e.g. a fresh checkout where only the desktop app was built), build the
 * extension automatically so `pnpm run build` is self-sufficient instead of
 * silently producing an app with blank panels.
 */
function ensureWebviewBundles(extWebviewDir) {
  const missing = WEBVIEW_BUNDLES
    .map((b) => path.join(extWebviewDir, b))
    .filter((p) => !fs.existsSync(p));
  if (missing.length === 0) { return; }

  const extDir = path.join(__dirname, '..', 'vscode-extension');
  console.log(`Webview bundles missing (${missing.length}) — building vscode-extension first…`);
  const result = spawnSync(process.execPath, [path.join(extDir, 'esbuild.js')], {
    cwd: extDir,
    stdio: 'inherit',
  });

  const stillMissing = missing.filter((p) => !fs.existsSync(p));
  if (result.status !== 0 || stillMissing.length > 0) {
    throw new Error(
      'Failed to build the vscode-extension webview bundles automatically.\n' +
      'Build it manually first:\n' +
      '  cd ../vscode-extension && pnpm install && pnpm run compile\n' +
      (stillMissing.length ? `Still missing: ${stillMissing.join(', ')}` : ''),
    );
  }
}

function copyStaticAssets(distDir, webviewDir) {
  const extWebviewDir = path.join(__dirname, '..', 'vscode-extension', 'dist', 'webview');

  ensureWebviewBundles(extWebviewDir);

  for (const bundle of WEBVIEW_BUNDLES) {
    fs.copyFileSync(path.join(extWebviewDir, bundle), path.join(webviewDir, bundle));
    console.log(`Copied ${bundle}`);
  }

  // Codicon icon font — the nav buttons in the shared bundles render
  // `.codicon-*` glyphs, which VS Code webviews get from this stylesheet.
  const codiconsSrcDir = path.join(__dirname, '..', 'vscode-extension', 'node_modules', '@vscode', 'codicons', 'dist');
  const codiconsDstDir = path.join(webviewDir, 'codicons');
  fs.mkdirSync(codiconsDstDir, { recursive: true });
  for (const file of ['codicon.css', 'codicon.ttf']) {
    fs.copyFileSync(path.join(codiconsSrcDir, file), path.join(codiconsDstDir, file));
  }
  console.log('Copied codicons');

  const wasmSrc = fs.existsSync(path.join(__dirname, '..', 'cli', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'))
    ? path.join(__dirname, '..', 'cli', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm')
    : path.join(__dirname, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
  if (fs.existsSync(wasmSrc)) {
    fs.copyFileSync(wasmSrc, path.join(distDir, 'sql-wasm.wasm'));
    console.log('Copied sql-wasm.wasm');
  }

  // App icon — copied into dist/ so the packaged app (which only ships dist/**)
  // can load it for the window/tray at runtime.
  const iconSrc = path.join(__dirname, 'assets', 'tray-icon.png');
  if (fs.existsSync(iconSrc)) {
    fs.copyFileSync(iconSrc, path.join(distDir, 'tray-icon.png'));
    console.log('Copied tray-icon.png');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
