#!/usr/bin/env bash
# Finds the `architecture` issue that already covers a Strong candidate (ADR-0067):
#
#   find-architecture-issue.sh <title>
#
# Prints the number of an issue with exactly <title> that is open or was closed in the last 30
# days, or nothing. The weekly and per-batch reviews can both find the same candidate; the
# workflow opens an issue only when this prints nothing. GitHub's title search is fuzzy, so the
# exact match is checked here.
#
# Holds no secrets and runs no agent. GH overrides the gh binary (tests).
set -euo pipefail

GH=${GH:-gh}
title=${1:?usage: find-architecture-issue.sh <title>}
repo=${GITHUB_REPOSITORY:?}

"$GH" issue list -R "$repo" --label architecture --state all --search "\"$title\" in:title" \
  --limit 20 --json number,title,state,closedAt |
  jq -r --arg title "$title" '[.[] | select(.title == $title)
    | select(.state == "OPEN" or ((.closedAt | fromdateiso8601) > now - 30 * 86400))
    | .number] | first // empty'
