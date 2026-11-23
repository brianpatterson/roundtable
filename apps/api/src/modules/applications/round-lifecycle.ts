// The Round lifecycle: what a change to an Application or its Rounds sets off (Outcome inference,
// GLOSSARY.md, ADR-0061). The handlers make the change and call this in the same transaction; the
// rules themselves are the pure ones in ./inference.ts, which this feeds the Rounds in the order
// they expect.
import { and, asc, eq, inArray } from 'drizzle-orm';
import { Effect } from 'effect';
import type { ApplicationStatus } from '@roundtable/contract';
import type { Database } from '../../platform/database/effect.js';
import { INFERABLE, failedByRejection } from './inference.js';
import { rounds } from './schema.js';

/** A transaction of the Effect `Database`. */
export type Transaction = Parameters<Parameters<Database['Service']['transaction']>[0]>[0];

/** The day rule's time zone when the request sends none. */
const DEFAULT_TIME_ZONE = 'UTC';

/**
 * Sets the inferred `outcome` on the Rounds `ids`, in the transaction `tx` that made the change
 * it follows from. The guard is the same rule the pure ones use, so a Round whose Outcome the user
 * set keeps it, even one set since it was read.
 */
export const inferOutcomes = (
  tx: Transaction,
  ids: readonly string[],
  outcome: 'passed' | 'failed',
) =>
  ids.length === 0
    ? Effect.void
    : tx
        .update(rounds)
        .set({ outcome })
        .where(
          and(
            inArray(rounds.id, [...ids]),
            eq(rounds.outcome, INFERABLE.outcome),
            eq(rounds.outcomeSetByUser, INFERABLE.outcomeSetByUser),
          ),
        )
        .pipe(Effect.asVoid);

/**
 * What an Application's status change sets off, in the transaction `tx` that made it, holding its
 * row: a change to rejected fails its latest pending Rounds, unless the user set their Outcome.
 * Setting rejected again, or any other status, changes nothing. `timeZone` is the user's, for the
 * day rule; without one the day is UTC's.
 */
export const statusChanged = (
  tx: Transaction,
  before: { readonly status: ApplicationStatus },
  after: { readonly id: string; readonly status: ApplicationStatus },
  timeZone: string = DEFAULT_TIME_ZONE,
) =>
  Effect.gen(function* () {
    if (after.status !== 'rejected' || before.status === 'rejected') return;

    // In the order they were added, as `failedByRejection` requires.
    const its = yield* tx
      .select()
      .from(rounds)
      .where(eq(rounds.applicationId, after.id))
      .orderBy(asc(rounds.createdAt), asc(rounds.id));

    yield* inferOutcomes(tx, failedByRejection(its, timeZone), 'failed');
  });
