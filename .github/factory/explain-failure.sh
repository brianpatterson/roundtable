#!/usr/bin/env bash
# After a failed agent run: the Claude action hides the agent's messages from the public log,
# including the one that says why it failed (a rejected token, an unknown model). Shows only that
# final message, as an error and in the step summary. Used by every agent job in factory.yml,
# copied from main before the agent runs (a branch can't change it).
#
# The action also fails a run that finished but took more turns than --max-turns, and then leaves
# its structured_output empty, although the agent returned its answer (#132: 179 turns of 150, with
# the pull request open). So when the last result is a success with a JSON object answer, whatever
# the action then failed on (this can't tell the turn cap from anything else), this
# writes that answer as the `result` output, for the steps after it to use in place of the
# action's; it passes the same guards there. Always writes `reason`, one line, for a summary.
#
#   explain-failure.sh <who>   who failed, for the message ("agent", "fixer")
set -euo pipefail

who=${1:-agent}
file="$RUNNER_TEMP/claude-execution-output.json"
out=${GITHUB_OUTPUT:-/dev/null}

if [ ! -f "$file" ]; then
  echo "::error::The $who failed before writing its output."
  echo "reason=it failed before writing its output" >>"$out"
  exit 0
fi

last=$(jq -c '[.[] | select(.type == "result")] | last // {}' "$file")
turns=$(jq -r '.num_turns // "?"' <<<"$last")
answer=$(jq -c '
  select(.subtype == "success")
  | if (.structured_output | type) == "object" then .structured_output
    else (.result // "" | try fromjson catch null) end
  | select(type == "object")' <<<"$last")

if [ -n "$answer" ]; then
  reason="it answered after $turns turns, but the action marked the run failed after that; its answer was recovered from the run's output"
  echo "result=$answer" >>"$out"
  echo "::warning::The $who $reason."
  title="The $who finished, but the action failed the run"
else
  reason=$(jq -r '(.result // (.errors // [] | join(", "))) // .subtype // "no result message"' <<<"$last" | head -c 1000)
  reason=${reason//$'\n'/ }
  echo "::error::The $who failed: $reason"
  title="The $who failed"
fi
echo "reason=$reason" >>"$out"
printf '### %s\n\n~~~\n%s\n~~~\n' "$title" "$reason" >>"${GITHUB_STEP_SUMMARY:-/dev/null}"
