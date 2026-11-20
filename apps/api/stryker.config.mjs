// Mutation testing for the API (ADR-0027): Stryker changes the code in small ways and reruns the
// Vitest suite; a change no test notices is a "surviving mutant", a test that proves less than it
// looks. Run with `pnpm --filter @roundtable/api test:mutation`. The setup and its TypeScript 7
// workarounds are the web app's (apps/web/stryker.config.mjs); what differs is commented here.
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: 'vitest',
  // Named, because pnpm's strict node_modules hides the runner from Stryker's plugin discovery.
  plugins: ['@stryker-mutator/vitest-runner', './stryker-effect-ignorer.mjs'],
  mutate: [
    'src/**/*.ts',
    '!src/**/*.test.ts',
    // Entry points and re-exports: wiring with nothing to assert.
    '!src/main.ts',
    '!src/migrate.ts',
    '!src/**/index.ts',
    // Drizzle table definitions. The test database is built from the SQL migrations, not from
    // these, so a mutant here changes nothing at run time; CI's schema drift check is their test.
    '!src/**/schema.ts',
    '!src/platform/database/columns.ts',
  ],
  // Effect service keys and span names, which nothing observes (see the file).
  ignorers: ['effect-names'],
  coverageAnalysis: 'perTest',
  // Each worker gets its own test database (test/test-database.ts), so they can run side by side.
  // Four, like a GitHub-hosted runner.
  concurrency: 4,
  // Reuses the last run's results for code and tests that haven't changed.
  incremental: true,
  incrementalFile: 'reports/stryker-incremental.json',
  reporters: ['clear-text', 'progress', 'html', 'json'],
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },
  // TypeScript 7 workarounds, as in the web app: skip the tsconfig rewrite (no such file) and put
  // the sandbox two levels below the repo root, so `../../tsconfig.base.json` still resolves.
  tsconfigFile: 'stryker-skips-tsconfig-rewrite.json',
  tempDirName: '../../.stryker-tmp',
  // Advisory, like the web app: no score fails the run.
  thresholds: { high: 80, low: 60, break: null },
};
