import pg from 'pg';
import { Redacted } from 'effect';
import { createDb } from '../src/platform/database/promise.js';
import { runMigrations } from '../src/platform/database/migrate.js';

/**
 * The API for the browser tests (ADR-0065), started by `apps/web/playwright.config.ts`. Drops and
 * recreates its own database, `DATABASE_URL` (`app_browser`, never the dev or the Vitest one),
 * migrates it, then runs the same entry point as production. Emails go to the log, where the
 * tests read the confirmation link.
 */
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) throw new Error('DATABASE_URL is required');

const name = new URL(databaseUrl).pathname.slice(1);

if (!name.startsWith('app_browser'))
  throw new Error(`Refusing to reset ${name}: the browser tests only reset app_browser`);

// The server's maintenance database, to drop and create the test one from outside it.
const maintenance = new URL(databaseUrl);

maintenance.pathname = '/postgres';

const client = new pg.Client({ connectionString: maintenance.href });

await client.connect();

try {
  await client.query(`drop database if exists ${client.escapeIdentifier(name)} with (force)`);
  await client.query(`create database ${client.escapeIdentifier(name)}`);
} finally {
  await client.end();
}

const { db, pool } = createDb(Redacted.make(databaseUrl), 'roundtable-browser-admin');

try {
  await runMigrations(db);
} finally {
  await pool.end();
}

await import('../src/main.js');
