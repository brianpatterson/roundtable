#!/usr/bin/env bash
# Turns the Stryker report CI made on a mutation ticket's pull request (ADR-0069) into the short
# Markdown the reviewer reads:
#   load-mutation-report.sh <artifact dir> <ticket's file> <destination dir>
#
# <ticket's file> is the path the ticket's title names, relative to its app (`src/…`): the caller
# reads it from the ticket, not from the artifact. The artifact was written by the pull request's
# code, so only `mutation.json` is read, at most $MAX_BYTES, and only a fixed shape comes out of
# it: the ticket's file's counts by status, and each of its mutants that isn't killed with its line,
# status, mutator, replacement and (for an ignored one) the disable comment's reason, each cut
# short, at most $MAX_MUTANTS of them. Any other file in the report is only counted: a run with
# `--mutate <file>` has none, so one is a sign the report isn't what CI ran. Run from main (copied
# to $RUNNER_TEMP), so a branch can't loosen it. Never fails the review: with no usable report,
# the destination gets a line saying so.
set -euo pipefail

src="$1/mutation.json"
expected=$2
dest=$3
max_bytes=${MAX_BYTES:-20000000}
max_mutants=${MAX_MUTANTS:-300}

mkdir -p "$dest"
out="$dest/report.md"

none() {
  printf '# Stryker on this pull request\n\nNo report: %s. Treat the ticket'"'"'s Stryker criterion as not verified.\n' "$1" >"$out"
  echo "No mutation report: $1."
  exit 0
}

[[ "$expected" =~ ^src/[A-Za-z0-9_./-]+\.tsx?$ ]] && [[ "$expected" != *..* ]] || none "the ticket names no plain source file"
[ -f "$src" ] && [ ! -L "$src" ] || none "CI's Stryker run on this commit failed, timed out or didn't start"
[ "$(wc -c <"$src")" -le "$max_bytes" ] || none "the report is over $max_bytes bytes"

if ! jq -r --arg file "$expected" --argjson max "$max_mutants" '
  def cut($n): tostring | gsub("[\\s`]+"; " ") | if length > $n then .[0:$n] + "…" else . end;
  (.files | keys | map(select(. != $file)) | length) as $others
  | [.files[$file].mutants // empty | .[]] as $all
  | "# Stryker on this pull request\n\n" +
    "CI ran `test:mutation --mutate \($file) --force` on this commit. Killed and timed-out mutants are counted, not listed.\n\n" +
    (if $others > 0 then "**Warning:** the report also covers \($others) other file(s), which a run on one file doesn'"'"'t produce. Treat it as unreliable.\n\n" else "" end) +
    "## `\($file)`\n\n" +
    if ($all | length) == 0 then "The report has no mutants for this file.\n" else
      ($all | group_by(.status) | map("\(.[0].status | cut(20)): \(length)") | join(", ")) + "\n\n" +
      ([$all[] | select(.status != "Killed" and .status != "Timeout")]
        | sort_by(.location.start.line) | .[0:$max]
        | map("- line \(.location.start.line | cut(8)): \(.status | cut(20)), \(.mutatorName | cut(40)): `` \(.replacement // "" | cut(80)) ``"
            + (if .status == "Ignored" and .statusReason then " (\(.statusReason | cut(200)))" else "" end))
        | if length == 0 then "Every mutant was killed." else join("\n") end) + "\n"
    end
' "$src" >"$out" 2>/dev/null; then
  none "the report isn't Stryker's JSON"
fi

echo "Mutation report: $(grep -c '^- line' "$out" || true) mutants not killed."
