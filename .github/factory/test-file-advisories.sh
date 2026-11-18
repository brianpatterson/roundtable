#!/usr/bin/env bash
# Checks file-advisories.sh (ADR-0036) against a stand-in `gh` that records what would be filed.
# Run from anywhere: .github/factory/test-file-advisories.sh
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
failures=0

# The stand-in gh: a GET prints the titles already filed (as the real call's --jq would); a POST
# records its body, and fails, printing the body to stderr as GitHub's error would, when the title
# says so.
cat >"$work/gh" <<'GH'
#!/usr/bin/env bash
if [ "$2" = "-X" ]; then
  body=$(cat)
  if grep -q 'FAIL POST' <<<"$body"; then echo "GitHub says no: $body" >&2; exit 1; fi
  printf '%s\n' "$body" >>"$WORK/posted.jsonl"
else
  tr '[:upper:]' '[:lower:]' <"$WORK/existing"
fi
GH
chmod +x "$work/gh"

# run <findings JSON> <existing titles, one per line>: sets $status and $output, and the titles
# and severities filed.
run() {
  printf '%s' "$1" >"$work/findings.json"
  printf '%s' "$2" >"$work/existing"
  : >"$work/posted.jsonl"
  status=0
  output=$(WORK=$work GH=$work/gh GITHUB_REPOSITORY=o/r RUN_URL=https://run \
    "$here/file-advisories.sh" "$work/findings.json" 2>&1) || status=$?
  filed=$(jq -r '.summary' "$work/posted.jsonl" | paste -sd '|' -)
  severities=$(jq -r '.severity' "$work/posted.jsonl" | paste -sd '|' -)
}

check() { # check <name> <expected> <actual>
  if [ "$2" != "$3" ]; then
    echo "FAIL: $1: expected [$2], got [$3]"
    failures=$((failures + 1))
  fi
}

run '{"findings":[{"title":"Token in logs","severity":"high","category":"A09","files":["a.ts"],"details":"d","reproduction":"r","fix":"f"}]}' ''
check "files a finding" "Token in logs" "$filed"
check "keeps its severity" "high" "$severities"
check "exits 0" 0 "$status"
check "the description names the file" '**Where:** `a.ts`' "$(jq -r '.description' "$work/posted.jsonl" | grep -F 'Where')"

run '{"findings":[{"title":"A","severity":"High"},{"title":"B","severity":"CRITICAL"},{"title":"C","severity":"urgent"},{"title":"D"}]}' ''
check "lowercases severity, defaults the rest to medium" "high|critical|medium|medium" "$severities"

run '{"findings":[{"title":"Token in logs"},{"title":"New one"}]}' $'token in logs\n'
check "skips a title already filed" "New one" "$filed"

run '{"findings":[{"title":"  Token   in\tlogs  "},{"title":"TOKEN IN LOGS"}]}' $'token in logs\n'
check "trims and collapses whitespace before matching" "" "$filed"

run '{"findings":[{"title":"  Spaced   out  "},{"title":"Spaced out"}]}' ''
check "files the cleaned-up title once" "Spaced out" "$filed"

run '{"findings":[{"title":"Same"},{"title":"same"}]}' ''
check "files a title once per run" "Same" "$filed"

run '{"findings":[{"title":"-x session token in logs"},{"title":"-- leading dashes"}]}' $'-x session token in logs\n-- leading dashes\n'
check "matches titles that start with a dash" "" "$filed"
check "a dash title doesn't break grep" 0 "$status"

run '{"findings":[{"title":"Line one\nline two\t"}]}' $'line one\n'
check "flattens a multi-line title, and doesn't match one of its lines" "Line one line two" "$filed"

run '{"findings":[{"severity":"high"},{"title":""},"junk",{"title":"Kept","files":"one.ts"},{"title":7,"files":[1,"b"]}]}' ''
check "skips untitled and junk findings, keeps the rest" "Kept|7" "$filed"
check "a string files becomes a list" '**Where:** `one.ts`' "$(jq -r 'select(.summary == "Kept") | .description' "$work/posted.jsonl" | grep -F 'Where')"

run '{"findings":"not a list"}' ''
check "a findings value that isn't a list files nothing" "" "$filed"
check "and isn't an error" 0 "$status"

run '{"findings": [ SECRET-SHAPED-INPUT' ''
check "invalid JSON fails" 1 "$status"
check "without printing it" "" "$(grep -F 'SECRET-SHAPED-INPUT' <<<"$output" || true)"

run '{"findings":[{"title":"FAIL POST","details":"LEAK-MARKER"},{"title":"After"}]}' ''
check "a failed POST doesn't stop the next finding" "After" "$filed"
check "and fails the run" 1 "$status"
check "and GitHub's error text stays out of the log" "" "$(grep -F 'LEAK-MARKER' <<<"$output" || true)"
check "the error names the index" "::error::Filing finding 0 failed." "$(grep -F '::error::' <<<"$output")"

token="ghp_$(printf 'a%.0s' {1..36})"
run "{\"findings\":[{\"title\":\"Has a token\",\"details\":\"$token\"},{\"title\":\"Clean\"}]}" ''
check "a finding carrying a credential isn't filed" "Clean" "$filed"
check "nor printed" "" "$(grep -F "$token" <<<"$output" || true)"

if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed."
  exit 1
fi
echo "All advisory filing cases pass."
