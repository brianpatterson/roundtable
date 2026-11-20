#!/usr/bin/env bash
# Refuses text that quotes a user's report (ADR-0041). The report is private, and everything the
# factory publishes (comments, pull requests, commits) is public, so the implementer describes
# the bug in its own words. This catches a slip: any run of 40 characters from the description,
# compared without case and with whitespace collapsed. A description under 20 characters ("it
# broke") is too generic to check.
#
# Usage: guard-report-text.sh <description file> < text. Exits 1, never printing the match.
set -euo pipefail

WINDOW=40
MIN=20

normalize() { tr '[:upper:]' '[:lower:]' | tr -s '[:space:]' ' '; }

description=$(normalize <"$1" | sed -E 's/^ +| +$//g')
text=$(normalize)
length=${#description}

[ "$length" -ge "$MIN" ] || exit 0

windows=$(mktemp)
trap 'rm -f "$windows"' EXIT

if [ "$length" -le "$WINDOW" ]; then
  printf '%s\n' "$description" >"$windows"
else
  for ((i = 0; i + WINDOW <= length; i++)); do
    printf '%s\n' "${description:i:WINDOW}"
  done >"$windows"
fi

if grep -qF -f "$windows" <<<"$text"; then
  echo "::error::Refusing to publish text that quotes the user's private report (ADR-0041)."
  exit 1
fi
