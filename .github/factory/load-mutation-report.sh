#!/usr/bin/env bash
# Turns the Stryker report CI made on a mutation ticket's pull request (ADR-0069) into the short
# Markdown the reviewer reads:
#   load-mutation-report.sh <artifact dir> <destination dir>
#
# The artifact was written by the pull request's code, so only `mutation.json` is read, at most
# $MAX_BYTES, and only a fixed shape comes out of it: each mutated file's counts by status, and
# each mutant that isn't killed with its line, status, mutator, replacement and (for an ignored one)
# the disable comment's reason, each cut short, at most $MAX_MUTANTS of them. Run from main (copied
# to $RUNNER_TEMP), so a branch can't loosen it. Never fails the review: with no usable report,
# the destination gets a line saying so.
set -euo pipefail

src="$1/mutation.json"
dest=$2
max_bytes=${MAX_BYTES:-20000000}
max_mutants=${MAX_MUTANTS:-300}

mkdir -p "$dest"
out="$dest/report.md"

none() {
  printf '# Stryker on this pull request\n\nNo report: %s. Treat the ticket'"'"'s Stryker criterion as not verified.\n' "$1" >"$out"
  echo "No mutation report: $1."
  exit 0
}

[ -f "$src" ] && [ ! -L "$src" ] || none "CI ran no Stryker check on this commit, or it failed before writing one"
[ "$(wc -c <"$src")" -le "$max_bytes" ] || none "the report is over $max_bytes bytes"

if ! jq -r --argjson max "$max_mutants" '
  def cut($n): tostring | gsub("[\\s`]+"; " ") | if length > $n then .[0:$n] + "…" else . end;
  def plain: tostring | select(test("^[A-Za-z0-9_./@-]{1,200}$")) // "(an odd file name)";
  .files | to_entries
  | "# Stryker on this pull request\n\n" +
    "CI ran `test:mutation --mutate <the ticket'"'"'s file> --force` on this commit. Killed and timed-out mutants are counted, not listed.\n\n" +
    (map(
      .key as $file | [.value.mutants[]] as $all
      | "## `\($file | plain)`\n\n" +
        ($all | group_by(.status) | map("\(.[0].status | cut(20)): \(length)") | join(", ")) + "\n\n" +
        ([$all[] | select(.status != "Killed" and .status != "Timeout")]
          | sort_by(.location.start.line) | .[0:$max]
          | map("- line \(.location.start.line | cut(8)): \(.status | cut(20)), \(.mutatorName | cut(40)): `` \(.replacement // "" | cut(80)) ``"
              + (if .status == "Ignored" and .statusReason then " (\(.statusReason | cut(200)))" else "" end))
          | if length == 0 then "Every mutant was killed." else join("\n") end)
    ) | join("\n\n")) + "\n"
' "$src" >"$out" 2>/dev/null; then
  none "the report isn't Stryker's JSON"
fi

echo "Mutation report: $(grep -c '^- line' "$out" || true) mutants not killed."
