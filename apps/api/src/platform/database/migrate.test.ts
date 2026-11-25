// The migrations build the whole schema from nothing, as on a new server. Every other test runs
// on a database that's already migrated, so it can't tell whether runMigrations does anything.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Redacted } from 'effect';
import pg from 'pg';
import { runMigrations } from './migrate.js';
import { createDb } from './promise.js';
import { env } from '#test/helpers';

describe('runMigrations', () => {
  const testDatabase = new URL(Redacted.value(env.DATABASE_URL));
  const name = `${testDatabase.pathname.slice(1)}_empty_${process.pid}`;
  const empty = new URL(testDatabase);

  empty.pathname = `/${name}`;

  const admin = new pg.Client({ connectionString: testDatabase.href });

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`drop database if exists ${admin.escapeIdentifier(name)}`);
    await admin.query(`create database ${admin.escapeIdentifier(name)}`);
  });
  afterAll(async () => {
    await admin.query(`drop database if exists ${admin.escapeIdentifier(name)}`);
    await admin.end();
  });

  it('creates every table in an empty database', async () => {
    const { db, pool } = createDb(Redacted.make(empty.href), 'roundtable-test-admin');

    try {
      await runMigrations(db);

      const { rows } = await pool.query<{ name: string }>(
        `select tablename as name from pg_tables where schemaname = 'public' order by tablename`,
      );

      expect(rows.map((row) => row.name)).toEqual([
        'accounts',
        'applications',
        'email_sends',
        'rounds',
        'sessions',
        'skills',
        'user_reports',
        'users',
        'verifications',
      ]);
    } finally {
      await pool.end();
    }
  });
});
