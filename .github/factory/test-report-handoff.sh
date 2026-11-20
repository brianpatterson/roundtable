#!/usr/bin/env bash
# Checks the user-report hand-off (ADR-0041): fetch-report.sh against a stand-in curl, and
# guard-report-text.sh against text that does and doesn't quote a report.
# Run from anywhere: .github/factory/test-report-handoff.sh
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
failures=0
fail() {
  echo "FAIL: $1"
  failures=$((failures + 1))
}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

ID=0b6e7c1a-1111-4222-8333-444455556666

# A stand-in curl: answers by the id at the end of the URL, and only to the right token, which it
# reads from the header on stdin, as fetch-report.sh sends it.
cat >"$work/curl" <<'CURL'
#!/usr/bin/env bash
out= url=
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out=$2; shift 2 ;;
    -w|-H|--max-time) shift 2 ;;
    -*) shift ;;
    *) url=$1; shift ;;
  esac
done
header=$(cat)
[ "$header" = "Authorization: Bearer right-token" ] || { printf '{}' >"$out"; printf 401; exit 0; }
case "$url" in
  */0b6e7c1a-1111-4222-8333-444455556666)
    printf '{"id":"%s","description":"The list is empty after I add one","diagnostics":null}' "${url##*/}" >"$out"
    printf 200 ;;
  */unreachable) exit 7 ;;
  *) printf '{}' >"$out"; printf 404 ;;
esac
CURL
chmod +x "$work/curl"

fetch() { # fetch <title> <token>: runs fetch-report.sh into a fresh directory, prints the note
  rm -rf "$work/out" "$work/guard" "$work/prompt.md" "$work/output"
  : >"$work/prompt.md"
  : >"$work/output"
  TITLE=$1 TOKEN=$2 REPORTS_URL=https://app.test/api/factory/reports OUT="$work/out" \
    GUARD="$work/guard/description.txt" PROMPT="$work/prompt.md" CURL="$work/curl" GITHUB_OUTPUT="$work/output" \
    "$here/fetch-report.sh" >/dev/null 2>&1 ||
    fail "fetch-report.sh exited non-zero for [$1]"
  cat "$work/prompt.md"
}

note=$(fetch "User report $ID: /" right-token)
[ "$(cat "$work/guard/description.txt")" = "The list is empty after I add one" ] ||
  fail "the description is written for the guard"
[ ! -e "$work/out/description.txt" ] || fail "the guard's copy isn't in the directory the agent can edit"
[ "$(jq -r .id "$work/out/report.json")" = "$ID" ] || fail "the report is written as JSON"
grep -qx 'fetched=true' "$work/output" || fail "a fetched report tells the workflow to guard against quotes"
case "$note" in *"$work/out/report.json"*) ;; *) fail "the note tells the agent where the report is: [$note]" ;; esac
case "$note" in *"empty after"*) fail "the note never holds the user's words" ;; esac

expect_missing() { # expect_missing <name> <title> <token> <reason the note must give>
  note=$(fetch "$2" "$3")
  case "$note" in *"$4"*) ;; *) fail "$1: no [$4] in [$note]" ;; esac
  [ ! -f "$work/guard/description.txt" ] && [ ! -f "$work/out/report.json" ] ||
    fail "$1: no report is left behind"
  [ ! -s "$work/output" ] || fail "$1: no output says it was fetched"
}
expect_missing "a wrong token" "User report $ID: /" wrong-token "refused the token"
expect_missing "no token" "User report $ID: /" "" "no FACTORY_REPORTS_TOKEN"
expect_missing "an unknown report" "User report 0b6e7c1a-1111-4222-8333-000000000000: /" right-token "no report"
expect_missing "a title with no id" "Fix the list" right-token "names no report id"
expect_missing "an id with something after it" "User report $ID/../../x: /" right-token "names no report id"

# The guard.
printf 'The list is empty after I add an application, and my landlord Jane Doe said so\n' >"$work/description"
guard() { "$here/guard-report-text.sh" "$work/description" >/dev/null 2>&1; }

guard <<<"Fix: the list query ignored new rows. Adds a test." || fail "own words pass the guard"
! guard <<<"The user said: the list is empty after I add an application" ||
  fail "a quote is caught"
! guard <<<"THE LIST IS   EMPTY after I add an
application" || fail "a quote is caught across case and line breaks"
! guard <<<"// application, and my landlord Jane Doe said so" || fail "a quote at the end is caught"
printf 'it broke\n' >"$work/description"
guard <<<"it broke" || fail "a description too short to check passes"

# The take-down, against a stand-in gh that answers from canned JSON in $CASE, applies --jq as gh
# would, and logs every call that changes something.
cat >"$work/gh" <<'GH'
#!/usr/bin/env bash
filter=.
prev=
for arg in "$@"; do [ "$prev" = --jq ] && filter=$arg; prev=$arg; done
case "$1 $2 $3" in
  "api -X DELETE"* | "pr edit"* | "pr comment"* | "issue edit"* | "issue comment"*)
    printf '%s\n' "$*" >>"$CASE/calls"
    exit 0 ;;
esac
case "$1 $2" in
  "api repos/o/r/issues/7/comments") file=comments.json ;;
  "api repos/o/r/issues/comments/"*) file=comment-${2##*/}.json ;;
  "pr list") file=prs.json ;;
  "pr view") file=pr.json ;;
  "issue view") file=issue.json ;;
  "api repos/o/r/compare/"*) file=compare.json ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
[ -f "$CASE/$file" ] || { echo "GitHub says no" >&2; exit 1; }
jq -r "$filter" "$CASE/$file"
GH
chmod +x "$work/gh"
printf 'The list is empty after I add an application, my landlord Jane Doe\n' >"$work/description"

QUOTE="The user wrote: the list is empty after I add an application"

newcase() { # newcase <name>: canned answers for a run where nothing quotes the report
  CASE="$work/case-$1"
  mkdir -p "$CASE"
  : >"$CASE/calls"
  jq -n '[{id: 11, user: {login: "claude[bot]"}}, {id: 13, user: {login: "brianpatterson"}}]' >"$CASE/comments.json"
  jq -n '{body: "Fixed: new rows were filtered out."}' >"$CASE/comment-11.json"
  jq -n '[{number: 21}]' >"$CASE/prs.json"
  jq -n '{title: "fix: show new applications", body: "Closes #7"}' >"$CASE/pr.json"
  jq -n '{title: "User report 0b6e7c1a-1111-4222-8333-444455556666: /"}' >"$CASE/issue.json"
  jq -n '{files: [{patch: "@@ -1 +1 @@\n-old\n+const fresh = rows;"}, {filename: "image.png"}],
          commits: [{commit: {message: "fix: show new applications"}}]}' >"$CASE/compare.json"
}
takedown() { # takedown [branch]: runs the take-down for issue 7, returns its exit status
  GH="$work/gh" CASE=$CASE GITHUB_REPOSITORY=o/r NUMBER=7 BRANCH=${1-claude/issue-7} \
    DESCRIPTION="$work/description" "$here/takedown-report-quotes.sh" >/dev/null 2>&1
}
called() { grep -qF -- "$1" "$CASE/calls"; }

newcase clean
takedown || fail "nothing quoted: the take-down passes"
[ ! -s "$CASE/calls" ] || fail "nothing quoted: nothing is changed, got [$(cat "$CASE/calls")]"

newcase comment
jq -n '[{id: 11, user: {login: "claude[bot]"}}, {id: 12, user: {login: "claude[bot]"}}]' >"$CASE/comments.json"
jq -n --arg b "$QUOTE" '{body: $b}' >"$CASE/comment-12.json"
! takedown || fail "a quoting comment fails the run"
called "api -X DELETE repos/o/r/issues/comments/12" || fail "a quoting comment is deleted"
! called "comments/11" || fail "a clean comment is left alone"
called "pr edit 21 -R o/r --add-label needs-human" || fail "the pull request goes to a human"
called "A comment of the agent's quoted it" || fail "the note says a comment was deleted"

newcase title
jq -n --arg t "$QUOTE" '{title: $t, body: "Closes #7"}' >"$CASE/pr.json"
! takedown || fail "a quoting title fails the run"
called "--title Fix User report 0b6e7c1a-1111-4222-8333-444455556666: /" ||
  fail "a quoting title is replaced with the issue's"
called "delete the earlier revisions" || fail "the note asks the owner to delete the old revisions"

newcase branch
jq -n --arg q "$QUOTE" '{files: [{patch: ("@@ -1 +1 @@\n+// " + $q)}], commits: [{commit: {message: "fix: rows"}}]}' >"$CASE/compare.json"
! takedown || fail "a quoting branch fails the run"
called "The branch \`claude/issue-7\` quotes it" || fail "the note names the branch"

newcase commit
jq -n --arg q "$QUOTE" '{files: [], commits: [{commit: {message: ("fix: rows\n\n" + $q)}}]}' >"$CASE/compare.json"
! takedown || fail "a quoting commit message fails the run"

newcase removed-line
jq -n --arg q "$QUOTE" '{files: [{patch: ("@@ -1 +1 @@\n-// " + $q + "\n+// fixed")}], commits: []}' >"$CASE/compare.json"
takedown || fail "a line the branch removes isn't a quote"

newcase no-pr
jq -n '[]' >"$CASE/prs.json"
jq -n --arg q "$QUOTE" '{files: [{patch: ("+" + $q)}], commits: []}' >"$CASE/compare.json"
! takedown || fail "a quoting branch without a pull request fails the run"
called "issue edit 7 -R o/r --add-label needs-human" || fail "without a pull request, the issue goes to a human"
called "issue comment 7" || fail "without a pull request, the note goes on the issue"

newcase no-compare
rm "$CASE/compare.json"
takedown || fail "a branch GitHub can't compare isn't a quote"

newcase no-branch
takedown "" || fail "no branch: only the comments are checked"

if [ "$failures" -gt 0 ]; then
  echo "$failures failed."
  exit 1
fi
echo "All report hand-off checks pass."
