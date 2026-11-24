#!/usr/bin/env bash
# Writes the trail of this run's agent for the batch retrospective (ADR-0064): what it did, never
# what it read or said. Run after the agent, with the job's name:
#
#   agent-trail.sh <job>
#
# Reads $RUNNER_TEMP/claude-execution-output.json and writes $RUNNER_TEMP/agent-trail/trail.json:
#
#   {job, outcome, turns, duration_ms, cost_usd, denied,
#    calls: [{tool, target, error}]}
#
# The trail is uploaded as an artifact, and artifacts of a public repository are public, so a
# manipulated agent must not be able to publish data through it (ADR-0029). It keeps only shapes,
# the way report-denials.sh does: a file inside the repository, when every part of its path is
# plain; a command as each part's program and up to three plain words or short flags, joined by
# the shell operators between them. Search patterns, edits, tool output and the agent's own text
# are left out. A trail that still matches a credential pattern isn't kept.
#
# Never fails the job: a missing or unreadable transcript just leaves no trail. The workflow skips
# this on a run that fetched a user's report (ADR-0041).
set -uo pipefail

job=${1:?usage: agent-trail.sh <job>}
file="$RUNNER_TEMP/claude-execution-output.json"
out="$RUNNER_TEMP/agent-trail"
here=$(cd "$(dirname "$0")" && pwd)
guard=${GUARD_SECRETS:-$here/guard-secrets.sh}

rm -rf "$out"
[ -f "$file" ] || { echo "No execution output; no trail."; exit 0; }
mkdir -p "$out"

if ! python3 -I - "$file" "${GITHUB_WORKSPACE:-$PWD}" "$job" >"$out/trail.json" <<'PY'; then
import json
import os
import re
import shlex
import sys

path, workspace, job = sys.argv[1], os.path.realpath(sys.argv[2]), sys.argv[3]

WORD = re.compile(r"[a-z@][a-z0-9:._/@=-]{0,40}")
FLAG = re.compile(r"--?[a-z][a-z0-9-]{0,20}")
TOOL = re.compile(r"[A-Za-z][A-Za-z0-9_]{0,60}")
KIND = re.compile(r"[A-Za-z][A-Za-z0-9_-]{0,40}")
SEGMENT = re.compile(r"[A-Za-z0-9._@+-]{1,80}")
OPERATORS = {"|", "||", "&", "&&", ";", ";;", "|&", "(", ")", "\n"}
MAX_PARTS = 6
MAX_WORDS = 3
FILE_TOOLS = {"Read", "Edit", "Write", "MultiEdit", "NotebookEdit"}
SEARCH_TOOLS = {"Glob", "Grep"}
AGENT_TOOLS = {"Task", "Agent"}


def word(token):
    return token if WORD.fullmatch(token) or FLAG.fullmatch(token) else "…"


def shape_path(value):
    if not isinstance(value, str) or not value:
        return ""
    full = os.path.realpath(os.path.join(workspace, value))
    if full != workspace and not full.startswith(workspace + os.sep):
        return "(outside the repository)"
    relative = os.path.relpath(full, workspace)
    if relative == ".":
        return "."
    parts = relative.split(os.sep)
    if len(parts) > 12 or not all(SEGMENT.fullmatch(p) and p != ".." for p in parts):
        return "…"
    return relative


def tokenize(command):
    lexer = shlex.shlex(command, posix=True, punctuation_chars=";&|()")
    lexer.whitespace_split = True
    try:
        return list(lexer)
    except ValueError:
        return command.split()


def shape_command(command):
    if not isinstance(command, str):
        return ""
    pieces, current, ops = [], [], []
    for token in tokenize(command):
        if token in OPERATORS:
            pieces.append(current)
            ops.append(token)
            current = []
        else:
            current.append(token)
    pieces.append(current)
    shown = []
    for i, argv in enumerate(pieces[:MAX_PARTS]):
        if i > 0:
            shown.append(ops[i - 1])
        if argv:
            shown.append(" ".join(word(t) for t in argv[: 1 + MAX_WORDS]))
            if len(argv) > 1 + MAX_WORDS:
                shown.append("…")
    if len(pieces) > MAX_PARTS:
        shown.append("…")
    return " ".join(shown)


def target(name, data):
    if not isinstance(data, dict):
        return ""
    if name in FILE_TOOLS:
        return shape_path(data.get("file_path") or data.get("notebook_path"))
    if name in SEARCH_TOOLS:
        return shape_path(data.get("path")) or "."
    if name == "Bash":
        return shape_command(data.get("command"))
    if name in AGENT_TOOLS:
        kind = data.get("subagent_type")
        return kind if isinstance(kind, str) and KIND.fullmatch(kind) else ""
    return ""


with open(path) as f:
    events = json.load(f)
events = [e for e in events if isinstance(e, dict)] if isinstance(events, list) else []

calls, by_id = [], {}
for event in events:
    message = event.get("message")
    content = message.get("content") if isinstance(message, dict) else None
    if not isinstance(content, list):
        continue
    for block in content:
        if not isinstance(block, dict):
            continue
        if event.get("type") == "assistant" and block.get("type") == "tool_use":
            raw = block.get("name")
            name = raw if isinstance(raw, str) and TOOL.fullmatch(raw) else "…"
            call = {"tool": name, "target": target(name, block.get("input")), "error": False}
            calls.append(call)
            by_id[block.get("id")] = call
        elif event.get("type") == "user" and block.get("type") == "tool_result":
            call = by_id.get(block.get("tool_use_id"))
            if call is not None:
                call["error"] = block.get("is_error") is True

results = [e for e in events if e.get("type") == "result"]
result = results[-1] if results else {}


def number(key):
    value = result.get(key)
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


subtype = result.get("subtype")
json.dump(
    {
        "job": job,
        "outcome": subtype if isinstance(subtype, str) and WORD.fullmatch(subtype) else "no result",
        "turns": number("num_turns"),
        "duration_ms": number("duration_ms"),
        "cost_usd": number("total_cost_usd"),
        "denied": len(result.get("permission_denials") or []),
        "calls": calls,
    },
    sys.stdout,
    ensure_ascii=False,
    indent=1,
)
PY
  echo "::warning::Couldn't read the execution output; no trail."
  rm -rf "$out"
  exit 0
fi

if ! "$guard" <"$out/trail.json" >/dev/null; then
  echo "::warning::The trail matched a credential pattern; it isn't kept."
  rm -rf "$out"
  exit 0
fi

echo "Trail: $(jq '.calls | length' "$out/trail.json") tool calls in $(jq -r '.turns // "?"' "$out/trail.json") turns."
