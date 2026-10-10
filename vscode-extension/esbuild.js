const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
	name: 'esbuild-problem-matcher',

	setup(build) {
		build.onStart(() => {
			console.log('[watch] build started');
		});
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				console.error(`    ${location.file}:${location.line}:${location.column}:`);
			});
			console.log('[watch] build finished');
		});
	},
};

async function main() {
	// Extension bundle (Node target)
	const extensionCtx = await esbuild.context({
		entryPoints: ['src/extension.ts'],
		bundle: true,
		format: 'cjs',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'node',
		outfile: 'dist/extension.js',
		external: ['vscode'],
		// Shared sources in <repo>/src sit outside this package, so make sure
		// bare imports still resolve against this project's node_modules.
		nodePaths: [path.join(__dirname, 'node_modules')],
		logLevel: 'silent',
		// Polyfill import.meta.url so ESM packages that use createRequire(import.meta.url)
		// work correctly when bundled as CJS (esbuild otherwise sets import.meta to {}).
		// The banner defines a __importMetaUrl variable; define wires import.meta.url to it.
		banner: { js: 'var __importMetaUrl = require("url").pathToFileURL(__filename).href;' },
		define: { 'import.meta.url': '__importMetaUrl' },
		plugins: [esbuildProblemMatcherPlugin],
	});

	// Session-analysis worker (Node target). Runs all CPU-heavy parsing off the extension host's
	// event loop; loaded by src/analysis/analysisWorkerPool.ts as dist/analysisWorker.js.
	// `vscode` is aliased to a throwing stub because a worker thread has no VS Code API.
	const workerCtx = await esbuild.context({
		entryPoints: ['src/analysis/analysisWorker.ts'],
		bundle: true,
		format: 'cjs',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'node',
		outfile: 'dist/analysisWorker.js',
		alias: { vscode: path.join(__dirname, 'src', 'analysis', 'vscodeStub.ts') },
		nodePaths: [path.join(__dirname, 'node_modules')],
		logLevel: 'silent',
		banner: { js: 'var __importMetaUrl = require("url").pathToFileURL(__filename).href;' },
		define: { 'import.meta.url': '__importMetaUrl' },
		plugins: [esbuildProblemMatcherPlugin],
	});

	// Webview bundle(s) (Browser target)
	const webviewCtx = await esbuild.context({
		entryPoints: {
			details: 'src/webview/details/main.ts',
			chart: 'src/webview/chart/main.ts',
			usage: 'src/webview/usage/main.ts',
			diagnostics: 'src/webview/diagnostics/main.ts',
			logviewer: 'src/webview/logviewer/main.ts',
			maturity: 'src/webview/maturity/main.ts',
			dashboard: 'src/webview/dashboard/main.ts',
			'fluency-level-viewer': 'src/webview/fluency-level-viewer/main.ts',
			environmental: 'src/webview/environmental/main.ts',
			efficiency: 'src/webview/efficiency/main.ts',
			whatsnew: 'src/webview/whatsnew/main.ts',
		},
		bundle: true,
		format: 'iife',
		minify: production,
		sourcemap: !production,
		platform: 'browser',
		target: 'es2020',
		outdir: 'dist/webview',
		entryNames: '[name]',
		external: ['vscode'],
		nodePaths: [path.join(__dirname, 'node_modules')],
		logLevel: 'silent',
		plugins: [esbuildProblemMatcherPlugin],
		// Tool logos (assets/tool-logos) are inlined so webviews need no extra resources.
		loader: { '.css': 'text', '.svg': 'dataurl', '.png': 'dataurl' },
	});

	if (watch) {
		await Promise.all([extensionCtx.watch(), workerCtx.watch(), webviewCtx.watch()]);
	} else {
		await Promise.all([extensionCtx.rebuild(), workerCtx.rebuild(), webviewCtx.rebuild()]);
		await extensionCtx.dispose();
		await workerCtx.dispose();
		await webviewCtx.dispose();
	}

	// Copy JSON config files to dist/webview/ so the VS extension can read them as runtime sidecars.
	// These live in the shared <repo>/src folder.
	const jsonConfigFiles = ['tokenEstimators.json', 'modelPricing.json', 'toolNames.json', 'automaticTools.json'];
	const webviewDistDir = path.join(__dirname, 'dist', 'webview');
	fs.mkdirSync(webviewDistDir, { recursive: true });
	for (const file of jsonConfigFiles) {
		const jsonSrc = path.join(__dirname, '..', 'src', file);
		const jsonDst = path.join(webviewDistDir, file);
		if (fs.existsSync(jsonSrc)) {
			fs.copyFileSync(jsonSrc, jsonDst);
		}
	}

	// Emit one resolved localization dictionary per shipped locale into
	// dist/webview/, for the hosts that cannot build it themselves.
	//
	// The VS Code extension and the desktop app call buildWebviewLocalization()
	// directly, but the JetBrains plugin is Kotlin and the Visual Studio
	// extension is C# — neither can run our TypeScript. They redistribute these
	// same bundles, and a bundle only localizes itself if the host puts a
	// `localization` dictionary in the panel payload. Without these files they
	// had no way to, which is why both shipped English regardless of IDE
	// language. Each host reads the file matching its own display language and
	// completes the payload it already builds.
	//
	// Written as fully resolved key→text maps rather than the raw nls bundles
	// so the hosts need no fallback logic: the English file already carries the
	// English text for any key a locale has not translated.
	{
		// webviewKeys.json is the single manifest of which keys the webviews need —
		// the same one the generated English fallback is built from, so the sidecars
		// and that fallback can never cover different key sets.
		const keys = require('./src/webview/shared/webviewKeys.json');
		if (keys.length < 100) {
			throw new Error(`webviewKeys.json lists only ${keys.length} keys — refusing to ship a near-empty dictionary.`);
		}
		const englishBundle = require('./package.nls.json');
		const locales = { 'en': englishBundle, 'zh-cn': require('./package.nls.zh-cn.json') };
		for (const [locale, bundle] of Object.entries(locales)) {
			const dictionary = {};
			for (const key of keys) {
				dictionary[key] = bundle[key] ?? englishBundle[key] ?? key;
			}
			dictionary['__language__'] = locale;
			fs.writeFileSync(
				path.join(webviewDistDir, `localization.${locale}.json`),
				`${JSON.stringify(dictionary, null, 2)}\n`,
			);
		}
		console.log(`[build] wrote ${Object.keys(locales).length} webview localization sidecar(s), ${keys.length} keys each`);
	}

	// Copy the codicon font (icon font VS Code itself uses) into dist/webview/codicons/ so
	// webview panels can load it via webview.asWebviewUri() and render `.codicon-*` icons.
	// Placed under dist/webview because most panels restrict localResourceRoots to that folder.
	const codiconsSrcDir = path.join(__dirname, 'node_modules', '@vscode', 'codicons', 'dist');
	const codiconsDstDir = path.join(webviewDistDir, 'codicons');
	if (fs.existsSync(codiconsSrcDir)) {
		fs.mkdirSync(codiconsDstDir, { recursive: true });
		for (const file of ['codicon.css', 'codicon.ttf']) {
			const codiconSrc = path.join(codiconsSrcDir, file);
			const codiconDst = path.join(codiconsDstDir, file);
			if (fs.existsSync(codiconSrc)) {
				fs.copyFileSync(codiconSrc, codiconDst);
			}
		}
	}

	// Copy sql.js WASM file to dist/ for OpenCode SQLite support
	const wasmSrc = path.join(__dirname, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
	const wasmDst = path.join(__dirname, 'dist', 'sql-wasm.wasm');
	if (fs.existsSync(wasmSrc)) {
		fs.mkdirSync(path.dirname(wasmDst), { recursive: true });
		fs.copyFileSync(wasmSrc, wasmDst);
	}

	// Copy vscode-elements bundle to dist/ for webview usage (configPanel loads it at runtime via URI)
	const toolkitDir = path.join(__dirname, 'dist', 'toolkit');
	if (!fs.existsSync(toolkitDir)) {
		fs.mkdirSync(toolkitDir, { recursive: true });
	}
	const src = path.join(__dirname, 'node_modules', '@vscode-elements', 'elements', 'dist', 'bundled.js');
	const dst = path.join(toolkitDir, 'toolkit.js');
	if (fs.existsSync(src)) {
		fs.copyFileSync(src, dst);
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
