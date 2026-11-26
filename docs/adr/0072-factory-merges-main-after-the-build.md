# 0072. Merge main into a factory build's branch outside the agent's sandbox, with a fresh App token

- **Status:** Accepted
- **Date:** 2026-11-25

## Context

The implementer merges main into its branch before it pushes, so the pull request it opens is
up to date and its ADR numbers don't collide ([ADR-0058](0058-factory-resolves-conflicts.md)).
Its sandbox can't write `.github/`, `.claude/` or `CLAUDE.md` ([ADR-0029](0029-software-factory-credential-hardening.md)),
so that merge is refused whenever main has changed one of them since the build started. The
owner edits `.github/` after most retrospectives, while the next ticket is often building. On
#228 the agent pushed without the merge, and the owner merged main by hand three minutes after
the pull request opened (retro #241).

The conflict resolver ([ADR-0058](0058-factory-resolves-conflicts.md)) avoids this because its
workflow merges main before the agent starts. A build can't do that: main moves while it runs.

Forces:

- **A push needs a token that starts CI.** The job keeps no credentials of its own after checkout,
  and a push with the job's `GITHUB_TOKEN` starts no workflows (#75, #76). The Claude action's App
  token, which does, is revoked when the action's step ends.
- **The merge must not run the branch's code** or anything the agent left in its workspace (git
  hooks, config) while a token is in reach.

## Options considered

1. **Let the agent write the protected paths during a merge.** Weakens the one guard that keeps an
   agent from changing the factory's own rules. Rejected.
2. **Push the merge with the job's `GITHUB_TOKEN`.** No CI or reviewer on the merge commit, so the
   pull request sits without checks until someone closes and reopens it.
3. **Hand the branch to the conflict resolver.** It only runs on conflicting pull requests, and
   would spend an agent run on a merge that needs no judgment.
4. **A workflow step after the agent merges main, and pushes with a fresh App token**, exchanged
   for the job's OIDC token at the same endpoint the Claude action uses, and revoked after the push.

## Decision

Option 4. After the build job's agent step and its checks of what the agent published,
`.github/factory/merge-main.sh` (copied from main) fetches the accepted
`claude/issue-<n>-` branch and main into a new repository outside the workspace, with no checkout action, so CodeQL's untrusted-checkout rules hold. It merges main only when main changed nothing since the merge base but
`.github/`, `.claude/` and `CLAUDE.md` (both names of a renamed file count), with git hooks off. A
conflict is aborted and left to the conflict resolver; a main that changed other files too is left
alone, since a pull request needn't be up to date to merge ([ADR-0035](0035-merge-without-updating-branches.md)).
The push is never forced. The implementer is told to abort a merge the sandbox refuses and push
without it.

## Consequences

- No owner commit for the common case, and CI and the reviewer run on the merge.
- The step depends on the Claude action's token exchange, which isn't a documented API. If it
  changes, the step fails with an annotation and the pull request is left behind main, as before
  this ADR; it never blocks the build. Revisit if the action exposes its token to later steps.
- The merge commit is authored by `factory`, not the owner or the Claude App.
- Only the dispatcher's build does this. A follow-up, CI fix or rework doesn't merge main (they're
  told not to), so it isn't needed there.
