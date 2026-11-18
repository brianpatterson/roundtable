#!/usr/bin/env bash
# Files the security auditor's findings as private draft security advisories (ADR-0036).
#   GH_TOKEN=… GITHUB_REPOSITORY=owner/repo RUN_URL=… file-advisories.sh <findings.json>
# The findings file is the agent's decrypted output. It's untrusted: any field can be missing, of
# the wrong type or malformed, and nothing about a finding may reach the log, which is public. So
# the file is normalized once (every field a string, titles on one line with single spaces, files
# a list), jq's and gh's own errors are discarded (they quote the value), and errors name a finding
# only by its index.
# test-file-advisories.sh pins this; CI runs it. `GH` overrides the gh command, for that test.
set -euo pipefail

findings_file=${1:?usage: file-advisories.sh <findings.json>}
here=$(cd "$(dirname "$0")" && pwd)
gh=${GH:-gh}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

jq -c '{findings: [.findings[]? | select(type == "object") | {
    title: ((.title // "") | tostring | gsub("\\s+"; " ") | sub("^ "; "") | sub(" $"; "") | .[0:200]),
    severity: ((.severity // "") | tostring | ascii_downcase),
    category: ((.category // "unknown") | tostring),
    files: ((.files // []) | if type == "array" then map(tostring) else [tostring] end),
    details: ((.details // "") | tostring),
    reproduction: ((.reproduction // "") | tostring),
    fix: ((.fix // "") | tostring)
  }]}' "$findings_file" >"$work/findings.json" 2>/dev/null ||
  { echo "::error::The findings file isn't valid JSON."; exit 1; }

# Titles already filed, lowercased, one per line. Titles filed in this run are added as they go.
"$gh" api "repos/$GITHUB_REPOSITORY/security-advisories?per_page=100" --paginate \
  --jq '.[].summary | ascii_downcase' >"$work/known" 2>/dev/null ||
  { echo "::error::Couldn't list the advisories already filed."; exit 1; }

failed=0
count=$(jq '.findings | length' "$work/findings.json")
for i in $(seq 0 $((count - 1))); do
  finding=$(jq -c ".findings[$i]" "$work/findings.json")
  title=$(jq -r '.title' <<<"$finding")
  # A finding without a title can't be filed or matched against earlier ones.
  [ -n "$title" ] || { echo "::warning::Finding $i has no title; skipped."; continue; }
  lower=$(tr '[:upper:]' '[:lower:]' <<<"$title")
  # `--`: a title can start with "-", which grep would otherwise read as an option.
  if grep -qxF -- "$lower" "$work/known"; then continue; fi

  body=$(jq -n --argjson f "$finding" --arg run "${RUN_URL:-}" '{
    summary: $f.title,
    severity: (if ($f.severity | IN("low", "medium", "high", "critical")) then $f.severity else "medium" end),
    description: (
      "**Category:** \($f.category)\n\n" +
      "**Where:** " + ($f.files | map("`\(.)`") | join(", ")) + "\n\n" +
      "### What happens\n\n\($f.details)\n\n" +
      "### Reproduction\n\n\($f.reproduction)\n\n" +
      "### Suggested fix\n\n\($f.fix)\n\n" +
      "<sub>Filed by the security auditor ([run](\($run)), ADR-0036). Unverified by a human: triage it, then fix it in the advisory'"'"'s private fork or close it.</sub>"
    ),
    vulnerabilities: [{ package: { ecosystem: "other", name: "roundtable" } }]
  }' 2>/dev/null) || { echo "::error::Finding $i couldn't be turned into an advisory."; failed=$((failed + 1)); continue; }

  # Private, but it may be published one day: no credentials in it, ever. The guard prints only
  # the kind of match.
  "$here/guard-secrets.sh" <<<"$body" || { failed=$((failed + 1)); continue; }

  if "$gh" api -X POST "repos/$GITHUB_REPOSITORY/security-advisories" --input - <<<"$body" >/dev/null 2>&1; then
    printf '%s\n' "$lower" >>"$work/known"
  else
    echo "::error::Filing finding $i failed."
    failed=$((failed + 1))
  fi
done

[ "$failed" -eq 0 ]
