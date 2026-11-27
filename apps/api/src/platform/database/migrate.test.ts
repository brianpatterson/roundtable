// The migrations build the whole schema from nothing, as on a new server. Every other test runs
// on a database that's already migrated, so it can't tell whether runMigrations does anything.
// The phases (ADR-0073) run on fixture migrations, each scenario in its own empty database, and
// pin what they rely on: Drizzle applies any folder whose name it hasn't recorded.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Redacted } from 'effect';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readlinkSync, readdirSync, rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import {
  describeMigrationFailure,
  isPostDeploy,
  parsePhase,
  runMigrations,
  usage,
  withPreDeployFolder,
} from './migrate.js';
import { createDb } from './promise.js';
import { env } from '#test/helpers';

const testDatabase = new URL(Redacted.value(env.DATABASE_URL));
const admin = new pg.Client({ connectionString: testDatabase.href });
const created: string[] = [];
const fixtureRoot = mkdtempSync(join(tmpdir(), 'roundtable-migrate-test-'));

beforeAll(() => admin.connect());

afterAll(async () => {
  for (const name of created)
    await admin.query(`drop database if exists ${admin.escapeIdentifier(name)}`);

  await admin.end();
  rmSync(fixtureRoot, { recursive: true, force: true });
});

/** A new empty database, dropped after the file's tests. */
async function emptyDatabase(label: string) {
  const name = `${testDatabase.pathname.slice(1)}_${label}_${process.pid}`;
  const url = new URL(testDatabase);

  url.pathname = `/${name}`;
  await admin.query(`drop database if exists ${admin.escapeIdentifier(name)}`);
  await admin.query(`create database ${admin.escapeIdentifier(name)}`);
  created.push(name);

  return url.href;
}

/** Runs `use` with a pool on `url`, closing it after. */
async function withDb<A>(url: string, use: (db: ReturnType<typeof createDb>) => Promise<A>) {
  const connection = createDb(Redacted.make(url), 'roundtable-test-admin');

  try {
    return await use(connection);
  } finally {
    await connection.pool.end();
  }
}

/** A folder of migrations, as drizzle-kit writes them: `<timestamp>_<name>/migration.sql`. */
function migrationsFolder(label: string) {
  const folder = join(fixtureRoot, label);

  mkdirSync(folder);

  return {
    folder,
    add(name: string, sql: string) {
      mkdirSync(join(folder, name));
      writeFileSync(join(folder, name, 'migration.sql'), sql);
    },
  };
}

function roundsMigrations(label: string) {
  const migrations = migrationsFolder(label);

  migrations.add(
    '20260101000000_create_rounds',
    'create table rounds (id serial primary key, legacy text);',
  );
  migrations.add('20260102000000_drop_legacy_postdeploy', 'alter table rounds drop column legacy;');
  migrations.add('20260103000000_add_tags', 'alter table rounds add column tags text[];');

  return migrations;
}

/** The migrations recorded as applied, in the order they were applied. */
async function applied(pool: pg.Pool) {
  const { rows } = await pool.query<{ name: string }>(
    'select name from drizzle.__drizzle_migrations order by id',
  );

  return rows.map((row) => row.name.slice(15));
}

async function columns(pool: pg.Pool, table: string) {
  const { rows } = await pool.query<{ name: string }>(
    `select column_name as name from information_schema.columns
      where table_schema = 'public' and table_name = $1 order by column_name`,
    [table],
  );

  return rows.map((row) => row.name);
}

describe('runMigrations', () => {
  it('creates every table in an empty database', async () => {
    const url = await emptyDatabase('empty');

    await withDb(url, async ({ db, pool }) => {
      await runMigrations(db);

      const { rows } = await pool.query<{ name: string }>(
        `select tablename as name from pg_tables where schemaname = 'public' order by tablename`,
      );

      expect(rows.map((row) => row.name)).toEqual([
        'accounts',
        'applications',
        'email_sends',
        'persona_skills',
        'personas',
        'prep_tasks',
        'rounds',
        'sessions',
        'skills',
        'user_reports',
        'users',
        'verifications',
      ]);
    });
  });

  it('runs everything without a phase, post-deploy migrations included', async () => {
    const { folder } = roundsMigrations('all');

    await withDb(await emptyDatabase('all'), async ({ db, pool }) => {
      await runMigrations(db, undefined, folder);

      expect(await applied(pool)).toEqual(['create_rounds', 'drop_legacy_postdeploy', 'add_tags']);
      expect(await columns(pool, 'rounds')).toEqual(['id', 'tags']);
    });
  });

  it('leaves post-deploy migrations to the post phase, which runs them once', async () => {
    const { folder } = roundsMigrations('phases');

    await withDb(await emptyDatabase('phases'), async ({ db, pool }) => {
      await runMigrations(db, 'pre', folder);

      expect(await applied(pool)).toEqual(['create_rounds', 'add_tags']);
      expect(await columns(pool, 'rounds')).toEqual(['id', 'legacy', 'tags']);

      await runMigrations(db, 'post', folder);

      expect(await applied(pool)).toEqual(['create_rounds', 'add_tags', 'drop_legacy_postdeploy']);
      expect(await columns(pool, 'rounds')).toEqual(['id', 'tags']);

      await runMigrations(db, 'post', folder);

      expect(await applied(pool)).toEqual(['create_rounds', 'add_tags', 'drop_legacy_postdeploy']);
      expect(await columns(pool, 'rounds')).toEqual(['id', 'tags']);
    });
  });

  it('applies a skipped post-deploy migration after migrations added since', async () => {
    const migrations = roundsMigrations('skipped');

    await withDb(await emptyDatabase('skipped'), async ({ db, pool }) => {
      await runMigrations(db, 'pre', migrations.folder);
      migrations.add('20260104000000_add_notes', 'alter table rounds add column notes text;');
      await runMigrations(db, 'pre', migrations.folder);

      expect(await applied(pool)).toEqual(['create_rounds', 'add_tags', 'add_notes']);

      await runMigrations(db, 'post', migrations.folder);

      expect(await applied(pool)).toEqual([
        'create_rounds',
        'add_tags',
        'add_notes',
        'drop_legacy_postdeploy',
      ]);
      expect(await columns(pool, 'rounds')).toEqual(['id', 'notes', 'tags']);
    });
  });

  // A migration can't return anything, so it records the settings it ran with in a table.
  const recordSettings = `create table settings as select
    current_setting('lock_timeout') as lock_timeout,
    current_setting('statement_timeout') as statement_timeout;`;

  async function settingsUnder(phase: 'pre' | 'post' | undefined) {
    const migrations = migrationsFolder(`settings-${phase ?? 'none'}`);

    migrations.add('20260101000000_record_settings', recordSettings);

    return withDb(await emptyDatabase(`settings_${phase ?? 'none'}`), async ({ db, pool }) => {
      await runMigrations(db, phase, migrations.folder);

      const { rows } = await pool.query('select lock_timeout, statement_timeout from settings');

      return rows;
    });
  }

  it.each(['pre', 'post'] as const)(
    'runs the %s phase with lock and statement timeouts',
    async (phase) => {
      expect(await settingsUnder(phase)).toEqual([
        { lock_timeout: '5s', statement_timeout: '1min' },
      ]);
    },
  );

  it('sets no timeouts without a phase', async () => {
    expect(await settingsUnder(undefined)).toEqual([{ lock_timeout: '0', statement_timeout: '0' }]);
  });

  it('gives up on a lock another session holds after about 5 seconds', async () => {
    const migrations = migrationsFolder('lock');

    migrations.add('20260101000000_create_rounds', 'create table rounds (id serial primary key);');

    const url = await emptyDatabase('lock');

    await withDb(url, async ({ db, pool }) => {
      await runMigrations(db, 'pre', migrations.folder);
      migrations.add('20260102000000_add_tags', 'alter table rounds add column tags text[];');

      const holder = await pool.connect();

      try {
        await holder.query('begin');
        await holder.query('lock table rounds in access exclusive mode');

        const started = Date.now();

        await expect(runMigrations(db, 'pre', migrations.folder)).rejects.toThrow();

        const waited = Date.now() - started;

        expect(waited).toBeGreaterThanOrEqual(4_500);
        expect(waited).toBeLessThan(15_000);
      } finally {
        await holder.query('rollback');
        holder.release();
      }

      expect(await applied(pool)).toEqual(['create_rounds']);
    });
  }, 30_000);
});

describe('isPostDeploy', () => {
  it.each([
    ['20261127000000_drop_legacy_postdeploy', true],
    ['drop_legacy_postdeploy', true],
    ['20261127000000_drop_legacy', false],
    ['20261127000000_drop_postdeploy_legacy', false],
    ['20261127000000_drop_legacy_postdeploy_again', false],
    ['20261127000000_drop_legacypostdeploy', false],
  ])('%s → %s', (name, expected) => {
    expect(isPostDeploy(name)).toBe(expected);
  });
});

describe('withPreDeployFolder', () => {
  const migrations = roundsMigrations('pre-folder');

  it('links every migration but the post-deploy ones, by absolute path', async () => {
    const links = await withPreDeployFolder(migrations.folder, async (pre) =>
      readdirSync(pre).map((entry) => readlinkSync(join(pre, entry))),
    );

    expect(links).toEqual([
      resolve(migrations.folder, '20260101000000_create_rounds'),
      resolve(migrations.folder, '20260103000000_add_tags'),
    ]);
    expect(links.every((link) => isAbsolute(link))).toBe(true);
  });

  it('is a fresh temporary folder each time, removed after the run', async () => {
    const first = await withPreDeployFolder(migrations.folder, async (pre) => pre);
    const second = await withPreDeployFolder(migrations.folder, async (pre) => pre);

    expect(first).not.toBe(second);
    expect(first.startsWith(tmpdir())).toBe(true);
    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(false);
  });

  it('is removed when the run fails', async () => {
    let seen = '';

    await expect(
      withPreDeployFolder(migrations.folder, async (pre) => {
        seen = pre;
        throw new Error('migration failed');
      }),
    ).rejects.toThrow('migration failed');
    expect(seen).not.toBe('');
    expect(existsSync(seen)).toBe(false);
  });
});

describe('the migrate entry', () => {
  it.each([
    [[], undefined],
    [['pre'], 'pre'],
    [['post'], 'post'],
    [['both'], false],
    [['PRE'], false],
    [['pre', 'post'], false],
    [[''], false],
  ])('reads %j as %s', (args, expected) => {
    expect(parsePhase(args)).toBe(expected);
  });

  it('prints its usage and exits 1 on any other argument, without touching the database', async () => {
    // An address nothing listens on: reaching for the database would fail differently.
    const result = await runEntry(['sideways'], {
      DATABASE_URL: 'postgres://nobody@127.0.0.1:9/none',
    });

    expect(result).toEqual({ code: 1, stdout: '', stderr: `${usage}\n` });
  }, 30_000);

  // The deploy log is public, and a failed migration's output reaches it (deploy.sh's
  // `recent_logs migrate`, post-migrate.sh). Postgres's `detail` quotes the rows that broke the
  // constraint, so the entry prints only the migration's name, the message and the code.
  const email = 'someone-private@example.com';

  async function failingRun(label: string, args: string[], breaking: string) {
    const migrations = migrationsFolder(`entry-${label}`);

    migrations.add(
      '20260101000000_create_people',
      `create table people (id serial primary key, email text, age text);
      --> statement-breakpoint
      insert into people (email, age) values ('${email}', 'forty-two'), ('${email}', null);`,
    );

    const url = await emptyDatabase(`entry_${label}`);

    await withDb(url, ({ db }) => runMigrations(db, undefined, migrations.folder));
    migrations.add('20260102000000_tighten_people', breaking);

    const result = await runEntry(args, {
      DATABASE_URL: url,
      MIGRATIONS_FOLDER: migrations.folder,
    });

    return { result, url };
  }

  it.each([
    ['pre', ['pre']],
    ['post', ['post']],
    ['all', []],
  ])(
    'prints only the safe fields of a constraint failure and exits 1 (%s)',
    async (label, args) => {
      const { result, url } = await failingRun(
        `unique_${label}`,
        args,
        'create unique index people_email on people (email);',
      );

      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe(
        'Migration 20260102000000_tighten_people failed: ' +
          'could not create unique index "people_email" (code 23505)\n',
      );
      expect(`${result.stdout}${result.stderr}`).not.toContain(email);

      await withDb(url, async ({ pool }) => {
        expect(await applied(pool)).toEqual(['create_people']);
      });
    },
    30_000,
  );

  it('names a NOT NULL failure without the row', async () => {
    const { result } = await failingRun(
      'not_null',
      ['pre'],
      'alter table people alter column age set not null;',
    );

    expect(result).toEqual({
      code: 1,
      stdout: '',
      stderr:
        'Migration 20260102000000_tighten_people failed: ' +
        'column "age" of relation "people" contains null values (code 23502)\n',
    });
  }, 30_000);

  it('drops the value a data exception quotes', async () => {
    const { result } = await failingRun(
      'cast',
      ['pre'],
      'alter table people alter column age type integer using age::integer;',
    );

    expect(result).toEqual({
      code: 1,
      stdout: '',
      stderr:
        'Migration 20260102000000_tighten_people failed: ' +
        'invalid input syntax for type integer: "<redacted>" (code 22P02)\n',
    });
  }, 30_000);
});

describe('describeMigrationFailure', () => {
  const migrations = migrationsFolder('describe');

  migrations.add('20260101000000_add_flag', 'alter table rounds add column flag boolean;');
  migrations.add('20260102000000_drop_flag_postdeploy', 'alter table rounds drop column flag;');
  migrations.add('20260103000000_add_flag_again', 'alter table rounds add column flag boolean;');

  it('names every migration that holds the failed statement', () => {
    const error = new DrizzleQueryError('alter table rounds add column flag boolean;', undefined);

    expect(describeMigrationFailure(error, 'post', migrations.folder)).toBe(
      'Migration one of 20260101000000_add_flag, 20260103000000_add_flag_again failed: ' +
        'Failed query: alter table rounds add column flag boolean;',
    );
  });

  it('leaves out post-deploy migrations in the pre phase', () => {
    const error = new DrizzleQueryError('alter table rounds drop column flag;', undefined);

    expect(describeMigrationFailure(error, 'pre', migrations.folder)).toBe(
      'Migrations failed: Failed query: alter table rounds drop column flag;',
    );
    expect(describeMigrationFailure(error, 'post', migrations.folder)).toBe(
      'Migration 20260102000000_drop_flag_postdeploy failed: ' +
        'Failed query: alter table rounds drop column flag;',
    );
  });

  it('redacts query params, and gives a failure outside a query its own code', () => {
    const query = new DrizzleQueryError('select $1', ['a-session-token']);

    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), {
      code: 'ECONNREFUSED',
    });

    expect(describeMigrationFailure(query, undefined, migrations.folder)).toBe(
      'Migrations failed: Failed query: select $1\nparams: <redacted: string(15)>',
    );
    expect(describeMigrationFailure(refused, undefined, migrations.folder)).toBe(
      'Migrations failed: connect ECONNREFUSED 127.0.0.1:9 (code ECONNREFUSED)',
    );
  });
});

/** Runs the migrate entry as the deploy does, in its own process, with the tests' environment. */
function runEntry(args: string[], overrides: Record<string, string>) {
  const entry = fileURLToPath(new URL('../../migrate.ts', import.meta.url));

  return new Promise<{ code: number | null; stdout: string; stderr: string }>((done) => {
    const child = execFile(
      process.execPath,
      ['--import', 'tsx', entry, ...args],
      {
        env: {
          ...process.env,
          BETTER_AUTH_SECRET: 'test-secret-that-is-at-least-32-characters-long',
          BETTER_AUTH_URL: 'http://localhost:5173',
          ...overrides,
        },
      },
      (_error, stdout, stderr) => done({ code: child.exitCode, stdout, stderr }),
    );
  });
}
