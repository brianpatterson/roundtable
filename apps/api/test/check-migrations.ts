import { checkMigrations, UnreadableRef } from '../src/platform/database/migration-check.js';
import { migrationsFolder } from '../src/platform/database/migrate.js';
import { sharedTestDatabase } from './test-database.js';

// `pnpm check:migrations` (scripts/check-migrations.sh): judges the migrations added since
// origin/main against the schema main builds, in a scratch database next to the tests' own
// (ADR-0073). Exits 1 on a problem or when origin/main can't be read.
try {
  const result = await checkMigrations({
    folder: migrationsFolder,
    ref: 'origin/main',
    testDatabaseUrl: sharedTestDatabase,
  });

  (result.code === 0 ? console.log : console.error)(result.output);
  process.exitCode = result.code;
} catch (error) {
  if (!(error instanceof UnreadableRef)) throw error;

  console.error(error.message);
  process.exitCode = 1;
}
