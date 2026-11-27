// The migrations build the whole schema from nothing, as on a new server. Every other test runs
// on a database that's already migrated, so it can't tell whether runMigrations does anything.
// The phases (ADR-0073) run on fixture migrations, each scenario in its own empty database, and
// pin what they rely on: Drizzle applies any folder whose name it hasn't recorded. A failed run
// is told apart through MigrationFailed, and the migrate entry's output through
// runMigrateCommand, with one run of the real process.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Redacted } from 'effect';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { isPostDeploy, MigrationFailed, runMigrations, splitStatements } from './migrate.js';
import { runMigrateCommand, usage } from './migrate-command.js';
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

describe('the pre phase', () => {
  // Drizzle reads a folder, so pre hands it a temporary one without the post-deploy migrations.
  // os.tmpdir() reads TMPDIR, so each test gets its own and can see what's left in it.
  function ownTmpdir() {
    const dir = mkdtempSync(join(fixtureRoot, 'tmp-'));

    vi.stubEnv('TMPDIR', dir);

    return dir;
  }

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('leaves no temporary folder behind', async () => {
    const { folder } = roundsMigrations('pre-tmp');
    const dir = ownTmpdir();

    await withDb(await emptyDatabase('pre_tmp'), ({ db }) => runMigrations(db, 'pre', folder));

    expect(readdirSync(dir)).toEqual([]);
  });

  it('leaves none behind when a migration fails', async () => {
    const migrations = roundsMigrations('pre-tmp-fails');

    migrations.add('20260104000000_broken', 'alter table missing add column notes text;');

    const dir = ownTmpdir();

    await withDb(await emptyDatabase('pre_tmp_fails'), async ({ db }) => {
      await expect(runMigrations(db, 'pre', migrations.folder)).rejects.toBeInstanceOf(
        MigrationFailed,
      );
    });

    expect(readdirSync(dir)).toEqual([]);
  });
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

describe('splitStatements', () => {
  it('splits on statement breakpoints, without comments, semicolons or empty statements', () => {
    const sql = [
      '-- Why this migration exists.',
      'ALTER TABLE "rounds" DROP COLUMN "legacy";--> statement-breakpoint',
      '  UPDATE "rounds"',
      '  -- a note in the middle',
      '  SET "status" = \'done\';  ',
      '--> statement-breakpoint',
      '',
    ].join('\n');

    expect(splitStatements(sql)).toEqual([
      'ALTER TABLE "rounds" DROP COLUMN "legacy"',
      'UPDATE "rounds"\n  SET "status" = \'done\'',
    ]);
  });
});

describe('a failed run', () => {
  /** rounds, with `flag` added by an applied migration. */
  async function roundsWithFlag(label: string) {
    const migrations = migrationsFolder(`failed-${label}`);

    migrations.add('20260101000000_create_rounds', 'create table rounds (id serial primary key);');
    migrations.add('20260102000000_add_flag', 'alter table rounds add column flag boolean;');

    const url = await emptyDatabase(`failed_${label}`);

    await withDb(url, ({ db }) => runMigrations(db, undefined, migrations.folder));

    return { migrations, url };
  }

  async function failure(url: string, phase: 'pre' | 'post' | undefined, folder: string) {
    return withDb(url, async ({ db }) => {
      try {
        await runMigrations(db, phase, folder);
      } catch (error) {
        expect(error).toBeInstanceOf(MigrationFailed);

        return error instanceof MigrationFailed ? error : undefined;
      }

      expect.fail('the run succeeded');
    });
  }

  it('carries the pending migration, the phase, the statement, the message and the code', async () => {
    const { migrations, url } = await roundsWithFlag('fields');

    migrations.add('20260103000000_drop_missing', 'alter table rounds drop column missing;');

    const failed = await failure(url, 'pre', migrations.folder);

    expect({ ...failed }).toEqual({
      name: 'MigrationFailed',
      migrations: ['20260103000000_drop_missing'],
      phase: 'pre',
      statement: 'alter table rounds drop column missing',
      reason: 'column "missing" of relation "rounds" does not exist',
      code: '42703',
    });
    expect(failed?.message).toBe(
      'Migration 20260103000000_drop_missing failed: ' +
        'column "missing" of relation "rounds" does not exist (code 42703)',
    );
  });

  it('names only the pending migration when an applied one holds the same statement', async () => {
    const { migrations, url } = await roundsWithFlag('applied');

    migrations.add('20260103000000_add_flag_again', 'alter table rounds add column flag boolean;');

    expect(await runMigrateCommand(['post'], Redacted.make(url), migrations.folder)).toEqual({
      code: 1,
      output:
        'Migration 20260103000000_add_flag_again failed: ' +
        'column "flag" of relation "rounds" already exists (code 42701)',
    });
  });

  it('names each pending migration that holds the failed statement', async () => {
    const { migrations, url } = await roundsWithFlag('both');
    const addNotes = 'alter table rounds add column notes text;';

    migrations.add('20260103000000_add_notes', addNotes);
    migrations.add('20260104000000_add_notes_again', `-- Again.\n${addNotes}`);

    const failed = await failure(url, 'pre', migrations.folder);

    expect(failed?.migrations).toEqual([
      '20260103000000_add_notes',
      '20260104000000_add_notes_again',
    ]);
    expect(failed?.message).toBe(
      'Migration one of 20260103000000_add_notes, 20260104000000_add_notes_again failed: ' +
        'column "notes" of relation "rounds" already exists (code 42701)',
    );
  });

  it('leaves the post-deploy migrations out of a pre run, and names them in post', async () => {
    const { migrations, url } = await roundsWithFlag('phases');
    const dropMissing = 'alter table rounds drop column missing;';

    migrations.add('20260103000000_drop_missing_postdeploy', dropMissing);

    expect((await failure(url, 'post', migrations.folder))?.migrations).toEqual([
      '20260103000000_drop_missing_postdeploy',
    ]);

    migrations.add('20260104000000_drop_missing', dropMissing);

    expect((await failure(url, 'pre', migrations.folder))?.migrations).toEqual([
      '20260104000000_drop_missing',
    ]);
  });

  it("names no migration when Drizzle's own bookkeeping fails", async () => {
    const { migrations, url } = await roundsWithFlag('bookkeeping');

    migrations.add(
      '20260103000000_refuse_records',
      `create function refuse() returns trigger language plpgsql as $$
        begin raise exception 'no more records'; end $$;
      --> statement-breakpoint
      create trigger refuse before insert on drizzle.__drizzle_migrations
        for each row execute function refuse();`,
    );

    const failed = await failure(url, undefined, migrations.folder);

    expect(failed?.migrations).toEqual([]);
    expect(failed?.message).toBe('Migrations failed: no more records (code P0001)');
  });

  it('leaves a failure outside a statement as it is: a refused connection', async () => {
    const { folder } = roundsMigrations('refused');

    await withDb('postgres://nobody@127.0.0.1:9/none', async ({ db }) => {
      const run = runMigrations(db, 'pre', folder);

      await expect(run).rejects.toThrow('ECONNREFUSED');
      await expect(run).rejects.not.toBeInstanceOf(MigrationFailed);
    });
  });
});

describe('runMigrateCommand', () => {
  // An address nothing listens on: reaching for the database fails.
  const nowhere = Redacted.make('postgres://nobody@127.0.0.1:9/none');

  it.each([[['both']], [['PRE']], [['pre', 'post']], [['']]])(
    'answers %j with its usage, without touching the database',
    async (args) => {
      expect(await runMigrateCommand(args, nowhere)).toEqual({ code: 1, output: usage });
    },
  );

  it.each([
    [[], 'Migrations applied'],
    [['pre'], 'Migrations applied (pre)'],
    [['post'], 'Migrations applied (post)'],
  ])('runs %j and says so', async (args, output) => {
    const { folder } = roundsMigrations(`command-${args.join('') || 'all'}`);
    const url = await emptyDatabase(`command_${args.join('') || 'all'}`);

    expect(await runMigrateCommand(args, Redacted.make(url), folder)).toEqual({ code: 0, output });

    await withDb(url, async ({ pool }) => {
      expect(await applied(pool)).toEqual(
        args[0] === 'pre'
          ? ['create_rounds', 'add_tags']
          : ['create_rounds', 'drop_legacy_postdeploy', 'add_tags'],
      );
    });
  });

  it('gives a failure outside a statement only its message and code', async () => {
    const { folder } = roundsMigrations('command-refused');

    expect(await runMigrateCommand(['pre'], nowhere, folder)).toEqual({
      code: 1,
      output: 'Migrations failed: connect ECONNREFUSED 127.0.0.1:9 (code ECONNREFUSED)',
    });
  });

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

    return { migrations, url };
  }

  it.each([
    ['pre', ['pre']],
    ['post', ['post']],
    ['all', []],
  ])('prints only the safe fields of a constraint failure (%s)', async (label, args) => {
    const { migrations, url } = await failingRun(
      `unique_${label}`,
      args,
      'create unique index people_email on people (email);',
    );

    const result = await runMigrateCommand(args, Redacted.make(url), migrations.folder);

    expect(result).toEqual({
      code: 1,
      output:
        'Migration 20260102000000_tighten_people failed: ' +
        'could not create unique index "people_email" (code 23505)',
    });
    expect(result.output).not.toContain(email);

    await withDb(url, async ({ pool }) => {
      expect(await applied(pool)).toEqual(['create_people']);
    });
  });

  it('names a NOT NULL failure without the row', async () => {
    const { migrations, url } = await failingRun(
      'not_null',
      ['pre'],
      'alter table people alter column age set not null;',
    );

    expect(await runMigrateCommand(['pre'], Redacted.make(url), migrations.folder)).toEqual({
      code: 1,
      output:
        'Migration 20260102000000_tighten_people failed: ' +
        'column "age" of relation "people" contains null values (code 23502)',
    });
  });

  it('drops the value a data exception quotes', async () => {
    const { migrations, url } = await failingRun(
      'cast',
      ['pre'],
      'alter table people alter column age type integer using age::integer;',
    );

    expect(await runMigrateCommand(['pre'], Redacted.make(url), migrations.folder)).toEqual({
      code: 1,
      output:
        'Migration 20260102000000_tighten_people failed: ' +
        'invalid input syntax for type integer: "<redacted>" (code 22P02)',
    });
  });

  it('runs as the deploy runs it: its own process, one line on stderr, exit 1', async () => {
    const { migrations, url } = await failingRun(
      'process',
      ['pre'],
      'create unique index people_email on people (email);',
    );

    const result = await runEntry(['pre'], {
      DATABASE_URL: url,
      MIGRATIONS_FOLDER: migrations.folder,
    });

    expect(result).toEqual({
      code: 1,
      stdout: '',
      stderr:
        'Migration 20260102000000_tighten_people failed: ' +
        'could not create unique index "people_email" (code 23505)\n',
    });
  }, 30_000);
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
