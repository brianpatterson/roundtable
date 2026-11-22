#!/usr/bin/env bash
# Checks the dispatcher's decisions (ADR-0047): each case is a ticket's state and the action it must
# get, then a gate and a sweep end to end against a stand-in gh. Run from anywhere:
# .github/factory/test-dispatch.sh
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
failures=0

check() { # check <name> <state JSON> <expected action>
  got=$("$here/dispatch.sh" --decide <<<"$2" | jq -r .action)
  if [ "$got" != "$3" ]; then
    echo "FAIL: $1: expected $3, got $got"
    failures=$((failures + 1))
  fi
}

# A ready ticket the owner labeled, nothing blocking it, nothing in flight. Cases change one thing.
base='{"open":true,"closed":null,"ready":{"approved":true,"age":5},"edited_after_ready":false,"held":null,"answered":false,"building":null,"blockers":[],"others_building":[]}'
with() { jq -c "$1" <<<"$base"; }

check "unblocked, nothing in flight: start" "$base" start
check "labeled by someone other than the owner: ignore" "$(with '.ready.approved = false')" ignore
check "no ready label: ignore" "$(with '.ready = null')" ignore
check "labeled needs-human: ignore" "$(with '.held = "needs-human"')" ignore
check "waiting for answers (needs-info): ignore" "$(with '.held = "needs-info"')" ignore
check "needs-info, answered and relabeled ready: start" "$(with '.answered = true')" start
check "edited by someone else after the label: unlabel" "$(with '.edited_after_ready = true')" unlabel
check "edited after the label and also blocked: unlabel first" "$(with '.edited_after_ready = true | .blockers = [{"number":3,"open":true,"closed":null}]')" unlabel

check "an open blocker: wait" "$(with '.blockers = [{"number":3,"open":true,"closed":null}]')" wait
check "a blocker merged but not deployed: wait" "$(with '.blockers = [{"number":3,"open":false,"closed":"merged"}]')" wait
check "every blocker deployed: start" "$(with '.blockers = [{"number":3,"open":false,"closed":"deployed"},{"number":4,"open":false,"closed":"deployed"}]')" start
check "a blocker closed without a merged pull request: human" "$(with '.blockers = [{"number":3,"open":false,"closed":"unmerged"}]')" human
check "an unmerged blocker outranks an open one" "$(with '.blockers = [{"number":3,"open":true,"closed":null},{"number":4,"open":false,"closed":"unmerged"}]')" human

check "another ticket in flight: queue" "$(with '.others_building = [7]')" queue
check "blocked and another in flight: wait (the blocker is the reason)" "$(with '.others_building = [7] | .blockers = [{"number":3,"open":true,"closed":null}]')" wait

check "building, just started: ok" "$(with '.building = {"age":10,"has_pr":false}')" ok
check "building with its pull request open: ok" "$(with '.building = {"age":600,"has_pr":true}')" ok
check "building for over 90 minutes with no pull request: stuck" "$(with '.building = {"age":91,"has_pr":false}')" stuck
check "building and handed to a human: ignore, still in flight" "$(with '.building = {"age":600,"has_pr":false} | .held = "needs-human"')" ignore

check "closed and merged, not yet deployed: ok (still in flight)" "$(with '.open = false | .closed = "merged" | .building = {"age":60,"has_pr":false}')" ok
check "closed and deployed: release" "$(with '.open = false | .closed = "deployed" | .building = {"age":60,"has_pr":false}')" release
check "closed without a merged pull request: release" "$(with '.open = false | .closed = "unmerged" | .building = {"age":60,"has_pr":false}')" release
check "closed and never building: ignore" "$(with '.open = false | .closed = "deployed"')" ignore

reason=$("$here/dispatch.sh" --decide <<<"$(with '.blockers = [{"number":3,"open":true,"closed":null},{"number":4,"open":false,"closed":"deployed"}]')" | jq -r .reason)
case "$reason" in *"#3"*"merged and deployed"*) ;; *)
  echo "FAIL: the reason names the blockers still waited on: got [$reason]"
  failures=$((failures + 1))
  ;;
esac
case "$reason" in *"#4"*)
  echo "FAIL: the reason leaves out a deployed blocker: got [$reason]"
  failures=$((failures + 1))
  ;;
esac

# An open blocker nothing will finish (no `ready`, no `building`, no open pull request) still waits,
# but the reason says so: a tracking issue opened after its pull request merged waited forever (#129).
check "an open blocker nothing will finish: still wait" "$(with '.blockers = [{"number":3,"open":true,"closed":null,"active":false}]')" wait
reason=$("$here/dispatch.sh" --decide <<<"$(with '.blockers = [{"number":3,"open":true,"closed":null,"active":false},{"number":4,"open":true,"closed":null,"active":true},{"number":5,"open":false,"closed":"merged","active":false}]')" | jq -r .reason)
case "$reason" in *"Nothing will finish #3:"*"remove the dependency"*) ;; *)
  echo "FAIL: the reason names the blocker nothing will finish: got [$reason]"
  failures=$((failures + 1))
  ;;
esac
case "$reason" in *"finish #3, #4"* | *"finish #3, #5"* | *"finish #4"* | *"finish #5"*)
  echo "FAIL: the reason calls an active or closed blocker idle: got [$reason]"
  failures=$((failures + 1))
  ;;
esac
reason=$("$here/dispatch.sh" --decide <<<"$(with '.blockers = [{"number":3,"open":true,"closed":null,"active":true}]')" | jq -r .reason)
case "$reason" in *"Nothing will finish"*)
  echo "FAIL: an active blocker is reported as idle: got [$reason]"
  failures=$((failures + 1))
  ;;
esac

# A blocker held for the owner (the factory handed it over, or it waits on answers) needs the owner,
# not a `ready` label: the wait says what it is held on, even if it still has `ready`.
reason=$("$here/dispatch.sh" --decide <<<"$(with '.blockers = [{"number":3,"open":true,"closed":null,"active":false,"held":"needs-human"},{"number":4,"open":true,"closed":null,"active":true,"held":"needs-info"}]')" | jq -r .reason)
# shellcheck disable=SC2016 # backticks are Markdown
case "$reason" in *'Waiting on you: #3 (`needs-human`), #4 (`needs-info`). Settle each first'*) ;; *)
  echo "FAIL: the reason names held blockers with their label: got [$reason]"
  failures=$((failures + 1))
  ;;
esac
case "$reason" in *"Nothing will finish"*)
  echo "FAIL: a held blocker is told to be labeled ready: got [$reason]"
  failures=$((failures + 1))
  ;;
esac

# End to end, against a stand-in gh that answers GraphQL per issue from canned JSON and applies
# --jq as gh would. The repo is o/r, owned by o; the latest deploy shipped commit "dep".
#   #10: ready (by o), blocked by #3, which a pull request merged as commit "old", which "dep" includes.
#   #11: ready (by o), blocked by #4, still open and labeled ready.
#   #27: ready (by o), blocked by #7, which the factory handed to a human (needs-human).
#   #26: ready (by o), blocked by #5 (open, unlabeled, no pull request) and #6 (open, a pull request closes it).
#   #12: ready, but labeled by someone else.
#   #13: ready (by o), then its description was edited by "stranger".
#   #14: building, closed by a pull request merged as "new", which "dep" doesn't include yet.
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
labeled() { printf '{"__typename":"LabeledEvent","createdAt":"%s","label":{"name":"%s"},"actor":{"login":"%s"}}' "$1" "$2" "$3"; }
closed_by() { printf '{"nodes":[{"__typename":"ClosedEvent","closer":{"__typename":"PullRequest","merged":true,"mergeCommit":{"oid":"%s"}}}]}' "$1"; }
issue() { # issue <number> <state> <labels JSON> <timeline nodes JSON> <blockers JSON> [edits JSON] [author]
  jq -n --argjson n "$1" --arg s "$2" --argjson l "$3" --argjson t "$4" --argjson b "$5" --argjson e "${6:-[]}" --arg a "${7:-o}" \
    '{data:{repository:{issue:{number:$n,state:$s,author:{login:$a},labels:{nodes:($l|map({name:.}))},userContentEdits:{nodes:$e},
      timelineItems:{nodes:$t},closedByPullRequestsReferences:{nodes:[]},blockedBy:{nodes:$b}}}}}' >"$work/issue-$1.json"
}
t=2026-11-20T10:00:00Z
issue 10 OPEN '["ready","enhancement"]' "[$(labeled $t ready o)]" "[{\"number\":3,\"state\":\"CLOSED\",\"timelineItems\":$(closed_by old)}]"
issue 11 OPEN '["ready"]' "[$(labeled 2026-11-20T09:00:00Z ready o)]" '[{"number":4,"state":"OPEN","labels":{"nodes":[{"name":"ready"}]},"timelineItems":{"nodes":[]}}]'
issue 27 OPEN '["ready"]' "[$(labeled $t ready o)]" '[{"number":7,"state":"OPEN","labels":{"nodes":[{"name":"needs-human"}]},"closedByPullRequestsReferences":{"nodes":[]},"timelineItems":{"nodes":[]}}]'
issue 26 OPEN '["ready"]' "[$(labeled $t ready o)]" '[{"number":5,"state":"OPEN","labels":{"nodes":[{"name":"enhancement"}]},"closedByPullRequestsReferences":{"nodes":[]},"timelineItems":{"nodes":[]}},{"number":6,"state":"OPEN","labels":{"nodes":[]},"closedByPullRequestsReferences":{"nodes":[{"number":60}]},"timelineItems":{"nodes":[]}}]'
issue 12 OPEN '["ready"]' "[$(labeled $t ready someone)]" '[]'
issue 13 OPEN '["ready"]' "[$(labeled $t ready o)]" '[]' '[{"editedAt":"2026-11-20T11:00:00Z","editor":{"login":"stranger"}},{"editedAt":"2026-11-20T09:00:00Z","editor":{"login":"o"}}]'
renamed() { printf '{"__typename":"RenamedTitleEvent","createdAt":"%s","actor":{"login":"%s"}}' "$1" "$2"; }
issue 15 OPEN '["ready","needs-info"]' "[$(labeled 2026-11-20T09:00:00Z ready o),$(labeled 2026-11-20T09:30:00Z needs-info github-actions),$(labeled $t ready o)]" '[]'
issue 16 OPEN '["ready","needs-human"]' "[$(labeled $t ready o)]" '[]'
issue 17 OPEN '["ready"]' "[$(labeled $t ready o),$(renamed 2026-11-20T11:00:00Z stranger)]" '[]'
issue 18 CLOSED '["building"]' "[$(labeled $t building github-actions),$(jq -c '.nodes[0]' <<<"$(closed_by old)")]" '[]'
issue 19 OPEN '["building","ready"]' "[$(labeled $t ready o),$(labeled $t building github-actions)]" '[]'
unlabeled() { printf '{"__typename":"UnlabeledEvent","createdAt":"%s","label":{"name":"%s"},"actor":{"login":"%s"}}' "$1" "$2" "$3"; }
stranger_edit='[{"editedAt":"2026-11-20T09:30:00Z","editor":{"login":"stranger"}}]'
# #20: ready (by o) later than #10, nothing blocking it. #21: started by the dispatcher (building).
# #22: started, but edited by a stranger after the label. #23 and #24: a stranger edited at 09:30,
# then the label came off and went back on at 10:00; by the owner (#23) or by the workflow (#24).
issue 20 OPEN '["ready"]' "[$(labeled 2026-11-20T12:00:00Z ready o)]" '[]'
issue 21 OPEN '["ready","building"]' "[$(labeled $t ready o),$(labeled 2026-11-20T12:00:00Z building github-actions)]" '[]'
issue 22 OPEN '["ready","building"]' "[$(labeled 2026-11-20T09:00:00Z ready o),$(labeled 2026-11-20T12:00:00Z building github-actions)]" '[]' "$stranger_edit"
issue 23 OPEN '["ready"]' "[$(labeled 2026-11-20T09:00:00Z ready o),$(unlabeled 2026-11-20T09:45:00Z ready o),$(labeled $t ready o)]" '[]' "$stranger_edit"
issue 24 OPEN '["ready"]' "[$(labeled 2026-11-20T09:00:00Z ready o),$(unlabeled 2026-11-20T09:45:00Z ready github-actions),$(labeled $t ready o)]" '[]' "$stranger_edit"
# #25: building; a pull request closed it, then it was reopened and closed by hand.
issue 25 CLOSED '["building"]' "[$(labeled $t building github-actions),$(jq -c '.nodes[0]' <<<"$(closed_by old)"),{\"__typename\":\"ClosedEvent\",\"closer\":null}]" '[]'
# Mutation tickets (ADR-0051): #47 the nightly run opened and labeled itself; #48 is the same, then
# a stranger edited it; #49 is another workflow issue the workflow labeled, without `mutation`; #50
# is labeled `mutation` and `ready` by the workflow, but someone else opened it.
issue 47 OPEN '["mutation","ready"]' "[$(labeled $t mutation github-actions),$(labeled $t ready github-actions)]" '[]' '[]' github-actions
issue 48 OPEN '["mutation","ready"]' "[$(labeled $t ready github-actions)]" '[]' "$(jq -c '.[0].editedAt = "2026-11-20T11:00:00Z"' <<<"$stranger_edit")" github-actions
issue 49 OPEN '["architecture","ready"]' "[$(labeled $t ready github-actions)]" '[]' '[]' github-actions
issue 50 OPEN '["mutation","ready"]' "[$(labeled $t ready github-actions)]" '[]' '[]' stranger
issue 14 CLOSED '["building"]' "[$(labeled $t building github-actions),$(jq -c '.nodes[0]' <<<"$(closed_by new)")]" '[]'
echo '[{"headSha":"dep"}]' >"$work/deploy.json"
echo '[{"number":10},{"number":11},{"number":12},{"number":13},{"number":17}]' >"$work/ready.json"
echo '[{"number":14}]' >"$work/building.json"
# The dispatcher's last comment on #11 already says it waits on #4: a sweep doesn't repeat it.
jq -n --arg b "$(printf '<!-- factory-dispatch -->\nThe factory will build this later: it is blocked by #4, until each is merged and deployed. It says here when it starts. ADR-0047.')" \
  '[{user:{login:"github-actions[bot]"},body:$b}]' >"$work/comments-11.json"
cat >"$work/gh" <<'GH'
#!/usr/bin/env bash
filter=.
prev=
number=
for arg in "$@"; do
  [ "$prev" = --jq ] && filter=$arg
  case "$arg" in number=*) number=${arg#number=} ;; esac
  prev=$arg
done
case "$*" in
  "api graphql"*) [ "$number" != "$FAIL_READ" ] || { echo "GitHub says no" >&2; exit 1; }; file=issue-$number.json ;;
  "run list"*) file=deploy.json ;;
  "issue list"*"--label ready"*) file=ready.json ;;
  "issue list"*"--label building"*) file=building.json ;;
  "api repos/o/r/compare/old...dep"*) echo ahead; exit 0 ;;
  "api repos/o/r/issues/11/comments"*) file=comments-11.json ;;
  "issue comment $FAIL_COMMENT "*) echo "$*" >>"$WORK/writes"; exit 1 ;;
  "workflow run"*"issue=$FAIL_DISPATCH") echo "$*" >>"$WORK/writes"; exit 1 ;;
  "api repos/o/r/compare/"*) echo behind; exit 0 ;;
  *) echo "$*" >>"$WORK/writes"; exit 0 ;;
esac
jq -rc "$filter" "$WORK/$file"
GH
chmod +x "$work/gh"
run() { FAIL_COMMENT=${FAIL_COMMENT:-none} FAIL_READ=${FAIL_READ:-none} FAIL_DISPATCH=${FAIL_DISPATCH:-none} WORK=$work GH=$work/gh GITHUB_REPOSITORY=o/r "$here/dispatch.sh" "$@" 2>&1; }
expect() { # expect <name> <output> <text it must contain>
  case "$2" in *"$3"*) ;; *)
    echo "FAIL: $1: no [$3] in [$2]"
    failures=$((failures + 1))
    ;;
  esac
}

# #14 is merged but not deployed, so it's in flight: #10 would start but queues behind it.
output=$(DRY_RUN=true run)
expect "a merged, undeployed ticket stays in flight" "$output" "#14: ok"
expect "an unblocked ticket queues behind the one in flight" "$output" "#10: queue"
expect "an open blocker means wait" "$output" "#11: wait"
case "$output" in *"#11: wait"*"Nothing will finish"*) echo "FAIL: a blocker labeled ready counted as idle: [$output]"; failures=$((failures + 1)) ;; esac
expect "someone else's ready label is ignored" "$output" "#12: ignore"
expect "an edit by someone else after the label sends it back" "$output" "#13: unlabel"
expect "a title change by someone else after the label sends it back" "$output" "#17: unlabel"

# A real sweep: #18's work is deployed, so it's released; #19 has built for hours with no pull
# request, so it goes to a human and stops holding the queue; #11 isn't told again what it was told.
echo '[{"number":18},{"number":19}]' >"$work/building.json"
echo '[{"number":11}]' >"$work/ready.json"
: >"$work/writes"
output=$(run)
expect "a deployed ticket is released" "$(cat "$work/writes")" "issue edit 18 -R o/r --remove-label building"
expect "a stuck ticket goes to a human and leaves the queue" "$(cat "$work/writes")" "issue edit 19 -R o/r --remove-label building --add-label needs-human"
if grep -q "issue comment 11" "$work/writes"; then
  echo "FAIL: a waiting ticket was told the same thing twice"
  failures=$((failures + 1))
fi
echo '[{"number":10},{"number":11},{"number":12},{"number":13},{"number":17}]' >"$work/ready.json"

# Once #14 is deployed, it's released and the gate starts #10, labeling it building.
echo '[]' >"$work/building.json"
: >"$work/writes"
output=$(GITHUB_OUTPUT=$work/out run --gate 10)
expect "the gate starts an unblocked ticket" "$output" "#10: start"
expect "the gate starts the build through a dispatch, not the tag-mode job" "$(cat "$work/writes")" "workflow run factory.yml -R o/r --ref main -f issue=10"
expect "a started ticket is labeled building" "$(cat "$work/writes")" "issue edit 10 -R o/r --add-label building"

# The gate refuses a blocked ticket and always says why, so the owner sees an answer.
: >"$work/writes"
: >"$work/out"
output=$(GITHUB_OUTPUT=$work/out run --gate 11)
expect "the gate holds a blocked ticket" "$output" "#11: wait"
expect "the gate comments on a held ticket" "$(cat "$work/writes")" "issue comment 11"
if grep -q "issue=11" "$work/writes"; then
  echo "FAIL: the gate started a blocked ticket"
  failures=$((failures + 1))
fi

# Read from GitHub: #5 has neither label nor pull request, so the wait names it; #6 has a pull
# request that closes it, so it doesn't.
output=$(DRY_RUN=true run --gate 26)
expect "a blocker nothing will finish is named" "$output" "Nothing will finish #5:"
case "$output" in *"finish #5, #6"* | *"finish #6"*)
  echo "FAIL: a blocker an open pull request closes counted as idle: [$output]"
  failures=$((failures + 1))
  ;;
esac

output=$(DRY_RUN=true run --gate 27)
# shellcheck disable=SC2016 # backticks are Markdown
expect "a blocker held for a human is named with its label" "$output" 'Waiting on you: #7 (`needs-human`).'

# Relabeling `ready` after answering `needs-info` starts it again, and clears `needs-info`.
: >"$work/writes"
: >"$work/out"
output=$(GITHUB_OUTPUT=$work/out run --gate 15)
expect "an answered needs-info ticket starts when relabeled" "$output" "#15: start"
expect "starting it clears needs-info" "$(cat "$work/writes")" "issue edit 15 -R o/r --add-label building --remove-label needs-info"

# A label the gate won't act on is never silent.
: >"$work/writes"
output=$(GITHUB_OUTPUT=$work/out run --gate 16)
expect "the gate ignores a ticket held for a human" "$output" "#16: ignore"
expect "and says why" "$(cat "$work/writes")" "issue comment 16"

# The sweep starts the oldest free ticket itself, and the next free one queues behind it.
echo '[]' >"$work/building.json"
echo '[{"number":20},{"number":10}]' >"$work/ready.json"
: >"$work/writes"
output=$(run)
expect "the sweep starts the oldest free ticket" "$output" "#10: start"
expect "and marks it building" "$(cat "$work/writes")" "issue edit 10 -R o/r --add-label building"
expect "by dispatching the implementer from main" "$(cat "$work/writes")" "workflow run factory.yml -R o/r --ref main -f issue=10"
expect "the next free ticket queues behind it" "$output" "#20: queue"
if grep -q "issue=20" "$work/writes"; then
  echo "FAIL: the sweep started two tickets at once"
  failures=$((failures + 1))
fi

# A dispatch that fails takes `building` back off and leaves the ticket out of flight, so the next
# free ticket starts in the same sweep, and the failed one is tried again next time.
: >"$work/writes"
output=$(FAIL_DISPATCH=10 run) || true
expect "a failed dispatch releases the ticket" "$(cat "$work/writes")" "issue edit 10 -R o/r --remove-label building"
expect "and the next free ticket starts instead" "$(cat "$work/writes")" "workflow run factory.yml -R o/r --ref main -f issue=20"

# A started ticket stays in flight even if the comment saying so fails, so nothing starts beside it.
: >"$work/writes"
output=$(FAIL_COMMENT=10 run) || true
expect "a started ticket whose comment failed" "$(cat "$work/writes")" "workflow run factory.yml -R o/r --ref main -f issue=10"
if grep -q "issue=20" "$work/writes"; then
  echo "FAIL: a failed comment let a second ticket start"
  failures=$((failures + 1))
fi

# The dispatched run checks the rules again before its agent runs.
: >"$work/out"
output=$(GITHUB_OUTPUT=$work/out run --verify 21)
expect "a ticket the dispatcher started is verified" "$(cat "$work/out")" "ok=true"
: >"$work/out"
: >"$work/writes"
output=$(GITHUB_OUTPUT=$work/out run --verify 22)
expect "an edit since the label refuses the dispatched run" "$output" "#22: refused"
expect "and releases it" "$(cat "$work/writes")" "issue edit 22 -R o/r --remove-label building"
: >"$work/out"
output=$(GITHUB_OUTPUT=$work/out run --verify 20)
expect "a ticket the dispatcher didn't mark is refused" "$output" "#20: refused"
if grep -q ok=true "$work/out"; then
  echo "FAIL: verify passed a ticket that isn't building"
  failures=$((failures + 1))
fi

# The approval runs from the owner's first label: relabeling yourself doesn't wash out an edit made
# in between, but a label the workflow removed starts a fresh one.
expect "an edit before the owner's own relabel still counts" "$(run --state 23 | jq -c .edited_after_ready)" true
expect "an edit before the workflow removed the label doesn't" "$(run --state 24 | jq -c .edited_after_ready)" false

# The gate answers a relabel on a ticket that's already building (#26: #21 with its pull request open).
jq '.data.repository.issue.number = 26 | .data.repository.issue.closedByPullRequestsReferences.nodes = [{number: 99}]' \
  "$work/issue-21.json" >"$work/issue-26.json"
: >"$work/writes"
output=$(GITHUB_OUTPUT=$work/out run --gate 26)
expect "relabeling a building ticket is ok" "$output" "#26: ok"
expect "and gets an answer" "$(cat "$work/writes")" "issue comment 26"

# What closed an issue is its last close: a pull request's earlier close doesn't count.
expect "a reopened issue closed by hand counts as unmerged" "$(run --state 25 | jq -r .closed)" unmerged

# A ticket that can't be read doesn't stop the sweep, and turns the run red. One that's building
# stays in flight, so nothing starts beside it.
echo '[]' >"$work/building.json"
echo '[{"number":11},{"number":10}]' >"$work/ready.json"
: >"$work/writes"
status=0
output=$(FAIL_READ=11 run) || status=$?
expect "an unreadable ready ticket is skipped" "$output" "Couldn't read #11"
expect "and the rest are still decided" "$output" "#10: start"
[ "$status" -ne 0 ] || { echo "FAIL: a sweep with an unreadable ticket exits 0"; failures=$((failures + 1)); }
echo '[{"number":21}]' >"$work/building.json"
echo '[{"number":10}]' >"$work/ready.json"
output=$(FAIL_READ=21 run) || true
expect "an unreadable building ticket stays in flight" "$output" "#10: queue"

# The nightly mutation run's own ticket is approved by its own label; no other workflow label is.
expect "a mutation ticket the workflow opened and labeled is approved" "$(run --state 47 | jq -c .ready.approved)" true
expect "and an edit by someone else after that label still counts" "$(run --state 48 | jq -c .edited_after_ready)" true
expect "the workflow's label on another kind of issue is not approval" "$(run --state 49 | jq -c .ready.approved)" false
expect "nor on a mutation ticket someone else opened" "$(run --state 50 | jq -c .ready.approved)" false
echo '[]' >"$work/building.json"
echo '[{"number":47}]' >"$work/ready.json"
expect "a sweep starts the mutation ticket" "$(DRY_RUN=true run)" "#47: start"
echo '[{"number":49}]' >"$work/ready.json"
expect "and ignores the other workflow-labeled issue" "$(DRY_RUN=true run)" "#49: ignore"

if [ "$failures" -gt 0 ]; then
  echo "$failures failed."
  exit 1
fi
echo "All dispatcher decisions pass."
