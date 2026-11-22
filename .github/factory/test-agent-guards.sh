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

if [ "$failures" -gt 0 ]; then
  echo "$failures failed."
  exit 1
fi
echo "All agent guard checks pass."
