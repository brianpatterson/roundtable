#!/usr/bin/env bash
# Sets the `factory` commit status on a pull request's commit (ADR-0063), so the pull request page
# shows whether the factory is still working on that commit or is done with it:
#
#   pending  the factory is working: reviewing, deciding on a rework, or reworking
#   success  the factory is done with this commit and it's the owner's turn; the description says
#            why (ready, changes asked on a pull request the factory doesn't rework, or needs-human)
#   error    a factory run stopped without finishing; the target links the run
#
# No `factory` status on the latest commit means the factory hasn't reached it yet: CI is running or
# failed, and the review comes only after green CI (ADR-0033).
#
#   factory-status.sh STATE DESCRIPTION   set STATE (pending | success | error) with DESCRIPTION
#   factory-status.sh --reviewed          the status after a review, from VERDICT (ready | changes),
#                                         MINOR (the number of minor findings) and the pull request's
#                                         labels: pending when the Rework workflow takes it from
#                                         here (ADR-0037, ADR-0053), which then sets its own
#
#   GITHUB_REPOSITORY  owner/name
#   SHA                the commit the status is on
#   PR                 the pull request (--reviewed only)
#   GITHUB_SERVER_URL, GITHUB_RUN_ID  the run the status links to, when set
#   GH                 overrides gh (tests)
#
# The status only reports: nothing waits on it, so a failure to set it is a warning, never a failed
# job that would stop the workflow behind it.
set -euo pipefail

GH=${GH:-gh}
: "${GITHUB_REPOSITORY:?}" "${SHA:?}"

set_status() { # set_status <state> <description>
  local url=
  [ -z "${GITHUB_RUN_ID:-}" ] || url="${GITHUB_SERVER_URL:-https://github.com}/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"
  # GitHub rejects a description over 140 characters.
  local description=$2
  [ "${#description}" -le 140 ] || description="${description:0:137}..."
  "$GH" api -X POST "repos/$GITHUB_REPOSITORY/statuses/$SHA" -f context=factory -f state="$1" \
    -f description="$description" ${url:+-f target_url="$url"} >/dev/null ||
    echo "::warning::Couldn't set the factory status on ${SHA:0:7}."
}

if [ "${1:-}" = --reviewed ]; then
  : "${PR:?}" "${VERDICT:?}"
  minor=${MINOR:-0}
  labels=$("$GH" pr view "$PR" -R "$GITHUB_REPOSITORY" --json labels --jq '[.labels[].name]') || labels='[]'
  # Rework's own test (rework.yml): a factory pull request no human has taken over, with changes
  # asked or minor findings to fix.
  if jq -e 'any(. == "factory") and (any(. == "needs-human") | not)' <<<"$labels" >/dev/null &&
    { [ "$VERDICT" = changes ] || [ "$minor" -gt 0 ]; }; then
    set_status pending "Working: reviewed; deciding on a rework"
  elif [ "$VERDICT" = changes ]; then
    set_status success "Done: changes needed, your turn"
  elif [ "$minor" -gt 0 ]; then
    set_status success "Done: ready for you, with minor findings"
  else
    set_status success "Done: ready for you"
  fi
  exit 0
fi

case "${1:-}" in
  pending | success | error) set_status "$1" "${2:?a description}" ;;
  *)
    echo "usage: factory-status.sh pending|success|error DESCRIPTION, or --reviewed" >&2
    exit 2
    ;;
esac
