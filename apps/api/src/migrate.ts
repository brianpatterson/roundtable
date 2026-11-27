import { createDb } from './platform/database/promise.js';
import { parsePhase, runMigrations, usage } from './platform/database/migrate.js';
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

try {
  await runMigrations(db, phase);
} finally {
  await pool.end();
}

console.log(phase === undefined ? 'Migrations applied' : `Migrations applied (${phase})`);
