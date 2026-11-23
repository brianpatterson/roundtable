#!/usr/bin/env bash
# Which of the files the factory may never change (`.github/`, `.claude/`, `CLAUDE.md`) differ
# between two commits, by GitHub's three-dot compare (ADR-0029). Every agent job checks what its
# agent pushed with this, from main, after the agent.
#
#   protected-changes.sh <base> <head>
#
# Exits 0 when none changed, 1 when some did (printing them), and 2 when GitHub couldn't say: the
# compare failed, or listed 300 files, its limit, so more may be unlisted. A caller treats 2 as a
# human's to check, never as "none": a check that can't run mustn't pass. Needs GITHUB_REPOSITORY;
# GH overrides the gh binary (tests).
set -euo pipefail

GH=${GH:-gh}
: "${GITHUB_REPOSITORY:?}" "${1:?base}" "${2:?head}"

if ! compare=$("$GH" api "repos/$GITHUB_REPOSITORY/compare/$1...$2" 2>/dev/null) ||
  ! jq -e '.files | type == "array" and length < 300' <<<"$compare" >/dev/null 2>&1; then
  echo "GitHub couldn't list every file changed between $1 and $2." >&2
  exit 2
fi

# A renamed file is listed under its new name, with the old one in `previous_filename`: both
# count, or `git mv .github/workflows/ci.yml docs/` would pass as a change to `docs/` alone.
if files=$(jq -r '.files[] | .filename, (.previous_filename // empty)' <<<"$compare" |
  grep -E '^(\.github/|\.claude/|CLAUDE\.md$)'); then
  echo "$files"
  exit 1
fi
