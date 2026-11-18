# 0033. Review every pull request but Dependabot's, not only the factory's

- **Status:** Accepted
- **Date:** 2026-11-17

## Context

[ADR-0026](0026-software-factory-reviewer.md) has the reviewer agent review the factory's pull
requests automatically, after each green CI run on a new commit, and any other pull request only
once the owner labels it `review`. It kept the owner's own pull requests opt-in for two reasons:
every review spends the owner's subscription limits, and the reviewer's verdicts weren't proven.

Since then, the owner's pull requests (most of them written with an agent in a session, like
#78) change the factory itself, its workflows and its permissions: the code where a second read
matters most. Remembering to add a label is the step that gets skipped. ADR-0026's principle, that
an agent should never be the only judge of its own work, applies to those pull requests too.

The reviewer's instructions assume a ticket: its first check maps the ticket's acceptance
criteria to tests. The owner's pull requests often close no ticket.

## Options considered

1. **Keep the label.** No cost, but it depends on remembering it, on exactly the pull requests
   that change the factory.
2. **Review every pull request from this repository except Dependabot's**, after each green CI
   run on a new commit. One more review per push, from the same subscription. Dependabot's stay
   with the triage agent (roadmap block 5), as ADR-0026 planned.
3. **Make the verdict a required check.** ADR-0026's own revisit condition, but its verdicts
   still aren't proven over enough pull requests, and a wrong `changes` would block a merge.

## Decision

Option 2. The Review workflow's `select` job reviews every same-repository pull request whose
author isn't Dependabot, once CI passes on its head commit; the `factory` and `review` labels no
longer decide it. Labeling `review` still starts a review at once, on any pull request.
Everything else in ADR-0026 stands: it runs from `main`, reads and never runs the pull request,
posts one comment updated in place, and never approves.

Without a ticket, the reviewer checks the change against the description's "What and why"
instead, and lists its claims where it would list acceptance criteria
(`.github/factory/reviewer.md`).

## Consequences

- Every green push on any pull request costs one review (Opus 5.5, up to 60 turns) from the
  owner's subscription. Pushing several commits in a row reviews only the last one CI passes on;
  earlier runs see that the head moved and stop.
- Fork pull requests stay excluded: the trigger already requires the head to be in this
  repository, because the workflow holds the Claude token.
- Without a ticket, "what was asked" is the author's own description, so the reviewer can check
  that the change does what it says, but not that it's what was needed.
- Revisit as ADR-0026 says: once verdicts have proven reliable, make the verdict a required check.
  If the cost shows up in the subscription limits, go back to labels for pull requests that don't
  touch `.github/`, `infra/` or auth.

## Updates

- **2026-11-18:** Dependabot's pull requests are skipped only while every commit is Dependabot's.
  Its npm pull requests now get `autofix` ([ADR-0028](0028-software-factory-ci-fixer.md)), and
  once the CI fixer pushes to one, the reviewer reviews it, so no fix goes unread.
