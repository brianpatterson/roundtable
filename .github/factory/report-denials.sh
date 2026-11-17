#!/usr/bin/env bash
# Lists the tool calls Claude Code refused in this run, in the job summary, and flags the ones that
# look like an attack (ADR-0029).
#
# The summary is public, and a manipulated agent chooses what it tries, so the report must not be
# a way to publish data: it shows only the tool, a command's program and subcommand when they look
# like one (lowercase words, nothing that could carry encoded data), and a file's top-level folder.
#
# Suspicious: reaching for credentials or the factory's own rules (.git/, .github/, .claude/,
# CLAUDE.md, git config/remote/credential/-c, curl/wget/env/printenv). An honest agent has no
# reason to try those, so the run is flagged for a human. Other denials are gaps to fix, not
# alarms, including running a package's binary (pnpm exec/dlx, npx, pnpx): an honest agent
# reaches for `pnpm exec prettier` all the time, and the deny list refuses it anyway.
#
# Writes `suspicious=true|false` to $GITHUB_OUTPUT.
set -euo pipefail

file="$RUNNER_TEMP/claude-execution-output.json"
suspicious=false

report() {
  echo "suspicious=$suspicious" >> "${GITHUB_OUTPUT:-/dev/null}"
}
trap report EXIT

[ -f "$file" ] || { echo "No execution output; nothing to report."; exit 0; }

# One line per denial: "<kind>\t<label>", where kind is "suspicious" or "gap".
denials=$(jq -r --arg workspace "$GITHUB_WORKSPACE/" '
  def word: if test("^[a-z][a-z0-9:._-]{0,30}$") then . else "…" end;
  # Tool names come from Claude Code, not the agent, so capitals are fine there.
  def tool: if test("^[A-Za-z][A-Za-z0-9_]{0,60}$") then . else "…" end;
  def folder:
    ltrimstr($workspace) | ltrimstr("./") | split("/")
    | (.[0] | if . == "CLAUDE.md" or test("^\\.?[a-z][a-z0-9._-]{0,30}$") then . else "…" end) + (if length > 1 then "/" else "" end);

  [.[] | select(.type == "result")] | last | (.permission_denials // [])[]
  | .tool_name as $tool
  | (.tool_input.command // "" | split(" ") | map(select(. != ""))) as $argv
  | (.tool_input.file_path // .tool_input.path // .tool_input.pattern // "") as $path
  | (if $tool == "Bash" then
       ($argv[0:2] | map(word) | join(" ")) as $cmd
       | [(if ($argv[0] == "git" and (($argv[1] // "") | test("^(config|remote|credential|-c)$")))
             or ($argv[0] | test("^(curl|wget|env|printenv)$"))
           then "suspicious" else "gap" end), "Bash: " + $cmd]
     elif $path != "" then
       [(if ($path | ltrimstr($workspace) | ltrimstr("./") | test("^(\\.git|\\.github|\\.claude)(/|$)|^CLAUDE\\.md$"))
         then "suspicious" else "gap" end), ($tool | tool) + ": " + ($path | folder)]
     else ["gap", ($tool | tool)] end)
  | join("\t")' "$file")

[ -n "$denials" ] || { echo "No tool calls were denied."; exit 0; }

summarize() { grep "^$1"$'\t' <<<"$denials" | cut -f2 | sort | uniq -c | sort -rn || true; }
flagged=$(summarize suspicious)
gaps=$(summarize gap)

# The same guard as everything else the factory publishes.
"$RUNNER_TEMP/guard-secrets.sh" <<<"$flagged$gaps" || exit 0

{
  echo '### Denied tool calls'
  echo
  if [ -n "$flagged" ]; then
    echo '**Suspicious:** reaching for credentials or the factory'"'"'s own rules. A human should read this run.'
    echo
    echo '~~~'
    echo "$flagged"
    echo '~~~'
    echo
  fi
  if [ -n "$gaps" ]; then
    echo 'Not on the allowlist (a gap to fix, or a command it doesn'"'"'t need):'
    echo
    echo '~~~'
    echo "$gaps"
    echo '~~~'
  fi
} >> "$GITHUB_STEP_SUMMARY"

# The same labels as log notices: run summaries can't be read through the API or signed out, but
# annotations can, so whoever checks the run sees which calls were refused.
while read -r count label; do
  [ -n "$label" ] && echo "::notice::Denied ${count}x: $label"
done <<<"$flagged
$gaps"

if [ -n "$flagged" ]; then
  suspicious=true
  echo "::warning::The agent tried tool calls that reach for credentials or the factory's rules; the run summary lists them."
else
  echo "::notice::Some tool calls were denied; the run summary lists them."
fi
