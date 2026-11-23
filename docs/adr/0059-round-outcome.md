# 0059. Store a Round's Outcome as an enum on the Round, with a flag for one the user set

- **Status:** Accepted
- **Date:** 2026-11-23

## Context

A Round's Outcome is whether the user advanced past it: pending, passed, failed or unknown (never
told) (`GLOSSARY.md`). Pass rates (roadmap step 6) are built on it, so its values and where it's
stored are hard to change once rows exist. The user sets it by hand now; the next ticket infers
it (adding the next Round passes the earlier pending ones, a rejection fails the latest), and an
inference must never override what the user set. Every existing Round has to read as pending.

## Options considered

1. **A `round_outcome` enum column on `rounds`, `NOT NULL DEFAULT 'pending'`, and a boolean
   `outcome_set_by_user NOT NULL DEFAULT false`.** Pros: one row per Round; a pass rate is one
   grouped query; the defaults make existing Rounds pending and keep the previous release's
   inserts working (expand-only); inference skips rows with the flag set. Cons: the flag can't
   tell an inferred Outcome from the starting one.
2. **A nullable `outcome_source` enum (`user`, `inferred`) instead of the boolean.** Pros: says
   where every Outcome came from. Cons: `inferred` would be a value nothing writes until the next
   ticket, and that ticket can still add it (an enum value is an expand-only migration) if it
   needs to show the difference.
3. **A nullable `outcome`, null meaning pending.** Pros: no default. Cons: two ways to say
   pending (null and, after a reset, `pending`), and every reader has to fold them together.
4. **A `round_outcomes` history table.** Pros: who changed it, and when. Cons: a join for every
   list, for a history nobody asked for.

## Decision

Option 1. The values are the contract's `OUTCOMES` (`pending`, `passed`, `failed`, `unknown`),
and the Postgres enum is made from them, like `interview_type`. The user sets one with
`PUT /api/applications/:id/rounds/:roundId/outcome` (`{ "outcome": … }`), which also sets
`outcome_set_by_user`; the API returns both on every Round (`outcome`, `outcomeSetByUser`).
Setting it back to pending is still the user's choice, so the flag stays set: once the user has
set a Round's Outcome, nothing infers it again.

## Consequences

- A pass rate per Interview type is a single grouped query over `rounds`, counting `passed` among
  `passed` and `failed`.
- The inference ticket updates only rows where `outcome_set_by_user` is false.
- There's no way yet to hand a Round back to inference. If one is wanted, it's a request that
  clears the flag, not a schema change.
- A new Outcome value needs a migration, and removing one needs expand/contract (ADR-0014).
