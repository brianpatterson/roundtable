#!/usr/bin/env bash
# The factory's sweeper (ADR-0040): every open factory pull request (labeled `factory` or
# `autofix`) is either moving or labeled `needs-human`, never stuck in silence. Each workflow reacts
# to one event (CI failed, CI passed, the reviewer asked for changes), so a run that ends any other
# way, or a workflow that never starts, leaves a pull request waiting with nobody told. This looks
# at each one's state and either waits, reruns a cancelled CI once, or hands it to a human.
#
#   sweep-prs.sh            sweep every open factory pull request (needs GH_TOKEN, GITHUB_REPOSITORY)
#   sweep-prs.sh --decide   read one state as JSON on stdin, print the decision (for the tests)
#   sweep-prs.sh --one PR   check one pull request (JSON from the list below); the sweep runs each
#                           in its own process, so one that fails doesn't stop the rest
#
# DRY_RUN=true prints what it would do and changes nothing. GH overrides the gh binary (tests).
set -euo pipefail

GH=${GH:-gh}

# The decision, from a state the main loop gathers (ages in minutes):
#   {factory, mergeable, head_age, ci: null | {status, conclusion, attempt, age}, review: null | {verdict, age}}
# `factory` is false for a pull request only labeled `autofix`: it gets no rework (ADR-0037), so a
# `changes` verdict there is the owner's turn, like `ready`.
# Prints {action: wait | ok | rerun | human, reason}.
# shellcheck disable=SC2016 # jq's own $variables
decide='
  def out($a; $r): {action: $a, reason: $r};
  if .mergeable == "CONFLICTING" then
    out("human"; "it conflicts with main, so CI can'"'"'t run on it. Merge main into the branch and resolve the conflict")
  elif .ci == null then
    if .head_age > 30 then out("human"; "no CI run started for its latest commit in \(.head_age) minutes")
    else out("wait"; "CI hasn'"'"'t started yet") end
  elif .ci.status != "completed" then
    if .ci.age > 90 then out("human"; "CI has been \(.ci.status) for \(.ci.age) minutes")
    else out("wait"; "CI is \(.ci.status)") end
  elif .ci.conclusion == "success" then
    if .review == null then
      if .ci.age > 60 then out("human"; "CI passed \(.ci.age) minutes ago and the reviewer hasn'"'"'t reviewed this commit")
      else out("wait"; "waiting for the reviewer") end
    elif .review.verdict == "ready" then out("ok"; "reviewed and ready: the owner'"'"'s turn")
    elif .factory != true then out("ok"; "changes asked on a pull request the factory doesn'"'"'t rework: the owner'"'"'s turn")
    elif .review.age > 120 then out("human"; "the reviewer asked for changes \(.review.age) minutes ago and no rework was pushed")
    else out("wait"; "waiting for the rework") end
  elif .ci.conclusion == "failure" then
    if .ci.age > 120 then out("human"; "CI failed \(.ci.age) minutes ago and the CI fixer hasn'"'"'t pushed a fix")
    else out("wait"; "the CI fixer'"'"'s turn") end
  elif .ci.attempt < 2 then
    out("rerun"; "CI ended `\(.ci.conclusion)` (a job timing out ends this way), which no factory workflow acts on")
  else
    out("human"; "CI ended `\(.ci.conclusion)` again after a rerun")
  end'

if [ "${1:-}" = --decide ]; then
  jq -c "$decide"
  exit 0
fi

: "${GITHUB_REPOSITORY:?}"
repo=$GITHUB_REPOSITORY
now=$(date -u +%s)
minutes_since() { echo $(((now - $(jq -rn --arg t "$1" '$t | fromdateiso8601')) / 60)); }

# shellcheck disable=SC2016 # backticks are Markdown
handback='To hand it back to the factory, fix what blocks it and remove `needs-human`. ADR-0040.'

if [ "${1:-}" = --one ]; then
  pr=$2
  number=$(jq -r .number <<<"$pr")
  sha=$(jq -r .sha <<<"$pr")
  committed=$("$GH" api "repos/$repo/commits/$sha" --jq .commit.committer.date)

  ci=$("$GH" run list -R "$repo" --workflow ci.yml --commit "$sha" --event pull_request --limit 1 \
    --json databaseId,status,conclusion,attempt,startedAt,updatedAt --jq '.[0] // empty')
  ci_state=null
  if [ -n "$ci" ]; then
    # Minutes since it finished, or, while it runs, since this attempt started (a rerun keeps the
    # first attempt's creation time).
    since=$(jq -r 'if .status == "completed" then .updatedAt else .startedAt end' <<<"$ci")
    ci_state=$(jq -c --argjson age "$(minutes_since "$since")" \
      '{status, conclusion, attempt, age: $age}' <<<"$ci")
  fi

  # The reviewer's one comment names the commit it reviewed (review.yml).
  review=$("$GH" api "repos/$repo/issues/$number/comments" --paginate \
    --jq ".[] | select(.user.login == \"github-actions[bot]\" and (.body | startswith(\"<!-- factory-review -->\")) and (.body | contains(\"$sha\")))
          | {verdict: (if (.body | startswith(\"<!-- factory-review -->\\n### Factory review: ✅ Ready for you\")) then \"ready\" else \"changes\" end), updated: .updated_at}" | tail -1)
  review_state=null
  if [ -n "$review" ]; then
    review_state=$(jq -c --argjson age "$(minutes_since "$(jq -r .updated <<<"$review")")" \
      '{verdict, age: $age}' <<<"$review")
  fi

  state=$(jq -nc --argjson pr "$pr" --argjson ci "$ci_state" --argjson review "$review_state" \
    --argjson head_age "$(minutes_since "$committed")" \
    '{factory: $pr.factory, mergeable: $pr.mergeable, head_age: $head_age, ci: $ci, review: $review}')
  decision=$(jq -c "$decide" <<<"$state")
  action=$(jq -r .action <<<"$decision")
  reason=$(jq -r .reason <<<"$decision")
  echo "#$number ${sha:0:7}: $action ($reason)"

  [ "${DRY_RUN:-}" = true ] && exit 0
  case "$action" in
    rerun)
      run=$(jq -r .databaseId <<<"$ci")
      "$GH" run rerun "$run" -R "$repo"
      "$GH" pr comment "$number" -R "$repo" --body "The sweeper reran CI once: $reason. If it ends the same way again, this goes to a human. ADR-0040."
      ;;
    human)
      "$GH" pr edit "$number" -R "$repo" --add-label needs-human
      "$GH" pr comment "$number" -R "$repo" --body "The factory is stuck on this pull request: $reason. Over to you. $handback"
      ;;
  esac
  exit 0
fi

prs=$("$GH" pr list -R "$repo" --state open --limit 100 \
  --json number,labels,mergeable,headRefOid \
  --jq '[.[]
         | select([.labels[].name] | (index("factory") or index("autofix")) and (index("needs-human") | not))
         | {number, mergeable, sha: .headRefOid, factory: ([.labels[].name] | index("factory") != null)}]')

failed=0
while read -r pr; do
  "$0" --one "$pr" || {
    echo "::warning::Couldn't sweep #$(jq -r .number <<<"$pr"); carrying on with the rest."
    failed=$((failed + 1))
  }
done < <(jq -c '.[]' <<<"$prs")
[ "$failed" -eq 0 ]
