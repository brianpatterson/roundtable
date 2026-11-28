#!/usr/bin/env bash
# Asks the factory's Conductor why a Work item is where it is (ADR-0075): runs
# `node tools/conductor/main.ts why <n>` for this repository, with the token from `gh auth token`.
# It prints the Work item's state, action and reason, the facts they came from and its dispatch
# budget count, and writes nothing to GitHub. See tools/conductor/README.md.
#
#   scripts/factory-why.sh <n>    the Ticket's number, or its pull request's
#
#   GH, NODE   override gh and node (tests)
set -euo pipefail

GH=${GH:-gh}
NODE=${NODE:-node}

if [ "$#" -ne 1 ] || ! [[ $1 =~ ^[1-9][0-9]*$ ]]; then
  echo "usage: scripts/factory-why.sh <issue or pull request number>" >&2
  exit 2
fi

root=$(cd "$(dirname "$0")/.." && pwd)

# This repository, as gh sees the checkout's remote.
repository=$(cd "$root" && "$GH" repo view --json nameWithOwner --jq .nameWithOwner)
token=$("$GH" auth token)

GH_TOKEN=$token GITHUB_REPOSITORY=$repository exec "$NODE" "$root/tools/conductor/main.ts" why "$1"
