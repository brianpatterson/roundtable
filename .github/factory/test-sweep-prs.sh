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
state() { # state <mergeable> <head age> <ci JSON or null> [review JSON]
  printf '{"mergeable":"%s","head_age":%s,"ci":%s,"review":%s}' "$1" "$2" "$3" "${4:-null}"
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

reason=$("$here/sweep-prs.sh" --decide <<<"$(state MERGEABLE 40 "$(ci completed cancelled 1 5)")" | jq -r .reason)
case "$reason" in *cancelled*) ;; *)
  echo "FAIL: the reason names the conclusion: got [$reason]"
  failures=$((failures + 1))
  ;;
esac

if [ "$failures" -gt 0 ]; then
  echo "$failures failed."
  exit 1
fi
echo "All sweeper decisions pass."
