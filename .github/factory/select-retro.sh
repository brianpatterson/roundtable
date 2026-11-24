#!/usr/bin/env bash
# Decides whether a batch of factory tickets is ready for its retrospective (ADR-0064). A batch is
# a spec's parent issue and the tickets that are its sub-issues (docs/agents/issue-tracker.md).
#
#   select-retro.sh --issue N    N just closed: is its parent's batch done?
#   select-retro.sh --parent P   by hand, for P (also when P is already closed: a backfill)
#
# Ready when every sub-issue is closed, the factory built at least one of them (a merged pull
# request from a claude/issue-<n>- branch closed it), and no `retro` issue covers the parent yet.
# Through --issue the parent must also still be open. Prints why, and writes `parent=<P>` to
# $GITHUB_OUTPUT when ready.
#
# A parent labeled `retro` is a retrospective whose findings were filed as its sub-issues, not a
# batch: it never gets a retrospective of its own. Through --issue, once the last of its findings
# closes, it writes `close=<P>` instead, and the workflow closes it.
#
# Holds no secrets and runs no agent. GH overrides the gh binary (tests).
set -euo pipefail

GH=${GH:-gh}
repo=${GITHUB_REPOSITORY:?}
owner=${repo%/*}
name=${repo#*/}

say() { echo "$*"; }
ready() {
  say "Batch #$1 is ready for its retrospective."
  echo "parent=$1" >>"${GITHUB_OUTPUT:-/dev/null}"
  exit 0
}

case "${1:-}" in
  --issue)
    issue=${2:?}
    by_hand=false
    # shellcheck disable=SC2016 # GraphQL variables, not shell
    parent=$("$GH" api graphql -F owner="$owner" -F name="$name" -F number="$issue" -f query='
      query($owner: String!, $name: String!, $number: Int!) {
        repository(owner: $owner, name: $name) { issue(number: $number) { parent { number } } }
      }' --jq '.data.repository.issue.parent.number // empty')
    [ -n "$parent" ] || { say "#$issue has no parent issue, so it's in no batch."; exit 0; }
    ;;
  --parent)
    parent=${2:?}
    by_hand=true
    ;;
  *)
    echo "usage: select-retro.sh --issue N | --parent P" >&2
    exit 2
    ;;
esac

# shellcheck disable=SC2016 # GraphQL variables, not shell
batch=$("$GH" api graphql -F owner="$owner" -F name="$name" -F number="$parent" -f query='
  query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      issue(number: $number) {
        state
        labels(first: 20) { nodes { name } }
        subIssues(first: 100) {
          totalCount
          nodes {
            number
            state
            closedByPullRequestsReferences(first: 10, includeClosedPrs: true) { nodes { merged headRefName } }
          }
        }
      }
    }
  }' --jq '.data.repository.issue')

if jq -e 'any(.labels.nodes[]; .name == "retro")' <<<"$batch" >/dev/null; then
  [ "$by_hand" = false ] || { say "#$parent is a retrospective, not a spec: it gets no retrospective of its own."; exit 0; }
  [ "$(jq -r .state <<<"$batch")" = OPEN ] || { say "Retrospective #$parent is already closed."; exit 0; }
  jq -e '.subIssues.totalCount <= (.subIssues.nodes | length)' <<<"$batch" >/dev/null ||
    { say "Retrospective #$parent has more than 100 findings: close it by hand."; exit 0; }
  open=$(jq -r '[.subIssues.nodes[] | select(.state != "CLOSED") | "#\(.number)"] | join(", ")' <<<"$batch")
  [ -z "$open" ] || { say "Retrospective #$parent still has open findings: $open."; exit 0; }
  say "Every finding of retrospective #$parent is closed."
  echo "close=$parent" >>"${GITHUB_OUTPUT:-/dev/null}"
  exit 0
fi

# Prints a reason not to run, or nothing.
why_not=$(jq -r --argjson by_hand "$by_hand" '
  [.subIssues.nodes[] | select(.state != "CLOSED") | "#\(.number)"] as $open
  | [.subIssues.nodes[] | select(.number as $n | any(.closedByPullRequestsReferences.nodes[];
      .merged and (.headRefName | startswith("claude/issue-\($n)-"))))] as $built
  | if .state != "OPEN" and ($by_hand | not) then "it is already closed"
    elif .subIssues.totalCount == 0 then "it has no sub-issues"
    elif .subIssues.totalCount > (.subIssues.nodes | length) then "it has more than 100 sub-issues"
    elif ($open | length) > 0 then "\($open | join(", ")) still open"
    elif ($built | length) == 0 then "the factory built none of its tickets"
    else empty end
' <<<"$batch")
[ -z "$why_not" ] || { say "No retrospective for #$parent yet: $why_not."; exit 0; }

existing=$("$GH" issue list -R "$repo" --label retro --state all --limit 500 --json number,body \
  --jq "[.[] | select(.body | contains(\"<!-- retro-of-#$parent -->\")) | .number] | first // empty")
[ -z "$existing" ] || { say "#$existing is already the retrospective of #$parent."; exit 0; }

ready "$parent"
