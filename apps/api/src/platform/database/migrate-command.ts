import type { Redacted } from 'effect';
import { MigrationFailed, migrationsFolder, phases, runMigrations, safeReason } from './migrate.js';
import type { Phase } from './migrate.js';
import { createDb } from './promise.js';

export const usage = 'Usage: migrate.js [pre|post]';

/**
 * The phase the arguments ask for: `undefined` runs everything (dev, tests, `pnpm db:migrate`),
 * and `false` means the arguments make no sense.
 */
function parsePhase(args: readonly string[]): Phase | undefined | false {
  if (args.length === 0) return undefined;

  const [arg] = args;
  const phase = phases.find((known) => known === arg);

  return args.length === 1 && phase !== undefined ? phase : false;
}

export interface CommandResult {
  /** The process's exit code: 1 when the arguments are wrong or the run failed. */
  readonly code: 0 | 1;
  readonly output: string;
}

/**
 * The migrate entry (`migrate.js [pre|post]`), without the process: reads the phase, runs it on
 * `databaseUrl`, and says what happened in one line. The deploy log that shows a failure is
 * public, so a failure is only `MigrationFailed`'s line (the migration, the redacted message and
 * the code), or the same safe fields of an error outside a statement (#275).
 */
export async function runMigrateCommand(
  args: readonly string[],
  databaseUrl: Redacted.Redacted<string>,
  folder: string = migrationsFolder,
): Promise<CommandResult> {
  const phase = parsePhase(args);

  if (phase === false) return { code: 1, output: usage };

  const { db, pool } = createDb(databaseUrl);

  try {
    await runMigrations(db, phase, folder);
  } catch (error) {
    if (error instanceof MigrationFailed) return { code: 1, output: error.message };

    if (!(error instanceof Error)) return { code: 1, output: 'Migrations failed' };

    const { reason, code } = safeReason(error);

    return {
      code: 1,
      output: `Migrations failed: ${reason}${code === undefined ? '' : ` (code ${code})`}`,
    };
  } finally {
    await pool.end();
  }

  return {
    code: 0,
    output: phase === undefined ? 'Migrations applied' : `Migrations applied (${phase})`,
  };
}
