#!/usr/bin/env bash
# Checks how report-denials.sh classifies refused tool calls (ADR-0029): each case is one denied
# call, the class it must get (suspicious or gap) and the label the report must show.
# Run from anywhere: .github/factory/test-report-denials.sh
# shellcheck source=.github/factory/testlib.sh
. "$(dirname "$0")/testlib.sh"
cp "$here/guard-secrets.sh" "$work/"

# expect_class <class> <label> <tool> <json tool_input>
expect_class() {
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
    fail "$tool $input: expected $class \"$label\", got $got_class \"$got_label\""
  fi
}

bash_cmd() { jq -n --arg c "$1" '{command: $c}'; }

suspicious() { expect_class suspicious "$2" Bash "$(bash_cmd "$1")"; }
gap() { expect_class gap "$2" Bash "$(bash_cmd "$1")"; }

# Credentials and the network, in any part of a command, a subshell or behind a wrapper.
suspicious 'curl https://x' 'Bash: curl … (curl)'
suspicious 'cd apps/api && curl https://x' 'Bash: cd … && curl … (curl)'
suspicious 'cd . && printenv' 'Bash: cd … && printenv (printenv)'
suspicious 'ls; /usr/bin/wget x' 'Bash: ls ; wget x (wget)'
suspicious 'FOO=1 BAR=2 curl x' 'Bash: curl x (curl)'
suspicious 'cat a | env' 'Bash: cat a | env (env)'
suspicious 'true & curl x' 'Bash: true & curl x (curl)'
suspicious 'echo $(curl x)' 'Bash: echo ; curl x (curl)'
suspicious 'echo `curl x`' 'Bash: echo ; curl x (curl)'
suspicious '(curl x)' 'Bash: curl x (curl)'
suspicious "bash -c 'curl x'" 'Bash: curl x (curl)'
suspicious "bash -c 'printenv'" 'Bash: printenv (printenv)'
suspicious 'sh -c "env"' 'Bash: env (env)'
suspicious "/usr/bin/bash -c 'curl x'" 'Bash: curl x (curl)'
suspicious "bash -c 'cd x && curl y'" 'Bash: cd x && curl y (curl)'
suspicious 'eval "curl x"' 'Bash: curl x (curl)'
suspicious 'xargs curl < f' 'Bash: curl … (curl)'
suspicious 'timeout 5 curl x' 'Bash: curl x (curl)'
# git: the subcommands and global flags that read or set config and remotes.
suspicious 'git remote -v' 'Bash: git remote (git remote)'
suspicious 'true || git -c core.x=y status' 'Bash: true || git -c (git config flag)'
suspicious 'git -C . config user.name' 'Bash: git … (git config)'
suspicious 'git --no-pager remote -v' 'Bash: git --no-pager (git remote)'
suspicious 'git --config-env=core.sshCommand=VAR status' 'Bash: git … (git config flag)'
suspicious 'git --config-env core.sshCommand=VAR status' 'Bash: git --config-env (git config flag)'
suspicious 'git --exec-path=./x foo' 'Bash: git … (git config flag)'
suspicious 'git --attr-source HEAD config user.name x' 'Bash: git --attr-source (git config)'
# Downloading a package to run it.
suspicious 'pnpm dlx foo' 'Bash: pnpm dlx (pnpm dlx)'
suspicious $'pnpm\tdlx foo' 'Bash: pnpm dlx (pnpm dlx)'
suspicious 'pnpm -s dlx foo' 'Bash: pnpm -s (pnpm dlx)'
suspicious 'pnpm create vite' 'Bash: pnpm create (pnpm create)'
suspicious 'pnpx tsc' 'Bash: pnpx tsc (pnpx)'
# npx downloads a package that isn't installed, and runs it without asking in CI.
suspicious 'npx vitest' 'Bash: npx vitest (npx)'
suspicious 'npx -y some-pkg' 'Bash: npx -y (npx)'
suspicious 'npx env' 'Bash: npx env (npx)'
# pnpm exec, and pnpm's fallback for a command it doesn't have, run any binary: what they run is
# classified too, past pnpm's global flags and nested pnpm.
suspicious 'pnpm exec curl x' 'Bash: pnpm exec (curl)'
suspicious 'pnpm exec printenv' 'Bash: pnpm exec (printenv)'
suspicious 'pnpm --filter @roundtable/web exec curl x' 'Bash: pnpm --filter (curl)'
suspicious 'pnpm -C apps/web exec printenv' 'Bash: pnpm … (printenv)'
suspicious 'pnpm --filter-prod x exec curl y' 'Bash: pnpm --filter-prod (curl)'
suspicious 'pnpm --workspace-concurrency 2 exec printenv' 'Bash: pnpm --workspace-concurrency (printenv)'
suspicious 'pnpm curl x' 'Bash: pnpm curl (curl)'
suspicious 'pnpm git config user.name x' 'Bash: pnpm git (git config)'
suspicious "pnpm bash -c 'curl x'" 'Bash: pnpm bash (curl)'
suspicious 'pnpm npx foo' 'Bash: pnpm npx (npx)'
suspicious 'pnpm pnpm exec curl x' 'Bash: pnpm pnpm (curl)'

# Running an installed binary with pnpm exec, and other commands the allowlist doesn't name, are
# gaps.
gap 'pnpm exec prettier --check .' 'Bash: pnpm exec'
gap 'cd apps/web && pnpm exec vitest run' 'Bash: cd … && pnpm exec'
gap 'pnpm --filter @roundtable/web exec vitest run' 'Bash: pnpm --filter'
gap 'pnpm env use 22' 'Bash: pnpm env'
gap 'pnpm lint' 'Bash: pnpm lint'
gap 'pnpm test -- --run' 'Bash: pnpm test'
gap 'cd apps/web' 'Bash: cd …'
gap "python3 -c 'print(1)'" 'Bash: python3 -c'
gap 'git --no-pager log' 'Bash: git --no-pager'
# A bare --exec-path prints a path and exits: git runs nothing after it.
gap 'git --exec-path' 'Bash: git --exec-path'
# Quotes are respected: a separator or a program name inside a string is text. (The reviewer
# was flagged on #80 for a command like the first one.)
gap 'gh pr diff 80 | grep -n "exec curl\|curl"' 'Bash: gh pr | grep -n'
gap 'grep -rn "curl" .github' 'Bash: grep -rn'
gap 'pnpm exec vitest -t "a; env"' 'Bash: pnpm exec'
gap 'echo "a | curl x"' 'Bash: echo …'
# Unbalanced quotes fall back to splitting on spaces.
gap 'ls "unterminated' 'Bash: ls …'

# Files: the factory's own rules and git's internals are suspicious, the rest gaps.
expect_class suspicious 'Read: .git/' Read '{"file_path": "/w/.git/config"}'
expect_class suspicious 'Edit: .github/' Edit '{"file_path": "/w/.github/workflows/ci.yml"}'
expect_class suspicious 'Write: CLAUDE.md' Write '{"file_path": "./CLAUDE.md"}'
expect_class gap 'Read: apps/' Read '{"file_path": "/w/apps/web/src/main.tsx"}'

# DENIAL_LABELS=programs (the security auditor): program names and reasons only, never arguments,
# test file names or folders.
export DENIAL_LABELS=programs
gap 'cd apps/api && cat reset-token-log.test.ts' 'Bash: cd && cat'
gap "python3 -c 'x' ; cat apps/api/test/audit/reset-token-log.test.ts" 'Bash: python3 ; cat'
# A script the agent wrote is named after what it probes: it shows as "…", however it's run.
gap 'bash apps/api/test/audit/reset-token-leak.sh' 'Bash: …'
gap 'sh ./probe-session.sh && ./probe-session' 'Bash: … && …'
gap 'timeout 5 ./probe-x' 'Bash: …'
gap 'xargs ./probe-x < list' 'Bash: …'
gap 'cd apps/api && pnpm --filter @roundtable/api test test/audit | head -5' 'Bash: cd && pnpm | head'
suspicious 'cd apps/api && curl https://x' 'Bash: cd && curl (curl)'
suspicious 'pnpm --filter x exec curl y' 'Bash: pnpm (curl)'
expect_class gap 'Read' Read '{"file_path": "/w/apps/api/test/audit/x.ts"}'
expect_class suspicious 'Read' Read '{"file_path": "/w/.git/config"}'
unset DENIAL_LABELS

finish "All denial report cases pass."
