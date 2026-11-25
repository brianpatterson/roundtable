#!/usr/bin/env bash
# Files mutation tickets (ADR-0051, ADR-0052) from the nightly mutation run's reports: for each
# source file with mutants no test detects (`Survived` or `NoCoverage`), most first, a `mutation`
# issue labeled `ready` listing up to LIMIT of them. A ticket asks only for tests (or a Stryker
# disable comment on an equivalent mutant), so the dispatcher builds it without the owner's label,
# after the owner's own tickets. It tops up to MAX_OPEN open tickets, one per file: a file with an
# open ticket gets no second one until that closes. A file whose ticket the owner closed as not planned
# is never filed again, and a mutant a finished ticket already listed isn't asked for again: its
# pull request left it alive and said why, so asking again would loop.
#
#   file-mutation-issue.sh <app dir>=<mutation.json> ...   e.g. apps/web=apps/web/reports/mutation/mutation.json
#
# Env: GITHUB_REPOSITORY, RUN_URL (the mutation run), LIMIT (mutants per ticket, default 25),
# MAX_OPEN (open tickets, default 5), DRY_RUN=true prints the tickets and files nothing, GH
# overrides the gh binary (tests).
set -euo pipefail

GH=${GH:-gh}
: "${GITHUB_REPOSITORY:?}"
repo=$GITHUB_REPOSITORY
limit=${LIMIT:-25}
max_open=${MAX_OPEN:-5}

open=$("$GH" issue list -R "$repo" --label mutation --state open --limit 100 --json title --jq '[.[].title]')
slots=$((max_open - $(jq length <<<"$open")))
if [ "$slots" -le 0 ]; then
  echo "$(jq length <<<"$open") mutation tickets are open, the most allowed ($max_open): nothing to file."
  exit 0
fi

# Every closed mutation ticket, for declined files and mutants already asked for. 1000 is years of
# tickets at five a day; past it, the oldest would drop out and their files and mutants come back.
closed=$("$GH" issue list -R "$repo" --label mutation --state closed --limit 1000 --json title,stateReason,body)
declined=$(jq -c '[.[] | select(.stateReason == "NOT_PLANNED") | .title]' <<<"$closed")
# Each ticket lists its mutants' keys at the end of its description, as base64 JSON in an HTML
# comment (a replacement could contain `-->`). A key is the file, mutator and replacement, not the
# line, so a mutant left alive is still recognized after code above it moves; identical mutants in
# one file are counted, so asking for one of them doesn't hide the others.
asked=$(jq -c '[.[] | select(.stateReason != "NOT_PLANNED") | .body // ""
  | capture("<!-- mutants: (?<k>[A-Za-z0-9+/=]+) -->").k? // "" | (@base64d | fromjson)? // [] | .[]]' <<<"$closed")

mutants='[]'
for pair in "$@"; do
  app=${pair%%=*}
  report=${pair#*=}
  mutants=$(jq -c --argjson acc "$mutants" --arg app "$app" '
    $acc + [.files | to_entries[] | .key as $f | .value.mutants[]
      | select(.status == "Survived" or .status == "NoCoverage")
      | {app: $app, file: $f, line: .location.start.line, status, mutator: .mutatorName,
         replacement: ((.replacement // "") | gsub("\\s+"; " ") | .[0:80])}
      | .key = "\(.app)/\(.file) \(.mutator) \(.replacement)"]' "$report")
done

# The files with the most undetected mutants, as many as there are free slots, leaving out files the
# owner declined and files that already have an open ticket.
picks=$(jq -c --argjson skip "$(jq -c --argjson o "$open" '. + $o' <<<"$declined")" --argjson asked "$asked" --argjson slots "$slots" '
  ($asked | group_by(.) | map({key: .[0], value: length}) | from_entries) as $times
  | group_by(.key) | map(sort_by(.line) | .[($times[.[0].key] // 0):]) | add // []
  | group_by(.app + "/" + .file)
  | map({path: (.[0].app + "/" + .[0].file), mutants: (. | sort_by(.line))})
  | map(select(("Mutation: test `\(.path)`") as $t | $skip | index($t) | not))
  | sort_by(-(.mutants | length), .path) | .[0:$slots]' <<<"$mutants")
if [ "$(jq length <<<"$picks")" -eq 0 ]; then
  echo "No undetected mutants left to file."
  exit 0
fi

if [ "${DRY_RUN:-}" != true ]; then
  "$GH" label create mutation -R "$repo" --force --color FBCA04 \
    --description "Tests the nightly mutation run asks for (ADR-0051)" >/dev/null
fi

while read -r pick; do
  path=$(jq -r .path <<<"$pick")
  app=$(jq -r '.mutants[0].app' <<<"$pick")
  file=$(jq -r '.mutants[0].file' <<<"$pick")
  package="@roundtable/${app#apps/}"
  issue_title="Mutation: test \`$path\`"

  # shellcheck disable=SC2016 # backticks are Markdown
  body=$(jq -r --argjson limit "$limit" --arg run "${RUN_URL:-}" --arg path "$path" --arg file "$file" --arg package "$package" '
    .mutants as $all | $all[0:$limit] as $some
    | ([$all[] | select(.status == "Survived")] | length) as $survived
    | ([$all[] | select(.status == "NoCoverage")] | length) as $uncovered
    | "### Problem\n\n" +
      "The nightly mutation run on main" + (if $run != "" then " ([run](\($run)))" else "" end) +
      " left \($all | length) mutants in `\($path)` that no test detects: \($survived) survived and \($uncovered) ran no test at all. " +
      "Each is a small change to the code that the tests let through, so a bug like it would get through too. " +
      (if ($all | length) > ($some | length) then "This ticket covers the first \($some | length), by line; the next ticket takes the rest." else "This ticket covers all of them." end) +
      "\n\n### Mutants\n\n" +
      ($some | map("- `\($path):\(.line)` \(.status), \(.mutator): `` \(.replacement) ``") | join("\n")) +
      "\n\nLine numbers are from the run; the code may have moved since. Confirm with the command below.\n\n" +
      "### Acceptance criteria\n\n" +
      "- Given each mutant above, then a test fails when it is applied, through behavior a user or caller can see. " +
      "Or, if no test could tell it from the original (an equivalent mutant), a `// Stryker disable next-line <Mutator>: <why it is equivalent>` comment sits on the line above it, or the pull request names it as equivalent where a disable would also hide a mutant a test kills (ADR-0068).\n" +
      "- Given `pnpm --filter \($package) test:mutation --mutate \($file) --force`, then none of the mutants above is reported `Survived` or `NoCoverage`, apart from those the pull request names as left alive, each with why.\n" +
      "- Given the diff, then it changes only test files, plus Stryker disable comments in `\($path)`.\n" +
      "- Given `pnpm check`, then it passes.\n\n" +
      "### Modules touched\n\nTests for `\($path)`.\n\n" +
      "### Out of scope\n\nChanging what `\($path)` does, or refactoring it to make a test easier: anything in it but a disable comment. If a mutant can only be killed by changing the code, leave it, and say which and why in the pull request. Mutants in other files.\n\n" +
      "### Docs impact\n\nNone.\n\n" +
      "<sub>Filed by the nightly mutation run (ADR-0051, ADR-0052) and labeled `ready` by it: it asks only for tests. Close it as not planned to stop tickets for this file.</sub>\n\n" +
      "<!-- mutants: \($some | map(.key) | tojson | @base64) -->"
  ' <<<"$pick")

  if [ "${DRY_RUN:-}" = true ]; then
    printf '%s\n\n%s\n\n' "$issue_title" "$body"
  else
    "$GH" issue create -R "$repo" --title "$issue_title" --label mutation --label ready --body "$body"
  fi
done < <(jq -c '.[]' <<<"$picks")
