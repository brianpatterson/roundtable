#!/usr/bin/env bash
# Fetches the problem report a `user-report` issue refers to, for the implementer (ADR-0041). Runs
# as its own step before the agent, so FACTORY_REPORTS_TOKEN never reaches it: the agent gets the
# report as a file, and a note in its instructions saying where it is, or why there's none.
#
#   TITLE        the issue's title, "User report <id>: <page>" (written by the report App)
#   TOKEN        FACTORY_REPORTS_TOKEN
#   REPORTS_URL  e.g. https://roundtableapp.us/api/factory/reports
#   OUT          directory for report.json and description.txt (the agent may read it)
#   PROMPT       the implementer's instructions file, which gets the note appended
#   CURL         overrides curl (tests)
#
# Sets the step output fetched=true when the report was fetched.
#
# Never fails the job: without the report the agent asks the owner instead, as it did before.
set -euo pipefail

CURL=${CURL:-curl}
mkdir -p "$OUT"

note() {
  printf '\n## This run: a user report (ADR-0041)\n\n%s\n' "$1" >>"$PROMPT"
}

missing() {
  rm -f "$OUT/report.json" "$OUT/description.txt"
  echo "::warning::The user's report wasn't fetched: $1"
  note "This issue is a user report, but its text couldn't be fetched ($1). Don't guess what went wrong: ask the owner in your comment, without quoting anything private, and stop."
  exit 0
}

id=$(sed -nE 's/^User report ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}): .*/\1/p' <<<"$TITLE")
[ -n "$id" ] || missing "the issue title names no report id"
[ -n "${TOKEN:-}" ] || missing "the factory environment has no FACTORY_REPORTS_TOKEN secret"

# The token goes in a header read from stdin, so it never appears in the process list.
status=$("$CURL" -sS --max-time 20 -o "$OUT/report.json" -w '%{http_code}' \
  -H @- "$REPORTS_URL/$id" <<<"Authorization: Bearer $TOKEN") || missing "the API couldn't be reached"

case "$status" in
  200) ;;
  401) missing "the API refused the token: FACTORY_REPORTS_TOKEN differs between GitHub and the server" ;;
  404) missing "the API has no report $id younger than 30 days" ;;
  *) missing "the API answered $status" ;;
esac

jq -e '.description | type == "string"' "$OUT/report.json" >/dev/null 2>&1 ||
  missing "the API's answer wasn't a report"
jq -r .description "$OUT/report.json" >"$OUT/description.txt"

note "This issue is user report \`$id\`. What the user wrote, and what their browser saw before they sent it, is in \`$OUT/report.json\`: read it with your Read tool before anything else, and follow \"User reports\" above."
echo "Fetched report $id."
# Tells the workflow to check what the agent publishes against the description.
[ -z "${GITHUB_OUTPUT:-}" ] || echo "fetched=true" >>"$GITHUB_OUTPUT"
