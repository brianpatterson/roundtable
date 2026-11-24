#!/usr/bin/env bash
# Prettier's check on the files git sees: tracked ones, and new ones not yet added that
# .gitignore doesn't exclude. `prettier --check .` reads every directory before it applies
# .prettierignore, so one unreadable directory (the `.idea` the agent sandbox creates) stopped
# `pnpm check` for every factory agent (retro of the mutation batch, after retro #180). Git skips
# a directory it can't read, with a warning. Extra arguments go to Prettier.
set -euo pipefail
cd "$(dirname "$0")/.."

# Tracked files deleted in the working tree are listed too; there's nothing of them to check.
git ls-files --cached --others --exclude-standard -z |
  while IFS= read -r -d '' file; do
    [ -f "$file" ] && printf '%s\0' "$file"
  done |
  xargs -0 prettier --check --ignore-unknown --no-error-on-unmatched-pattern "$@"
