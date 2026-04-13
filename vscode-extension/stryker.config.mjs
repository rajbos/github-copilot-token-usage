// @ts-check
/** @type {import('@stryker-mutator/core').PartialStrykerOptions} */
export default {
  testRunner: 'command',
  commandRunner: {
    // Explicit file list — no shell globs to keep this cross-platform safe.
    // Excludes viewRegression.test.js (requires JSDOM; not available in Node runner).
    command: [
      'node',
      '--require ./out/test/unit/vscode-shim-register.js',
      '--test',
      '--test-force-exit',
      // Core parser / estimation
      'out/test/unit/tokenEstimation.test.js',
      'out/test/unit/sessionParser.test.js',
      'out/test/unit/sessionParser-integration.test.js',
      'out/test/unit/maturityScoring.test.js',
      'out/test/unit/usageAnalysis.test.js',
      // Utilities
      'out/test/unit/utils-dayKeys.test.js',
      'out/test/unit/utils-errors.test.js',
      'out/test/unit/utils-html.test.js',
      'out/test/unit/workspaceHelpers.test.js',
      'out/test/unit/claudecode.test.js',
      'out/test/unit/logging-redaction.test.js',
      'out/test/unit/webview-utils.test.js',
      // Backend — services
      'out/test/unit/credentialService.test.js',
      'out/test/unit/azureResourceService.test.js',
      'out/test/unit/backend-blobUploadService.test.js',
      'out/test/unit/backend-dataPlaneService.test.js',
      'out/test/unit/backend-queryService.test.js',
      'out/test/unit/backend-syncService.test.js',
      'out/test/unit/backend-sync-profiles.test.js',
      'out/test/unit/backend-utilityService.test.js',
      // Backend — core
      'out/test/unit/backend-cache-integration.test.js',
      'out/test/unit/backend-commands.test.js',
      'out/test/unit/backend-configPanel.test.js',
      'out/test/unit/backend-configPanel-webview.test.js',
      'out/test/unit/backend-configurationFlow.test.js',
      'out/test/unit/backend-configurator.test.js',
      'out/test/unit/backend-copyConfig.test.js',
      'out/test/unit/backend-displayNames.test.js',
      'out/test/unit/backend-facade-helpers.test.js',
      'out/test/unit/backend-facade-methods.test.js',
      'out/test/unit/backend-facade-query.test.js',
      'out/test/unit/backend-facade-rollups.test.js',
      'out/test/unit/backend-identity.test.js',
      'out/test/unit/backend-integration.test.js',
      'out/test/unit/backend-redaction.test.js',
      'out/test/unit/backend-rollups.test.js',
      'out/test/unit/backend-settings.test.js',
      'out/test/unit/backend-sharingProfile.test.js',
      'out/test/unit/backend-storageTables.test.js',
      'out/test/unit/backend-ui-messages.test.js',
    ].join(' '),
  },

  // inPlace: true — Stryker mutates the compiled JS files directly in the
  // working directory instead of copying them to a sandbox. This is required
  // because out/ is gitignored and excluded from the default sandbox, which
  // would cause every test command to fail with MODULE_NOT_FOUND.
  //
  // At concurrency 4 with 7 files Stryker batches mutants per-file within each
  // worker, making simultaneous writes to the same file extremely unlikely.
  // If Stryker crashes mid-run, files in out/src/ are left mutated — run
  // `npm run compile-tests` to restore them.
  inPlace: true,

  // Mutate compiled JS produced by `npm run compile-tests`.
  // The compiled tests in out/test/unit/ import from out/src/ via relative paths,
  // so mutating out/src/ is picked up by the test runner automatically.
  //
  // The glob patterns below use Stryker's built-in micromatch support (cross-platform).
  //
  // Scope excludes backend/** (syncService ~1430 lines, facade ~1136 lines etc. generate
  // ~10k+ mutants with low kill rates and blow the CI time budget). Also excludes
  // usageAnalysis and maturityScoring (~1900 and ~1200 lines respectively) for the
  // same reason. These can be added per-file once their test coverage is improved.
  mutate: [
    // Core files
    'out/src/tokenEstimation.js',
    'out/src/sessionParser.js',
    'out/src/workspaceHelpers.js',
    'out/src/claudecode.js',
    // Utilities
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

  reporters: ['html', 'json', 'clear-text', 'progress'],
  htmlReporter: {
    fileName: 'reports/mutation/report.html',
  },
};
