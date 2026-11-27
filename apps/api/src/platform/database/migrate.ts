import { DrizzleQueryError } from 'drizzle-orm/errors';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Option, Schema } from 'effect';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { causeChain, describeError, postgresFields } from '../observability/redact.js';
import type { Db } from './promise.js';

// In the bundled production image the SQL files sit next to dist/, so the path is configurable.
export const migrationsFolder =
  process.env.MIGRATIONS_FOLDER ?? fileURLToPath(new URL('../../../drizzle', import.meta.url));

/**
 * A deploy's two phases (ADR-0073): `pre` runs before the new release starts and skips the
 * post-deploy migrations; `post` runs once the release is healthy and applies everything pending.
 */
export const phases = ['pre', 'post'] as const;

export type Phase = (typeof phases)[number];

/** The single home of the rule: a migration is post-deploy when its folder name ends so. */
export function isPostDeploy(name: string) {
  return name.endsWith('_postdeploy');
}

/** A migration folder's name and its `migration.sql`. */
export interface Migration {
  readonly name: string;
  readonly sql: string;
}

/**
 * The statements of a `migration.sql`, as the migration runner and the migration check both read
 * them: split where drizzle-kit writes `--> statement-breakpoint` (as Drizzle splits them to run
 * them), without comment lines, surrounding space or the trailing semicolon, and none empty.
 */
export function splitStatements(sql: string): string[] {
  return sql
    .split('--> statement-breakpoint')
    .map((part) =>
      part
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n')
        .trim()
        .replace(/;\s*$/, '')
        .trim(),
    )
    .filter((statement) => statement !== '');
}

/** The migrations in `folder` on disk, committed or not, by name: what Drizzle would apply. */
export async function readMigrations(folder: string): Promise<Migration[]> {
  const entries = await readdir(folder, { withFileTypes: true });

  const migrations = await Promise.all(
    entries
      .filter(
        (entry) => entry.isDirectory() && existsSync(join(folder, entry.name, 'migration.sql')),
      )
      .map(async (entry) => ({
        name: entry.name,
        sql: await readFile(join(folder, entry.name, 'migration.sql'), 'utf8'),
      })),
  );

  return migrations.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * `the_one`, or `one of a, b` when a failed statement is in more than one migration (add, drop,
 * add again) and only its SQL says which failed; `undefined` for none.
 */
export function migrationLabel(names: readonly string[]): string | undefined {
  const [only, ...others] = names;

  if (only === undefined) return undefined;

  return others.length === 0 ? only : `one of ${names.join(', ')}`;
}

/** A failure's own code: Postgres's SQLSTATE, or Node's (`ECONNREFUSED`). Nothing else is read. */
const readCode = Schema.decodeUnknownOption(Schema.Struct({ code: Schema.String }));

/**
 * What is safe to say about a failure in public: the innermost error's message (values a data
 * exception quotes removed, Drizzle's query params redacted) and its code. Never Postgres's
 * `detail`, `where` or `hint`, which quote the rows that broke a constraint ("Key (email)=(…)").
 * When Drizzle's error has no cause, its message is the innermost, so the reason carries the
 * failed statement's SQL: that's the migration's own text, already public in the repo.
 */
export function safeReason(error: Error): { readonly reason: string; readonly code?: string } {
  const innermost = causeChain(error).at(-1) ?? error;
  const reason = describeError(innermost).message || innermost.name;
  const code = postgresFields(error)?.code ?? Option.getOrUndefined(readCode(innermost))?.code;

  return code === undefined ? { reason } : { reason, code };
}

/**
 * A statement of a pending migration failed. Drizzle runs every pending migration in one
 * transaction and says only which statement failed, so `migrations` names each pending one that
 * holds it (none when it's Drizzle's own bookkeeping). It carries only what `safeReason` keeps,
 * not the database's error, so it can be printed or logged anywhere: its message is the migrate
 * entry's one public line.
 */
export class MigrationFailed extends Error {
  readonly migrations: readonly string[];
  readonly phase: Phase | undefined;
  /** The failed statement, as `splitStatements` reads it. */
  readonly statement: string;
  /** The redacted message of the database's error. */
  readonly reason: string;
  /** The SQLSTATE, when there is one. */
  readonly code: string | undefined;

  constructor(error: DrizzleQueryError, pending: readonly Migration[], phase: Phase | undefined) {
    const statement = splitStatements(error.query)[0] ?? error.query.trim();

    const migrations = pending.flatMap((migration) =>
      splitStatements(migration.sql).includes(statement) ? [migration.name] : [],
    );

    const { reason, code } = safeReason(error);
    const label = migrationLabel(migrations);

    super(
      [
        label === undefined ? 'Migrations failed: ' : `Migration ${label} failed: `,
        reason,
        code === undefined ? '' : ` (code ${code})`,
      ].join(''),
    );

    this.name = 'MigrationFailed';
    this.migrations = migrations;
    this.phase = phase;
    this.statement = statement;
    this.reason = reason;
    this.code = code;
  }
}

/**
 * Migrations that wait on a busy table fail fast instead of queueing every request behind their
 * lock, and none outlasts the deploy's 90-second health check. Only a deploy's phases set them.
 */
const timeouts = ["set lock_timeout = '5s'", "set statement_timeout = '60s'"];

/** The pool's `db` from `createDb`: the run pins one of its connections. */
export type MigrationDb = Db & { $client: pg.Pool };

/**
 * Applies the migrations in `folder` that the database hasn't recorded, and throws
 * `MigrationFailed` when one of their statements fails (nothing is applied then: it's one
 * transaction). With no phase it runs them all, as it always has. `pre` skips the post-deploy
 * ones, and a later `post` applies them, after any migration `pre` ran since (ADR-0073). The
 * phases run with lock and statement timeouts.
 */
export async function runMigrations(
  db: MigrationDb,
  phase?: Phase,
  folder: string = migrationsFolder,
): Promise<void> {
  const local = await readMigrations(folder);

  // One connection, so the timeouts apply to the migrations' transaction. It's discarded after,
  // rather than returned to the pool with them.
  const client = await db.$client.connect();

  try {
    if (phase !== undefined) for (const statement of timeouts) await client.query(statement);

    const applied = await appliedMigrations(client);

    const pending = local.filter(
      (migration) =>
        !applied.has(migration.name) && (phase !== 'pre' || !isPostDeploy(migration.name)),
    );

    const pinned = drizzle({ client });

    try {
      if (phase === 'pre')
        await withPreDeployFolder(folder, (pre) => migrate(pinned, { migrationsFolder: pre }));
      else await migrate(pinned, { migrationsFolder: folder });
    } catch (error) {
      throw error instanceof DrizzleQueryError ? new MigrationFailed(error, pending, phase) : error;
    }
  } finally {
    client.release(true);
  }
}

/**
 * The migrations Drizzle has recorded as applied, by folder name. Drizzle applies every folder
 * whose name isn't there, so the rest are pending. A database Drizzle hasn't touched has none.
 */
async function appliedMigrations(client: pg.PoolClient): Promise<ReadonlySet<string>> {
  const { rowCount } = await client.query(
    `select 1 from information_schema.columns
      where table_schema = 'drizzle' and table_name = '__drizzle_migrations' and column_name = 'name'`,
  );

  if (rowCount === 0) return new Set();

  const { rows } = await client.query<{ name: string | null }>(
    'select name from drizzle.__drizzle_migrations',
  );

  return new Set(rows.flatMap((row) => (row.name === null ? [] : [row.name])));
}

/**
 * Calls `use` with a fresh temporary folder of absolute symlinks to every migration in `folder`
 * that isn't post-deploy (Drizzle reads a folder, not a list), and removes it afterwards.
 */
async function withPreDeployFolder<A>(folder: string, use: (pre: string) => Promise<A>) {
  const pre = await mkdtemp(join(tmpdir(), 'roundtable-pre-migrations-'));

  try {
    for (const entry of await readdir(folder)) {
      if (!isPostDeploy(entry)) await symlink(resolve(folder, entry), join(pre, entry));
    }

    return await use(pre);
  } finally {
    await rm(pre, { recursive: true, force: true });
  }
}
