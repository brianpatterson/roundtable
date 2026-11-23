# 0030. Route code scanning findings into the factory, and keep agent jobs off main's cache

- **Status:** Accepted
- **Date:** 2026-11-17
- **Amends:** [ADR-0028](0028-software-factory-ci-fixer.md) (which CodeQL results start the fixer)

## Context

ADR-0028 has the CI fixer run "when CI, dependency review or CodeQL fails". A review of alert #9
(`actions/untrusted-checkout/medium` in `deploy.yml`, open since 2026-11-11 and unnoticed for six
days) showed that it can't work for CodeQL:

- **A finding doesn't fail the CodeQL workflow.** Every run concludes `success`; GitHub reports
  new alerts on a pull request in a separate check. The fixer only fired if the analysis itself
  broke.
- **Alerts on `main` reach no one.** Pushes and the weekly scan create alerts with no pull request,
  and the fixer only handles pull requests.
- **No agent can read alerts.** Neither the job tokens nor the Claude App have code scanning access,
  and on a public repository the details of an open alert shouldn't be published.

Alert #9 itself was a false positive (the deploy job only runs for pushes to this repository's
`main`) and was dismissed with that reason. The same review found a real risk CodeQL didn't
flag: the implementer and fixer restored and saved the pnpm cache. Their caches are scoped to
`main` (they run on `issues` and `workflow_run`), but what they install comes from a branch, so a
store shaped by a branch could be restored by CI and deploy on `main`.

## Options considered

1. **Fail the CodeQL workflow on findings in a pull request's changed files**, and let the existing
   fixer read them from the log.
2. **Trigger the fixer on GitHub's own CodeQL check run**, which already counts only new alerts.
   Cleaner, but whether those check runs can start a workflow is unverified.
3. **`code_scanning_alert` as a workflow trigger** for alerts on `main`. It doesn't exist: it's a
   webhook for GitHub Apps, not an event that can start a workflow.
4. **An agent that triages alerts on `main`** and writes real findings into private draft security
   advisories. The most complete, but it needs facts not yet verified (whether a workflow token
   can create advisories) and decisions about where write-ups go.

## Decision

- **Pull requests (option 1):** `codeql.yml` writes its results and, on a pull request, fails with
  one `::error file=…,line=…::CodeQL <rule>: <message>` line per finding in a file the pull request
  changed. Findings elsewhere are older alerts and don't fail unrelated pull requests. The fixer
  (ADR-0028) then starts as for any failure and reads the findings with `gh run view --log-failed`.
  A finding in `.github/` still ends as `needs-human`, since the factory can't edit there. The
  findings already show on public pull request checks, so the log adds no exposure.
- **`main`:** a `Security alerts` workflow runs after every CodeQL run on `main` (pushes and the
  weekly scan) with the job's token and `security-events: read`. It opens a `security-triage` issue
  for each open alert that has none, saying only the alert's number, rule and severity, never its
  file, line or message. No agent runs there. Triage and dismissal stay the owner's.
- **Caches:** the implementer's and fixer's `setup-node` steps keep no dependency cache
  (`package-manager-cache: false`). CI's own jobs keep theirs: they run on `pull_request`, whose
  caches stay scoped to the pull request.
- **Later (option 4):** an alert triage agent, as its own ticket, once advisory creation from a
  workflow is verified.

## Consequences

- A pull request that introduces a CodeQL finding now fails, and the fixer gets a chance to fix it
  before the owner looks. An alert on `main` becomes an issue within minutes of the scan.
- A pull request that touches a file with an older alert in it now fails on that alert too, since
  results don't say which findings are new. That's a nudge to fix or dismiss it.
- The two agent jobs install from scratch, a minute or so slower; they run rarely.
- The issue for an alert is created once; closing it without fixing or dismissing the alert
  doesn't reopen it.
- Revisit with option 2 if GitHub's CodeQL check run turns out to trigger workflows, and with option
  4 when the triage agent is built.

## Note (2026-11-23)

The pull request check reads the open CodeQL alerts on the pull request's ref instead of the SARIF
file, so dismissing an alert clears it, as the consequences above expect. Reading the file failed
every change to `deploy.yml` on alert #9, dismissed in November. The decision is unchanged.
