// Release 3 of ADR-0045 drops `screening` from the status enum. Postgres can't drop an enum value,
// so the migration rebuilds the type under the existing rows: this runs it on a database migrated
// to just before it, holding a row in every status the previous release could store.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Redacted } from 'effect';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import pg from 'pg';
import { migrationsFolder, runMigrations } from '../../platform/database/migrate.js';
import { createDb } from '../../platform/database/promise.js';
import { env } from '#test/helpers';

const MIGRATION = 'drop_screening_status';

const STORED_BEFORE = [
  'saved',
  'applied',
  'screening',
  'interviewing',
  'offer',
  'accepted',
  'rejected',
  'withdrawn',
];

describe('the migration that drops screening', () => {
  const testDatabase = new URL(Redacted.value(env.DATABASE_URL));
  const name = `${testDatabase.pathname.slice(1)}_statuses_${process.pid}`;
  const url = new URL(testDatabase);

  url.pathname = `/${name}`;

  const admin = new pg.Client({ connectionString: testDatabase.href });
  const before = mkdtempSync(join(tmpdir(), 'roundtable-migrations-'));

  // Every migration up to this one, as the database stands under the previous release.
  cpSync(migrationsFolder, before, {
    recursive: true,
    filter: (source) => !basename(source).endsWith(`_${MIGRATION}`),
  });

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`drop database if exists ${admin.escapeIdentifier(name)}`);
    await admin.query(`create database ${admin.escapeIdentifier(name)}`);
  });
  afterAll(async () => {
    await admin.query(`drop database if exists ${admin.escapeIdentifier(name)}`);
    await admin.end();
    rmSync(before, { recursive: true, force: true });
  });

  it('keeps every row, folds screening into interviewing, and drops the value', async () => {
    const { db, pool } = createDb(Redacted.make(url.href), 'roundtable-test-admin');

    try {
      await migrate(db, { migrationsFolder: before });
      await pool.query(
        `insert into users (id, name, email) values ('u1', 'Ada', 'ada@example.com')`,
      );

      for (const [index, status] of STORED_BEFORE.entries()) {
        await pool.query(
          `insert into applications (user_id, company, job_title, status) values ('u1', $1, 'SWE', $2)`,
          [`Company ${index}`, status],
        );
      }

      await runMigrations(db);

      const { rows } = await pool.query<{ company: string; status: string }>(
        `select company, status from applications order by company`,
      );

      const values = await pool.query<{ value: string }>(
        `select unnest(enum_range(null::application_status))::text as value`,
      );

      const inserted = await pool.query<{ status: string }>(
        `insert into applications (user_id, company, job_title) values ('u1', 'New', 'SWE') returning status`,
      );

      expect(rows.map((row) => row.status)).toEqual(
        STORED_BEFORE.map((status) => (status === 'screening' ? 'interviewing' : status)),
      );
      expect(values.rows.map((row) => row.value)).toEqual([
        'saved',
        'applied',
        'interviewing',
        'offer',
        'accepted',
        'rejected',
        'withdrawn',
      ]);
      expect(inserted.rows[0]?.status).toBe('applied');
      await expect(
        pool.query(
          `insert into applications (user_id, company, job_title, status) values ('u1', 'Old', 'SWE', 'screening')`,
        ),
      ).rejects.toThrow(/invalid input value for enum/);
    } finally {
      await pool.end();
    }
  });
});
