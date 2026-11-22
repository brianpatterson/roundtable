#!/usr/bin/env bash
# Checks what the reviewer posts (ADR-0026, ADR-0046), against a stand-in gh that answers from
# canned comments and logs every call that changes something. Run from anywhere:
# .github/factory/test-post-review.sh
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
failures=0
fail() {
  echo "FAIL: $1"
  failures=$((failures + 1))
}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cat >"$work/gh" <<'GH'
#!/usr/bin/env bash
filter=.
prev=
for arg in "$@"; do [ "$prev" = --jq ] && filter=$arg; prev=$arg; done
case "$1 $2" in
  "api repos/o/r/issues/5/comments") jq -c "$filter" "$CASE/comments.json" ;;
  *) printf '%s\n' "$*" >>"$CASE/calls" ;;
esac
GH
chmod +x "$work/gh"

review() { # review <heading> <sha>: the main comment post-review.sh writes
  printf '<!-- factory-review -->\n### Factory review: %s\n\nSome findings.\n\n<sub>Commit %s, reviewed by the factory'"'"'s reviewer agent (ADR-0026). It never approves; the owner merges.</sub>\n' "$1" "$2"
}
nudge() { printf '<!-- factory-review-changes -->\nRe-reviewed %s: ✋ changes needed.\n' "$1"; }

# run <name> <verdict> <sha> [comment JSON...]: posts a review of commit <sha> on #5, whose
# comments are the given ones.
run() {
  CASE="$work/$1"
  mkdir -p "$CASE"
  : >"$CASE/calls"
  shift
  local verdict=$1 sha=$2
  shift 2
  jq -s . <<<"${*:-}" >"$CASE/comments.json"
  CASE=$CASE GH=$work/gh GITHUB_REPOSITORY=o/r PR=5 SHA=$sha GITHUB_SERVER_URL=https://github.com \
    RESULT=$(jq -n --arg v "$verdict" '{verdict: $v, review: "Some findings."}') \
    "$here/post-review.sh" >/dev/null || fail "$CASE: post-review.sh exited $?"
  calls=$(cat "$CASE/calls")
}
comment() { # comment <id> <body> [login]
  jq -nc --argjson id "$1" --arg b "$2" --arg u "${3:-github-actions[bot]}" '{id: $id, user: {login: $u}, body: $b}'
}
has() { case "$calls" in *"$1"*) ;; *) return 1 ;; esac }
posts() { grep -c '^pr comment' <<<"$calls" || true; }

old=1111111aaaa
new=2222222bbbb

run first-changes changes "$new"
has "pr comment 5 -R o/r --body <!-- factory-review -->" || fail "a first review is a new comment"
[ "$(posts)" = 1 ] || fail "a first review posts nothing else, even asking for changes"

run rereview-changes changes "$new" "$(comment 10 "$(review '✅ Ready for you' "$old")")"
has "api -X PATCH repos/o/r/issues/comments/10" || fail "a re-review edits the review in place"
has "<!-- factory-review-changes -->"$'\n'"Re-reviewed 2222222: ✋ changes needed. See [the factory review](https://github.com/o/r/pull/5#issuecomment-10)" ||
  fail "a re-review asking for changes posts a short new comment that links the review: [$calls]"
[ "$(posts)" = 1 ] || fail "a re-review posts only the short comment"

run rereview-changes-again changes "$new" "$(comment 10 "$(review '✋ Changes needed' "$old")")" "$(comment 11 "$(nudge 1111111)")"
has "api -X DELETE repos/o/r/issues/comments/11" || fail "the earlier short comment is deleted"
[ "$(posts)" = 1 ] || fail "a changes re-review of a new commit posts a fresh short comment"

run rereview-ready ready "$new" "$(comment 10 "$(review '✋ Changes needed' "$old")")" "$(comment 11 "$(nudge 1111111)")"
has "api -X PATCH repos/o/r/issues/comments/10" || fail "a ready re-review edits the review"
has "api -X DELETE repos/o/r/issues/comments/11" || fail "a ready re-review deletes the stale short comment"
[ "$(posts)" = 0 ] || fail "a ready re-review posts nothing new"

run same-commit changes "$old" "$(comment 10 "$(review '✋ Changes needed' "$old")")" "$(comment 11 "$(nudge 1111111)")"
has "api -X PATCH repos/o/r/issues/comments/10" || fail "a repeat review still edits the review"
! has "DELETE" || fail "a repeat of the same verdict on the same commit keeps its short comment"
[ "$(posts)" = 0 ] || fail "a repeat of the same verdict on the same commit posts nothing new"

run same-commit-flip changes "$old" "$(comment 10 "$(review '✅ Ready for you' "$old")")"
[ "$(posts)" = 1 ] || fail "the same commit, now asking for changes after ready, posts a short comment"

run others changes "$new" "$(comment 9 "$(review '✅ Ready for you' "$old")" someone)" \
  "$(comment 12 "$(nudge 1111111)" someone)" "$(comment 10 "$(review '✅ Ready for you' "$old")")"
has "issues/comments/10" || fail "the workflow's own review is the one edited"
! has "issues/comments/9" || fail "someone else's lookalike review is left alone"
! has "issues/comments/12" || fail "someone else's lookalike short comment is left alone"

# Nothing that reads the main review may mistake the short comment for it: the sweeper, review.yml
# and rework.yml all find the review with startswith("<!-- factory-review -->").
case "$(nudge abc)" in "<!-- factory-review -->"*) fail "the short comment's marker starts like the review's" ;; esac

CASE="$work/bad" && mkdir -p "$CASE" && echo '[]' >"$CASE/comments.json"
if CASE=$CASE GH=$work/gh GITHUB_REPOSITORY=o/r PR=5 SHA=$new RESULT='{"verdict":"maybe","review":""}' \
  "$here/post-review.sh" 2>/dev/null; then
  fail "an unknown verdict fails"
fi

if [ "$failures" -gt 0 ]; then
  echo "$failures failed."
  exit 1
fi
echo "All review comment cases pass."
