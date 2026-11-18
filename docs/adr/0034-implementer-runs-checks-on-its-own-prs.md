# 0034. Let the implementer run checks on its own pull requests

- **Status:** Accepted
- **Date:** 2026-11-18

## Context

The implementer ([ADR-0025](0025-software-factory-implementer.md)) also runs when the owner
mentions `@claude` on a pull request, most often to address the reviewer's findings
([ADR-0026](0026-software-factory-reviewer.md)). On those runs the Claude Code action refused
every command that runs the checkout's code, `pnpm check` and the tests included, and logged:
"The author of pull request #76 is not confirmed to have write access, so commands that run code
from the checkout are denied. Set restrict_untrusted_prs to "false" to turn this off."

The factory's pull requests are opened by `claude[bot]`, the Claude GitHub App, which the action
doesn't count as a collaborator with write access. So both follow-ups on #76 pushed code no one
had run, and CI was the first test of it; one of its new tests failed there. The first run on a
ticket isn't affected (it starts from an issue, not a pull request), and neither is the CI fixer
([ADR-0028](0028-software-factory-ci-fixer.md)), which starts from a `workflow_run`.

The restriction exists for a real case: a pull request from someone without write access, whose
code would run with the job's credentials. [ADR-0029](0029-software-factory-credential-hardening.md)
already scrubs those credentials from what the agent runs, but running a stranger's code is still
a step it shouldn't take on a comment.

## Options considered

1. **Keep the restriction.** Follow-ups stay untested until CI, and a failure costs a CI fixer
   attempt or another round.
2. **Turn it off for the implementer.** Simple, but an owner's `@claude` on a fork's or a
   stranger's pull request would run their code.
3. **Turn it off only on pull requests `claude[bot]` opened.** Those branches live in this
   repository and were written by the implementer itself, from tickets the owner labeled `ready`.
4. **Add `claude[bot]` as a collaborator.** An App can't be one, and it would widen its access
   everywhere, not just here.

## Decision

Option 3. The implementer step sets `restrict_untrusted_prs` to `false` only when the event is a
comment on a pull request whose author is `claude[bot]`, and `true` otherwise. Every other guard
stays: only the owner's comments start the job, the allowlist and deny list are unchanged, and
commands run without the scrubbed credentials. The CI fixer and the reviewer are unchanged.

## Consequences

- Follow-ups can run `pnpm check`, the tests and mutation testing before pushing, like the first
  run on a ticket.
- The implementer now runs code on its own branches that someone else may have pushed to: the
  owner, or the CI fixer. Both are already trusted to push there.
- If the factory starts working on pull requests from people other than the owner, revisit this
  together with ADR-0029's option of separating the agent from the credentials.
