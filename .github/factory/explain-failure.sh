#!/usr/bin/env bash
# After a failed agent run: the Claude action hides the agent's messages from the public log,
# including the one that says why it failed (a rejected token, an unknown model). Shows only that
# final message, as an error and in the step summary. Used by every agent job in factory.yml,
# copied from main before the agent runs (a branch can't change it).
#
#   explain-failure.sh <who>   who failed, for the message ("agent", "fixer")
set -euo pipefail

who=${1:-agent}
file="$RUNNER_TEMP/claude-execution-output.json"
[ -f "$file" ] || { echo "::error::The $who failed before writing its output."; exit 0; }
reason=$(jq -r '[.[] | select(.type == "result")] | last | (.result // (.errors // [] | join(", "))) // "no result message"' "$file" | head -c 1000)
echo "::error::The $who failed: $reason"
printf '### The %s failed\n\n~~~\n%s\n~~~\n' "$who" "$reason" >>"${GITHUB_STEP_SUMMARY:-/dev/null}"
