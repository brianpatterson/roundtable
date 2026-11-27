# 0073. Run destructive migrations after the deploy is healthy, in a second phase

- **Status:** Accepted
- **Date:** 2026-11-26

## Context

A deploy runs every pending migration in the `migrate` container, then starts the new API. If
migrations fail or the health check doesn't pass within 90 seconds, `deploy.sh` redeploys the
previous release's images ([ADR-0014](0014-push-based-deploys.md)). It rolls back the code, not
the database. So every migration must work with the previous release's code (CLAUDE.md, rule 5).
Adding a nullable or defaulted column or a table always does: the old code ignores it. Removing
something only does once no deployed code reads it. A ticket that stops reading a column and the
ticket that drops it must ship in different releases.

Today every merge is a release, so "a later release" means "a later ticket". [ADR-0074](0074-batch-merges.md)
deploys a whole spec's batch at once, and then a batch can't both stop reading a column and drop
it. Planning around that (expand in this spec, contract in the next) puts the burden on every spec
for a problem the deploy can solve.

Forces:

- **No staging environment.** The health check after a deploy is the only test against the
  production database before users reach it.
- **A rollback must stay quick and lose no data.** It runs unattended in the deploy job.
- **Drizzle generates no down migrations**, and one ordered folder of up migrations is what
  drizzle-kit's snapshot chain and the schema drift check in CI expect.

A spike on 2026-11-26 (drizzle-orm and drizzle-kit 1.0.0-rc.5, a throwaway database and worktree)
found what this needs:

- `migrate()` runs every folder whose **name** isn't in `drizzle.__drizzle_migrations`, in one
  transaction, whatever its timestamp. A migration left out of one run is applied by a later
  one, after migrations with later timestamps.
- It takes a folder, not a list. A temporary folder of symlinks to the migrations a phase may run
  works (the links must be absolute).
- `drizzle-kit generate --name <x>_postdeploy` writes to the same folder; a later `generate`
  reports no changes and `drizzle-kit check` passes.

## Options considered

1. **Expand-only batches.** CI rejects drops, renames and `SET NOT NULL` in a batch unless it's
   labeled a contract batch, and `/plan-step` splits contract steps into the next spec. Works with
   today's deploy; every spec pays for it in planning, and a forgotten split stops a batch.
2. **Roll the database back with the code.** Snapshot Postgres before `migrate` and restore it
   when the health check fails. Any migration becomes safe, but writes during the deploy window are
   lost, a restore grows with the data, and a restore that fails partway is worse than today.
3. **Hand-written down migrations.** Drizzle has none; we'd write and test each by hand, and the
   rollback would run untested SQL against production.
4. **Two phases.** Expand migrations run before the new code, as now. Destructive ones run after
   the new release has passed its health check, when no code that reads what they remove is
   running. A rollback happens before the second phase, so the old code always finds its columns.
   The pattern of GitLab's post-deployment migrations.

## Decision

Option 4.

- **Marking:** a migration is post-deploy when its folder name ends in `_postdeploy`
  (`pnpm db:generate --name drop_job_url_postdeploy`). The name is the whole contract: no
  comment in the SQL, no second folder.
- **Running:** `migrate.ts` takes a phase. `pre` runs every migration except post-deploy ones,
  through a temporary folder of absolute symlinks; `post` runs the real folder, so it applies the
  post-deploy migrations and anything else still pending. With no phase it runs everything, as
  dev, tests and `pnpm db:migrate` do now.
- **Deploying:** the `migrate` container runs `pre`. After the smoke test passes, a last step in
  `deploy.yml` runs `post` on the server (`docker compose run --rm migrate … post`). If it fails,
  the release stays up and the Deploy run shows red; the next deploy's `post` retries it.
- **Checking:** a CI check on every migration added since `origin/main` (merged ones are left
  alone):
  - fails `RENAME` of a table or column in **either** phase. Neither phase is safe for one: before
    the deploy the old code reads the old name, and after it the new code reads the new name
    until `post` runs. A rename is the three steps below.
  - fails `DROP TABLE`, `DROP COLUMN`, `SET NOT NULL` or `ALTER COLUMN … TYPE` in a migration
    that isn't post-deploy.
  - **replays the deploy on `app_test`**: `main`'s migrations in full, then `pre`, then `post`.
    drizzle-kit generates each migration from the schema after the one before it, so a pre-deploy
    migration generated after a pending post-deploy one can depend on it (re-creating a dropped
    column or reusing a dropped constraint's name) and fail in `pre`. The replay catches that
    before the merge rather than in a rolled-back deploy; the fix is to make the dependent
    migration post-deploy too, or to stop reusing the name.
- **Writing them:** a ticket that both adds and removes schema generates twice: the additions
  first, then the removals as `_postdeploy`. A rename is three steps in one batch: add the new
  column and copy the data (pre), switch the code to it, drop the old column (post). A
  post-deploy type change runs while the new code is already up, so that code must work with the
  old type and the new one. CLAUDE.md's schema rule and the implementer prompt say so.

This amends ADR-0014: the deploy gains the post-deploy step after the smoke test.

## Consequences

- A batch can contain contract steps, and a spec needs no expand/contract split across releases.
  The rule that every migration works with the previous release's code still holds, now per
  phase.
- If a deploy rolls back after the new code ran but before `post`, anything it wrote only to a
  renamed column's new copy is invisible to the old code. The window is the health check's 90
  seconds.
- Rolling back by hand to a release older than an applied post-deploy migration still breaks, as
  it does today. Fix forward.
- The `_postdeploy` suffix carries the safety: a destructive migration without it runs before the
  health check. The CI check is what makes the convention safe; don't drop it.
- It depends on Drizzle choosing migrations by name. A Drizzle upgrade that applies them strictly
  in timestamp order, or refuses one older than the newest applied, breaks the `post` phase. The
  spike's two scenarios become a test of `migrate.ts` against `app_test`, so an upgrade that
  changes this fails CI.
