#!/usr/bin/env bash
# Checks that every agent allowed to run the repository's checks one by one can run all of them:
# an agent that couldn't run `pnpm check:adrs` took an ADR number main already had (retro #180).
# Run from anywhere: .github/factory/test-agent-allowlists.sh
# shellcheck source=.github/factory/testlib.sh
. "$(dirname "$0")/testlib.sh"

workflows="$here/../workflows"
checks=(typecheck check:effect check:deps check:adrs check:boundaries)
seen=0

for file in "$workflows"/*.yml; do
  while IFS=: read -r line text; do
    seen=$((seen + 1))
    for check in "${checks[@]}"; do
      [[ "$text" == *"Bash(pnpm $check)"* ]] || fail "$(basename "$file"):$line lets the agent run \`pnpm check\` piecemeal but not \`pnpm $check\`"
    done
  done < <(grep -n -- '--allowedTools .*Bash(pnpm check:boundaries)' "$file" || true)
done

[ "$seen" -gt 0 ] || fail "found no agent allowlist to check: has the workflows' layout changed?"

finish "All $seen agent allowlists can run every check"
