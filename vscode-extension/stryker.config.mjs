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

  // Mutate compiled JS produced by `npm run compile-tests`.
  // The compiled tests in out/test/unit/ import from out/src/ via relative paths,
  // so mutating out/src/ is picked up by the test runner automatically.
  mutate: [
    'out/src/tokenEstimation.js',
    'out/src/sessionParser.js',
    'out/src/maturityScoring.js',
    'out/src/usageAnalysis.js',
    'out/src/utils/dayKeys.js',
    'out/src/utils/errors.js',
    'out/src/utils/html.js',
  ],

  coverageAnalysis: 'off',
  timeoutMS: 15000,
  concurrency: 2,

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
