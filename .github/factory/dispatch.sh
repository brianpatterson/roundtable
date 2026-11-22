#!/usr/bin/env bash
# The factory's dispatcher (ADR-0047): decides which `ready` ticket the implementer builds, and
# when. A ticket waits until every issue blocking it (GitHub's issue dependencies) is merged and
# deployed, and the factory builds one ticket at a time: a ticket labeled `building` is in flight
# until what closed it is deployed. Only a `ready` label the owner added counts, and a ticket whose
# description someone else edited after that label goes back to the owner.
#
#   dispatch.sh --decide        read one ticket's state as JSON on stdin, print the decision (tests)
#   dispatch.sh --state ISSUE   print the state decide would get for ISSUE (read-only, for debugging)
#   dispatch.sh --gate ISSUE    the owner just labeled ISSUE `ready`: decide for it alone, start it
#                               if it may start, and always say what happened
#   dispatch.sh --verify ISSUE  in a run the dispatcher started for ISSUE: check the same rules again
#                               before the agent runs, and write ok=true to $GITHUB_OUTPUT if they hold
#   dispatch.sh                 sweep: release tickets whose work is deployed, then decide for every
#                               `ready` ticket, oldest label first, and start the first that may start
#
# Holds no secrets and runs no agent. DRY_RUN=true prints what it would do and changes nothing.
# GH overrides the gh binary (tests).
set -euo pipefail

GH=${GH:-gh}

# The decision, from a state gather() builds (ages in minutes):
#   {open, closed: null | deployed | merged | unmerged, ready: null | {by_owner, age},
#    edited_after_ready, held: null | needs-human | needs-info, answered, building: null | {age, has_pr},
#    blockers: [{number, open, closed, active, held}], others_building: [number]}
# `closed` is what closed an issue: a pull request or commit whose merge commit the latest
# successful deploy includes (deployed) or doesn't yet (merged), or nothing (unmerged: closed by
# hand, as not planned or done elsewhere). `held` is the label a ticket waits on the owner under;
# `needs-info` stops holding it once the owner labels it `ready` again after it (`answered`), and
# a start then removes it. `edited_after_ready` counts title and description edits by anyone but
# the owner since the owner's approval began: the first `ready` label the owner added after the
# workflow last removed it. Removing and re-adding it themselves doesn't restart the approval, so an
# edit made in between still counts. A blocker is `active` when it's labeled `ready` or `building`,
# or an open pull request closes it, and `held` (needs-human | needs-info | null) when it waits on
# the owner. An open blocker that is neither (a tracking issue opened after its pull request merged,
# or a ticket nobody labeled) would be waited on forever, so the wait names it, and names a held one
# with what it waits on. Only direct blockers are checked: an active blocker that is itself blocked by
# an idle issue gets its own warning, on its own ticket, once it's labeled `ready`.
# Prints {action: ignore | ok | release | unlabel | human | stuck | wait | queue | start, reason}.
# shellcheck disable=SC2016 # backticks are Markdown
decide='
  def out($a; $r): {action: $a, reason: $r};
  def refs: map("#\(.)") | join(", ");
  if .open != true then
    if .building == null then out("ignore"; "closed")
    elif .closed == "merged" then out("ok"; "merged, and in flight until it is deployed")
    else out("release"; "closed, and nothing of it is left to deploy") end
  elif .held == "needs-human" then out("ignore"; "it is labeled `needs-human`. Remove that label and the factory decides again")
  elif .held == "needs-info" then out("ignore"; "it is waiting for answers (`needs-info`). Answer them, then label it `ready` again")
  elif .building != null then
    if .building.has_pr or .building.age <= 90 then out("ok"; "being built")
    else out("stuck"; "the factory started building it \(.building.age) minutes ago and no open pull request closes it. It is no longer `building`, so the next ticket can start; remove `needs-human` and the factory decides on this one again") end
  elif .ready == null or .ready.by_owner != true then out("ignore"; "not labeled `ready` by the owner")
  elif .edited_after_ready then
    out("unlabel"; "its title or description was edited by someone else after it was labeled `ready`. Reread it, and label it `ready` again if it should still be built")
  elif any(.blockers[]; .open != true and .closed == "unmerged") then
    out("human"; "\([.blockers[] | select(.open != true and .closed == "unmerged") | .number] | refs) closed without a merged pull request, so the plan may have changed. Remove that dependency if this should still be built")
  elif any(.blockers[]; .open or .closed == "merged") then
    [.blockers[] | select(.open and (.held // null) != null)] as $held
    | [.blockers[] | select(.open and .active == false and (.held // null) == null) | .number] as $idle
    | out("wait"; "it is blocked by \([.blockers[] | select(.open or .closed == "merged") | .number] | refs), until each is merged and deployed"
        + (if $held == [] then "" else ". Waiting on you: \($held | map("#\(.number) (`\(.held)`)") | join(", ")). Settle each first" end)
        + (if $idle == [] then "" else ". Nothing will finish \($idle | refs): no `ready` label and no open pull request that closes it. Label each `ready`, or, if its work is already merged, remove the dependency and then close the issue" end))
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
      timelineItems(itemTypes: [LABELED_EVENT, UNLABELED_EVENT, RENAMED_TITLE_EVENT, CLOSED_EVENT], last: 100) {
        nodes {
          __typename
          ... on LabeledEvent { createdAt label { name } actor { login } }
          ... on UnlabeledEvent { createdAt label { name } actor { login } }
          ... on RenamedTitleEvent { createdAt actor { login } }
          ... on ClosedEvent { closer { __typename ... on PullRequest { merged mergeCommit { oid } } ... on Commit { oid } } }
        }
      }
      closedByPullRequestsReferences(first: 5, includeClosedPrs: false) { nodes { number } }
      blockedBy(first: 50) {
        nodes {
          number
          state
          labels(first: 50) { nodes { name } }
          closedByPullRequestsReferences(first: 1, includeClosedPrs: false) { nodes { number } }
          timelineItems(itemTypes: [CLOSED_EVENT], last: 1) {
            nodes { __typename ... on ClosedEvent { closer { __typename ... on PullRequest { merged mergeCommit { oid } } ... on Commit { oid } } } }
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
  raw=$("$GH" api graphql -F owner="$owner" -F name="${repo#*/}" -F number="$1" -f query="$query") || return 1
  [ -n "$raw" ] || return 1
  state=$(jq -c --arg owner "$owner" --argjson now "$now" '
    def age($t): (($now - ($t | fromdateiso8601)) / 60 | floor);
    # What closed it the last time: a reopened issue closed by hand has no closer, even if a pull
    # request closed it before.
    def sha: ([.nodes[] | select(.__typename == "ClosedEvent")] | last | .closer) as $c
      | if $c == null then "" elif $c.__typename == "PullRequest" then (if $c.merged then $c.mergeCommit.oid else "" end) else $c.oid end;
    .data.repository.issue as $i
    | [$i.labels.nodes[].name] as $labels
    | [$i.timelineItems.nodes[] | select(.__typename == "LabeledEvent")] as $labeled
    | ([$labeled[] | select(.label.name == "ready")] | last) as $ready
    | ([$labeled[] | select(.label.name == "building")] | last) as $building
    | ([$labeled[] | select(.label.name == "needs-info")] | last) as $info
    | ($info != null and $ready != null and $ready.createdAt > $info.createdAt) as $answered
    # When the approval began: walk the `ready` events in order, restarting after the workflow removes it.
    | (reduce ($i.timelineItems.nodes[] | select((.__typename == "LabeledEvent" or .__typename == "UnlabeledEvent") and .label.name == "ready")) as $e
        (null;
         if $e.__typename == "UnlabeledEvent" and ($e.actor.login // "") != $owner then null
         elif $e.__typename == "LabeledEvent" and . == null and ($e.actor.login // "") == $owner then $e.createdAt
         else . end)) as $since
    | {number: $i.number, open: ($i.state == "OPEN"), sha: ($i.timelineItems | sha),
       ready: (if ($labels | index("ready")) != null and $ready != null
               then {by_owner: ($ready.actor.login == $owner), at: $ready.createdAt, age: age($ready.createdAt)} else null end),
       edited_after_ready: ($ready != null and (($since // $ready.createdAt) as $from |
         any($i.userContentEdits.nodes[]; .editedAt > $from and (.editor.login // "") != $owner) or
         any($i.timelineItems.nodes[]; .__typename == "RenamedTitleEvent" and .createdAt > $from and (.actor.login // "") != $owner))),
       held: (if ($labels | index("needs-human")) != null then "needs-human"
              elif ($labels | index("needs-info")) != null and ($answered | not) then "needs-info" else null end),
       answered: (($labels | index("needs-info")) != null and $answered),
       building: (if ($labels | index("building")) != null
                  then {age: (if $building != null then age($building.createdAt) else 0 end), has_pr: ($i.closedByPullRequestsReferences.nodes | length > 0)} else null end),
       blockers: [$i.blockedBy.nodes[] | {number, open: (.state == "OPEN"), sha: (.timelineItems | sha),
         active: (([(.labels.nodes // [])[].name] | any(. == "ready" or . == "building"))
                  or ((.closedByPullRequestsReferences.nodes // []) | length > 0)),
         held: ([(.labels.nodes // [])[].name] as $l
                | if ($l | index("needs-human")) != null then "needs-human"
                  elif ($l | index("needs-info")) != null then "needs-info" else null end)}]}
  ' <<<"$raw") || return 1
  [ -n "$state" ] || return 1

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
    blockers=$(jq -c --argjson b "$blocker" --argjson c "$b_closed" '. + [{number: $b.number, open: $b.open, closed: $c, active: $b.active, held: $b.held}]' <<<"$blockers")
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
act() { # act <mode> <issue> <decision JSON> <state JSON>
  local action reason
  action=$(jq -r .action <<<"$3")
  reason=$(jq -r .reason <<<"$3")
  echo "#$2: $action ($reason)"
  [ "${DRY_RUN:-}" != true ] || return 0
  local always=
  [ "$1" != gate ] || always=always
  case "$action" in
    ok) [ "$1" != gate ] || say "$2" "The factory is already building this, so there's nothing to start. ADR-0047." always ;;
    ignore)
      # Only the gate answers an ignore: the owner just added the label and should see why nothing ran.
      [ "$1" != gate ] || say "$2" "The factory didn't start this: $reason. ADR-0047." always
      ;;
    stuck)
      "$GH" issue edit "$2" -R "$repo" --remove-label building --add-label needs-human >/dev/null
      say "$2" "The factory stopped on this ticket: $reason. ADR-0047." always
      ;;
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
      local edit=(--add-label building)
      [ "$(jq -r .answered <<<"$4")" != true ] || edit+=(--remove-label needs-info)
      # act runs as an `if` condition in the sweep, where `set -e` is off: fail explicitly.
      "$GH" issue edit "$2" -R "$repo" "${edit[@]}" >/dev/null || return 1
      # The gate starts it the same way as the sweep: the dispatched build re-checks the ticket
      # after loading it, which the tag-mode job can't.
      if "$GH" workflow run factory.yml -R "$repo" --ref main -f issue="$2"; then
        # Started, so in flight, even if the comment doesn't make it.
        say "$2" "The factory started building this: nothing blocks it any more. ADR-0047." always || true
      else
        # Not started, so not in flight: the next sweep tries again.
        "$GH" issue edit "$2" -R "$repo" --remove-label building >/dev/null
        echo "::warning::Couldn't start the implementer for #$2; the next sweep tries again."
        return 1
      fi
      ;;
  esac
}

if [ "${1:-}" = --state ]; then
  gather "$2"
  exit 0
fi

# A run the dispatcher started reads the queue without changing it: the sweep owns the queue.
[ "${1:-}" != --verify ] || DRY_RUN=true

# Tickets in flight: labeled `building`, open or merged but not yet deployed. Releases the rest.
in_flight='[]'
failed=0
while read -r number; do
  [ -n "$number" ] || continue
  # One that can't be read stays in flight: better a stalled queue than two builds at once.
  if ! state=$(gather "$number"); then
    echo "::warning::Couldn't read #$number; it counts as in flight."
    in_flight=$(jq -c --argjson n "$number" '. + [$n]' <<<"$in_flight")
    failed=1
    continue
  fi
  state=$(jq -c '.others_building = []' <<<"$state")
  decision=$(jq -c "$decide" <<<"$state")
  case "$(jq -r .action <<<"$decision")" in
    # Closed and deployed, or open with no pull request long after it started (handed to a human,
    # so it no longer holds the queue): either way, no longer in flight.
    release | stuck) act sweep "$number" "$decision" "$state" ;;
    *)
      in_flight=$(jq -c --argjson n "$number" '. + [$n]' <<<"$in_flight")
      echo "#$number: $(jq -r '"\(.action) (\(.reason))"' <<<"$decision")"
      ;;
  esac
done < <("$GH" issue list -R "$repo" --label building --state all --limit 100 --json number --jq '.[].number')

# The dispatcher labeled ISSUE `building` and started this run. Everything else must still hold, as
# if it were deciding now; if not, release it and say why, and the next sweep decides again.
if [ "${1:-}" = --verify ]; then
  number=$2
  state=$(gather "$number") || { echo "::error::Couldn't read #$number."; exit 1; }
  decision=$(jq -c --argjson f "$in_flight" --argjson n "$number" \
    '(.building != null) as $marked | (.building = null | .others_building = ($f - [$n]) | '"$decide"') + {marked: $marked}' <<<"$state")
  action=$(jq -r .action <<<"$decision")
  reason=$(jq -r .reason <<<"$decision")
  if [ "$(jq -r .marked <<<"$decision")" = true ] && [ "$action" = start ]; then
    echo "#$number: verified ($reason)"
    [ -z "${GITHUB_OUTPUT:-}" ] || echo "ok=true" >>"$GITHUB_OUTPUT"
    exit 0
  fi
  [ "$(jq -r .marked <<<"$decision")" = true ] || reason="the dispatcher didn't mark it \`building\`"
  echo "#$number: refused ($reason)"
  unset DRY_RUN
  "$GH" issue edit "$number" -R "$repo" --remove-label building >/dev/null || true
  say "$number" "The factory didn't build this after all: $reason. ADR-0047." always
  exit 0
fi

if [ "${1:-}" = --gate ]; then
  number=$2
  state=$(gather "$number") || { echo "::error::Couldn't read #$number."; exit 1; }
  state=$(jq -c --argjson f "$in_flight" --argjson n "$number" '.others_building = ($f - [$n])' <<<"$state")
  act gate "$number" "$(jq -c "$decide" <<<"$state")" "$state"
  exit 0
fi

# Every ready ticket, oldest `ready` label first; the first that may start is started, and the rest
# queue behind it.
states=()
while read -r number; do
  [ -n "$number" ] || continue
  # One that can't be read is skipped this time; the rest are still decided.
  if state=$(gather "$number"); then
    states+=("$state")
  else
    echo "::warning::Couldn't read #$number; carrying on with the rest."
    failed=1
  fi
done < <("$GH" issue list -R "$repo" --label ready --state open --limit 100 --json number --jq '.[].number')
[ "${#states[@]}" -gt 0 ] || exit "$failed"
while read -r state; do
  number=$(jq -r .number <<<"$state")
  decision=$(jq -c --argjson f "$in_flight" '.others_building = ($f - [.number])' <<<"$state" | jq -c "$decide")
  if act sweep "$number" "$decision" "$state" && [ "$(jq -r .action <<<"$decision")" = start ]; then
    in_flight=$(jq -c --argjson n "$number" '. + [$n]' <<<"$in_flight")
  fi
done < <(printf '%s\n' "${states[@]}" | jq -sc 'sort_by(.ready.at // "") | .[]')
# A ticket that couldn't be read turns the run red, so it gets noticed.
exit "$failed"
