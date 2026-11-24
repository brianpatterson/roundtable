# 0066. The factory writes browser tests, and the reviewer reads their screenshots

- **Status:** Accepted
- **Date:** 2026-11-24

## Context

[ADR-0065](0065-browser-tests-in-ci.md) added Playwright tests in CI: keyboard and focus, an axe
scan in both themes, and screenshots at desktop and phone sizes. Two things were left for the
factory:

- **Its agents can't run them.** The implementer, Rework, the CI fixer and the conflict
  resolver have no Chromium. Inside Claude Code's sandbox they can't install it either: `pnpm
exec` is refused, the system libraries need `sudo`, and `node_modules` is read-only
  ([ADR-0050](0050-factory-adds-no-dependencies.md)). So a UI ticket would ship without browser
  tests, and a factory PR that broke the `browser` job would end `needs-human`.
- **The reviewer can't see the screenshots,** so its "Check by hand" list still asks the owner
  to look at layouts and themes.

Installing the browser happens before the agent starts, with `sudo`, in jobs that can mint
tokens. The checkout is often a pull request's branch. Until now, no code from a branch, its
dependencies included, ran outside the agent's sandbox in those jobs: `pnpm install` runs no
install scripts but esbuild's.

## Options considered

1. **Run the branch's Playwright to install Chromium** (`pnpm exec playwright install
--with-deps`), in a step or a local composite action. Pros: simplest. Cons: a branch's
   lockfile decides what code runs with `sudo` and the job's token environment. Worse, a local
   action is loaded from the workspace, which is the branch by then, as the step itself may be.
2. **Main's script installs the official package of the branch's version.**
   `.github/factory/install-browsers.sh`, copied from main like the other guards, reads only
   `@playwright/test`'s version from the branch, a string checked against `X.Y.Z`. Then, outside
   the checkout, it runs `npx playwright@X.Y.Z install --with-deps chromium`. Pros: the browser
   build matches the branch, and only npm's official package runs with `sudo`. Cons: a second
   copy of Playwright downloads (seconds), and no cache (ADR-0030).
3. **The agent installs Chromium itself** through a package script. Pros: no new workflow step.
   Cons: no system libraries without `sudo`, it spends a turn every run, and a package script is
   on the branch, so the agent could change what it runs.
4. **Leave browser tests to the owner.** Cons: UI tickets keep a manual check, the opposite of
   the roadmap's step 9.

For the reviewer: download the CI run's `browser-tests` artifact, or have the reviewer run the
tests. The reviewer runs no code on purpose (ADR-0026), so it downloads.

## Decision

Option 2, before the agent starts, in `implement`, `build`, `fix-ci`, Rework and the conflict
resolver. The script never fails the job: without Chromium, CI still runs the tests.
`test-install-browsers.sh` checks it, and checks that every agent job allowed to run the web
app's tests installs Chromium. The security auditor is exempt: it writes tests only in the API.

The implementer writes a Playwright test for each user-visible behavior a change adds, keyboard
and focus included, and passes each new page or dialog to `expectAccessible` and
`screenshotThemes` (`implementer.md`, "Browser tests"). The CI fixer runs them to debug a failed
`browser` job.

The reviewer's `select` job records the CI run that passed on the commit. The review job
downloads that run's `browser-tests` artifact and copies only the PNGs with plain
`<project>/<name>.png` names into `./screenshots/`. The reviewer looks at them with Read,
checks that UI changes come with browser tests, and leaves out of "Check by hand" what the
tests and screenshots already cover (`reviewer.md`, item 7).

## Consequences

- UI tickets come with browser tests and screenshots, and the owner's manual check shrinks to
  what neither covers: hover, animation, a real screen reader, other browsers.
- One exception to the browser build matching the branch: an owner's `@claude` follow-up
  (`implement`) installs dependencies and Chromium from `main`, then the agent switches to the pull
  request's branch. On a branch that changes Playwright's version (a Dependabot bump), Chromium
  won't launch for the agent, which then says so and relies on CI.
- The `browser-tests` artifact holds only `screenshots/` and `report/`: artifacts are public in
  this repository, and the rest of `apps/web/test-results/` holds the test user's session cookie
  and the test API's log. A failed test's trace, kept in the report for debugging, still records
  that cookie in its network requests. It belongs to a throwaway user on a server that's gone when
  the job ends.
- Each agent job spends about 30 to 60 seconds installing Chromium, every run, UI change or not.
- The reviewer reads images made by the pull request's code. Text in them is data, like the
  code (`reviewer.md`). Only PNGs are copied, never the HTML report or the test API's log.
- Not verified until a factory run uses it: that Chromium starts inside Claude Code's bubblewrap
  sandbox, and that the sandbox lets the tests' servers bind ports 3101 and 4173. Playwright
  starts Chromium with `--no-sandbox` and `--disable-dev-shm-usage` by default, so neither should
  need more than the API tests do. If it fails, the implementer says so in its PR and CI runs the
  tests (`implementer.md`).
- An incidental fix in the same change: ADR-0065's artifact uploaded nothing, because
  `upload-artifact` skips hidden folders and the output was `apps/web/e2e/.output/`. It's
  `apps/web/test-results/` now.
- Revisit for visual regression (screenshots compared to stored baselines), once enough UI
  tickets have screenshots to show which pages change.
