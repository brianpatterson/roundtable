#!/usr/bin/env bash
# Which factory pull requests the conflict resolver merges main into (ADR-0058).
#
#   select-conflicts.sh [PR]   check that pull request, or every open one labeled `factory`
#
# Prints a JSON array, one {pr, sha, branch, attempt} per pull request to resolve: open, from this
# repository, labeled `factory`, not `needs-human`, and conflicting with main. Each gets two
# attempts against the same main commit: the resolver hands anything but a crash to a human
# itself, so the second is a crash's retry, and a third goes to a human here. A new main commit is
# a new conflict, with two attempts of its own. MAIN is the commit attempts count
# against (the current main if unset). Needs GH_TOKEN and GITHUB_REPOSITORY; GH overrides the gh
# binary and SLEEP the wait between mergeability checks (tests).
set -euo pipefail

GH=${GH:-gh}
SLEEP=${SLEEP:-15}
repo=${GITHUB_REPOSITORY:?}
marker='<!-- factory-conflict -->'
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

  skip=$(jq -r '
    if .state != "OPEN" then "isn'"'"'t open"
    elif .isCrossRepository then "is from a fork"
    elif ([.labels[].name] | index("factory")) == null then "isn'"'"'t a factory pull request"
    elif ([.labels[].name] | index("needs-human")) != null then "is waiting for a human"
    elif .mergeable != "CONFLICTING" then "doesn'"'"'t conflict with main (\(.mergeable))"
    else empty end' <<<"$info")
  if [ -n "$skip" ]; then
    echo "#$pr $skip." >&2
    continue
  fi

  # The resolver's comment names the main commit it merged (resolve-conflicts.yml).
  attempts=$("$GH" api "repos/$repo/issues/$pr/comments" --paginate \
    --jq "[.[] | select(.user.login == \"github-actions[bot]\" and (.body | startswith(\"$marker\")) and (.body | contains(\"$main\")))] | length" |
    jq -s add)

  if [ "${attempts:-0}" -ge 2 ]; then
    echo "#$pr still conflicts after two attempts against main at ${main:0:7}." >&2
    "$GH" pr edit "$pr" -R "$repo" --add-label needs-human >&2
    "$GH" pr comment "$pr" -R "$repo" --body "The factory tried twice to resolve this pull request's conflict with main (at $main) and it still conflicts. Over to you: merge main into the branch and resolve it. To hand it back, remove \`needs-human\`; it tries again when main moves. ADR-0058." >&2
    continue
  fi

  jq -c --argjson pr "$pr" --argjson attempt "$((${attempts:-0} + 1))" \
    '{pr: $pr, sha: .headRefOid, branch: .headRefName, attempt: $attempt}' <<<"$info"
done | jq -sc .
