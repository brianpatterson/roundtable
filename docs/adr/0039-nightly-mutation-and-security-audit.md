# 0039. Run mutation testing and the security audit nightly, not per pull request or weekly

- **Status:** Accepted, amended by [0057](0057-leave-mutation-testing-to-the-nightly-run.md), [0062](0062-incremental-nightly-mutation-testing.md), [0069](0069-stryker-on-mutation-pull-requests.md)
- **Date:** 2026-11-20
- **Amends:** [ADR-0027](0027-mutation-testing-stryker.md) (mutation testing on pull requests),
  [ADR-0036](0036-weekly-security-audit.md) (a weekly audit)

## Context

Mutation testing ran on every pull request: the web app in full, and the API incrementally,
reusing the nightly results unless a change touched something incremental results can't see (the
contract, tables, migrations, test helpers, config, dependencies), when it ran in full. A full API
run takes about 31 minutes on a runner. A factory pull request that added a module touched all of
those, ran in full, and hit the job's 30-minute limit at 96%. A timeout leaves CI `cancelled`, not
`failed`: the CI fixer acts only on failures and the reviewer only on success, so the pull request
sat with no review and no `needs-human` label. The nightly API run on main already covers every
merged change within a day, and a survivor is advisory either way.

The security audit ran weekly. The factory now ships several changes a day, so a hole could sit in
production for a week before the auditor looks.

## Options considered

1. **Keep mutation on pull requests with a longer limit.** Every API-heavy pull request waits half
   an hour more for an advisory result, and the next slow runner stalls one again.
2. **Run mutation testing only nightly on main (chosen).** Pull requests are faster and can't
   stall on it. The reviewer loses the survivors as evidence that a test is weak; the
   implementer still runs the web app's mutation testing locally (about 20 seconds), and the
   nightly summary shows anything that lands untested.
3. **Audit security on every pull request touching auth, logging or `infra/`.** Rejected again
   (as in ADR-0036): a full Opus run per pull request, and the reviewer already does an OWASP pass.
4. **Audit nightly (chosen), skipping nights when main didn't change.** At most one Opus run a
   day, none on quiet days, and a hole is looked for within a day of landing.

## Decision

- `.github/workflows/mutation.yml` runs Stryker on the web app and the API, nightly on main (and
  by hand). CI's `mutation` and `api-mutation` jobs are gone, and the reviewer no longer reads
  survivors. The API job's limit is 60 minutes.
- `.github/workflows/security-audit.yml` runs nightly at 06:41 UTC. A `changed` job skips the
  run when main is still at the commit the last successful audit ran on; a manual run always
  audits. The filing job
  already skips titles it has filed, so a hole still open isn't filed again each night.

## Consequences

- Pull request CI is about 10 minutes shorter for web changes and up to 30 for API changes, and
  can't stall on mutation testing.
- A weak test is found the night after it merges, not in review. Nothing fails on the score
  either way; a threshold, when it comes, belongs in the nightly run.
- Up to seven audits a week instead of one, on the owner's subscription. Revisit if the cost
  shows up or if nightly findings are mostly repeats.
- A cancelled CI run (a timeout) still goes unnoticed by the factory: a separate change.
