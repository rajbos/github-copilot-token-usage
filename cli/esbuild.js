const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const production = process.argv.includes("--production");

async function main() {
  // Copy JSON data files from src/ to a temp location for bundling
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

  // Copy sql-wasm.wasm to dist/
  const distDir = path.join(__dirname, "dist");
  if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
  }

  const wasmSrc = path.join(
    __dirname,
    "node_modules",
    "sql.js",
    "dist",
    "sql-wasm.wasm"
  );
  const wasmDest = path.join(distDir, "sql-wasm.wasm");
  if (fs.existsSync(wasmSrc)) {
    fs.copyFileSync(wasmSrc, wasmDest);
    console.log("Copied sql-wasm.wasm to dist/");
  }

  const buildOptions = {
    entryPoints: ["src/cli.ts"],
    bundle: true,
    outfile: "dist/cli.js",
    format: "cjs",
    platform: "node",
    target: "node18",
    sourcemap: !production,
    minify: production,
    banner: {
      js: "#!/usr/bin/env node",
    },
    external: ["vscode"],
    // The CLI bundles shared sources from ../vscode-extension/src, so tell esbuild
    // to resolve package imports from the CLI's own node_modules as well.
    nodePaths: [path.join(__dirname, "node_modules")],
    // Resolve the parent src/ directory modules
    alias: {
      vscode: path.join(__dirname, "src", "vscode-stub.ts"),
    },
    loader: {
      ".json": "json",
    },
    logLevel: "info",
  };

  await esbuild.build(buildOptions);
  console.log(
    `CLI built successfully (${production ? "production" : "development"})`
  );

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
