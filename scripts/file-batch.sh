#!/usr/bin/env bash
# Files a batch (docs/agents/issue-tracker.md): a spec issue and its tickets, each ticket a
# sub-issue of the spec, with a native blocking edge for every blocker its body names. Labels
# nothing: `ready` is the owner's sign-off. Used by the plan-step skill (.claude/skills/plan-step).
#
#   scripts/file-batch.sh [--dry-run] <dir>
#
# <dir> holds the drafts, each starting with a `# Title` line (the rest is the issue body):
#
#   spec.md         the spec, filed with no label
#   NN-<slug>.md    one ticket per file (01-api.md, 02-web.md), filed in that order, labeled
#                   `enhancement`
#
# In any body, {{spec}} and {{NN}} (two digits) stand for the issue numbers filed, so drafts can name each
# other before they exist. A ticket's `## Blocked by` section is where its blockers come from:
# every {{NN}} there (an earlier ticket) and every #123 (an issue already filed) becomes a blocking
# edge, so the section people read and the order the dispatcher follows can't disagree.
#
# --dry-run checks the drafts and prints what would be filed, calling GitHub for nothing. After
# filing, it reads the sub-issues and edges back and fails if any is missing. On a failure it
# prints what it had already filed, to finish or close by hand.
set -euo pipefail

gh=${GH:-gh}
dry_run=false
if [ "${1:-}" = --dry-run ]; then
  dry_run=true
  shift
fi
dir=${1:?usage: file-batch.sh [--dry-run] <dir>}

die() {
  echo "file-batch: $*" >&2
  exit 1
}

title_of() { # the text of the file's first line, which must be "# Title"
  local first
  first=$(head -n 1 "$1")
  case "$first" in
    '# '?*) printf '%s' "${first#\# }" ;;
    *) die "$1 must start with a '# Title' line" ;;
  esac
}

body_of() { # everything after the title line, leading blank lines dropped
  tail -n +2 "$1" | sed '/./,$!d'
}

blockers_of() { # the {{NN}} and #123 references in the file's "## Blocked by" section, one a line, each once
  awk '/^## /{inside = ($0 ~ /^## Blocked by[[:space:]]*$/); next} inside' "$1" |
    { grep -oE '\{\{[0-9]{2}\}\}|#[0-9]+' || true; } | awk '!seen[$0]++'
}

# Check every draft before filing anything.
[ -f "$dir/spec.md" ] || die "no spec.md in $dir"
title_of "$dir/spec.md" >/dev/null
tickets=()
while IFS= read -r file; do tickets+=("$file"); done < <(find "$dir" -maxdepth 1 -name '[0-9][0-9]-*.md' | sort)
[ "${#tickets[@]}" -gt 0 ] || die "no tickets (NN-<slug>.md) in $dir"
known=" spec "
for file in "${tickets[@]}"; do
  key=$(basename "$file" | cut -c1-2)
  case "$known" in *" $key "*) die "two tickets numbered $key" ;; esac
  title_of "$file" >/dev/null
  for ref in $(blockers_of "$file"); do
    case "$ref" in
      '{{'*) case "$known" in *" ${ref:2:2} "*) ;; *) die "$(basename "$file") is blocked by $ref, which isn't an earlier ticket" ;; esac ;;
    esac
  done
  known="$known$key "
done
for file in "$dir/spec.md" "${tickets[@]}"; do
  while IFS= read -r ref; do
    case "$known" in *" ${ref:2:${#ref}-4} "*) ;; *) die "$(basename "$file") names $ref, which isn't spec or a ticket here" ;; esac
  done < <(grep -oE '\{\{(spec|[0-9]+)\}\}' "$file" | sort -u) # not ${{ … }}: workflow expressions stay as written
done

if $dry_run; then
  echo "Would file, with no labels but enhancement on the tickets:"
  echo "  spec: $(title_of "$dir/spec.md")"
  for file in "${tickets[@]}"; do
    key=$(basename "$file" | cut -c1-2)
    blockers=$(blockers_of "$file" | tr '\n' ' ')
    echo "  {{$key}}: $(title_of "$file")${blockers:+ (blocked by ${blockers% })}"
  done
  exit 0
fi

repo=${GITHUB_REPOSITORY:-$("$gh" repo view --json nameWithOwner --jq .nameWithOwner)}
filed=()
numbers=" "
report() {
  [ "${#filed[@]}" -gt 0 ] || return 0
  echo "file-batch: stopped after filing: ${filed[*]}" >&2
}
on_exit() {
  local code=$?
  [ "$code" -eq 0 ] || report
}
trap on_exit EXIT

create() { # create <title> [label]; prints the new issue's number. The body is written after.
  local url
  url=$("$gh" issue create -R "$repo" --title "$1" --body "Filing this batch…" ${2:+--label "$2"})
  printf '%s' "${url##*/}"
}

number_of() { # number_of <key>: the issue number filed for spec or NN
  local entry
  for entry in $numbers; do
    [ "${entry%%=*}" = "$1" ] && { printf '%s' "${entry#*=}"; return; }
  done
  die "nothing filed for $1"
}

resolve() { # the file's body with every {{key}} replaced by its issue number
  local body key
  body=$(body_of "$1")
  for key in spec "${keys[@]}"; do
    body=${body//"{{$key}}"/"#$(number_of "$key")"}
  done
  printf '%s\n' "$body"
}

n=$(create "$(title_of "$dir/spec.md")")
filed+=("#$n (spec)")
numbers="$numbers spec=$n "
keys=()
for file in "${tickets[@]}"; do
  key=$(basename "$file" | cut -c1-2)
  n=$(create "$(title_of "$file")" enhancement)
  filed+=("#$n")
  numbers="$numbers$key=$n "
  keys+=("$key")
done

spec=$(number_of spec)
for file in "$dir/spec.md" "${tickets[@]}"; do
  key=$(basename "$file" | cut -c1-2)
  [ "$file" = "$dir/spec.md" ] && key=spec
  resolve "$file" >"$dir/.resolved"
  "$gh" issue edit -R "$repo" "$(number_of "$key")" --body-file "$dir/.resolved" >/dev/null
done
rm -f "$dir/.resolved"

id_of() { "$gh" api "repos/$repo/issues/$1" --jq .id; }

expected_edges=()
for file in "${tickets[@]}"; do
  key=$(basename "$file" | cut -c1-2)
  ticket=$(number_of "$key")
  "$gh" api --method POST "repos/$repo/issues/$spec/sub_issues" -F "sub_issue_id=$(id_of "$ticket")" >/dev/null
  for ref in $(blockers_of "$file"); do
    case "$ref" in
      '{{'*) blocker=$(number_of "${ref:2:2}") ;;
      *) blocker=${ref#\#} ;;
    esac
    "$gh" api --method POST "repos/$repo/issues/$ticket/dependencies/blocked_by" -F "issue_id=$(id_of "$blocker")" >/dev/null
    expected_edges+=("$ticket:$blocker")
  done
done

# Read every link back: a sub-issue or edge GitHub didn't keep would leave the batch without a
# retrospective, or a ticket built before its blocker.
subs=" $("$gh" api "repos/$repo/issues/$spec/sub_issues" --jq 'map(.number | tostring) | join(" ")') "
for key in "${keys[@]}"; do
  case "$subs" in *" $(number_of "$key") "*) ;; *) die "#$(number_of "$key") isn't a sub-issue of #$spec" ;; esac
done
for edge in ${expected_edges[@]+"${expected_edges[@]}"}; do
  blocked_by=" $("$gh" api "repos/$repo/issues/${edge%%:*}/dependencies/blocked_by" --jq 'map(.number | tostring) | join(" ")') "
  case "$blocked_by" in *" ${edge#*:} "*) ;; *) die "#${edge%%:*} isn't blocked by #${edge#*:}" ;; esac
done

echo "Filed spec #$spec:"
for file in "${tickets[@]}"; do
  key=$(basename "$file" | cut -c1-2)
  echo "  #$(number_of "$key") $(title_of "$file")"
done
for edge in ${expected_edges[@]+"${expected_edges[@]}"}; do
  echo "  #${edge%%:*} blocked by #${edge#*:}"
done
echo "Nothing is labeled ready."
