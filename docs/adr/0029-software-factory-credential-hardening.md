# 0029. Keep the factory's credentials out of what its agents run and publish

- **Status:** Accepted, amended by [ADR-0050](0050-factory-adds-no-dependencies.md) (the scrub's sandbox keeps the agent from installing packages)
- **Date:** 2026-11-17

## Context

The factory's jobs ([ADR-0025](0025-software-factory-implementer.md),
[ADR-0026](0026-software-factory-reviewer.md), [ADR-0028](0028-software-factory-ci-fixer.md))
hold credentials: the owner's long-lived `CLAUDE_CODE_OAUTH_TOKEN`, the Claude App's
short-lived installation token (on the git remote during the job), the job's `GITHUB_TOKEN`,
and the runner's OIDC request token, which can mint new App tokens. The workflow-level boundaries
hold: they run from `main`, the `factory` environment admits only `main`, triggers are gated to
the owner and labels. A review found the gaps inside a job:

- **The command allowlists weren't a boundary.** `Bash(pnpm:*)` included `pnpm exec` and
  `pnpm dlx`; `Bash(git:*)` included `git config` and `git -c core.sshCommand=…`; and an agent
  that can edit `package.json` can run anything through `pnpm check`. Every command inherited
  the job's environment, credentials included, with the network open.
- **What the agents post is public and unmasked.** GitHub masks registered secrets in logs, not
  in comments, pull request bodies or commits. A manipulated agent could publish a token.
- **Untrusted text reaches the agents:** CI logs, dependency code and tests (the fixer runs
  them), and on `autofix` pull requests, code the owner didn't write.

Already in place: secret scanning with push protection (blocks known token formats in commits),
pnpm running install scripts only for `esbuild` (`allowBuilds`), a read-only reviewer that never
runs pull request code, and checkouts without persisted credentials where they're not needed.

## Options considered

1. **Scrub and isolate subprocesses** (`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`, bubblewrap): every
   command the agent runs starts without Anthropic credentials or the runner's OIDC and runtime
   tokens, in its own PID namespace. Claude Code's own mechanism; best effort.
2. **Tighter allowlists only.** Raises the bar, but editing a script and running it gets around
   any allowlist while file edits are allowed.
3. **No network for the agent's commands.** The strongest, but `pnpm add` and `gh` need the
   network, and the runner has no simple egress filter.
4. **Separate jobs:** the agent works without credentials, and a later job pushes its diff. The
   cleanest split, but it gives up the agent pushing, commenting and opening its own pull request,
   which the action's flow is built on.

## Decision

Options 1 and 2 together, plus a guard on what's published:

- **Scrub and isolate** on all three agent jobs: `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1'` on the
  Claude step, and `./.github/actions/isolate-agent` (installs bubblewrap, allows unprivileged
  user namespaces) run from `main`'s checkout, before any branch replaces the workspace.
- **Narrow allowlists** for the implementer and fixer: named `pnpm` scripts (`check`, `install`,
  `add`, `remove`, `audit`, `format`, `lint`, `typecheck`, `test`, `db:generate`, the web
  mutation run), named `git` subcommands, `git push` only to `origin`. Denied outright:
  `pnpm exec`, `pnpm dlx`, `pnpx`, `npx`, `git config`, `git remote`, `git -c`,
  `git credential`, and reading `.git/` (where the App token sits in the remote URL).
- **A secret guard** (`.github/factory/guard-secrets.sh`, copied from `main`): refuses text
  matching Anthropic and GitHub token formats, private keys and JWTs. The review and fix steps
  run it before posting; after the implementer, a step checks its comments and pull request
  description, deletes or blanks any match, and fails the run so the owner rotates the
  credential.

## Consequences

- A manipulated agent can no longer read the Claude token or mint App tokens from the commands
  it runs, and can't publish a token through the factory's own posting steps.
- **Residual risk, accepted:** the App token is still usable by `git push` and `gh` (that's
  their job) for the length of the job, and scoped to this repo; `pnpm add` can fetch from a URL;
  an agent that edits a script can still run it, just without the scrubbed credentials. The
  long-lived Claude token is the one that matters most, and it's out of reach.
- Isolation and scrubbing are best effort, and Claude Code's mechanism, not ours. If a future
  release changes what it scrubs, this ADR's guarantees change with it.
- Revisit with option 4 if the factory starts handling code from people other than the owner,
  or if the action gains a mode that separates the agent from the credentials.

## Updates

- **2026-11-17:** the first hardened run (#60) diagnosed the failure but couldn't fix it: with
  `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` set, Claude Code forces the `default` permission mode and
  ignores `acceptEdits`, so file edits were denied. The implementer and fixer now allow `Edit`,
  `Write` and `MultiEdit` by name, and deny them on `.git/`, `.github/`, `.claude/` and
  `CLAUDE.md`: the protected paths are now refused at the tool, not only checked afterwards.
- **2026-11-17:** every agent job reports the tool calls it was refused
  (`.github/factory/report-denials.sh`), so allowlist gaps are visible (the #65 run had 12
  denials and no way to tell what they were). The report is public and a manipulated agent
  chooses what it tries, so it must not become a way to publish data: it shows only the tool, a
  command's program and subcommand when they're plain lowercase words, and a path's top-level
  folder, and it passes the secret guard. Denials that reach for credentials or the factory's
  rules (`.git/`, `.github/`, `.claude/`, `CLAUDE.md`, `git config`/`remote`/`credential`/`-c`,
  `pnpm exec`/`dlx`, `npx`, `curl`, `env`; `pnpm exec` no longer, see the next entry)
  mark the run suspicious: the job fails, the issue or
  pull request gets `needs-human` and a comment, and a suspicious review isn't posted. Detection
  is the workflow's, not the agent's: the agent is the party that may be compromised.
- **2026-11-17:** running an installed binary with `pnpm exec` is now a gap in the denial
  report, not suspicious. The #76 implementer run was flagged for one honest `pnpm exec`, the way
  any agent reaches for a tool's binary, and the deny list refuses it at the tool anyway, so
  flagging it only trained the owner to ignore the label. Downloading a package to run it
  (`pnpm dlx`, `npx`, `pnpx`; npx downloads what isn't installed without asking in CI) stays
  suspicious, since that is how a manipulated agent would bring in its own code, as do credential
  paths, `git config`/`remote`/`credential`/`-c`, `curl`, `wget`, `env` and `printenv`.
  - The report classifies each part of a command on its own: it splits at `;`, `|`, `&`,
    newlines, backticks and parentheses, and skips leading quotes, `VAR=…`, wrappers such as
    `bash -c`, `xargs` and `timeout`, and the program's directory. So `cd x && curl …`,
    `$(curl …)`, `bash -c 'curl …'` and `pnpm exec curl …` are flagged like `curl …` (what
    `pnpm exec` runs is classified too, past pnpm's and git's global flags such as `--filter x`
    and `-C dir`). `.github/factory/test-report-denials.sh` pins
    the classification, and CI runs it. It is best effort, not a shell
    parser: a separator inside quotes also splits (a false alarm), and an encoded command isn't
    seen. The deny list is the boundary; the report only decides who looks.
  - The implementer and fixer also allow `cd` (agents chain `cd dir && pnpm …`, and every part of
    a chain must be allowed), `pnpm format` with arguments, any `pnpm prettier` command
    (`--check` was refused) and `git merge` (merging `main` to resolve a conflict was refused on
    #76). Their instructions say to merge `main` only when the owner asks to resolve a conflict.
    Both entries are broader than their use: `pnpm prettier` also takes `--plugin` (code from the
    workspace, which `pnpm test` already runs) and `git merge` takes any fetched ref; only the
    instructions narrow them.
- **2026-11-18:** the denial report splits commands the way a shell does (Python's `shlex`,
  replacing the regex split in jq), so quoted text is no longer split. The reviewer's run on #80 was
  flagged for a refused command with `curl` in it, and the report couldn't tell whether `curl`
  was a program or text in a grep pattern: `gh pr diff 80 | grep -n "exec curl\|curl"` split at
  the `\|`. It also parses subshells, backticks, `bash -c '…'` and `eval` strings in turn.
  - **Labels show the command's shape:** each part's program and first argument when they are
    plain lowercase words or short flags, joined by the shell operators, and why it was flagged:
    `Bash: cd … && curl … (curl)`, `Bash: gh pr | grep -n`. Still nothing that could carry
    encoded data, and the secret guard still runs on it.
  - **Also flagged:** what pnpm runs for an unknown command (`pnpm git config …`: pnpm runs it
    like `exec`), nested pnpm, `pnpm create` (it downloads a package to run it, like `pnpm dlx`),
    and git's `--config-env` and `--exec-path=<dir>` (which runs subcommands from that directory)
    like `-c`. More global flags that take a value are skipped (`--filter-prod`,
    `--workspace-concurrency`, `--attr-source`, `--super-prefix`).
  - **Denied outright:** the implementer and fixer deny `git --config-env`, like `git -c`:
    `Bash(git --config-env:*)` for the form with a space, and the wildcard
    `Bash(git --config-env=*)` for the `=` form, since `:*` only matches a prefix followed by a
    space. If a Claude Code version doesn't match that wildcard, the `=` form is still refused
    because no allowlist entry matches it.
  - `.github/factory/test-report-denials.sh` pins 65 cases. Seeing exactly what an agent tried
    would need its full transcript, which is deleted with the job; keeping it, encrypted to the
    owner, is a separate decision.
- **2026-11-18:** the implementer and fixer may run one package's tests:
  `pnpm --filter @roundtable/web test`, `pnpm --filter @roundtable/api test` (with arguments) and
  `pnpm vitest`. Both were refused on #85, so the agent ran the whole suite instead. `--filter` is
  allowed only with those two packages' `test` script, not as a prefix: `pnpm --filter x exec …`
  would not match the deny list's `pnpm exec`. `pnpm vitest` runs test files, which `pnpm test`
  already does.
- **2026-11-23:** every agent job checks what its agent pushed for changes to `.github/`,
  `.claude/` or `CLAUDE.md` through one script from main, `.github/factory/protected-changes.sh`
  (pinned by `test-agent-guards.sh`): the build, the CI fixer, rework and the conflict resolver.
  It fails closed. Each job used to ask GitHub for the compare inline and read a failed request as
  "nothing changed", so a push went unchecked whenever GitHub didn't answer. Now a compare that
  fails, or that lists 300 files (its limit, so more may be unlisted), sends the pull request or
  ticket to a human. A renamed file counts by its old name too: the agents may run `git mv`, and
  the compare lists a file moved out of `.github/` only under its new name.
