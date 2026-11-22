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
base='{"open":true,"closed":null,"ready":{"by_owner":true,"age":5},"edited_after_ready":false,"held":false,"building":null,"blockers":[],"others_building":[]}'
with() { jq -c "$1" <<<"$base"; }

check "unblocked, nothing in flight: start" "$base" start
check "labeled by someone other than the owner: ignore" "$(with '.ready.by_owner = false')" ignore
check "no ready label: ignore" "$(with '.ready = null')" ignore
check "waiting for the owner (needs-human or needs-info): ignore" "$(with '.held = true')" ignore
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
check "building for over 90 minutes with no pull request: human" "$(with '.building = {"age":91,"has_pr":false}')" human
check "building and held: ignore, still in flight" "$(with '.building = {"age":600,"has_pr":false} | .held = true')" ignore

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
issue 14 CLOSED '["building"]' "[$(labeled $t building github-actions),$(jq -c '.nodes[0]' <<<"$(closed_by new)")]" '[]'
echo '[{"headSha":"dep"}]' >"$work/deploy.json"
echo '[{"number":10},{"number":11},{"number":12},{"number":13}]' >"$work/ready.json"
echo '[{"number":14}]' >"$work/building.json"
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

if [ "$failures" -gt 0 ]; then
  echo "$failures failed."
  exit 1
fi
echo "All dispatcher decisions pass."
