#!/usr/bin/env bash
# After the conflict resolver renumbers a pull request's ADR (ADR-0058), gives the ADR its new
# number in the pull request's description too. The agent can't edit the description, and a stale
# number there cost a review finding and a Rework run on every collision (retro #180).
#
# Run in the resolver's job, after its push, from the branch's checkout. Reads PR, SHA (the head the
# resolver started from) and GITHUB_REPOSITORY. Finds the ADR files renamed between SHA and HEAD
# (`git diff --find-renames`), rewrites each one's `ADR-NNNN` and `NNNN-<slug>.md` in the
# description, and comments with what it changed. A link to an ADR with the old number but another
# slug (main's ADR, which kept the number) is left alone. A bare `ADR-NNNN` can't be told apart, so
# it is always taken to mean this pull request's ADR: a description is nearly always written before
# the collision. The comment quotes every line it changed, so a wrong rewrite is easy to spot. Does
# nothing unless HEAD is what the pull request now points at. GH overrides the gh binary (tests).
#
#   renumber-adr-refs.sh --rewrite <old-path> <new-path> […]   rewrite stdin to stdout (tests)
set -euo pipefail

GH=${GH:-gh}

rewrite() { # rewrite <old new>…: the description on stdin, rewritten on stdout
  python3 -I -c '
import re
import sys

pairs = sys.argv[1:]
renames = {}  # old number -> (slug, new number)
for old, new in zip(pairs[0::2], pairs[1::2]):
    o = re.match(r"(\d{4})-(.+)\.md$", old.rsplit("/", 1)[-1])
    n = re.match(r"(\d{4})-(.+)\.md$", new.rsplit("/", 1)[-1])
    if o and n and o.group(2) == n.group(2) and o.group(1) != n.group(1):
        renames[o.group(1)] = (o.group(2), n.group(1))

text = sys.stdin.read()
if not renames:
    sys.stdout.write(text)
    sys.exit()

numbers = "|".join(renames)
plain = re.compile(r"\bADR-(" + numbers + r")\b|\b(" + numbers + r")-([a-z0-9-]+)\.md\b")


def plain_sub(m):
    if m.group(1):
        return "ADR-" + renames[m.group(1)][1]
    number, slug = m.group(2), m.group(3)
    old_slug, new = renames[number]
    return (new if slug == old_slug else number) + "-" + slug + ".md"


link = re.compile(r"\[([^\]]*)\]\(([^)\s]*)\)")


def link_sub(m):
    label, target = m.group(1), m.group(2)
    t = re.search(r"\b(" + numbers + r")-([a-z0-9-]+)\.md\b", target)
    if t and t.group(2) != renames[t.group(1)][0]:
        return m.group(0)  # the number, but another ADR: main kept it
    return "[" + plain.sub(plain_sub, label) + "](" + plain.sub(plain_sub, target) + ")"


out, last = [], 0
for m in link.finditer(text):
    out.append(plain.sub(plain_sub, text[last:m.start()]))
    out.append(link_sub(m))
    last = m.end()
out.append(plain.sub(plain_sub, text[last:]))
sys.stdout.write("".join(out))
' "$@"
}

if [ "${1:-}" = --rewrite ]; then
  shift
  rewrite "$@"
  exit 0
fi

repo=${GITHUB_REPOSITORY:?}
: "${PR:?}" "${SHA:?}"

head=$(git rev-parse HEAD)
pr_head=$("$GH" pr view "$PR" -R "$repo" --json headRefOid --jq .headRefOid)
if [ "$head" != "$pr_head" ]; then
  echo "#$PR points at $pr_head, not this checkout's $head: nothing to renumber."
  exit 0
fi

pairs=()
while IFS=$'\t' read -r status old new; do
  [[ "$status" == R* ]] || continue
  pairs+=("$old" "$new")
done < <(git diff --find-renames --diff-filter=R --name-status "$SHA" HEAD -- docs/adr/)
[ "${#pairs[@]}" -gt 0 ] || { echo "No ADR was renumbered."; exit 0; }

body=$("$GH" pr view "$PR" -R "$repo" --json body --jq .body)
new_body=$(rewrite "${pairs[@]}" <<<"$body")
if [ "$new_body" = "$body" ]; then
  echo "The description names no renumbered ADR."
  exit 0
fi

file=$(mktemp)
printf '%s\n' "$new_body" >"$file"
"$GH" pr edit "$PR" -R "$repo" --body-file "$file"
rm -f "$file"

changes=$(for ((i = 0; i < ${#pairs[@]}; i += 2)); do
  printf -- '- `%s` → `%s`\n' "${pairs[i]##*/}" "${pairs[i + 1]##*/}"
done)
# The rewrite keeps every line in place, so the changed lines pair up one to one.
lines=$(paste -d '\n' <(printf '%s\n' "$body") <(printf '%s\n' "$new_body") | python3 -I -c '
import sys
rows = sys.stdin.read().split("\n")
for before, after in zip(rows[0::2], rows[1::2]):
    if before != after:
        print("- Was: " + before.strip()[:300] + "\n  Now: " + after.strip()[:300])
')
"$GH" pr comment "$PR" -R "$repo" --body "$(printf 'Renumbered in the description, after the merge with main:\n\n%s\n\nThe lines it changed. A bare ADR number is taken to mean this pull request'"'"'s ADR, so check none of these meant main'"'"'s:\n\n%s\n\n<sub>ADR-0058.</sub>' "$changes" "$lines")"
echo "Renumbered the description: ${pairs[*]}"
