# 0028. Let the factory fix CI failures on its pull requests, twice, then hand over

- **Status:** Accepted; which CodeQL results start the fixer is amended by [ADR-0030](0030-factory-code-scanning-findings.md), its concurrency by [ADR-0037](0037-software-factory-rework.md), and its security fixes, which a human now makes, by [ADR-0050](0050-factory-adds-no-dependencies.md)
- **Date:** 2026-11-17

## Context

The factory's pull requests ([ADR-0025](0025-software-factory-implementer.md)) only get a
review once CI is green ([ADR-0026](0026-software-factory-reviewer.md)). A red check waited for
the owner to notice. On #58 dependency review failed twice in a row on advisories in Stryker's
indirect dependencies (minimatch, then qs): routine, mechanical fixes (scoped pnpm overrides)
that still needed a human to start them, and the second only appeared after the first was fixed.

Forces:

- **Loops.** An agent that fixes its own failures can keep failing, on the owner's
  subscription limits.
- **Not every failure is the pull request's fault:** GitHub and registry outages, provider
  downloads timing out (2026-11-09), flaky tests.
- **Security failures are decisions.** "Make dependency review pass" can be done by weakening
  it.
- **Tokens.** A fix pushed with the workflow's own token starts no CI, so nothing would verify
  it.

## Options considered

1. **A fixer job in the factory**, on `workflow_run` when CI, dependency review or CodeQL fails,
   reusing the implementer's instructions with a "Fixing CI" section.
2. **A separate fixer agent** with its own instructions. Fixing code to meet the bar is the
   implementer's job; a third set of instructions would drift from it.
3. **The desktop app's Auto-fix**, which already watches pull requests opened from a Claude Code
   session. It doesn't cover tickets the factory builds on GitHub.
4. **Owner-only**, as before: reliable, and exactly the wait this removes.

## Decision

Option 1:

- **Which pull requests:** the factory's (`factory` label) automatically; any other, the
  owner's or Dependabot's, when labeled `autofix`. Never one labeled `needs-human`.
- **Trigger:** `workflow_run` on CI, Dependency review and CodeQL, when one fails on a pull
  request from this repository. It runs `factory.yml` from `main`. A cheap `select-fix` job
  (no secrets) skips stale commits (the head moved on) and counts attempts; the `fix-ci` job
  runs with the `factory` environment, one per pull request at a time.
- **What it does first:** reads every failing check and runs `pnpm audit`, so one attempt
  fixes everything. If the failure isn't the pull request's fault, it re-runs the failed jobs
  once instead of changing code.
- **Two attempts,** counted from marked comments since the last commit with no bot among its
  authors (a push from the owner resets the count). Then `needs-human` and a comment.
- **Security fixes,** in order of preference: bump the direct dependency; a scoped
  `pnpm-workspace.yaml` override with a dependency register row; replace or drop the package.
  Never allowlist an advisory, loosen `dependency-review.yml`, dismiss a CodeQL alert, or delete
  flagged code without fixing it. The summary names the decision, and the reviewer reads it once
  CI is green.
- **What it can't touch:** `.github/`, `.claude/`, `CLAUDE.md`. A fix that belongs there ends as
  `needs-human` with the exact change. A deterministic step checks what the fix commits touched
  and fails the run if it's one of those.
- **Token:** the Claude App's, so its pushes start CI. If the App's token exchange refuses
  `workflow_run` runs (it refused `pull_request_target` for the reviewer), a small GitHub App of
  our own replaces it, its key in the `factory` environment and its token from
  `actions/create-github-app-token`.
- **Prevention:** the implementer runs `pnpm audit --audit-level moderate` after adding or
  bumping a dependency. It stays out of `pnpm check`, which shouldn't need the network.

## Consequences

- A factory pull request reaches the owner green, or with a comment saying why it couldn't be.
  The two dependency review failures on #58 are the kind it fixes.
- Every failed run on a factory pull request costs a fixer run; a re-run of an outage costs a
  little, a hard failure at most two attempts.
- Fixing on `workflow_run` means the fixer sees each workflow's failure separately; one per pull
  request runs at a time, and a later one finds the earlier fix already pushed, or a moved head
  and stops.
- Revisit if fixes start masking problems instead of solving them (the reviewer and the owner
  read every one), or when the triage agent (roadmap block 5) takes over Dependabot.

## Updates

- **2026-11-17:** the first test (#60) worked end to end except one thing: the App token exchange
  accepted the `workflow_run` run, but the fix was pushed with the job's own token, which
  `actions/checkout` v7 had left in git's config where the action's cleanup doesn't reach, so
  CI on the fix waited for a manual approval. The fixer's checkouts now keep no credentials.
- **2026-11-17:** the implementer had the same problem on follow-ups: after `@claude address the
review` on #75 and #76, its pushes went out with the job's token and CI on them was held for
  approval. Its checkout keeps no credentials now either.
- **2026-11-18:** Dependabot's npm pull requests are labeled `autofix` by `.github/dependabot.yml`,
  so the fixer takes any whose CI fails, security fixes and version bumps alike (the Effect group
  can need code changes). Telling a security fix from a bump would need the Dependabot alerts
  API, which a workflow's own token can't read. The fixer pushing to a Dependabot branch means
  Dependabot stops rebasing that pull request; it's merged or closed as it is. GitHub Actions and
  Docker updates stay opt-in.
  - **The fix is reviewed.** The reviewer skips Dependabot's pull requests (ADR-0033) only while
    every commit is Dependabot's; once the fixer has pushed, it reviews the pull request like any
    other, so the reviewer still reads every fix.
  - **New releases wait.** Without a delay, a release could reach the fixer minutes after it's
    published: a compromised one only has to fail CI. `fix-ci` runs `pnpm install` as an ordinary
    step, outside the agent's isolation, in a job that can request OIDC tokens, and the agent then
    runs the package's code with the App's token on the remote. So the npm entry has a three-day
    `cooldown`, which gives the ecosystem time to pull a bad release; security updates aren't
    delayed. Install scripts stay limited to esbuild (`allowBuilds`).
  - **Release notes are untrusted text.** A Dependabot pull request's body is written by the
    package's maintainers, and both the fixer and the reviewer read it. The fixer can't change
    `.github/` or `.claude/`, the reviewer reads every fix, and the owner merges; the owner should
    still read the reviewer's verdict on these pull requests with that in mind.
  - **Attempts carry over a refresh.** The count resets only on a commit with no bot author. If
    Dependabot rebuilds a pull request after the fixer used its two attempts (a grouped bump to
    newer versions, `@dependabot recreate`), it goes straight to `needs-human`; the owner then
    pushes or labels as needed.
