# 0047. Dispatch ready tickets in dependency order, one at a time, once their blockers are deployed

- **Status:** Accepted, amended by [0048](0048-claude-mentions-on-pull-requests-only.md), [0051](0051-nightly-mutation-tickets.md), [0060](0060-factory-clock.md) (what starts the sweep) and [0074](0074-batch-merges.md) (blockers within a batch)
- **Date:** 2026-11-21

## Context

The implementer ([ADR-0025](0025-software-factory-implementer.md)) builds an issue the moment the
owner labels it `ready`. Planning skills such as `/to-tickets` (see `docs/agents/`) break a feature
into a set of tickets, each declaring which others block it through GitHub's issue dependencies,
and expect an agent to work through them in that order. The factory ignores those edges: label a
whole set `ready` and it builds them all at once, on top of each other, so the owner labels one
at a time and waits for each to merge.

Merged isn't enough either. An expand/contract change needs a deploy between its steps
([ADR-0014](0014-push-based-deploys.md)): brianpatterson/roundtable#121 could only merge once #120's
migration was in production.

Two GitHub rules shape the options. A label added with a workflow's own token starts no workflows,
and the Claude action reads an issue as a ticket ("tag mode") only on an issue or comment event, from
the owner. And a concurrency group keeps one pending run and cancels the rest, so it can't serve as a
queue. The `ready` label is also the owner's sign-off that a ticket is safe to build: strangers can
open issues on this public repository, and only the owner can label them.

## Options considered

1. **A token that acts as the owner**: a job relabels an unblocked ticket with it, which starts the
   implementer as if the owner had. Nothing else changes, but whoever holds that token holds the
   owner's sign-off: a leak lets anyone have the factory build their own issue.
2. **Refuse blocked tickets and let the owner restart them**: no new credential, but no
   advancing on its own: the owner still relabels every ticket.
3. **A dispatcher that starts tickets through `workflow_dispatch` (chosen)**: a deterministic
   script decides which ticket goes next and starts the implementer with its number. A dispatch
   from a workflow's own token does start runs, so no new credential is needed. Such a run is in the
   Claude action's agent mode, which the CI fixer already uses: the ticket reaches the agent as a
   file, the way a user report does ([ADR-0041](0041-factory-reads-user-reports.md)).

## Decision

Option 3, in two steps. This ADR's first step is the dispatcher and the gate; the second is the
implementer accepting a dispatch.

- **What counts as approved.** A ticket is built only if the most recent `ready` label on it was
  added by the owner, as GitHub records it in the issue's timeline, which no token can forge for
  the owner. If anyone else changed its title or description after that label, it isn't built:
  the label is removed and the owner rereads it. A ticket under `needs-info` starts again when the
  owner relabels it `ready` after answering, and starting it clears `needs-info`.
- **When it may start.** Every issue blocking it (GitHub's native issue dependencies; a "Blocked by"
  section in the body is for people) must be closed by a merged pull request or commit that the
  latest successful Deploy includes. A blocker closed any other way (not planned, or by hand) stops
  its dependents with `needs-human`: the plan changed.
- **One at a time.** A started ticket is labeled `building`, and stays in flight until the
  commit that closed it is deployed. While one is in flight, the next waits. A ticket that has been
  `building` for 90 minutes with no open pull request closing it goes to a human, and loses
  `building` so the queue moves on.
- **Who decides.** `.github/factory/dispatch.sh`, which holds no secrets and runs no agent: as the
  Factory workflow's `gate` job when the owner labels a ticket, and as the Dispatcher workflow when
  an issue closes, a Deploy finishes, and every 30 minutes. Both share one concurrency group, so
  decisions never race. GitHub cancels all but one pending run in a group, so a gate can be
  dropped silently; the next sweep, within 30 minutes, decides again from the issues' state. A
  ticket waiting or queued is told why, once, and a label the gate won't act on always gets an
  answer.
- **Step 1** (this change): the gate starts a ticket the owner labels if it may start, and
  otherwise says why it waits. When a waiting ticket can start, the dispatcher tells the owner to
  relabel it. **Step 2:** the dispatcher starts it itself, through `workflow_dispatch`, and the
  implement job re-checks the same rules before its agent runs, so nothing but a ticket the owner
  approved is ever built. Without a human relabeling, an edit made in the window between the
  owner's label and the start must still count: step 2 checks edits since the owner's first `ready`
  label that the dispatcher didn't remove, not only the latest.
- An `@claude` comment from the owner still starts the implementer directly, outside the queue.

## Consequences

- A set of tickets can be labeled `ready` at once and the factory works through it in order as
  each merges and deploys; expand/contract chains are safe without anyone timing the merges.
- Throughput is one ticket per merge and deploy, slower than building independent tickets in
  parallel, which in this repository mostly touch the same module and migrations.
- A ticket that stalls while `building` goes to a human and stops holding the queue; one that
  goes to `needs-human` some other way (a suspicious run) still holds it until someone removes
  `building`.
- Closing a ticket by hand or as not planned now matters to the tickets it blocks.
- Revisit if most tickets turn out to be independent, where letting two run at once would pay.
