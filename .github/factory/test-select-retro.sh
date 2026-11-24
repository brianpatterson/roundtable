#!/usr/bin/env bash
# Checks when a batch gets its retrospective (ADR-0064) against a stand-in gh.
# Run from anywhere: .github/factory/test-select-retro.sh
# shellcheck source=.github/factory/testlib.sh
. "$(dirname "$0")/testlib.sh"

fake_gh <<'ROUTES'
  *"parent { number }"*) answer parent.json ;;
  *subIssues*) answer batch.json ;;
  "issue list"*) answer retros.json ;;
ROUTES

run() { # run <args…>; sets status, out, selected (the parent written to the output, or empty)
  rm -f "$work/output"
  status=0
  out=$(GH="$work/gh" GITHUB_REPOSITORY=owner/repo GITHUB_OUTPUT="$work/output" "$here/select-retro.sh" "$@" 2>&1) || status=$?
  selected=$(sed -n 's/^parent=//p' "$work/output" 2>/dev/null || true)
}

parent() { echo "{\"data\":{\"repository\":{\"issue\":{\"parent\":$1}}}}" >"$work/parent.json"; }

# batch <parent state> <sub-issue>… where a sub-issue is <number>:<OPEN|CLOSED>:<head branch or ->
batch() {
  local state=$1
  shift
  local nodes=() spec number sub head
  for spec in "$@"; do
    IFS=: read -r number sub head <<<"$spec"
    if [ "$head" = - ]; then
      nodes+=("{\"number\":$number,\"state\":\"$sub\",\"closedByPullRequestsReferences\":{\"nodes\":[]}}")
    else
      nodes+=("{\"number\":$number,\"state\":\"$sub\",\"closedByPullRequestsReferences\":{\"nodes\":[{\"merged\":true,\"headRefName\":\"$head\"}]}}")
    fi
  done
  local joined
  joined=$(
    IFS=,
    echo "${nodes[*]+${nodes[*]}}"
  )
  echo "{\"data\":{\"repository\":{\"issue\":{\"state\":\"$state\",\"subIssues\":{\"totalCount\":$#,\"nodes\":[$joined]}}}}}" >"$work/batch.json"
}

echo '[]' >"$work/retros.json"

parent null
batch OPEN
run --issue 7
expect "a ticket with no parent exits 0" 0 "$status"
expect "selects nothing for a ticket in no batch" "" "$selected"
expect_in "says it's in no batch" "$out" "no parent"

parent '{"number":10}'
batch OPEN 11:CLOSED:claude/issue-11-a 12:CLOSED:claude/issue-12-b
run --issue 12
expect "selects the parent once every ticket is closed" 10 "$selected"

batch OPEN 11:CLOSED:claude/issue-11-a 12:OPEN:-
run --issue 11
expect "selects nothing while a ticket is open" "" "$selected"
expect_in "names the open ticket" "$out" "#12 still open"

batch OPEN 11:CLOSED:feature/by-hand 12:CLOSED:-
run --issue 12
expect "selects nothing the factory didn't build" "" "$selected"
expect_in "says the factory built none" "$out" "built none"

batch OPEN 11:CLOSED:claude/issue-99-other
run --issue 11
expect "doesn't count a factory branch for another ticket" "" "$selected"

batch CLOSED 11:CLOSED:claude/issue-11-a
run --issue 11
expect "selects nothing for a closed parent" "" "$selected"
run --parent 10
expect "by hand, selects a closed parent (a backfill)" 10 "$selected"

batch OPEN
run --parent 10
expect "selects nothing for a parent with no sub-issues" "" "$selected"

batch OPEN 11:CLOSED:claude/issue-11-a
echo '[{"number":40,"body":"Findings <!-- retro-of-#100 -->"},{"number":41,"body":"<!-- retro-of-#10 -->"}]' >"$work/retros.json"
run --issue 11
expect "selects nothing once a retro covers the parent" "" "$selected"
expect_in "names the existing retro" "$out" "#41"

echo '[{"number":40,"body":"<!-- retro-of-#100 -->"}]' >"$work/retros.json"
run --issue 11
expect "another parent's retro doesn't count" 10 "$selected"

run --bogus
expect "an unknown option is a usage error" 2 "$status"

finish "All retro selection checks passed"
