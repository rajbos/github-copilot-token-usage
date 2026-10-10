const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

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
    const srcPath = path.join(__dirname, "..", "src", file);
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
  // The library bundle resolves the wasm next to itself (__dirname), so it gets its own copy.
  const libDir = path.join(distDir, "lib");
  fs.mkdirSync(libDir, { recursive: true });
  if (fs.existsSync(wasmSrc)) {
    fs.copyFileSync(wasmSrc, path.join(distDir, "sql-wasm.wasm"));
    fs.copyFileSync(wasmSrc, path.join(libDir, "sql-wasm.wasm"));
    console.log("Copied sql-wasm.wasm to dist/ and dist/lib/");
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
    // The CLI bundles shared sources from ../src (repo root), so tell esbuild
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

  await buildLibrary(buildOptions);

  // Clean up copied JSON files
  for (const file of dataFiles) {
    const destPath = path.join(__dirname, "src", file);
    if (fs.existsSync(destPath)) {
      fs.unlinkSync(destPath);
    }
  }
}

/**
 * Build the programmatic entry point `@rajbos/ai-engineering-fluency/session`:
 *  - dist/lib/session.js   CommonJS bundle (no CLI code, no shebang)
 *  - dist/lib/session.mjs  ESM wrapper re-exporting the CommonJS bundle, so `import` and
 *                          `require` share one module instance (and one in-memory cache)
 *  - dist/lib/session.d.ts / .d.mts  public types, emitted by tsc from src/lib/session.ts
 */
async function buildLibrary(cliOptions) {
  await esbuild.build({
    ...cliOptions,
    entryPoints: ["src/lib/session.ts"],
    outfile: "dist/lib/session.js",
    banner: undefined,
    // No console output from a library: route every bundled `console` to a no-op object.
    define: { console: "__aiFluencySilentConsole" },
    inject: [path.join(__dirname, "src", "lib", "silentConsole.ts")],
  });

  fs.writeFileSync(
    path.join(__dirname, "dist", "lib", "session.mjs"),
    [
      'import lib from "./session.js";',
      "export const { analyzeSessionFile, analyzeSessionFiles } = lib;",
      "",
    ].join("\n")
  );

  // tsc emits declarations for the whole program (rootDir is the repo root); only the entry
  // file's declaration is published. It must not reference any other module.
  const typesOut = path.join(__dirname, "out", "lib-types");
  fs.rmSync(typesOut, { recursive: true, force: true });
  execFileSync(
    process.execPath,
    [path.join(__dirname, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.lib.json"],
    { cwd: __dirname, stdio: "inherit" }
  );
  const dts = fs.readFileSync(
    path.join(typesOut, "cli", "src", "lib", "session.d.ts"),
    "utf-8"
  );
  if (/\bfrom\s+["']|\bimport\s*\(/.test(dts)) {
    throw new Error(
      "dist/lib/session.d.ts must be self-contained, but it imports another module. " +
        "Declare every public type in cli/src/lib/session.ts."
    );
  }
  fs.writeFileSync(path.join(__dirname, "dist", "lib", "session.d.ts"), dts);
  fs.writeFileSync(path.join(__dirname, "dist", "lib", "session.d.mts"), dts);
  console.log("Library built: dist/lib/session.{js,mjs,d.ts,d.mts}");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
