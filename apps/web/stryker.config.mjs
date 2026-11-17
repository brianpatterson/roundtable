// Mutation testing for the web app (ADR-0027): Stryker changes the code in small ways and reruns
// the Vitest suite; a change no test notices is a "surviving mutant", a test that proves less
// than it looks. Run with `pnpm --filter @roundtable/web test:mutation`.
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: 'vitest',
  // Named, because pnpm's strict node_modules hides it from Stryker's plugin discovery.
  plugins: ['@stryker-mutator/vitest-runner'],
  // Source only: not tests, not wiring with nothing to assert (entry point, re-exports).
  mutate: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.test.{ts,tsx}',
    '!src/test-setup.ts',
    '!src/main.tsx',
    '!src/**/index.ts',
  ],
  // TypeScript 7 has no JavaScript compiler API, so Stryker's TypeScript checker can't run, and
  // mutants that wouldn't compile still run (Vitest strips types). They mostly fail tests anyway.
  coverageAnalysis: 'perTest',
  // Reuses the last run's results for code and tests that haven't changed.
  incremental: true,
  incrementalFile: 'reports/stryker-incremental.json',
  reporters: ['clear-text', 'progress', 'html', 'json'],
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },
  // Stryker would rewrite tsconfig.json's relative `extends` for its sandbox, through TypeScript's
  // JavaScript API, which TypeScript 7 doesn't have. So the rewrite is skipped (no such file),
  // and the sandbox goes where the path still works: <repo>/.stryker-tmp/sandbox-*, two levels
  // below the repo root, exactly like apps/web, so `../../tsconfig.base.json` resolves.
  tsconfigFile: 'stryker-skips-tsconfig-rewrite.json',
  tempDirName: '../../.stryker-tmp',
  // Advisory for now: no score fails the run until real scores exist (ADR-0027).
  thresholds: { high: 80, low: 60, break: null },
};
