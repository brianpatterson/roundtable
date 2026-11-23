#!/usr/bin/env bash
# Checks attempt.sh, the attempt the CI fixer, Rework and the conflict resolver each make on a
# factory pull request (ADR-0028, ADR-0037, ADR-0053, ADR-0058): which attempt it is and when it
# goes to a human (next), and how what the agent pushed is judged and reported (report), against a
# stand-in gh that answers from canned JSON. Run from anywhere: .github/factory/test-attempt.sh
# shellcheck source=.github/factory/testlib.sh
. "$(dirname "$0")/testlib.sh"

fake_gh <<'ROUTES'
  "api repos/o/r/compare/"*) answer compare.json ;;
  "api repos/o/r/issues/7/comments"*) answer comments.json ;;
  "pr comment"*) printf '%s\n' "$*" >>"$GH_FIXTURES/comments" ;;
  "pr view 7 -R o/r --json state"*) answer pr.json ;;
  "pr view"*) [ "${HEAD_NOW:-abc}" != unreadable ] || refuse; echo "${HEAD_NOW:-abc}" ;;
ROUTES
labeled() { grep -q "pr edit 7 -R o/r --add-label needs-human" "$work/calls"; }
said() { grep -qF -- "$1" "$work/comments"; }

# --- next ---

# pr [labels JSON] [fork] [state]: pull request #7 at commit abc, whose last human commit (o's) is
# from 10:00; the factory's own commits after it don't reset the count.
pr() {
  jq -n --argjson l "${1:-[\"factory\"]}" --argjson f "${2:-false}" --arg s "${3:-OPEN}" \
    '{state: $s, headRefOid: "abc", isCrossRepository: $f, labels: ($l | map({name: .})),
      commits: [{committedDate: "2026-11-20T10:00:00Z", authors: [{login: "o"}]},
                {committedDate: "2026-11-20T11:00:00Z", authors: [{login: "claude[bot]"}]}]}' >"$work/pr.json"
}
# comments <marker@time>...: the bot's marked comments on #7; "someone:" before one makes it another
# user's.
comments() {
  local c user body
  for c in "$@"; do
    user="github-actions[bot]"
    case "$c" in someone:*) user=someone c=${c#someone:} ;; esac
    body="${c%@*}"$'\n### An attempt'
    jq -nc --arg u "$user" --arg b "$body" --arg t "${c##*@}" '{user: {login: $u}, body: $b, created_at: $t}'
  done | jq -s . >"$work/comments.json"
}
next() { # next <kind>, with EXPECT_SHA, MAIN or PASS set before it if needed: prints its answer
  : >"$work/calls"
  : >"$work/comments"
  GH=$work/gh GITHUB_REPOSITORY=o/r "$here/attempt.sh" next "$1" 7 2>/dev/null
}
ci='<!-- factory-ci-fix -->'
rw='<!-- factory-rework -->'
minor=$'<!-- factory-rework -->\n<!-- factory-rework-minor -->'
late=2026-11-20T12:00:00Z early=2026-11-20T09:00:00Z

pr
comments
expect "a factory pull request's first CI fix" 1 "$(next ci-fix)"
expect "and its first rework" 1 "$(next rework)"
pr '["autofix"]'
expect "the CI fixer also takes a pull request labeled autofix" 1 "$(next ci-fix)"
expect "Rework doesn't" "" "$(next rework)"
pr '["enhancement"]'
expect "a pull request that's neither isn't tried" "" "$(next ci-fix)"
pr '["factory","needs-human"]'
expect "one waiting for a human isn't tried" "" "$(next ci-fix)"
pr '["factory"]' true
expect "nor one from a fork" "" "$(next rework)"
pr '["factory"]' false CLOSED
expect "nor a closed one" "" "$(next ci-fix)"
pr
expect "nor one that moved past the commit the run was for" "" "$(EXPECT_SHA=def next ci-fix)"
expect "the commit the run was for is fine" 1 "$(EXPECT_SHA=abc next ci-fix)"

comments "$ci@$late"
expect "one fix since the owner's last push makes the next the second" 2 "$(next ci-fix)"
expect "another kind's comments don't count" 1 "$(next rework)"
comments "$ci@$early" "$ci@$early"
expect "fixes before the owner's last push don't count" 1 "$(next ci-fix)"
comments "someone:$ci@$late" "someone:$ci@$late"
expect "nor anyone else's comments" 1 "$(next ci-fix)"
comments "$ci@$late" "$ci@$late"
expect "two fixes: over to a human" limit "$(next ci-fix)"
labeled || fail "two fixes label the pull request needs-human"
said "tried to fix CI twice" || fail "and say why"

comments "$minor@$late" "$rw@$late"
expect "the minor pass doesn't count against the two reworks" 2 "$(next rework)"
comments "$rw@$late" "$rw@$late"
expect "two reworks: over to a human" limit "$(next rework)"
said "reworked this pull request twice" || fail "and the hand-over names the rework"
expect "a minor pass, once two reworks are spent, is still the one pass" minor "$(PASS=minor next rework)"
comments "$minor@$late"
expect "one minor pass per pull request" spent "$(PASS=minor next rework)"
! labeled || fail "a spent minor pass doesn't go to a human"
comments "$minor@$early"
expect "a minor pass before the owner's last push doesn't count" minor "$(PASS=minor next rework)"

comments "<!-- factory-conflict --> main at m1@$late" "<!-- factory-conflict --> main at m1@$late"
expect "two attempts against this main: over to a human" limit "$(MAIN=m1 next conflict)"
said "resolve this pull request's conflict with main (at m1)" || fail "and the hand-over names main's commit"
expect "attempts against an older main don't count" 1 "$(MAIN=m2 next conflict)"

# --- report ---

compare() { # compare <behind_by> [file JSON objects…]: what GitHub answers; none at all with "fails"
  if [ "$1" = fails ]; then rm -f "$work/compare.json"; return; fi
  local behind=$1
  shift
  local files
  files=$(IFS=,; echo "[$*]")
  jq -n --argjson b "$behind" --argjson f "$files" --argjson a "${AHEAD:-1}" '{ahead_by: $a, behind_by: $b, files: $f}' >"$work/compare.json"
}
nopatch() { # nopatch <name> <changes>: a file GitHub shows no diff for
  jq -nc --arg n "$1" --argjson c "$2" '{filename: $n, changes: $c}'
}
file() { # file <name> [patch, with \n for newlines]
  jq -nc --arg n "$1" --arg p "$(printf '%b' "${2:-@@ -1 +1 @@\n+fine}")" '{filename: $n, patch: $p, changes: 1}'
}
status=0
report() { # report <kind> <attempt> <agent result JSON or "">, with PASS set if needed: sets status
  : >"$work/calls"
  : >"$work/comments"
  status=0
  GH=$work/gh RESULT=$3 REASON='' PR=7 SHA=abc BRANCH=b MAIN=m1 ATTEMPT=$2 GITHUB_REPOSITORY=o/r \
    GITHUB_SERVER_URL=https://x GITHUB_RUN_ID=9 GITHUB_OUTPUT=$work/output \
    "$here/attempt.sh" report "$1" >/dev/null 2>&1 || status=$?
}
run() { report conflict "$@"; } # the resolver's cases
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
[ "$status" -eq 1 ] && labeled && said "whoever made the change" || fail "a change to .github/ fails the step and goes to a human"
! said "resolver" || fail "the protected-path message doesn't blame the resolver"
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

# 300 files is the compare's limit: protected paths past it can't be ruled out, even when the agent
# pushed nothing.
jq -n '{behind_by: 0, files: [range(300) | {filename: "f\(.).md", patch: "@@ -1 +1 @@\n+fine", changes: 1}]}' >"$work/compare.json"
run 1 ''
labeled && said "wasn't checked for changes to the factory's own rules" ||
  fail "a crash that pushed nothing still goes to a human when protected paths can't be ruled out"

# The CI fixer.
compare 0 "$(file apps/web/a.ts)"
report ci-fix 1 '{"outcome":"fixed","summary":"Fixed the flaky test."}'
[ "$status" -eq 0 ] && ! labeled && said "### CI fix, attempt 1 of 2: pushed a fix" || fail "a fix is reported, unlabeled"
said "<!-- factory-ci-fix -->" && said "for commit abc. ADR-0028." || fail "the fix's comment carries its marker, commit and ADR"
grep -qx "outcome=fixed" "$work/output" || fail "the outcome is written for the workflow"
report ci-fix 2 '{"outcome":"reran","summary":"A runner died."}'
! labeled && said "re-ran the failed jobs" || fail "a rerun is reported, unlabeled"
report ci-fix 1 '{"outcome":"needs-human","summary":"The test is right; the code is wrong."}'
labeled && said "couldn't fix it" || fail "the fixer's needs-human goes to a human"
report ci-fix 1 ''
labeled && said "The fixer stopped without a summary" || fail "a crashed fix goes to a human"
compare 0 "$(file .github/workflows/ci.yml)"
report ci-fix 1 '{"outcome":"fixed","summary":"Fixed CI."}'
[ "$status" -eq 1 ] && labeled && said "against commit abc" || fail "a fix that changes .github/ fails the step and goes to a human"
jq -n '{ahead_by: 1, behind_by: 0, files: [range(300) | {filename: "f\(.).md"}]}' >"$work/compare.json"
report ci-fix 1 '{"outcome":"fixed","summary":"Fixed CI."}'
labeled && said "couldn't check what it pushed" || fail "a fix that can't be checked goes to a human"

# Rework.
compare 0 "$(file apps/web/a.ts)"
report rework 1 '{"outcome":"fixed","summary":"Renamed it."}'
! labeled && said "### Rework, attempt 1 of 2: pushed changes" && said "answering the review of commit abc. ADR-0037, ADR-0053." ||
  fail "a rework that pushed is reported, unlabeled"
AHEAD=0 compare 0
report rework 1 '{"outcome":"fixed","summary":"Renamed it."}'
labeled && said "reported a fix but pushed no commits" || fail "a rework that claims a fix without commits goes to a human"
report rework 2 '{"outcome":"needs-human","summary":"The review is wrong."}'
labeled && said "over to you" || fail "the rework's needs-human goes to a human"
report rework 1 ''
labeled && said "The rework agent stopped without a summary" || fail "a crashed rework goes to a human"
PASS=minor report rework '' '{"outcome":"needs-human","summary":"Nothing worth changing."}'
! labeled && said "### Rework, minor findings: pushed nothing; the minor findings are yours" ||
  fail "a minor pass that pushes nothing leaves the findings to the owner, unlabeled"
said "<!-- factory-rework-minor -->" || fail "the minor pass's comment carries its marker, for next to count"
PASS=minor report rework '' ''
! labeled || fail "a crashed minor pass leaves the findings to the owner too"
compare 0 "$(file CLAUDE.md)"
PASS=minor report rework '' '{"outcome":"fixed","summary":"Tidied."}'
[ "$status" -eq 1 ] && labeled || fail "a minor pass that changes CLAUDE.md fails the step and goes to a human"

# Each kind's comment is what next counts: report, then next, sees one more attempt.
compare 0 "$(file apps/web/a.ts)"
pr
for kind in ci-fix rework conflict; do
  report "$kind" 1 ''
  body=$(sed '1s/^pr comment 7 -R o\/r --body //' "$work/comments")
  jq -n --arg b "$body" '[{user: {login: "github-actions[bot]"}, body: $b, created_at: "2026-11-20T12:00:00Z"}]' >"$work/comments.json"
  expect "a $kind attempt's comment counts toward the next" 2 "$(MAIN=m1 next "$kind")"
done

finish "All attempt checks pass."
