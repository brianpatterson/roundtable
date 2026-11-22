#!/usr/bin/env bash
# Posts the factory reviewer's review on a pull request, with a verdict this script derives from its
# blocking findings (ADR-0026, ADR-0046, ADR-0052).
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
#   RESULT             the reviewer's structured output: {blocking: <number>, review}
#   GITHUB_OUTPUT      where the verdict and the number of minor findings are written
#                      (`verdict=ready|changes`, `minor=<number>`), when set
#   GH                 overrides gh (tests)
#
# The reviewer doesn't choose the verdict (ADR-0052): any blocking finding means changes. It counts
# its blocking findings, and this script also counts the findings the review marks **blocking**
# (`1. **blocking**:`) and takes the larger, so a miscount can't turn a blocker into "ready".
# The minor findings (`1. **minor**:`) are counted for Rework's one minor pass (ADR-0052).
#
# The caller has already passed RESULT through guard-secrets.sh.
set -euo pipefail

GH=${GH:-gh}
repo=$GITHUB_REPOSITORY

reported=$(jq -r '.blocking | select(type == "number" and . >= 0 and . == floor)' <<<"$RESULT")
[ -n "$reported" ] || { echo "::error::The reviewer returned no count of blocking findings." >&2; exit 1; }
review=$(jq -r '.review | select(type == "string")' <<<"$RESULT")
finding() { grep -cE '^[[:space:]]*([0-9]+\.|[-*]) \*\*'"$1"'\*\*' <<<"$review" || true; }
marked=$(finding blocking)
minor=$(finding minor)
blocking=$((reported > marked ? reported : marked))

if [ "$blocking" -gt 0 ]; then
  verdict=changes heading='✋ Changes needed'
else
  verdict=ready heading='✅ Ready for you'
fi
[ -z "${GITHUB_OUTPUT:-}" ] || printf 'verdict=%s\nminor=%s\n' "$verdict" "$minor" >>"$GITHUB_OUTPUT"

marker='<!-- factory-review -->'
nudge_marker='<!-- factory-review-changes -->'
body=$(printf '%s\n### Factory review: %s\n\n%s\n\n<sub>Commit %s, reviewed by the factory'"'"'s reviewer agent (ADR-0026). It never approves; the owner merges.</sub>\n' \
  "$marker" "$heading" "$review" "$SHA")

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
