#!/usr/bin/env bash
# Posts the factory reviewer's verdict on a pull request (ADR-0026, ADR-0046).
#
# One review comment per pull request, marked `<!-- factory-review -->`, edited in place on every
# re-review. GitHub sends no event a watcher can see for an edit, so a re-review that asks for
# changes also posts a short new comment, marked `<!-- factory-review-changes -->`, pointing at the
# review. The Claude desktop app's Auto-fix wakes on new comments, not edits. At most one such
# comment exists: every review deletes the earlier ones, so a `ready` re-review leaves none.
# A first review needs none (it's a new comment already), nor does a repeat of the same verdict on
# the same commit (a `review` label re-run).
#
#   GITHUB_REPOSITORY  owner/name
#   PR, SHA            the pull request and the commit reviewed
#   RESULT             the reviewer's structured output: {verdict: ready | changes, review}
#   GH                 overrides gh (tests)
#
# The caller has already passed RESULT through guard-secrets.sh.
set -euo pipefail

GH=${GH:-gh}
repo=$GITHUB_REPOSITORY

verdict=$(jq -r .verdict <<<"$RESULT")
case "$verdict" in
  ready) heading='✅ Ready for you' ;;
  changes) heading='✋ Changes needed' ;;
  *) echo "::error::The reviewer returned no verdict." >&2; exit 1 ;;
esac

marker='<!-- factory-review -->'
nudge_marker='<!-- factory-review-changes -->'
body=$(printf '%s\n### Factory review: %s\n\n%s\n\n<sub>Commit %s, reviewed by the factory'"'"'s reviewer agent (ADR-0026). It never approves; the owner merges.</sub>\n' \
  "$marker" "$heading" "$(jq -r .review <<<"$RESULT")" "$SHA")

# Only the workflow's own comments: anyone can comment on a pull request in a public repository.
comments=$("$GH" api "repos/$repo/issues/$PR/comments" --paginate \
  --jq '.[] | select(.user.login == "github-actions[bot]") | {id, body}')
existing=$(jq -rs --arg m "$marker" '[.[] | select(.body | startswith($m))] | last | .id // empty' <<<"$comments")
previous=$(jq -rs --arg m "$marker" '[.[] | select(.body | startswith($m))] | last | .body // empty' <<<"$comments")
nudges=$(jq -r --arg m "$nudge_marker" 'select(.body | startswith($m)) | .id' <<<"$comments")

if [ -z "$existing" ]; then
  "$GH" pr comment "$PR" -R "$repo" --body "$body"
  exit 0
fi

"$GH" api -X PATCH "repos/$repo/issues/comments/$existing" -f body="$body" >/dev/null

# The same verdict on the same commit (a `review` label re-run) says nothing new: leave the
# comments as they are.
case "$previous" in
  "$marker"$'\n'"### Factory review: $heading"*"<sub>Commit $SHA,"*) exit 0 ;;
esac

for id in $nudges; do
  "$GH" api -X DELETE "repos/$repo/issues/comments/$id" >/dev/null
done

if [ "$verdict" = changes ]; then
  link="${GITHUB_SERVER_URL:-https://github.com}/$repo/pull/$PR#issuecomment-$existing"
  "$GH" pr comment "$PR" -R "$repo" --body "$(printf '%s\nRe-reviewed %s: ✋ changes needed. See [the factory review](%s).\n' \
    "$nudge_marker" "${SHA:0:7}" "$link")"
fi
