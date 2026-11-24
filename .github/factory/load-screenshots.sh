#!/usr/bin/env bash
# Copies the browser tests' screenshots from a CI run's `browser-tests` artifact to where the
# reviewer reads them (ADR-0065, ADR-0066):
#   load-screenshots.sh <artifact dir> <destination dir>
#
# The artifact was written by the pull request's code, so only `screenshots/<project>/<name>.png`
# files with plain names are copied: no other file, nothing nested deeper, no link. At most
# $MAX_FILES files of at most $MAX_BYTES each, so a pull request can't flood the reviewer's context.
# Run from main (copied to $RUNNER_TEMP), so a branch can't loosen it. Never fails the review.
set -euo pipefail

src="$1/screenshots"
dest=$2
max_files=${MAX_FILES:-64}
max_bytes=${MAX_BYTES:-5000000}

mkdir -p "$dest"

if [ ! -d "$src" ]; then
  echo "No screenshots in the artifact."
  exit 0
fi

copied=0
skipped=0

while IFS= read -r -d '' file; do
  project=$(basename "$(dirname "$file")")
  name=$(basename "$file")

  if ! [[ "$project/$name" =~ ^[A-Za-z0-9_-]+/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.png$ ]] ||
    [ "$(wc -c <"$file")" -gt "$max_bytes" ] || [ "$copied" -ge "$max_files" ]; then
    skipped=$((skipped + 1))
    continue
  fi

  mkdir -p "$dest/$project"
  cp "$file" "$dest/$project/$name"
  copied=$((copied + 1))
done < <(find "$src" -mindepth 2 -maxdepth 2 -type f -name '*.png' -print0 | sort -z)

echo "$copied screenshots."
[ "$skipped" = 0 ] || echo "::warning::Skipped $skipped screenshot(s): an odd name, over $max_bytes bytes, or past $max_files files."
