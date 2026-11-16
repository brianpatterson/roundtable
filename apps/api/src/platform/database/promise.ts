import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Context, Effect, Layer, Redacted } from 'effect';
import pg from 'pg';

export type Db = NodePgDatabase;

/** Every connection the API opens says so, in pg_stat_activity (the App's lifecycle test). */
export const APPLICATION_NAME = 'roundtable-api';

/**
 * The URL holds the database password, so it arrives `Redacted` and is unwrapped only here.
 * `applicationName` labels the connections; only the tests' own admin pool changes it.
 */
export function createDb(url: Redacted.Redacted<string>, applicationName = APPLICATION_NAME) {
  const pool = new pg.Pool({
    connectionString: Redacted.value(url),
    application_name: applicationName,
  });

  // paramsInErrors: failed queries carry their values inside the process, so error reports can
  // show each value's kind (uuid, string(32), null). redact.ts strips the values themselves
  // before anything is logged or sent (ADR-0022), and the leak tests check that.
  return { db: drizzle({ client: pool, paramsInErrors: true }), pool };
}

/**
 * The Promise-based Drizzle, for Better Auth (ADR-0022 keeps it at the Promise edge), as a
 * scoped resource: its pool closes when the layer is released.
 */
export class PromiseDatabase extends Context.Service<PromiseDatabase, Db>()(
  'roundtable/PromiseDatabase',
) {
  static readonly layer = (url: Redacted.Redacted<string>) =>
    Layer.effect(
      PromiseDatabase,
      Effect.acquireRelease(
        Effect.sync(() => createDb(url)),
        ({ pool }) => Effect.promise(() => pool.end()),
      ).pipe(Effect.map(({ db }) => db)),
    );
}
