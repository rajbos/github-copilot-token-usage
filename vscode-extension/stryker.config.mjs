// @ts-check
/** @type {import('@stryker-mutator/core').PartialStrykerOptions} */
export default {
  testRunner: 'command',
  commandRunner: {
    // Explicit file list — no shell globs to keep this cross-platform safe.
    command: [
      'node',
      '--require ./out/test/unit/vscode-shim-register.js',
      '--test',
      '--test-force-exit',
      'out/test/unit/tokenEstimation.test.js',
      'out/test/unit/sessionParser.test.js',
      'out/test/unit/sessionParser-integration.test.js',
      'out/test/unit/maturityScoring.test.js',
      'out/test/unit/usageAnalysis.test.js',
      'out/test/unit/utils-dayKeys.test.js',
      'out/test/unit/utils-errors.test.js',
      'out/test/unit/utils-html.test.js',
      'out/test/unit/workspaceHelpers.test.js',
    ].join(' '),
  },

  // inPlace: true — Stryker mutates the compiled JS files directly in the
  // working directory instead of copying them to a sandbox. This is required
  // because the `out/` directory is gitignored and would be excluded from the
  // default sandbox, causing every test command to fail with MODULE_NOT_FOUND
  // and produce misleading "timed out" results.
  //
  // Tradeoff: if Stryker crashes mid-run, files in out/src/ are left in a
  // mutated state. Run `npm run compile-tests` to restore them.
  inPlace: true,

  // Mutate compiled JS produced by `npm run compile-tests`.
  // The compiled tests in out/test/unit/ import from out/src/ via relative paths,
  // so mutating out/src/ is picked up by the test runner automatically.
  //
  // Scope is intentionally limited to files under ~600 lines. The larger files
  // (usageAnalysis.js ~1900 lines, maturityScoring.js ~1200 lines) generate
  // thousands of mutations and exceed the CI time budget.
  mutate: [
    'out/src/tokenEstimation.js',
    'out/src/sessionParser.js',
    'out/src/utils/dayKeys.js',
    'out/src/utils/errors.js',
    'out/src/utils/html.js',
  ],

  coverageAnalysis: 'off',
  timeoutMS: 15000,
  concurrency: 4,

  thresholds: {
    high: 80,
    low: 60,
    break: 0, // Informational — does not fail the build during initial rollout.
  },

  reporters: ['html', 'clear-text', 'progress'],
  htmlReporter: {
    fileName: 'reports/mutation/report.html',
  },
};
