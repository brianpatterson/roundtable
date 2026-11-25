# 0068. Leave an equivalent mutant alive when its disable would hide a real one

- **Status:** Accepted
- **Date:** 2026-11-24

## Context

A mutation ticket ([ADR-0051](0051-nightly-mutation-tickets.md)) allows one change to the file under
test: a `// Stryker disable next-line <Mutator>: <reason>` comment on an equivalent mutant. The
first batch of tickets (#189–#193) found two places where that rule doesn't fit how Stryker reads
the comment ([disabling mutants](https://stryker-mutator.io/docs/stryker-js/disable-mutants/)):

- **A disable switches off a mutator, not a mutant.** Every mutant that mutator makes on the line is
  ignored. Where one is equivalent and another is one a test kills, the comment hides the second
  from every later run. Nothing said what to do then, so the pull requests went both ways:
  - #202 disabled the mutator and hid the killable mutant.
  - #200 and #201 left the equivalent mutants alive, so the ticket's Stryker criterion failed.

  On #200 and #202 the reviewer raised it as a minor finding for the owner to decide, and each
  cost a rework pass that pushed nothing.

- **A `next-line` comment can fail to reach its line.** On #194 the comment sat above `}, []);`,
  the end of a `useEffect` body. The parser attached it inside the body, so the dependency list's
  mutant still survived. The owner's fix, a `disable`/`restore` pair for that mutator around the
  effect, broke ADR-0051's "never a disable without `next-line`", which the reviewer treats as
  blocking. The rework then moved the dependency list onto a line of its own to make room for a
  `next-line` comment. That was a change to the source, which the ticket forbids.

## Options considered

1. **Always disable the equivalent mutant**, and accept that a killable one on the same line goes
   quiet. The score looks complete, but a regression in that mutant's behavior is no longer
   reported by any mutation run.
2. **Leave the equivalent mutant alive and name it**, when its disable would also hide a mutant a
   test kills. The report keeps showing a survivor, but every real one stays visible.
3. **Ask the owner each time**, as the batch did. It costs a review finding and a rework pass per
   ticket for a choice that comes out the same way every time.

## Decision

Option 2, plus a fallback for comments that can't reach their line. This amends what ADR-0051's
tickets allow:

- **When a disable would also hide a mutant a test kills**, leave the equivalent mutant alive. Name
  it in the pull request as equivalent, with why. That meets the ticket. The reviewer checks the
  reason, and doesn't raise it as a finding.
- **When a `next-line` comment can't reach the mutant** (it would sit at the end of a block, as
  above a `useEffect` dependency list), use a `// Stryker disable <Mutator>: <reason>` and
  `// Stryker restore <Mutator>` pair around the smallest span that holds it. It names its
  mutators, like `next-line`. Moving code to make room for a comment is a change to the source.
- The ticket's Stryker criterion allows the mutants the pull request names as left alive.

`disable all` and `excludedMutations` stay forbidden, as do disables without a reason.

## Consequences

- No mutation ticket hides a mutant that a test kills, so a later change that breaks that
  behavior shows up in the nightly run.
- Files keep a few named survivors. The ticket filer doesn't ask for a mutant a finished ticket
  already listed (ADR-0051), so they don't come back as new tickets.
- Where the equivalent mutant could be split from its sibling by restructuring the code, that's a
  code change: an owner's ticket, not a mutation ticket.
