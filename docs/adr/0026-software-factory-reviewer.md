# 0026. Review factory pull requests with a second, read-only agent that never approves

- **Status:** Accepted
- **Date:** 2026-11-17

## Context

[ADR-0025](0025-software-factory-implementer.md) made the implementer: a labeled ticket becomes
a pull request. The roadmap's principle is that **an agent should never be the only judge of its
own work**. CI checks what is mechanical; the owner reviewed the first feature PR (#54) by hand:
reading the diff against the ticket, spotting a scope addition, and checking the UI in a
browser. Building block 3 is a second agent that does the reading part first, so the owner's
review is quicker and catches less by luck.

Forces:

- **Independence.** A reviewer that shares the implementer's context or reasoning shares its
  blind spots.
- **The public repo and the token.** Pull request code is untrusted input. A workflow that runs
  a branch's copy of itself, or runs the branch's code, with the Claude token in reach, can be
  turned against it.
- **The owner's subscription limits.** Every review uses the same limits as the owner's own
  sessions.
- **The ruleset requires no approvals.** The owner can't approve their own pull requests, and a
  bot's approval of its own App's work would mean nothing.

## Options considered

1. **On every pull request event** (`pull_request_target`). Reviews every push, including ones
   that fail lint, and never sees CI's results.
2. **After CI passes** (`workflow_run` on CI). Reviews only green commits, can read CI's
   results, and runs from `main`. Needs a lookup from the run to its pull request.
3. **A required check** whose failure blocks the merge. Strong, but it would block the owner's
   own pull requests unless it reviewed all of them, and its verdicts aren't proven yet.
4. **The implementer reviewing itself** in the same run. Cheap, and exactly what the principle
   rules out.

## Decision

Option 2 for automatic reviews, plus an on-demand trigger, with these constraints:

- **Which pull requests:** the factory's (labeled `factory`) after each green CI run on a new
  head commit, and any pull request the owner labels `review` (also re-reviewed after each green
  run). Dependabot's are left to the triage agent (roadmap block 5).
- **Triggers:** `workflow_run` on CI and `pull_request_target` for the `review` label. Both run
  `.github/workflows/review.yml` from `main`; the `factory` environment holds the token.
- **Read-only:** the working directory is a checkout of `main` (the reviewer's instructions,
  `CLAUDE.md`, Claude Code's settings); the pull request is a second checkout in `./pr/`, read
  and never installed or run. Tools: read, search, `gh pr view/diff` and `gh issue view`. No
  edits, no shell beyond those, no web. Opus 5.5, 60 turns, 30 minutes.
- **Instructions:** `.github/factory/reviewer.md`: acceptance criteria mapped to tests that
  would fail without the change, scope against the ticket, `CLAUDE.md`'s rules, a security
  review against every category of the [OWASP Top 10:2025](https://owasp.org/Top10/2025/),
  each written out for this codebase (access control and tenancy, misconfiguration, the supply
  chain, secrets, injection including prompt injection, missing limits, auth flows, schema
  decoding at trust boundaries, what leaves the process, and failing safe), and what only a
  browser or a human can check. The review ends with which categories the change touches.
- **Output:** structured (`verdict`: `ready` or `changes`, plus Markdown). A deterministic step
  posts it as one comment per pull request, updated in place. It never approves or requests
  changes.
- **The loop stays manual:** the owner replies `@claude address the review`, and the
  implementer, which now reads the reviewer's comments, fixes the blocking findings.

## Consequences

- The owner gets a checklist-driven read of every factory pull request before their own, from
  an agent that didn't write it, at the cost of one more run per green commit.
- Findings are one comment with `file:line` references, not inline review comments: the action
  only offers its inline-comment tool on pull request events, and `workflow_run` isn't one.
- `allowed_bots: claude[bot]` is needed because the factory's pushes start CI as the Claude App,
  and the action checks the upstream run's actor. It admits only that App.
- The reviewer can't run anything, so it can't catch what only running would show; CI, and the
  owner's browser check, still do.
- Revisit when its verdicts have proven reliable over several tickets: make `verdict` a required
  check for factory pull requests, or close the loop automatically with a round limit.
