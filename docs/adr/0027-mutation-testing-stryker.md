# 0027. Measure test strength with Stryker mutation testing, starting with the web app

- **Status:** Accepted
- **Date:** 2026-11-17

## Context

Agents now write both the code and its tests ([ADR-0025](0025-software-factory-implementer.md)).
Coverage says a line ran, not that a test would notice if it were wrong, and a test written by
the same agent as the code can pass while proving little. The roadmap's quality layers already
named mutation testing with Stryker as "the best signal for AI-written tests". The reviewer
agent ([ADR-0026](0026-software-factory-reviewer.md)) asks the same question by reading; mutation
testing answers it by trying: it changes the code in small ways (a condition to `true`, a string
to `""`, a callback to a no-op), reruns the tests, and reports every change no test noticed.

Forces:

- **Speed.** Each mutant reruns the tests that cover it. The web tests (Vitest + jsdom) take
  about a second; the API's hit a real Postgres and take about 12.
- **TypeScript 7** has no JavaScript compiler API, which Stryker uses in two places.
- **Unproven scores.** A threshold picked before seeing real scores would be arbitrary.

## Options considered

1. **Stryker (StrykerJS)** with its Vitest runner. The standard JavaScript mutation tester:
   per-test coverage, incremental runs that reuse unchanged results, HTML and JSON reports.
2. **Coverage thresholds only** (Vitest's v8 coverage). Cheap, but answers a weaker question.
3. **Rely on the reviewer agent** reading tests. Useful, and already in place, but a judgment,
   not a measurement.

## Decision

Stryker 10, starting with the web app, advisory:

- **Scope:** `apps/web/src`, minus tests, the entry point and `index.ts` re-exports
  (`apps/web/stryker.config.mjs`). The API follows once its run time is measured; its database
  tests make each mutant costlier, and Effect pipelines produce more equivalent mutants.
- **TypeScript 7 workarounds:** Stryker's TypeScript checker (which discards mutants that don't
  compile) can't run, so those mutants run and mostly fail tests anyway. Its rewrite of
  `tsconfig.json`'s relative `extends` for the sandbox also needs the compiler API, so it's
  skipped, and the sandbox lives in `<repo>/.stryker-tmp/`, two levels below the root like
  `apps/web`, so `../../tsconfig.base.json` still resolves. pnpm's strict `node_modules` hides
  the runner from plugin discovery, so it's named in `plugins`.
- **Advisory:** no score fails anything yet (`thresholds.break: null`). Next, in CI: a mutation
  job on pull requests whose surviving mutants the reviewer turns into findings, and a scheduled
  full run. Then the implementer runs it on what it changed. A required threshold comes after a
  few weeks of real scores.

The spike's measurements (2026-11-17, a laptop, 23 web tests):

| Run                                  | Mutants | Time |
| ------------------------------------ | ------- | ---- |
| Dry run (tests only, with coverage)  | n/a     | 3 s  |
| Full run, no previous results        | 372     | 20 s |
| Incremental, nothing changed in code | 372     | 3 s  |

Score: 94 killed, 33 survived, 245 not covered by any test: **25%** of all mutants, **74%** of
the ones a test runs. The uncovered ones are files with no tests yet (the sign-in page alone has
169). The survivors include the applications table's status change, which no test exercises
(its success callback can be emptied unnoticed), and its loading, error and empty states.

## Consequences

- Each pull request can show which lines its tests don't really check, for a few seconds of CI
  on the web app. At this speed the whole web app can be mutated on every pull request, so
  incremental runs matter more for local use and for the API.
- The score is low because whole pages have no tests, which coverage alone would also show; the
  74% of covered mutants is the more useful number for now.
- The workarounds depend on Stryker's sandbox layout and on TypeScript 7 lacking a JavaScript
  API. Revisit when Stryker supports TypeScript 7 natively, or if the sandbox layout changes.
- Not every survivor is a weak test: some mutants are equivalent (a class name emptied where
  nothing asserts on styling). Survivors need judgment, which is why the reviewer reads them.

## Updates

- **2026-11-17:** in CI. A `mutation` job in `ci.yml` mutates the whole web app on every pull
  request (about 20 seconds, so no incremental runs), writes the score and the survivors to the
  job summary, listing those in the files the pull request changed first, and uploads them as
  the `mutation-report` artifact. It fails only if Stryker can't run. The reviewer downloads that
  artifact for the commit it reviews and turns survivors in changed code into findings
  ([ADR-0026](0026-software-factory-reviewer.md)), and the implementer runs Stryker itself when it
  changes `apps/web/src`. A scheduled full run waits for the API, where runs are long enough for
  incremental runs to matter; a score threshold waits for a few weeks of real scores.
- **2026-11-18:** the API spike (roadmap Phase 3, step 7). Stryker runs on `apps/api` with the
  web app's setup and TypeScript 7 workarounds (`apps/api/stryker.config.mjs`,
  `pnpm --filter @roundtable/api test:mutation`), locally only for now.

  **The shared test database.** Each Stryker worker gets its own database: the test helpers read
  Stryker's `STRYKER_MUTATOR_WORKER` and use `app_test_<worker>`, which a Vitest global setup
  creates and migrates on first use (`apps/api/test/test-database.ts`). Outside Stryker nothing
  changes. Both options give identical results, mutant for mutant, so the workers don't
  interfere. Measured on a laptop (10 cores), 595 mutants, before the exclusions below:

  | Run                                         | Time       |
  | ------------------------------------------- | ---------- |
  | Dry run (117 tests, with coverage)          | 11 s       |
  | (a) `concurrency: 1`, the shared `app_test` | 28 min 6 s |
  | (b) 4 workers, a database each              | 8 min 32 s |
  | (b) after the exclusions (511 mutants)      | 6 min 36 s |
  | Incremental, nothing changed                | 13 s       |
  | Incremental, one line of `redact.ts`        | 15 s       |
  | Incremental, one test renamed               | 60 s       |

  Most of the time goes to **static mutants**: code that runs when a module loads (schemas,
  regexes, layers), which Stryker can only test by rerunning the whole suite. They're 55% of
  the mutants and 94% of the time. `ignoreStatic` would cut the run to about a minute, but it
  would also drop the redaction regexes in `redact.ts`, so they stay. Four workers matches a
  GitHub-hosted runner.

  **Exclusions.** `mutator.excludedMutations` was too coarse: excluding string or object
  literals would also drop real survivors (`redact.ts`'s placeholders, Sentry's privacy options).
  Instead:
  - **Drizzle tables** (`schema.ts`, `columns.ts`) aren't mutated (77 mutants). The test database
    is built from the SQL migrations, so of their mutants only renamed tables and columns are
    killed (35, by queries failing), and the rest (defaults, indexes, foreign keys, time zones)
    change nothing at run time (42 survived or had no coverage). CI's schema drift check
    already catches both kinds.
  - **Effect names** are skipped by an ignorer (`apps/api/stryker-effect-ignorer.mjs`): service
    keys (`Context.Service<…>()('roundtable/Mailer')`, found by class, not by key) and span
    names (`Effect.fn('Mailer.send')`, seen only by a tracer, which the API doesn't have). 7
    mutants.
  - Generators and pipelines produced no noise of their own: all 16 emptied `function*`
    bodies are killed, and the survivors on Effect lines are log messages and fallbacks that
    no test reads, which are real gaps. Error tags (`Schema.TaggedError`) stay mutated because they appear
    in error reports; their 3 survivors are noise, but harmless.

  **Score**, after exclusions: 511 mutants, 379 killed, 1 timed out, 106 survived, 19 not
  covered, 6 errors (a mutant that breaks module loading). **75%** of all mutants, **78%** of
  the covered ones. The biggest groups of survivors are Sentry's options in `error-tracking.ts`
  (31: no test notices if `cookies`, `urlQueryParams` or `databaseQueryData` collection is
  switched on), Better Auth's options in `better-auth.ts` (20: rate limits, account linking),
  and the Resend transport (12).

  **`redact.ts`:** every one of the 33 mutants in the query-parameter and reset-token
  redaction (`redactQueryParams`, `redactQueryParamsInJson`, `redactResetPasswordToken`,
  `redactLogLine`) is killed. Its survivors are all in error description:
  - `paramKind`: every case but `string` and `uuid` (null, undefined, number, boolean, date,
    array, object) can return nothing unnoticed; no test describes those kinds, and
    `describeParams([])` (`<redacted: none>`) has no test at all.
  - `redactDataException`: `startsWith('22')` → `startsWith('')` survives, so no test checks
    that a non-data-exception message keeps its quotes.
  - `describeError`: `'<redacted>'` → `''` survives (a "Failed query" message on an error
    without `params`), and so does `err.stack ?? …` → `&&` (an error without a stack).
    `instanceof DrizzleQueryError || …` → `true` survives but is equivalent: other errors have
    no `params`.
  - `PostgresError`'s `code` pattern can lose either anchor (`^`, `$`) unnoticed.

  **Decision: a scheduled full run, not every pull request yet.** A full run takes minutes,
  not the web app's 20 seconds, so pull requests would need incremental runs, and those need a
  baseline from `main` and only see changes to mutated source and test files: a change to
  `test/helpers.ts`, a migration, the contract package or a dependency would reuse stale
  results. A scheduled full run on `main` gives that baseline and catches what incremental
  misses. Next: a scheduled CI job (Postgres service, four workers) that publishes the report;
  then incremental runs on pull requests that touch `apps/api/src`, seeded from its
  incremental file. Not added in this change.
