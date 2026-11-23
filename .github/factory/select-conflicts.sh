#!/usr/bin/env bash
# Which factory pull requests the conflict resolver merges main into (ADR-0058).
#
#   select-conflicts.sh [PR]   check that pull request, or every open one labeled `factory`
#
# Prints a JSON array, one {pr, sha, branch, attempt} per pull request to resolve: conflicting
# with main, and the factory's to try by `attempt.sh next conflict` (open, from this repository,
# labeled `factory`, not `needs-human`). Each gets two attempts against the same main commit: the
# resolver hands anything but a crash to a human itself, so the second is a crash's retry, and a
# third goes to a human there. A new main commit is a new conflict, with two attempts of its own.
# MAIN is the commit attempts count against (the current main if unset). Needs GH_TOKEN and GITHUB_REPOSITORY; GH overrides the gh
# binary and SLEEP the wait between mergeability checks (tests).
set -euo pipefail

GH=${GH:-gh}
SLEEP=${SLEEP:-15}
repo=${GITHUB_REPOSITORY:?}
main=${MAIN:-$("$GH" api "repos/$repo/commits/main" --jq .sha)}

if [ -n "${1:-}" ]; then
  numbers=$1
else
  numbers=$("$GH" pr list -R "$repo" --state open --label factory --limit 100 --json number --jq '.[].number')
fi

for pr in $numbers; do
  # GitHub works out mergeability after main moves, in the background: UNKNOWN until it has.
  for _ in 1 2 3 4 5 6 7 8; do
    info=$("$GH" pr view "$pr" -R "$repo" --json state,mergeable,headRefOid,headRefName,isCrossRepository,labels)
    [ "$(jq -r .mergeable <<<"$info")" != UNKNOWN ] && break
    sleep "$SLEEP"
  done

  # Only a conflict is the resolver's; attempt.sh decides whether it's the factory's to try, and
  # which attempt this is.
  if [ "$(jq -r .mergeable <<<"$info")" != CONFLICTING ]; then
    echo "#$pr doesn't conflict with main ($(jq -r .mergeable <<<"$info"))." >&2
    continue
  fi
  attempt=$(MAIN=$main GH=$GH "$(dirname "$0")/attempt.sh" next conflict "$pr")
  case "$attempt" in [0-9]*) ;; *) continue ;; esac

  jq -c --argjson pr "$pr" --argjson attempt "$attempt" \
    '{pr: $pr, sha: .headRefOid, branch: .headRefName, attempt: $attempt}' <<<"$info"
done | jq -sc .
