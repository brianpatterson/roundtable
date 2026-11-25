#!/usr/bin/env bash
# Checks the agent trail (ADR-0064): it keeps what the agent did and none of what it read or said.
# Run from anywhere: .github/factory/test-agent-trail.sh
# shellcheck source=.github/factory/testlib.sh
. "$(dirname "$0")/testlib.sh"

repo="$work/repo"
mkdir -p "$repo/apps/api/src"

run() { # run [job]; sets status, out, trail (the file's contents, or empty)
  status=0
  out=$(RUNNER_TEMP="$work" GITHUB_WORKSPACE="$repo" "$here/agent-trail.sh" "${1:-build}" 2>&1) || status=$?
  trail=$(cat "$work/agent-trail/trail.json" 2>/dev/null || true)
}

cat >"$work/claude-execution-output.json" <<'JSON'
[
  {"type": "system", "subtype": "init"},
  {"type": "assistant", "message": {"content": [
    {"type": "text", "text": "The report says the user's name is Jane Example."},
    {"type": "tool_use", "id": "a", "name": "Read", "input": {"file_path": "apps/api/src/server.ts"}},
    {"type": "tool_use", "id": "b", "name": "Read", "input": {"file_path": "/home/runner/work/_temp/user-report/description.txt"}},
    {"type": "tool_use", "id": "c", "name": "Grep", "input": {"pattern": "Jane Example", "path": "apps/api"}},
    {"type": "tool_use", "id": "d", "name": "Bash", "input": {"command": "pnpm --filter @roundtable/api test -- rounds.test.ts && echo 'Jane Example' | wc -l"}},
    {"type": "tool_use", "id": "e", "name": "Edit", "input": {"file_path": "apps/api/src/new file.ts", "old_string": "secret", "new_string": "Jane Example"}},
    {"type": "tool_use", "id": "f", "name": "Agent", "input": {"subagent_type": "Explore", "prompt": "find Jane Example"}},
    {"type": "tool_use", "id": "g", "name": "Bash", "input": {"command": "pnpm --filter @roundtable/web test:browser"}}
  ]}},
  {"type": "user", "message": {"content": [
    {"type": "tool_result", "tool_use_id": "a", "content": "export const server = 1"},
    {"type": "tool_result", "tool_use_id": "d", "is_error": true, "content": "FAIL rounds.test.ts: Jane Example"},
    {"type": "tool_result", "tool_use_id": "g", "is_error": true, "content": "Claude requested permissions to use Bash, but you haven't granted it yet."}
  ]}},
  {"type": "result", "subtype": "success", "num_turns": 12, "duration_ms": 345000, "total_cost_usd": 1.5,
   "permission_denials": [{"tool_name": "Bash", "tool_use_id": "g", "tool_input": {"command": "pnpm --filter @roundtable/web test:browser"}}], "result": "Built it for Jane Example"}
]
JSON

run build
expect "a readable transcript exits 0" 0 "$status"
[ -n "$trail" ] || fail "writes a trail"
[[ "$trail" != *Jane* ]] || fail "keeps none of what the agent read, searched for, wrote or said"
[[ "$trail" != *secret* ]] || fail "keeps no edit's text"
expect "names the job" build "$(jq -r .job <<<"$trail")"
expect "keeps the outcome" success "$(jq -r .outcome <<<"$trail")"
expect "keeps the turns" 12 "$(jq -r .turns <<<"$trail")"
expect "keeps the duration" 345000 "$(jq -r .duration_ms <<<"$trail")"
expect "keeps the cost" 1.5 "$(jq -r .cost_usd <<<"$trail")"
expect "counts the denials" 1 "$(jq -r .denied <<<"$trail")"
expect "keeps every call, in order" "Read Read Grep Bash Edit Agent Bash" "$(jq -r '[.calls[].tool] | join(" ")' <<<"$trail")"
expect "shows a plain file in the repository" apps/api/src/server.ts "$(jq -r '.calls[0].target' <<<"$trail")"
expect "hides a file outside the repository" "(outside the repository)" "$(jq -r '.calls[1].target' <<<"$trail")"
expect "shows where a search looked, not what for" apps/api "$(jq -r '.calls[2].target' <<<"$trail")"
expect "shapes a command: programs and plain words" "pnpm --filter @roundtable/api test … && echo … | wc -l" "$(jq -r '.calls[3].target' <<<"$trail")"
expect "hides a path with an unusual part" "…" "$(jq -r '.calls[4].target' <<<"$trail")"
expect "names a subagent's kind only" Explore "$(jq -r '.calls[5].target' <<<"$trail")"
expect "marks a failed call" "false true" "$(jq -r '[.calls[0].error, .calls[3].error] | map(tostring) | join(" ")' <<<"$trail")"
expect "marks only the refused call denied: succeeded, failed, refused" "false false true" "$(jq -r '[.calls[0].denied, .calls[3].denied, .calls[6].denied] | map(tostring) | join(" ")' <<<"$trail")"
expect "a refused call failed too" true "$(jq -r '.calls[6].error' <<<"$trail")"
expect "every call says whether it was refused" 7 "$(jq '[.calls[] | select(.denied | type == "boolean")] | length' <<<"$trail")"

# A credential that gets through the shaping anyway (here, in a file name) drops the trail.
cat >"$work/claude-execution-output.json" <<'JSON'
[{"type": "assistant", "message": {"content": [
  {"type": "tool_use", "id": "a", "name": "Read", "input": {"file_path": "ghp_abcdefghijklmnopqrstuvwxyz0123456789"}}
]}}]
JSON
run build
expect "a credential-looking trail still exits 0" 0 "$status"
expect "keeps no trail that matches a credential pattern" "" "$trail"
expect_in "says why" "$out" "credential pattern"

echo 'not json' >"$work/claude-execution-output.json"
run build
expect "an unreadable transcript exits 0" 0 "$status"
expect "leaves no trail for an unreadable transcript" "" "$trail"

rm -f "$work/claude-execution-output.json"
run build
expect "no transcript exits 0" 0 "$status"
expect "leaves no trail without a transcript" "" "$trail"

finish "All agent trail checks passed"
