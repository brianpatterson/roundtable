# 0054. Store a Round's Tags as a text array on the Round

- **Status:** Accepted
- **Date:** 2026-11-22

## Context

A Tag is a free-form label on a Round for detail its Interview type doesn't carry ("React", "SQL",
"live debugging"; `GLOSSARY.md`). Issue #133 adds them: a Round has at most 10, each 1–40
characters once trimmed, and adding one that differs from an existing Tag only in case or
surrounding spaces leaves the Round with one. Suggesting earlier Tags, renaming a Tag across
Rounds and filtering by Tag are out of scope, but analytics may want to group Rounds by Tag later
(roadmap Phase 4, step 6). The table shape is hard to reverse once rows exist, and the endpoints
are part of the contract.

## Options considered

1. **A `text[]` column on `rounds`**, defaulted to `'{}'`. One row holds the Round and its
   Tags, so listing Rounds needs no join, and the order they were added is the array's order. A
   transaction holding the Round's row (`SELECT … FOR UPDATE`) keeps the limit and the
   case-insensitive uniqueness under concurrent adds. Postgres can't enforce "unique ignoring
   case" inside an array, so the handlers do; filtering by Tag later is a GIN index on the
   column (or on `lower()` of it, through a function) away.
2. **A `round_tags` table** (`round_id`, `tag`, a unique index on `(round_id, lower(tag))`).
   The database enforces uniqueness, and renaming or filtering by Tag are plain SQL. But every
   Rounds list joins and aggregates, the order needs its own column, and the limit of 10 still
   needs a lock or a count in a transaction. More moving parts for what the ticket needs.
3. **A `tags` table per user plus a join table.** What "rename a Tag across Rounds" and
   suggestions would want, but both are out of scope, and it makes every add a two-table
   upsert. Moving to it later is a migration from option 1's arrays.

For the endpoints: **replacing the whole list** (`PUT …/tags` with the new array) loses a Tag
added from another tab in between; **one Tag per request** (`POST …/tags` with `{ tag }` to add,
`DELETE …/tags?tag=` to remove) changes only what the user touched. The Tag to remove goes in the
query string rather than the path, since a free-form Tag can hold a `/`.

## Decision

Store a Round's Tags in a `tags text[] NOT NULL DEFAULT '{}'` column on `rounds`, in the order
they were added, trimmed, at most 10, none the same as another ignoring case. The handlers keep
those rules in a transaction holding the Round's row. Add one Tag with
`POST /api/applications/:id/rounds/:roundId/tags` and remove one with
`DELETE /api/applications/:id/rounds/:roundId/tags?tag=`; both answer the Round. An eleventh Tag
is a 400 `TooManyTags`.

## Consequences

- The migration only adds a defaulted column, so the release before it keeps inserting Rounds
  (ADR-0014), and the contract reads a Round without `tags` as having none.
- Renaming a Tag across Rounds, suggesting earlier Tags or filtering by Tag means array queries
  (`unnest`, `@>`) and probably a GIN index. If Tags grow an identity of their own (a rename, a
  colour, a link to a Skill), move to option 3 with a migration, superseding this ADR.
