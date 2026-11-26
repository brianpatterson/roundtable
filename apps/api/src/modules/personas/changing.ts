import { sql } from 'drizzle-orm';
import { Effect } from 'effect';
import type { Database } from '../../platform/database/effect.js';

/** A transaction on the Database, as `Database.transaction` hands it to its callback. */
export type Transaction = Parameters<Parameters<Database['Service']['transaction']>[0]>[0];

/**
 * A transaction that changes the user's Skills or Personas (`lock` says which), holding that
 * lock for the user: two requests at once can't both pass a limit, or both take one name (which
 * would be a unique violation, a 500). Database failures are defects.
 */
export const changing = <A, E>(
  db: Database['Service'],
  lock: 'skills' | 'personas',
  userId: string,
  change: (tx: Transaction) => Effect.Effect<A, E>,
) =>
  db
    .transaction((tx) =>
      Effect.gen(function* () {
        yield* tx
          .execute(sql`select pg_advisory_xact_lock(hashtext(${lock}), hashtext(${userId}))`)
          .pipe(Effect.orDie);

        return yield* change(tx);
      }),
    )
    .pipe(Effect.catchTag('SqlError', Effect.die));
