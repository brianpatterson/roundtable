#!/usr/bin/env bash
# shellcheck disable=SC2016 # backticks are Markdown
# Checks file-mutation-issue.sh (ADR-0051) against fixture reports and a stand-in `gh` that records
# what would be filed. Run from anywhere: .github/factory/test-file-mutation-issue.sh
# shellcheck source=.github/factory/testlib.sh
. "$(dirname "$0")/testlib.sh"

# The stand-in gh: `issue list --state open` and `--state closed` answer from files; `issue create`
# appends its arguments one per line, and anything else is recorded and succeeds.
fake_gh <<'ROUTES'
  "issue list"*"--state open"*) answer open.json ;;
  "issue list"*"--state closed"*) answer closed.json ;;
  "issue create"*) printf '%s\n' "$@" >>"$GH_FIXTURES/created" ;;
ROUTES

# A report: mutant <file> <line> <status> [mutator] [replacement]
mutant() { jq -nc --arg f "$1" --argjson l "$2" --arg s "$3" --arg m "${4:-ConditionalExpression}" --arg r "${5:-false}" \
  '{file: $f, m: {status: $s, mutatorName: $m, replacement: $r, location: {start: {line: $l, column: 1}}}}'; }
report() { jq -sc 'reduce .[] as $x ({files: {}}; .files[$x.file].mutants += [$x.m])' >"$1"; }

{
  mutant src/a.ts 3 Survived
  mutant src/a.ts 1 NoCoverage BlockStatement '{
  }'
  mutant src/a.ts 9 Killed
  mutant src/b.ts 2 Survived
} | report "$work/api.json"
{
  mutant src/Page.tsx 5 Survived
  mutant src/Page.tsx 6 Survived
  mutant src/Page.tsx 7 Survived
  mutant src/Page.tsx 8 Ignored
} | report "$work/web.json"

run() { # run, with LIMIT or DRY_RUN set before it if needed: sets $output and $status
  : >"$work/created"
  status=0
  output=$(GH="$work/gh" GITHUB_REPOSITORY=o/r RUN_URL=https://run \
    "$here/file-mutation-issue.sh" "apps/api=$work/api.json" "apps/web=$work/web.json" 2>&1) || status=$?
}
refute() { # refute <name> <text> <what it must not contain>
  case "$2" in *"$3"*)
    fail "$1: [$3] in [$2]"
    ;;
  esac
}

echo '[]' >"$work/open.json"
echo '[]' >"$work/closed.json"
titles() { grep '^Mutation: test' "$work/created" | paste -sd '|' -; }

# Up to MAX_OPEN (5) tickets, one per file, the most undetected mutants first (ADR-0052).
run
expect "a ticket per file, most undetected mutants first" \
  'Mutation: test `apps/web/src/Page.tsx`|Mutation: test `apps/api/src/a.ts`|Mutation: test `apps/api/src/b.ts`' "$(titles)"

# Open tickets count against the cap, and a file with one open gets no second one.
jq -nc '[{title: "Mutation: test `apps/web/src/Page.tsx`"}, {title: "Mutation: test `apps/x.ts`"}]' >"$work/open.json"
MAX_OPEN=3 run
expect "fills the free slot with the next file without an open ticket" 'Mutation: test `apps/api/src/a.ts`' "$(titles)"

# At the cap, nothing is filed.
MAX_OPEN=2 run
expect_in "at the cap, nothing is filed" "$output" "the most allowed (2)"
[ ! -s "$work/created" ] || fail "filed at the cap"
echo '[]' >"$work/open.json"

# The rest file one ticket at a time, to check which file comes first.
export MAX_OPEN=1

# The file with the most undetected mutants wins; killed and ignored ones don't count.
run
created=$(cat "$work/created")
expect_in "the file with the most undetected mutants is filed" "$created" 'Mutation: test `apps/web/src/Page.tsx`'
expect_in "labeled mutation" "$created" "mutation"
expect_in "and ready, by the workflow" "$created" "ready"
expect_in "it lists a survivor with its line" "$created" '`apps/web/src/Page.tsx:5` Survived'
refute "an ignored mutant isn't listed" "$created" "Page.tsx:8"
expect_in "the command runs Stryker on that file alone" "$created" "pnpm --filter @roundtable/web test:mutation --mutate src/Page.tsx"
expect_in "it asks for tests only" "$created" "changes only test files"

# A file the owner declined is skipped; the next file down is filed, its mutants in line order and
# its multi-line replacement on one line.
jq -nc '[{title: "Mutation: test `apps/web/src/Page.tsx`", stateReason: "NOT_PLANNED", body: ""}]' >"$work/closed.json"
run
created=$(cat "$work/created")
expect_in "a declined file is skipped for the next one" "$created" 'Mutation: test `apps/api/src/a.ts`'
expect_in "mutants in line order" "$(grep -n 'a.ts:' <<<"$created" | head -1)" "a.ts:1"
expect_in "a replacement over several lines is shown on one" "$created" '`` { } ``'

# A mutant a finished ticket already listed isn't asked for again, so a file whose only mutants were
# left alive on purpose isn't filed again.
LIMIT=25 DRY_RUN=true run
keys=$(grep -o '<!-- mutants: [A-Za-z0-9+/=]* -->' <<<"$output")
jq -nc --arg b "$keys" '[{title: "Mutation: test `apps/web/src/Page.tsx`", stateReason: "NOT_PLANNED", body: ""},
  {title: "Mutation: test `apps/api/src/a.ts`", stateReason: "COMPLETED", body: ("done\n\n" + $b)}]' >"$work/closed.json"
run
expect_in "with a.ts already asked for, b.ts is filed" "$(cat "$work/created")" 'Mutation: test `apps/api/src/b.ts`'

# The same, after code above a.ts's mutants moved them down a line: still recognized.
cp "$work/api.json" "$work/api.orig.json"
jq -c '.files["src/a.ts"].mutants |= map(.location.start.line += 1)' "$work/api.orig.json" >"$work/api.json"
run
expect_in "an asked mutant whose line moved isn't asked again" "$(cat "$work/created")" 'Mutation: test `apps/api/src/b.ts`'

# Asking for one of two identical mutants (same mutator and replacement) doesn't hide the other.
jq -c '.files["src/a.ts"].mutants += [.files["src/a.ts"].mutants[0] | .location.start.line = 20]
  | .files["src/b.ts"].mutants = []' "$work/api.orig.json" >"$work/api.json"
run
created=$(cat "$work/created")
expect_in "the second of two identical mutants is still filed" "$created" 'Mutation: test `apps/api/src/a.ts`'
expect_in "at its own line" "$created" "a.ts:20"
refute "and the asked one isn't" "$created" "a.ts:3\`"
cp "$work/api.orig.json" "$work/api.json"

# A long list is cut to LIMIT and says the rest come next.
echo '[]' >"$work/closed.json"
LIMIT=2 DRY_RUN=true run
expect_in "the ticket says it covers only the first ones" "$output" "covers the first 2"
refute "the third mutant waits for the next ticket" "$output" "Page.tsx:7"
[ ! -s "$work/created" ] || fail "a dry run filed a ticket"

# Nothing left to file.
echo '{"files":{}}' >"$work/api.json"
echo '{"files":{}}' >"$work/web.json"
run
expect_in "no undetected mutants: nothing filed" "$output" "No undetected mutants left"
[ "$status" -eq 0 ] || fail "nothing to file exits $status"

finish "All mutation ticket cases pass."
