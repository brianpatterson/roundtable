# 0025. Build labeled tickets with Claude Code in GitHub Actions, gated by the owner

- **Status:** Accepted, amended by [ADR-0048](0048-claude-mentions-on-pull-requests-only.md)
- **Date:** 2026-11-16

## Context

Phase 3 of the roadmap is a software factory: write a ticket, and an automated pipeline
implements, verifies and ships it. The first two building blocks are a ticket template and an
implementer agent. The codebase is ready for one: modules with one public interface each,
`pnpm check:boundaries`, colocated tests against a real database, and `CLAUDE.md` rules that an
agent can follow.

Forces:

- **The repo is public.** Anyone can open an issue or comment, and an issue's text is a
  prompt-injection path into an agent that can push code.
- **An agent should never be the only judge of its own work** (roadmap). CI and a human decide
  what merges.
- **Cost.** The owner has a Claude subscription (a Team plan seat with Max-level limits); per-token
  API billing would be a second bill.
- **GitHub's token rule.** Pushes and pull requests made with a workflow's `GITHUB_TOKEN` start
  no other workflows, so CI would never run on them.

## Options considered

1. **Claude Code GitHub Action** (`anthropics/claude-code-action`), triggered by a label. Runs
   Claude Code in our own runner with our tools (Postgres, `pnpm check`), pushes as the Claude
   GitHub App, whose token does start workflows. Built-in write-access check and comment
   filtering. It pushes a branch rather than opening a PR by default.
2. **GitHub Copilot coding agent**, assigned to an issue. Opens PRs itself, but runs Copilot's
   models, on another subscription, and with less control over its tools and instructions.
3. **A hosted agent service** watching the repo. Another account, and the agent runs outside
   our CI, so it can't use the same Postgres service and checks.
4. **Our own script** calling the Claude API from a workflow. Full control, but we'd rebuild
   branch handling, progress comments and GitHub tools the action already has.

## Decision

Option 1, with these constraints:

- **Triggers:** an issue labeled `ready`, or an `@claude` comment on an issue or pull request,
  and only from the repository owner (`github.actor == github.repository_owner`). Only
  `issues` and `issue_comment` events, which always run the workflow from `main`. Pull request
  review events would run the branch's copy of the workflow, so they're not used.
- **Credentials:** a `CLAUDE_CODE_OAUTH_TOKEN` from the owner's subscription (`claude
setup-token`), stored in a `factory` GitHub Environment that admits only `main`. No production
  secrets are in reach. If the subscription can't be used this way, an API key with a spend
  limit replaces it; nothing else changes.
- **Instructions:** `.github/factory/implementer.md`, appended to Claude Code's system prompt
  and copied from `main` before the agent switches branches. It treats the ticket as data,
  checks it against a definition of ready, and works to `CLAUDE.md`'s rules until `pnpm check`
  passes.
- **Powers:** `acceptEdits` permission mode with an explicit allowlist (`pnpm`, `git`, `ls`, and
  `gh pr create/view/checks`), no web fetching, Opus 5.5, 60 turns, 60 minutes. Only the owner's
  comments reach the agent (`include_comments_by_actor`).
- **Pull requests:** the agent opens its own PR with the App's token, so CI runs. A
  deterministic step afterwards checks the branch through the API: no commits means the agent
  asked questions, so the label becomes `needs-info`; a change to `.github/`, `.claude/` or
  `CLAUDE.md` fails the run and warns on the issue; a branch without a PR gets a draft PR and a
  note that CI starts only once a human closes and reopens it.
- **Tickets:** issue forms for features and bugs (problem, user story, Given/When/Then
  acceptance criteria, modules touched, design system components, out of scope, docs impact),
  with blank issues turned off.
- **Merging** stays human, always.

## Consequences

- A ticket becomes a pull request with no human typing code, and every PR still passes the same
  required CI and a human review. The ticket's quality now matters as much as the code's.
- The factory uses the owner's subscription limits, so busy factory runs compete with
  interactive Claude Code sessions.
- The action is pinned by commit SHA; its v1 line ships breaking changes in patch releases
  (v1.0.273, v1.0.277), so Dependabot bumps to it need their release notes read.
- Some behavior was undocumented or contradictory when this was written (whether the agent's
  own `gh pr create` works, whether the App can edit workflow files). The first real run checks
  it; the deterministic step covers both outcomes.
- Revisit when the reviewer agent (building block 3) lands, if the owner-only trigger blocks a
  collaborator, or if subscription limits get in the way.

## Updates

- **2026-11-17:** the turn cap is 150, not 60. The first feature ticket (#53) took 70 turns and
  was marked failed after it had already opened its pull request. The 60-minute job timeout
  stays the real limit.
