#!/usr/bin/env bash
# Checks the sweeps' heartbeat ping (ADR-0060) against a stand-in curl. Run from anywhere:
# .github/factory/test-ping-heartbeat.sh
# shellcheck source=.github/factory/testlib.sh
. "$(dirname "$0")/testlib.sh"

# The stand-in records its arguments and exits with $CURL_EXIT.
cat >"$work/curl" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$@" >"$CURL_LOG"
exit "${CURL_EXIT:-0}"
STUB
chmod +x "$work/curl"

run() { # run <url> <curl exit>; sets out, status
  rm -f "$work/log"
  status=0
  out=$(HEARTBEAT_URL=$1 CURL="$work/curl" CURL_LOG="$work/log" CURL_EXIT=$2 "$here/ping-heartbeat.sh" 2>&1) || status=$?
}

url=https://uptime.example/api/v1/heartbeat/secret-token

run "$url" 0
[ "$status" = 0 ] || fail "a successful ping exits 0 (got $status)"
grep -qxF "$url" "$work/log" 2>/dev/null || fail "pings the heartbeat URL"
grep -qx -- "--max-time" "$work/log" 2>/dev/null || fail "gives up on a slow ping"
grep -qx -- "-fsS" "$work/log" 2>/dev/null || fail "treats an HTTP error as a failed ping"
[[ "$out" != *secret-token* ]] || fail "never prints the URL"

run "$url" 22
[ "$status" = 0 ] || fail "a failed ping doesn't fail the sweep (got $status)"
[[ "$out" == *"::warning::"* ]] || fail "a failed ping warns"
[[ "$out" != *secret-token* ]] || fail "a failed ping never prints the URL"

run "" 0
[ "$status" = 0 ] || fail "no URL exits 0 (got $status)"
[ ! -e "$work/log" ] || fail "no URL sends nothing"
[[ "$out" == *"::notice::"* ]] || fail "no URL says nothing watches the sweeps"

finish "All heartbeat checks passed"
