# 0062. Make the nightly mutation run incremental, with a full run on Sundays

- **Status:** Accepted
- **Date:** 2026-11-23
- **Amends:** [ADR-0039](0039-nightly-mutation-and-security-audit.md) (the nightly run was always
  full)

## Context

The nightly mutation run ([ADR-0039](0039-nightly-mutation-and-security-audit.md)) mutated
everything every night. The code grew quickly: the web app went from 760 mutants (16 minutes on a
runner, 2026-11-22) to 1,118 a day later. On 2026-11-23 its job hit its 20-minute limit at 85%,
and the API job hit its 60-minute limit. A cancelled run files no `mutation` tickets
([ADR-0051](0051-nightly-mutation-tickets.md)), and it shows as a red check on any pull request
that changes the workflow, such as a Dependabot bump of an action it uses.

Stryker's incremental mode, already on in both configs, reuses earlier results for mutated files
and tests that haven't changed. [ADR-0027](0027-mutation-testing-stryker.md) recorded its two
blind spots: it can't see a change to anything else the results depend on (dependencies, config,
test helpers, the contract, migrations, Drizzle tables), and it keeps an old survivor that a new
test now kills.

## Options considered

1. **Only raise the time limits.** Simple, but the runs keep growing with the code, and every run
   stays as slow as the whole app.
2. **Incremental, seeded from the cache, keyed on what Stryker can't see (chosen).** A normal
   night mutates only what changed. A change to anything outside Stryker's view changes the cache
   key, so that night runs in full. A weekly full run corrects stale survivors.
3. **Shard Stryker across several jobs.** Faster full runs, but more jobs, merged reports, and for
   the API more Postgres services.

## Decision

Each job restores Stryker's incremental file from the Actions cache and saves the new one when it
succeeds. The cache key hashes the lockfile, `.node-version`, the base tsconfig, the contract, the
app's top-level config files, and the files Stryker doesn't mutate but the tests run (the web
app's CSS, test setup and re-exports; the API's tests folder, migrations, tables and re-exports).
Sunday's run and a manual run with `full` skip the cache. The time limits rise to 45 minutes (web)
and 90 (API), enough for a full run.

## Consequences

- Most nights finish in minutes. A full run still happens weekly, after any dependency or config
  change, and whenever the cache has nothing for the current key (caches unused for 7 days are
  evicted).
- Between Sundays, a survivor that a new test kills can still be reported, and filed as a ticket.
  The implementer then finds nothing to do for it; the next full run clears it.
- The cache key lists files by hand. A new kind of file the tests depend on, outside those
  patterns, would be missed until Sunday. Add it to the key in `mutation.yml` when it appears.
- A pull request's cache is scoped to its own ref, so a pull request can't plant results for main.
- Revisit if full runs approach the new limits again: sharding (option 3) is the next step.
