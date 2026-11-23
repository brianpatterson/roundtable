# 0057. Leave mutation testing of new code to the nightly run

- **Status:** Accepted
- **Date:** 2026-11-22
- **Amends:** [ADR-0039](0039-nightly-mutation-and-security-audit.md) (the implementer runs the web
  app's mutation testing locally)

## Context

ADR-0039 moved mutation testing off pull requests and kept one check per pull request: the
implementer ran Stryker on the web app before opening one, estimated at about 20 seconds. The web
app has grown since, and a full run now has well over a thousand mutants. On issue 134 the run was
about half done when the agent had to stop it. It never saw results for the component it had
added, and two of its attempts to rerun the command were denied. The run cost time and turns and
checked nothing.

Running Stryker only on the changed files would be faster, but getting that list right is its own
problem. New files are untracked until they're committed. A `--mutate` list replaces the config's
exclusions. In a rework run, `origin/main` may be missing or ahead of the branch. Every factory
ticket would follow those instructions, and the result would still be only advisory.

Since [ADR-0051](0051-nightly-mutation-tickets.md) and [ADR-0052](0052-more-mutation-tickets-behind-the-owners.md),
the nightly run doesn't just report survivors. It files tests-only `mutation` tickets, which the
factory builds.

## Options considered

1. **Keep the full run.** It no longer finishes in one command, so it checks nothing.
2. **Run Stryker on the changed files only.** It's fast, but the instructions for building the file
   list are fragile, as above, and each mistake silently skips the new code.
3. **Drop it from building and rework; leave it to the nightly run (chosen).** Builds are faster and
   simpler. Survivors in new code show up in the next night's report and come back as
   `mutation` tickets.

## Decision

The implementer doesn't run mutation testing when it builds a ticket or reworks a review. The
nightly run on main ([ADR-0039](0039-nightly-mutation-and-security-audit.md)) and its `mutation`
tickets ([ADR-0051](0051-nightly-mutation-tickets.md)) are the only mutation testing new code gets.
A `mutation` ticket still runs Stryker on its one file to confirm each kill.

## Consequences

- Builds and reworks are quicker and cheaper.
- A weak test in new code merges and is found within a day, not before review. A `mutation` ticket
  fixes it later, at the cost of another factory run and review.
- ADR-0051 listed "the implementer running Stryker on the API files it changed" as a possible next
  step. This decision drops that for the web app too.
- Revisit if the nightly tickets fall behind the survivors new code adds, or if Stryker gets fast
  enough on changed files for the check to be cheap and reliable.
