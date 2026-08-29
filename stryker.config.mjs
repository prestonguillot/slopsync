/**
 * Mutation testing: deliberately break the source and report which breakages NO test noticed.
 * Coverage only proves a line ran; this proves a test would catch a regression in it.
 *
 * Scoped per phase from the CLI while working:
 *   npx stryker run --mutate src/sync/trackMatching.ts
 *
 * @type {import('@stryker-mutator/api/core').PartialStrykerOptions}
 */
export default {
  packageManager: 'npm',
  testRunner: 'vitest',
  vitest: {
    configFile: 'vitest.config.ts',
  },
  reporters: ['html', 'json', 'clear-text', 'progress'],
  htmlReporter: {
    fileName: 'reports/mutation/index.html',
  },
  jsonReporter: {
    fileName: 'reports/mutation/report.json',
  },

  appendPlugins: ['./scripts/stryker-ignore-log-text.mjs'],
  ignorers: ['log-text'],

  coverageAnalysis: 'perTest',

  // Fixed, rather than Stryker's default of timeoutMS + timeoutFactor * the measured test time.
  // That default reads the machine, and it runs against vitest's own testTimeout - a fixed 10s.
  // Whichever stopwatch is shorter decides the mutant's status: a short Stryker budget records
  // Timeout, which the ratchet counts as killed, while a longer one lets vitest report what the
  // test actually did, including passing. The same mutant then scores differently on a laptop and
  // on a CI runner, and the per-file ratchet compares numbers across both.
  //
  // 20s sits above vitest's testTimeout so vitest always decides: a mutant that hangs a test fails
  // it at 10s and is scored killed, and Timeout means only a hang vitest cannot catch.
  timeoutMS: 20000,
  timeoutFactor: 0,

  // Left at Stryker's default of false. True skips mutants in code that only runs at import - a
  // const at module scope - and is wrong in both directions: one nothing covers is dropped from the
  // score instead of counted against it, and one that IS covered is reported as surviving without
  // ever being applied, so the tests catching it read as tests that do not. It buys a little speed
  // on the full sweep in exchange for a score that cannot be trusted either way.
  ignoreStatic: false,

  mutate: [
    'src/**/*.ts',
    '!src/types/**',
    '!src/server.ts',
    'public/js/**/*.js',
    '!public/vendor/**',
  ],

  thresholds: {
    high: 80,
    low: 60,
    break: null,
  },

  incremental: true,
  incrementalFile: 'reports/stryker-incremental.json',
};
