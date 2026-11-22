# 0048. Answer the owner's `@claude` on pull requests only

- **Status:** Accepted
- **Date:** 2026-11-21

## Context

[ADR-0025](0025-software-factory-implementer.md) starts the implementer two ways: an issue labeled
`ready`, or the owner's `@claude` comment on an issue or a pull request. Since
[ADR-0047](0047-factory-dispatcher.md), a `ready` ticket is built through the dispatcher: one at a
time, once its blockers are deployed, by a `build` job that checks the ticket it hands the agent
and everything the agent publishes.

An `@claude` on an issue skips all of that. It can build the same ticket while the dispatcher's
`build` runs, in a different concurrency group, both pushing `claude/issue-<n>-` branches; and a
pull request it opens during a build looks, to that build, like something the build's agent
published from the wrong branch, which stalls the queue for a human. On pull requests, `@claude`
is still the only way to ask for a follow-up the Rework workflow and the CI fixer don't cover
("resolve the conflict", "why this approach?").

## Options considered

1. **Keep both**: let the build tolerate pull requests from other tickets' branches. A misled agent
   could then hide a pull request behind another ticket's branch name, and the two runs on one
   ticket would still race.
2. **Skip `@claude` on a ticket that's `building`**: no race on that ticket, but an issue mention
   still builds outside the queue, unchecked, whenever it isn't.
3. **`@claude` on pull requests only (chosen)**: a ticket is built one way, by labeling it `ready`.

## Decision

Option 3. The implement job runs only for the owner's `@claude` on a pull request. On an issue it
does nothing; label the issue `ready` instead. A user report's issue is never worked on in tag mode,
so its report is fetched only by `build`.

## Consequences

- Every build of a ticket goes through the dispatcher's checks, and the build's strict check of
  what was published stays strict.
- Asking a question on an issue, or for partial work there, no longer runs the agent. Labeling
  `ready` covers building; a question can go on the pull request once there is one.
- The guards every agent job runs after the agent (explain a failure, flag a suspicious run, take
  down credentials) are now scripts in `.github/factory/`, copied from `main` before the agent runs,
  so the jobs can't drift apart.
- Revisit if issue mentions turn out to be missed, for example to ask the agent to refine a ticket
  before it's labeled.
