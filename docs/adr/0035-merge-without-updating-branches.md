# 0035. Merge pull requests without updating them first, and track main's health

- **Status:** Accepted
- **Date:** 2026-11-18

## Context

The ruleset for `main` required a pull request's branch to be up to date before it could merge
("Require branches to be up to date before merging"). With several pull requests open, every
merge made the others out of date. Each one then needed an update, a full CI run and, since
[ADR-0033](0033-review-every-pull-request.md), another review that spends the owner's Claude
limits, on code nothing had changed in. On 2026-11-17 and 18, #79, #81 and #88 each waited on
that, and a factory follow-up on #88 looked stuck when the branch fell behind mid-run.

GitHub's merge queue, which tests each pull request merged with the latest `main`, isn't
available to repositories owned by a personal account.

What protects production doesn't depend on that rule: Deploy runs only after CI passes on `main`
([ADR-0014](0014-push-based-deploys.md)), and a failed deploy rolls back.

## Options considered

1. **Keep the rule.** `main` never sees an untested combination, at the cost of a CI run and a
   review per open pull request per merge.
2. **Keep it, and have the agents merge `main` before each push.** Fewer stale branches, but a
   pull request can still fall behind while CI and the reviewer run.
3. **Drop the rule, and watch `main`.** Two pull requests that pass on their own can break `main`
   together (a renamed function and a new caller, two migrations, two lockfile changes). CI on
   `main` catches it and Deploy skips, so production stays on the last good release, but someone
   has to notice.

## Decision

Option 3. The owner turned off "Require branches to be up to date before merging" and turned on
"Always suggest updating pull request branches" (an "Update branch" button). The required checks
still have to pass on the pull request itself, and git conflicts still block a merge.

A new workflow, `Main health` (`.github/workflows/main-health.yml`), opens one `main-broken` issue
while CI or Deploy fails on `main`, comments on it for each further failure, and closes it when
that workflow passes again. No agent runs in it.

The one combination CI may not catch is two migrations that are each valid but conflict when
applied, and rollback doesn't undo a migration. So `CLAUDE.md` asks that a pull request adding a
migration or changing dependencies be updated with `main` before it merges.

## Consequences

- One CI run and one review per push, instead of one more per open pull request on every merge.
- `main` can be red for a while after a bad combination; the `main-broken` issue says so, and
  Deploy keeps production on the last good release until a fix merges.
- Revisit if the factory runs many pull requests at once, or if the repository moves to an
  organization, where the merge queue would do this properly.
