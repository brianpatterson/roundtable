#!/usr/bin/env bash
# Gathers a batch's evidence for its retrospective (ADR-0064) into a directory the agent reads:
#
#   gather-retro.sh <parent> <dir>
#
#   <dir>/summary.md         one row per ticket: its pull requests, who wrote their commits, the
#                            labels it went through, and what the factory's runs cost
#   <dir>/spec.md            the parent issue: the spec the tickets were cut from
#   <dir>/tickets/<n>.md     each ticket, its label history and its comments
#   <dir>/prs/<n>.md         each pull request that closed a ticket: its commits and their
#                            authors, files, merge commit and comments
#   <dir>/trails/<name>.json each agent run's trail on those tickets and pull requests, while the
#                            artifact lasts (90 days; agent-trail.sh)
#   <dir>/previous-retros.md earlier retrospectives and the owner's answers to them
#
# Only the owner's comments and the workflows' (github-actions) are kept: anyone can comment on a
# public issue, and the agent reads all of this. Holds no secrets and runs no agent. GH overrides
# the gh binary (tests).
set -euo pipefail

GH=${GH:-gh}
parent=${1:?usage: gather-retro.sh <parent> <dir>}
dir=${2:?usage: gather-retro.sh <parent> <dir>}
repo=${GITHUB_REPOSITORY:?}
owner=${repo%/*}
name=${repo#*/}
me=${GITHUB_REPOSITORY_OWNER:-$owner}

rm -rf "$dir"
mkdir -p "$dir/tickets" "$dir/prs" "$dir/trails"

# Comments from the owner and the workflows only, as Markdown. GraphQL names the bot `github-actions`.
comments_md="
  def comments_md: [.comments.nodes[] | select(.author.login == \$me or .author.login == \"github-actions\")
    | \"\n---\n\(.author.login) commented on \(.createdAt):\n\n\(.body)\n\"] | join(\"\");
"

# shellcheck disable=SC2016 # GraphQL variables, not shell
batch=$("$GH" api graphql -F owner="$owner" -F name="$name" -F number="$parent" -f query='
  query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      issue(number: $number) {
        number title body
        comments(first: 100) { nodes { author { login } createdAt body } }
        subIssues(first: 100) {
          nodes {
            number title state stateReason createdAt closedAt body
            comments(first: 100) { nodes { author { login } createdAt body } }
            timelineItems(first: 200, itemTypes: [LABELED_EVENT, UNLABELED_EVENT]) {
              nodes {
                __typename
                ... on LabeledEvent { createdAt actor { login } label { name } }
                ... on UnlabeledEvent { createdAt actor { login } label { name } }
              }
            }
            closedByPullRequestsReferences(first: 10, includeClosedPrs: true) { nodes { number } }
          }
        }
      }
    }
  }' --jq '.data.repository.issue')

jq -r --arg me "$me" "$comments_md"'
  "# Spec #\(.number): \(.title)\n\n\(.body // "")\n" + comments_md
' <<<"$batch" >"$dir/spec.md"

jq -c '.subIssues.nodes[]' <<<"$batch" | while read -r ticket; do
  jq -r --arg me "$me" "$comments_md"'
    "# Ticket #\(.number): \(.title)\n\n" +
    "- State: \(.state) (\(.stateReason // "open")), opened \(.createdAt), closed \(.closedAt // "never")\n" +
    "- Closed by: " + ([.closedByPullRequestsReferences.nodes[] | "#\(.number)"] | join(", ") | if . == "" then "no pull request" else . end) + "\n\n" +
    "## Labels\n\n" +
    ([.timelineItems.nodes[] | "- \(.createdAt): \(if .__typename == "LabeledEvent" then "added" else "removed" end) `\(.label.name)` (\(.actor.login // "?"))"] | join("\n")) +
    "\n\n## Description\n\n\(.body // "")\n" + comments_md
  ' <<<"$ticket" >"$dir/tickets/$(jq -r .number <<<"$ticket").md"
done

prs=$(jq -r '[.subIssues.nodes[].closedByPullRequestsReferences.nodes[].number] | unique | .[]' <<<"$batch")
pr_data='[]'
for pr in $prs; do
  # shellcheck disable=SC2016 # GraphQL variables, not shell
  data=$("$GH" api graphql -F owner="$owner" -F name="$name" -F number="$pr" -f query='
    query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          number title headRefName state createdAt mergedAt mergedBy { login } body
          additions deletions mergeCommit { oid }
          commits(first: 100) {
            totalCount
            nodes { commit { abbreviatedOid authoredDate messageHeadline authors(first: 5) { nodes { user { login } name } } } }
          }
          files(first: 100) { nodes { path additions deletions } }
          comments(first: 100) { nodes { author { login } createdAt body } }
        }
      }
    }' --jq '.data.repository.pullRequest')
  pr_data=$(jq -c --argjson pr "$data" '. + [$pr]' <<<"$pr_data")
  jq -r --arg me "$me" "$comments_md"'
    def who: [.authors.nodes[] | .user.login // .name] | join(", ");
    "# Pull request #\(.number): \(.title)\n\n" +
    "- Branch: `\(.headRefName)`, \(.state), opened \(.createdAt), merged \(.mergedAt // "never") by \(.mergedBy.login // "nobody")\n" +
    "- Merge commit: \(.mergeCommit.oid // "none") (read it with `git show`)\n" +
    "- Size: +\(.additions) −\(.deletions)\n\n" +
    "## Commits (\(.commits.totalCount))\n\n" +
    ([.commits.nodes[].commit | "- \(.abbreviatedOid) \(.authoredDate) by \(who)\(if any(.authors.nodes[]; .user.login == $me) then " **(the owner)**" else "" end): \(.messageHeadline)"] | join("\n")) +
    "\n\n## Files\n\n" + ([.files.nodes[] | "- `\(.path)` +\(.additions) −\(.deletions)"] | join("\n")) +
    "\n\n## Description\n\n\(.body // "")\n" + comments_md
  ' <<<"$data" >"$dir/prs/$pr.md"
done

# The trails of runs on these tickets and pull requests, while the artifacts last.
wanted=$( {
  jq -r '.subIssues.nodes[].number | "agent-trail-issue-\(.)-"' <<<"$batch"
  for pr in $prs; do echo "agent-trail-pr-$pr-"; done
})
"$GH" api "repos/$repo/actions/artifacts?per_page=100" --paginate \
  --jq '.artifacts[] | select(.expired | not) | select(.name | startswith("agent-trail-")) | "\(.id) \(.name)"' |
  while read -r id artifact; do
    match=false
    for prefix in $wanted; do
      [[ "$artifact" == "$prefix"* ]] && match=true
    done
    [ "$match" = true ] || continue
    [[ "$artifact" =~ ^[a-z0-9-]+$ ]] || continue
    if "$GH" api "repos/$repo/actions/artifacts/$id/zip" >"$dir/trails/$artifact.zip" &&
      unzip -p "$dir/trails/$artifact.zip" trail.json >"$dir/trails/$artifact.json" &&
      jq -e .calls "$dir/trails/$artifact.json" >/dev/null; then
      :
    else
      echo "::warning::Couldn't read the trail $artifact; skipped."
      rm -f "$dir/trails/$artifact.json"
    fi
    rm -f "$dir/trails/$artifact.zip"
  done

# One row per ticket.
trails=$(find "$dir/trails" -name '*.json' -exec jq -c --arg name '{}' '{name: ($name | split("/") | last), turns, cost_usd, outcome}' {} \; | jq -s .)
jq -r --arg me "$me" --argjson prs "$pr_data" --argjson trails "$trails" '
  "# Batch #\(.number): \(.title)\n\n" +
  "| Ticket | Closed | Pull requests | Commits: factory / owner | Labels it went through | Agent runs | Turns | Cost (USD) |\n" +
  "| --- | --- | --- | --- | --- | --- | --- | --- |\n" +
  ([.subIssues.nodes[] | . as $t
    | [.closedByPullRequestsReferences.nodes[].number] as $mine
    | [$prs[] | select(.number as $p | $mine | index($p))] as $own
    | [$own[].commits.nodes[].commit | select(any(.authors.nodes[]; .user.login == $me))] as $by_owner
    | ([$own[].commits.nodes[]] | length) as $all
    | [$trails[] | select(.name as $name | ($name | startswith("agent-trail-issue-\($t.number)-"))
        or any($mine[]; . as $p | $name | startswith("agent-trail-pr-\($p)-")))] as $runs
    | "| #\(.number) \(.title) | \(.stateReason // .state) | \($mine | map("#\(.)") | join(", ")) | \($all - ($by_owner | length)) / \($by_owner | length) | " +
      ([.timelineItems.nodes[] | select(.__typename == "LabeledEvent") | .label.name] | unique | join(", ")) +
      " | \($runs | length) | \([$runs[].turns // 0] | add // 0) | \([$runs[].cost_usd // 0] | add // 0 | . * 100 | round / 100) |"
  ] | join("\n")) +
  "\n\nTrails are in `trails/`, named `agent-trail-<issue-N|pr-N>-<job>-<run>-<attempt>.json`.\n"
' <<<"$batch" >"$dir/summary.md"

"$GH" issue list -R "$repo" --label retro --state all --limit 30 --json number,title,state,stateReason,body,comments |
  jq -r --arg me "$me" '
    if length == 0 then "# Previous retrospectives\n\nNone yet.\n" else
    "# Previous retrospectives\n\n" + (map(
      "## #\(.number): \(.title) (\(.state | ascii_downcase)\(if .stateReason then ", \(.stateReason | ascii_downcase)" else "" end))\n\n\(.body)\n" +
      ([.comments[] | select(.author.login == $me) | "\n---\nThe owner answered:\n\n\(.body)\n"] | join(""))
    ) | join("\n")) end
  ' >"$dir/previous-retros.md"

echo "Gathered #$parent: $(find "$dir/tickets" -name '*.md' | wc -l | tr -d ' ') tickets, $(find "$dir/prs" -name '*.md' | wc -l | tr -d ' ') pull requests, $(find "$dir/trails" -name '*.json' | wc -l | tr -d ' ') trails."
