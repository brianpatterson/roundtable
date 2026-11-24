# 0067. Review the architecture when a spec's batch closes, with Monday as a backstop

- **Status:** Accepted
- **Date:** 2026-11-24

## Context

[ADR-0031](0031-weekly-architecture-review.md) runs the unattended architecture review every
Monday. The factory now builds features as batches: a spec's parent issue and its tickets as
sub-issues, and [ADR-0064](0064-factory-retro-per-batch.md) runs a retrospective the moment the
last of them closes. A batch is when the most code changes at once, so it's when an architecture
pass is worth the most: the deepening candidates it finds are fresh, and they land before the next
batch builds on the same modules. Waiting for Monday can mean a second batch has already started.

Forces:

- **The batch-closed check already exists** in Retro's `select` job (`select-retro.sh`). A second
  copy would drift.
- **A close by a workflow's own token starts no workflow,** except `workflow_dispatch`. Retro's
  `select` runs on the owner's or the implementer's close, so it can dispatch the review.
- **GitHub's cron runs hours late here and drops runs** ([ADR-0060](0060-factory-clock.md)). The
  Monday run is unreliable as the only trigger, but fine as a backstop.
- **The review costs one long Opus run** (20 to 40 minutes). Running it twice on the same commit
  of main finds nothing new.
- **Two runs can find the same candidate.** Each already leaves out open `architecture` issues and
  ones the owner closed, and the workflow skips an open issue with the same title; but a weekly
  run after a per-batch run doubles the chances.

## Options considered

1. **Per batch only, drop the Monday run.** Least cost, but code merged outside a spec (the owner's
   own pull requests, factory fixes, mutation tickets) waits for the next batch, and a batch the
   factory built none of never gets one.
2. **Per batch, and Monday unchanged.** Simple, but a quiet week pays for a second review of the
   code the batch run just covered.
3. **Per batch, and Monday as a backstop that skips itself when main hasn't changed** since a
   successful review.
4. **Per batch, scoped to the files the batch's pull requests changed.** Cheaper and focused, but
   the skill already weights recently changed code (its hot spots from `git log`), and a narrow
   scope misses the seams a batch strains elsewhere.

## Decision

Option 3, reviewing the whole codebase each time:

- **Trigger:** Retro gains an `architecture` job. When `select` finds a batch ready (through an
  issue close, not a backfill by hand), it starts `architecture.yml` by `workflow_dispatch` on
  main with the spec's number as `spec`. Same detection, one place.
- **Scope:** unchanged. The skill picks its hot spots from the history, which after a batch is
  mostly that batch. The prompt names the spec so the report can say why it ran.
- **Backstop:** the Monday cron stays. A new `select` job in `architecture.yml` runs
  `select-architecture.sh`, which skips the review when a successful run already exists on main's
  current commit. It applies to the Monday run and to per-batch runs (so two tickets closing
  together review once). A dispatch by hand without `spec` always runs.
- **No duplicates:** the issue step now skips a Strong candidate whose exact title is an open
  `architecture` issue or one closed in the last 30 days (`find-architecture-issue.sh`; it was a
  fuzzy title search over open issues). The agent's own reading of open and closed issues stays as
  ADR-0031 set it. Each issue says which run opened it: weekly, by hand, or after which batch.

This supersedes ADR-0031's **Weekly** bullet: the review runs after each batch, and on Mondays
only when main changed since the last one. The rest of ADR-0031 stands.

## Consequences

- Each feature gets an architecture pass within the hour it lands, beside its retrospective, and
  its Strong candidates are tickets before the next spec is cut.
- A week with batches costs one run per batch and usually no Monday run; a week without changes
  costs nothing. A week with several batches costs more than before.
- A batch the factory built none of gets no retrospective (ADR-0064), so no per-batch review
  either; the Monday backstop covers it.
- The 30-day title check can skip a real recurrence with the same title; the report artifact still
  lists it.
- Revisit scoping to the batch's files if per-batch runs keep finding candidates far from what
  the batch changed, or if their cost matters.
