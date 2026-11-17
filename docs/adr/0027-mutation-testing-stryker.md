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
