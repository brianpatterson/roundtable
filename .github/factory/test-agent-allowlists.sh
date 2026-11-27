#!/usr/bin/env bash
# Checks that every agent allowed to run the repository's checks one by one can run all of them:
# an agent that couldn't run `pnpm check:adrs` took an ADR number main already had (retro #180).
# Run from anywhere: .github/factory/test-agent-allowlists.sh
# shellcheck source=.github/factory/testlib.sh
. "$(dirname "$0")/testlib.sh"

workflows="$here/../workflows"
seen=0

# The checks `pnpm check` chains, read from the root package.json (or the one given), so a new one
# fails this test until the agents can run it: `pnpm check:migrations` joined `pnpm check` but not
# the allowlists, and was refused twice (retro #281). `pnpm test` is covered by `pnpm test:*`.
checks_of() { jq -r '.scripts.check' "$1" | grep -oE 'pnpm [a-z][a-z:-]*' | awk '$2 != "test" { print $2 }'; }

# Prints one line per check in package.json $1 that the allowlist $2 doesn't let the agent run.
missing_checks() {
  local check
  while read -r check; do
    [[ "$2" == *"Bash(pnpm $check)"* ]] || echo "$check"
  done < <(checks_of "$1")
}

count=$(checks_of "$here/../../package.json" | wc -l | tr -d ' ')
[ "$count" -ge 5 ] || fail "read $count checks from package.json's \`check\` script: has its shape changed?"

# Shell scripts: the agent writes them under scripts/ and deploy/, and must be able to make them
# executable, ShellCheck them and run their tests, all refused 8 times in one batch (retro #281).
scripts=('Bash(shellcheck:*)' 'Bash(scripts/test-*.sh)' 'Bash(deploy/test-*.sh)' 'Bash(chmod +x scripts/*)' 'Bash(chmod +x deploy/*)' 'Bash(git update-index --chmod=+x:*)')

for file in "$workflows"/*.yml; do
  while IFS=: read -r line text; do
    seen=$((seen + 1))
    while read -r check; do
      [ -z "$check" ] || fail "$(basename "$file"):$line lets the agent run \`pnpm check\` piecemeal but not \`pnpm $check\`"
    done < <(missing_checks "$here/../../package.json" "$text")
    for entry in "${scripts[@]}"; do
      [[ "$text" == *"$entry"* ]] || fail "$(basename "$file"):$line lets the agent write shell scripts but not \`$entry\`"
    done
    # The cheapest way to search tracked files, and read-only: refused 7 times in one batch (retro #241).
    [[ "$text" == *"Bash(git grep:*)"* ]] || fail "$(basename "$file"):$line lets the agent change code but not search it with \`git grep\`"
    # Typechecking one package is the same read-only check as `pnpm typecheck`, and listing tracked
    # files is as harmless as `git grep`: both were refused in the Personas batch (retro #265).
    for package in api web contract; do
      [[ "$text" == *"Bash(pnpm --filter @roundtable/$package typecheck)"* ]] || fail "$(basename "$file"):$line lets the agent run \`pnpm typecheck\` but not \`pnpm --filter @roundtable/$package typecheck\`"
    done
    [[ "$text" == *"Bash(git ls-files:*)"* ]] || fail "$(basename "$file"):$line lets the agent search code with \`git grep\` but not list it with \`git ls-files\`"
  done < <(grep -n -- '--allowedTools .*Bash(pnpm check:boundaries)' "$file" || true)
done

# The build, follow-up, CI fixer, rework and conflict resolver.
[ "$seen" -ge 5 ] || fail "found $seen of the 5 implementer allowlists: has the workflows' layout changed?"

# A check added to `pnpm check` is required of every allowlist without editing this test.
jq '.scripts.check += " && pnpm check:foo"' "$here/../../package.json" >"$work/package.json"
expect "a new check in package.json is required of the allowlists" check:foo \
  "$(missing_checks "$work/package.json" "$(grep -h -- '--allowedTools .*Bash(pnpm check:boundaries)' "$workflows/rework.yml")")"

# An agent allowed Stryker must be able to run it on one file (`test:mutation --mutate <file>`,
# as implementer.md says). An entry without `:*` matches only the bare command, and `test:*`
# doesn't match `test:mutation`, so the implementer's check was refused (PR 194).
mutation=0

for file in "$workflows"/*.yml; do
  while IFS=: read -r line text; do
    mutation=$((mutation + 1))
    for package in web api; do
      [[ "$text" == *"Bash(pnpm --filter @roundtable/$package test:mutation:*)"* ]] || fail "$(basename "$file"):$line lets the agent run Stryker but not \`pnpm --filter @roundtable/$package test:mutation --mutate <file>\`"
    done
  done < <(grep -n -- '--allowedTools .*test:mutation' "$file" || true)
done

[ "$mutation" -gt 0 ] || fail "found no agent allowlist that runs Stryker: has the workflows' layout changed?"

# A job that installs Chromium for its agent (ADR-0066) must let it run the browser tests, on one
# spec file too. `test:*` doesn't match `test:browser`, so the implementer couldn't run the spec
# it wrote on #208 (retro #212).
browser=0

for file in "$workflows"/*.yml; do
  grep -q 'install-browsers.sh' "$file" || continue
  while IFS=: read -r line text; do
    browser=$((browser + 1))
    [[ "$text" == *"Bash(pnpm --filter @roundtable/web test:browser:*)"* ]] || fail "$(basename "$file"):$line installs Chromium but doesn't let the agent run \`pnpm --filter @roundtable/web test:browser [spec]\`"
  done < <(grep -n -- '--allowedTools ' "$file" || true)
done

[ "$browser" -gt 0 ] || fail "found no agent allowlist in a workflow that installs Chromium: has the workflows' layout changed?"

finish "All $seen agent allowlists can run every check, all $mutation that run Stryker can run it on one file, and all $browser that have Chromium can run the browser tests"
