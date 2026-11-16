import { createDb } from './platform/database/promise.js';
import { runMigrations } from './platform/database/migrate.js';
import { loadEnv } from './platform/config/env.js';

// Runs as its own container before each deploy (ADR-0014), with the API's environment, read and
// validated the same way the server reads it.
const env = loadEnv();
const { db, pool } = createDb(env.DATABASE_URL);

await runMigrations(db);

await pool.end();

console.log('Migrations applied');
