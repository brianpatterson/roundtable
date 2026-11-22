# 0056. Store a Round's Self-rating as two nullable columns on the Round, replaced as a whole

- **Status:** Accepted
- **Date:** 2026-11-22

## Context

A Self-rating is the user's own score for a Round, given right after it, with a note on what went
wrong (`GLOSSARY.md`). Analytics (roadmap step 6) will average it per Interview type, so the
scale and where it's stored are hard to change once rows exist. The user rates a Round once, and
may change or clear the rating or the note later.

## Options considered

1. **Two nullable columns on `rounds`** (`self_rating smallint` 1–5, `rating_note text` up to
   2000 characters), with check constraints. Pros: one row per Round, an average is one
   `avg(self_rating)` grouped by `interview_type`, expand-only migration. Cons: no history of
   earlier ratings.
2. **A `round_ratings` table**, one row per rating given. Pros: a history; room for several
   ratings per Round. Cons: a join for every list, and "the" rating becomes the latest row, for a
   history nobody asked for.
3. **A finer scale** (1–10, or half points). Pros: more resolution. Cons: a score given right
   after an interview isn't that precise, and a five-point scale is what the ticket and the
   glossary describe.

## Decision

Option 1, on a whole-number scale from 1 (went badly) to 5 (went well). The rating and the note
are each optional: a note without a rating, or a rating without a note, is allowed. They're
changed with `PUT /api/applications/:id/rounds/:roundId/rating`, which replaces both (what isn't
sent is cleared, so `{}` clears the Self-rating), like the schedule (ADR-0054). A note of only
whitespace is stored as null. The contract and the table both refuse a rating outside 1–5 and a
note over 2000 characters.

## Consequences

- Analytics' average per Interview type is a single grouped query over `rounds`, counting only
  rated Rounds.
- Changing a rating loses the old one. If a history is ever wanted, it's a new table that the
  columns can be backfilled into.
- Changing the scale later means rescaling stored ratings in a migration: the meaning of `3` is
  fixed by this decision.
