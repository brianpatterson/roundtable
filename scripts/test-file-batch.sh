#!/usr/bin/env bash
# Checks scripts/file-batch.sh, which files a spec and its tickets as one batch
# (docs/agents/issue-tracker.md), against a stand-in gh. Run from anywhere.
# shellcheck source=.github/factory/testlib.sh
. "$(dirname "$0")/../.github/factory/testlib.sh"
script="$(cd "$(dirname "$0")" && pwd)/file-batch.sh"

# Issues are numbered from 300 in the order they're created; an issue's database id is 9000 + its
# number. Bodies written with `issue edit` are kept as body-<n>.
fake_gh <<'ROUTES'
  "issue create"*)
    record
    n=$(($(cat "$GH_FIXTURES/next" 2>/dev/null || echo 300)))
    echo $((n + 1)) >"$GH_FIXTURES/next"
    echo "https://github.com/o/r/issues/$n" ;;
  "issue edit -R o/r "*) record; cp "$7" "$GH_FIXTURES/body-$5" ;;
  "api repos/o/r/issues/"*"/sub_issues --jq"*) answer subs.json ;;
  "api repos/o/r/issues/"*"/dependencies/blocked_by --jq"*) n=$(echo "$2" | cut -d/ -f5); answer "blocked-$n.json" ;;
  "api repos/o/r/issues/"*" --jq .id") n=${2##*/}; echo $((9000 + n)) ;;
ROUTES

run() { # run <args…>; sets status and out
  status=0
  out=$(GH="$work/gh" GITHUB_REPOSITORY=o/r "$script" "$@" 2>&1) || status=$?
}

drafts() { # a spec, an API ticket and a web ticket blocked by it and by #42
  rm -rf "$work/batch" "$work/calls" "$work/next" "$work"/body-*
  mkdir -p "$work/batch"
  printf '# Spec: the thing\n\n## Tickets\n\n1. {{01}} the API\n2. {{02}} the page\n' >"$work/batch/spec.md"
  printf '# The API\n\n## Problem\n\nPart of {{spec}}.\n' >"$work/batch/01-api.md"
  printf '# The page\n\n## Problem\n\nCalls {{01}}.\n\n## Blocked by\n\n- {{01}} (the endpoint)\n- #42\n\n## Out of scope\n\n- Not #99\n' >"$work/batch/02-web.md"
  echo '[{"number":301},{"number":302}]' >"$work/subs.json"
  echo '[{"number":301},{"number":42}]' >"$work/blocked-302.json"
}

drafts
run --dry-run "$work/batch"
expect "a dry run succeeds" 0 "$status"
expect_in "and lists the blockers it found" "$out" "{{02}}: The page (blocked by {{01}} #42)"
expect "and calls GitHub for nothing" false "$([ -f "$work/calls" ] && echo true || echo false)"

drafts
run "$work/batch"
expect "filing succeeds" 0 "$status"
expect_in "the spec is filed with no label" "$(sed -n 1p "$work/calls")" "--title Spec: the thing --body"
expect "and has no label" "" "$(sed -n 1p "$work/calls" | grep -o -- '--label' || true)"
expect_in "tickets are labeled enhancement only" "$(sed -n 2p "$work/calls")" "--title The API --body Filing this batch… --label enhancement"
expect_in "the spec's body names the ticket numbers" "$(cat "$work/body-300")" "1. #301 the API"
expect "and drops the title line" "## Tickets" "$(sed -n 1p "$work/body-300")"
expect_in "a ticket's body names the spec" "$(cat "$work/body-301")" "Part of #300."
expect_in "and an earlier ticket" "$(cat "$work/body-302")" "Calls #301."
expect_in "both tickets become sub-issues of the spec" "$(grep sub_issue_id "$work/calls" | tr '\n' ' ')" "issues/300/sub_issues -F sub_issue_id=9301 api --method POST repos/o/r/issues/300/sub_issues -F sub_issue_id=9302"
expect_in "Blocked by's earlier ticket becomes an edge" "$(cat "$work/calls")" "issues/302/dependencies/blocked_by -F issue_id=9301"
expect_in "and so does an issue already filed" "$(cat "$work/calls")" "issues/302/dependencies/blocked_by -F issue_id=9042"
expect "an issue named outside Blocked by isn't an edge" "" "$(grep 'issue_id=9099' "$work/calls" || true)"
expect "nothing is labeled ready" "" "$(grep -- 'ready' "$work/calls" || true)"
expect_in "it reports what it filed" "$out" "#302 blocked by #42"

drafts
echo '[{"number":301}]' >"$work/subs.json"
run "$work/batch"
expect "a sub-issue GitHub didn't keep fails the run" 1 "$status"
expect_in "naming it" "$out" "#302 isn't a sub-issue of #300"
expect_in "and listing what was filed" "$out" "stopped after filing: #300 (spec) #301 #302"

drafts
echo '[{"number":301}]' >"$work/blocked-302.json"
run "$work/batch"
expect "an edge GitHub didn't keep fails the run" 1 "$status"
expect_in "naming it" "$out" "#302 isn't blocked by #42"

drafts
printf '# The API\n\n## Blocked by\n\n- {{02}}\n' >"$work/batch/01-api.md"
run --dry-run "$work/batch"
expect "a ticket blocked by a later one is refused" 1 "$status"
expect_in "naming it" "$out" "01-api.md is blocked by {{02}}, which isn't an earlier ticket"

drafts
printf 'The API\n' >"$work/batch/01-api.md"
run "$work/batch"
expect "a draft without a title line is refused" 1 "$status"
expect "before anything is filed" false "$([ -f "$work/calls" ] && echo true || echo false)"

drafts
printf '# Spec\n\nSee {{03}}.\n' >"$work/batch/spec.md"
run "$work/batch"
expect "a placeholder for no ticket is refused" 1 "$status"
expect_in "naming it" "$out" "spec.md names {{03}}"

finish "file-batch.sh: all checks passed."
