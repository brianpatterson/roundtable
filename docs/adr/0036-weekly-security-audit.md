# 0036. Audit security weekly with a sandboxed agent that files private draft advisories

- **Status:** Accepted
- **Date:** 2026-11-18

## Context

CodeQL, dependency review and the per-PR reviewer ([ADR-0026](0026-software-factory-reviewer.md))
look at code. The 2026-11-10 leak (#29) wasn't visible in code: when the database failed, Drizzle's
error message, with the raw session token as a query parameter, went to Sentry and the logs. Only
making that failure happen and reading what left the process found it. The roadmap (Phase 3,
item 6) asks for an agent whose only job is that kind of search.

Two constraints shape it:

- **The repository is public.** An issue or a pull request with a test that reproduces a real hole
  would publish the hole. So would anything in a step's `env:` or an action's inputs, which GitHub
  prints in the run log, and the job summary.
- **Finding leaks means running code.** The test harness can already take the database away
  (`databaseUrl`), make the mailer throw (`sendEmail`), and capture logs (`logStream`) and scrubbed
  Sentry events (`errorEvents`); the auditor has to use it, not just read.

## Options considered

1. **Where findings go.**
   - Draft security advisories: private to the owner, and GitHub can attach a private fork for the
     fix and request a CVE. The workflow's own token can't create them, so it needs a fine-grained
     token from the owner.
   - Encrypted to a key the owner holds, attached to the run: no token, but a manual decrypt every
     week and nothing tracked.
   - Public issues: only acceptable if they say nothing specific, which defeats the purpose.
2. **Running code.** Sandboxed like the CI fixer (Postgres, isolation, scrubbed environment,
   throwaway test files), or read-only like the reviewer, which can't find what only a failure shows.
3. **When.** Weekly plus a manual run, or also on every PR touching auth, logging, error tracking,
   `infra/` or a new service; the reviewer already does an OWASP pass on every PR, and each audit is
   a full Opus run on the owner's subscription.

## Decision

Draft advisories, sandboxed, weekly (Wednesdays) plus manual runs: `.github/workflows/security-audit.yml`
and `.github/factory/auditor.md`.

- The agent reads the repository at `main`, writes tests only in `apps/api/test/audit/` (git-ignored,
  thrown away with the job) and runs them with `pnpm --filter @roundtable/api test test/audit`. It
  gets no network, no git credentials, the same deny list as the implementer, and the scrubbed,
  isolated environment of ADR-0029. Its token is the job's own, read-only.
- A finding is something it demonstrated: a test that fails or prints the leak, or, for code it can
  only read (`infra/`, the Caddyfile), the exact lines and the triggering request. It skips risks an
  ADR accepted and advisories already filed.
- It writes its findings to a file. A deterministic step reads the file, skips titles already filed,
  runs the secret guard, and creates one draft advisory per finding with `SECURITY_ADVISORY_TOKEN`
  (fine-grained, this repository only, "Repository security advisories: Read and write"), a
  `factory` environment secret that only the listing and filing steps see. A suspicious run files
  nothing.
- Nothing about a finding is public: no count, no title, no text in the log, the summary or the
  prompt. The owner reads Security → Advisories after each run, triages each draft, and fixes it in
  the advisory's private fork or closes it.

## Consequences

- Leaks like #29 get looked for every week, by exercising failures, not by reading code alone.
- One more Opus run a week on the owner's subscription, longer when it writes and runs tests.
- The owner holds one more token, which expires; when it does, the run fails at its first step and
  says why.
- A finding's fix is written in the advisory's private fork, by the owner or a session given the
  draft, not by the factory, whose pull requests are public. Wiring the factory into private forks
  is a later decision.
- Revisit if the findings are mostly noise (tighten the prompt or the bar), or to add a per-PR
  trigger for changes to auth, logging or `infra/`.
