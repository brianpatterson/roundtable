#!/usr/bin/env bash
# Checks the sweeper's decisions (ADR-0040): each case is a pull request's state and the action it
# must get. Run from anywhere: .github/factory/test-sweep-prs.sh
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
failures=0

check() { # check <name> <state JSON> <expected action>
  got=$("$here/sweep-prs.sh" --decide <<<"$2" | jq -r .action)
  if [ "$got" != "$3" ]; then
    echo "FAIL: $1: expected $3, got $got"
    failures=$((failures + 1))
  fi
}

ci() { # ci <status> <conclusion> <attempt> <age>
  printf '{"status":"%s","conclusion":"%s","attempt":%s,"age":%s}' "$1" "$2" "$3" "$4"
}
state() { # state <mergeable> <head age> <ci JSON or null> [review JSON] [factory: true|false]
  printf '{"factory":%s,"mergeable":"%s","head_age":%s,"ci":%s,"review":%s}' "${5:-true}" "$1" "$2" "$3" "${4:-null}"
}

check "a conflict goes to a human, whatever CI says" "$(state CONFLICTING 5 "$(ci completed success 1 5)")" human
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
check "reviewed and ready: the owner's turn" "$(state MERGEABLE 900 "$(ci completed success 1 800)" '{"verdict":"ready","age":700}')" ok
check "changes asked recently: wait for the rework" "$(state MERGEABLE 90 "$(ci completed success 1 70)" '{"verdict":"changes","age":30}')" wait
check "changes asked two hours ago, nothing pushed: human" "$(state MERGEABLE 300 "$(ci completed success 1 250)" '{"verdict":"changes","age":121}')" human
check "changes asked on an autofix-only PR: the owner's turn, not stuck" "$(state MERGEABLE 300 "$(ci completed success 1 250)" '{"verdict":"changes","age":121}' false)" ok
check "an autofix-only PR still gets a cancelled CI rerun" "$(state MERGEABLE 40 "$(ci completed cancelled 1 5)" null false)" rerun

reason=$("$here/sweep-prs.sh" --decide <<<"$(state MERGEABLE 40 "$(ci completed cancelled 1 5)")" | jq -r .reason)
case "$reason" in *cancelled*) ;; *)
  echo "FAIL: the reason names the conclusion: got [$reason]"
  failures=$((failures + 1))
  ;;
esac

# One pull request whose lookups fail doesn't stop the sweep for the rest. A stand-in gh lists
# two; GitHub refuses #1's commit.
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cat >"$work/gh" <<'GH'
#!/usr/bin/env bash
case "$1 $2" in
  "pr list") echo '[{"number":1,"mergeable":"MERGEABLE","sha":"aaa","factory":true},{"number":2,"mergeable":"MERGEABLE","sha":"bbb","factory":true}]' ;;
  "api repos/o/r/commits/aaa") echo "GitHub says no" >&2; exit 1 ;;
  "api repos/o/r/commits/bbb") date -u +%Y-%m-%dT%H:%M:%SZ ;;
  *) ;; # no CI run, no review
esac
GH
chmod +x "$work/gh"
status=0
output=$(GH=$work/gh GITHUB_REPOSITORY=o/r DRY_RUN=true "$here/sweep-prs.sh" 2>&1) || status=$?
case "$output" in *"#2 bbb: wait"*) ;; *)
  echo "FAIL: a failing pull request stops the sweep: got [$output]"
  failures=$((failures + 1))
  ;;
esac
case "$output" in *"Couldn't sweep #1"*) ;; *)
  echo "FAIL: a failing pull request isn't reported: got [$output]"
  failures=$((failures + 1))
  ;;
esac
if [ "$status" -eq 0 ]; then
  echo "FAIL: a sweep with a failed pull request exits 0"
  failures=$((failures + 1))
fi

if [ "$failures" -gt 0 ]; then
  echo "$failures failed."
  exit 1
fi
echo "All sweeper decisions pass."
