# 0054. Store a Round's schedule as a start instant or a calendar due date, replaced as a whole

- **Status:** Accepted
- **Date:** 2026-11-22

## Context

A Round has a scheduled time (a start, and a duration when the company gave one), a due date (a
take-home), or neither yet (`GLOSSARY.md`). The Agenda (roadmap step 3) and the calendar feed
(step 7) will read these dates, so how they're stored and what they mean is hard to change once
rows exist. The web app knows the user's time zone; the API doesn't.

## Options considered

1. **Three nullable columns on `rounds`** (`starts_at timestamptz`, `duration_minutes integer`,
   `due_on date`), with check constraints for the rules. Pros: one row per Round, simple queries
   and sorting, expand-only migration. Cons: the rules live in constraints and the contract
   rather than in the shape.
2. **A `round_schedules` table or a JSON column holding a tagged union.** Pros: the kind is
   explicit. Cons: a join or JSON parsing for every list and for the Agenda's sort, for no rule
   the constraints can't hold.
3. **A due date as a `timestamptz`** (end of the day in the user's zone). Pros: one type to sort.
   Cons: the server would need the user's time zone, and "due on the 1st" would shift when they
   travel.

## Decision

Option 1. A start is an instant (the browser turns the user's local date and time into it and
shows it back in their zone); a due date is a calendar date with no time zone, the same day
wherever the user is. The contract and the table both refuse a start with a due date, and a
duration without a start or outside 5–480 minutes. The schedule is changed with
`PUT /api/applications/:id/rounds/:roundId/schedule`, which replaces it as a whole (what isn't
sent is cleared), so a partial update can never combine with stored fields into an invalid one.
The list sorts dated Rounds first by `coalesce(starts_at, due_on at 00:00 UTC)`, then the rest in
the order they were added.

## Consequences

- Sorting and the Agenda's "upcoming" query are one expression over one table.
- A take-home and an interview on the same day sort by UTC midnight, so the take-home usually
  comes first; for users far east of UTC a morning interview can sort before it. Revisit if the
  Agenda needs the user's zone on the server.
- A future field of the schedule (a time zone of its own, a location) is a new nullable column and
  a new field of the `PUT` body.
