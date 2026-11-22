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
base='{"open":true,"closed":null,"ready":{"by_owner":true,"age":5},"edited_after_ready":false,"held":null,"answered":false,"building":null,"blockers":[],"others_building":[]}'
with() { jq -c "$1" <<<"$base"; }

check "unblocked, nothing in flight: start" "$base" start
check "labeled by someone other than the owner: ignore" "$(with '.ready.by_owner = false')" ignore
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

# End to end, against a stand-in gh that answers GraphQL per issue from canned JSON and applies
# --jq as gh would. The repo is o/r, owned by o; the latest deploy shipped commit "dep".
#   #10: ready (by o), blocked by #3, which a pull request merged as commit "old", which "dep" includes.
#   #11: ready (by o), blocked by #4, still open.
#   #12: ready, but labeled by someone else.
#   #13: ready (by o), then its description was edited by "stranger".
#   #14: building, closed by a pull request merged as "new", which "dep" doesn't include yet.
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
labeled() { printf '{"__typename":"LabeledEvent","createdAt":"%s","label":{"name":"%s"},"actor":{"login":"%s"}}' "$1" "$2" "$3"; }
closed_by() { printf '{"nodes":[{"__typename":"ClosedEvent","closer":{"__typename":"PullRequest","merged":true,"mergeCommit":{"oid":"%s"}}}]}' "$1"; }
issue() { # issue <number> <state> <labels JSON> <timeline nodes JSON> <blockers JSON> [edits JSON]
  jq -n --argjson n "$1" --arg s "$2" --argjson l "$3" --argjson t "$4" --argjson b "$5" --argjson e "${6:-[]}" \
    '{data:{repository:{issue:{number:$n,state:$s,labels:{nodes:($l|map({name:.}))},userContentEdits:{nodes:$e},
      timelineItems:{nodes:$t},closedByPullRequestsReferences:{nodes:[]},blockedBy:{nodes:$b}}}}}' >"$work/issue-$1.json"
}
t=2026-11-20T10:00:00Z
issue 10 OPEN '["ready","enhancement"]' "[$(labeled $t ready o)]" "[{\"number\":3,\"state\":\"CLOSED\",\"timelineItems\":$(closed_by old)}]"
issue 11 OPEN '["ready"]' "[$(labeled 2026-11-20T09:00:00Z ready o)]" '[{"number":4,"state":"OPEN","timelineItems":{"nodes":[]}}]'
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
  "api graphql"*) file=issue-$number.json ;;
  "run list"*) file=deploy.json ;;
  "issue list"*"--label ready"*) file=ready.json ;;
  "issue list"*"--label building"*) file=building.json ;;
  "api repos/o/r/compare/old...dep"*) echo ahead; exit 0 ;;
  "api repos/o/r/issues/11/comments"*) file=comments-11.json ;;
  "api repos/o/r/compare/"*) echo behind; exit 0 ;;
  *) echo "$*" >>"$WORK/writes"; exit 0 ;;
esac
jq -rc "$filter" "$WORK/$file"
GH
chmod +x "$work/gh"
run() { WORK=$work GH=$work/gh GITHUB_REPOSITORY=o/r "$here/dispatch.sh" "$@" 2>&1; }
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
expect "the gate tells the implement job to run" "$(cat "$work/out" 2>/dev/null)" "start=true"
expect "a started ticket is labeled building" "$(cat "$work/writes")" "issue edit 10 -R o/r --add-label building"

# The gate refuses a blocked ticket and always says why, so the owner sees an answer.
: >"$work/writes"
: >"$work/out"
output=$(GITHUB_OUTPUT=$work/out run --gate 11)
expect "the gate holds a blocked ticket" "$output" "#11: wait"
expect "the gate comments on a held ticket" "$(cat "$work/writes")" "issue comment 11"
if grep -q start=true "$work/out"; then
  echo "FAIL: the gate started a blocked ticket"
  failures=$((failures + 1))
fi

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

if [ "$failures" -gt 0 ]; then
  echo "$failures failed."
  exit 1
fi
echo "All dispatcher decisions pass."
