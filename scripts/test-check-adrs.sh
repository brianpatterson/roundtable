#!/usr/bin/env bash
# Checks what scripts/check-adrs.ts catches (ADR-0058), on small ADR directories: main never has a
# duplicate, so CI on main alone would never notice the check breaking. Run from anywhere.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
failures=0
fail() { echo "FAIL: $1"; failures=$((failures + 1)); }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

adr() { # adr <dir> <file> [heading number]
  printf '# %s. A decision\n\n- **Status:** Accepted\n' "${3:-${2:0:4}}" >"$1/$2"
}
row() { # row <dir> <number> <file>
  printf '| %s | [A decision](%s) | Accepted |\n' "$2" "$3" >>"$1/README.md"
}
fixture() { # fixture <name>: two good ADRs, each with its row
  mkdir -p "$work/$1"
  printf '| #    | Decision | Status |\n| ---- | -------- | ------ |\n' >"$work/$1/README.md"
  for n in 0001 0002; do adr "$work/$1" "$n-a.md" && row "$work/$1" "$n" "$n-a.md"; done
  printf '# NNNN. Title\n' >"$work/$1/template.md"
}
expect() { # expect <name> <dir> <pass | text the failure must contain>
  local out status=0
  out=$(node "$here/check-adrs.ts" "$2" 2>&1) || status=$?
  if [ "$3" = pass ]; then
    [ "$status" -eq 0 ] || fail "$1: expected a pass, got [$out]"
  elif [ "$status" -eq 0 ]; then
    fail "$1: expected a failure, got a pass"
  else
    case "$out" in *"$3"*) ;; *) fail "$1: no [$3] in [$out]" ;; esac
  fi
}

fixture good
expect "every ADR numbered once with one row passes" "$work/good" pass

fixture duplicate
adr "$work/duplicate" 0002-b.md && row "$work/duplicate" 0002 0002-b.md
expect "two ADRs with one number fail" "$work/duplicate" "ADR-0002 is taken by 2 files"

fixture unindexed
adr "$work/unindexed" 0003-a.md
expect "an ADR without an index row fails" "$work/unindexed" "0003-a.md has 0 rows"

fixture twice
row "$work/twice" 0002 0002-a.md
expect "an ADR with two index rows fails" "$work/twice" "0002-a.md has 2 rows"

fixture dangling
row "$work/dangling" 0003 0003-gone.md
expect "a row linking a missing file fails" "$work/dangling" "links 0003-gone.md, which doesn't exist"

fixture misnumbered
adr "$work/misnumbered" 0003-a.md && row "$work/misnumbered" 0004 0003-a.md
expect "a row numbered differently from its file fails" "$work/misnumbered" "numbered 0004 links 0003-a.md"

fixture heading
adr "$work/heading" 0003-a.md 0057 && row "$work/heading" 0003 0003-a.md
expect "a heading that doesn't match its file fails" "$work/heading" 'should start with "# 0003. "'

if [ "$failures" -gt 0 ]; then
  echo "$failures failed."
  exit 1
fi
echo "All ADR check cases pass."
