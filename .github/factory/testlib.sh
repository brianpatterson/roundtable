# shellcheck shell=bash
# What every factory test script shares: a scratch directory, failure counting, and a stand-in
# `gh` that answers from fixture files. Source it first:
#
#   . "$(dirname "$0")/testlib.sh"
#
# It sets `here` (the factory directory, where the scripts under test are) and `work` (a scratch
# directory removed on exit), and turns on `set -euo pipefail`.
#
#   fail <what>                     counts a failed check and prints it
#   expect <what> <expected> <got>  fails unless the two are equal
#   expect_in <what> <output> <text> fails unless the output contains the text
#   finish <message>                exits 1 if anything failed, else prints the message
#   fake_gh [path] <<'ROUTES'       writes a stand-in gh (default $work/gh): see below
#
# A stand-in gh's routes are the arms of a `case` on its whole command line ("$*"), so a pattern
# must cover what follows the part it names ("pr view 5"*). In an arm:
#
#   answer <file>   prints the fixture, filtered by the call's --jq like gh does (strings raw),
#                   or fails like GitHub would if the file is missing
#   refuse          fails like GitHub would
#   record          appends the command line to $GH_FIXTURES/calls and succeeds
#
# A call no route matches is recorded, so a test sees every write a script makes in
# $GH_FIXTURES/calls. Fixtures are read from $GH_FIXTURES, which defaults to $work: point it at a
# case's own directory to keep cases apart. `$filter` holds the call's --jq (`.` without one), and
# the arms may use any environment variable the test passes to the script.
set -euo pipefail

# shellcheck disable=SC2034 # for the test that sources this
here=$(cd "$(dirname "$0")" && pwd)
failures=0
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

fail() {
  echo "FAIL: $1"
  failures=$((failures + 1))
}

expect() {
  [ "$2" = "$3" ] || fail "$1: expected [$2], got [$3]"
}

expect_in() {
  case "$2" in *"$3"*) ;; *) fail "$1: no [$3] in [$2]" ;; esac
}

finish() {
  if [ "$failures" -gt 0 ]; then
    echo "$failures check(s) failed."
    exit 1
  fi
  echo "$1"
}

fake_gh() {
  local path=${1:-$work/gh}
  {
    cat <<HEAD
#!/usr/bin/env bash
GH_FIXTURES=\${GH_FIXTURES:-$work}
HEAD
    cat <<'BODY'
filter=.
prev=
for arg in "$@"; do
  [ "$prev" = --jq ] && filter=$arg
  prev=$arg
done
refuse() {
  echo "GitHub says no" >&2
  exit 1
}
answer() {
  [ -f "$GH_FIXTURES/$1" ] || refuse
  jq -rc "$filter" "$GH_FIXTURES/$1"
}
record() { printf '%s\n' "$CALL" >>"$GH_FIXTURES/calls"; }
CALL="$*"
case "$CALL" in
BODY
    cat
    cat <<'TAIL'
  *) record ;;
esac
TAIL
  } >"$path"
  chmod +x "$path"
}
