#!/usr/bin/env bash
# After an implementer run on a user report (ADR-0041): takes down what the agent published that
# quotes the user's private report, and tells the owner what can't be taken down.
#
# A comment that quotes it is deleted, which also removes its edit history. Editing can't do that:
# a pull request's title and description keep public revisions, so they are replaced and the
# owner is told to delete the old revisions (a quoted title stays in the timeline). A branch can't
# be taken back either, so it goes to a human, with or without a pull request.
#
#   GITHUB_REPOSITORY  owner/name
#   NUMBER             the issue the run was for
#   BRANCH             the agent's branch, if it pushed one
#   DESCRIPTION        the guard's copy of what the user wrote
#   GH                 overrides gh (tests)
#
# Exits 1 when anything quoted the report, after labeling `needs-human` and leaving a note.
set -euo pipefail

GH=${GH:-gh}
here=$(cd "$(dirname "$0")" && pwd)
repo=$GITHUB_REPOSITORY

quotes() { ! "$here/guard-report-text.sh" "$DESCRIPTION" <<<"$1" >/dev/null; }

problems=""

for id in $("$GH" api "repos/$repo/issues/$NUMBER/comments" --paginate \
  --jq '.[] | select(.user.login == "claude[bot]") | .id'); do
  if quotes "$("$GH" api "repos/$repo/issues/comments/$id" --jq .body)"; then
    "$GH" api -X DELETE "repos/$repo/issues/comments/$id" >/dev/null
    problems+=$'\n'"- A comment of the agent's quoted it. It was deleted, with its edit history."
  fi
done

prs=""
if [ -n "${BRANCH:-}" ]; then
  prs=$("$GH" pr list -R "$repo" --head "$BRANCH" --state all --json number --jq '.[].number')

  for pr in $prs; do
    if quotes "$("$GH" pr view "$pr" -R "$repo" --json title,body --jq '.title + "\n" + .body')"; then
      title=$("$GH" issue view "$NUMBER" -R "$repo" --json title --jq .title)
      "$GH" pr edit "$pr" -R "$repo" --title "Fix $title" \
        --body "Closes #$NUMBER. The title and description were replaced because one of them quoted the user's private report (ADR-0041)."
      problems+=$'\n'"- #$pr's title or description quoted it. Both were replaced, but GitHub keeps the old ones: delete the earlier revisions from the description's edit history (its \"edited\" menu). A quoted title stays visible in the timeline."
    fi
  done

  # The lines the branch adds and its commit messages, whether or not it has a pull request. If
  # GitHub can't compare it, there's nothing to check, not a quote.
  changes=$("$GH" api "repos/$repo/compare/main...$BRANCH" \
    --jq '(.files[].patch // "" | split("\n")[] | select(startswith("+")) | .[1:]), .commits[].commit.message') ||
    changes=""
  if quotes "$changes"; then
    problems+=$'\n'"- The branch \`$BRANCH\` quotes it in code or commit messages. Rewrite those lines and commits, or delete the branch, before merging."
  fi
fi

[ -n "$problems" ] || exit 0

message="This run published part of the user's private report (ADR-0041).$problems"$'\n\n'"Remove \`needs-human\` once it's cleaned up."
if [ -n "$prs" ]; then
  for pr in $prs; do
    "$GH" pr edit "$pr" -R "$repo" --add-label needs-human
    "$GH" pr comment "$pr" -R "$repo" --body "$message"
  done
else
  "$GH" issue edit "$NUMBER" -R "$repo" --add-label needs-human
  "$GH" issue comment "$NUMBER" -R "$repo" --body "$message"
fi
echo "::error::The agent published part of the user's private report; see the note it left."
exit 1
