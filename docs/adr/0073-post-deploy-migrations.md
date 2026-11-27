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
  - fails, in a migration that isn't post-deploy, anything the previous release's code can't
    live with: `DROP TABLE`, `DROP COLUMN`, `SET NOT NULL`, `ALTER COLUMN … TYPE`, a new `UNIQUE`
    or `CHECK` constraint or unique index (old writes can violate it), and removing an enum value.
  - fails `ADD COLUMN … NOT NULL` without a default in either phase: before `post` the old code's
    inserts violate it. Add it with a default, or nullable now and `SET NOT NULL` post-deploy.
  - applies these two rules only to tables, columns and types that exist on `main`, the schema
    the previous release runs on; the replay below knows it. The previous release can't write to a
    table it has never seen, so a new table's unique index, a `NOT NULL` column added to it, or a
    constraint on it stays in `pre`, as drizzle-kit writes it (a new table's `CREATE UNIQUE INDEX`
    is its own statement). Made post-deploy instead, the new code would run without it until
    `post`.
  - **replays the deploy on `app_test`**: `main`'s migrations in full, then `pre`, then `post`.
    drizzle-kit generates each migration from the schema after the one before it, so a pre-deploy
    migration generated after a pending post-deploy one can depend on it (re-creating a dropped
    column or reusing a dropped constraint's name) and fail in `pre`. The replay catches that
    before the merge rather than in a rolled-back deploy; the fix is to make the dependent
    migration post-deploy too, or to stop reusing the name. After `pre`, the replay also fails
    when a column that a pending post-deploy migration drops is still `NOT NULL` without a
    default: between `pre` and `post` the new code no longer writes it, so every insert would
    fail, and neither the health check nor the tests (which run on the fully migrated schema)
    would notice.

  The check enforces only what it lists. Anything else that the previous release's code can't
  live with is left to the reviewer, and the list grows when one is found.

- **Rehearsing on real data:** the checks above see only the schema. A migration can still fail
  on the data (`SET NOT NULL` over existing nulls, a unique index over duplicates, a cast that one
  row breaks) or take minutes rewriting a table. So every pull request that adds a migration is
  rehearsed on the latest nightly backup ([ADR-0015](0015-backups.md)), the way `backup.yml`
  already restores it into a throwaway Postgres to verify it:
  - On the restored database: whatever of the base branch's migrations the backup lacks, then the
    pull request's through `pre` and `post`, each migration timed. It fails on an error or on any
    migration over **5 seconds**, which flags a table rewrite or a long lock.
  - It runs from `main`'s workflow (after CI, as Review does), in the `backups` environment, with
    no agent in the job. The pull request's SQL files are read as data (`git show`), and a script
    from `main` applies them with `psql`. The branch's `migrate.ts` and code never run.
  - **The data is scrubbed before any branch SQL runs.** The branch's SQL can choose what the job
    reports: an error message can echo a value, and pass or fail, or a timing, can answer a
    question about one (`CASE WHEN … THEN pg_sleep(6)`), a bit per run. So `main`'s script first
    scrubs every column in every table (identity's `users`, `sessions`, `accounts` and
    `verifications` included) except those whose type it knows is safe to keep: numbers, dates
    and times, booleans, enum values and uuids. Everything else, whatever its type (`text`,
    `varchar`, `text[]` such as `rounds.tags`, `json`, `jsonb`, `bytea`, and any type added
    later), is replaced with a keyed hash under a random key that's never written down, element
    by element for arrays, or set to null where a hash can't take the type's place. Hashing keeps
    what migrations trip over (nulls, equal values, duplicates) and destroys the content, so
    nothing the job reports can carry it. A new column type is scrubbed by default.
  - **Accepted residual risk:** the kept values (interview times such as `rounds.starts_at`,
    `applied_at`, statuses, ids) and row counts are still readable to branch SQL, one bit per run
    through pass or fail. They identify no one without the scrubbed text, extracting anything
    takes many runs, each a pull request someone can see, and every run is of an owner-approved
    ticket. Scrubbing them too would hide the data the rehearsal exists to test (dates that a
    `NOT NULL` or a cast trips over).
  - The SQL is also contained: the Postgres container has no network, and the migrations run as a
    role that isn't a superuser (no `COPY … TO PROGRAM`, no extensions). The age key is used for
    the decryption and removed before the branch's SQL runs.
  - **The job reports in its own words only:** which migration failed and whether it was an error
    or over the time limit, never psql's message, and each migration as within or over the limit,
    never its time. It writes nothing else to its log. It sets a `migration-rehearsal` status,
    which a merge into a batch requires ([ADR-0074](0074-batch-merges.md)).
  - Pull requests for `user-report` tickets aren't rehearsed: their text came from outside, and
    they go to the owner anyway. Their status says so, and the owner rehearses by hand if needed.
- **Guarding production:** `migrate.ts` sets `lock_timeout` (5 seconds) and `statement_timeout`
  (60 seconds, inside the health check's 90) on its connection in both phases. A migration that
  waits on a busy table fails fast and the deploy rolls back, instead of queueing every request
  behind its lock.
- **Recovering:** right before `post`, the deploy dumps the database (`pg_dump`), encrypts it to
  the backups' age recipient and keeps it on the volume for 7 days. Post-deploy migrations are the
  only ones that destroy data, so a bad drop is a restore, not a loss. If the dump fails, `post`
  doesn't run.
- **Showing them:** the batch pull request lists every migration in the batch with its SQL, its
  phase and its rehearsal result, which is where the owner reviews them.
- **Only what drizzle-kit writes merges on its own:** migration SQL must consist of the
  statements `drizzle-kit generate` produces (creating, altering and dropping tables, columns,
  indexes, constraints, types and sequences). A migration with anything else (`INSERT`, `UPDATE`,
  `DELETE`, `GRANT`, `REVOKE`, functions, triggers, extensions, `DO` blocks, `COPY`), or one that
  touches identity's tables, is labeled `needs-human` and waits for the owner's merge into the
  batch. A data backfill, such as a rename's copy, therefore always goes to the owner.

- **Writing them:** a ticket that both adds and removes schema generates twice: the additions
  first, then the removals as `_postdeploy`. A column dropped post-deploy is first made nullable
  or given a default in a pre-deploy migration, because the new code stops writing it before
  `post` runs. A rename is three steps in one batch: add the new column, copy the data and make
  the old one nullable (pre), switch the code to it, drop the old column (post). A
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
- Migrations merge into a batch without the owner. The checks, the rehearsal, the timeouts and
  the snapshot replace a click that couldn't see the data anyway; the owner still reads every
  migration once, on the batch pull request.
- The rehearsal uses last night's data: a row written since can still break a migration, and then
  `pre` fails and the deploy rolls back. It also brings a branch's SQL near production data in CI,
  which is why it's contained as above and why no agent ever runs in that job.
- A large table's migration can outgrow the 5-second limit for good. Then the limit is raised for
  that migration by hand, in the rehearsal script on `main`, or the change is rewritten to batch
  its work.
- It depends on Drizzle choosing migrations by name. A Drizzle upgrade that applies them strictly
  in timestamp order, or refuses one older than the newest applied, breaks the `post` phase. The
  spike's two scenarios become a test of `migrate.ts` against `app_test`, so an upgrade that
  changes this fails CI.
