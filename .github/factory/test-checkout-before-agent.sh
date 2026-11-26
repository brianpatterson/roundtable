#!/usr/bin/env bash
# Checks that no job checks out code after its agent step. By then the agent has run code on the
# runner and could have planted a repository at the checkout's path, with git config that runs
# while the step holds the job's tokens; CodeQL flags it too. A step after the agent that needs
# git works in a new `mktemp -d` directory with global git config ignored, as merge-main.sh does
# (ADR-0072). A checkout in a later job is fine: each job gets a fresh runner.
# Run from anywhere: .github/factory/test-checkout-before-agent.sh
# shellcheck source=.github/factory/testlib.sh
. "$(dirname "$0")/testlib.sh"

# Prints `<line>: <job>` for each checkout after an agent step in the same job.
late_checkouts() {
  awk '
    /^  [A-Za-z0-9_-]+:$/ { job = $1; agent = 0 }
    /uses: anthropics\/claude-code-action/ { agent = 1 }
    /uses: actions\/checkout/ && agent { print NR ": " job }
  ' "$1"
}

# The guard itself catches one, and not one in a later job.
cat >"$work/bad.yml" <<'YML'
jobs:
  build:
    steps:
      - uses: actions/checkout@v7
      - uses: anthropics/claude-code-action@abc
      - uses: actions/checkout@v7
  later:
    steps:
      - uses: actions/checkout@v7
YML
expect "a checkout after the agent is caught, one in a later job isn't" "6: build:" "$(late_checkouts "$work/bad.yml")"

agents=0
for file in "$here"/../workflows/*.yml; do
  grep -q 'uses: anthropics/claude-code-action' "$file" && agents=$((agents + 1))
  while read -r found; do
    [ -n "$found" ] && fail "$(basename "$file"):$found checks out code after the agent step: work in a new mktemp -d directory instead (ADR-0072)"
  done <<<"$(late_checkouts "$file")"
done

[ "$agents" -gt 0 ] || fail "found no workflow with an agent step: has the workflows' layout changed?"

finish "No job in the $agents workflows with an agent step checks out code after it"
