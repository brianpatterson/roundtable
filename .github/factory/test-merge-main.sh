#!/usr/bin/env bash
# Checks when the build job merges main into the branch the implementer pushed (ADR-0072), against
# a local repository and a stand-in curl for the token exchange.
# Run from anywhere: .github/factory/test-merge-main.sh
# shellcheck source=.github/factory/testlib.sh
. "$(dirname "$0")/testlib.sh"

export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t

# A stand-in curl: the OIDC request, the exchange, and the revoke, each recorded.
cat >"$work/curl" <<'CURL'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$CALLS"
case "$*" in
  *audience=claude-code-github-action*) echo '{"value":"oidc-1"}' ;;
  *exchange*) [ -n "${NO_TOKEN:-}" ] && echo '{}' || echo '{"token":"app-1"}' ;;
  *installation/token*) ;;
esac
CURL
chmod +x "$work/curl"

commit() { # commit <repo> <file> [content]
  mkdir -p "$(dirname "$1/$2")"
  echo "${3:-$RANDOM}" >"$1/$2"
  git -C "$1" add -A
  git -C "$1" commit -qm "change $2"
}

# setup <case> <file main changes>...: a branch with one commit of its own, then main moves.
setup() {
  local dir=$work/$1
  shift
  git init -q --bare -b main "$dir/origin.git"
  git clone -q "$dir/origin.git" "$dir/seed" 2>/dev/null
  commit "$dir/seed" README.md
  git -C "$dir/seed" push -q origin main
  git -C "$dir/seed" switch -qc claude/issue-1-x
  commit "$dir/seed" apps/web/a.ts
  git -C "$dir/seed" push -q origin claude/issue-1-x
  git -C "$dir/seed" switch -q main
  for file in "$@"; do commit "$dir/seed" "$file"; done
  git -C "$dir/seed" push -q origin main
  : >"$dir/calls"
}

run() { # run <case>: prints the script's output; sets $code
  local dir=$work/$1
  code=0
  out=$(REPO_URL=$dir/origin.git MERGE_DIR=$dir/work CALLS=$dir/calls CURL=$work/curl EXCHANGE_URL=https://x/exchange \
    ACTIONS_ID_TOKEN_REQUEST_URL='https://oidc?x=1' ACTIONS_ID_TOKEN_REQUEST_TOKEN=req \
    "$here/merge-main.sh" claude/issue-1-x 2>&1) || code=$?
}

remote_head() { git -C "$work/$1/origin.git" rev-parse claude/issue-1-x; }
pushed_head() { git -C "$work/$1/work" rev-parse HEAD; }

# Main changed only what the agent can't write: merged, pushed, the token revoked.
setup protected .github/workflows/ci.yml .claude/settings.json CLAUDE.md
before=$(remote_head protected)
run protected
expect "a protected-only main is merged" 0 "$code"
expect_in "it says so" "$out" "Merged main"
[ "$(remote_head protected)" != "$before" ] || fail "the merge is pushed"
expect "the pushed commit is the merge" "$(pushed_head protected)" "$(remote_head protected)"
git -C "$work/protected/origin.git" merge-base --is-ancestor main claude/issue-1-x || fail "the branch now has main"
expect "the merge has two parents" 2 "$(git -C "$work/protected/origin.git" rev-list --parents -n1 claude/issue-1-x | wc -w | awk '{print $1 - 1}')"
calls=$(cat "$work/protected/calls")
expect_in "the OIDC token is asked for with the action's audience" "$calls" "audience=claude-code-github-action"
expect_in "it is exchanged for an App token" "$calls" "-X POST -H Authorization: Bearer oidc-1 https://x/exchange"
expect_in "the App token is revoked after the push" "$calls" "Authorization: Bearer app-1 https://api.github.com/installation/token"
expect_in "the tokens are masked" "$out" "::add-mask::app-1"

# A rename into .github/ counts as a change outside it too: the file left the root.
setup rename
mkdir "$work/rename/seed/.github"
git -C "$work/rename/seed" mv README.md .github/README.md
git -C "$work/rename/seed" commit -qm rename
git -C "$work/rename/seed" push -q origin main
before=$(remote_head rename)
run rename
expect "a rename into .github/ leaves the branch alone" "$before" "$(remote_head rename)"
expect_in "it says why" "$out" "outside .github/"

# Main also changed files the agent could merge: left alone, no token asked for.
setup mixed .github/workflows/ci.yml apps/api/b.ts
before=$(remote_head mixed)
run mixed
expect "a mixed main exits 0" 0 "$code"
expect "a mixed main leaves the branch alone" "$before" "$(remote_head mixed)"
expect "no token is asked for when nothing is pushed" "" "$(cat "$work/mixed/calls")"

# Already up to date: nothing to do.
setup current
run current
expect_in "a branch that has main is left alone" "$out" "already has main"
expect "nothing asked for when up to date" "" "$(cat "$work/current/calls")"

# A conflict: aborted, the working tree clean, nothing pushed.
setup conflict
commit "$work/conflict/seed" .github/a.md main-side
git -C "$work/conflict/seed" push -q origin main
git -C "$work/conflict/seed" switch -q claude/issue-1-x
commit "$work/conflict/seed" .github/a.md branch-side
git -C "$work/conflict/seed" push -q origin claude/issue-1-x
before=$(remote_head conflict)
run conflict
expect "a conflict exits 0" 0 "$code"
expect_in "a conflict is left to the resolver" "$out" "conflict resolver"
expect "a conflict pushes nothing" "$before" "$(remote_head conflict)"
expect "the aborted merge leaves a clean tree" "" "$(git -C "$work/conflict/work" status --porcelain)"
expect "no token is asked for on a conflict" "" "$(cat "$work/conflict/calls")"

# No token from the exchange: an error, nothing pushed.
setup notoken CLAUDE.md
before=$(remote_head notoken)
code=0
out=$(REPO_URL=$work/notoken/origin.git MERGE_DIR=$work/notoken/work NO_TOKEN=1 CALLS=$work/notoken/calls CURL=$work/curl EXCHANGE_URL=https://x/exchange \
  ACTIONS_ID_TOKEN_REQUEST_URL='https://oidc?x=1' ACTIONS_ID_TOKEN_REQUEST_TOKEN=req \
  "$here/merge-main.sh" claude/issue-1-x 2>&1) || code=$?
expect "no App token fails the step" 1 "$code"
expect "no App token pushes nothing" "$before" "$(remote_head notoken)"

finish "merge-main.sh merges a main that changed only protected files, and leaves every other branch alone"
