#!/usr/bin/env bash
# The migration check (ADR-0073): fails a migration added since origin/main that the previous
# release's code can't live with, naming the statement and the fix. It applies main's migrations
# to a scratch database next to the tests' (TEST_DATABASE_URL), so it needs `pnpm db:up`, and
# origin/main fetched. The logic is apps/api/src/platform/database/migration-check.ts.
set -euo pipefail
cd "$(dirname "$0")/.."

exec pnpm --silent --filter @roundtable/api check:migrations
