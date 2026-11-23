# 0058. Resolve factory pull requests' conflicts with main automatically, and check ADR numbers

- **Status:** Accepted
- **Date:** 2026-11-23
- **Amends:** [ADR-0040](0040-factory-sweeper.md) (a factory pull request that conflicts with main
  went to a human)

## Context

The sweeper ([ADR-0040](0040-factory-sweeper.md)) hands a pull request that conflicts with main to
a human, and expected conflicts to be rare. Three factory pull requests have conflicted since, all
for the same reason: two pull requests written at the same time took the same ADR number and added
their row at the end of `docs/adr/README.md`. #105 did. #149 took ADR-0052. #155 took ADR-0057
after #154, the owner's, took it while #155 was being reviewed. The implementer already merges
main before it opens a pull request, so this only happens when something merges while the pull
request is open. The dispatcher builds one ticket at a time, but the owner's own pull requests and
earlier factory pull requests waiting to be merged still land in between.

Each conflict stopped a pull request that was otherwise ready, until the owner merged main and
renumbered the ADR by hand. That's a mechanical job.

There's a quieter version of the same problem: when the two index rows don't touch, git sees no
conflict and two ADRs share a number on main.

Forces:

- **GitHub doesn't announce a conflict.** No event fires when a pull request starts conflicting.
  Its mergeability is recalculated in the background after main moves, and reads as `UNKNOWN`
  until then.
- **Conflicts can't be prevented here.** GitHub's merge ignores custom merge drivers in
  `.gitattributes` (a `union` driver for the index), and renaming the ADRs so they can't collide
  would rewrite every link to them.
- **Tokens.** A push made with the workflow's own token starts no CI, as with the CI fixer
  ([ADR-0028](0028-software-factory-ci-fixer.md)).
- **Loops.** An agent that keeps resolving, or keeps failing to, spends the owner's limits.

## Options considered

1. **A resolver workflow (chosen):** after every merge to main, find factory pull requests that now
   conflict, merge main into each, and have the implementer resolve the rest. The sweeper starts it
   for a conflict that run missed.
2. **An `@claude resolve the conflict` comment from the owner,** as now. Works, but it's the manual
   step this removes.
3. **Only a CI check for duplicate ADR numbers,** which ADR-0040 suggested. It turns a silent
   duplicate into a red check the CI fixer can fix, but a conflicting pull request gets no CI at
   all, so it doesn't help with conflicts.
4. **Rebase instead of merge.** Rewrites the branch's history under the reviewer's comments, and
   would need a force push, which nothing in the factory does.

## Decision

Option 1, with option 3 as its check.

- **`pnpm check:adrs`** (`scripts/check-adrs.ts`, in `pnpm check` and CI) fails when two ADRs share
  a number, a heading doesn't match its file, or the index doesn't have exactly one row for each
  ADR. `scripts/test-check-adrs.sh` checks each failure on small fixtures, since main never has one.
- **`.github/workflows/resolve-conflicts.yml`** runs when CI passes on main (after every merge),
  and through `workflow_dispatch` for one pull request. Either way it merges nothing until CI has
  passed on main's head: a broken main would fail every pull request it reached, and the CI fixer
  would spend their attempts on main's failure. A `select` job with no secrets runs
  `.github/factory/select-conflicts.sh`: open pull requests from this repository labeled `factory`
  and not `needs-human`, waiting up to two minutes for GitHub to work out whether each conflicts.
  `autofix`-only pull requests are left out: Dependabot rebases its own, and the owner's are the
  owner's.
- **Each one gets a `resolve` job** in the `factory` environment, in the branch's concurrency group
  (shared with the CI fixer and rework). It merges main into the branch without committing, before
  installing, so the agent starts with only the conflicts. The implementer follows "Resolving a
  conflict with main": keep both sides, renumber this pull request's ADR if main took its number,
  regenerate a migration rather than edit main's, then run `pnpm check`, commit the merge and push
  with the Claude App's token, so CI and the reviewer run again.
- **What it can't do:** edit `.github/`, `.claude/` or `CLAUDE.md`, or resolve a conflicted
  lockfile. Those, and anything needing a decision, go to `needs-human` with what it would do.
- **Checked after the agent, whatever it reports** (`.github/factory/report-conflict-attempt.sh`,
  tested by `test-report-conflict-attempt.sh`): main is in the branch, no conflict markers were
  pushed, and the pull request's changes against main touch none of the protected paths, which
  the agent could still reach with `git restore` or `git mv`. Otherwise, or if the agent answers
  `needs-human`, a human takes over at once. If GitHub can't compare the branch with main, nothing
  can be checked, so a human takes over then too, even after a crash. A push is checked even when
  the agent crashed before answering, since the pull request no longer conflicts and no later run
  would look at it; one that passes counts as resolved. A changed file GitHub shows no diff for
  (large, binary, or past the compare's 300 files) can't be checked for markers, so it goes to a
  human.
- **Attempts:** each comment names the main commit it merged. A run that crashes or times out
  without an answer isn't a verdict: the next run (the next merge, or the sweeper) retries once
  against the same main commit, and a second crash goes to a human. A later main commit is a new
  conflict with attempts of its own.
- **The sweeper** starts the resolver for a conflicting factory pull request instead of labeling it,
  unless a resolver run is already queued or running. GitHub keeps one pending job per concurrency
  group and cancels the one before it, so a resolver queued every 30 minutes could replace a
  pending fix or rework on the same branch. A conflicting `autofix`-only pull request still goes to
  a human.

## Consequences

- While main is red, a conflicting factory pull request waits without a label: the resolver merges
  nothing until main is green, and says so only in its run log. The `main-broken` issue
  ([ADR-0035](0035-merge-without-updating-branches.md)) is the signal then, and the first green CI
  on main starts the resolver.
- A resolver started by a merge can still replace a fix or rework pending on the same branch; the
  sweeper then hands that pull request to a human as "changes asked and never reworked". Rare: it
  needs a merge to main while that branch's job is already queued behind a running one.

- A factory pull request that falls behind main is merged up and reviewed again without the owner,
  usually within minutes of the merge that caused it. ADR collisions, the usual cause, are
  renumbered.
- Each resolution costs an agent run, a CI run and a review. The re-review is wanted: the merge is
  new code, even when the conflict was only an index row.
- A pull request's description can still mention its old ADR number: the agent can't edit it, so
  its summary gives the old and new number.
- Two ADRs can no longer share a number on main, whichever path led there.
- Revisit if the resolver's merges start hiding real disagreements between pull requests (the
  reviewer reads each one), or if the repository moves to an organization, where the merge queue
  would test each pull request against the latest main instead.
