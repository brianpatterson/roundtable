# 0040. Sweep factory pull requests every 30 minutes so none is stuck without a label

- **Status:** Accepted; what happens to a factory pull request that conflicts with main is amended by [ADR-0058](0058-factory-resolves-conflicts.md), and what starts the sweep (a Cloudflare Cron Trigger every 20 minutes, not GitHub's cron) by [ADR-0060](0060-factory-clock.md)
- **Date:** 2026-11-20

## Context

Each factory workflow reacts to one event: the CI fixer to a failed CI run
([ADR-0028](0028-software-factory-ci-fixer.md)), the reviewer to a passing one
([ADR-0026](0026-software-factory-reviewer.md)), the rework to a `changes` verdict
([ADR-0037](0037-software-factory-rework.md)). A pull request that ends anywhere else waits with
nobody told. brianpatterson/roundtable#105 did: a job hit its time limit, which leaves CI
`cancelled`, not `failed`, so neither the fixer nor the reviewer started. It also conflicted with
main after another ADR took its number, and a conflict isn't an event any workflow sees. It had
the `factory` label and no `needs-human`, so it looked like it was still in progress.

The same gap exists for a CI run that never starts, one that hangs, a review that never comes,
and a fixer or rework run that crashes before it can label anything.

## Options considered

1. **Teach each workflow about the other endings** (the fixer also on `cancelled`, and so on).
   Covers timeouts, but not a conflict, a run that never starts, or a workflow that dies itself:
   those have no event to react to.
2. **A scheduled sweeper (chosen).** Every 30 minutes, look at each open factory pull request's
   state and decide. One place holds the rule "moving, or labeled `needs-human`", and it catches
   what no event announces.
3. **An agent that resolves conflicts and retries on its own.** More automatic, but it needs a
   write token and a model run for what is usually a one-line fix. Later, if conflicts are common.

## Decision

`.github/workflows/sweeper.yml` runs `.github/factory/sweep-prs.sh` every 30 minutes (and by hand,
with a dry run option) over open pull requests labeled `factory` or `autofix` without
`needs-human`, drafts included: the factory opens a draft when its checks still fail or it pushed
a branch without a pull request, and those are the likeliest to stall. No agent runs; it holds only the job's own token.

| State                                                               | Action                                                                                      |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Conflicts with main                                                 | `needs-human`                                                                               |
| No CI run on the head commit after 30 minutes                       | `needs-human`                                                                               |
| CI queued or running for over 90 minutes                            | `needs-human`                                                                               |
| CI `cancelled`, `timed_out` or anything else odd                    | rerun once; `needs-human` if it recurs                                                      |
| CI failed over 2 hours ago, no fix pushed                           | `needs-human` (the fixer died or gave up)                                                   |
| CI green over an hour ago, head commit not reviewed                 | `needs-human`, except Dependabot's own bumps, which the reviewer skips by design (ADR-0033) |
| Reviewer asked for changes over 2 hours ago on a `factory` PR       | `needs-human` (no rework was pushed)                                                        |
| Reviewer says ready, or changes on an `autofix`-only PR (no rework) | nothing: the owner's turn                                                                   |

Each `needs-human` comes with a comment giving the reason. The thresholds sit above how long each
step normally takes, so it doesn't race the workflow it's waiting for. The rules are one jq program,
pinned case by case by `.github/factory/test-sweep-prs.sh` in CI, which also checks that the
ready heading it matches is still the one `review.yml` writes. Each pull request is checked
in its own process, so one whose lookups or actions fail (GitHub refuses to rerun a run older
than 30 days) is reported as a warning and doesn't stop the rest.

## Consequences

- A factory pull request is never silently stuck for more than about two and a half hours.
- A run the owner cancels by hand on a factory pull request is rerun once. Add `needs-human` first
  to keep it stopped.
- A rerun requested with the job's token may not start the workflows that follow CI (GitHub limits
  what that token triggers). Then the next sweeps see a green commit with no review and hand it to a
  human: slower, but still not silent. Revisit with an app token if that happens often.
- Conflicts still need a person. If they become frequent (ADR numbers are the usual collision),
  add a CI check for a duplicate ADR number, which the CI fixer can then fix, or option 3.
- One more scheduled workflow: 48 short runs a day.
