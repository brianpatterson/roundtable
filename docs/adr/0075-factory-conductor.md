# 0075. Decide every factory step in one conductor, from state derived from GitHub each time

- **Status:** Accepted
- **Date:** 2026-11-27

## Context

The factory is choreography. Eight workflows react to GitHub events, and each works out on its
own what state a ticket or its pull request is in: the dispatcher ([ADR-0047](0047-factory-dispatcher.md)),
the build and the CI fixer ([ADR-0025](0025-software-factory-implementer.md), [ADR-0028](0028-software-factory-ci-fixer.md)),
Review and Rework ([ADR-0026](0026-software-factory-reviewer.md), [ADR-0037](0037-software-factory-rework.md)),
the conflict resolver ([ADR-0058](0058-factory-resolves-conflicts.md)), the sweeper
([ADR-0040](0040-factory-sweeper.md)) and the `factory` status ([ADR-0063](0063-factory-status-check.md)).
A map of them on 2026-11-27 found:

- **The same decision in several places.** Whether a ticket was edited after `ready` is decided
  in three places. The review verdict is in four: `post-review.sh`, the sweeper's re-parse of the
  comment's heading, Rework's artifact, and a copy of Rework's test in `factory-status.sh`.
  "Is this the factory's pull request?" is decided in five, and "has the head moved?" in five.
  Timeouts and limits are spread over three files.
- **Races.** Two CI-fix selects for one commit (CI, CodeQL and dependency review failing
  together) can both count "attempt 1" before either waits on the branch's concurrency group.
  The conflict resolver has no workflow-level group, and can start from CI on `main` and from the
  sweeper at once. `@claude` on a pull request isn't in the branch's group, so it can push at the
  same time as a fix or a rework. GitHub keeps one pending run per concurrency group and silently
  drops the rest, so edge-triggered workflows can lose events.
- **Gaps.** A factory pull request labeled `needs-human` holds the whole queue, because the
  dispatcher never reads pull request labels. A commit merged but never deployed stays in flight
  with no timeout. A `pending` "deciding on a rework" status can stay pending forever. Builds have
  no attempt limit.
- **What works:** `dispatch.sh` already splits `gather` (all I/O and time) from a pure `decide`
  (state in, `{action, reason}` out) and `act`, and `test-dispatch.sh` tests `decide` on small
  patches of one base state. `sweep-prs.sh --decide` does the same.

Batch branches ([ADR-0074](0074-batch-merges.md)), accepted but not built, would add the most
transitions yet: the batch pull request, two new statuses, merge order.

Forces: the owner is the only human, so a stuck item is noticed late; the factory's agents must
not be able to change what decides for them; everything runs in GitHub Actions, with no server of
the factory's own.

## Options considered

1. **Keep the choreography and fix each race and gap where it is.** Least change now, but every
   fix adds another place that knows the state, and batches double it.
2. **One shared `decide`, called as a guard** at the start of every workflow, which runs only if
   the decision names its own action. Removes the duplicated logic, but not the races: two guards
   can read the same state and both decide "attempt 1".
3. **One conductor.** A single workflow, in one concurrency group, that every event wakes. It
   gathers the state of every open item from GitHub, decides each one's next action, and starts
   executor workflows that do the work but never decide.
4. **A stored state machine**: an explicit state per item in a label or a hidden JSON comment,
   written on every transition. The state can disagree with GitHub (a label added by hand, a run
   that dies before it writes), and then needs reconciling anyway.
5. **An orchestrator outside GitHub** (a workflow engine, or a service on the droplet). Durable
   timers and retries, but a new service holding GitHub credentials, for a handful of items.

## Decision

Option 3: a **conductor** decides, **executors** act, and the state is **derived** from GitHub on
every run, never stored.

- **Work items.** The unit is a ticket and its pull request together. A pull request with no
  ticket (Dependabot's, one labeled `autofix`, the owner's own) is an item with no ticket. Once
  ADR-0074 is built, a batch is an item too.
- **`gather`** reads everything an item's state depends on: labels and who added them, the
  timeline, edits, blocking edges, the pull request's head, checks, statuses, mergeability and
  labels, the reviewer's comment, the factory's marker comments (the attempt counts, still
  counted since the last human push, [ADR-0028](0028-software-factory-ci-fixer.md)), which
  executor runs are queued or running, and what is deployed. It is the only code that reads
  GitHub or the clock.
- **`decide`** is a pure function from one item's gathered state to `{state, action, reason}`.
  The state is one name from a fixed list:
  - before the pull request: `waiting` (not approved, blocked or queued), `building`,
    `needs-info`;
  - on the pull request: `checking`, `fixing`, `reviewing`, `reworking`, `resolving`,
    `approved` (the owner's turn, or the batch's);
  - after: `merged`, then `deployed`;
  - anywhere: `needs-human`, with the reason;
  - a batch: `collecting`, `gating`, `merging`, `deployed`.

  An action only ever starts from a named state. Every limit and timeout lives in one `policy`
  table beside it: two attempts per kind, the stale build, the sweeper's thresholds. Two rules
  change:
  - **Builds get a limit too:** two, then `needs-human`.
  - A commit **merged but not deployed** after 3 hours goes to `needs-human`.

- **`needs-human` releases the slot.** The item waits for the owner, and the next ticket can
  start. Tickets it blocks still wait, through their blocking edges. One at a time
  ([ADR-0047](0047-factory-dispatcher.md)) now means one _building_, not one waiting on the owner.
- **The conductor** is one workflow, `conductor.yml`, in one concurrency group that doesn't
  cancel runs in progress. It is **level-triggered**: every run gathers and decides every open
  item, whatever woke it, so a run GitHub drops loses nothing. It wakes on issue and pull request
  events, comments, the completion of CI, CodeQL, dependency review and Deploy, a `workflow_dispatch`
  from each executor as it finishes, and the factory clock's 20-minute heartbeat
  ([ADR-0060](0060-factory-clock.md)). It writes labels and comments with `GITHUB_TOKEN`, so its
  own writes never wake it. It never checks out a pull request's code, and always runs `main`'s
  copy.
- **Executors** do one thing for one item: build, fix CI, review, rework, resolve a conflict,
  answer `@claude`, and later `batch-merge.yml`. The conductor starts them by `workflow_dispatch`
  with the item, the kind, the head commit it decided on and the attempt number. An executor
  checks the head hasn't moved before it pushes, leaves its evidence where `gather` reads it (a
  marker comment, a status, a push), and dispatches the conductor when it ends. It doesn't
  decide whether to run, and doesn't count attempts. The conductor starts nothing for an item
  that has an executor queued or running, which ends the duplicate fixes and resolvers and puts
  `@claude` in line with the rest.
- **The owner's actions are inputs**: labels, pushes, merges and comments, as today. Adding
  `needs-human` means hands off; removing it hands the item back.
- **Seeing why.** The conductor sets the `factory` status on the pull request's head
  ([ADR-0063](0063-factory-status-check.md)) and keeps one `<!-- factory-state -->` comment on
  the ticket, edited only when the state changes. `scripts/factory-why.sh <n>` runs `gather` and
  `decide` locally, without acting, and prints the state, the action and the evidence.
- **Code.** TypeScript in `.github/factory/conductor/`, run by Node directly (type stripping) with
  no dependencies, so it needs no `pnpm install` and adds nothing to the lockfile
  ([ADR-0050](0050-factory-adds-no-dependencies.md)), and tested with `node --test` in CI's
  `check` job beside the other factory tests. `decide`'s tests keep `test-dispatch.sh`'s shape: one
  base state and a small patch per case. Under `.github/`, it is out of the agents' reach and an
  owner path (ADR-0074).
- **Migration, in shadow first.** The conductor first runs alongside today's workflows, deciding
  on every event and writing its verdicts to the job summary and an artifact, acting on nothing.
  Then the executors move over one at a time, each once a week of the conductor's verdicts shows
  no disagreement that isn't explained: the dispatcher first (it is already `decide`), then the
  sweeper, Review, Rework, the CI fixer and the conflict resolver. Each move deletes that
  workflow's own selection logic (`dispatch.sh`, `sweep-prs.sh`, `attempt.sh next`,
  `select-conflicts.sh`, the `select` jobs). Batch branches are built after the cutover, with
  `batch-merge.yml` as an executor.

This amends ADR-0040 (the sweeper's rules move into the conductor), ADR-0047 (who dispatches,
the build limit, and `needs-human` releasing the slot), ADR-0048 (`@claude` is started by the
conductor), ADR-0063 (who sets the `factory` status) and ADR-0074 (`batch-merge.yml` is started by
the conductor). What each executor does, its limits and its prompts are unchanged.

## Consequences

- **Easier:** one place answers "why is #N stuck?", in code, a comment and a local command. A new
  rule or state is a case in one function with a one-line test. The races above can't happen,
  because one run at a time decides. Batch branches add states to `decide` rather than another
  workflow that works out the state on its own.
- **Harder:** the conductor is a single point of failure; if it breaks, nothing in the factory
  moves. The clock's heartbeat ([ADR-0060](0060-factory-clock.md)) moves to it, so an hour
  without a conductor run alerts. Each step waits one extra hop (the conductor's run) before its
  executor starts. Every run reads every open item, which costs API calls per run, and the
  shadow period runs both systems for weeks.
- **Revisit** if open items grow past a few dozen or GitHub's API limits bite (gather only the
  item the event names, with the heartbeat still sweeping all), if GitHub Actions' scheduling
  proves too unreliable for a single conductor, or if the factory moves off GitHub Actions.
