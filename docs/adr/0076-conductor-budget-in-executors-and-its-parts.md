# 0076. Enforce the conductor's dispatch budget in the executors, and settle the conductor's parts

- **Status:** Accepted
- **Date:** 2026-11-27

## Context

Planning the Conductor's batch ([ADR-0075](0075-factory-conductor.md)) turned up five points
where building it needs more than ADR-0075 says, or something else:

- **The dispatch budget guards against the Conductor's own bugs.** A Conductor that misreads the
  evidence of a step (a marker comment, a run name) starts it again every time it wakes, and every
  Executor that finishes wakes it. The Attempt limits can't stop that loop, because they are
  counted from the same evidence. ADR-0075 puts the budget in the Conductor's `policy` table and
  has the Conductor enforce it. But the factory writes the Conductor (`tools/conductor/`), and
  ADR-0075's own rule is that an agent may change what decides, not what refuses harm.
- **"Approved" meant two things.** ADR-0075 names the state after a ready Review `approved`, while
  the dispatcher and the factory's glossary ([`docs/factory/GLOSSARY.md`](../factory/GLOSSARY.md))
  use Approval for the Owner's `ready` on a Ticket.
- **The history test needs past states.** It runs `decide` at every event in a recorded Work
  item's life, but GitHub answers with how things are now. ADR-0075's `gather` reads GitHub and
  builds the state in one step, as of now.
- **Executors and the Conductor must agree on how a run names its Work item**, so the Conductor
  can see what's queued or running for each, and count the budget.
- **Where the code is checked.** ADR-0075 has the Conductor's tests run "beside the other factory
  tests" in CI's `check` job, which would need a new root script, a CI step and an allowlist entry,
  all files the factory can't write.

## Options considered

1. **Follow ADR-0075 as written**: the Conductor enforces the budget, `approved` stays, and
   `gather` is tested only on hand-written states. The loop guard is code the factory can
   change, the word clashes with Approval, and the history test can't be built.
2. **Amend it on these five points**, as below.

## Decision

Option 2. ADR-0075 stands except for:

- **The Executors enforce the dispatch budget.** Before it acts, each Executor counts the runs
  named for its Work item, and all Executor runs, in the last 24 hours. Past either limit (20 per
  Work item, 60 in all, in one file under `.github/factory/`), it does nothing, labels the Work
  item `needs-human` with the reason, and fails, so the Owner is emailed. The Conductor still
  starts nothing past the limit, reading the same count, and shows how close each Work item is in
  `why`, but it doesn't label or fail for it.
- **The state after a ready Review is `reviewed`**, not `approved`. Approval is the Owner's.
- **`gather` reads, `observe` builds, `act` writes.** `gather` reads GitHub and returns its raw
  responses. A pure `observe(raw, at)` builds the Work item's state as it was at time `at`,
  ignoring everything later, so one recording of a past Work item gives a state at every event in
  its life. What GitHub only shows as it is now (mergeability) is `unknown` at a past time. `act`
  is the only code that writes to GitHub. The command line reads the clock once and passes it as
  `at`, and nothing else reads it.
- **Executor runs are named `<kind> #<item> <sha7>`**: the kind (`build`, `ci-fix`, `review`,
  `rework`, `conflict`, `mention`), the Work item's number, and the head commit it was started for
  (`-` before there is one).
- **The Conductor is a workspace package**, `@roundtable/conductor` in `tools/conductor/`, with no
  dependencies. `pnpm test` runs its `node --test` tests and `pnpm typecheck` its `tsc`, both
  already in `pnpm check` and in CI's `check` job, so it needs no new root script, CI step or
  allowlist entry. Node still runs it without `pnpm install`.

The design in full is `tools/conductor/README.md`.

## Consequences

- **Easier:** a Conductor bug can't spend past the budget, even one an agent wrote, because the
  check lives where the factory can't change it. The history test can replay the factory's real
  past. The words match the glossary.
- **Harder:** the budget is counted in two places, the Executors' guard and `decide`. They read
  the same run names, so a mismatch only makes the Conductor ask for a run the guard refuses,
  which is a Hand-over, not a loop. Each Executor's guard makes one more API call.
- **Revisit** if the budget trips on legitimate work: raise the numbers in their one file.
