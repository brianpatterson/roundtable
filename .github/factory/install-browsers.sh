#!/usr/bin/env bash
# Installs Chromium and its system libraries for the browser tests an agent writes and runs
# (ADR-0065, ADR-0066), before the agent starts. Run from the checkout, after `pnpm install`:
#   "$RUNNER_TEMP/install-browsers.sh"
#
# The checkout is often a pull request's branch, and installing needs sudo, outside the agent's
# sandbox, in a job that can mint tokens. So no code from the branch runs here, its dependencies
# included: the branch only says which Playwright version it installed (a string, checked), and
# the official `playwright` package of that version, from npm, installs the browser build that
# version pins. Run from main (copied to $RUNNER_TEMP), so a branch can't change this either.
#
# Never fails the job: without Chromium the agent can't run the browser tests, but CI still does.
set -euo pipefail

npx=${NPX:-npx}
manifest=apps/web/node_modules/@playwright/test/package.json

if [ ! -f "$manifest" ]; then
  echo "::notice::No Playwright in apps/web on this branch; skipping the browser install."
  exit 0
fi

version=$(jq -r '.version // ""' "$manifest" 2>/dev/null || true)

if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "::warning::Playwright's version on this branch isn't a plain release; skipping the browser install."
  exit 0
fi

# Outside the checkout, so the branch's .npmrc and workspace settings don't apply.
cd "${RUNNER_TEMP:-/tmp}"

for attempt in 1 2 3; do
  if "$npx" --yes "playwright@$version" install --with-deps chromium; then
    echo "Chromium installed for Playwright $version."
    exit 0
  fi
  echo "::warning::Installing Chromium failed (attempt $attempt of 3)."
  [ "$attempt" = 3 ] || sleep "${RETRY_DELAY:-10}"
done

echo "::warning::Couldn't install Chromium: the agent can't run the browser tests (CI still does)."
