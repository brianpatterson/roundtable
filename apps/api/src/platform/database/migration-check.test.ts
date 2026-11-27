// The migration check (ADR-0073). The rules are judged against a made-up `main` schema; the
// scratch database, the real migrations and the whole check (on a throwaway git repository) run
// against Postgres next to the tests' database.
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import {
  checkMigrations,
  classifyMigration,
  closePool,
  judgeMigrations,
  readSchema,
  scratchDatabaseName,
  UnreadableRef,
  withScratchDatabase,
  type Schema,
} from './migration-check.js';
import { Redacted } from 'effect';
import { migrationsFolder, runMigrations } from './migrate.js';
import { runMigrateCommand } from './migrate-command.js';
import { createDb } from './promise.js';
import { sharedTestDatabase } from '#test/test-database';

const fixtureRoot = mkdtempSync(join(tmpdir(), 'roundtable-migration-check-test-'));

afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));

/** `main`: rounds(id, status, legacy) with an enum type `round_status`. */
const main: Schema = {
  tables: new Set(['rounds']),
  columns: new Set(['rounds.id', 'rounds.status', 'rounds.legacy']),
  types: new Set(['round_status']),
};

function judge(name: string, sql: string) {
  return judgeMigrations([{ name, sql }], main);
}

describe('classifyMigration', () => {
  it('classifies each statement splitStatements reads', () => {
    expect(
      classifyMigration(
        'ALTER TABLE "rounds" DROP COLUMN "legacy";--> statement-breakpoint\n' +
          'UPDATE "rounds" SET "status" = \'done\';',
      ),
    ).toEqual([
      {
        sql: 'ALTER TABLE "rounds" DROP COLUMN "legacy"',
        changes: [{ kind: 'drop-column', table: 'rounds', column: 'legacy' }],
      },
      { sql: 'UPDATE "rounds" SET "status" = \'done\'', changes: [] },
    ]);
  });

  it.each([
    [
      'CREATE TABLE "notes" (\n\t"id" uuid PRIMARY KEY\n)',
      [{ kind: 'create-table', table: 'notes' }],
    ],
    [
      'CREATE TYPE "public"."round_kind" AS ENUM(\'a\', \'b\')',
      [{ kind: 'create-type', type: 'round_kind' }],
    ],
    ['ALTER TABLE "rounds" RENAME TO "stages"', [{ kind: 'rename-table', table: 'rounds' }]],
    [
      'ALTER TABLE "rounds" RENAME COLUMN "legacy" TO "old"',
      [{ kind: 'rename-column', table: 'rounds', column: 'legacy' }],
    ],
    ['ALTER TABLE "rounds" RENAME CONSTRAINT "a" TO "b"', []],
    [
      'DROP TABLE "rounds", "notes" CASCADE',
      [
        { kind: 'drop-table', table: 'rounds' },
        { kind: 'drop-table', table: 'notes' },
      ],
    ],
    ['DROP TYPE "public"."round_status"', [{ kind: 'drop-type', type: 'round_status' }]],
    [
      'ALTER TABLE "public"."rounds" ALTER COLUMN "status" SET NOT NULL',
      [{ kind: 'set-not-null', table: 'rounds', column: 'status' }],
    ],
    [
      'ALTER TABLE "rounds" ALTER COLUMN "status" SET DATA TYPE text',
      [{ kind: 'set-data-type', table: 'rounds', column: 'status' }],
    ],
    [
      'alter table Rounds alter status type text',
      [{ kind: 'set-data-type', table: 'rounds', column: 'status' }],
    ],
    [
      'ALTER TABLE "rounds" ADD CONSTRAINT "rounds_status_key" UNIQUE("status")',
      [{ kind: 'add-constraint', table: 'rounds', constraint: 'UNIQUE' }],
    ],
    [
      'ALTER TABLE "rounds" ADD CONSTRAINT "rounds_status_check" CHECK ("status" in (\'a\', \'b\'))',
      [{ kind: 'add-constraint', table: 'rounds', constraint: 'CHECK' }],
    ],
    [
      'ALTER TABLE "rounds" ADD CONSTRAINT "rounds_user_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id")',
      [],
    ],
    ['ALTER TABLE "rounds" DROP CONSTRAINT "rounds_status_key"', []],
    [
      'CREATE UNIQUE INDEX "rounds_key" ON "rounds" USING btree ("status")',
      [{ kind: 'create-unique-index', table: 'rounds' }],
    ],
    [
      'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "rounds_key" ON ONLY "public"."rounds" ("status")',
      [{ kind: 'create-unique-index', table: 'rounds' }],
    ],
    ['CREATE INDEX "rounds_idx" ON "rounds" ("status")', []],
    [
      'ALTER TABLE "rounds" ADD COLUMN "notes" text NOT NULL',
      [{ kind: 'add-column', table: 'rounds', column: 'notes', notNullWithoutDefault: true }],
    ],
    [
      'ALTER TABLE "rounds" ADD COLUMN "tags" text[] DEFAULT \'{}\'::text[] NOT NULL',
      [{ kind: 'add-column', table: 'rounds', column: 'tags', notNullWithoutDefault: false }],
    ],
    [
      'ALTER TABLE "rounds" ADD COLUMN "notes" text',
      [{ kind: 'add-column', table: 'rounds', column: 'notes', notNullWithoutDefault: false }],
    ],
    [
      'ALTER TABLE "rounds" ADD COLUMN "notes" text NOT NULL, DROP COLUMN "legacy"',
      [
        { kind: 'add-column', table: 'rounds', column: 'notes', notNullWithoutDefault: true },
        { kind: 'drop-column', table: 'rounds', column: 'legacy' },
      ],
    ],
    ['UPDATE "rounds" SET "status" = \'done\'', []],
    ['GRANT SELECT ON "rounds" TO someone', []],
  ])('%s', (sql, changes) => {
    expect(classifyMigration(sql)).toEqual([{ sql, changes }]);
  });
});

describe('judgeMigrations', () => {
  it.each([
    ['ALTER TABLE "rounds" RENAME TO "stages"', 'Renames table rounds'],
    ['ALTER TABLE "rounds" RENAME COLUMN "legacy" TO "old"', 'Renames column rounds.legacy'],
  ])('fails a rename of what exists on main in either phase: %s', (sql, what) => {
    for (const name of ['20270101000000_rename', '20270101000000_rename_postdeploy']) {
      const [problem] = judge(name, sql);

      expect(problem?.reason).toContain(what);
      expect(problem?.reason).toContain("ADR-0073's three steps");
    }
  });

  it.each([
    ['DROP TABLE "rounds" CASCADE', 'Drops table rounds'],
    ['ALTER TABLE "rounds" DROP COLUMN "legacy"', 'Drops column rounds.legacy'],
    ['ALTER TABLE "rounds" ALTER COLUMN "status" SET NOT NULL', 'Makes rounds.status NOT NULL'],
    [
      'ALTER TABLE "rounds" ALTER COLUMN "status" SET DATA TYPE text',
      'Changes the type of rounds.status',
    ],
    ['ALTER TABLE "rounds" ADD CONSTRAINT "k" UNIQUE("status")', 'Adds a UNIQUE constraint'],
    ['ALTER TABLE "rounds" ADD CONSTRAINT "c" CHECK ("id" > 0)', 'Adds a CHECK constraint'],
    ['CREATE UNIQUE INDEX "k" ON "rounds" ("status")', 'Adds a unique index to table rounds'],
    ['DROP TYPE "round_status"', 'Drops type round_status'],
  ])('fails %s outside a post-deploy migration, and passes it in one', (sql, what) => {
    const problems = judge('20270101000000_contract', sql);

    expect(problems).toEqual([
      {
        migration: '20270101000000_contract',
        statement: sql,
        reason: expect.stringContaining(what),
      },
    ]);
    expect(problems[0]?.reason).toContain('Move it into a _postdeploy migration');
    expect(judge('20270101000000_contract_postdeploy', sql)).toEqual([]);
  });

  it('fails a NOT NULL column without a default on a table on main, in either phase', () => {
    const sql = 'ALTER TABLE "rounds" ADD COLUMN "notes" text NOT NULL';

    for (const name of ['20270101000000_notes', '20270101000000_notes_postdeploy']) {
      const [problem] = judge(name, sql);

      expect(problem?.reason).toContain('Adds NOT NULL column rounds.notes without a default');
      expect(problem?.reason).toContain(
        'Add it with a DEFAULT, or add it nullable and SET NOT NULL in a _postdeploy migration',
      );
    }
  });

  it('passes a NOT NULL column with a default, or a nullable one', () => {
    expect(
      judge(
        '20270101000000_notes',
        'ALTER TABLE "rounds" ADD COLUMN "notes" text DEFAULT \'\' NOT NULL;--> statement-breakpoint\n' +
          'ALTER TABLE "rounds" ADD COLUMN "more" text;',
      ),
    ).toEqual([]);
  });

  it.each([
    'ALTER TABLE "notes" RENAME TO "memos"',
    'ALTER TABLE "rounds" RENAME COLUMN "notes" TO "memo"',
    'DROP TABLE "notes"',
    'ALTER TABLE "rounds" DROP COLUMN "notes"',
    'ALTER TABLE "notes" ALTER COLUMN "body" SET NOT NULL',
    'ALTER TABLE "rounds" ALTER COLUMN "notes" SET DATA TYPE text',
    'ALTER TABLE "notes" ADD CONSTRAINT "k" UNIQUE("body")',
    'ALTER TABLE "notes" ADD CONSTRAINT "c" CHECK ("body" <> \'\')',
    'CREATE UNIQUE INDEX "k" ON "notes" ("body")',
    'DROP TYPE "note_kind"',
    'ALTER TABLE "notes" ADD COLUMN "body" text NOT NULL',
  ])('passes %s on what a new migration created, not main', (sql) => {
    expect(judge('20270101000000_notes', sql)).toEqual([]);
  });

  it('passes statements it does not recognize: it enforces only what it lists', () => {
    expect(
      judge(
        '20270101000000_backfill',
        'UPDATE "rounds" SET "legacy" = NULL;--> statement-breakpoint\nTRUNCATE "rounds";',
      ),
    ).toEqual([]);
  });

  it('names every problem by migration, in order', () => {
    const problems = judgeMigrations(
      [
        { name: '20270102000000_second', sql: 'DROP TYPE "round_status";' },
        { name: '20270101000000_first', sql: 'DROP TABLE "rounds";' },
      ],
      main,
    );

    expect(problems.map((problem) => problem.migration)).toEqual([
      '20270101000000_first',
      '20270102000000_second',
    ]);
  });
});

async function databaseExists(name: string) {
  const admin = new pg.Client({ connectionString: sharedTestDatabase });

  await admin.connect();

  try {
    const { rowCount } = await admin.query('select 1 from pg_database where datname = $1', [name]);

    return rowCount === 1;
  } finally {
    await admin.end();
  }
}

describe('withScratchDatabase', () => {
  const name = scratchDatabaseName(sharedTestDatabase);

  it('is named after the test database and the process', () => {
    expect(name).toBe(
      `${new URL(sharedTestDatabase).pathname.slice(1)}_migration_check_${process.pid}`,
    );
  });

  it('creates the database for the run and drops it after', async () => {
    const seen = await withScratchDatabase(sharedTestDatabase, async (url) => {
      expect(await databaseExists(name)).toBe(true);

      return new URL(url).pathname.slice(1);
    });

    expect(seen).toBe(name);
    expect(await databaseExists(name)).toBe(false);
  });

  it('drops it when the run fails', async () => {
    await expect(
      withScratchDatabase(sharedTestDatabase, async () => {
        throw new Error('check failed');
      }),
    ).rejects.toThrow('check failed');
    expect(await databaseExists(name)).toBe(false);
  });

  it('waits for a connection still closing before it drops the database', async () => {
    const errors: Error[] = [];
    let ended: Promise<void> = Promise.resolve();

    await withScratchDatabase(sharedTestDatabase, async (url) => {
      const client = new pg.Client({ connectionString: url });

      client.on('error', (error) => errors.push(error));
      await client.connect();
      // Closes a moment after the run returns, as a client a pool destroyed can.
      ended = new Promise((resolve) => setTimeout(resolve, 300)).then(() => client.end());
    });

    await ended;
    expect(errors).toEqual([]);
    expect(await databaseExists(name)).toBe(false);
  });
});

describe('closePool', () => {
  it('resolves only once every connection has closed', async () => {
    const applicationName = `roundtable-close-pool-${process.pid}`;
    const { pool } = createDb(Redacted.make(sharedTestDatabase), applicationName);
    const held = await Promise.all([pool.connect(), pool.connect()]);

    for (const client of held) client.release();

    await closePool(pool);

    const admin = new pg.Client({ connectionString: sharedTestDatabase });

    await admin.connect();

    try {
      const { rowCount } = await admin.query(
        'select 1 from pg_stat_activity where application_name = $1',
        [applicationName],
      );

      expect(rowCount).toBe(0);
    } finally {
      await admin.end();
    }
  });
});

describe('the real migrations, each judged as new against the ones before it', () => {
  const real = readdirSync(migrationsFolder).toSorted();

  let folders = 0;

  /** A folder linking to every real migration before `name`: `main` when `name` is new. */
  function before(name: string) {
    const folder = join(fixtureRoot, `before-${folders++}`);

    mkdirSync(folder);

    for (const entry of real.filter((other) => other < name))
      symlinkSync(join(migrationsFolder, entry), join(folder, entry));

    return folder;
  }

  /** Applies the migrations in `folder` to a scratch database and reads the schema they build. */
  function schemaOf(folder: string) {
    return withScratchDatabase(sharedTestDatabase, async (url) => {
      const { db, pool } = createDb(Redacted.make(url), 'roundtable-migration-check-test');

      try {
        await runMigrations(db, undefined, folder);

        return await readSchema(pool);
      } finally {
        await closePool(pool);
      }
    });
  }

  async function judgeReal(name: string, as = name) {
    const schema = await schemaOf(before(name));
    const sql = readFileSync(join(migrationsFolder, name, 'migration.sql'), 'utf8');

    return judgeMigrations([{ name: as, sql }], schema);
  }

  it('passes personas: new tables, and a unique index on one of them', async () => {
    expect(await judgeReal('20261126162813_personas')).toEqual([]);
  });

  it('fails drop_screening_status, and passes it named _postdeploy', async () => {
    const name = '20261123064959_drop_screening_status';
    const problems = await judgeReal(name);

    expect(problems.map((problem) => problem.statement)).toEqual([
      'ALTER TABLE "applications" ALTER COLUMN "status" SET DATA TYPE text',
      'DROP TYPE "application_status"',
      'ALTER TABLE "applications" ALTER COLUMN "status" SET DATA TYPE "application_status" USING "status"::"application_status"',
    ]);
    expect(await judgeReal(name, `${name}_postdeploy`)).toEqual([]);
  });
});

describe('checkMigrations', () => {
  let repos = 0;

  /** A git repository whose `main` branch has `merged`; the migrations live in `apps/api/drizzle`. */
  function repository(merged: Record<string, string>) {
    const root = join(fixtureRoot, `repo-${repos++}`);
    const folder = join(root, 'apps', 'api', 'drizzle');

    const git = (...args: string[]) =>
      execFileSync(
        'git',
        ['-C', root, '-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args],
        { stdio: 'pipe' },
      );

    const add = (name: string, sql: string) => {
      mkdirSync(join(folder, name), { recursive: true });
      writeFileSync(join(folder, name, 'migration.sql'), sql);
    };

    mkdirSync(folder, { recursive: true });
    git('init', '-q', '-b', 'main');
    writeFileSync(join(root, 'README.md'), 'fixture\n');

    for (const [name, sql] of Object.entries(merged)) add(name, sql);

    git('add', '.');
    git('commit', '-q', '-m', 'main');
    git('switch', '-q', '-c', 'feature');

    return {
      folder,
      add,
      commit: () => {
        git('add', '.');
        git('commit', '-q', '-m', 'feature');
      },
    };
  }

  const createRounds = 'CREATE TABLE "rounds" ("id" serial PRIMARY KEY, "legacy" text);';

  function check(folder: string, ref = 'main') {
    return checkMigrations({ folder, ref, testDatabaseUrl: sharedTestDatabase });
  }

  it('passes quickly, saying so, when nothing is new', async () => {
    const { folder } = repository({ '20270101000000_create_rounds': createRounds });

    expect(await check(folder)).toEqual({
      code: 0,
      output: 'Migration check: no new migrations since main.',
    });
  });

  it('never judges a merged migration, even one that would fail', async () => {
    const { folder, add } = repository({
      '20270101000000_create_rounds': createRounds,
      '20270102000000_drop_legacy': 'ALTER TABLE "rounds" DROP COLUMN "legacy";',
    });

    add('20270103000000_add_notes', 'ALTER TABLE "rounds" ADD COLUMN "notes" text;');

    expect(await check(folder)).toEqual({
      code: 0,
      output:
        "Migration check: 1 new migration, nothing the previous release can't live with, " +
        'and the deploy applies them pre then post.',
    });
  });

  it('judges new migrations, committed or not, against the schema main builds', async () => {
    const { folder, add, commit } = repository({ '20270101000000_create_rounds': createRounds });

    add('20270102000000_drop_legacy', 'ALTER TABLE "rounds" DROP COLUMN "legacy";');
    commit();
    add('20270103000000_rename_rounds', 'ALTER TABLE "rounds" RENAME TO "stages";');

    const result = await check(folder);

    expect(result.code).toBe(1);
    expect(result.output).toContain('2 problems in 2 new migrations');
    expect(result.output).toContain(
      [
        '20270102000000_drop_legacy:',
        '  ALTER TABLE "rounds" DROP COLUMN "legacy"',
        '  Drops column rounds.legacy, which the previous release still uses. Move it into a _postdeploy migration',
      ].join('\n'),
    );
    expect(result.output).toContain(
      ['20270103000000_rename_rounds:', '  ALTER TABLE "rounds" RENAME TO "stages"'].join('\n'),
    );
  });

  it('applies main as the repository has it, not as the branch does', async () => {
    const { folder, add } = repository({ '20270101000000_create_rounds': createRounds });

    // The branch's copy no longer creates `legacy`: main's does, so dropping it still fails.
    add('20270101000000_create_rounds', 'CREATE TABLE "rounds" ("id" serial PRIMARY KEY);');
    add('20270102000000_drop_legacy', 'ALTER TABLE "rounds" DROP COLUMN IF EXISTS "legacy";');

    expect((await check(folder)).code).toBe(1);
  });

  describe("the deploy's replay", () => {
    const scratch = scratchDatabaseName(sharedTestDatabase);

    const createRequired =
      'CREATE TABLE "rounds" ("id" serial PRIMARY KEY, "required" text NOT NULL);';

    it('fails a pre-deploy migration that depends on a pending post-deploy one', async () => {
      const { folder, add } = repository({ '20270101000000_create_rounds': createRounds });

      add('20270102000000_drop_legacy_postdeploy', 'ALTER TABLE "rounds" DROP COLUMN "legacy";');
      add('20270103000000_legacy_again', 'ALTER TABLE "rounds" ADD COLUMN "legacy" integer;');

      const result = await check(folder);

      expect(result.code).toBe(1);
      expect(result.output).toContain(
        [
          '20270103000000_legacy_again:',
          '  ALTER TABLE "rounds" ADD COLUMN "legacy" integer',
          '  Fails in the pre phase of the deploy\'s replay: column "legacy" of relation "rounds" already exists.',
        ].join('\n'),
      );
      expect(result.output).toContain('make it post-deploy too');
      expect(result.output).toContain('stop reusing a name a post-deploy migration drops');
      expect(await databaseExists(scratch)).toBe(false);
    });

    it('names every pending migration with the failed statement, not just the first', async () => {
      const { folder, add } = repository({ '20270101000000_create_rounds': createRounds });
      const addNotes = 'ALTER TABLE "rounds" ADD COLUMN "notes" integer;';

      // Pre runs add_notes, then notes_again, which fails: the same statement is in both.
      add('20270102000000_add_notes', addNotes);
      add('20270103000000_drop_notes_postdeploy', 'ALTER TABLE "rounds" DROP COLUMN "notes";');
      add('20270104000000_notes_again', addNotes);

      const result = await check(folder);

      expect(result.code).toBe(1);
      expect(result.output).toContain(
        [
          'one of 20270102000000_add_notes, 20270104000000_notes_again:',
          '  ALTER TABLE "rounds" ADD COLUMN "notes" integer',
          '  Fails in the pre phase of the deploy\'s replay: column "notes" of relation "rounds" already exists.',
        ].join('\n'),
      );
      expect(await databaseExists(scratch)).toBe(false);
    });

    it.each([
      [
        'pre',
        'one of 20270102000000_add_notes, 20270104000000_notes_again',
        {
          '20270102000000_add_notes': 'ALTER TABLE "rounds" ADD COLUMN "notes" integer;',
          '20270103000000_drop_notes_postdeploy': 'ALTER TABLE "rounds" DROP COLUMN "notes";',
          '20270104000000_notes_again': 'ALTER TABLE "rounds" ADD COLUMN "notes" integer;',
        },
      ],
      [
        'post',
        '20270102000000_drop_missing_postdeploy',
        { '20270102000000_drop_missing_postdeploy': 'ALTER TABLE "rounds" DROP COLUMN "missing";' },
      ],
    ] as const)(
      'names the migrations and phase the deploy entry names (%s)',
      async (phase, named, added) => {
        const merged = { '20270101000000_create_rounds': createRounds };
        const { folder, add } = repository(merged);

        for (const [name, sql] of Object.entries(added)) add(name, sql);

        const { output } = await check(folder);

        // The deploy on a database main built: the entry runs pre, then post.
        const entry = await withScratchDatabase(sharedTestDatabase, async (url) => {
          const mainOnly = join(fixtureRoot, `main-only-${repos}`);

          mkdirSync(join(mainOnly, '20270101000000_create_rounds'), { recursive: true });
          writeFileSync(
            join(mainOnly, '20270101000000_create_rounds', 'migration.sql'),
            createRounds,
          );

          await runMigrateCommand([], Redacted.make(url), mainOnly);

          const pre = await runMigrateCommand(['pre'], Redacted.make(url), folder);

          return pre.code === 1 ? pre : runMigrateCommand(['post'], Redacted.make(url), folder);
        });

        expect(entry.output).toMatch(new RegExp(`^Migration ${named} failed: `));
        expect(output).toContain(`\n${named}:\n  ALTER TABLE`);
        expect(output).toContain(`Fails in the ${phase} phase of the deploy's replay`);
      },
    );

    it('fails a post-deploy drop of a column still NOT NULL without a default after pre', async () => {
      const { folder, add } = repository({ '20270101000000_create_rounds': createRequired });

      add(
        '20270102000000_drop_required_postdeploy',
        'ALTER TABLE "rounds" DROP COLUMN "required";',
      );

      const result = await check(folder);

      expect(result.code).toBe(1);
      expect(result.output).toContain(
        [
          '20270102000000_drop_required_postdeploy:',
          '  ALTER TABLE "rounds" DROP COLUMN "required"',
          '  Drops column rounds.required, which after the pre phase is still NOT NULL without a default',
        ].join('\n'),
      );
      expect(result.output).toContain(
        'Make it nullable (DROP NOT NULL) or give it a default in a pre-deploy migration first.',
      );
    });

    it.each([
      ['drops its NOT NULL', 'ALTER TABLE "rounds" ALTER COLUMN "required" DROP NOT NULL;'],
      ['gives it a default', 'ALTER TABLE "rounds" ALTER COLUMN "required" SET DEFAULT \'\';'],
    ])('passes that drop when a pre-deploy migration %s first', async (_, sql) => {
      const { folder, add } = repository({ '20270101000000_create_rounds': createRequired });

      add('20270102000000_relax_required', sql);
      add(
        '20270103000000_drop_required_postdeploy',
        'ALTER TABLE "rounds" DROP COLUMN "required";',
      );

      expect(await check(folder)).toEqual({
        code: 0,
        output:
          "Migration check: 2 new migrations, nothing the previous release can't live with, " +
          'and the deploy applies them pre then post.',
      });
      expect(await databaseExists(scratch)).toBe(false);
    });

    it('fails an error in the post phase, naming the migration and the phase', async () => {
      const { folder, add } = repository({ '20270101000000_create_rounds': createRounds });

      add('20270102000000_drop_missing_postdeploy', 'ALTER TABLE "rounds" DROP COLUMN "missing";');

      const result = await check(folder);

      expect(result.code).toBe(1);
      expect(result.output).toContain(
        [
          '20270102000000_drop_missing_postdeploy:',
          '  ALTER TABLE "rounds" DROP COLUMN "missing"',
          '  Fails in the post phase of the deploy\'s replay: column "missing" of relation "rounds" does not exist.',
        ].join('\n'),
      );
      expect(await databaseExists(scratch)).toBe(false);
    });

    it('runs post after pre, so a post-deploy migration sees what pre added', async () => {
      const { folder, add } = repository({ '20270101000000_create_rounds': createRounds });

      // Sorted by name, the post-deploy migration comes first; the deploy still runs it last.
      add('20270102000000_drop_notes_postdeploy', 'ALTER TABLE "rounds" DROP COLUMN "notes";');
      add('20270103000000_add_notes', 'ALTER TABLE "rounds" ADD COLUMN "notes" text;');

      expect((await check(folder)).code).toBe(0);
    });
  });

  it('fails, saying to fetch it, when the ref can not be read', async () => {
    const { folder } = repository({ '20270101000000_create_rounds': createRounds });

    const failure = check(folder, 'origin/main');

    await expect(failure).rejects.toBeInstanceOf(UnreadableRef);
    await expect(failure).rejects.toThrow('git fetch origin main');
  });
});
