import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { mkdtemp, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
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

export const usage = 'Usage: migrate.js [pre|post]';

/**
 * The phase the migrate entry was asked for: `undefined` runs everything (dev, tests,
 * `pnpm db:migrate`), and `false` means the arguments make no sense.
 */
export function parsePhase(args: readonly string[]): Phase | undefined | false {
  if (args.length === 0) return undefined;

  const [arg] = args;
  const phase = phases.find((known) => known === arg);

  return args.length === 1 && phase !== undefined ? phase : false;
}

/** The single home of the rule: a migration is post-deploy when its folder name ends so. */
export function isPostDeploy(name: string) {
  return name.endsWith('_postdeploy');
}

/**
 * Migrations that wait on a busy table fail fast instead of queueing every request behind their
 * lock, and none outlasts the deploy's 90-second health check. Only a deploy's phases set them.
 */
const timeouts = ["set lock_timeout = '5s'", "set statement_timeout = '60s'"];

/** The pool's `db` from `createDb`: a phase pins one of its connections to set the timeouts. */
export type MigrationDb = Db & { $client: pg.Pool };

/**
 * Applies the pending migrations in `folder`. With no phase it runs them all, as it always has.
 * Drizzle applies every folder whose name it hasn't recorded, so `pre` hides the post-deploy ones
 * and a later `post` applies them, after any migration `pre` ran since (ADR-0073).
 */
export async function runMigrations(
  db: MigrationDb,
  phase?: Phase,
  folder: string = migrationsFolder,
) {
  if (phase === undefined) {
    await migrate(db, { migrationsFolder: folder });

    return;
  }

  // One connection, so the timeouts apply to the migrations' transaction. It's discarded after,
  // rather than returned to the pool with them.
  const client = await db.$client.connect();

  try {
    for (const statement of timeouts) await client.query(statement);

    const guarded = drizzle({ client });

    if (phase === 'post') await migrate(guarded, { migrationsFolder: folder });
    else await withPreDeployFolder(folder, (pre) => migrate(guarded, { migrationsFolder: pre }));
  } finally {
    client.release(true);
  }
}

/**
 * Calls `use` with a fresh temporary folder of absolute symlinks to every migration in `folder`
 * that isn't post-deploy (Drizzle reads a folder, not a list), and removes it afterwards.
 */
export async function withPreDeployFolder<A>(
  folder: string,
  use: (pre: string) => Promise<A>,
): Promise<A> {
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
