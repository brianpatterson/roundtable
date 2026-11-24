#!/usr/bin/env bash
# Checks that a renumbered ADR gets its new number in the pull request's description (ADR-0058,
# retro #180). Run from anywhere: .github/factory/test-renumber-adr-refs.sh
# shellcheck source=.github/factory/testlib.sh
. "$(dirname "$0")/testlib.sh"

rewrite() { "$here/renumber-adr-refs.sh" --rewrite "$@"; }
old=docs/adr/0057-round-outcome.md
new=docs/adr/0059-round-outcome.md

expect "rewrites the ADR's number" "Decided in ADR-0059." \
  "$(rewrite "$old" "$new" <<<"Decided in ADR-0057.")"
expect "rewrites its file name" "See docs/adr/0059-round-outcome.md" \
  "$(rewrite "$old" "$new" <<<"See docs/adr/0057-round-outcome.md")"
expect "rewrites a link to it, text and target" "[ADR-0059](docs/adr/0059-round-outcome.md)" \
  "$(rewrite "$old" "$new" <<<"[ADR-0057](docs/adr/0057-round-outcome.md)")"
expect "leaves a link to main's ADR with the old number" "[ADR-0057](docs/adr/0057-factory-thing.md)" \
  "$(rewrite "$old" "$new" <<<"[ADR-0057](docs/adr/0057-factory-thing.md)")"
expect "leaves another slug's file name" "docs/adr/0057-factory-thing.md" \
  "$(rewrite "$old" "$new" <<<"docs/adr/0057-factory-thing.md")"
expect "leaves a longer number alone" "ADR-00570 and 10057" \
  "$(rewrite "$old" "$new" <<<"ADR-00570 and 10057")"
expect "applies two renames at once, without chaining" "ADR-0058 then ADR-0059" \
  "$(rewrite docs/adr/0057-a.md docs/adr/0058-a.md docs/adr/0058-b.md docs/adr/0059-b.md <<<"ADR-0057 then ADR-0058")"
expect "ignores a rename that changes the slug" "ADR-0057" \
  "$(rewrite docs/adr/0057-a.md docs/adr/0059-b.md <<<"ADR-0057")"

# The whole run, in a scratch repository with a stand-in gh.
git_() { git -C "$work/repo" -c user.name=t -c user.email=t@invalid "$@"; }
mkdir -p "$work/repo/docs/adr"
git_ init -q
echo "# 0057. Round outcome" >"$work/repo/docs/adr/0057-round-outcome.md"
git_ add -A
git_ commit -qm "the pull request's ADR"
start=$(git_ rev-parse HEAD)
git_ mv docs/adr/0057-round-outcome.md docs/adr/0059-round-outcome.md
echo "# 0057. Factory thing" >"$work/repo/docs/adr/0057-factory-thing.md"
git_ add -A
git_ commit -qm "merge main"
merged=$(git_ rev-parse HEAD)

fake_gh <<'ROUTES'
  "pr view 5 -R owner/repo --json headRefOid"*) echo "$PR_HEAD" ;;
  "pr view 5 -R owner/repo --json body"*) answer body.json ;;
  "pr edit 5 -R owner/repo --body-file "*) cp "${@: -1}" "$GH_FIXTURES/edited"; record ;;
ROUTES
cat >"$work/body.json" <<'JSON'
{"body": "Closes #1\n\nAdds [ADR-0057](docs/adr/0057-round-outcome.md)."}
JSON

run() { # run <pr head>; sets status, out
  rm -f "$work/calls" "$work/edited"
  status=0
  out=$(cd "$work/repo" && GH="$work/gh" PR_HEAD=$1 PR=5 SHA=$start GITHUB_REPOSITORY=owner/repo \
    "$here/renumber-adr-refs.sh" 2>&1) || status=$?
}

run "$merged"
expect "a renumbering run exits 0" 0 "$status"
expect_in "says what it renumbered" "$out" "Renumbered the description"
expect "edits the description" "Closes #1

Adds [ADR-0059](docs/adr/0059-round-outcome.md)." "$(cat "$work/edited" 2>/dev/null)"
expect_in "comments with what it changed" "$(cat "$work/calls" 2>/dev/null)" "0057-round-outcome.md\` → \`0059-round-outcome.md"
expect_in "quotes each line it changed, before" "$(cat "$work/calls" 2>/dev/null)" "Was: Adds [ADR-0057](docs/adr/0057-round-outcome.md)."
expect_in "and after" "$(cat "$work/calls" 2>/dev/null)" "Now: Adds [ADR-0059](docs/adr/0059-round-outcome.md)."

run "$start"
expect "a pull request that moved on exits 0" 0 "$status"
[ ! -e "$work/calls" ] || fail "changes nothing when the pull request isn't at this checkout's head"

echo '{"body": "Closes #1"}' >"$work/body.json"
run "$merged"
[ ! -e "$work/calls" ] || fail "changes nothing when the description names no renumbered ADR"

finish "All ADR renumbering checks passed"
