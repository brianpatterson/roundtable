#!/usr/bin/env bash
# After an agent run (ADR-0029): the agent posts its own comments and pull request descriptions,
# so they're checked after the fact. A comment that looks like it holds a credential is deleted, a
# description is replaced, and the step fails so the owner rotates the credential. Used by the
# implement and build jobs in factory.yml, copied from main before the agent runs.
#
#   GH_TOKEN, GITHUB_REPOSITORY   from Actions
#   NUMBER   the issue or pull request whose claude[bot] comments to check
#   PRS      pull request numbers whose descriptions to check, space-separated (may be empty)
#   GUARD    guard-secrets.sh (default: next to this script)
#   GH       overrides gh (tests)
set -euo pipefail

GH=${GH:-gh}
GUARD=${GUARD:-$(cd "$(dirname "$0")" && pwd)/guard-secrets.sh}
repo=${GITHUB_REPOSITORY:?}
leaked=0

for id in $("$GH" api "repos/$repo/issues/${NUMBER:?}/comments" --paginate --jq '.[] | select(.user.login == "claude[bot]") | .id'); do
  if ! "$GH" api "repos/$repo/issues/comments/$id" --jq .body | "$GUARD"; then
    "$GH" api -X DELETE "repos/$repo/issues/comments/$id" >/dev/null
    leaked=1
  fi
done

# shellcheck disable=SC2086 # PRS is a space-separated list
for pr in $(printf '%s\n' ${PRS:-} | sort -u); do
  if ! "$GH" pr view "$pr" -R "$repo" --json body --jq .body | "$GUARD"; then
    "$GH" pr edit "$pr" -R "$repo" --body "The description was removed because it matched a credential pattern (ADR-0029)." >/dev/null
    leaked=1
  fi
done

[ "$leaked" = 0 ] || { echo "::error::The agent published something that looks like a credential. It was taken down; rotate the credential."; exit 1; }
