import { createDb } from './platform/database/promise.js';
import {
  describeMigrationFailure,
  parsePhase,
  runMigrations,
  usage,
} from './platform/database/migrate.js';
import { loadEnv } from './platform/config/env.js';

// Runs as its own container in each deploy (ADR-0014), with the API's environment, read and
// validated the same way the server reads it. `pre` runs before the new release starts, `post`
// after it's healthy, and no argument runs everything (ADR-0073).
const phase = parsePhase(process.argv.slice(2));

if (phase === false) {
  console.error(usage);
  process.exit(1);
}

const env = loadEnv();
const { db, pool } = createDb(env.DATABASE_URL);
let failure: string | undefined;

// A failure is caught rather than left to Node, which would print the whole error, Postgres's
// `detail` and its row values included, into the public deploy log (#275).
try {
  await runMigrations(db, phase);
} catch (error) {
  failure = error instanceof Error ? describeMigrationFailure(error, phase) : 'Migrations failed';
} finally {
  await pool.end();
}

if (failure !== undefined) {
  console.error(failure);
  process.exit(1);
}

console.log(phase === undefined ? 'Migrations applied' : `Migrations applied (${phase})`);
