#!/usr/bin/env bash
# Decides whether the architecture review runs (ADR-0067):
#
#   select-architecture.sh <event> <sha> [spec]
#
# <event> is what started the run (`schedule` or `workflow_dispatch`), <sha> the commit of main it
# would review, and [spec] the spec whose batch closed, when Retro started it.
#
# A dispatch by hand (no spec) always runs. Otherwise it runs unless a review already succeeded on
# <sha>: the Monday backstop then costs nothing in a week whose last batch was already reviewed,
# and a batch whose last two tickets close together is reviewed once. Prints why, and writes
# `run=true` to $GITHUB_OUTPUT when it runs. A spec that isn't an issue number fails: it goes into
# the agent's prompt.
#
# Holds no secrets and runs no agent. GH overrides the gh binary (tests).
set -euo pipefail

GH=${GH:-gh}
event=${1:?usage: select-architecture.sh <event> <sha> [spec]}
sha=${2:?usage: select-architecture.sh <event> <sha> [spec]}
spec=${3:-}
repo=${GITHUB_REPOSITORY:?}

run() {
  echo "$1"
  echo "run=true" >>"${GITHUB_OUTPUT:-/dev/null}"
  exit 0
}

[[ "$spec" =~ ^[0-9]*$ ]] || { echo "::error::spec must be an issue number, got [$spec]." >&2; exit 1; }

if [ "$event" = workflow_dispatch ] && [ -z "$spec" ]; then
  run "Started by hand: the review runs."
fi

done_on=$("$GH" run list -R "$repo" --workflow architecture.yml --status success --limit 100 \
  --json headSha,url --jq "[.[] | select(.headSha == \"$sha\") | .url] | first // empty")
if [ -n "$done_on" ]; then
  echo "Main hasn't changed since the last architecture review ($done_on): nothing new to review."
  exit 0
fi

run "No architecture review has run on ${sha:0:7} yet."
