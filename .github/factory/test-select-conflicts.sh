#!/usr/bin/env bash
# Checks which pull requests the conflict resolver takes (ADR-0058), against a stand-in gh that
# answers from canned JSON. Run from anywhere: .github/factory/test-select-conflicts.sh
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
failures=0
fail() { echo "FAIL: $1"; failures=$((failures + 1)); }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

pr() { # pr <number> <mergeable> [labels JSON] [state] [fork]
  jq -n --argjson n "$1" --arg m "$2" --argjson l "${3:-[\"factory\"]}" --arg s "${4:-OPEN}" --argjson f "${5:-false}" \
    '{state: $s, mergeable: $m, headRefOid: "sha\($n)", headRefName: "claude/issue-\($n)-x", isCrossRepository: $f, labels: ($l | map({name: .}))}' \
    >"$work/pr-$1.json"
}
attempt() { # attempt <pr> <main sha>: a comment the resolver posted
  jq --arg b "$(printf '<!-- factory-conflict -->\n### Conflict with main, attempt 1: the run failed; the next one retries\n\nIt crashed.\n\n<sub>[Run](https://x), merging main at %s into commit abc. ADR-0058.</sub>\n' "$2")" \
    '. + [{user: {login: "github-actions[bot]"}, body: $b}]' "$work/comments-$1.json" >"$work/c" && mv "$work/c" "$work/comments-$1.json"
}

pr 1 CONFLICTING                               # selected, first attempt
pr 2 CONFLICTING                               # one attempt against this main already: the second
pr 3 CONFLICTING                               # two against this main: to a human
pr 4 CONFLICTING                               # two against an older main: a fresh start
pr 5 MERGEABLE                                 # no conflict
pr 6 CONFLICTING '["factory","needs-human"]'   # waiting for a human
pr 7 CONFLICTING '["autofix"]'                 # not the factory's
pr 8 CONFLICTING '["factory"]' OPEN true       # a fork
pr 9 UNKNOWN                                   # CONFLICTING once GitHub has worked it out
for n in 1 2 3 4 5 6 7 8 9; do echo '[]' >"$work/comments-$n.json"; done
attempt 2 main1
attempt 3 main1
attempt 3 main1
attempt 4 main0
attempt 4 main0
jq -n '[{user: {login: "someone"}, body: "<!-- factory-conflict --> main1"}, {user: {login: "someone"}, body: "<!-- factory-conflict --> main1"}]' >"$work/comments-1.json"

cat >"$work/gh" <<'GH'
#!/usr/bin/env bash
filter=.
prev=
for arg in "$@"; do [ "$prev" = --jq ] && filter=$arg; prev=$arg; done
case "$*" in
  "api repos/o/r/commits/main"*) echo main1; exit 0 ;;
  "pr list"*) echo '1 2 3 4 5 6 7 8 9' | tr ' ' '\n'; exit 0 ;;
  "pr view 9"*)
    # UNKNOWN the first time, CONFLICTING after.
    if [ -f "$WORK/seen-9" ]; then jq '.mergeable = "CONFLICTING"' "$WORK/pr-9.json"; else touch "$WORK/seen-9"; cat "$WORK/pr-9.json"; fi
    exit 0 ;;
  "pr view "*) cat "$WORK/pr-$3.json"; exit 0 ;;
  "api repos/o/r/issues/"*"/comments"*) n=${2#repos/o/r/issues/}; jq -c "$filter" "$WORK/comments-${n%%/*}.json"; exit 0 ;;
  *) echo "$*" >>"$WORK/writes" ;;
esac
GH
chmod +x "$work/gh"
: >"$work/writes"

out=$(WORK=$work GH=$work/gh GITHUB_REPOSITORY=o/r SLEEP=0 "$here/select-conflicts.sh" 2>"$work/log")
writes=$(cat "$work/writes")
picked=$(jq -c 'map({(.pr | tostring): .attempt}) | add // {}' <<<"$out")

[ "$(jq -r '."1"' <<<"$picked")" = 1 ] || fail "a conflicting factory pull request is taken, attempt 1 (others' comments don't count): $picked"
[ "$(jq -r '."2"' <<<"$picked")" = 2 ] || fail "one attempt against this main makes the next the second: $picked"
[ "$(jq -r '."3"' <<<"$picked")" = null ] || fail "two attempts against this main aren't followed by a third: $picked"
grep -q "pr edit 3 -R o/r --add-label needs-human" <<<"$writes" || fail "two attempts against this main go to a human"
grep -q "pr comment 3 -R o/r" <<<"$writes" || fail "the hand-over says why"
[ "$(jq -r '."4"' <<<"$picked")" = 1 ] || fail "attempts against an older main don't count: $picked"
for n in 5 6 7 8; do
  [ "$(jq -r ".\"$n\"" <<<"$picked")" = null ] || fail "#$n is skipped: $picked"
done
[ "$(jq -r '."9"' <<<"$picked")" = 1 ] || fail "an UNKNOWN mergeability is checked again until GitHub knows: $picked"
! grep -qE "pr (edit|comment) [^3]" <<<"$writes" || fail "nothing else is labeled or commented: $writes"
[ "$(jq -r '.[0] | "\(.sha) \(.branch)"' <<<"$out")" = "sha1 claude/issue-1-x" ] || fail "the head and branch are passed on: $out"

# One pull request, named by the sweeper.
out=$(WORK=$work GH=$work/gh GITHUB_REPOSITORY=o/r SLEEP=0 "$here/select-conflicts.sh" 5 2>/dev/null)
[ "$out" = '[]' ] || fail "a named pull request without a conflict gives an empty list: $out"
out=$(WORK=$work GH=$work/gh GITHUB_REPOSITORY=o/r SLEEP=0 MAIN=main0 "$here/select-conflicts.sh" 1 2>/dev/null)
[ "$(jq -c '[.[].pr]' <<<"$out")" = '[1]' ] || fail "a named pull request is the only one checked, against MAIN: $out"

# select-conflicts.sh finds the resolver's comments by their marker and the main commit they name.
# If the comment report-conflict-attempt.sh posts changes either, attempts stop counting. Pin them.
reporter="$here/report-conflict-attempt.sh"
if ! grep -qF "body=\$(printf '<!-- factory-conflict -->\n###" "$reporter" ||
  ! grep -qF 'merging main at %s into commit %s.' "$reporter" ||
  ! grep -qF "marker='<!-- factory-conflict -->'" "$here/select-conflicts.sh"; then
  fail "the comment report-conflict-attempt.sh posts and what select-conflicts.sh counts have drifted apart"
fi

if [ "$failures" -gt 0 ]; then
  echo "$failures failed."
  exit 1
fi
echo "All conflict selections pass."
