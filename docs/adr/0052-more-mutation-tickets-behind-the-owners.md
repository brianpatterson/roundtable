# 0052. Keep up to five mutation tickets open, built after the owner's tickets

- **Status:** Accepted
- **Date:** 2026-11-22

## Context

[ADR-0051](0051-nightly-mutation-tickets.md) has the nightly mutation run file one tests-only ticket at
a time, so the factory gets at most one a night. The backlog on 2026-11-22 was about 330 undetected
mutants across a few files. At one ticket of up to 25 mutants a night, it takes weeks to clear, and a
busy day of feature work adds survivors faster than one ticket a night removes them.

Filing more doesn't make the factory build more at once. The dispatcher still builds one ticket at a
time ([ADR-0047](0047-factory-dispatcher.md)), oldest `ready` label first. So a batch of mutation
tickets filed overnight would build before a feature ticket the owner labels the next morning. The
other limits are the owner, who merges every pull request, and review size: one file per pull request
keeps each one easy to judge.

## Options considered

1. **Bigger tickets**: one ticket for every mutant in a module. Fewer tickets, but each pull request is
   too large to review well, which is where mutation work goes wrong (tests that pin implementation
   details, disable comments on mutants that aren't equivalent).
2. **More tickets, in the order they're labeled**: simple, but mutation work then crowds out the owner's
   feature tickets for a day after each nightly run.
3. **More tickets, built after the owner's**: the same per-file tickets, a few open at once, and the
   dispatcher starts any ticket the owner labeled before any nightly one.

## Decision

Option 3. This amends ADR-0051's "Pace".

- **Up to five open.** Each night, `file-mutation-issue.sh` files tickets until five are open
  (`MAX_OPEN`). Each is for a different file, most undetected mutants first, up to 25 mutants each as
  before. A file with an open ticket gets no second one until that ticket closes, and then the next
  night files its next 25. Declined files and mutants already asked for are skipped, as in ADR-0051.
- **After the owner's tickets.** The dispatcher's state marks a ticket approved by the nightly run's
  own label as `ready.nightly`. Its sweep starts the owner's tickets first, then the nightly run's, each
  group oldest label first. A ticket that is already building isn't interrupted: the owner's next
  ticket waits for it, as any ticket waits for the one in flight. If the owner labels a mutation ticket
  `ready` themselves, it counts as theirs.

## Consequences

- At five a day, the current backlog clears in about two weeks, and a busy day's new survivors in a few
  more. A mutation ticket only runs when no ticket of the owner's could start, so the factory's idle time
  does the work.
- Up to five more pull requests a day for the owner to review and merge. `MAX_OPEN` in
  `file-mutation-issue.sh` is the knob: lower it if that's a chore, raise it if they're easy.
- An owner's ticket can still wait behind a mutation ticket already in flight, and a ticket is in flight
  until its pull request is merged and deployed. That includes the owner's own merge, so merging or
  closing the mutation pull request unblocks it. If this gets in the way, the next step is to stop
  starting mutation tickets while any of the owner's tickets is waiting on a blocker.
