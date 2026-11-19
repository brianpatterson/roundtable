import pg from 'pg';
import { createDb } from '../src/platform/database/promise.js';
import { runMigrations } from '../src/platform/database/migrate.js';
import { Redacted } from 'effect';

const sharedTestDatabase =
  process.env.TEST_DATABASE_URL ?? 'postgres://app:app@localhost:5432/app_test';

/**
 * The database the tests use. Every test file shares one, so `reset()` empties it between them
 * and files run one at a time. Stryker (ADR-0027) runs several test processes at once, so under
 * Stryker each of its workers gets its own copy: `app_test_<worker>`.
 */
export const testDatabaseUrl = forStrykerWorker(
  sharedTestDatabase,
  process.env.STRYKER_MUTATOR_WORKER,
);

function forStrykerWorker(url: string, worker: string | undefined): string {
  if (worker === undefined) return url;

  const perWorker = new URL(url);

  perWorker.pathname = `${perWorker.pathname}_${worker}`;

  return perWorker.href;
}

/**
 * Vitest's global setup. Creates and migrates a Stryker worker's own database; the shared one
 * already exists (docker/postgres-init.sql, or CI's service), and each test file migrates it.
 */
export default async function createWorkerDatabase() {
  if (testDatabaseUrl === sharedTestDatabase) return;

  const name = new URL(testDatabaseUrl).pathname.slice(1);
  const client = new pg.Client({ connectionString: sharedTestDatabase });

  await client.connect();

  try {
    const existing = await client.query('select 1 from pg_database where datname = $1', [name]);

    if (existing.rowCount === 0)
      await client.query(`create database ${client.escapeIdentifier(name)}`);
  } finally {
    await client.end();
  }

  const { db, pool } = createDb(Redacted.make(testDatabaseUrl), 'roundtable-test-admin');

  try {
    await runMigrations(db);
  } finally {
    await pool.end();
  }
}
