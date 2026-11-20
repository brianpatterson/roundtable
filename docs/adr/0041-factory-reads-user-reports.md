# 0041. Let the implementer read the user's report, fetched by the workflow with a token the agent never sees

- **Status:** Accepted
- **Date:** 2026-11-20

## Context

"Report a problem" ([ADR-0038](0038-user-problem-reports.md)) keeps what the user wrote out of the
public issue: the issue holds the report id, page, release, time and browser family. When the
owner labeled the first report `ready`, the implementer had nothing to go on and asked for the
details, so the owner had to retell a private report in public. The owner wants the loop to be:
a user reports a bug, an issue appears, the owner labels it `ready`, and the factory fixes it.

What the user wrote also tends to be thin ("the list is empty"). The browser knows more: which
API requests failed and with what status, and which errors were thrown.

Forces:

- **The repository is public.** Everything the factory publishes (comments, pull requests,
  commits) can be read by anyone. The report may hold personal details.
- **A report is the least trusted text the factory reads.** Anyone on the internet can write
  one, and the implementer can push code. The roadmap's building block 5 had ruled this out:
  "Agents never get real values … stored text a prompt-injection path".
- **The implementer runs with the Claude token and a GitHub App token** ([ADR-0029](0029-software-factory-credential-hardening.md)).
  Anything else the job holds, a hijacked agent could try to reach.

## Options considered

1. **The owner pastes the details into a comment.** No code, but it's the manual step to remove,
   and it publishes them.
2. **Encrypt the report into the issue body** with a key only the factory holds. No new endpoint,
   but hand-rolled hybrid encryption (or a new dependency), and the ciphertext is public forever:
   a leaked key exposes every past report, and a report can't be deleted from the issue's history.
3. **A private repository** where the report App also files the full text, read by the workflow
   with an installation token. No new endpoint, but the text is copied to GitHub, and the factory
   holds a key that can mint tokens for the report App.
4. **A read endpoint on the API, behind a token the workflow uses in a step of its own**, before
   the agent starts. The text stays in our database, where it can be deleted.

## Decision

Option 4.

- **`GET /api/factory/reports/:id`** in the support module returns the description, the page path,
  release, browser family, whether the user was signed in, the time and the diagnostics. It never
  returns the reply address, the user id or the full user agent. It answers only
  `Authorization: Bearer <FACTORY_REPORTS_TOKEN>`, compared in constant time; without the token
  configured, nobody can read through it. Reports older than 30 days are a 404.
- **Diagnostics come with the report.** The web app keeps, in memory, the latest 20 API requests
  (method, path without its query, status, or 0 for a network failure; Better Auth's included) and
  the latest 5 uncaught errors (message and stack, cut short), plus the window size and theme. A
  report sends them in a new nullable `diagnostics` column. They are private like the
  description: stored, in the owner's email, given to the implementer, never in the issue. The form
  says so, and says an AI assistant reads reports.
- **The workflow fetches the report, not the agent.** In the implement job, for an issue authored
  by `roundtable-user-reports[bot]` and labeled `user-report`, a step runs
  `.github/factory/fetch-report.sh` with the token in its own environment. It writes the report to
  a directory the agent may read (`--add-dir`), and appends to the agent's instructions where the
  file is, or why it couldn't be fetched. The token is a secret of the `factory` environment, which
  admits only `main`, and it is never passed to the Claude step.
- **The implementer treats the report as untrusted data** (`implementer.md`, "User reports"): only
  a bug fix, reproduced first with a failing test; the bug described in its own words; stop and
  ask when it can't reproduce it.
- **A deterministic check catches quotes after the run.** `guard-report-text.sh` refuses text
  holding any 40 characters of the description (case and whitespace ignored), compared with a copy
  kept outside the directory the agent can edit. The agent's comments are taken down, and a pull
  request's title and description that quote it are replaced; a branch whose added lines or commit
  messages do gets `needs-human`, because a push can't be taken back. Diagnostics aren't checked:
  error messages such as `TypeError: x is undefined` are what a fix rightly names, so the
  implementer is told instead to name errors by type and place, not by their full message.

## Consequences

- The owner's step is to read the report email and label the issue `ready`. That label is still
  the gate: the owner has read what the agent will read.
- The roadmap's "agents never get real values" no longer holds for reports. It still holds for
  application data and production errors, which the factory never reads.
- **Prompt injection:** a report can try to steer the agent. What stands in the way: the owner
  reads it first; the agent's instructions; the agent has no credentials of its own and can't edit
  `.github/` ([ADR-0029](0029-software-factory-credential-hardening.md)); and the reviewer and the
  owner's merge come before anything ships.
- **If `FACTORY_REPORTS_TOKEN` leaks**, the holder can read reports under 30 days old by id (the
  ids are in the public issues): their text and diagnostics, never who sent them. Nothing else.
  Rotate it in both places (`infra/README.md`). The report text now reaches Anthropic through the
  agent, like the code does.
- **The guard is a backstop, not a proof.** It catches copying, not paraphrase, and nothing under
  40 characters, so a name alone gets through. A quote in a commit is public until the owner
  rewrites the branch.
- **New attack surface:** one public endpoint behind a 256-bit bearer token. No rate limit: the
  token can't be guessed, and each request is one indexed lookup.
- Diagnostics can hold personal data an error message happens to include. They are cut short,
  never include request or response bodies or query strings, and stay as private as the
  description. Revisit with ADR-0038's open question of retention.
- The endpoint is part of `RoundtableApi`, like every other, so the typed client in the browser
  bundle has a `factoryReports.get` method (useless without the token) and `client/errors.ts` a
  message for `ReportNotFound` that no page shows. A separate contract for factory-only endpoints
  would avoid that, at the cost of a second `HttpApi` and its tests; revisit if more appear.
- The site's URL is written into `factory.yml` (`https://roundtableapp.us`), because the `DOMAIN`
  variable belongs to the `production` environment. A new domain needs changing it there.
