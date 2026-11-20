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
  the Factory workflow's concurrency group (`factory-<branch>`) can't key it.
- **Untrusted comments.** Anyone can comment on a pull request in a public repository; the
  review the agent acts on must be the reviewer's.
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
  posted its comment. A cheap `select` job (no secrets) reads it and runs only on `changes` for
  the pull request's current head.
- **Two attempts,** counted from marked comments since the last commit with no bot among its
  authors, as the CI fixer does; then `needs-human` and a comment. The two caps are separate, so
  a pull request gets at most two CI fixes and two reworks between human pushes.
- **What it acts on:** a step writes only the reviewer's and earlier rework comments (posted by
  `github-actions[bot]` with their markers) to `.factory/review.md`. The agent fixes the
  findings and uncovered acceptance criteria, nothing else, and disputes a finding it judges
  wrong instead of obeying it. The reviewer reads the rework comments on its next pass and
  drops a finding whose dispute holds.
- **Deterministic checks:** "fixed" with no new commit becomes `needs-human`; a commit touching
  `.github/`, `.claude/` or `CLAUDE.md` fails the run, as in the CI fixer.
- **Concurrency:** the job's group is `factory-<branch>`, the same string as the CI fixer's, so
  the two never push to one branch at once.
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
- `@claude address the review` still works for the owner's own guidance.
- Revisit if rework rounds mostly end in disputes (the reviewer's rules need sharpening, which
  the retro task in the same skill would propose), or to extend it to the owner's pull requests
  behind a label.
