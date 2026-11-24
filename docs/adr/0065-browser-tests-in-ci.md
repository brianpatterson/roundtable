# 0065. Run Playwright browser tests in CI against the built app and the real API

- **Status:** Accepted
- **Date:** 2026-11-23

## Context

The reviewer's "Check by hand" list is the owner's remaining manual work on most pull requests
(roadmap, Phase 3 step 9): does focus come back after a dialog closes, does the page fit a phone,
is the dark theme readable, would a screen reader find the controls. Component tests under jsdom
([ADR-0024](0024-design-system.md)) can't answer these. jsdom has no layout, no real focus model
for portals, no rendering to look at, and no computed contrast.

The staging environment is deferred until there are users (roadmap, Phase 3 step 4). The checks
are needed on each pull request, before merge, which staging wouldn't cover anyway. They also
must not need production secrets: the factory's agents will write and run them.

## Options considered

1. **Playwright against the built app, in its own CI job.** `vite build` and `vite preview` serve
   the production bundle. The real API runs on CI's Postgres with test values, and emails go to
   its log. Pros: real Chromium, real auth flow, no secrets, runs on every PR. Cons: a second
   Postgres job, about two more minutes of CI. `vite preview` doesn't set Caddy's headers, so a
   Content Security Policy break isn't caught.
2. **Playwright against the production Compose stack** (Caddy included). Pros: Caddy's headers
   too, so CSP breaks are caught. Cons: builds both images first, slower and harder to debug, and
   needs a local TLS story.
3. **Vitest browser mode** for components. Pros: same runner as today's tests. Cons: tests
   components in isolation, not pages, the API or the sign-in flow. It still needs Playwright
   underneath.
4. **Wait for staging** and test there after each merge. Cons: too late (after merge), deferred
   indefinitely, and it would need staging credentials.

## Decision

Option 1. The tests live in `apps/web/e2e/` and run with `pnpm --filter @roundtable/web test:browser`
and in CI's `browser` job.

- The API is started by `apps/api/test/browser-server.ts`. It drops and recreates a database of
  its own, `app_browser`, on the same Postgres server as `app_test`, and refuses to reset any
  other. Then it migrates and runs the production entry point. The ports (3101 and 4173) differ
  from `pnpm dev`'s, so the tests run beside it.
- A `setup` project signs up through the real form, reads the confirmation link from the API's
  log, follows it, and saves the session for the other tests.
- Two projects: `desktop` (Desktop Chrome) and `phone` (Pixel 7, also Chromium, so CI installs
  one browser).
- Tests use three helpers from `e2e/support.ts`. `expectAccessible` fails on any WCAG 2.2 A/AA
  violation axe finds, in the light and the dark theme, after animations settle. `screenshotThemes` saves full-page screenshots
  in light and dark themes. `confirmationLink` reads the emailed link.
- Screenshots are not compared to baselines. They go to the `browser-tests` artifact (with the
  HTML report, traces of failures and the API log) for a person or the reviewer to look at.

## Consequences

- Focus, keyboard, layout at two widths, both themes and automated accessibility are now
  checkable on every PR, with no secrets and no new production access.
- A second Postgres-backed CI job, about two minutes, in parallel with `check`.
- Until the factory's part lands, the CI fixer can't run these tests (no Chromium in its job), so
  a factory PR that breaks the `browser` job will likely end `needs-human`.
- CSP and other Caddy headers are still untested. Option 2 is the upgrade if that bites.
- Next (a separate change): the implementer writes browser tests for UI changes, its job
  installs Chromium before the agent runs (`node_modules` is read-only there, ADR-0050), and the
  reviewer reads the screenshot artifact so "Check by hand" lists only what a test can't check.
  After that, visual regression against stored baselines.
- Revisit if the suite grows past a few minutes (shard it, or run per-PR only the specs a
  change touches), or if flakiness forces retries above one.
