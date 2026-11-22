# 0045. Add a saved status and an applied date; fold screening into interviewing, over three releases

- **Status:** Accepted
- **Date:** 2026-11-21

## Context

[ADR-0006](0006-status-enum-and-dates.md) made `created_at` double as the date an application was
sent. The job-search domain model (`GLOSSARY.md`) changes two things:

- An Application can exist before it is sent: a posting the user saved to apply to later. Its
  **applied date** is when it was sent, not when it was saved, so it needs its own column.
- **Status** is a coarse stage the user sets: saved, applied, interviewing, offer, accepted,
  rejected or withdrawn. `screening` folds into `interviewing`, because Rounds (the next step of
  Phase 4) carry the detail within interviewing.

A failed deploy rolls the code back but not the database
([ADR-0014](0014-push-based-deploys.md)), so every release must work against the
data the next one writes, and a browser tab can outlive a deploy in either direction. Three facts
shape the rollout:

1. **The release before this change can't send a `saved` row.** Its response schema lists the
   statuses it knows, and encoding a row with any other fails: after a rollback, the list endpoint
   of any user with one saved application would answer 500.
2. **The release before this change still writes `screening`**, during a deploy (an old tab's
   select) or after a rollback.
3. **Postgres can't drop an enum value** in place: it means a new type, a column rewrite and a
   swap, which the previous release would then fail against if it wrote `screening`.

## Options considered

1. **One release: add `saved`, the column and the fold together.** Simplest, but a rollback after
   anyone saves an application breaks their list (fact 1).
2. **Expand first, then allow `saved`, then contract.** Each release reads everything the next one
   can write:
   - **Release 1 (expand):** the enum gains `saved` (first, in display order); `applied_at` is
     added, defaulting to `now()` and backfilled from `created_at`; `screening` rows become
     `interviewing`. Responses can carry `saved` and read a stored `screening` as
     `interviewing`; requests can set neither.
   - **Release 2:** requests can set `saved`, and the web app can save without sending. A
     rollback to release 1 reads saved rows and can move them on.
   - **Release 3 (contract):** once no deployed release writes `screening`, drop it from the
     enum.
3. **A separate `sent` flag instead of a status.** Keeps the enum as it is, but a status of
   `applied` with `sent = false` makes no sense, and the glossary defines saved as a stage.

## Decision

Option 2. The applied date is set by the server, never by a request: the database default
(`now()`, Postgres's clock like the other timestamps) dates an application created with a sent
status, including the previous release's inserts, and a status change sets it with
`coalesce(applied_at, now())`, so an application moving out of `saved` is dated then and a sent
one keeps its date. From release 2, creating one as `saved` stores null, and moving one back to
`saved` clears it.

This supersedes ADR-0006's choice of `created_at` as the application date; its choice of a
Postgres enum stands.

## Consequences

- Release 2 can merge only after release 1 is in production, and release 3 only after release 2
  is (a rollback from release 3 to 2 is safe, because release 2 writes no `screening`).
- Until release 3, the enum and the contract carry a value no request can set:
  `STORED_APPLICATION_STATUSES` (the enum) differs from `APPLICATION_STATUSES` (what responses
  return), and `currentStatus` maps one to the other.
- The web app decodes a response with no `appliedAt` as null, so a tab left open across a
  rollback keeps working.
- An application can't yet be backdated: one the user sent last week and records today shows
  today. An editable applied date is a small change on top of this (a nullable date in
  `UpdateApplication`, a date field in the design system) if it turns out to matter.
- Moving an application back from a sent status to `saved` (a mistake) loses its applied date.
