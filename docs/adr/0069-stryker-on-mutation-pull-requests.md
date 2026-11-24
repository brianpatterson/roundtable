# 0069. Run Stryker on a mutation ticket's file in CI, for the reviewer

- **Status:** Accepted
- **Date:** 2026-11-24
- **Amends:** [ADR-0039](0039-nightly-mutation-and-security-audit.md) (no mutation testing on pull requests)

## Context

A mutation ticket ([ADR-0051](0051-nightly-mutation-tickets.md)) has one criterion only Stryker can
check: none of its mutants is left `Survived` or `NoCoverage`. The implementer runs Stryker on the
file and reports the result in its pull request. The reviewer can't run anything
([ADR-0026](0026-software-factory-reviewer.md)), so in the first batch (#189–#193) every review
called that criterion "not verified" or "the implementer's claim". On #194 and #201, "Check by
hand" asked the owner to run Stryker. On #194 the owner did, twice, and found a mutant the pull
request said was disabled still surviving.

Pull requests don't run mutation testing ([ADR-0039](0039-nightly-mutation-and-security-audit.md)):
a full API run takes half an hour or more, and one that timed out stalled a factory pull request.
But a mutation ticket covers one file, and Stryker on one file takes seconds for the web app and
minutes for the API.

## Options considered

1. **Let the reviewer run Stryker.** It would have to install and run the pull request's code in
   the job that holds the reviewer's token and writes the review, which ADR-0026 rules out.
2. **A CI job on mutation tickets' pull requests**, running Stryker on the ticket's file and
   uploading the report, which the reviewer reads the way it reads the browser tests' screenshots
   ([ADR-0066](0066-factory-writes-and-reads-browser-tests.md)). The pull request's code runs where
   all of it already runs, in CI with no secrets.
3. **Keep the owner's hand check.** It costs the owner a local run on every ticket.

## Decision

Option 2.

- **CI's `mutation` job** runs on pull requests from `claude/issue-<n>-…` branches. When issue `<n>`
  is labeled `mutation` and its title names a source file in `apps/web` or `apps/api`, it runs
  `test:mutation --mutate <file> --force` on CI's Postgres and uploads `mutation.json` as the
  `mutation-check` artifact. Other pull requests skip it after one `gh` call. It is advisory
  (`continue-on-error`, 25 minutes): a failure or timeout leaves no report, never a red CI.
- **The reviewer** gets `./mutation/report.md`, made by main's `load-mutation-report.sh` from that
  artifact. The artifact was written by the pull request's code, so the script keeps a fixed shape,
  cut short and capped: counts by status, and each mutant not killed with its line, mutator,
  replacement and, for an ignored one, its reason. When Stryker ran and failed, the report says the
  criterion isn't verified.
- A mutant the pull request says is killed but the report shows `Survived` or `NoCoverage` is a
  blocking finding. Running Stryker leaves **Check by hand**.

## Consequences

- The ticket's Stryker criterion is checked on every commit of its pull request, and the owner no
  longer runs Stryker by hand.
- The report lists every ignored mutant, so the reviewer sees each mutant a disable comment
  silences ([ADR-0068](0068-mutation-disables-that-would-hide-too-much.md)).
- A mutation ticket's review waits for the Stryker job, since the review starts when all of CI
  finishes: a few extra minutes for an API file.
- If an API file's run regularly nears 25 minutes, narrow it to the ticket's lines, or revisit.
