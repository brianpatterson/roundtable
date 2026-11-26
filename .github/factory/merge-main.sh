#!/usr/bin/env bash
# Merges main into a factory branch the implementer pushed without it, when main gained only
# changes to the files the agent's sandbox can't write (`.github/`, `.claude/`, `CLAUDE.md`), so
# its own `git merge origin/main` was refused (ADR-0072, retro #241). The build job runs it from
# main, after the agent. It fetches the branch and main into a new repository of its own, outside
# the workspace, so nothing the agent left there (hooks, config) takes part, and only git touches
# the branch's files: nothing from it runs.
#
#   merge-main.sh <branch>
#
# REPO_URL is where to fetch and push (default: this repository on GitHub, which is public).
#
# Leaves the branch alone, exiting 0, when it already has main, when main also changed files the
# agent could have merged itself, or when the merge conflicts (the conflict resolver takes that,
# ADR-0058). Otherwise it commits the merge and pushes it with a fresh Claude App token, exchanged
# for this job's OIDC token the way the Claude action does it and revoked after the push: a push
# made with the job's own token starts no CI. Exits 1 only when it merged but couldn't push.
# CURL overrides the curl binary and EXCHANGE_URL the exchange endpoint (tests).
set -euo pipefail

branch=${1:?branch}
CURL=${CURL:-curl}
EXCHANGE_URL=${EXCHANGE_URL:-https://api.anthropic.com/api/github/github-app-token-exchange}
protected='^(\.github/|\.claude/|CLAUDE\.md$)'
REPO_URL=${REPO_URL:-https://github.com/${GITHUB_REPOSITORY:?}.git}

# No git config but this repository's, which this script writes: the agent's code ran on this
# runner and could have left a ~/.gitconfig (a proxy, a credential helper, an fsmonitor) for the
# step that holds the OIDC request token. Likewise a new directory, never one that may exist.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
repo=${MERGE_DIR:-$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/merge-main.XXXXXX")} # MERGE_DIR: tests
mkdir "$repo" 2>/dev/null || [ -z "$(ls -A "$repo")" ]
cd "$repo"
git init -q
git remote add origin "$REPO_URL"
git fetch -q origin "+refs/heads/main:refs/remotes/origin/main" "+refs/heads/$branch:refs/remotes/origin/$branch"
git checkout -q -b "$branch" "origin/$branch"

if git merge-base --is-ancestor origin/main HEAD; then
  echo "$branch already has main."
  exit 0
fi

# Both names of a renamed file count, as in protected-changes.sh.
base=$(git merge-base HEAD origin/main)
# On its own, so a failed comparison stops the script rather than reading as "nothing else changed".
changed=$(git diff --no-renames --name-only "$base" origin/main)
if others=$(grep -Ev "$protected" <<<"$changed"); then
  echo "Main also changed $(wc -l <<<"$others" | tr -d ' ') file(s) outside .github/, .claude/ and CLAUDE.md; leaving $branch as it is."
  exit 0
fi

if ! git -c user.name=factory -c user.email=factory@invalid -c core.hooksPath=/dev/null \
  merge --no-edit -q origin/main; then
  git merge --abort
  echo "Merging main into $branch conflicts; leaving it to the conflict resolver."
  exit 0
fi

# -q comes first in every curl call, so no ~/.curlrc takes part.
oidc=$("$CURL" -q -fsS -H "Authorization: bearer ${ACTIONS_ID_TOKEN_REQUEST_TOKEN:?}" \
  "${ACTIONS_ID_TOKEN_REQUEST_URL:?}&audience=claude-code-github-action" | jq -r '.value // empty')
echo "::add-mask::$oidc"
token=$("$CURL" -q -fsS -X POST -H "Authorization: Bearer $oidc" "$EXCHANGE_URL" |
  jq -r '.token // .app_token // empty')
[ -n "$token" ] || {
  echo "::error::Couldn't get a Claude App token to push the merge of main into $branch."
  exit 1
}
echo "::add-mask::$token"
revoke() {
  "$CURL" -q -fsS -o /dev/null -X DELETE -H "Accept: application/vnd.github+json" \
    -H "Authorization: Bearer $token" https://api.github.com/installation/token || true
}
trap revoke EXIT

# Not --force: if the branch moved while this ran, the push fails and the branch keeps the new commit.
auth=$(printf 'x-access-token:%s' "$token" | base64 | tr -d '\n')
if ! git -c "http.extraheader=AUTHORIZATION: basic $auth" push -q origin "HEAD:refs/heads/$branch"; then
  echo "::error::Merged main into $branch but couldn't push it."
  exit 1
fi
echo "Merged main into $branch and pushed it: main had changed only .github/, .claude/ or CLAUDE.md."
