const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

const production = process.argv.includes('--production');

async function main() {
  const distDir = path.join(__dirname, 'dist');
  if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
  }

  await esbuild.build({
    entryPoints: ['src/server.ts'],
    bundle: true,
    outfile: 'dist/server.js',
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    sourcemap: !production,
    minify: production,
    // node:sqlite is a built-in module — esbuild auto-externalises node:* with platform:node,
    // but list explicitly for clarity
    external: ['node:sqlite'],
    logLevel: 'info',
  });

  // Copy Chart.js UMD bundle so the dashboard can inline it without a CDN dependency
  const chartSrc = path.join(__dirname, 'node_modules', 'chart.js', 'dist', 'chart.umd.min.js');
  const chartDst = path.join(distDir, 'chart.min.js');
  if (fs.existsSync(chartSrc)) {
    fs.copyFileSync(chartSrc, chartDst);
    console.log('Copied chart.js to dist/chart.min.js');
  } else {
    console.warn('WARNING: chart.js not found — charts will not render in the dashboard');
  }

  console.log(`Sharing server built (${production ? 'production' : 'development'})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
