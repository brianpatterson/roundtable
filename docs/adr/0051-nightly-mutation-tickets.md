# 0051. File a nightly mutation ticket that the factory builds without the owner's label

- **Status:** Accepted
- **Date:** 2026-11-22

## Context

Mutation testing runs nightly on main ([ADR-0027](0027-mutation-testing-stryker.md),
[ADR-0039](0039-nightly-mutation-and-security-audit.md)). It was moved off pull requests because a full
API run took about half an hour and stalled a factory pull request. Since then nothing acts on the
results. The score and the survivors sit in a job summary and an artifact that expires after 14
days. On 2026-11-22 the API scored 86%, with 131 mutants no test detects, 106 of them in the support
module. The web app scored 67%, with 203, 131 of them in `SignInPage.tsx`. Most of it sits in a few
files.

The factory already turns reports into work. The weekly architecture review opens issues
([ADR-0031](0031-weekly-architecture-review.md)), and the dispatcher builds `ready` tickets one at a
time ([ADR-0047](0047-factory-dispatcher.md)). But `ready` is the owner's sign-off that a ticket is
safe to build, and only the owner's label counts. Waiting for that label on every mutation ticket
would bring back the delay that moving mutation testing off pull requests removed.

StrykerJS's own guidance shapes what a ticket asks for ([mutant states](https://stryker-mutator.io/docs/mutation-testing-elements/mutant-states-and-metrics/),
[equivalent mutants](https://stryker-mutator.io/docs/mutation-testing-elements/equivalent-mutants/),
[disabling mutants](https://stryker-mutator.io/docs/stryker-js/disable-mutants/)):

- A survivor means a missing test. `NoCoverage` counts against the score the same way.
- An equivalent mutant can't be killed. Mark it with `// Stryker disable next-line <Mutator>: <reason>`,
  which keeps it in the report as `Ignored` with the reason. `excludedMutations` is the "shotgun approach".
- A score below 100% is fine.
- `--mutate <file>[:<lines>]` runs one file, so a fix can be confirmed in seconds (web) or minutes (API).

## Options considered

1. **Mutation tickets the owner labels**, like architecture issues. Nothing about trust changes, but
   every ticket waits for the owner, which is the slowness this is meant to remove.
2. **The nightly run opens pull requests itself**, with an agent in the mutation workflow. It's fast,
   but it's a second agent that writes code outside the dispatcher's queue. It would race tickets on
   the same files, and need its own credentials and guards.
3. **The nightly run files a ticket and labels it `ready` itself, and the dispatcher accepts that
   label on that kind of ticket only.** It reuses the dispatcher, implementer and reviewer as they
   are. What makes the label safe is how narrow the ticket is: tests only.

## Decision

Option 3.

- **Filing.** `mutation.yml`'s `file` job runs after the web and API jobs, from main only (elsewhere
  it prints the ticket). It uses `.github/factory/file-mutation-issue.sh`, pinned by
  `test-file-mutation-issue.sh` in CI. It picks the source file with the most `Survived` and
  `NoCoverage` mutants, and lists up to 25 of them in line order, with their mutator and replacement.
  It opens that as a `mutation` issue labeled `ready`, with the ticket form's headings. There's no
  agent in this step: the ticket is built from the report deterministically.
- **Pace.** One mutation ticket at a time: nothing is filed while one is open, so the factory gets at
  most one a night, and the owner's own tickets still interleave in the dispatcher's queue.
  - Closing a ticket as **not planned** stops tickets for that file.
  - A mutant that a finished ticket already listed isn't asked for again. Its pull request left it alive
    and said why, and asking again would loop. Each ticket keeps its mutants' keys (file, line, mutator,
    replacement) in a comment at the end of its description.
- **Approval.** The dispatcher counts a `ready` label as approval when the owner added it, or when it is
  a `mutation` ticket the workflow token both opened and labeled (`github-actions` in GraphQL). Edits by
  anyone else after that label still send the ticket back, as before. Nobody else can act as that token.
  An issue someone else opens and labels `mutation` gets no exception. Another workflow's issues don't
  either (an architecture issue, a security triage issue).
- **What the ticket allows.** The implementer's "Mutation tickets" section and the reviewer's checklist
  hold it to tests only, following Stryker's guidance:
  - Kill each survivor with a test of behavior a user or caller sees.
  - Mark a truly equivalent mutant with a single-mutator `next-line` disable comment with a reason.
    Never `disable all`, and never `excludedMutations`.
  - Leave alive, and name in the pull request, any mutant that only a change to the code, or a test of
    an implementation detail, could kill.
  - Confirm each kill with `test:mutation --mutate <file>`.

  The reviewer treats any other change to the source as blocking. A human still merges every pull request.

## Consequences

- The score climbs with no owner time per ticket beyond the merge. The worst files come first, which
  today means sign-in and the support module.
- Unlike the owner's label, the `ready` label on these tickets isn't a judgment that the work is worth
  doing. What makes it safe is the ticket's narrow scope, which the implementer's brief and the review
  enforce, not a mechanical check. A pull request that strays still needs the reviewer to block it and
  the owner not to merge it. If one gets through, add a CI check that a `mutation` pull request changes
  only test files and disable comments.
- Each ticket costs a factory run and a review. At one a night, the current backlog of about 330
  mutants takes a few weeks.
- Tickets are 25 mutants from last night's report, so line numbers may be stale by the time the ticket
  is built. The implementer confirms against a fresh run of that file.
- Not yet: a `thresholds.break` ratchet. Once scores settle, raise it after each merge so the score
  can't fall back. And the implementer running Stryker on the API files it changed, as it already does
  for the web app. That would stop new survivors at the source.
