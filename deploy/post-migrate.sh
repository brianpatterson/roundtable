#!/usr/bin/env bash
# Runs the post-deploy migrations (ADR-0073) once a release is healthy, then prunes old snapshots.
#   Usage: post-migrate.sh <snapshot>
# <snapshot> is the encrypted dump of the database taken right before this step
# (snapshots/<name>.dump.age, on the data volume). Without one, post-deploy migrations, the only
# ones that destroy data, don't run.
# Runs as the `deploy` user from /opt/interview-app, next to deploy.sh, compose.prod.yml, .env
# and .deployed, in the API image deploy.sh last recorded there.
set -euo pipefail
cd "$(dirname "$0")"

snapshot=${1:?usage: post-migrate.sh <snapshot>}
docker=${DOCKER:-docker} # a stand-in in test-post-migrate.sh

set -a
# shellcheck disable=SC1091
source .env # DOMAIN, secrets
set +a

compose() { "$docker" compose -f compose.prod.yml --env-file .env "$@"; }

# The deploy workflow's output is public, so this prints what deploy.sh's filter does: warn/error
# lines (pino levels 40+) and anything that isn't a pino line. Never the snapshot.
important() { grep -Ev '^\{"level":(10|20|30),' || true; }

if [ ! -s "$snapshot" ]; then
  echo "✗ No snapshot at $snapshot (missing or empty): post-deploy migrations not run"
  exit 1
fi

deployed=$(cat .deployed 2>/dev/null || true)
read -r api_image web_image <<<"$deployed" || true
if [ -z "${api_image:-}" ]; then
  echo "✗ No deployed release in .deployed: post-deploy migrations not run"
  exit 1
fi

echo "→ Post-deploy migrations in $api_image"
status=0
output=$(API_IMAGE=$api_image WEB_IMAGE=${web_image:-} compose run --rm -T migrate \
  node --enable-source-maps dist/migrate.js post 2>&1) || status=$?
printf '%s\n' "$output" | important

# Snapshots are kept for 7 days (ADR-0073), whether or not this one's migrations succeeded.
if [ -d snapshots ]; then
  find snapshots -maxdepth 1 -type f -name '*.dump.age' -mmin +$((7 * 24 * 60)) -delete
fi

if [ "$status" != 0 ]; then
  echo "✗ Post-deploy migrations failed (exit $status). The release stays up; the next deploy retries them."
  exit 1
fi
echo "✓ Post-deploy migrations applied"
