#!/usr/bin/env bash
# Checks scripts/check-format.sh where the agent sandbox runs it: with the unreadable placeholders
# Claude Code's sandbox creates in the checkout root, `.idea` as a directory or as a file. The
# check must still pass on a formatted tree and still fail on a misformatted file, new or tracked.
# Uses this repo's Prettier and .prettierignore. Run from anywhere.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
root=$(dirname "$here")
export PATH="$root/node_modules/.bin:$PATH"
failures=0
fail() { echo "FAIL: $1"; failures=$((failures + 1)); }

work=$(mktemp -d)
trap 'chmod -R u+rwx "$work"; rm -rf "$work"' EXIT

repo() { # repo <name>: a formatted git repo with the check, its ignore file and one tracked file
  local dir="$work/$1"
  mkdir -p "$dir/scripts"
  cp "$here/check-format.sh" "$dir/scripts/"
  cp "$root/.prettierignore" "$dir/"
  printf 'export const a = 1;\n' >"$dir/a.ts"
  git -C "$dir" init -q
  git -C "$dir" add .
  echo "$dir"
}
placeholders() { # placeholders <dir> <idea: dir | file>
  for name in .bash_profile .bashrc .gitconfig .mcp.json .profile .ripgreprc .zprofile .zshrc; do
    touch "$1/$name" && chmod 000 "$1/$name"
  done
  if [ "$2" = dir ]; then mkdir "$1/.idea"; else touch "$1/.idea"; fi
  chmod 000 "$1/.idea"
}
expect() { # expect <name> <dir> <pass | fail>
  local status=0
  "$2/scripts/check-format.sh" >/dev/null 2>&1 || status=$?
  if [ "$3" = pass ] && [ "$status" -ne 0 ]; then fail "$1: expected a pass, exit $status"; fi
  if [ "$3" = fail ] && [ "$status" -eq 0 ]; then fail "$1: expected a failure, got a pass"; fi
  return 0
}

for idea in dir file; do
  dir=$(repo "formatted-$idea")
  placeholders "$dir" "$idea"
  expect "passes with an unreadable .idea $idea" "$dir" pass

  dir=$(repo "new-file-$idea")
  placeholders "$dir" "$idea"
  printf 'export const b  =  2\n' >"$dir/b.ts"
  expect "fails on a misformatted new file, with an unreadable .idea $idea" "$dir" fail

  dir=$(repo "tracked-$idea")
  placeholders "$dir" "$idea"
  printf 'export const a  =  1\n' >"$dir/a.ts"
  expect "fails on a misformatted tracked file, with an unreadable .idea $idea" "$dir" fail
done

dir=$(repo deleted)
rm "$dir/a.ts"
expect "passes when a tracked file was deleted" "$dir" pass

[ "$failures" -eq 0 ] || exit 1
echo "check-format.sh: all cases pass."
