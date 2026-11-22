# 0050. Add the factory's dependencies by hand

- **Status:** Accepted
- **Date:** 2026-11-22

## Context

The factory's agent jobs (implement, build, fix CI, rework) allowed `pnpm add`, `pnpm remove` and
`pnpm install`, and the implementer's instructions told it to add or bump a dependency when a
ticket or a security failure called for one. None of that could work. Ticket #130 needed
TanStack Router, and the agent stopped: `pnpm install` failed with
`ERR_PNPM_PACKAGE_MANAGER_REMOVE_MODULES_DIR` (`node_modules/.bin` on a read-only file system), and
`pnpm install --lockfile-only` with `ERR_PNPM_LOCKFILE_RENAME_FILE` (`pnpm-lock.yaml` busy).
`pnpm --filter @roundtable/web add …` was refused outright: `Bash(pnpm add:*)` matches only a
command that starts with `pnpm add`.

The cause is Claude Code, not our settings. With `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` and
bubblewrap installed ([ADR-0029](0029-software-factory-credential-hardening.md)), Claude Code runs
every command the agent starts in a bubblewrap sandbox with a built-in list of paths it can't
write. Relative to the directory Claude Code starts in, the list includes `package.json`,
`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `node_modules/.bin`, `.npmrc`, `scripts/`,
`.github` and `.claude`. Single files are bind-mounted read-only, which is why renaming the
lockfile reports "busy". We read the list in the binary of Claude Code 2.1.325, the version our
pinned `claude-code-action` installs. No setting removes a path from it, and the Bash tool's
`dangerouslyDisableSandbox` doesn't lift it. The only way out is to turn the scrub off.

The list is deliberate. What a package manager installs, and the lockfile that pins it, decide
what code every later step runs: `pnpm check` in the job, the guards after the agent, CI and
production. The agent reads text we don't fully trust (tickets, CI logs, user reports, dependency
code).

## Options considered

1. **Let the factory add dependencies**: set `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=0` so pnpm can
   write the lockfile and `node_modules`, and rely on `minimumReleaseAge`, `allowBuilds`,
   `check:deps` and the dependency register. Fully automatic, but every command the agent runs
   gets the Claude token and the runner's OIDC and runtime tokens back, which ADR-0029 exists to
   prevent.
2. **A trusted install step**: the agent stops with a new outcome naming the packages, and a fixed
   workflow step outside the agent runs `pnpm add`, commits `package.json` and the lockfile, then
   restarts the agent. This keeps the scrub and stays automatic, but adds the most new workflow
   code, and a ticket's text can still choose what gets installed.
3. **Say no explicitly (chosen)**: drop `pnpm add`, `pnpm remove` and `pnpm install` from every
   agent job's allowlist, and have the agent stop and name the change for a human to make.

## Decision

Option 3. No agent job allows `pnpm add`, `pnpm remove` or `pnpm install`; the workflow installs
from the lockfile before the agent starts, and the agent uses what's installed. When the work needs
a package that isn't installed, the agent commits nothing and names the package, its version,
which `package.json` it goes in, and why: `needs-info` on a ticket, `needs-human` while fixing CI or
reworking a review. The same goes for a dependency advisory: the agent names the bump or the scoped
override, and a human makes it. A human adds the package, with its row in
`docs/dependencies.md`, then labels the ticket `ready` again.

This amends [ADR-0028](0028-software-factory-ci-fixer.md), whose CI fixer was to fix security
failures itself by bumping or overriding dependencies, and
[ADR-0029](0029-software-factory-credential-hardening.md), by recording a consequence of the
scrub that it didn't name.

## Consequences

- What the instructions and the allowlists say matches what the sandbox allows, so a run stops on
  its first turn with a clear request, instead of after several failed installs.
- Every new package, and every change to the lockfile, passes through a human who reads it. That's
  what `docs/dependencies.md` asks for anyway.
- A ticket that needs a package takes two steps: a human adds it first (as #138 did for #130).
  When writing tickets, name new packages up front (`docs/agents/issue-tracker.md`).
- A dependency advisory on a factory pull request now needs the owner, where the CI fixer was
  meant to fix it.
- Revisit if hand-added packages become a bottleneck (option 2 is the path then), or if Claude Code
  lets the sandbox's protected paths be configured.
