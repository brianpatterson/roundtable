# 0037. Rework factory pull requests when the reviewer asks for changes, twice, then hand over

- **Status:** Accepted
- **Date:** 2026-11-19

## Context

The reviewer ([ADR-0026](0026-software-factory-reviewer.md)) posts a verdict on every pull
request once CI is green: `ready` or `changes`. On the factory's own pull requests, a `changes`
verdict waited for the owner to read it and comment `@claude address the review`, a mechanical
step that only restarted the implementer. The CI fixer ([ADR-0028](0028-software-factory-ci-fixer.md))
already closes the same loop for red checks.

Matt Pocock's `software-factory` skill (upstream, in progress) names this the **rework task**:
triggered when an automated review fails a pull request, it fixes only what the review named and
pushes, which triggers the review again; after a set number of fails it hands over to a human.

Forces:

- **Loops.** Implementer and reviewer can disagree forever, on the owner's subscription limits.
- **Chaining.** Comments and labels made with a workflow's own token start no workflows, so the
  review can't trigger the rework by commenting or labeling. A `workflow_run` on Review can, and
  CI → Review → Rework is three levels, GitHub's limit.
- **Concurrency.** A run started by `workflow_run` on Review reports `main` as its branch, so
  the Factory workflow's concurrency group (`factory-<branch>`) can't key it. And GitHub keeps
  only one pending run per group, cancelling the older: the Factory workflow took its branch's
  group for every check that finished, most of them no-ops, so one could replace a pending fix.
- **Untrusted comments.** Anyone can comment on a pull request in a public repository; the
  review the agent acts on must be the reviewer's.
- **Untrusted runs.** `workflow_run` matches workflows by name, so a fork's pull request can run
  a workflow of its own called Review, with whatever artifact it likes.
- **Wrong findings.** A reviewer finding can be wrong; an agent told to obey it would make the
  code worse to get a `ready`.

## Options considered

1. **A Rework workflow on `workflow_run` of Review**, reusing the implementer's instructions with
   a "Reworking a review" section, capped at two attempts like the CI fixer.
2. **A job in `factory.yml`.** One file for every implementer run, but its workflow-level
   concurrency group would put every rework in `factory-main`, where GitHub keeps only one
   pending run and cancels the rest.
3. **Review comments `@claude address the review`.** The implement job only accepts the owner,
   and a comment from the job's token triggers nothing anyway.
4. **Owner-only**, as before: the owner already reads every review, but restarting the
   implementer is the wait this removes.

## Decision

Option 1, in `.github/workflows/rework.yml`:

- **Which pull requests:** the factory's own (`factory` label, a branch of this repository),
  never one labeled `needs-human`. Not `autofix`: that label means "fix CI", and the owner's
  pull requests are theirs to change.
- **Trigger:** Review records `{pr, sha, verdict}` as a `review-verdict` artifact once it has
  posted its comment. Rework only reads it from a run of `main`'s `review.yml` started by its own
  triggers (`workflow_run` or `pull_request_target`, both run from `main`) in this repository. A cheap `select` job (no secrets) reads it and runs only on `changes` for
  the pull request's current head.
- **Two attempts,** counted from marked comments since the last commit with no bot among its
  authors, as the CI fixer does; then `needs-human` and a comment. The two caps are separate, so
  a pull request gets at most two CI fixes and two reworks between human pushes.
- **What it acts on:** a step writes only the reviewer's and earlier rework comments (posted by
  `github-actions[bot]` with their markers) to `.factory/review.md`. The agent fixes the
  findings and uncovered acceptance criteria, nothing else, and disputes a finding it judges
  wrong instead of obeying it. On its next pass the reviewer gets the rework comments, filtered
  the same way, in `rework/replies.md`, drops a finding whose dispute holds, and treats any other
  comment claiming to be a rework reply as anyone's text.
- **Deterministic checks:** "fixed" with no new commit becomes `needs-human`; a commit touching
  `.github/`, `.claude/` or `CLAUDE.md` fails the run, as in the CI fixer.
- **Concurrency:** the rework job's group is `factory-<branch>`, and the CI fixer's group moves
  from the Factory workflow's level to its `fix-ci` job, under the same name, so the two never
  push to one branch at once and runs that do nothing no longer hold the group. The selectors
  now run outside the group, so each job, once it holds the group, first checks the commit it
  was started for is still the head, and does nothing if another job pushed meanwhile. The
  agent pushes once, at the end, so CI on its push fails after it has finished, not while it's
  still holding the group.
- **Token, isolation, secrets:** as the CI fixer: the Claude App's token so pushes start CI,
  the `factory` environment, subprocess isolation and the secret guard
  ([ADR-0029](0029-software-factory-credential-hardening.md)).

## Consequences

- A factory pull request reaches the owner with the reviewer's verdict `ready`, or labeled
  `needs-human` with the dispute or the reason it stopped.
- Every `changes` verdict on a factory pull request costs a rework run, a CI run and a review;
  at most two rounds before a human.
- The reviewer's verdict now has a cost: a `changes` it didn't need starts a run. Its
  instructions say so.
- `@claude address the review` still works for the owner's own guidance, but its runs are
  grouped by pull request number (an `issue_comment` doesn't carry the branch), so it can run
  alongside a rework on the same branch. The owner waits for a rework run to finish first; a
  clash shows up as a rejected push, not lost work.
- Two runs can still meet in one branch's group (a rework waiting while a fix runs, and a third
  arriving); the older pending one is cancelled without its marker comment. Rare with today's
  timings, since a fix needs red CI and a rework green CI on the same head.
- Revisit if rework rounds mostly end in disputes (the reviewer's rules need sharpening, which
  the retro task in the same skill would propose), or to extend it to the owner's pull requests
  behind a label.
