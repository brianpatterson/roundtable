#!/usr/bin/env bash
# Pings a Better Stack heartbeat after a factory sweep succeeds (ADR-0060). Better Stack opens an
# incident and emails the owner when an hour passes without a ping, so a sweep that fails, or one
# that never starts (the factory's clock stopped, GitHub Actions is down), is noticed.
#
#   HEARTBEAT_URL=… ping-heartbeat.sh
#
# An unset URL skips the ping (the secret isn't set up yet, or this is a fork). A failed ping only
# warns: the sweep did its work, and if pings keep failing, the missing pings raise the alarm.
# The URL is a secret and is never printed. CURL overrides the curl binary (tests).
set -euo pipefail

CURL=${CURL:-curl}

if [ -z "${HEARTBEAT_URL:-}" ]; then
  echo "::notice::No heartbeat URL is set, so nothing watches for missed sweeps. See infra/README.md, Factory clock."
  exit 0
fi

if ! "$CURL" -fsS --max-time 10 --retry 3 -o /dev/null "$HEARTBEAT_URL"; then
  echo "::warning::The heartbeat ping failed. Better Stack alerts if the next ones fail too."
fi
