#!/usr/bin/env bash
# Checks the `factory` commit status (ADR-0063) against a stand-in gh that answers the pull
# request's labels and logs every status it is asked to set. Run from anywhere:
# .github/factory/test-factory-status.sh
# shellcheck source=.github/factory/testlib.sh
. "$(dirname "$0")/testlib.sh"

fake_gh <<'ROUTES'
  "pr view"*) jq -c "{labels: map({name: .})} | $filter" <<<"$LABELS" ;;
  "api -X"*) [ -z "${FAIL_STATUS:-}" ] || refuse; record ;;
  *) refuse ;;
ROUTES

# status <labels JSON> <args...>: runs factory-status.sh on commit abc of #5 and sets $calls.
status() {
  local labels=$1
  shift
  : >"$work/calls"
  GH=$work/gh LABELS=$labels GITHUB_REPOSITORY=o/r SHA=abc PR=5 \
    GITHUB_SERVER_URL=https://github.com GITHUB_RUN_ID=7 \
    "$here/factory-status.sh" "$@" >/dev/null || fail "factory-status.sh $* exited $?"
  calls=$(cat "$work/calls")
}
reviewed() { # reviewed <labels JSON> <verdict> <minor>
  local labels=$1
  VERDICT=$2 MINOR=$3 status "$labels" --reviewed
}
expect_status() { # expect_status <name> <state> <description>
  case "$calls" in
    *"state=$2 -f description=$3 "*) ;;
    *) fail "$1: expected $2 \"$3\", got [$calls]" ;;
  esac
}

status '[]' pending "Working: reviewing"
expect_status "a plain status" pending "Working: reviewing"
case "$calls" in *"repos/o/r/statuses/abc -f context=factory "*) ;; *) fail "the status is the factory context on the commit: [$calls]" ;; esac
case "$calls" in *"target_url=https://github.com/o/r/actions/runs/7"*) ;; *) fail "the status links the run: [$calls]" ;; esac

status '[]' success "$(printf 'x%.0s' {1..200})"
description=$(sed -n 's/.*-f description=\(x*\.\.\.\) .*/\1/p' <<<"$calls")
[ "${#description}" -eq 140 ] || fail "a long description is cut to GitHub's 140 characters, got ${#description}"

reviewed '["factory"]' ready 0
expect_status "a factory PR, ready with nothing to fix" success "Done: ready for you"
reviewed '["factory"]' changes 0
expect_status "a factory PR with changes asked goes to Rework" pending "Working: reviewed; deciding on a rework"
reviewed '["factory"]' ready 2
expect_status "a factory PR with minor findings goes to Rework" pending "Working: reviewed; deciding on a rework"
reviewed '["factory","needs-human"]' changes 0
expect_status "a PR a human has taken over isn't reworked" success "Done: changes needed, your turn"
reviewed '[]' changes 1
expect_status "the owner's own PR with changes asked" success "Done: changes needed, your turn"
reviewed '["autofix"]' ready 3
expect_status "a PR the factory doesn't rework, with minor findings" success "Done: ready for you, with minor findings"

FAIL_STATUS=1 status '[]' success "Done"
[ -z "$calls" ] || fail "a status GitHub refused isn't logged"

if GH=$work/gh GITHUB_REPOSITORY=o/r SHA=abc "$here/factory-status.sh" failure "x" >/dev/null 2>&1; then
  fail "a state other than pending, success or error is refused"
fi

# Rework's minor pass, and Rework itself, run on the same test as --reviewed: pin them together.
if ! grep -qF "jq -e 'any(. == \"factory\")' <<<\"\$labels\"" "$here/../workflows/rework.yml" ||
  ! grep -qF "any(. == \"needs-human\")' <<<\"\$labels\"" "$here/../workflows/rework.yml"; then
  fail "rework.yml no longer selects factory pull requests without needs-human, as --reviewed assumes"
fi

finish "All factory status checks pass."
