/**
 * Bundles the CLI unit tests (cli/src/test/*.test.ts) into out/test/ so they can
 * be run with `node --test out/test`.
 *
 * Uses the exact same esbuild setup as the main CLI build (esbuild.js): the tests
 * import shared modules from ../vscode-extension/src which reference the `vscode`
 * module (aliased to the CLI stub) and ESM-only packages like chalk — bundling
 * resolves both, matching how dist/cli.js is produced.
 */
const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

async function main() {
  // Copy JSON data files from vscode-extension/src (same as esbuild.js)
  const dataFiles = [
    "tokenEstimators.json",
    "modelPricing.json",
    "toolNames.json",
    "automaticTools.json",
  ];

  for (const file of dataFiles) {
    const srcPath = path.join(__dirname, "..", "vscode-extension", "src", file);
    const destPath = path.join(__dirname, "src", file);
    if (fs.existsSync(srcPath) && !fs.existsSync(destPath)) {
      fs.copyFileSync(srcPath, destPath);
    }
  }

  const testDir = path.join(__dirname, "src", "test");
  const entryPoints = fs
    .readdirSync(testDir)
    .filter((f) => f.endsWith(".test.ts"))
    .map((f) => path.join(testDir, f));

  if (entryPoints.length === 0) {
    throw new Error(`No *.test.ts files found in ${testDir}`);
  }

  await esbuild.build({
    entryPoints,
    bundle: true,
    outdir: path.join(__dirname, "out", "test"),
    format: "cjs",
    platform: "node",
    target: "node18",
    sourcemap: true,
    // The package's own `/session` subpath is loaded from the built dist/ at runtime by the
    // library smoke test, through the package.json `exports` map — never bundled.
    external: ["vscode", "@rajbos/ai-engineering-fluency/session"],
    // The tests bundle shared sources from ../vscode-extension/src, so tell esbuild
    // to resolve package imports from the CLI's own node_modules as well.
    nodePaths: [path.join(__dirname, "node_modules")],
    alias: {
      vscode: path.join(__dirname, "src", "vscode-stub.ts"),
    },
    loader: {
      ".json": "json",
    },
    logLevel: "info",
  });
  console.log(`CLI tests bundled successfully (${entryPoints.length} file(s))`);

  // Clean up copied JSON files
  for (const file of dataFiles) {
    const destPath = path.join(__dirname, "src", file);
    if (fs.existsSync(destPath)) {
      fs.unlinkSync(destPath);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
