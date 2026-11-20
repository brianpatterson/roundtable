# 0038. Let anyone report a problem; keep their words private and open issues with safe context only

- **Status:** Accepted
- **Date:** 2026-11-20

## Context

Failures outside our code never reach Sentry or the logs. A user who tried "Sign in with GitHub"
landed on GitHub's "redirect_uri is not associated with this application" page and never came
back. The only way to hear about failures like that is for the user to tell us, and they may not
have a GitHub account, or be able to sign in at all.

Forces:

- **The repository is public, and the factory's agents read issues** ([ADR-0025](0025-software-factory-implementer.md)).
  Anything a user types that lands in an issue is published, and it is a prompt-injection path
  into an agent that can push code.
- **The form is unauthenticated**, so it's an abuse target: storage, the owner's inbox, the Resend
  quota shared with auth emails ([ADR-0018](0018-email-sending-limits.md)), and the issue tracker.
- **A signed-in report should be linked to the account**, without making the form need a session.
- **Writing to GitHub needs a credential held by the app**, the first one that writes to the
  repository.

## Options considered

1. **Link to GitHub's "new issue" page.** No code, but needs a GitHub account and publishes
   whatever the user writes. Fails the user story.
2. **A third-party feedback widget** (Sentry user feedback, a form service). Fast, but sends user
   text to another processor, and ties reports to a vendor; Sentry's needs its SDK in the browser,
   which we don't ship.
3. **Our own endpoint: store in Postgres, email the owner, open an issue with safe context only.**
   More code, but the user's words stay in our database and the owner's inbox, and the issue gives
   the owner (and later the factory) something to track without carrying any user text.

## Decision

Option 3, as a new `support` module (API and web, [ADR-0023](0023-modular-monolith-layout.md)):

- **`POST /api/reports`, public**, behind a new `OptionalSession` middleware that identity
  implements: it provides a `Viewer` (`Option` of the user) and never fails, so a signed-in report
  carries the user id from the session (never from the body) and a signed-out one works.
- **Stored in `user_reports`**: id, description (1–2,000 characters), optional reply email,
  optional user id (no foreign key: modules query only their own tables, and a report outlives
  the account), page path without its query or hash (they can hold tokens; any path, at most 500
  characters, so a user on a mistyped link can still report), release, user agent, time. The
  client address is kept only as an HMAC keyed with the server's secret, for the limit.
- **The GitHub issue holds safe context only**: title `User report <id>: <page>`, body with the
  report id, page, release, time and browser family (one of a fixed list of words). Never the
  description, reply email, user id or user agent. The page is never the path the client sent:
  the server names one of the web app's pages (`/`, `/reset-password`) or `other`, so nothing the
  client chose reaches the issue. The owner's email has the path as sent. Labels are a constant,
  `bug` and `user-report`: **never `ready`**, so a public form can't start the factory.
- **The owner gets the full report by email** through the email module's `Mailer`, with a link
  to the issue (or why there is none), as a new `user-report` email kind.
- **Best effort after storing**: if GitHub or the email fails, the user still gets the
  confirmation with the report id; the failure is logged and goes to `ErrorReporter` with no user
  data (`IssueOpenFailed` carries only GitHub's status). Failed issues aren't retried.
- **Limits**: 5 reports per client address per hour, an IPv6 address counted by its /64 (one
  subscriber or VPS usually holds a whole /64), and 50 per hour from everyone together, so the
  table has an upper bound whatever the address mix. Past either, a 429 and nothing is stored or
  sent. Both are counted in Postgres under an advisory lock so they survive restarts. At most `REPORT_LIMIT_PER_DAY`
  (default 20) issues per 24 hours, and the same cap on report emails as their per-address limit
  in the `Mailer`, so a flood across many addresses can't fill the repository or use up the daily
  email total that sign-up and password resets need.
- **Issues are opened by a GitHub App, never with the owner's token.** The factory starts on a
  `ready` label or an `@claude` comment made by the owner ([ADR-0025](0025-software-factory-implementer.md)),
  and a personal token with Issues write can do both as the owner. The App is installed on this
  repository only, with Issues read/write and nothing else; its issues are authored by
  `<app>[bot]`, which the factory doesn't trust. The API holds the App's id, installation id and
  private key (`GITHUB_ISSUES_PRIVATE_KEY`, a `Secret`), signs a short JWT per issue and trades it
  for an installation token that lasts an hour, narrowed to this repository and Issues: write.
  Optional: without the App, reports are stored and emailed and the log says the issue was skipped
  (development, tests).

## Consequences

- Users can tell us what went wrong without an account, and the owner sees it by email within
  seconds; the public tracker gets a reference with nothing private in it.
- We now store free text from anonymous users. It's in the database backups like everything else;
  there is no admin UI, retention policy or deletion path yet. Revisit when reports are many, or
  when account deletion arrives (reports keep a user id with no foreign key).
- The app holds a credential that can write to the repository's issues: the App's private key. If
  it leaks, someone can create, edit, label or close issues and comment on them **as the App's
  bot**, not as the owner, so they can't start the implementer, and can't touch code. They could
  still write issues the architect agent or a person reads; delete the key on the App's page
  (rotation is in `infra/README.md`). A personal token was rejected for this reason.
- Anonymous reports appear as issues by the App's bot, so neither people nor agents mistake them
  for tickets the owner wrote.
- More setup than a token: the owner creates and installs an App (`infra/README.md`), and the API
  signs a JWT itself (`node:crypto`, no dependency) and makes two calls per issue.
- The client address comes from the last `X-Forwarded-For` entry, which Caddy sets. If the API is
  ever reachable without Caddy in front, that header can be forged and the per-address limit
  bypassed; the hourly ceiling for everyone and the daily caps still hold. The ceiling also means
  a flood can make the form answer "try again later" for an hour for everyone: the price of a
  bounded table.
- Nothing the client sends reaches an issue: the page is one of a fixed list or `other`. A new
  page in the web app needs adding to that list (`modules/support/handlers.ts`) to be named.
