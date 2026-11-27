# Conductor

The factory's Conductor ([ADR-0075](../../docs/adr/0075-factory-conductor.md)): it reads what
GitHub shows about every open Work item, decides each one's next step, and starts an Executor to
take it. The words are the factory's ([`docs/factory/GLOSSARY.md`](../../docs/factory/GLOSSARY.md)).

**Status:** being built. Nothing here runs in production until the Owner's wiring (below), so a
change to it changes nothing live. It is an Owner path (ADR-0074).

## Rules for this package

- **No dependencies**, of any kind (`package.test.ts` fails on one): the Conductor runs with Node
  alone, from `main`'s copy, without `pnpm install`.
- **Node runs the TypeScript as it is**, stripping the types: only syntax it can erase (no
  `enum`, no parameter properties, no `namespace`), and imports that name the `.ts` file
  (`./decide.ts`). `pnpm --filter @roundtable/conductor typecheck` checks it, and tests are
  `*.test.ts` files run by `node --test` (`pnpm --filter @roundtable/conductor test`). Both run in
  `pnpm check`.
- **GitHub through `fetch`**, Node's own, against GitHub's GraphQL and REST APIs with the token in
  `GH_TOKEN`. Every function that calls GitHub takes the `fetch` to use, so tests pass a stand-in
  (as `infra/factory-clock/worker.test.js` does).
- **Only `fetch.ts` reads GitHub and only `act.ts` writes to it.** Everything between is pure:
  the time is an argument, never `Date.now()`.

## How it decides

```
fetch (GitHub)  →  raw  →  observe(raw, at)  →  state  →  decide(state, policy)  →  {state, action, reason}  →  act (GitHub)
```

- **`fetch`** gathers everything one Work item's state depends on, as GitHub returns it, trimmed
  to the fields `observe` reads: the Ticket's labels and who added them, its timeline (labeled,
  unlabeled, edited, closed), its Blockers, the pull request's commits and head, checks, statuses
  and mergeability, the reviewer's comment, the factory's marker comments, the Executor runs (by
  run name, below) and the last successful deploy.
- **`observe(raw, at)`** builds the Work item's state **as it was at time `at`**, ignoring
  everything later. Run with now, it is the state today; run with a past time, it is the state
  then, which is what the history test needs. What GitHub only shows as it is now (mergeability)
  is `unknown` at a past time, and `decide` handles `unknown` anyway: GitHub answers it for a
  while after every push.
- **`decide(state, policy)`** is pure. It names the state, one of:
  - before the pull request: `waiting` (no Approval, a Blocker not Deployed, or another Ticket
    building), `building`, `needs-info`;
  - on the pull request: `checking`, `fixing`, `reviewing`, `reworking`, `resolving`, `reviewed`
    (a ready Review on the head: the Owner's turn. ADR-0075 lists it as `approved`, but Approval
    is the Owner's `ready`; see the glossary);
  - after: `merged`, then `deployed`;
  - anywhere: `needs-human`, a Hand-over, with the reason.

  It returns the action to take from that state (start an Executor, hand over, set a status,
  nothing) and the reason in a sentence.

- **`policy.ts`** holds every number: two Attempts per kind, two builds, a build stale after 90
  minutes, a merge not Deployed after 3 hours, the sweeper's thresholds, and the dispatch budget:
  at most **20 Executor starts per Work item, and 60 in all, in any 24 hours**. Past either, the
  Conductor starts nothing more, hands the Work item over, and fails its run so the Owner is
  emailed.
- **`act`** carries the decisions out: labels, the one `<!-- factory-state -->` comment on each
  Ticket (edited only when the state changes), the `factory` status on the pull request's head,
  and `workflow_dispatch` of Executors. With `--dry-run` it prints each write instead.

## Executor run names

Every Executor run is named `<kind> #<item> <sha7>`: the kind (`build`, `ci-fix`, `review`,
`rework`, `conflict`, `mention`), the Work item's number (the Ticket's, or the pull request's when
there's no Ticket), and the first 7 characters of the head commit it was started for (`-` before
there's a pull request). `fetch` lists recent runs and reads these names to see what is queued or
running for each Work item, and to count the budget. The run's name exists from the moment it's
queued, so two decisions can't both start one.

## The history test

`decide` is tested on the factory's real past, not only on cases written by hand. `record.ts`
saves `fetch`'s raw responses for a list of past Work items, chosen to cover every state at least
once, as fixtures in `history/`, and derives what the factory did next after each event in their
lives (the next marker comment, label, push or merge). The history test runs
`decide(observe(raw, at))` at every one of those moments and expects the state and action the
factory took. Where today's workflows were wrong (a `needs-human` pull request holding the whole
queue, say), the fixture names the fault, and the test expects the Conductor's answer instead.
The fixtures hold only what GitHub shows publicly on this repository: never a token, never a
User report.

## The command line

- `node tools/conductor/main.ts run [--dry-run]`: one pass over every open Work item.
- `node tools/conductor/main.ts why <n>`: one Work item's state, action, reason and evidence,
  without acting. `scripts/factory-why.sh <n>` runs it with `gh auth token`.
- `node tools/conductor/main.ts record <n>…`: records Work items as history fixtures.

## The Owner's wiring

Under `.github/`, which the factory can't write, and built after this package:

- `conductor.yml`: one concurrency group, woken by issue, pull request, comment and workflow
  events, the Executors and the factory clock, running `main.ts run`.
- Each Executor gets a `workflow_dispatch` entry with its inputs, its run name, and its own
  guards: the Owner's Approval with no edit since, the head it was started for, no
  `needs-human`, and a hard cap of Attempts.
- The `FACTORY_CONDUCTOR` repository variable: `on` turns the Conductor on and today's deciding
  workflows off, `off` turns them back.
