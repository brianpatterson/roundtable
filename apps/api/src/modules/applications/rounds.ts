// Round access: how the applications module reaches "a Round the user owns" and answers one. Every
// endpoint under a Round's path goes through `changeRound` or `deleteRound`, so tenancy, the row
// lock and the Round 404 rule live here once; every Round the API answers, the Agenda's included,
// gets its prep tasks (Prep, GLOSSARY.md) from `withPrepTasks`. createRound locks the Application
// instead, and answers its new Round through `withPrepTasks` too.
import { and, asc, eq, inArray } from 'drizzle-orm';
import { Effect } from 'effect';
import { CurrentUser, RoundNotFound, type PrepTask } from '@roundtable/contract';
import type { Database } from '../../platform/database/effect.js';
import type { Transaction } from './round-lifecycle.js';
import { applications, prepTasks, rounds } from './schema.js';

/** The Effect `Database`, or one of its transactions. */
type Db = Database['Service'] | Transaction;

/** A Round as its table holds it. */
export type RoundRow = typeof rounds.$inferSelect;

/** A Round's path: the id of its Application, and its own. */
export interface RoundPath {
  readonly id: string;
  readonly roundId: string;
}

/** The columns a prep task has in the contract: the rest stay inside the module. */
const prepTaskColumns = {
  id: prepTasks.id,
  title: prepTasks.title,
  skillId: prepTasks.skillId,
  completedAt: prepTasks.completedAt,
};

/**
 * The prep tasks of the Rounds `roundIds`, by Round, each Round's in the order they were added: one
 * query, whatever the number of Rounds. A Round without any isn't in the map.
 */
const prepTasksOf = (
  db: Db,
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

/**
 * `rounds`, each with its prep tasks, as the API answers a Round: one query for all of them. The
 * caller has checked the Rounds are the user's.
 */
export const withPrepTasks = <R extends { readonly id: string }>(db: Db, rounds: readonly R[]) =>
  prepTasksOf(
    db,
    rounds.map((round) => round.id),
  ).pipe(
    Effect.map((byRound) =>
      rounds.map((round) => ({ ...round, prepTasks: byRound.get(round.id) ?? [] })),
    ),
  );

/**
 * The Round `path` names, holding its row until `tx` ends, or `RoundNotFound`: a missing Round, one
 * of another Application, and one of a missing or another user's Application are the same 404, so
 * the API never confirms an id exists (CLAUDE.md rule 8).
 */
const lockOwned = (tx: Transaction, userId: string, path: RoundPath) =>
  Effect.gen(function* () {
    const [round] = yield* tx
      .select()
      .from(rounds)
      .where(
        and(
          eq(rounds.id, path.roundId),
          eq(rounds.applicationId, path.id),
          inArray(
            rounds.applicationId,
            tx
              .select({ id: applications.id })
              .from(applications)
              .where(and(eq(applications.id, path.id), eq(applications.userId, userId))),
          ),
        ),
      )
      .for('update')
      .pipe(Effect.orDie);

    if (!round) return yield* new RoundNotFound();

    return round;
  });

/**
 * Runs `use` on the signed-in user's Round `path` in one transaction holding its row, so a change
 * that reads before it writes (the Tag limit, the prep-task limit and positions) can't race another.
 * A database failure is a defect.
 */
const withLockedRound = <A, E>(
  db: Database['Service'],
  path: RoundPath,
  use: (tx: Transaction, round: RoundRow) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const user = yield* CurrentUser;

    return yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          const round = yield* lockOwned(tx, user.id, path);

          return yield* use(tx, round);
        }),
      )
      .pipe(Effect.catchTag('SqlError', Effect.die));
  });

/**
 * Changes the signed-in user's Round `path`: `change` gets the Round as it is, locked, and writes
 * what it changes in `tx`. Answers the Round as it is afterwards, with its prep tasks. A Round the
 * user doesn't own is `RoundNotFound`, and nothing changes.
 */
export const changeRound = <E>(
  db: Database['Service'],
  path: RoundPath,
  change: (tx: Transaction, round: RoundRow) => Effect.Effect<unknown, E>,
) =>
  withLockedRound(db, path, (tx, locked) =>
    Effect.gen(function* () {
      yield* change(tx, locked);

      const [round] = yield* tx
        .select()
        .from(rounds)
        .where(eq(rounds.id, locked.id))
        .pipe(Effect.orDie);

      // Stryker disable next-line StringLiteral: the row is locked, so it's always there and the message is never used
      if (!round) return yield* Effect.die(new Error('the locked round is gone'));

      const [answer] = yield* withPrepTasks(tx, [round]);

      // Stryker disable next-line StringLiteral: one Round in is one answer out, so the message is never used
      if (!answer) return yield* Effect.die(new Error('the round has no answer'));

      return answer;
    }),
  );

/** Deletes the signed-in user's Round `path`, its prep tasks with it, or `RoundNotFound`. */
export const deleteRound = (db: Database['Service'], path: RoundPath) =>
  withLockedRound(db, path, (tx, round) =>
    tx.delete(rounds).where(eq(rounds.id, round.id)).pipe(Effect.orDie, Effect.asVoid),
  );
