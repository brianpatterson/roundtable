#!/usr/bin/env bash
# Checks the guards every agent job in factory.yml runs after its agent (ADR-0029, ADR-0048):
# takedown-credentials.sh and flag-suspicious.sh, against a stand-in gh, and explain-failure.sh on
# a canned output file. Run from anywhere: .github/factory/test-agent-guards.sh
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
failures=0
fail() { echo "FAIL: $1"; failures=$((failures + 1)); }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
token="ghp_$(printf 'a%.0s' {1..36})"
# Issue 5 has a clean comment of the agent's (1), one with a token (2) and one by someone else with
# a token (3, not the agent's: left alone). PR 7's description is clean, PR 8's holds a token.
jq -n --arg t "$token" '[{id:1,user:{login:"claude[bot]"},body:"done"},{id:2,user:{login:"claude[bot]"},body:("key " + $t)},{id:3,user:{login:"someone"},body:$t}]' >"$work/comments.json"
cat >"$work/gh" <<GH
#!/usr/bin/env bash
filter=.
prev=
for arg in "\$@"; do [ "\$prev" = --jq ] && filter=\$arg; prev=\$arg; done
case "\$*" in
  "api repos/o/r/issues/5/comments"*) jq -rc "\$filter" "$work/comments.json" ;;
  "api repos/o/r/issues/comments/1"*) echo done ;;
  "api repos/o/r/issues/comments/2"*) echo "key $token" ;;
  "pr view 7"*) echo "Closes #5" ;;
  "pr view 8"*) echo "Closes #5 $token" ;;
  *) echo "\$*" >>"$work/writes" ;;
esac
GH
chmod +x "$work/gh"
: >"$work/writes"

status=0
GH=$work/gh GITHUB_REPOSITORY=o/r NUMBER=5 PRS="7 8 8" "$here/takedown-credentials.sh" >/dev/null 2>&1 || status=$?
writes=$(cat "$work/writes")
[ "$status" -ne 0 ] || fail "a leak fails the step"
grep -q "api -X DELETE repos/o/r/issues/comments/2" <<<"$writes" || fail "the agent's comment with a token is deleted"
! grep -q "comments/1\$\|comments/3" <<<"$writes" || fail "a clean comment, or someone else's, is left alone"
grep -q "pr edit 8 -R o/r --body" <<<"$writes" || fail "a description with a token is replaced"
! grep -q "pr edit 7" <<<"$writes" || fail "a clean description is left alone"
[ "$(grep -c "pr edit 8" <<<"$writes")" = 1 ] || fail "a pull request listed twice is checked once"

: >"$work/writes"
status=0
GH=$work/gh GITHUB_REPOSITORY=o/r NUMBER=6 PRS="" "$here/takedown-credentials.sh" >/dev/null 2>&1 || status=$?
[ "$status" -eq 0 ] || fail "nothing to take down passes"

: >"$work/writes"
status=0
GH=$work/gh GITHUB_REPOSITORY=o/r GITHUB_SERVER_URL=https://github.com GITHUB_RUN_ID=9 NUMBER=5 "$here/flag-suspicious.sh" || status=$?
[ "$status" -ne 0 ] || fail "flagging a suspicious run fails the step"
grep -q "issue edit 5 -R o/r --add-label needs-human" "$work/writes" || fail "a suspicious run is labeled needs-human"
grep -q "actions/runs/9" "$work/writes" || fail "the comment links the run"

echo '[{"type":"result","result":"model not found"}]' >"$work/claude-execution-output.json"
output=$(RUNNER_TEMP=$work GITHUB_STEP_SUMMARY=$work/summary "$here/explain-failure.sh" fixer)
case "$output" in *"The fixer failed: model not found"*) ;; *) fail "the failure names who failed and why: [$output]" ;; esac
grep -q "model not found" "$work/summary" || fail "the reason goes in the step summary"

# The reason is also an output, for the summary the workflow posts; a failure leaves no result.
: >"$work/out"
RUNNER_TEMP=$work GITHUB_STEP_SUMMARY=$work/summary GITHUB_OUTPUT=$work/out "$here/explain-failure.sh" agent >/dev/null
grep -qx "reason=model not found" "$work/out" || fail "the reason is an output: [$(cat "$work/out")]"
! grep -q "^result=" "$work/out" || fail "a failure recovers no answer"

# Over the turn cap: the agent answered (#132), and the action dropped its structured_output.
# The answer is recovered whether the CLI put it in structured_output or in result as JSON text.
for last in \
  '{"type":"result","subtype":"success","num_turns":179,"structured_output":{"outcome":"built","branch":"claude/issue-1-x","summary":"Opened #2.\nDone."}}' \
  '{"type":"result","subtype":"success","num_turns":179,"result":"{\"outcome\":\"built\",\"branch\":\"claude/issue-1-x\",\"summary\":\"Opened #2.\\nDone.\"}"}'; do
  echo "[{\"type\":\"system\"},$last]" >"$work/claude-execution-output.json"
  : >"$work/out"
  output=$(RUNNER_TEMP=$work GITHUB_STEP_SUMMARY=$work/summary GITHUB_OUTPUT=$work/out "$here/explain-failure.sh" agent)
  result=$(sed -n 's/^result=//p' "$work/out")
  [ "$(jq -r .branch <<<"$result" 2>/dev/null)" = claude/issue-1-x ] || fail "an answer over the turn cap is recovered: [$result]"
  [ "$(grep -c . "$work/out")" = 2 ] || fail "a multi-line summary stays on one output line: [$(cat "$work/out")]"
  grep -q "^reason=.*179 turns" "$work/out" || fail "the reason names the turns"
  case "$output" in *"::warning::"*) ;; *) fail "a recovered run is a warning, not an error: [$output]" ;; esac
done

# Out of turns before answering, or an answer that isn't an object: nothing to recover.
for last in \
  '{"type":"result","subtype":"error_max_turns","num_turns":150,"errors":["Reached maximum number of turns (150)"]}' \
  '{"type":"result","subtype":"success","result":"Done, no JSON."}'; do
  echo "[$last]" >"$work/claude-execution-output.json"
  : >"$work/out"
  RUNNER_TEMP=$work GITHUB_STEP_SUMMARY=$work/summary GITHUB_OUTPUT=$work/out "$here/explain-failure.sh" agent >/dev/null
  ! grep -q "^result=" "$work/out" || fail "nothing is recovered from $last"
  grep -q "^reason=." "$work/out" || fail "a reason is given for $last"
done
grep -q "maximum number of turns" "$work/summary" || fail "running out of turns says so"

rm "$work/claude-execution-output.json"
: >"$work/out"
RUNNER_TEMP=$work GITHUB_OUTPUT=$work/out "$here/explain-failure.sh" agent >/dev/null
grep -qx "reason=it failed before writing its output" "$work/out" || fail "no output file still gives a reason"

if [ "$failures" -gt 0 ]; then
  echo "$failures failed."
  exit 1
fi
echo "All agent guard checks pass."
