// Prep (GLOSSARY.md): a Round's notes and prep tasks. Every Round the API answers carries its prep
// tasks, so the handlers and the Agenda load them here, for any number of Rounds in one query.
import { asc, inArray } from 'drizzle-orm';
import { Effect } from 'effect';
import type { PrepTask } from '@roundtable/contract';
import type { Database } from '../../platform/database/effect.js';
import type { Transaction } from './round-lifecycle.js';
import { prepTasks } from './schema.js';

/** The columns a prep task has in the contract: the rest stay inside the module. */
const prepTaskColumns = {
  id: prepTasks.id,
  title: prepTasks.title,
  skillId: prepTasks.skillId,
  completedAt: prepTasks.completedAt,
};

/**
 * The prep tasks of the Rounds `roundIds`, by Round, each Round's in the order they were added: one
 * query, whatever the number of Rounds. A Round without any isn't in the map. The caller has
 * checked the Rounds are the user's.
 */
export const prepTasksOf = (
  db: Database['Service'] | Transaction,
  roundIds: readonly string[],
): Effect.Effect<ReadonlyMap<string, PrepTask[]>> =>
  roundIds.length === 0
    ? Effect.succeed(new Map())
    : db
        .select({ ...prepTaskColumns, roundId: prepTasks.roundId })
        .from(prepTasks)
        .where(inArray(prepTasks.roundId, [...roundIds]))
        .orderBy(asc(prepTasks.roundId), asc(prepTasks.position))
        .pipe(
          Effect.orDie,
          Effect.map((rows) => {
            const byRound = new Map<string, PrepTask[]>();

            for (const { roundId, ...task } of rows) {
              byRound.set(roundId, [...(byRound.get(roundId) ?? []), task]);
            }

            return byRound;
          }),
        );

/** `rounds`, each with its prep tasks: one query for all of them. */
export const withPrepTasks = <R extends { readonly id: string }>(
  db: Database['Service'] | Transaction,
  rounds: readonly R[],
) =>
  prepTasksOf(
    db,
    rounds.map((round) => round.id),
  ).pipe(
    Effect.map((byRound) =>
      rounds.map((round) => ({ ...round, prepTasks: byRound.get(round.id) ?? [] })),
    ),
  );
