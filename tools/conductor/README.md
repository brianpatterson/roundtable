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
- **`decide(states, policy)`** (`decide.ts`) is pure: it takes every open Work item's state, since
  one Ticket's build waits on the others', and returns `{number, state, action, reason}` for each.
  It names the state, one of:
  - before the pull request: `waiting` (no Approval, a Blocker not Deployed, or another Ticket
    building), `building`, `needs-info`;
  - on the pull request: `checking`, `fixing`, `reviewing`, `reworking`, `resolving`, `reviewed`
    (a ready Review on the head: the Owner's turn. ADR-0075 called it `approved`; ADR-0076 renamed it, since Approval
    is the Owner's `ready`; see the glossary);
  - after: `merged`, then `deployed`;
  - anywhere: `needs-human`, a Hand-over, with the reason.

  It returns the action to take from that state, one of: nothing; **start** an Executor (its
  kind, the Work item, the head and which Attempt, or Rework's Minor pass); **hand over**
  (label `needs-human`, and take `building` off a Ticket, with the reason); **withdraw** the
  Approval (take the Owner's `ready` off a Ticket edited since, with the reason); or **rerun** the
  checks on the head that ended cancelled or timed out. The reason is one plain sentence: what the
  Work item waits for, and what the Owner can do when it waits on them. `act` sets the `factory`
  status and the `<!-- factory-state -->` comment from the state and reason on every run.

  The rules, in the order `decide` applies them:
  - **An Executor queued or running** for the Work item: nothing more starts, and the state names
    it (`building`, `fixing`, `reviewing`, `reworking`, `resolving`; a mention keeps the state).
  - **The Owner's `@claude`** on the pull request, after the last mention run: start the
    `mention` Executor, except on one handed over, which every Executor's guard refuses: remove
    `needs-human` to have it answered.
  - **Merged:** `deployed` once a deploy includes the merge; handed over when it isn't Deployed
    3 hours after it merged, naming the merge commit.
  - **Before the pull request,** as `dispatch.sh` decides, except that `needs-human` and
    `needs-info` hold no slot: one Ticket builds at a time, from its build until its merge is
    Deployed, and a Work item that couldn't be read holds the slot until it can be; the Owner's Tickets before the nightly run's, each oldest Approval first. A build
    that ended without a pull request is started again, and handed over after two. A Ticket
    `building` with no build run and no pull request after 90 minutes is handed over.
  - **On the pull request,** as `attempt.sh next` and `sweep-prs.sh` decide: a conflict goes to
    the resolver (the factory's own pull requests, two Attempts per commit of `main`), and
    mergeability `UNKNOWN` waits for GitHub; CI not started after 30 minutes or running after 90
    is handed over; a failure goes to the CI fixer (labeled `factory` or `autofix`, two Attempts
    since the last human push); a cancelled check is rerun once; a pass goes to the reviewer,
    except on a pull request with only Dependabot's commits; `changes` go to Rework (the factory's
    own, two Attempts), and a ready Review with minor findings gets one Minor pass. A pull request
    labeled neither `factory` nor `autofix` is reviewed, but, as the sweeper leaves it, never
    handed over or rerun: its reason says what the Owner can do. Where an
    Executor has already answered the evidence (its run was asked for after it) and nothing
    changed, `decide` waits, then hands over after the sweeper's threshold for it.
  - **The dispatch budget** (below): where a start would pass it, `decide` starts nothing and says
    so, without handing over.

- **`policy.ts`** holds every number: two Attempts per kind, one Minor pass, two builds, a build
  stale after 90 minutes, a merge not Deployed after 3 hours, the sweeper's thresholds (30 minutes
  for CI to start, 90 to run, 60 for a Review after CI passes, 120 for a fix or a rework to land),
  one rerun, and the budget's limits. `decide` has no number of its own. It starts nothing for a
  Work item past the dispatch budget (below), and says so, but it isn't what enforces it.
- **`act`** carries the decisions out: labels, the one `<!-- factory-state -->` comment on each
  Ticket (edited only when the state changes), the `factory` status on the pull request's head,
  and `workflow_dispatch` of Executors. With `--dry-run` it prints each write instead.

## What `gather` reads

**The open Work items:** every open issue labeled `ready`, `building`, `needs-info` or
`needs-human`, and every open pull request labeled `factory` or `autofix` or opened by Dependabot.
A pull request that closes a listed issue belongs to that issue's Work item (the latest, if more
than one does); any other is a Work item of its own.

**For each Work item**, every connection and list followed through all its pages:

| Part          | From GitHub                                                                                                                                                                                                               | `observe` reads it for                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `ticket`      | the issue's `number`, `createdAt`, author; its timeline's labeled, unlabeled, renamed, closed (and what closed it) and reopened events; its `userContentEdits`; the dispatcher's comments, cut to the marker and one line | labels, Approval, held, `building`, open or closed at `at` (the recorder reads the dispatcher's queue) |
| `blockers`    | each issue in `blockedBy`, with the same timeline                                                                                                                                                                         | each Blocker open, merged or closed unmerged, Deployed and held at `at`                                |
| `pullRequest` | `number`, `createdAt`, author, `mergeable`, merge commit; each commit's `oid`, `committedDate` and authors' logins; its labeled, unlabeled, closed, reopened and merged events                                            | head, labels, merged, Attempts' human commits, mergeability                                            |
| `checks`      | each check run's `name`, `status`, `conclusion`, `started_at`, `completed_at`, on the head (or, for a history fixture, every commit)                                                                                      | each check's status at `at`                                                                            |
| `statuses`    | each commit status's `context`, `state`, `description`, `created_at`, on the same commits                                                                                                                                 | statuses at `at`, and a past Review from the `factory` status                                          |
| `comments`    | the workflow's (`github-actions[bot]`) comments that start with a marker (`markers.ts`), cut to their marker, heading and footer lines, and each minor finding's mark without its text                                    | Attempts, and the Review with its minor findings                                                       |
| `mentions`    | when the Owner commented `@claude` on the pull request, without the text                                                                                                                                                  | a mention to answer                                                                                    |
| `main`        | the latest 100 commits of `main`: `sha` and committer date                                                                                                                                                                | the head of `main`, which conflicts count against                                                      |
| `deploys`     | the latest 100 successful Deploy runs' `head_sha` and `updated_at`                                                                                                                                                        | when a deploy completed                                                                                |
| `inclusions`  | GitHub's compare of each merge commit with the deploys after it, oldest first, until one includes it                                                                                                                      | Deployed                                                                                               |
| `runs`        | every Executor run (named as below, started by `workflow_dispatch`) created in the 24 hours before `at`: `display_title`, `event`, `status`, `created_at`, `run_started_at`, `updated_at`                                 | runs queued, running and finished, and the budget's counts                                             |

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

`decide` is tested on the factory's real past, not only on cases written by hand. The recorder
saves `gather`'s raw responses for a list of past Work items, chosen to cover every state at least
once, as fixtures in `history/`, and derives what the factory did next after each event in their
lives (the next marker comment, label, push or merge). The history test runs
`decide(observe(raw, at))` at every one of those moments and expects the state and action the
factory took. Where today's workflows were wrong (a `needs-human` pull request holding the whole
queue, say), the fixture names the fault, and the test expects the Conductor's answer instead.
The fixtures hold only what GitHub shows publicly on this repository: never a token, never a
User report.

### Recording a Work item

```sh
GITHUB_REPOSITORY=<owner>/roundtable GH_TOKEN=$(gh auth token) node tools/conductor/main.ts record 291 288
```

For each number it runs `gatherWorkItem` (`gather.ts`), which reads one Work item, open or closed,
as `gather` reads an open one: the Ticket with the latest pull request that closes it (a pull
request that closes a Ticket is recorded as that Ticket), every commit's checks and statuses, and
the Executor runs from 24 hours before it was opened. It writes `history/<n>.json` (`fixture.ts`):

- **`gather`**: the `GATHER_VERSION` it was recorded with. The history test refuses a fixture from
  another version and says to record it again; raise the version whenever a change to `gather`
  would make an older fixture read differently.
- **`raw`**: what `gather` returned, trimmed as it trims, with the lists GitHub doesn't promise an
  order for (check runs, statuses, runs) sorted by their content. Keys are sorted too, so the same
  Work item recorded again with nothing new on GitHub is byte for byte the same file.
- **`checkpoints`** (`record.ts`, pure): one at every moment something happened in the Work item's
  life (a label added or removed, a title or description edit, a push, a check finished, a
  comment from the factory or the Owner's `@claude`, the pull request opened, a merge, a close, a
  deploy that includes a merge, a Blocker closed), with its time, what happened, the Tickets the
  dispatcher last said were in flight (`building`), and `next`: the step the factory took after
  it, as one of `decide`'s actions with the evidence, or `unknown` with why.

`next` is the first thing after the checkpoint that the factory or the Owner did:

| What came next                                                                                                | `next`                                                |
| ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| an Executor run named for it, a `factory` status `Working: …`, or the dispatcher's `building` label           | start that kind                                       |
| an Executor's work whose start isn't recorded: its marker comment, its push, its `needs-human` just before it | start that kind, with the commit and Attempt it names |
| a `needs-human` label the factory added on its own                                                            | hand over                                             |
| the Owner's `ready` taken off by the factory (not swapped for `needs-info` by a build)                        | withdraw                                              |
| a check run again on the same commit, not by the CI fixer                                                     | rerun                                                 |
| the Owner's own step (a label, a push, a merge, an edit, a mention), or nothing at all                        | nothing                                               |

It is `unknown`, and the history test skips it, where the events can't tell: an Executor was
running then (between its start and its comment) and no named run shows `decide` that; its work
came after other events, so when it started isn't known; a factory commit no Executor's comment
claims; or an Owner's `@claude`, whose answer leaves no comment. A precise start that comes only
after another event is `nothing`: the factory answered that event, not this one. A hand-over's or
withdrawal's reason in a fixture is what showed it, not `decide`'s sentence.

Before writing, the recorder refuses a fixture that matches any of `guard-secrets.sh`'s credential
patterns, and the tests check every fixture in `history/` again. A User report's Ticket keeps only
its labels and events: `gather` never reads an issue's title, description or anyone's comments but
the factory's.

## The command line

- `node tools/conductor/main.ts run [--dry-run]`: one pass over every open Work item.
- `node tools/conductor/main.ts why <n>`: one Work item's state, action, reason and evidence,
  without acting. `scripts/factory-why.sh <n>` runs it with `gh auth token`.
- `node tools/conductor/main.ts record <n>…`: records Work items as history fixtures (above),
  with the token in `GH_TOKEN` and the repository in `GITHUB_REPOSITORY`. Built; `run` and `why`
  aren't yet.

## The Owner's wiring

Under `.github/`, which the factory can't write, and built after this package:

- `conductor.yml`: one concurrency group, woken by issue, pull request, comment and workflow
  events, the Executors and the factory clock, running `main.ts run`.
- Each Executor gets a `workflow_dispatch` entry with its inputs, its run name, and its own
  guards: the Owner's Approval with no edit since, the head it was started for, no
  `needs-human`, a hard cap of Attempts, and the dispatch budget.
- The `FACTORY_CONDUCTOR` repository variable: `on` turns the Conductor on and today's deciding
  workflows off, `off` turns them back.
