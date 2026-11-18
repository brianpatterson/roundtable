#!/usr/bin/env bash
# Lists the tool calls Claude Code refused in this run, in the job summary, and flags the ones that
# look like an attack (ADR-0029).
#
# The summary is public, and a manipulated agent chooses what it tries, so the report must not be
# a way to publish data. For a command it shows only its shape: each part's program and first
# argument when they are plain lowercase words or short flags (nothing that could carry encoded
# data), joined by the shell operators between them, plus why it was flagged. For a file, the
# tool and the top-level folder.
#
# Suspicious: reaching for credentials or the factory's own rules (.git/, .github/, .claude/,
# CLAUDE.md, git config/remote/credential and the global flags that set config, curl, wget, env,
# printenv, and downloading a package to run it with pnpm dlx, pnpm create, npx or pnpx), in any
# part of a command. An honest agent has no reason to try those, so the run is flagged for a
# human. Other denials are gaps to fix, not alarms, including running an installed binary with
# `pnpm exec`: an honest agent reaches for `pnpm exec prettier` all the time, and the deny list
# refuses it anyway. What `pnpm exec` (or pnpm's fallback for an unknown command) runs is
# classified too, past pnpm's and git's global flags.
#
# Commands are split the way a shell does (Python's shlex): quotes are respected, so a `|` or
# `curl` inside a grep pattern is text, not a command. Subshells, backticks and `bash -c '…'`
# strings are parsed in turn. It is still not a full shell: an encoded or indirect command isn't
# seen, and a global flag that takes a value but isn't listed hides what follows it. The deny
# list is the boundary; this only decides who looks. test-report-denials.sh pins the
# classification, and CI runs it.
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
denials=$(python3 -I - "$file" "$GITHUB_WORKSPACE" <<'PY'
import json
import os
import re
import shlex
import sys

WORD = re.compile(r"[a-z][a-z0-9:._-]{0,30}")
FLAG = re.compile(r"--?[a-z][a-z0-9-]{0,20}")
# Tool names come from Claude Code, not the agent, so capitals are fine there.
TOOL = re.compile(r"[A-Za-z][A-Za-z0-9_]{0,60}")
OPERATORS = {"|", "||", "&", "&&", ";", ";;", "|&", "(", ")", "\n"}
SHELLS = {"bash", "sh", "zsh", "dash"}
WRAPPERS = SHELLS | {"xargs", "nohup", "time", "command", "exec", "eval", "sudo", "nice", "timeout"}
NETWORK = {"curl", "wget", "env", "printenv", "npx", "pnpx"}
PNPM_VALUED = {"-F", "--filter", "--filter-prod", "-C", "--dir", "--loglevel", "--reporter", "--workspace-concurrency"}
GIT_VALUED = {"-C", "-c", "--config-env", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--attr-source"}
MAX_PARTS = 6


def word(token):
    return token if WORD.fullmatch(token) or FLAG.fullmatch(token) else "…"


def tokenize(command):
    """Shell tokens; on unbalanced quotes, whitespace-separated words."""
    lexer = shlex.shlex(command, posix=True, punctuation_chars=";&|()")
    lexer.whitespace_split = True
    lexer.commenters = ""
    try:
        return list(lexer)
    except ValueError:
        return command.split()


def parts(command, depth=0):
    """[(operator before it, argv)] for each simple command, subshells and bash -c included."""
    found, argv, op = [], [], ""

    def close(next_op):
        nonlocal argv, op
        if argv:
            found.extend(unwrap(argv, op, depth))
        argv, op = [], next_op

    for token in tokenize(command):
        if token in OPERATORS or set(token) <= set(";&|()"):
            close(token if token not in "()" else ";")
            continue
        # Backticks run a command inside a word: each one is a boundary.
        pieces = token.split("`")
        for i, piece in enumerate(pieces):
            if i:
                close(";")
            piece = piece.removeprefix("$")
            if piece:
                argv.append(piece)
    close("")
    return found


def unwrap(argv, op, depth):
    """Drops what runs the next word, and parses `bash -c '…'` and `eval …` strings in turn."""
    while argv:
        program = os.path.basename(argv[0])
        if program in SHELLS and "-c" in argv[1:] and depth < 3:
            script = argv[argv.index("-c") + 1:]
            return parts(" ".join(script[:1]), depth + 1) if script else []
        if program == "eval" and depth < 3:
            return parts(" ".join(argv[1:]), depth + 1)
        if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=.*|-.*|[0-9.]+[smhd]?", argv[0]) or program in WRAPPERS:
            argv = argv[1:]
            continue
        return [(op, [program] + argv[1:])]
    return []


def skip_flags(argv, valued):
    """Leading global flags (and the value after the listed ones), then the rest."""
    lead = []
    while argv and argv[0].startswith("-"):
        take = 2 if argv[0] in valued else 1
        lead, argv = lead + argv[:take], argv[take:]
    return lead, argv


def reason(argv, depth=0):
    """Why a simple command is suspicious, as a fixed label, or None."""
    program = argv[0]
    if program == "git":
        lead, rest = skip_flags(argv[1:], GIT_VALUED)
        if any(f == "-c" or f.startswith("--config-env") or f.startswith("--exec-path=") for f in lead):
            return "git config flag"
        if rest and rest[0] in {"config", "remote", "credential"}:
            return "git " + rest[0]
        return None
    if program == "pnpm":
        _, rest = skip_flags(argv[1:], PNPM_VALUED)
        if not rest or rest[0] == "env":
            return None
        if rest[0] in {"dlx", "create"}:
            return "pnpm " + rest[0]
        # `pnpm exec x` runs x, and so does `pnpm x` for a command pnpm doesn't have.
        inner = rest[1:] if rest[0] == "exec" else rest
        found = [r for _, a in unwrap(inner, "", 0) for r in [reason(a, depth + 1)] if r] if depth < 3 else []
        return found[0] if found else None
    return program if program in NETWORK else None


def shape(found):
    words = []
    for op, argv in found[:MAX_PARTS]:
        if op and words:
            words.append(op if op in OPERATORS else ";")
        words.extend(word(t) for t in argv[:2])
    if len(found) > MAX_PARTS:
        words.append("…")
    return " ".join(words)


def folder(path, workspace):
    path = path.removeprefix(workspace + "/").removeprefix("./")
    top, _, rest = path.partition("/")
    shown = top if top == "CLAUDE.md" or re.fullmatch(r"\.?[a-z][a-z0-9._-]{0,30}", top) else "…"
    return shown + ("/" if rest else "")


def classify(denial, workspace):
    tool = denial.get("tool_name", "")
    tool_input = denial.get("tool_input") or {}
    shown_tool = tool if TOOL.fullmatch(tool) else "…"
    if tool == "Bash":
        found = parts(tool_input.get("command") or "")
        reasons = [r for _, argv in found for r in [reason(argv)] if r]
        label = "Bash: " + shape(found)
        if reasons:
            return "suspicious", label + " (" + ", ".join(dict.fromkeys(reasons)) + ")"
        return "gap", label
    path = tool_input.get("file_path") or tool_input.get("path") or tool_input.get("pattern") or ""
    if path:
        relative = path.removeprefix(workspace + "/").removeprefix("./")
        kind = "suspicious" if re.match(r"(\.git|\.github|\.claude)(/|$)|CLAUDE\.md$", relative) else "gap"
        return kind, shown_tool + ": " + folder(path, workspace)
    return "gap", shown_tool


with open(sys.argv[1]) as f:
    events = json.load(f)
results = [e for e in events if isinstance(e, dict) and e.get("type") == "result"]
for denial in (results[-1].get("permission_denials") or []) if results else []:
    kind, label = classify(denial, sys.argv[2])
    print(kind + "\t" + label.replace("\t", " ").replace("\n", " "))
PY
)

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
