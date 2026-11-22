#!/usr/bin/env bash
# Files the next mutation ticket (ADR-0051) from the nightly mutation run's reports: the source file
# with the most mutants no test detects (`Survived` or `NoCoverage`), up to LIMIT of them, as a
# `mutation` issue labeled `ready`. The ticket asks only for tests (or a Stryker disable comment on
# an equivalent mutant), so the dispatcher builds it without the owner's label. One at a time: while
# a mutation ticket is open, nothing is filed. A file whose ticket the owner closed as not planned
# is never filed again, and a mutant a finished ticket already listed isn't asked for again: its
# pull request left it alive and said why, so asking again would loop.
#
#   file-mutation-issue.sh <app dir>=<mutation.json> ...   e.g. apps/web=apps/web/reports/mutation/mutation.json
#
# Env: GITHUB_REPOSITORY, RUN_URL (the mutation run), LIMIT (default 25), DRY_RUN=true prints the
# ticket and files nothing, GH overrides the gh binary (tests).
set -euo pipefail

GH=${GH:-gh}
: "${GITHUB_REPOSITORY:?}"
repo=$GITHUB_REPOSITORY
limit=${LIMIT:-25}

open=$("$GH" issue list -R "$repo" --label mutation --state open --json number --jq '.[0].number // empty')
if [ -n "$open" ]; then
  echo "#$open is still open: the factory gets one mutation ticket at a time."
  exit 0
fi

closed=$("$GH" issue list -R "$repo" --label mutation --state closed --limit 200 --json title,stateReason,body)
declined=$(jq -c '[.[] | select(.stateReason == "NOT_PLANNED") | .title]' <<<"$closed")
# Each ticket lists its mutants' keys at the end of its description, as base64 JSON in an HTML
# comment (a replacement could contain `-->`).
asked=$(jq -c '[.[] | select(.stateReason != "NOT_PLANNED") | .body // ""
  | capture("<!-- mutants: (?<k>[A-Za-z0-9+/=]+) -->").k? // "" | (@base64d | fromjson)? // [] | .[]] | unique' <<<"$closed")

mutants='[]'
for pair in "$@"; do
  app=${pair%%=*}
  report=${pair#*=}
  mutants=$(jq -c --argjson acc "$mutants" --arg app "$app" '
    $acc + [.files | to_entries[] | .key as $f | .value.mutants[]
      | select(.status == "Survived" or .status == "NoCoverage")
      | {app: $app, file: $f, line: .location.start.line, status, mutator: .mutatorName,
         replacement: ((.replacement // "") | gsub("\\s+"; " ") | .[0:80])}
      | .key = "\(.app)/\(.file):\(.line) \(.mutator) \(.replacement)"]' "$report")
done

# The file with the most undetected mutants that the owner hasn't declined.
pick=$(jq -c --argjson declined "$declined" --argjson asked "$asked" '
  map(select(.key as $k | $asked | index($k) | not))
  | group_by(.app + "/" + .file)
  | map({path: (.[0].app + "/" + .[0].file), mutants: (. | sort_by(.line))})
  | map(select(("Mutation: test `\(.path)`") as $t | $declined | index($t) | not))
  | sort_by(-(.mutants | length), .path) | first // empty' <<<"$mutants")
if [ -z "$pick" ]; then
  echo "No undetected mutants left to file."
  exit 0
fi

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
    "Or, if no test could tell it from the original (an equivalent mutant), a `// Stryker disable next-line <Mutator>: <why it is equivalent>` comment sits on the line above it.\n" +
    "- Given `pnpm --filter \($package) test:mutation --mutate \($file)`, then none of the mutants above is reported `Survived` or `NoCoverage`.\n" +
    "- Given the diff, then it changes only test files, plus Stryker disable comments in `\($path)`.\n" +
    "- Given `pnpm check`, then it passes.\n\n" +
    "### Modules touched\n\nTests for `\($path)`.\n\n" +
    "### Out of scope\n\nChanging what `\($path)` does, or refactoring it to make a test easier: anything in it but a disable comment. If a mutant can only be killed by changing the code, leave it, and say which and why in the pull request. Mutants in other files.\n\n" +
    "### Docs impact\n\nNone.\n\n" +
    "<sub>Filed by the nightly mutation run (ADR-0051) and labeled `ready` by it: it asks only for tests. Close it as not planned to stop tickets for this file.</sub>\n\n" +
    "<!-- mutants: \($some | map(.key) | tojson | @base64) -->"
' <<<"$pick")

if [ "${DRY_RUN:-}" = true ]; then
  printf '%s\n\n%s\n' "$issue_title" "$body"
  exit 0
fi

"$GH" label create mutation -R "$repo" --force --color FBCA04 \
  --description "Tests the nightly mutation run asks for (ADR-0051)" >/dev/null
"$GH" issue create -R "$repo" --title "$issue_title" --label mutation --label ready --body "$body"
