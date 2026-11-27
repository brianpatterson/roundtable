# Conductor

The factory's Conductor ([ADR-0075](../../docs/adr/0075-factory-conductor.md), amended by
[ADR-0076](../../docs/adr/0076-conductor-budget-in-executors-and-its-parts.md)): it reads what
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
- **Only `gather.ts` reads GitHub and only `act.ts` writes to it.** Everything between is pure:
  the time is an argument, never `Date.now()`.

## How it decides

```
gather (GitHub)  →  raw  →  observe(raw, at)  →  state  →  decide(state, policy)  →  {state, action, reason}  →  act (GitHub)
```

- **`gather`** (`gather.ts`) reads everything one Work item's state depends on, as GitHub returns
  it, trimmed to the fields `observe` reads (below, and `raw.ts`). A Work item GitHub fails or
  refuses to answer about comes back unreadable, with the reason, and the rest are still read.
- **`observe(raw, at)`** (`observe.ts`) builds the Work item's state (`state.ts`) **as it was at
  time `at`**, ignoring everything later. Run with now, it is the state today; run with a past
  time, it is the state then, which is what the history test needs. What GitHub only shows as it
  is now (mergeability, the reviewer's comment, which is edited in place) is `unknown` when `at`
  is before the Work item's latest event, and `decide` handles `unknown` anyway: GitHub answers
  mergeability only a while after every push. It never throws: a field it can't read makes that
  part of the state `unknown`, with what was missing.
- **`decide(state, policy)`** is pure. It names the state, one of:
  - before the pull request: `waiting` (no Approval, a Blocker not Deployed, or another Ticket
    building), `building`, `needs-info`;
  - on the pull request: `checking`, `fixing`, `reviewing`, `reworking`, `resolving`, `reviewed`
    (a ready Review on the head: the Owner's turn. ADR-0075 called it `approved`; ADR-0076 renamed it, since Approval
    is the Owner's `ready`; see the glossary);
  - after: `merged`, then `deployed`;
  - anywhere: `needs-human`, a Hand-over, with the reason.

  It returns the action to take from that state (start an Executor, hand over, set a status,
  nothing) and the reason in a sentence.

- **`policy.ts`** holds every number: two Attempts per kind, two builds, a build stale after 90
  minutes, a merge not Deployed after 3 hours, and the sweeper's thresholds. `decide` also
  starts nothing for a Work item past the dispatch budget (below), and says so, but it isn't
  what enforces it.
- **`act`** carries the decisions out: labels, the one `<!-- factory-state -->` comment on each
  Ticket (edited only when the state changes), the `factory` status on the pull request's head,
  and `workflow_dispatch` of Executors. With `--dry-run` it prints each write instead.

## What `gather` reads

**The open Work items:** every open issue labeled `ready`, `building`, `needs-info` or
`needs-human`, and every open pull request labeled `factory` or `autofix` or opened by Dependabot.
A pull request that closes a listed issue belongs to that issue's Work item (the latest, if more
than one does); any other is a Work item of its own.

**For each Work item**, every connection and list followed through all its pages:

| Part          | From GitHub                                                                                                                                                                               | `observe` reads it for                                                  |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `ticket`      | the issue's `number`, `createdAt`, author; its timeline's labeled, unlabeled, renamed, closed (and what closed it) and reopened events; its `userContentEdits`                            | labels, Approval, held, `building`, open or closed at `at`              |
| `blockers`    | each issue in `blockedBy`, with the same timeline                                                                                                                                         | each Blocker open, merged or closed unmerged, Deployed and held at `at` |
| `pullRequest` | `number`, `createdAt`, author, `mergeable`, merge commit; each commit's `oid`, `committedDate` and authors' logins; its labeled, unlabeled, closed, reopened and merged events            | head, labels, merged, Attempts' human commits, mergeability             |
| `checks`      | each check run's `name`, `status`, `conclusion`, `started_at`, `completed_at`, on the head (or, for a history fixture, every commit)                                                      | each check's status at `at`                                             |
| `statuses`    | each commit status's `context`, `state`, `description`, `created_at`, on the same commits                                                                                                 | statuses at `at`, and a past Review from the `factory` status           |
| `comments`    | the workflow's (`github-actions[bot]`) comments that start with a marker (`markers.ts`), cut to their marker, heading and footer lines                                                    | Attempts, and the Review                                                |
| `deploys`     | the latest 100 successful Deploy runs' `head_sha` and `updated_at`                                                                                                                        | when a deploy completed                                                 |
| `inclusions`  | GitHub's compare of each merge commit with the deploys after it, oldest first, until one includes it                                                                                      | Deployed                                                                |
| `runs`        | every Executor run (named as below, started by `workflow_dispatch`) created in the 24 hours before `at`: `display_title`, `event`, `status`, `created_at`, `run_started_at`, `updated_at` | runs queued or running, and the budget's counts                         |

**What a past `at` can't know exactly**, because GitHub doesn't keep it:

- The head at `at` is the latest commit _committed_ by then: GitHub doesn't say when a commit was
  pushed. A rebase or a force push makes a past head approximate.
- The list of Blockers is today's: GitHub's timeline doesn't hold when a dependency was added.
- A past Review comes from the `factory` status after each review ("Done: ready for you", "Done:
  changes needed") and the `factory-review-changes` comments, which a later review deletes; where
  neither says, it is `unknown`.
- A change merged before the oldest of the 100 deploys read counts as Deployed only from that
  deploy on.

## Executor run names

Every Executor run is named `<kind> #<item> <sha7>`: the kind (`build`, `ci-fix`, `review`,
`rework`, `conflict`, `mention`), the Work item's number (the Ticket's, or the pull request's when
there's no Ticket), and the first 7 characters of the head commit it was started for (`-` before
there's a pull request). `gather` lists recent runs and reads these names to see what is queued or
running for each Work item. Only runs started by `workflow_dispatch` count, which only a
collaborator can start: a pull request's CI runs carry its title, which anyone can make look like
an Executor run's name. The run's name exists from the moment it's queued, so two decisions
can't both start one. `run-name.ts` makes and parses them, one function each.

## The dispatch budget

At most **20 Executor starts per Work item, and 60 in all, in any 24 hours**, counted from
GitHub's list of runs by their names. A busy Ticket uses about 15. The budget is there for one
failure: a Conductor that misreads the evidence of a step (a marker comment, a run name) starts
it again every time it wakes, and every Executor that finishes wakes it, so a loop would run an
agent every few minutes until someone noticed. The Attempt limits can't stop that, because they
are counted from the same evidence.

It is a refusal, so the Executors enforce it, in their guards under `.github/` (the Owner's
wiring), not this package: the factory writes the Conductor, and an agent may change what
decides but not what refuses harm (ADR-0075, ADR-0076). Before it acts, each Executor counts the runs
named for its Work item, and all Executor runs, in the last 24 hours; past either limit it does
nothing, hands the Work item over with the reason, and fails, so the Owner is emailed. The
numbers live in one file there. `decide` reads the same count to stop asking, and to show how
close a Work item is in `why`.

## The history test

`decide` is tested on the factory's real past, not only on cases written by hand. `record.ts`
saves `gather`'s raw responses for a list of past Work items, chosen to cover every state at least
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
  `needs-human`, a hard cap of Attempts, and the dispatch budget.
- The `FACTORY_CONDUCTOR` repository variable: `on` turns the Conductor on and today's deciding
  workflows off, `off` turns them back.
