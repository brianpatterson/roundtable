import { checkMigrations, UnreadableRef } from './migration-check.js';
import { migrationsFolder } from './migrate.js';

// `pnpm check:migrations` (scripts/check-migrations.sh): judges the migrations added since
// origin/main against the schema main builds, in a scratch database next to the tests' own
// (ADR-0073). Exits 1 on a problem or when origin/main can't be read. It lives here, in an owner
// path (ADR-0074), rather than in test/, so a ticket can't weaken what the gate runs; that's why
// it keeps its own copy of the tests' default database instead of importing test plumbing.
const testDatabaseUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://app:app@localhost:5432/app_test';

try {
  const result = await checkMigrations({
    folder: migrationsFolder,
    ref: 'origin/main',
    testDatabaseUrl,
  });

  (result.code === 0 ? console.log : console.error)(result.output);
  process.exitCode = result.code;
} catch (error) {
  if (!(error instanceof UnreadableRef)) throw error;

  console.error(error.message);
  process.exitCode = 1;
}
