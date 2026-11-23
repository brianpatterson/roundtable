#!/usr/bin/env bash
# One agent attempt on a factory pull request, for the three agents that push to one: the CI fixer
# (ADR-0028), Rework (ADR-0037, ADR-0053) and the conflict resolver (ADR-0058). Each gets two
# attempts, counted by the marked comment this posts after each one, then hands over to a human.
# The kinds differ only in the table below and in what they check of a push.
#
#   attempt.sh next <kind> <pr>   before the agent: is this pull request the kind's to try, and
#                                 which attempt is it? Prints one line:
#                                   <n>     attempt n of 2
#                                   minor   Rework's one pass over minor findings (PASS=minor)
#                                   limit   two attempts already: labeled needs-human, and said why
#                                   spent   the minor pass since a human last pushed is used: the
#                                           findings are the owner's
#                                 or nothing, with the reason on stderr, when it isn't the kind's to
#                                 try (closed, a fork, not its label, waiting for a human, or moved
#                                 past EXPECT_SHA).
#   attempt.sh report <kind>      after the agent, whether or not it finished: decides the outcome
#                                 from what was pushed, whatever the agent reported, labels the pull
#                                 request needs-human when a human must take over, and posts the
#                                 attempt's marked comment. Writes `outcome` to GITHUB_OUTPUT, and
#                                 exits 1 when the branch changes the factory's own files, so the
#                                 run shows red.
#
# Kinds: ci-fix, rework, conflict. Attempts count from the last commit a human pushed (ci-fix,
# rework), or against one main commit (conflict, MAIN): a new main is a new conflict.
#
# next reads EXPECT_SHA (the head the run was for; optional), MAIN (conflict) and PASS (rework).
# report reads RESULT (the agent's JSON answer, or empty), REASON (why it failed, if it did), PR,
# SHA (the head it started from), BRANCH, ATTEMPT, MAIN (conflict), PASS (rework). Both need
# GITHUB_REPOSITORY; report also uses GITHUB_SERVER_URL and GITHUB_RUN_ID for the run's link.
# GH overrides the gh binary and GUARD the secret guard (tests).
set -euo pipefail

GH=${GH:-gh}
here=$(cd "$(dirname "$0")" && pwd)
GUARD=${GUARD:-$here/guard-secrets.sh}
repo=${GITHUB_REPOSITORY:?}
command=${1:?next or report}
kind=${2:?ci-fix, rework or conflict}

# The kind's table: its comment's marker, the labels that make a pull request its own, who the
# agent is in a message, the ADR its comment cites, and the outcomes its agent may answer (its
# --json-schema enum).
case "$kind" in
  ci-fix) marker='<!-- factory-ci-fix -->' labels='["factory","autofix"]' who=fixer adr=ADR-0028 answers='fixed|reran|needs-human' ;;
  rework) marker='<!-- factory-rework -->' labels='["factory"]' who='rework agent' adr='ADR-0037, ADR-0053' answers='fixed|needs-human' ;;
  conflict) marker='<!-- factory-conflict -->' labels='["factory"]' who=resolver adr=ADR-0058 answers='resolved|needs-human' ;;
  *)
    echo "Unknown kind: $kind" >&2
    exit 2
    ;;
esac
minor_marker='<!-- factory-rework-minor -->'

# What the kind tells the owner when it hands over after two attempts.
handover() {
  case "$kind" in
    ci-fix) echo "The factory tried to fix CI twice and it still fails. Over to you: push a fix. To hand it back, push a commit yourself (that resets the count) and remove \`needs-human\`; it tries again on the next failure. ADR-0028." ;;
    rework) echo "The factory reworked this pull request twice and the reviewer still asks for changes. Over to you: push a fix. To hand it back, push a commit yourself (that resets the count) and remove \`needs-human\`; it tries again on the next \`changes\` verdict. ADR-0037." ;;
    conflict) echo "The factory tried twice to resolve this pull request's conflict with main (at $MAIN) and it still conflicts. Over to you: merge main into the branch and resolve it. To hand it back, remove \`needs-human\`; it tries again when main moves. ADR-0058." ;;
  esac
}

next() {
  local pr=${1:?pr} info skip since comments attempts
  [ "$kind" != conflict ] || : "${MAIN:?conflict attempts count against MAIN}"
  info=$("$GH" pr view "$pr" -R "$repo" --json state,headRefOid,isCrossRepository,labels,commits)

  skip=$(jq -r --argjson own "$labels" --arg expect "${EXPECT_SHA:-}" '
    [.labels[].name] as $l
    | if .state != "OPEN" then "isn'"'"'t open"
      elif .isCrossRepository then "is from a fork"
      elif ($l | any(. as $x | $own | index($x))) | not then "isn'"'"'t the factory'"'"'s to try (no \($own | join(" or ")) label)"
      elif $l | index("needs-human") then "is waiting for a human"
      elif $expect != "" and .headRefOid != $expect then "has moved past \($expect); its own runs decide"
      else empty end' <<<"$info")
  if [ -n "$skip" ]; then
    echo "#$pr $skip." >&2
    return
  fi

  # The kind's marked comments that count: since the last commit a human pushed (a push from the
  # owner resets the count), or naming the main commit (conflict). Others' comments never count.
  since=$(jq -r '[(.commits // [])[] | select(all(.authors[]; (.login // "") | test("^(claude|dependabot)") | not)) | .committedDate] | max // "1970-01-01T00:00:00Z"' <<<"$info")
  comments=$("$GH" api "repos/$repo/issues/$pr/comments" --paginate \
    --jq "[.[] | select(.user.login == \"github-actions[bot]\" and (.body | startswith(\"$marker\"))) | {created_at, body}]" |
    jq -sc 'add // []')
  if [ "$kind" = conflict ]; then
    comments=$(jq -c --arg main "$MAIN" '[.[] | select(.body | contains($main))]' <<<"$comments")
  else
    comments=$(jq -c --arg since "$since" '[.[] | select(.created_at > $since)]' <<<"$comments")
  fi

  # Rework's minor pass doesn't count against the two attempts (ADR-0053). It's one per human push,
  # not per pull request: only comments since the last commit a human pushed count (above), as
  # the minor pass always has.
  if [ "$kind" = rework ]; then
    if [ "${PASS:-}" = minor ]; then
      if jq -e --arg m "$minor_marker" 'any(.body | contains($m))' <<<"$comments" >/dev/null; then
        echo "#$pr has had its minor pass; its minor findings are the owner's." >&2
        echo spent
      else
        echo minor
      fi
      return
    fi
    comments=$(jq -c --arg m "$minor_marker" '[.[] | select(.body | contains($m) | not)]' <<<"$comments")
  fi

  attempts=$(jq length <<<"$comments")
  if [ "$attempts" -ge 2 ]; then
    echo "#$pr: two attempts already; over to a human." >&2
    "$GH" pr edit "$pr" -R "$repo" --add-label needs-human >&2
    "$GH" pr comment "$pr" -R "$repo" --body "$(handover)" >&2
    echo limit
    return
  fi
  echo $((attempts + 1))
}

report() {
  : "${PR:?}" "${SHA:?}" "${BRANCH:?}"
  [ "$kind:${PASS:-}" = rework:minor ] || : "${ATTEMPT:?}"
  [ "$kind" != conflict ] || : "${MAIN:?}"
  local result outcome summary base against code head to_human title extra='' context compared=true

  result=${RESULT:-}
  [ -n "$result" ] || result='{}'
  outcome=$(jq -r '.outcome // "failed"' <<<"$result")
  # The answer may come from explain-failure.sh, which recovers any JSON object without the action's
  # schema check: an outcome the kind's agent can't give counts as no answer, so it can't steer
  # what follows.
  [[ "$outcome" =~ ^($answers)$ ]] || outcome=failed
  summary=$(jq -r --arg who "$who" --arg why "${REASON:-}" \
    '.summary // ("The \($who) stopped without a summary" + (if $why == "" then "" else ": " + $why end) + ". See the run log.")' <<<"$result")
  note() { summary=$(printf '%s\n\n_%s_' "$summary" "$1"); }

  # What the kind checks of the push, before the check every kind makes.
  case "$kind" in
    rework)
      # "fixed" means commits on the branch; without any, CI and the review won't run again.
      local compare
      compare=$("$GH" api "repos/$repo/compare/$SHA...$BRANCH" 2>/dev/null) || compare='{}'
      if [ "$outcome" = fixed ] && [ "$(jq '.ahead_by // 0' <<<"$compare")" -eq 0 ]; then
        outcome=needs-human
        note "The agent reported a fix but pushed no commits."
      fi
      ;;
    conflict)
      check_merge
      ;;
  esac

  # The agent never changes the factory's rules or CI, with an editor or with git (`git restore`,
  # `git mv`). Against the commit it started from (or, for a merge, the main it merged), its push
  # never includes them. If GitHub can't say, a human checks: a check that can't run mustn't pass.
  if [ "$compared" = true ]; then
    base=$SHA against="commit $SHA"
    [ "$kind" != conflict ] || base=$MAIN against=main
    code=0
    "$here/protected-changes.sh" "$base" "$BRANCH" >/dev/null || code=$?
    case "$code" in
      0) ;;
      1)
        outcome=protected
        summary="The branch changes \`.github/\`, \`.claude/\` or \`CLAUDE.md\` against $against. A factory pull request never should, whoever made the change: don't merge it until a human has looked."
        ;;
      *)
        note "GitHub couldn't list every file the branch changes against $against, so what the $who pushed wasn't checked for changes to the factory's own rules. Check it before merging."
        case "$kind:$outcome" in
          ci-fix:failed | ci-fix:needs-human) ;; # goes to a human anyway, under its own heading
          conflict:*) outcome=needs-human ;;
          *) outcome=unchecked ;;
        esac
        ;;
    esac
  fi

  # The heading, and whether a human takes over.
  to_human=true
  case "$kind:$outcome" in
    ci-fix:fixed) head="pushed a fix" to_human=false ;;
    ci-fix:reran) head="re-ran the failed jobs: the failure wasn't caused by this pull request" to_human=false ;;
    ci-fix:unchecked) head="couldn't check what it pushed" ;;
    ci-fix:*) head="couldn't fix it" ;;
    rework:fixed) head="pushed changes; CI and the reviewer run again" to_human=false ;;
    conflict:resolved) head="merged main and pushed; CI and the reviewer run again" to_human=false ;;
    # A crash (an outage, a timeout) isn't an answer: the next merge or sweep retries once.
    conflict:failed)
      if [ "$ATTEMPT" -lt 2 ]; then
        head="the run failed; the next one retries" to_human=false
      else
        head="the run failed twice, over to you"
      fi
      ;;
    # On the minor pass the pull request is already the owner's turn: nothing pushed leaves the
    # findings for them, without asking for a human.
    rework:needs-human | rework:failed)
      if [ "${PASS:-}" = minor ]; then
        head="pushed nothing; the minor findings are yours" to_human=false
      else
        head="over to you"
      fi
      ;;
    *) head="over to you" ;;
  esac
  [ "$to_human" = false ] || hand_to_human

  # Never publish what looks like a credential (ADR-0029).
  if ! "$GUARD" <<<"$summary"; then
    summary="The $who's summary was withheld because it matched a credential pattern. See the run, and rotate the credential."
  fi

  case "$kind" in
    ci-fix) title="CI fix, attempt $ATTEMPT of 2" context="for commit $SHA" ;;
    rework)
      title="Rework, attempt ${ATTEMPT:-} of 2" context="answering the review of commit $SHA"
      if [ "${PASS:-}" = minor ]; then
        title='Rework, minor findings' extra="$minor_marker"$'\n'
      fi
      ;;
    conflict) title="Conflict with main, attempt $ATTEMPT" context="merging main at $MAIN into commit $SHA" ;;
  esac
  "$GH" pr comment "$PR" -R "$repo" --body "$(printf '%s\n%s### %s: %s\n\n%s\n\n<sub>[Run](%s), %s. %s.</sub>\n' \
    "$marker" "$extra" "$title" "$head" "$summary" \
    "${GITHUB_SERVER_URL:-https://github.com}/$repo/actions/runs/${GITHUB_RUN_ID:-0}" "$context" "$adr")"
  echo "outcome=$outcome" >>"${GITHUB_OUTPUT:-/dev/null}"
  echo "#$PR: $outcome"
  [ "$outcome" != protected ] || exit 1
}

hand_to_human() { "$GH" pr edit "$PR" -R "$repo" --add-label needs-human; }

# The resolver's own checks (ADR-0058): the pull request's changes against the main it merged;
# nothing behind means main is in the branch. What was pushed is checked whether or not the agent
# answered: one that pushes and then crashes leaves a pull request that no longer conflicts, which
# no later run would look at again. If GitHub can't compare, nothing can be checked, so a human
# looks, whatever the agent reported: a crashed run may still have pushed.
check_merge() {
  local compare head_now unchecked
  if ! compare=$("$GH" api "repos/$repo/compare/$MAIN...$BRANCH" 2>/dev/null) ||
    ! jq -e '.behind_by | type == "number"' <<<"$compare" >/dev/null 2>&1; then
    compared=false outcome=needs-human
    note "GitHub couldn't compare the branch with main, so what was pushed wasn't checked."
    return
  fi
  # If the head can't be read, assume it moved.
  head_now=$("$GH" pr view "$PR" -R "$repo" --json headRefOid --jq .headRefOid 2>/dev/null) || head_now=
  [ "$outcome" = resolved ] || [ "$head_now" != "$SHA" ] || return 0
  # GitHub leaves out a file's patch when it's large or binary, and lists at most 300 files.
  unchecked=$(jq '([.files[]? | select(.patch == null and (.changes // 0) > 0)] | length) + (if (.files | length) >= 300 then 1 else 0 end)' <<<"$compare")
  if [ "$(jq .behind_by <<<"$compare")" -ne 0 ]; then
    outcome=needs-human
    note "Main ($MAIN) isn't merged into the branch."
  elif jq -e '[.files[]?.patch // "" | select(test("(^|\n)\\+(<<<<<<<|>>>>>>>)( |\n|$)"))] | length > 0' <<<"$compare" >/dev/null; then
    outcome=needs-human
    note "The merge pushed still has conflict markers in it."
  elif [ "$unchecked" -gt 0 ]; then
    outcome=needs-human
    note "GitHub showed no diff for some changed files (large, binary, or past 300), so they weren't checked for conflict markers."
  elif [ "$outcome" = failed ]; then
    outcome=resolved
    note "The agent stopped without answering, but what it pushed passes the checks."
  fi
}

case "$command" in
  next) next "${3:-}" ;;
  report) report ;;
  *)
    echo "Unknown command: $command" >&2
    exit 2
    ;;
esac
