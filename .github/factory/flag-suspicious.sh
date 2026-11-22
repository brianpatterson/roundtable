#!/usr/bin/env bash
# When report-denials.sh found the agent reaching for credentials or the factory's own rules
# (ADR-0029): labels the issue or pull request `needs-human`, says why, and fails the step. Used by
# every agent job in factory.yml, copied from main before the agent runs.
#
#   GH_TOKEN, GITHUB_REPOSITORY, GITHUB_SERVER_URL, GITHUB_RUN_ID   from Actions
#   NUMBER   the issue or pull request the run was for
#   GH       overrides gh (tests)
set -euo pipefail

GH=${GH:-gh}
: "${NUMBER:?}" "${GITHUB_REPOSITORY:?}"
"$GH" issue edit "$NUMBER" -R "$GITHUB_REPOSITORY" --add-label needs-human
"$GH" issue comment "$NUMBER" -R "$GITHUB_REPOSITORY" --body "The factory's agent tried tool calls that reach for credentials or the factory's own rules, and was refused. A human should read [the run]($GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID) (its summary lists the calls) before anything here is merged. ADR-0029."
exit 1
