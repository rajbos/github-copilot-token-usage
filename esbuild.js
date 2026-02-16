const esbuild = require("esbuild");

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
		logLevel: 'silent',
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
		logLevel: 'silent',
		plugins: [esbuildProblemMatcherPlugin],
		loader: { '.css': 'text' },
	});

	if (watch) {
		await Promise.all([extensionCtx.watch(), webviewCtx.watch()]);
	} else {
		await Promise.all([extensionCtx.rebuild(), webviewCtx.rebuild()]);
		await extensionCtx.dispose();
		await webviewCtx.dispose();
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
