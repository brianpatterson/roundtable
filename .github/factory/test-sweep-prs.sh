#!/usr/bin/env bash
# Checks the sweeper's decisions (ADR-0040, ADR-0058): each case is a pull request's state and the action it
# must get. Run from anywhere: .github/factory/test-sweep-prs.sh
# shellcheck source=.github/factory/testlib.sh
. "$(dirname "$0")/testlib.sh"

check() { # check <name> <state JSON> <expected action>
  expect "$1" "$3" "$("$here/sweep-prs.sh" --decide <<<"$2" | jq -r .action)"
}

ci() { # ci <status> <conclusion> <attempt> <age>
  printf '{"status":"%s","conclusion":"%s","attempt":%s,"age":%s}' "$1" "$2" "$3" "$4"
}
state() { # state <mergeable> <head age> <ci JSON or null> [review JSON] [factory: true|false]
  printf '{"factory":%s,"mergeable":"%s","head_age":%s,"ci":%s,"review":%s}' "${5:-true}" "$1" "$2" "$3" "${4:-null}"
}

check "a factory PR's conflict goes to the resolver, whatever CI says" "$(state CONFLICTING 5 "$(ci completed success 1 5)")" resolve
check "an autofix-only PR's conflict goes to a human" "$(state CONFLICTING 5 "$(ci completed success 1 5)" null false)" human
check "no CI yet, just pushed: wait" "$(state MERGEABLE 10 null)" wait
check "no CI half an hour after the push: human" "$(state MERGEABLE 31 null)" human
check "CI running: wait" "$(state MERGEABLE 40 "$(ci in_progress '' 1 40)")" wait
check "CI queued for over 90 minutes: human" "$(state MERGEABLE 95 "$(ci queued '' 1 91)")" human
check "mergeability unknown doesn't count as a conflict" "$(state UNKNOWN 40 "$(ci in_progress '' 1 40)")" wait

check "cancelled (a timeout) on the first attempt: rerun" "$(state MERGEABLE 40 "$(ci completed cancelled 1 5)")" rerun
check "timed out on the first attempt: rerun" "$(state MERGEABLE 40 "$(ci completed timed_out 1 5)")" rerun
check "startup failure on the first attempt: rerun" "$(state MERGEABLE 40 "$(ci completed startup_failure 1 5)")" rerun
check "cancelled again after a rerun: human" "$(state MERGEABLE 90 "$(ci completed cancelled 2 5)")" human

check "failed recently: the CI fixer's turn" "$(state MERGEABLE 40 "$(ci completed failure 1 30)")" wait
check "failed two hours ago with no fix pushed: human" "$(state MERGEABLE 200 "$(ci completed failure 1 121)")" human

check "green, no review yet: wait" "$(state MERGEABLE 40 "$(ci completed success 1 20)")" wait
check "green an hour ago, never reviewed: human" "$(state MERGEABLE 90 "$(ci completed success 1 61)")" human
check "Dependabot's own bump, green and unreviewed by design: the owner's turn" "$(state MERGEABLE 90 "$(ci completed success 1 61)" null false | jq -c '.reviewed = false')" ok
check "Dependabot's bump that failed still waits for the CI fixer" "$(state MERGEABLE 40 "$(ci completed failure 1 30)" null false | jq -c '.reviewed = false')" wait
check "reviewed and ready: the owner's turn" "$(state MERGEABLE 900 "$(ci completed success 1 800)" '{"verdict":"ready","age":700}')" ok
check "changes asked recently: wait for the rework" "$(state MERGEABLE 90 "$(ci completed success 1 70)" '{"verdict":"changes","age":30}')" wait
check "changes asked two hours ago, nothing pushed: human" "$(state MERGEABLE 300 "$(ci completed success 1 250)" '{"verdict":"changes","age":121}')" human
check "changes asked on an autofix-only PR: the owner's turn, not stuck" "$(state MERGEABLE 300 "$(ci completed success 1 250)" '{"verdict":"changes","age":121}' false)" ok
check "an autofix-only PR still gets a cancelled CI rerun" "$(state MERGEABLE 40 "$(ci completed cancelled 1 5)" null false)" rerun

reason=$("$here/sweep-prs.sh" --decide <<<"$(state MERGEABLE 40 "$(ci completed cancelled 1 5)")" | jq -r .reason)
case "$reason" in *cancelled*) ;; *) fail "the reason names the conclusion: got [$reason]" ;; esac

# The sweeper reads the verdict from the heading post-review.sh writes, and finds the review of the
# head commit by the SHA in its footer. If either changes, every reviewed pull request would read as
# `changes` or unreviewed. Pin them together.
poster="$here/post-review.sh"
if ! grep -qF "verdict=ready heading='✅ Ready for you'" "$poster" ||
  ! grep -qF "printf '%s\n### Factory review: %s\n\n%s\n\n<sub>Commit %s," "$poster" ||
  ! grep -qF '<!-- factory-review -->\\n### Factory review: ✅ Ready for you' "$here/sweep-prs.sh"; then
  fail "the review comment post-review.sh writes and what sweep-prs.sh matches have drifted apart"
fi

# The sweep end to end, against a stand-in gh that answers from canned JSON and applies --jq as
# gh would. #1's commit lookup fails, which mustn't stop the rest. #2 is green and the reviewer's
# comment names its head commit, in the footer post-review.sh writes. #3 is green and its only review
# is of an older commit, which doesn't count.
long_ago=$(date -u -d '-3 hours' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-3H +%Y-%m-%dT%H:%M:%SZ)
review() { # review <sha>: the comment post-review.sh posts, verdict ready
  printf '<!-- factory-review -->\n### Factory review: %s\n\nLooks right.\n\n<sub>Commit %s, reviewed by the factory'"'"'s reviewer agent (ADR-0026). It never approves; the owner merges.</sub>\n' \
    '✅ Ready for you' "$1"
}
jq -n --arg t "$long_ago" '[{number:1,mergeable:"MERGEABLE",headRefOid:"aaa",labels:[{name:"factory"}],author:{login:"app/claude"}},
  {number:2,mergeable:"MERGEABLE",headRefOid:"bbb",labels:[{name:"factory"}],author:{login:"app/claude"}},
  {number:3,mergeable:"MERGEABLE",headRefOid:"ccc",labels:[{name:"factory"}],author:{login:"app/claude"}}]' >"$work/prs.json"
jq -n --arg t "$long_ago" '[{databaseId:9,status:"completed",conclusion:"success",attempt:1,startedAt:$t,updatedAt:$t}]' >"$work/run.json"
jq -n --arg t "$long_ago" --arg b "$(review bbb)" '[{user:{login:"github-actions[bot]"},body:$b,updated_at:$t}]' >"$work/comments-2.json"
jq -n --arg t "$long_ago" --arg b "$(review old)" '[{user:{login:"github-actions[bot]"},body:$b,updated_at:$t}]' >"$work/comments-3.json"
jq -n --arg t "$long_ago" '{commit:{committer:{date:$t}}}' >"$work/commit.json"
fake_gh <<'ROUTES'
  "pr list"*) answer prs.json ;;
  "run list"*) answer run.json ;;
  "api repos/o/r/commits/aaa"*) refuse ;;
  "api repos/o/r/commits/"*) answer commit.json ;;
  "api repos/o/r/issues/2/comments"*) answer comments-2.json ;;
  "api repos/o/r/issues/3/comments"*) answer comments-3.json ;;
ROUTES
status=0
output=$(GH=$work/gh GITHUB_REPOSITORY=o/r DRY_RUN=true "$here/sweep-prs.sh" 2>&1) || status=$?
expect_in "a failing pull request is reported and the sweep carries on" "$output" "Couldn't sweep #1"
expect_in "a review naming the head commit, in post-review.sh's footer, reads as ready" "$output" "#2 bbb: ok"
expect_in "a review of an older commit doesn't count" "$output" "#3 ccc: human"
[ "$status" -ne 0 ] || fail "a sweep with a failed pull request exits 0"

# A conflicting factory pull request starts the resolver, unless a resolver run is already queued or
# running: another would wait in the branch's concurrency group and could cancel a pending rework.
echo '[]' >"$work/empty.json"
fake_gh "$work/gh2" <<'ROUTES'
  "run list"*resolve-conflicts.yml*) jq -rc "$filter" <<<"$RESOLVER" ;;
  "run list"*) answer empty.json ;;
  "api repos/o/r/commits/"*) answer commit.json ;;
  "api repos/o/r/issues/"*) answer empty.json ;;
ROUTES
conflicting='{"number":4,"mergeable":"CONFLICTING","sha":"ddd","factory":true,"dependabot":false}'
sweep_one() { # sweep_one <resolver runs JSON>
  : >"$work/calls"
  RESOLVER=$1 GH=$work/gh2 GITHUB_REPOSITORY=o/r "$here/sweep-prs.sh" --one "$conflicting" >/dev/null 2>&1
}
sweep_one '[{"status":"completed"}]'
grep -q "workflow run resolve-conflicts.yml -R o/r --ref main -f pr=4" "$work/calls" ||
  fail "a conflicting factory pull request starts the resolver for it"
! grep -q "needs-human" "$work/calls" || fail "a conflict sent to the resolver isn't labeled needs-human"
sweep_one '[{"status":"in_progress"}]'
! grep -q "workflow run" "$work/calls" || fail "no second resolver is queued while one is running"
sweep_one '[{"status":"queued"}]'
! grep -q "workflow run" "$work/calls" || fail "no second resolver is queued while one is queued"

# A pull request handed to a human shows the factory done with its commit (ADR-0063).
: >"$work/calls"
RESOLVER='[]' GH=$work/gh2 GITHUB_REPOSITORY=o/r "$here/sweep-prs.sh" --one \
  '{"number":6,"mergeable":"MERGEABLE","sha":"eee","factory":true,"dependabot":false}' >/dev/null 2>&1
grep -q "pr edit 6 -R o/r --add-label needs-human" "$work/calls" || fail "a stuck pull request is labeled needs-human"
grep -q "statuses/eee -f context=factory -f state=success -f description=Done: over to you" "$work/calls" ||
  fail "a stuck pull request's factory status says it's the owner's turn"

finish "All sweeper decisions pass."
