# 0044. Link modules by plain ids, archive what's referenced, and keep transactions inside one module

- **Status:** Accepted
- **Date:** 2026-11-21

## Context

[ADR-0023](0023-modular-monolith-layout.md) lets a module query only its own tables, with one
exception: the applications table's foreign key to `users`. The job-search workflow (see
`GLOSSARY.md`) adds a `personas` module that owns Personas, Skills, Documents, their Versions and
Forks, and its data is linked to from `applications`: a sent Application points at the Version it
went out with, and a Prep task can name a Skill. Personas also belong to a user, so they need the
same link to `users` that applications has.

Without foreign keys across modules, the database no longer stops a referenced row from being
deleted, and a step that writes to two modules (sending an Application freezes a Version, then
records it) can fail halfway. There's one database today, so foreign keys and shared
transactions would work, but they would have to be unpicked before any module could move out.

`user_reports` (support, [ADR-0038](0038-user-problem-reports.md)) already stores `user_id` as a
plain id with no foreign key.

## Options considered

1. **One big `applications` module**: no links across modules at all. The module becomes the
   whole product, and ADR-0023's "a module could become a service" stops meaning anything.
2. **Real foreign keys and shared transactions across modules**: the database keeps everything
   consistent, but every link is one more exception to unpick before a split, and modules learn
   each other's tables.
3. **Plain ids between modules, with rules that make them safe**: a new module, links that are
   just ids, and the guarantees moved from the database into each module's interface.

## Decision

Option 3, as four rules:

1. **Links across modules are plain ids**, never foreign keys, except to `users` (rule 2).
   Dependencies run one way (applications → personas → identity); a module reads another's data
   only through that module's `index.ts`, and a module never needs to know who refers to its
   rows. A module that accepts another module's id resolves it through that `index.ts`, scoped to
   the `CurrentUser`, before storing it: an id that isn't the user's is a 404, like any other
   resource of theirs.
2. **Any module's tables may reference `users`**, and those that do are deleted with the account.
   Identity sits under every module. A table may still choose not to, as `user_reports` does so
   a report outlives the account. This replaces ADR-0023's single
   exception. A module that moves to its own database trades the foreign key for an
   account-deleted notice from identity at that point.
3. **What other modules refer to is archived, not deleted.** A Persona or Skill is archived
   (hidden from pickers, still readable); a Version is never deleted while the account exists.
   Deleting the account still removes them through rule 2.
4. **No transaction spans two modules.** A step that writes to both orders its writes so that
   failing between them leaves only harmless leftovers, and retrying works. Sending an
   Application creates the Version first and updates the Application second: a failure leaves
   an unused Version and an unsent Application. Forks live in personas, filed under an
   application id that personas treats as an opaque owner key and never resolves (it never
   reads applications, so rule 1's direction holds). Forks are created and deleted only through
   applications, after it has checked the user owns the Application, since personas can't check
   that itself. Deleting an Application asks personas to delete its Forks, and a failure there
   leaves Forks nothing can reach.

## Consequences

- A module can still move out on its own: no foreign key or transaction ties it to another
  module's tables.
- Consistency is the code's job now: tests have to cover archiving, and the half-finished
  outcome of every step that writes to two modules.
- Orphans (unused Versions, unreachable Forks) can pile up. They're small and private to their
  owner; clean them up if they ever matter.
- Revisit if a step needs both writes to happen or neither, with no acceptable leftover: that's a
  sign the data belongs in one module.
