#!/usr/bin/env bash
# Checks scripts/factory-why.sh against a stand-in gh and node: it runs the Conductor's `why <n>`
# for the repository gh names, with gh's token in GH_TOKEN, and refuses anything but one number.
# Run from anywhere.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
root=$(dirname "$here")
failures=0
fail() { echo "FAIL: $1"; failures=$((failures + 1)); }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# The stand-in gh names the repository and the token; the stand-in node prints what it was given.
cat >"$work/gh" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  "repo view --json nameWithOwner --jq .nameWithOwner") echo owner/roundtable ;;
  "auth token") echo gho_stand_in ;;
  *) echo "unexpected gh $*" >&2; exit 1 ;;
esac
EOF
cat >"$work/node" <<'EOF'
#!/usr/bin/env bash
echo "GH_TOKEN=$GH_TOKEN GITHUB_REPOSITORY=$GITHUB_REPOSITORY args=$*"
EOF
chmod +x "$work/gh" "$work/node"

why() { GH="$work/gh" NODE="$work/node" bash "$here/factory-why.sh" "$@"; }

out=$(why 293) || fail "why 293 exited $?"
expected="GH_TOKEN=gho_stand_in GITHUB_REPOSITORY=owner/roundtable args=$root/tools/conductor/main.ts why 293"
[ "$out" = "$expected" ] || fail "why 293 ran: $out"

for args in "" "abc" "0" "12 13" "-1"; do
  status=0
  # shellcheck disable=SC2086 # split on purpose: "" is no argument, "12 13" is two
  why $args >/dev/null 2>&1 || status=$?
  [ "$status" -eq 2 ] || fail "'$args' should be a usage error (2), exited $status"
done

# A gh that can't give a token stops it before node runs.
cat >"$work/gh-signed-out" <<'EOF'
#!/usr/bin/env bash
[ "$1" = auth ] && { echo "not logged in" >&2; exit 1; }
echo owner/roundtable
EOF
chmod +x "$work/gh-signed-out"
status=0
out=$(GH="$work/gh-signed-out" NODE="$work/node" bash "$here/factory-why.sh" 293 2>/dev/null) || status=$?
[ "$status" -ne 0 ] || fail "a signed-out gh should fail"
[ -z "$out" ] || fail "node ran without a token: $out"

if [ "$failures" -gt 0 ]; then
  echo "$failures failure(s)"
  exit 1
fi
echo "factory-why.sh: all checks passed"
