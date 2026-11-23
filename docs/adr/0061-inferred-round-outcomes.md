# 0061. Infer Round Outcomes in the API, in the user's time zone, without a new column

- **Status:** Accepted
- **Date:** 2026-11-23

## Context

Outcomes are often known days later, and a user won't always go back and set them
(`GLOSSARY.md`). Two events say what happened: adding the next Round means the user passed the
pending ones before it, and a rejection means they failed the latest pending ones, all of them when
several were on the same day. ADR-0059 stored the Outcome with an `outcome_set_by_user` flag, so an
inference can skip what the user set, and left open whether the next ticket needed a column to tell
an inferred Outcome from the one a Round starts with.

Two things need deciding. "Before the new one" and "the same day" depend on dates, and the list
orders a take-home by the start of its due day in the user's time zone (ADR-0054), which the server
doesn't know. And the page has to show an inferred Outcome apart from one the user set.

## Options considered

1. **Infer in the handler that makes the change, in its transaction, with the time zone the
   browser sends.** `POST …/rounds` and `PATCH /api/applications/:id` take an optional `timeZone`
   (an IANA name, checked with `Intl`); without one, UTC. The handler reads the application's
   Rounds and works out which to change in TypeScript, then updates only rows still pending and not
   set by the user. Pros: one transaction with the change, as the ticket asks; the same day as the
   list shows; Rounds are few, so reading them all costs nothing. Cons: two payloads carry a field
   that isn't data about the application.
2. **The same, but in SQL with `AT TIME ZONE`.** Pros: no date code in TypeScript. Cons: Postgres
   and `Intl` don't accept the same names (Postgres reads `+05:30` as a POSIX zone, with the sign
   reversed), so an accepted name could fail the query or pick the wrong day.
3. **Infer in the web app,** setting Outcomes through the existing endpoint after adding a Round or
   rejecting. Pros: the browser knows the time zone. Cons: not one transaction; the inferred values
   would be written as the user's; a second tab or another client never infers.
4. **Infer when reading,** deriving the Outcome from the other Rounds and the status. Pros: nothing
   stored. Cons: the ticket keeps inferred Outcomes when a Round is deleted or the status moves on,
   which a derivation can't; pass rates would need the same derivation in SQL.

For telling the two apart: **an `outcome_source` enum column** (ADR-0059's option 2) or **reading
it from what's there**: inference only ever writes passed or failed, and never sets the flag, so an
Outcome that isn't pending and wasn't set by the user is an inferred one.

## Decision

Option 1, and no new column. The contract's `isInferredOutcome` reads a Round's Outcome as inferred
when it isn't pending and `outcomeSetByUser` is false; the page shows it as `Passed (inferred)`.

The rules, in `apps/api/src/modules/applications/inference.ts`:

- **Adding a Round** passes every Round of the application that is pending, not set by the user,
  and comes before the new one in the list's date order (in the user's time zone). An unscheduled
  Round counts as before, and a new unscheduled Round comes after them all.
- **A change to `rejected`** (not setting it again) fails the latest Round that is pending and not
  set by the user, in the list's order. If it's dated, every such Round on the same calendar day in
  the user's time zone fails with it. A Round the user set to pending isn't a candidate: they chose
  to leave it open.

## Consequences

- If a later release writes a passed or failed Outcome some other way without setting the flag, it
  will read as inferred. Then the column is the fix: an expand-only migration (ADR-0014).
- Nothing re-infers when a Round is deleted or rescheduled, or when the application leaves
  `rejected`: inferred Outcomes stay as they are.
- A client that doesn't send a time zone (an old tab, a script) gets UTC days, the same as the
  server's own list order.
- Offer and withdrawn infer nothing yet.
