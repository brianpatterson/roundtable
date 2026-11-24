#!/usr/bin/env bash
# Checks when the architecture review runs (ADR-0067) against a stand-in gh.
# Run from anywhere: .github/factory/test-select-architecture.sh
# shellcheck source=.github/factory/testlib.sh
. "$(dirname "$0")/testlib.sh"

fake_gh <<'ROUTES'
  "run list -R owner/repo --workflow architecture.yml --status success"*) answer runs.json ;;
ROUTES

run() { # run <sha>; sets status, out and selected (true when the review runs)
  rm -f "$work/output"
  status=0
  out=$(GH="$work/gh" GITHUB_REPOSITORY=owner/repo GITHUB_OUTPUT="$work/output" "$here/select-architecture.sh" "$@" 2>&1) || status=$?
  selected=$(sed -n 's/^run=//p' "$work/output" 2>/dev/null || true)
}

echo '[]' >"$work/runs.json"
run abc1234def
expect "runs when no review has succeeded yet" true "$selected"
expect_in "names the commit" "$out" "abc1234"

echo '[{"headSha":"old","url":"https://x/runs/1"}]' >"$work/runs.json"
run abc1234def
expect "runs when main changed since the last review" true "$selected"

echo '[{"headSha":"old","url":"https://x/runs/1"},{"headSha":"abc1234def","url":"https://x/runs/2"}]' >"$work/runs.json"
run abc1234def
expect "exits 0 when skipping" 0 "$status"
expect "skips when a review already succeeded on this commit" "" "$selected"
expect_in "links the review that covered it" "$out" "https://x/runs/2"

rm "$work/runs.json"
run abc1234def
expect "fails when GitHub can't list the runs, rather than guessing" 1 "$status"
expect "and selects nothing" "" "$selected"

finish "select-architecture.sh: all checks passed."
