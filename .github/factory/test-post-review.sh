#!/usr/bin/env bash
# Checks what the reviewer posts (ADR-0026, ADR-0046, ADR-0053), against a stand-in gh that answers from
# canned comments and logs every call that changes something. Run from anywhere:
# .github/factory/test-post-review.sh
# shellcheck source=.github/factory/testlib.sh
. "$(dirname "$0")/testlib.sh"

fake_gh <<'ROUTES'
  "api repos/o/r/issues/5/comments"*) answer comments.json ;;
ROUTES

review() { # review <heading> <sha>: the main comment post-review.sh writes
  printf '<!-- factory-review -->\n### Factory review: %s\n\nSome findings.\n\n<sub>Commit %s, reviewed by the factory'"'"'s reviewer agent (ADR-0026). It never approves; the owner merges.</sub>\n' "$1" "$2"
}
nudge() { printf '<!-- factory-review-changes -->\nRe-reviewed %s: ✋ changes needed.\n' "$1"; }

# run <name> <verdict> <sha> [comment JSON...]: posts a review of commit <sha> on #5, whose
# comments are the given ones. The reviewer reports one blocking finding for `changes`, none for
# `ready`; post_result posts any structured output.
run() {
  local name=$1 verdict=$2
  shift 2
  post_result "$name" "$(jq -n --argjson b "$([ "$verdict" = changes ] && echo 1 || echo 0)" '{blocking: $b, review: "Some findings."}')" "$@"
}
post_result() { # post_result <name> <RESULT> <sha> [comment JSON...]
  CASE="$work/$1"
  mkdir -p "$CASE"
  : >"$CASE/calls"
  : >"$CASE/output"
  local out=$CASE/output
  local result=$2 sha=$3
  shift 3
  jq -s . <<<"${*:-}" >"$CASE/comments.json"
  GH_FIXTURES=$CASE GH=$work/gh GITHUB_REPOSITORY=o/r PR=5 SHA=$sha GITHUB_SERVER_URL=https://github.com \
    GITHUB_OUTPUT=$out RESULT=$result \
    "$here/post-review.sh" >/dev/null || fail "$CASE: post-review.sh exited $?"
  calls=$(cat "$CASE/calls")
  output=$(cat "$CASE/output")
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

# The verdict follows the blocking findings (ADR-0053), whatever the count says.
result() { jq -n --argjson b "$1" --arg r "$2" '{blocking: $b, review: $r}'; }
findings=$'**Findings**\n1. **minor**: `a.ts:1` could be clearer.\n2. **minor**: `b.ts:2` too.'
blocker=$'**Findings**\n1. **minor**: `a.ts:1` could be clearer.\n2. **blocking**: A01 `b.ts:2` leaks rows.'

post_result counted-ready "$(result 0 "$findings")" "$new"
has "### Factory review: ✅ Ready for you" || fail "minor findings only are ready: [$calls]"
[ "$output" = $'verdict=ready\nminor=2' ] || fail "ready and the minor findings' count are written to GITHUB_OUTPUT: [$output]"

post_result counted-changes "$(result 1 "$blocker")" "$new"
has "### Factory review: ✋ Changes needed" || fail "a blocking finding needs changes"
[ "$output" = $'verdict=changes\nminor=1' ] || fail "changes and the minor findings' count are written to GITHUB_OUTPUT: [$output]"

post_result undercounted "$(result 0 "$blocker")" "$new"
has "### Factory review: ✋ Changes needed" || fail "a finding marked blocking needs changes even when the count says 0"
[ "${output%%$'\n'*}" = verdict=changes ] || fail "an undercount still records changes: [$output]"

post_result unmarked "$(result 2 "$findings")" "$new"
[ "${output%%$'\n'*}" = verdict=changes ] || fail "a blocking count needs changes even without markers: [$output]"

post_result prose "$(result 0 $'**Findings**\nNone.\n\nNothing here is **blocking** the merge.')" "$new"
[ "$output" = $'verdict=ready\nminor=0' ] || fail "the word blocking in prose isn't a finding, nor a missing list a minor one: [$output]"

# Follow-ups are for the owner to file, not findings: they start no minor rework pass.
post_result follow-ups "$(result 0 $'**Findings**\nNone.\n\n**Follow-ups**\n- **Plain reset message**: `Page.tsx:9` shows "Invalid token".\n- **Split the bucket**: `h.ts:51` shares it.')" "$new"
[ "$output" = $'verdict=ready\nminor=0' ] || fail "follow-ups count as no finding: [$output]"

CASE="$work/bad" && mkdir -p "$CASE" && echo '[]' >"$CASE/comments.json"
for bad in '{"verdict":"ready","review":""}' '{"blocking":-1,"review":""}' '{"blocking":1.5,"review":""}' '{"blocking":"1","review":""}'; do
  if GH_FIXTURES=$CASE GH=$work/gh GITHUB_REPOSITORY=o/r PR=5 SHA=$new RESULT=$bad \
    "$here/post-review.sh" 2>/dev/null; then
    fail "a result without a whole, non-negative blocking count fails: $bad"
  fi
done

finish "All review comment cases pass."
