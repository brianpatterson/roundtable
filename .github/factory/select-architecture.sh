#!/usr/bin/env bash
# Decides whether the architecture review runs (ADR-0067):
#
#   select-architecture.sh <sha>
#
# It runs unless a review already succeeded on <sha>, the commit of main it would review. The
# Monday backstop then costs nothing in a week whose last batch was already reviewed, and a batch
# whose last two tickets close together is reviewed once. Prints why, and writes `run=true` to
# $GITHUB_OUTPUT when it runs.
#
# Holds no secrets and runs no agent. GH overrides the gh binary (tests).
set -euo pipefail

GH=${GH:-gh}
sha=${1:?usage: select-architecture.sh <sha>}
repo=${GITHUB_REPOSITORY:?}

done_on=$("$GH" run list -R "$repo" --workflow architecture.yml --status success --limit 100 \
  --json headSha,url --jq "[.[] | select(.headSha == \"$sha\") | .url] | first // empty")
if [ -n "$done_on" ]; then
  echo "Main hasn't changed since the last architecture review ($done_on): nothing new to review."
  exit 0
fi

echo "No architecture review has run on ${sha:0:7} yet."
echo "run=true" >>"${GITHUB_OUTPUT:-/dev/null}"
