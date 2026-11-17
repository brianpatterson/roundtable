#!/usr/bin/env bash
# Checks how report-denials.sh classifies refused tool calls (ADR-0029): each case is one denied
# call, the class it must get (suspicious or gap) and the label the report must show.
# Run from anywhere: .github/factory/test-report-denials.sh
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cp "$here/guard-secrets.sh" "$work/"

failures=0

# expect <class> <label> <tool> <json tool_input>
expect() {
  local class=$1 label=$2 tool=$3 input=$4
  jq -n --arg tool "$tool" --argjson input "$input" \
    '[{type: "result", permission_denials: [{tool_name: $tool, tool_input: $input}]}]' \
    > "$work/claude-execution-output.json"
  : > "$work/summary"
  : > "$work/out"
  RUNNER_TEMP=$work GITHUB_WORKSPACE=/w GITHUB_STEP_SUMMARY=$work/summary GITHUB_OUTPUT=$work/out \
    bash "$here/report-denials.sh" > /dev/null

  local got_class got_label
  got_class=$(grep -q '^suspicious=true' "$work/out" && echo suspicious || echo gap)
  got_label=$(grep -m1 -E '^ +[0-9]+ ' "$work/summary" | sed -E 's/^ +[0-9]+ //')
  if [ "$got_class" != "$class" ] || [ "$got_label" != "$label" ]; then
    echo "FAIL: $tool $input: expected $class \"$label\", got $got_class \"$got_label\""
    failures=$((failures + 1))
  fi
}

bash_cmd() { jq -n --arg c "$1" '{command: $c}'; }

suspicious() { expect suspicious "$2" Bash "$(bash_cmd "$1")"; }
gap() { expect gap "$2" Bash "$(bash_cmd "$1")"; }

# Credentials and the network, in any part of a chain, a subshell or behind a wrapper.
suspicious 'curl https://x' 'Bash: curl …'
suspicious 'cd apps/api && curl https://x' 'Bash: curl …'
suspicious 'cd . && printenv' 'Bash: printenv'
suspicious 'ls; /usr/bin/wget x' 'Bash: wget x'
suspicious 'FOO=1 BAR=2 curl x' 'Bash: curl x'
suspicious 'cat a | env' 'Bash: env'
suspicious 'true || git -c core.x=y status' 'Bash: git …'
suspicious 'git remote -v' 'Bash: git remote'
suspicious 'echo $(curl x)' 'Bash: curl x'
suspicious 'echo `curl x`' 'Bash: curl x'
suspicious '(curl x)' 'Bash: curl x'
suspicious 'true & curl x' 'Bash: curl x'
suspicious "bash -c 'curl x'" 'Bash: curl x'
suspicious "bash -c 'printenv'" 'Bash: printenv'
suspicious 'sh -c "env"' 'Bash: env'
suspicious "/usr/bin/bash -c 'curl x'" 'Bash: curl x'
suspicious 'xargs curl < f' 'Bash: curl …'
suspicious 'timeout 5 curl x' 'Bash: curl x'
# Downloading a package to run it.
suspicious 'pnpm dlx foo' 'Bash: pnpm dlx'
suspicious $'pnpm\tdlx foo' 'Bash: pnpm dlx'
suspicious 'pnpx tsc' 'Bash: pnpx tsc'
# pnpm exec runs any binary: what it runs is classified too, past pnpm's global flags.
suspicious 'pnpm exec curl x' 'Bash: curl x'
suspicious 'pnpm exec printenv' 'Bash: printenv'
suspicious 'npx env' 'Bash: npx env'
suspicious 'pnpm --filter @roundtable/web exec curl x' 'Bash: curl x'
suspicious 'pnpm -C apps/web exec printenv' 'Bash: printenv'
suspicious 'pnpm -s dlx foo' 'Bash: pnpm …'
suspicious 'pnpm curl x' 'Bash: curl x'
suspicious 'pnpm git config user.name x' 'Bash: git config'
suspicious "pnpm bash -c 'curl x'" 'Bash: curl x'
suspicious 'pnpm npx foo' 'Bash: npx foo'
suspicious 'pnpm --filter-prod x exec curl y' 'Bash: curl y'
suspicious 'pnpm --workspace-concurrency 2 exec printenv' 'Bash: printenv'
suspicious 'git --config-env=core.sshCommand=VAR status' 'Bash: git …'
suspicious 'git --config-env core.sshCommand=VAR status' 'Bash: git …'
suspicious 'git --exec-path /tmp remote -v' 'Bash: git …'
suspicious 'git -C . config user.name' 'Bash: git …'
suspicious 'git --no-pager remote -v' 'Bash: git …'
# npx downloads a package that isn't installed, and runs it without asking in CI.
suspicious 'npx vitest' 'Bash: npx vitest'
suspicious 'npx -y some-pkg' 'Bash: npx …'

# Running an installed binary with pnpm exec, and other commands the allowlist doesn't name, are gaps.
gap 'pnpm exec prettier --check .' 'Bash: pnpm exec'
gap 'cd apps/web && pnpm exec vitest run' 'Bash: pnpm exec'
gap 'pnpm --filter @roundtable/web exec vitest run' 'Bash: pnpm …'
gap 'pnpm env use 22' 'Bash: pnpm env'
gap 'pnpm lint' 'Bash: pnpm lint'
gap 'git --no-pager log' 'Bash: git …'
gap 'cd apps/web' 'Bash: cd …'
gap "python3 -c 'print(1)'" 'Bash: python3 …'
gap 'pnpm test -- --run' 'Bash: pnpm test'

# Files: the factory's own rules and git's internals are suspicious, the rest gaps.
expect suspicious 'Read: .git/' Read '{"file_path": "/w/.git/config"}'
expect suspicious 'Edit: .github/' Edit '{"file_path": "/w/.github/workflows/ci.yml"}'
expect suspicious 'Write: CLAUDE.md' Write '{"file_path": "./CLAUDE.md"}'
expect gap 'Read: apps/' Read '{"file_path": "/w/apps/web/src/main.tsx"}'

if [ "$failures" -gt 0 ]; then
  echo "$failures case(s) failed."
  exit 1
fi
echo "All denial report cases pass."
