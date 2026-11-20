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
  thrown away with the job) and runs them with `pnpm --filter @roundtable/api test test/audit`. Its
  tools have no web access, no git credentials and the implementer's deny list, in the scrubbed,
  isolated environment of ADR-0029, with the job's own read-only token. The tests it writes do run
  with the network, like any test: isolation here is a PID namespace and a scrubbed environment,
  not a network sandbox.
- A finding is something it demonstrated: a test that fails or prints the leak, or, for code it can
  only read (`infra/`, the Caddyfile), the exact lines and the triggering request. It skips risks an
  ADR accepted, and gives each hole a stable title.
- **Three jobs, two environments.** Code the agent wrote could tamper with anything later in its
  job (the scripts it runs, `GITHUB_ENV`) and, outside the sandbox, read the runner's memory. A job
  holds every secret its expressions reference, so the agent's job references neither the advisory
  token (which can read every unfixed draft) nor the decryption key. Both live in their own
  environment, `security-advisories`, used only by:
  - `preflight`, which checks that both are set before the Opus run starts, and passes on nothing
    else;
  - `file`, which runs on a fresh runner from `main` after the audit, decrypts the findings with
    `AUDIT_FINDINGS_KEY`, normalizes them (so a malformed one can't stop the rest or print itself),
    skips titles already filed, runs the secret guard, and creates one draft advisory per finding
    with `SECURITY_ADVISORY_TOKEN`. It runs nothing from the agent's job, and not at all if that job
    was flagged suspicious.

  The `audit` job (environment `factory`, for the Claude token) writes the findings to a file and
  encrypts it with a fresh AES key, itself encrypted (RSA-OAEP) to the repository variable
  `AUDIT_FINDINGS_PUBLIC_KEY`; only the ciphertext is uploaded, because artifacts on a public
  repository are public. All of it is `openssl`, already on the runner.

- **What the owner sets up:**
  - An environment `security-advisories` (Settings → Environments), deployable from `main` only.
  - In it, the secret `SECURITY_ADVISORY_TOKEN`: fine-grained, this repository only, "Repository
    security advisories: Read and write" and nothing else.
  - A key pair, made locally:
    `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out audit.key && openssl pkey -in audit.key -pubout -out audit.pub`.
    `audit.key` goes in the `security-advisories` secret `AUDIT_FINDINGS_KEY`, `audit.pub` in the
    repository variable `AUDIT_FINDINGS_PUBLIC_KEY` (Settings → Secrets and variables → Actions →
    Variables); then delete both files.
- Nothing about a finding is public: no count, no title, no text in the log, the summary or the
  prompt. The owner reads Security → Advisories after each run, triages each draft, and fixes it in
  the advisory's private fork or closes it.

## Consequences

- Leaks like #29 get looked for every week, by exercising failures, not by reading code alone.
- One more Opus run a week on the owner's subscription, longer when it writes and runs tests.
- The owner holds one more token, which expires, and a key pair; when either is missing, the run
  fails at its first step and says which.
- **Accepted risk:** the agent's tests run with the network and the job's other secrets as every
  agent job has them (the Claude token, scrubbed from the commands but present on the runner). A
  manipulated agent or a compromised dependency could send its own findings out, but never the
  advisory token or earlier drafts, which only `preflight` and `file` see.
- A finding's fix is written in the advisory's private fork, by the owner or a session given the
  draft, not by the factory, whose pull requests are public. Wiring the factory into private forks
  is a later decision.
- Revisit if the findings are mostly noise (tighten the prompt or the bar), or to add a per-PR
  trigger for changes to auth, logging or `infra/`.

## Updates

- **2026-11-18:** the filing logic moved from the workflow into `.github/factory/file-advisories.sh`,
  pinned by `.github/factory/test-file-advisories.sh` in CI (a stand-in `gh` records what would be
  filed), like the denial report. It now lowercases severity (`High` was filed as `medium`),
  collapses all whitespace in titles before matching, and matches titles that start with `-`
  (grep read them as options, so the same hole could be filed every week).
- **2026-11-19:** the first run's denial report printed the first argument of each part of a
  refused command, and the agent names its test files after what it's probing, so the public log
  hinted at what it looked into (not what it found). The audit job now sets `DENIAL_LABELS=programs`:
  program names, the fixed reason when a call is flagged, and a file's tool only.
- **2026-11-20:** the audit runs nightly, skipping nights when main has no new commits
  ([ADR-0039](0039-nightly-mutation-and-security-audit.md)).
