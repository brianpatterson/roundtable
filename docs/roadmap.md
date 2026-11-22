# Roadmap

Goals: (1) learn systems design, (2) deploy to production for real, (3) build a **software
factory**: write a ticket, and an automated pipeline implements, verifies and ships it to a high,
measurable quality bar.

Each phase ends in something running. Bigger decisions get an ADR when they're made.

## Phase 1: Multi-user auth ✅

Better Auth with email/password, GitHub and Google, and per-user data isolation.
[ADR-0011](adr/0011-authentication.md).

## Phase 2: Production on a single VPS 🏗️

Decided: DigitalOcean (ADR-0013, superseding Hetzner in ADR-0012), a domain on Cloudflare DNS, OpenTofu with cloud-init, Cloudflare R2 for off-site storage. The rest of the details go
in a hosting ADR when built.

1. ✅ **Containers**: multi-stage Dockerfiles. The API runs as a Node image with a non-root user.
   The web app is built to static files served by Caddy. A `compose.prod.yml` wires Caddy, the
   API and Postgres together.
2. ✅ **Infrastructure as code** (applied 2026-11-05; encrypted state in R2) (`infra/`, OpenTofu): DigitalOcean droplet, firewall (only 22/80/443
   open), SSH key, a reserved IP, a data volume, and DNS records. cloud-init installs Docker, creates a deploy
   user, disables password SSH, and turns on unattended security upgrades.
3. ✅ **Edge**: Caddy terminates TLS with automatic Let's Encrypt certificates, serves the SPA,
   reverse-proxies `/api/*`, and sets security headers (HSTS, CSP).
4. ✅ **Delivery pipeline** (live: first deploy to https://roundtableapp.us on 2026-11-05) ([ADR-0014](adr/0014-push-based-deploys.md)): on merge to `main`, GitHub Actions builds the images, tags them with the
   git SHA, and pushes them to GitHub Container Registry. A deploy job then runs migrations as a
   one-off container, rolls the API, health-checks `/api/health`, and rolls back if that fails.
   Production is a protected GitHub Environment holding the secrets. Merges that ship nothing
   (docs, Markdown, `infra/`) don't deploy. **Later: zero-downtime deploys.** Today every deploy
   recreates the API and Caddy, so the site is down for about 10 seconds. Instead: start the new API
   next to the old one, switch Caddy's upstream once `/api/health` is up, then stop the old one,
   and keep Caddy running throughout. Migrations already have to be backward-compatible with the
   previous release, which is exactly what running both versions at once needs.
5. ✅ **Data safety** ([ADR-0015](adr/0015-backups.md)): nightly `pg_dump` to object storage with retention, plus a **tested restore**
   (a backup you haven't restored isn't a backup). OpenTofu state is in R2 too, encrypted ([ADR-0016](adr/0016-remote-encrypted-state.md)).
6. ✅ **Email** ([ADR-0017](adr/0017-email-resend.md)): Resend from `mail.<domain>` with
   SPF/DKIM/DMARC records in OpenTofu, and required email verification.
7. ✅ **Observability (minimum)** ([ADR-0019](adr/0019-monitoring-and-error-tracking.md)):
   structured logs (Pino), a Better Stack uptime check and backup heartbeat (in OpenTofu), and
   Sentry error tracking for the API. Later: searchable log history, browser errors.

Cost: $6/month droplet + ~$1 volume + $0 R2 (free tier) + $0 Resend (free tier, 3,000 emails a
month) + $0 Better Stack and Sentry (free tiers) ≈ **$7/month**, plus the domain.

## Next: the API on Effect

Decided in [ADR-0022](adr/0022-effect-for-the-api.md), with the evidence in the
[spike findings](research/2026-11-effect-spike.md). Each step is its own PR, keeps `pnpm check`
green, and updates `CLAUDE.md` and `docs/architecture.md` as it changes them:

1. ✅ **Drizzle 1.0 on the current Fastify app:** bump `drizzle-orm` and `drizzle-kit` to the release
   candidate (exact pins), convert the migrations folder once with `drizzle-kit up` (byte-identical
   SQL), switch to `drizzle({ client })`, turn on `paramsInErrors`, and update #29's leak tests for
   1.0's error format. Measured in the spike as 4 lines of code. It goes first because it's
   independent of Effect and shrinks the later steps.
2. ✅ **Foundation:** `effect` and `@effect/*` pinned exactly and grouped in Dependabot. Effect's
   language service runs as `pnpm check:effect` (`@effect/tsgo`, since TypeScript 7 can't load
   the classic plugin), in `pnpm check` and CI, and works in editors through the same tsconfig
   plugin entry. Also the anti-slop Effect rules, `@effect/vitest`, and an "Effect conventions"
   section in `CLAUDE.md` built from the spike's gotchas.
3. ✅ **Contract:** the `HttpApi` definition, written with Effect Schema, in `packages/shared`
   (now `@roundtable/shared`). The Zod schemas stayed until the web app moved (step 5).
   `contract.test.ts` keeps the two in step: same input accepted and rejected, real responses
   decode, same endpoints as Fastify. Writing it also exposed that `jobUrl` accepted
   `javascript:` URLs; both schemas now allow only `http(s)`.
4. ✅ **Server:** `HttpApi` replaces Fastify, in two PRs. 4a moved every test onto a
   framework-neutral `t.inject()`; 4b swapped the server under it, and the same tests passed
   unchanged except the planned 400 for malformed ids. The `Authorization` middleware provides
   `CurrentUser`; Better Auth is mounted with `fromWebHandler`; Sentry gets Effect's failures
   through our own `ErrorReporter` (not the alpha `@sentry/effect`), and expected errors set the
   ignore marker; Effect's logs go through pino and its redaction. 400s are RFC 9457 problems
   that name the invalid value. `server.test.ts` checks the production wiring on a real Node
   server.
5. ✅ **Web:** the web app calls the API through the client generated from the contract
   (`@roundtable/shared/client`), inside TanStack Query; the Zod contract is gone. A follow-up removed
   Zod entirely: `env.ts` reads the environment through Effect `Config`, with every secret
   (database URL, auth secret, OAuth client secrets, Resend key, Sentry DSN) kept `Redacted` so
   it can't leak through a log line or an error, and `redact.ts` uses Effect Schema. The client checks request bodies before sending
   them, which exposed that `Schema.Trim` refuses to _encode_ untrimmed text: company and job
   title now trim in both directions. `client.test.ts` runs the client against the real server.
   Bundle: 115 → 155 KB gzipped, as the ADR estimated.
6. ✅ **Email as Effect services:** an `EmailTransport` (Resend, the log, or a test's capture)
   under a `Mailer` that applies the sending limits in one Effect transaction. Resend is called
   with Effect's HttpClient and retried, three attempts in all, on what its docs say is worth
   retrying (5xx, the per-second rate limit, a concurrent request with the same key, a network
   failure), never on a 4xx or a used-up quota. One idempotency key per email makes a retry
   after a timeout safe: Resend delivers it once. Failures and the daily-limit alarm reach Sentry
   through the `ErrorReporter`, tagged with the email kind. Better Auth's callbacks reach the
   `Mailer` through a Promise bridge. The spike's interrupted-transaction test is back as
   `test/database.test.ts`, since the limits' lock depends on it.

**Later: `@sentry/effect` instead of our own reporter.** ADR-0022 named `@sentry/effect`; step 4b
uses our own `ErrorReporter` (`errorTrackingLayer` in `apps/api/src/platform/observability/error-tracking.ts`, about 15
lines on `@sentry/node`) instead. The reasons: the package is alpha, we'd use only its reporter,
it initialises Sentry itself (in place of our tuned `initErrorTracking`), and it pins
`@sentry/node` to its own exact version. Migrate when **any** of these becomes true:

- **We want tracing:** request latency, slow queries, or SLOs for the factory's "Observe" step.
  Its `SentryEffectTracer` turns Effect's spans into Sentry traces, which our reporter can't do.
- **It's stable** (no longer marked alpha), so it's no riskier than `@sentry/node`.
- **It reports something ours doesn't**, for example the route and method on every event. A
  database-outage event currently loses the request, because Better Auth reports first and
  Sentry deduplicates the second report.
- **Ours breaks on an Effect upgrade** (the `ErrorReporter` API is marked unstable) while theirs
  keeps up.

The move: replace the reporter inside `errorTrackingLayer` with `Sentry.effectLayer(...)`, passing it today's
`initErrorTracking` options (minimal `dataCollection`, `beforeSend: scrubEvent`, console
breadcrumbs off), and keep `@sentry/node` on its exact version. It's done when the Sentry tests
pass unchanged, especially `test/server.test.ts` (the real server, every log line and event
checked for the session token) and the outage tests in `platform/observability/error-tracking.test.ts`.

## Modular monolith ✅

[ADR-0023](adr/0023-modular-monolith-layout.md): both apps are organized by module, so a module
can later become its own service, and the web app its own repo or several microfrontends,
without untangling anything first.

1. ✅ **Layout:** the API in `modules/{applications,identity,email}` plus `platform/`, with
   colocated tests and each module's tables in its own `schema.ts` (no migration). The contract
   is `@roundtable/contract`, one file per module. The web app is `shell/`, `modules/` and
   `shared/`. `pnpm check:boundaries` enforces the import rules.
2. ✅ **Design system** ([ADR-0024](adr/0024-design-system.md)): our own Material-style
   components in `apps/web/src/design-system/`, with behavior from Base UI and styles from CSS
   Modules reading `--ds-*` tokens. Light, dark and system themes, remembered per browser. First
   components: Button, TextField (with real labels, replacing placeholder-only inputs), Select
   and Alert, each with colocated Vitest + Testing Library tests, the web app's first. Every
   page uses them, and the global stylesheet is gone. `check:boundaries` keeps Base UI inside the
   design system.
3. **Storybook**, once the design system has about ten components: a browsable catalog to build
   and review components in isolation, and a place the factory's reviewer agent can check visual
   changes.
4. **More components as features need them:** ✅ dialog (on Base UI's alert dialog; deletes
   confirm in it instead of `confirm()`, and Oxlint's `eslint/no-alert` keeps the browser's
   dialogs out), ✅ snackbar for mutation errors (on Base UI's toast; failed status changes
   show in it instead of an alert above the table), menu, a data table. When microfrontends build
   separately, the design system moves to `packages/design-system`.

## Phase 3: The software factory

The target loop:

```mermaid
flowchart LR
  T[Ticket<br/>GitHub Issue from template] -->|label: ready| I[Implementer agent<br/>Claude Code GitHub Action]
  I --> PR[Pull request]
  PR --> G{Quality gates<br/>CI}
  G -->|fail| I
  G -->|pass| R[Reviewer agent<br/>+ human approval]
  R -->|changes requested| I
  R -->|approve| M[Merge]
  M --> S[Deploy to staging<br/>smoke + E2E]
  S --> P[Deploy to production<br/>health check, auto-rollback]
  P --> O[Observe<br/>errors, SLOs]
  O -->|regressions become tickets| T
```

Building blocks, in order:

1. ✅ **Ticket template** ([ADR-0025](adr/0025-software-factory-implementer.md)): a GitHub Issue form with problem, user story, acceptance criteria
   (Given/When/Then), out of scope, and a "docs impact" field. Good tickets are the single biggest
   lever on agent output quality.
2. ✅ **Implementer** ([ADR-0025](adr/0025-software-factory-implementer.md)): the Claude Code GitHub Action runs when the owner labels an issue `ready`. It
   reads `CLAUDE.md`, implements on a branch, and opens a PR linked to the issue. An `@claude`
   comment from the owner re-triggers it. Feature and bug forms carry the modules touched and
   the design system components, too. First real ticket: the delete dialog.
   It also fixes CI failures on its own pull requests, and on any labeled `autofix`: two attempts,
   then `needs-human` ([ADR-0028](adr/0028-software-factory-ci-fixer.md)).
3. ✅ **Reviewer** ([ADR-0026](adr/0026-software-factory-reviewer.md)): a second agent with a different prompt and no stake in the implementation
   reviews every PR against the ticket's acceptance criteria and the repo rules. It posts inline
   comments, then a human approves (you stay in the loop at first).
   When it asks for changes on a factory PR, the implementer reworks it: two attempts, then
   `needs-human` ([ADR-0037](adr/0037-software-factory-rework.md)).
   ✅ **Sweeper** ([ADR-0040](adr/0040-factory-sweeper.md)): every 30 minutes, any factory PR
   stuck where no workflow reacts (CI cancelled or timed out, a conflict, no review) is rerun once
   or labeled `needs-human` with the reason. Next, if conflicts are common: fix them automatically.
4. **Staging environment**: a second deploy target on the same VPS or a second small one. Every
   merge goes to staging first, and production follows automatically if staging is healthy.
   **Deferred until there are users** (2026-11-18): until then it would mostly protect test
   data. Production already rolls back a failed deploy, `Main health` reports a broken main
   (ADR-0035), and rule 5 in `CLAUDE.md` keeps migrations compatible with the previous release.
   When it's picked up, the 2026-11-18 sketch was a second $6 droplet with the same cloud-init,
   Compose file and deploy script, behind HTTP basic auth, promoted to production automatically.
5. **Continuous operation**: scheduled agent runs that triage Dependabot PRs, fix flaky tests,
   and turn production errors into tickets, and then into PRs with a failing test that reproduces
   them, without a human starting the investigation. That only works if each error carries enough
   context to reproduce it, and never any user data. Today a database error carries the SQL,
   Postgres's own fields (`code`, `table`, `constraint`), the stack, the route and the release,
   plus the kind of each query value (`uuid`, `string(32)`, `null`) but not the value itself
   ([ADR-0022](adr/0022-effect-for-the-api.md)). Next: the kinds of the request body's fields on
   every error (`jobUrl: null`, `company: string(0)`), so a validation or handler bug can be
   reproduced from the Sentry issue alone. Agents never get real values: that would expose user
   data and make stored text a prompt-injection path. The one exception is a user's own problem
   report, which the owner reads before labeling it `ready`
   ([ADR-0041](adr/0041-factory-reads-user-reports.md)).

   Dependabot already notifies and opens security fix PRs on its own, and dependency review blocks
   PRs that add a vulnerable package, so its alerts don't need code scanning's pipeline
   ([ADR-0030](adr/0030-factory-code-scanning-findings.md)). Two pieces for the triage agent:
   - ✅ **Dependabot's npm PRs get `autofix` automatically** (`.github/dependabot.yml`), so the CI
     fixer ([ADR-0028](adr/0028-software-factory-ci-fixer.md)) handles any breakage they cause:
     version bumps too, since telling them from security fixes would need the alerts API.
   - **Alerts with no fix get a triage note, deterministically, no agent**: whether production
     depends on the package (`pnpm why --prod`) or only tooling does, and whether a patched
     version exists. That separates "wait for Dependabot's PR" from "act now". Example: alert #4,
     a picomatch ReDoS with no patch yet, reaches the repo only through Vite and Vitest. Verify
     first whether a workflow's own token can read Dependabot alerts: it can't (no permission
     covers them), so this needs a fine-grained token from the owner (Dependabot alerts and
     contents, read-only). Deferred until then; Dependabot's own alert emails are the signal.

6. ✅ **Security auditor** ([ADR-0036](adr/0036-weekly-security-audit.md); nightly since [ADR-0039](adr/0039-nightly-mutation-and-security-audit.md), files private draft
   advisories; a per-PR trigger is left for later): a scheduled agent (nightly, and on any PR that touches auth, logging,
   error tracking, `infra/` or a new external service) whose only job is to find security holes.
   It has its own prompt and no stake in the code it audits. Every finding becomes a ticket with
   a test that reproduces it. Scanners only catch known patterns. The 2026-11-10 leak passed
   CodeQL, dependency review, the tests and code review: when the database failed, Drizzle's
   error message (with the raw session token as a query parameter) went to Sentry and the
   server logs ([#29](https://github.com/brianpatterson/roundtable/pull/29)). Only exercising a
   failure on purpose and reading what left the process found it. So the auditor should:
   - **Follow data out of the process:** what reaches Sentry, the logs, emails and third-party
     APIs, and under which failures (database down, a provider erroring, bad input).
   - **Check auth and tenancy:** every route behind the session check, cross-user access is a
     404, and tokens and links are single-use and expire.
   - **Probe inputs and config:** validation gaps, injection, headers and CSP, cookie flags,
     firewall and secrets handling in `infra/`.
   - **Inject faults** to exercise error paths, the way the leak was found: take away the
     database, make the mailer throw, then inspect every outgoing event and log line.

7. ✅ **Mutation testing for the API (spike)** ([ADR-0027](adr/0027-mutation-testing-stryker.md),
   2026-11-18 update): `pnpm --filter @roundtable/api test:mutation`. Each Stryker worker gets
   its own test database (`app_test_<worker>`), which cut a full run from 28 to under 9
   minutes; skipping Drizzle tables and Effect service keys and span names leaves 511 mutants
   and a score of 75% (78% of covered mutants), then 96% once the survivors worth killing got
   tests; every survivor left is reviewed in ADR-0027's updates. In CI:
   - ✅ **A scheduled full run in CI**: nightly on `main` (`.github/workflows/mutation.yml`),
     with the score and survivors in the job summary and the report in an artifact.
   - ~~Incremental runs on pull requests~~: built, then removed with the web app's PR job
     ([ADR-0039](adr/0039-nightly-mutation-and-security-audit.md)): a full run timed out and
     stalled a factory pull request. Both run nightly on main instead.

8. ✅ **Weekly architecture review** ([ADR-0031](adr/0031-weekly-architecture-review.md)): Matt
   Pocock's `improve-codebase-architecture` skill runs unattended every Monday and turns each Strong
   candidate into an `architecture` issue, which the owner labels `ready` to build or closes with
   a reason. The reviewer checks every PR's design in the same vocabulary. Later: Strong findings
   straight to implementation, once several have been accepted unchanged.

9. **Fewer checks by hand** (2026-11-20): the reviewer's "Check by hand" list is the owner's
   remaining manual work on most pull requests. Shrink it, cheapest first:
   - **Browser tests in CI**: Playwright against the built app. Assertions for keyboard and
     focus behavior (focus returns to the button that opened a dialog), screenshots at phone and
     desktop widths in light and dark themes, and an axe scan. The screenshots go in the run's
     artifacts for the reviewer to look at. The implementer writes these for UI changes, and the
     reviewer lists only what a test truly can't check. No secrets and no production access, so
     no new risk. Covers the Acceptance tests, Visual regression and Accessibility rows below.
   - **Check config at startup**: the API parses the problem-report App's private key when it
     starts, not on the first report, so a bad key fails the deploy's health check and rolls
     back, instead of being found when the owner sends a test report. (The 2026-11-20 quoting bug,
     [#110](https://github.com/brianpatterson/roundtable/pull/110), failed earlier, in `deploy.sh`:
     this catches a key that is quoted right but malformed or truncated.)
   - **Production secrets in GitHub**: secrets of the `production` environment, from which the
     deploy job writes `.env`, instead of ssh one-liners the owner runs on the server. Needs an
     ADR. GitHub then holds production's secrets, and a change to `deploy.yml` on `main` could
     read them. The environment admits only `main`, the factory's agents run in the `factory`
     environment and never see them, and changes to `.github/` need the owner's merge.

## Phase 4: The job-search workflow

The product itself: from a posting you're considering, through each interview, to knowing what to
practice. The words are defined in [`GLOSSARY.md`](../GLOSSARY.md); documents are versioned
([ADR-0042](adr/0042-version-persona-documents.md)) and written in Markdown
([ADR-0043](adr/0043-markdown-documents.md)); a new `personas` module links to `applications`
by plain ids ([ADR-0044](adr/0044-links-between-modules.md)). Each step ships something usable:

1. **Application status rework**: a `saved` status for postings not yet sent, an applied date
   separate from the creation date, and `screening` folded into `interviewing` (expand/contract,
   since a deploy rollback can't undo a migration).
2. **Rounds**: interview type (fixed list) and tags, a scheduled time or a due date, a
   self-rating, and an outcome inferred from the next round or a rejection.
3. **Agenda**: upcoming rounds in date order, with time left and prep progress.
4. **Skills and prep**: starts the `personas` module with a skill library per user (ADR-0044
   puts Skills there, so they never have to move); notes and prep tasks on a round, each task
   optionally naming a skill.
5. **Personas and documents**: the rest of the `personas` module, a Markdown editor, versions, forks, and
   PDF export. The editor and PDF rendering each get their own design session and ADR.
6. **Analytics v1**: pass rate and average self-rating per interview type, with the count of
   rounds behind each.
7. **Calendar**: an ICS feed to subscribe to from Google or Apple Calendar (its secret URL and
   revocation designed first), then a month grid if the agenda isn't enough.

## What "ensuring quality" can mean

Quality comes in layers. Each answers a different question, and they compound. Already in place
is marked ✅.

| Layer                       | Question it answers                                           | Tools                                                                        | Status                                                                                                                        |
| --------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Static checks               | Is the code well-formed?                                      | TypeScript strict, Oxlint, Prettier                                          | ✅                                                                                                                            |
| Contract                    | Do the frontend and backend agree?                            | Shared Effect `HttpApi` contract and typed client                            | ✅                                                                                                                            |
| Integration tests           | Does the API behave correctly against a real DB?              | Vitest + Postgres                                                            | ✅                                                                                                                            |
| Security scanning           | Known-vulnerable deps? Injection bugs?                        | Dependabot, dependency review, CodeQL                                        | ✅                                                                                                                            |
| Docs as a gate              | Is the "why" recorded?                                        | Dependency register check, PR template, ADRs                                 | ✅                                                                                                                            |
| **Acceptance tests**        | Does it do what the ticket asked?                             | Playwright E2E, one test per acceptance criterion                            | Phase 3                                                                                                                       |
| **Coverage gate**           | Is new code exercised at all?                                 | Vitest coverage, with a threshold on changed lines                           | Phase 3                                                                                                                       |
| **Mutation testing**        | Would the tests catch a bug? Coverage can't tell you that.    | Stryker ([ADR-0027](adr/0027-mutation-testing-stryker.md))                   | Web app and API nightly on main, advisory ✅ ([ADR-0039](adr/0039-nightly-mutation-and-security-audit.md)). Next: a threshold |
| **AI code review**          | Does it match the ticket, the conventions and good design?    | Reviewer agent with a checklist                                              | Phase 3                                                                                                                       |
| **Security audits**         | What can leak or be abused that no scanner knows to look for? | Security auditor agent (building block 6): data-flow review, fault injection | Phase 3                                                                                                                       |
| **Visual regression**       | Did the UI change unexpectedly?                               | Playwright screenshots                                                       | Later                                                                                                                         |
| **Accessibility**           | Is it usable with a keyboard or screen reader?                | axe-core in Playwright                                                       | Phase 3 (cheap)                                                                                                               |
| **Performance budgets**     | Did it get slower or heavier?                                 | Lighthouse CI, bundle size limits, API latency tests                         | Later                                                                                                                         |
| **Production verification** | Does it work for real users?                                  | Smoke tests after deploy, error rates, SLOs with alerts, auto-rollback       | Phase 2–3                                                                                                                     |
| **DORA metrics**            | Is the factory itself healthy?                                | Deploy frequency, lead time, change failure rate, time to restore            | Later: the factory's own dashboard                                                                                            |

Guiding principle: **an agent should never be the only judge of its own work.** Every gate above
is either deterministic (a test, a type check) or independent (a separate reviewer agent, a
human, production metrics).
