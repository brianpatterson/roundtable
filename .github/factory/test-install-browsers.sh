#!/usr/bin/env bash
# Checks the browser install before agent runs (ADR-0066) against a stand-in npx: it installs
# the official package of the branch's Playwright version and runs nothing from the branch.
# Run from anywhere: .github/factory/test-install-browsers.sh
# shellcheck source=.github/factory/testlib.sh
. "$(dirname "$0")/testlib.sh"

# The stand-in records its arguments and directory, and exits with $NPX_EXIT.
cat >"$work/npx" <<'STUB'
#!/usr/bin/env bash
{ pwd; printf '%s\n' "$@"; } >>"$NPX_LOG"
exit "${NPX_EXIT:-0}"
STUB
chmod +x "$work/npx"

run() { # run <checkout> <npx exit>; sets out, status
  rm -f "$work/log"
  status=0
  out=$(cd "$1" && NPX="$work/npx" NPX_LOG="$work/log" NPX_EXIT=$2 RUNNER_TEMP="$work/temp" RETRY_DELAY=0 \
    "$here/install-browsers.sh" 2>&1) || status=$?
}

checkout() { # checkout <name> <manifest JSON or empty>; prints its path
  local dir="$work/$1"
  mkdir -p "$dir/apps/web/node_modules/@playwright/test"
  if [ -n "$2" ]; then printf '%s' "$2" >"$dir/apps/web/node_modules/@playwright/test/package.json"; fi
  echo "$dir"
}

mkdir -p "$work/temp"

run "$(checkout good '{"name":"@playwright/test","version":"1.65.1"}')" 0
[ "$status" = 0 ] || fail "a good install exits 0 (got $status)"
grep -qxF "playwright@1.65.1" "$work/log" 2>/dev/null || fail "installs the official package of the branch's version"
grep -qxF -- "--with-deps" "$work/log" 2>/dev/null || fail "installs the system libraries"
grep -qxF "chromium" "$work/log" 2>/dev/null || fail "installs only Chromium"
expect "runs outside the checkout" "$work/temp" "$(head -1 "$work/log" 2>/dev/null)"

run "$(checkout old '')" 0
[ "$status" = 0 ] || fail "a branch without Playwright exits 0 (got $status)"
[ ! -e "$work/log" ] || fail "a branch without Playwright installs nothing"
expect_in "says why it skipped" "$out" "::notice::"

run "$(checkout odd '{"version":"1.65.1 && curl evil"}')" 0
[ "$status" = 0 ] || fail "an odd version exits 0 (got $status)"
[ ! -e "$work/log" ] || fail "an odd version installs nothing"
expect_in "warns about an odd version" "$out" "::warning::"

run "$(checkout tag '{"version":"latest"}')" 0
[ ! -e "$work/log" ] || fail "a tag instead of a version installs nothing"

run "$work/good" 1
[ "$status" = 0 ] || fail "a failed download doesn't fail the job (got $status)"
expect "retries three times" 3 "$(grep -cxF chromium "$work/log" 2>/dev/null || echo 0)"
expect_in "warns that the agent can't run them" "$out" "can't run the browser tests"

# Every agent job that may run the web app's tests installs Chromium first, so a new one can't
# forget it: as many installs as such allowlists, in each workflow. Not the security auditor's:
# it writes tests only in apps/api/test/audit/, so it can't write a browser test.
for file in "$here"/../workflows/*.yml; do
  [ "$(basename "$file")" != security-audit.yml ] || continue
  agents=$(grep -cF -- 'Bash(pnpm --filter @roundtable/web test:*)' "$file" || true)
  installs=$(grep -cF -- '"$RUNNER_TEMP/install-browsers.sh"' "$file" || true)
  expect "$(basename "$file"): Chromium installs for its agents that run the web tests" "$agents" "$installs"
done

finish "All browser install checks passed"
