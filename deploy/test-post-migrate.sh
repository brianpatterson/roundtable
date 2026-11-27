#!/usr/bin/env bash
# Checks deploy/post-migrate.sh, which runs the post-deploy migrations on the server (ADR-0073),
# against a stand-in docker. Run from anywhere.
# shellcheck source=.github/factory/testlib.sh
. "$(dirname "$0")/../.github/factory/testlib.sh"
script="$(cd "$(dirname "$0")" && pwd)/post-migrate.sh"

# The stand-in records its command line and API_IMAGE in $work/calls, prints what a migrate run
# would (an info line, a warning, plain text), and exits with $work/exit (0 if absent).
cat >"$work/docker" <<'DOCKER'
#!/usr/bin/env bash
printf 'API_IMAGE=%s %s\n' "$API_IMAGE" "$*" >>"$WORK/calls"
echo '{"level":30,"msg":"an info line"}'
echo '{"level":40,"msg":"a warning"}'
echo 'migration output'
exit "$(cat "$WORK/exit" 2>/dev/null || echo 0)"
DOCKER
chmod +x "$work/docker" # in the scratch directory

# A fresh /opt/interview-app: the script, .env, .deployed, today's snapshot, and older ones.
server() {
  rm -rf "$work/app" "$work/calls" "$work/exit"
  mkdir -p "$work/app/snapshots"
  cp "$script" "$work/app/post-migrate.sh"
  echo 'DOMAIN=example.test' >"$work/app/.env"
  echo 'ghcr.io/o/api:new ghcr.io/o/web:new' >"$work/app/.deployed"
  echo 'SNAPSHOT-CONTENTS' >"$work/app/snapshots/today.dump.age"
  echo old >"$work/app/snapshots/old.dump.age"
  touch -d '8 days ago' "$work/app/snapshots/old.dump.age"
  echo recent >"$work/app/snapshots/recent.dump.age"
  touch -d '6 days ago' "$work/app/snapshots/recent.dump.age"
  echo other >"$work/app/snapshots/notes.txt"
  touch -d '30 days ago' "$work/app/snapshots/notes.txt"
}

run() { # run <args…>; sets status and out
  status=0
  out=$(cd / && DOCKER="$work/docker" WORK="$work" bash "$work/app/post-migrate.sh" "$@" 2>&1) || status=$?
}

calls() { cat "$work/calls" 2>/dev/null || true; }
snapshots() { (cd "$work/app/snapshots" && printf '%s ' *); }

server
run snapshots/today.dump.age
expect "a run with a snapshot succeeds" 0 "$status"
expect "it runs post once, in the deployed API image, through compose run" \
  "API_IMAGE=ghcr.io/o/api:new compose -f compose.prod.yml --env-file .env run --rm -T migrate node --enable-source-maps dist/migrate.js post" \
  "$(calls)"
expect_in "it passes on warnings" "$out" '{"level":40,"msg":"a warning"}'
expect_in "and plain output" "$out" "migration output"
expect "but not info lines" "" "$(echo "$out" | grep '"level":30' || true)"
expect "it deletes snapshots older than 7 days, and only those" "notes.txt recent.dump.age today.dump.age " "$(snapshots)"

server
echo 3 >"$work/exit"
run snapshots/today.dump.age
expect "a failed post fails the run" 1 "$status"
expect_in "saying so" "$out" "Post-deploy migrations failed (exit 3)"
expect "and still prints only what the filter passes" "" "$(echo "$out" | grep '"level":30' || true)"
expect "and still prunes old snapshots" "notes.txt recent.dump.age today.dump.age " "$(snapshots)"

server
run snapshots/missing.dump.age
expect "a missing snapshot fails the run" 1 "$status"
expect_in "saying so" "$out" "post-deploy migrations not run"
expect "without running post" "" "$(calls)"

server
: >"$work/app/snapshots/today.dump.age"
run snapshots/today.dump.age
expect "an empty snapshot fails the run" 1 "$status"
expect "without running post" "" "$(calls)"

server
run
expect "no snapshot argument fails the run" 1 "$status"
expect "without running post" "" "$(calls)"

server
rm "$work/app/.deployed"
run snapshots/today.dump.age
expect "no recorded release fails the run" 1 "$status"
expect "without running post" "" "$(calls)"

for outcome in 0 1; do
  server
  echo "$outcome" >"$work/exit"
  run snapshots/today.dump.age
  expect "the snapshot's contents are never printed (post exits $outcome)" "" "$(echo "$out" | grep SNAPSHOT-CONTENTS || true)"
done

finish "post-migrate.sh: all checks passed."
