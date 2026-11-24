#!/usr/bin/env bash
# Checks which existing issue covers an architecture candidate (ADR-0067) against a stand-in gh.
# Run from anywhere: .github/factory/test-find-architecture-issue.sh
# shellcheck source=.github/factory/testlib.sh
. "$(dirname "$0")/testlib.sh"

fake_gh <<'ROUTES'
  "issue list -R owner/repo --label architecture --state all"*) answer issues.json ;;
ROUTES

find() { # find <title>; sets status and found
  status=0
  found=$(GH="$work/gh" GITHUB_REPOSITORY=owner/repo "$here/find-architecture-issue.sh" "$1" 2>&1) || status=$?
}

days_ago() { jq -nr --argjson d "$1" 'now - $d * 86400 | todateiso8601'; }

issue() { # issue <number> <title> <OPEN|CLOSED> [closed days ago]
  local closed=null
  [ -z "${4:-}" ] || closed="\"$(days_ago "$4")\""
  echo "{\"number\":$1,\"title\":\"$2\",\"state\":\"$3\",\"closedAt\":$closed}"
}

issues() { (
  IFS=,
  echo "[$*]"
) >"$work/issues.json"; }

issues
find "Architecture: Deepen the App"
expect "finds nothing when no issue matches" "" "$found"
expect "and exits 0" 0 "$status"

issues "$(issue 5 "Architecture: Deepen the App" OPEN)"
find "Architecture: Deepen the App"
expect "finds an open issue with the same title" 5 "$found"

issues "$(issue 6 "Architecture: Deepen the App assembly" OPEN)"
find "Architecture: Deepen the App"
expect "ignores a longer title the fuzzy search also returns" "" "$found"

issues "$(issue 7 "Architecture: Deepen the App" CLOSED 10)"
find "Architecture: Deepen the App"
expect "finds one closed in the last 30 days" 7 "$found"

issues "$(issue 8 "Architecture: Deepen the App" CLOSED 45)"
find "Architecture: Deepen the App"
expect "ignores one closed more than 30 days ago" "" "$found"

issues "$(issue 9 "Architecture: Deepen the App" CLOSED 45)" "$(issue 10 "Architecture: Deepen the App" OPEN)"
find "Architecture: Deepen the App"
expect "finds the open one past an old closed one" 10 "$found"

rm "$work/issues.json"
find "Architecture: Deepen the App"
expect "fails when GitHub can't list the issues, so no duplicate is opened" 1 "$status"

finish "find-architecture-issue.sh: all checks passed."
