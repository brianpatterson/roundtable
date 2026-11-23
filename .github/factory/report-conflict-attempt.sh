#!/usr/bin/env bash
# After the conflict resolver's agent (ADR-0058): decides the attempt's outcome from what was
# pushed, whatever the agent reported, labels the pull request when a human must take over, and
# posts the one marked comment per attempt that select-conflicts.sh counts.
#
# Reads RESULT (the agent's JSON answer, or empty), REASON (why it failed, if it did), PR, SHA
# (the head it started from), BRANCH, MAIN (the main commit it merged), ATTEMPT, GITHUB_REPOSITORY,
# GITHUB_SERVER_URL, GITHUB_RUN_ID. GH overrides the gh binary and GUARD the secret guard (tests).
# Exits 1 when the branch touches protected paths, so the run shows red.
set -euo pipefail

GH=${GH:-gh}
GUARD=${GUARD:-$RUNNER_TEMP/guard-secrets.sh}
: "${PR:?}" "${SHA:?}" "${BRANCH:?}" "${MAIN:?}" "${ATTEMPT:?}" "${GITHUB_REPOSITORY:?}"

result=${RESULT:-}
[ -n "$result" ] || result='{}'
outcome=$(jq -r '.outcome // "failed"' <<<"$result")
summary=$(jq -r --arg why "${REASON:-}" '.summary // ("The resolver stopped without a summary" + (if $why == "" then "" else ": " + $why end) + ". See the run log.")' <<<"$result")
note() { summary=$(printf '%s\n\n_%s_' "$summary" "$1"); }

# The pull request's own changes against the main it merged; nothing behind means main is in the
# branch. If GitHub can't say, nothing below can be checked, so a human looks, whatever the agent
# reported: a crashed run may still have pushed.
if compare=$("$GH" api "repos/$GITHUB_REPOSITORY/compare/$MAIN...$BRANCH" 2>/dev/null) &&
  jq -e '.behind_by | type == "number"' <<<"$compare" >/dev/null 2>&1; then
  if [ "$outcome" = resolved ]; then
    if [ "$(jq .behind_by <<<"$compare")" -ne 0 ]; then
      outcome=needs-human
      note "The agent reported the conflict resolved, but main ($MAIN) isn't merged into the branch."
    elif jq -e '[.files[]?.patch // "" | select(test("(^|\n)\\+(<<<<<<<|>>>>>>>)( |\n|$)"))] | length > 0' <<<"$compare" >/dev/null; then
      outcome=needs-human
      note "The merge pushed still has conflict markers in it."
    fi
  fi

  # The agent never changes the factory's rules or CI, with an editor or with git (`git restore`,
  # `git mv`). Against the merged main, a factory pull request's own changes never include them.
  if jq -r '.files[]?.filename' <<<"$compare" | grep -qE '^(\.github/|\.claude/|CLAUDE\.md$)'; then
    outcome=protected
    summary="The branch changes \`.github/\`, \`.claude/\` or \`CLAUDE.md\` against main, which the factory may not touch. Don't merge it until a human has looked."
  fi
else
  outcome=needs-human
  note "GitHub couldn't compare the branch with main, so what was pushed wasn't checked."
fi

case "$outcome" in
  resolved) head="merged main and pushed; CI and the reviewer run again" ;;
  # A crash (an outage, a timeout) isn't an answer: the next merge or sweep retries once.
  failed)
    if [ "$ATTEMPT" -lt 2 ]; then
      head="the run failed; the next one retries"
    else
      head="the run failed twice, over to you"
      "$GH" pr edit "$PR" -R "$GITHUB_REPOSITORY" --add-label needs-human
    fi
    ;;
  *)
    head="over to you"
    "$GH" pr edit "$PR" -R "$GITHUB_REPOSITORY" --add-label needs-human
    ;;
esac

# Never publish what looks like a credential (ADR-0029).
if ! "$GUARD" <<<"$summary"; then
  summary="The resolver's summary was withheld because it matched a credential pattern. See the run, and rotate the credential."
fi

body=$(printf '<!-- factory-conflict -->\n### Conflict with main, attempt %s: %s\n\n%s\n\n<sub>[Run](%s), merging main at %s into commit %s. ADR-0058.</sub>\n' \
  "$ATTEMPT" "$head" "$summary" "${GITHUB_SERVER_URL:-https://github.com}/$GITHUB_REPOSITORY/actions/runs/${GITHUB_RUN_ID:-0}" "$MAIN" "$SHA")
"$GH" pr comment "$PR" -R "$GITHUB_REPOSITORY" --body "$body"
echo "#$PR: $outcome"
[ "$outcome" != protected ] || exit 1
