#!/usr/bin/env bash
# Lists the tool calls Claude Code refused in this run, in the job summary, and flags the ones that
# look like an attack (ADR-0029).
#
# The summary is public, and a manipulated agent chooses what it tries, so the report must not be
# a way to publish data: it shows only the tool, a command's program and subcommand when they look
# like one (lowercase words, nothing that could carry encoded data), and a file's top-level folder.
#
# Suspicious: reaching for credentials or the factory's own rules (.git/, .github/, .claude/,
# CLAUDE.md, git config/remote/credential/-c, curl/wget/env/printenv, and downloading a package
# to run it with pnpm dlx, npx or pnpx), in any part of a chain. An honest agent has no reason to try
# those, so the run is flagged for a human. Other denials are gaps to fix, not alarms, including
# running an installed binary (pnpm exec, which never downloads): an honest agent reaches for
# `pnpm exec prettier` all the time, and the deny list refuses it anyway. What it runs is
# classified too, so `pnpm exec curl` is suspicious, and pnpm's and git's global flags are skipped
# (`pnpm --filter x exec curl`, `git -C . config`). A global flag that takes a value but isn't
# listed hides what follows it. test-report-denials.sh pins all of this; CI runs it.
#
# Splitting a command is best effort: it isn't a shell parser. It splits on separators and
# subshells and skips wrappers (`bash -c`, `xargs`), but a separator inside quotes also splits
# (a false alarm), and an encoded or indirect command isn't seen. The deny list is the boundary;
# this only decides who looks.
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

  # Drops what runs the next word: `VAR=…` assignments, flags, durations and wrappers
  # (`bash -c`, `xargs`, `timeout 5`, also given with a path), then the program directory, so
  # `/usr/bin/curl` is `curl`.
  def unwrap:
    until(length == 0
      or (.[0] | split("/") | last
          | test("^([A-Za-z_][A-Za-z0-9_]*=.*|-.*|[0-9.]+[smhd]?|bash|sh|zsh|dash|xargs|nohup|time|command|exec|eval|sudo|nice|timeout)$") | not);
      .[1:])
    | if length > 0 then .[0] |= (split("/") | last) else . end;
  # Skips leading flags, and the value after the ones in $valued (`--filter x`, `-C dir`).
  def skipflags($valued):
    until(length == 0 or (.[0] | startswith("-") | not);
      if (.[0] as $f | $valued | index($f)) != null then .[2:] else .[1:] end);
  def pnpm_valued:
    ["-F", "--filter", "--filter-prod", "-C", "--dir", "--loglevel", "--reporter", "--workspace-concurrency"];
  def suspicious_argv:
    if .[0] == "git" then
      # `-c` and `--config-env` set config for one command, like `git config` does.
      .[1:] as $r
      | ($r | skipflags(["-C", "-c", "--config-env", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--attr-source"])) as $sub
      | ($r[0:(($r | length) - ($sub | length))] | any(. == "-c" or startswith("--config-env")))
        or (($sub[0] // "") | test("^(config|remote|credential)$"))
    elif .[0] == "pnpm" then
      # pnpm dlx and pnpm create download a package to run it. (An unknown pnpm command runs like
      # exec: see target.)
      (.[1:] | skipflags(pnpm_valued)) as $sub | ($sub[0] // "") | test("^(dlx|create)$")
    else
      # npx and pnpx download a package that is not installed, and run it.
      (.[0] // "") | test("^(curl|wget|env|printenv|npx|pnpx)$")
    end;
  # What a part runs: for `pnpm [flags] exec …`, the command after exec. pnpm runs an unknown
  # command the same way (`pnpm git config …`), so that is classified too, except `env`, `dlx`
  # and `create`, which are pnpm commands of its own.
  def target:
    if .[0] == "pnpm" then
      (.[1:] | skipflags(pnpm_valued)) as $sub
      | if ($sub[0] // "") == "exec" then $sub[1:] | unwrap
        elif ($sub[0] // "") | test("^(env|dlx|create)?$") then .
        else $sub | unwrap end
    else . end;

  [.[] | select(.type == "result")] | last | (.permission_denials // [])[]
  | .tool_name as $tool
  # A command is a chain (`cd dir && pnpm …`): classify every part, so a refused
  # `cd x && curl …` is flagged like `curl …`. Parts are split at ; | & newlines, backticks and
  # parentheses (subshells), and quotes around each word are dropped. Best effort: see the top
  # of this file.
  | [(.tool_input.command // "") | splits("[;|&\n`()]")
      | [splits("[ \t]+")] | map(gsub("^[\"\u0027]+|[\"\u0027]+$"; "") | select(. != ""))
      | unwrap | select(length > 0)] as $parts
  | (.tool_input.file_path // .tool_input.path // .tool_input.pattern // "") as $path
  | (if $tool == "Bash" then
       # `pnpm exec` runs any binary: classify the one it runs too, so `pnpm exec curl …` is
       # flagged like `curl …`.
       ($parts | map(
         target as $inner
         | if ($inner | length) > 0 and ($inner | suspicious_argv) then {argv: $inner, suspicious: true}
           else {argv: ., suspicious: suspicious_argv} end)) as $classified
       # Label the part that matters: the first suspicious one, else the first that is not a `cd`.
       | (($classified | map(select(.suspicious)) | first)
          // ($classified | map(select(.argv[0] != "cd")) | first)
          // $classified[0]
          // {argv: [], suspicious: false}) as $shown
       | [(if $shown.suspicious then "suspicious" else "gap" end),
          "Bash: " + ($shown.argv[0:2] | map(word) | join(" "))]
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
