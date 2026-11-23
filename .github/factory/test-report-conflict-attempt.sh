#!/usr/bin/env bash
# Checks how the conflict resolver judges an attempt (ADR-0058): report-conflict-attempt.sh against
# a stand-in gh that answers the compare with canned JSON, or fails. Run from anywhere:
# .github/factory/test-report-conflict-attempt.sh
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
failures=0
fail() { echo "FAIL: $1"; failures=$((failures + 1)); }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cat >"$work/gh" <<'GH'
#!/usr/bin/env bash
case "$1 $2" in
  "api repos/o/r/compare/"*)
    [ -f "$WORK/compare.json" ] || { echo "GitHub says no" >&2; exit 1; }
    cat "$WORK/compare.json" ;;
  "pr comment") printf '%s\n' "$*" >>"$WORK/comments" ;;
  "pr view")
    [ "${HEAD_NOW:-abc}" != unreadable ] || { echo "GitHub says no" >&2; exit 1; }
    echo "${HEAD_NOW:-abc}" ;;
  *) echo "$*" >>"$WORK/writes" ;;
esac
GH
chmod +x "$work/gh"

compare() { # compare <behind_by> [file JSON objects…]: what GitHub answers; none at all with "fails"
  if [ "$1" = fails ]; then rm -f "$work/compare.json"; return; fi
  local behind=$1
  shift
  local files
  files=$(IFS=,; echo "[$*]")
  jq -n --argjson b "$behind" --argjson f "$files" '{behind_by: $b, files: $f}' >"$work/compare.json"
}
nopatch() { # nopatch <name> <changes>: a file GitHub shows no diff for
  jq -nc --arg n "$1" --argjson c "$2" '{filename: $n, changes: $c}'
}
file() { # file <name> [patch, with \n for newlines]
  jq -nc --arg n "$1" --arg p "$(printf '%b' "${2:-@@ -1 +1 @@\n+fine}")" '{filename: $n, patch: $p, changes: 1}'
}
status=0
run() { # run <attempt> <agent result JSON or "">: sets status, writes, comments
  : >"$work/writes"
  : >"$work/comments"
  status=0
  WORK=$work GH=$work/gh GUARD=$here/guard-secrets.sh RESULT=$2 REASON='' PR=7 SHA=abc BRANCH=b MAIN=m1 \
    ATTEMPT=$1 GITHUB_REPOSITORY=o/r GITHUB_SERVER_URL=https://x GITHUB_RUN_ID=9 \
    "$here/report-conflict-attempt.sh" >/dev/null 2>&1 || status=$?
}
labeled() { grep -q "pr edit 7 -R o/r --add-label needs-human" "$work/writes"; }
said() { grep -qF -- "$1" "$work/comments"; }
resolved='{"outcome":"resolved","summary":"Renumbered ADR-0057 to 0059."}'

compare 0 "$(file docs/adr/0059-a.md)"
run 1 "$resolved"
[ "$status" -eq 0 ] && ! labeled && said "merged main and pushed" || fail "a clean resolution is reported, unlabeled"
said "Renumbered ADR-0057 to 0059." || fail "the agent's summary is posted"
said "<!-- factory-conflict -->" && said "merging main at m1 into commit abc." || fail "the comment carries the marker and main's commit"

compare 1 "$(file docs/adr/0059-a.md)"
run 1 "$resolved"
labeled && said "isn't merged into the branch" || fail "a resolution without main in the branch goes to a human"

compare 0 "$(file README.md '@@ -1,3 +1,5 @@\n context\n+<<<<<<< HEAD\n+ours')"
run 1 "$resolved"
labeled && said "conflict markers" || fail "a merge with conflict markers goes to a human"

compare 0 "$(file README.md '@@ -1 +1 @@\n-<<<<<<< old\n+text with <<<<<<< inside')"
run 1 "$resolved"
! labeled || fail "markers only removed, or mid-line, aren't conflict markers"

compare 0 "$(file docs/a.md)" "$(file .github/workflows/ci.yml)"
run 1 "$resolved"
[ "$status" -eq 1 ] && labeled && said "may not touch" || fail "a change to .github/ fails the step and goes to a human"
compare 0 "$(file CLAUDE.md)"
run 1 "$resolved"
[ "$status" -eq 1 ] || fail "a change to CLAUDE.md fails the step"
compare 0 "$(file .claude/settings.json)"
run 1 ''
[ "$status" -eq 1 ] && labeled || fail "a crashed run that pushed to .claude/ still fails the step and goes to a human"

compare 0
run 1 ''
[ "$status" -eq 0 ] && ! labeled && said "the next one retries" || fail "a first crash is left for the retry, unlabeled"
said "stopped without a summary" || fail "a crash says it stopped without a summary"
run 2 ''
labeled && said "failed twice" || fail "a second crash goes to a human"

run 1 '{"outcome":"needs-human","summary":"Both sides changed the same rule."}'
labeled && said "over to you" && said "Both sides changed the same rule." || fail "the agent's needs-human goes to a human with its reasons"

compare fails
run 1 "$resolved"
labeled && said "couldn't compare" || fail "a failed compare after a resolution goes to a human"
run 1 ''
labeled && said "couldn't compare" || fail "a failed compare after a crash goes to a human, not to a retry"
echo '{"message":"Not Found"}' >"$work/compare.json"
run 1 "$resolved"
labeled && said "couldn't compare" || fail "an answer without behind_by counts as a failed compare"

compare 0 "$(file docs/a.md)"
run 1 "{\"outcome\":\"resolved\",\"summary\":\"key ghp_$(printf 'a%.0s' {1..36})\"}"
said "withheld" && ! said "ghp_" || fail "a summary with a credential is withheld"

# The agent pushed, then crashed before answering: the push is checked all the same, since the
# pull request no longer conflicts and no later run would look at it.
compare 0 "$(file docs/a.md)"
HEAD_NOW=def run 1 ''
! labeled && said "merged main and pushed" && said "stopped without answering" ||
  fail "a crash after a clean push counts as resolved, saying so"
compare 0 "$(file README.md '@@ -1 +1,2 @@\n+>>>>>>> main')"
HEAD_NOW=def run 1 ''
labeled && said "conflict markers" || fail "a crash after a push with conflict markers goes to a human"
compare 1 "$(file docs/a.md)"
HEAD_NOW=def run 1 ''
labeled && said "isn't merged" || fail "a crash after a push without main goes to a human"
compare 0 "$(file docs/a.md)"
HEAD_NOW=unreadable run 1 ''
! labeled && said "stopped without answering" || fail "an unreadable head counts as moved, so the push is checked"

# Files GitHub shows no diff for can't be checked for markers.
compare 0 "$(file docs/a.md)" "$(nopatch docs/big.md 4000)"
run 1 "$resolved"
labeled && said "showed no diff" || fail "a changed file without a patch goes to a human"
compare 0 "$(nopatch docs/adr/0059-a.md 0)"
run 1 "$resolved"
! labeled || fail "a pure rename, with no patch and no changes, is fine"
jq -n '{behind_by: 0, files: [range(300) | {filename: "f\(.).md", patch: "@@ -1 +1 @@\n+fine", changes: 1}]}' >"$work/compare.json"
run 1 "$resolved"
labeled && said "showed no diff" || fail "a compare listing 300 files counts as unchecked"
compare 0 "$(nopatch docs/big.md 4000)"
run 1 ''
! labeled && said "the next one retries" || fail "a crash that pushed nothing isn't judged on the pull request's own files"

if [ "$failures" -gt 0 ]; then
  echo "$failures failed."
  exit 1
fi
echo "All conflict attempt reports pass."
