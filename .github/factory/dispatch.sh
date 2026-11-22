#!/usr/bin/env bash
# The factory's dispatcher (ADR-0047): decides which `ready` ticket the implementer builds, and
# when. A ticket waits until every issue blocking it (GitHub's issue dependencies) is merged and
# deployed, and the factory builds one ticket at a time: a ticket labeled `building` is in flight
# until what closed it is deployed. Only a `ready` label the owner added counts, and a ticket whose
# description someone else edited after that label goes back to the owner.
#
#   dispatch.sh --decide        read one ticket's state as JSON on stdin, print the decision (tests)
#   dispatch.sh --state ISSUE   print the state decide would get for ISSUE (read-only, for debugging)
#   dispatch.sh --gate ISSUE    the owner just labeled ISSUE `ready`: decide for it alone, and write
#                               start=true to $GITHUB_OUTPUT if the implementer should build it now
#   dispatch.sh                 sweep: release tickets whose work is deployed, then decide for every
#                               `ready` ticket, oldest label first
#
# Holds no secrets and runs no agent. DRY_RUN=true prints what it would do and changes nothing.
# GH overrides the gh binary (tests).
set -euo pipefail

GH=${GH:-gh}

# The decision, from a state gather() builds (ages in minutes):
#   {open, closed: null | deployed | merged | unmerged, ready: null | {by_owner, age},
#    edited_after_ready, held, building: null | {age, has_pr},
#    blockers: [{number, open, closed}], others_building: [number]}
# `closed` is what closed an issue: a pull request or commit whose merge commit the latest
# successful deploy includes (deployed) or doesn't yet (merged), or nothing (unmerged: closed by
# hand, as not planned or done elsewhere). `held` is a needs-human or needs-info label.
# Prints {action: ignore | ok | release | unlabel | human | wait | queue | start, reason}.
# shellcheck disable=SC2016 # backticks are Markdown
decide='
  def out($a; $r): {action: $a, reason: $r};
  def refs: map("#\(.)") | join(", ");
  if .open != true then
    if .building == null then out("ignore"; "closed")
    elif .closed == "merged" then out("ok"; "merged, and in flight until it is deployed")
    else out("release"; "closed, and nothing of it is left to deploy") end
  elif .held then out("ignore"; "waiting for the owner")
  elif .building != null then
    if .building.has_pr or .building.age <= 90 then out("ok"; "being built")
    else out("human"; "the factory started building it \(.building.age) minutes ago and no open pull request closes it") end
  elif .ready == null or .ready.by_owner != true then out("ignore"; "not labeled `ready` by the owner")
  elif .edited_after_ready then
    out("unlabel"; "its description was edited by someone else after it was labeled `ready`. Reread it, and label it `ready` again if it should still be built")
  elif any(.blockers[]; .open != true and .closed == "unmerged") then
    out("human"; "\([.blockers[] | select(.open != true and .closed == "unmerged") | .number] | refs) closed without a merged pull request, so the plan may have changed. Remove that dependency if this should still be built")
  elif any(.blockers[]; .open or .closed == "merged") then
    out("wait"; "it is blocked by \([.blockers[] | select(.open or .closed == "merged") | .number] | refs), until each is merged and deployed")
  elif (.others_building | length) > 0 then
    out("queue"; "the factory builds one ticket at a time, and \(.others_building | refs) is in flight until it is deployed")
  else out("start"; "nothing blocks it") end'

if [ "${1:-}" = --decide ]; then
  jq -c "$decide"
  exit 0
fi

: "${GITHUB_REPOSITORY:?}"
repo=$GITHUB_REPOSITORY
owner=${repo%%/*}
now=$(date -u +%s)
marker='<!-- factory-dispatch -->'

# The commit the latest successful Deploy shipped. A docs-only merge deploys nothing but still ends
# Deploy successfully, which is right: nothing of it is left to wait for.
deployed=$("$GH" run list -R "$repo" --workflow deploy.yml --status success --limit 1 \
  --json headSha --jq '.[0].headSha // empty')

# deployed | merged | unmerged, for the merge commit (or closing commit) of a closed issue.
closed_state() {
  [ -n "$1" ] || { echo unmerged; return; }
  [ -n "$deployed" ] || { echo merged; return; }
  case "$("$GH" api "repos/$repo/compare/$1...$deployed" --jq .status 2>/dev/null || true)" in
    ahead | identical) echo deployed ;;
    *) echo merged ;; # behind, diverged, or GitHub didn't answer: not deployed yet
  esac
}

# shellcheck disable=SC2016 # GraphQL variables
query='query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      number
      state
      labels(first: 50) { nodes { name } }
      userContentEdits(last: 20) { nodes { editedAt editor { login } } }
      timelineItems(itemTypes: [LABELED_EVENT, CLOSED_EVENT], last: 100) {
        nodes {
          __typename
          ... on LabeledEvent { createdAt label { name } actor { login } }
          ... on ClosedEvent { closer { __typename ... on PullRequest { merged mergeCommit { oid } } ... on Commit { oid } } }
        }
      }
      closedByPullRequestsReferences(first: 5, includeClosedPrs: false) { nodes { number } }
      blockedBy(first: 50) {
        nodes {
          number
          state
          timelineItems(itemTypes: [CLOSED_EVENT], last: 1) {
            nodes { ... on ClosedEvent { closer { __typename ... on PullRequest { merged mergeCommit { oid } } ... on Commit { oid } } } }
          }
        }
      }
    }
  }
}'

# One ticket's state for decide, without others_building. The commit that closed an issue: the
# merge commit of the pull request that closed it, or the commit itself.
gather() {
  local raw state
  raw=$("$GH" api graphql -F owner="$owner" -F name="${repo#*/}" -F number="$1" -f query="$query")
  state=$(jq -c --arg owner "$owner" --argjson now "$now" '
    def age($t): (($now - ($t | fromdateiso8601)) / 60 | floor);
    def sha: [.nodes[] | .closer? // empty | if .__typename == "PullRequest" then (if .merged then .mergeCommit.oid else empty end) else .oid end] | last // "";
    .data.repository.issue as $i
    | [$i.labels.nodes[].name] as $labels
    | [$i.timelineItems.nodes[] | select(.__typename == "LabeledEvent")] as $labeled
    | ([$labeled[] | select(.label.name == "ready")] | last) as $ready
    | ([$labeled[] | select(.label.name == "building")] | last) as $building
    | {number: $i.number, open: ($i.state == "OPEN"), sha: ($i.timelineItems | sha),
       ready: (if ($labels | index("ready")) != null and $ready != null
               then {by_owner: ($ready.actor.login == $owner), at: $ready.createdAt, age: age($ready.createdAt)} else null end),
       edited_after_ready: ($ready != null and any($i.userContentEdits.nodes[]; .editedAt > $ready.createdAt and (.editor.login // "") != $owner)),
       held: (($labels | index("needs-human")) != null or ($labels | index("needs-info")) != null),
       building: (if ($labels | index("building")) != null
                  then {age: (if $building != null then age($building.createdAt) else 0 end), has_pr: ($i.closedByPullRequestsReferences.nodes | length > 0)} else null end),
       blockers: [$i.blockedBy.nodes[] | {number, open: (.state == "OPEN"), sha: (.timelineItems | sha)}]}
  ' <<<"$raw")

  local closed=null
  if [ "$(jq -r .open <<<"$state")" = false ]; then
    closed="\"$(closed_state "$(jq -r .sha <<<"$state")")\""
  fi
  local blockers='[]' blocker
  while read -r blocker; do
    [ -n "$blocker" ] || continue
    local b_closed=null
    if [ "$(jq -r .open <<<"$blocker")" = false ]; then
      b_closed="\"$(closed_state "$(jq -r .sha <<<"$blocker")")\""
    fi
    blockers=$(jq -c --argjson b "$blocker" --argjson c "$b_closed" '. + [{number: $b.number, open: $b.open, closed: $c}]' <<<"$blockers")
  done < <(jq -c '.blockers[]' <<<"$state")
  jq -c --argjson closed "$closed" --argjson blockers "$blockers" '.closed = $closed | .blockers = $blockers | del(.sha)' <<<"$state"
}

# Posts a comment that starts with the marker, unless the dispatcher's latest comment on the issue
# already says the same: a ticket that waits for days gets told once, not every half hour.
say() { # say <issue> <text> [always]
  local body latest
  body=$(printf '%s\n%s' "$marker" "$2")
  if [ "${3:-}" != always ]; then
    latest=$("$GH" api "repos/$repo/issues/$1/comments" --paginate \
      --jq ".[] | select(.user.login == \"github-actions[bot]\" and (.body | startswith(\"$marker\"))) | .body | @json" | tail -1)
    [ -z "$latest" ] || [ "$(jq -r . <<<"$latest")" != "$body" ] || return 0
  fi
  "$GH" issue comment "$1" -R "$repo" --body "$body" >/dev/null
}

# Acts on one decision. mode is gate or sweep.
act() { # act <mode> <issue> <decision JSON>
  local action reason
  action=$(jq -r .action <<<"$3")
  reason=$(jq -r .reason <<<"$3")
  echo "#$2: $action ($reason)"
  [ "${DRY_RUN:-}" != true ] || return 0
  local always=
  [ "$1" != gate ] || always=always
  case "$action" in
    release) "$GH" issue edit "$2" -R "$repo" --remove-label building >/dev/null ;;
    unlabel)
      "$GH" issue edit "$2" -R "$repo" --remove-label ready >/dev/null
      say "$2" "The factory won't build this: $reason. ADR-0047." always
      ;;
    human)
      "$GH" issue edit "$2" -R "$repo" --add-label needs-human >/dev/null
      say "$2" "The factory stopped on this ticket: $reason. Over to you; remove \`needs-human\` to hand it back. ADR-0047." always
      ;;
    wait | queue) say "$2" "The factory will build this later: $reason. It says here when it starts. ADR-0047." $always ;;
    start)
      if [ "$1" = gate ]; then
        "$GH" issue edit "$2" -R "$repo" --add-label building >/dev/null
        [ -z "${GITHUB_OUTPUT:-}" ] || echo "start=true" >>"$GITHUB_OUTPUT"
      else
        # Starting it from here needs the implementer to accept a dispatch (ADR-0047's second
        # step). Until then, hand the start to the owner, once.
        say "$2" "Nothing blocks this any more and nothing else is in flight. Remove \`ready\` and add it again to have the factory build it now. ADR-0047."
      fi
      ;;
  esac
}

if [ "${1:-}" = --state ]; then
  gather "$2"
  exit 0
fi

# Tickets in flight: labeled `building`, open or merged but not yet deployed. Releases the rest.
in_flight='[]'
while read -r number; do
  [ -n "$number" ] || continue
  state=$(gather "$number" | jq -c '.others_building = []')
  decision=$(jq -c "$decide" <<<"$state")
  case "$(jq -r .action <<<"$decision")" in
    release) act sweep "$number" "$decision" ;;
    *)
      in_flight=$(jq -c --argjson n "$number" '. + [$n]' <<<"$in_flight")
      # Open and building may be stuck (no pull request long after it started); the rest only report.
      if [ "$(jq -r .action <<<"$decision")" = human ]; then
        act sweep "$number" "$decision"
      else
        echo "#$number: $(jq -r '"\(.action) (\(.reason))"' <<<"$decision")"
      fi
      ;;
  esac
done < <("$GH" issue list -R "$repo" --label building --state all --limit 100 --json number --jq '.[].number')

if [ "${1:-}" = --gate ]; then
  number=$2
  state=$(gather "$number" | jq -c --argjson f "$in_flight" --argjson n "$number" '.others_building = ($f - [$n])')
  act gate "$number" "$(jq -c "$decide" <<<"$state")"
  exit 0
fi

# Every ready ticket, oldest `ready` label first; once one may start, the rest queue behind it.
states=()
while read -r number; do
  [ -n "$number" ] || continue
  states+=("$(gather "$number")")
done < <("$GH" issue list -R "$repo" --label ready --state open --limit 100 --json number --jq '.[].number')
[ "${#states[@]}" -gt 0 ] || exit 0
while read -r state; do
  number=$(jq -r .number <<<"$state")
  decision=$(jq -c --argjson f "$in_flight" '.others_building = ($f - [.number])' <<<"$state" | jq -c "$decide")
  act sweep "$number" "$decision"
  [ "$(jq -r .action <<<"$decision")" != start ] || in_flight=$(jq -c --argjson n "$number" '. + [$n]' <<<"$in_flight")
done < <(printf '%s\n' "${states[@]}" | jq -sc 'sort_by(.ready.at // "") | .[]')
