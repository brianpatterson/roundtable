import { and, asc, count, desc, eq, inArray, max, sql } from 'drizzle-orm';
import { Effect } from 'effect';
import { HttpApiBuilder } from 'effect/http-api';
import {
  ApplicationNotFound,
  CurrentUser,
  MAX_PREP_TASKS,
  MAX_TAGS,
  PrepTaskNotFound,
  RoundNotFound,
  RoundtableApi,
  TooManyPrepTasks,
  TooManyTags,
  sameTag,
  type RoundRating,
  type RoundSchedule,
} from '@roundtable/contract';
import { Database } from '../../platform/database/effect.js';
import { Skills } from '../personas/index.js';
import { prepTasksOf, withPrepTasks } from './prep.js';
import { roundAdded, statusChanged, type Transaction } from './round-lifecycle.js';
import { applications, prepTasks, rounds } from './schema.js';

/** A whole schedule as columns: what the request leaves out is cleared. */
const scheduleOf = (schedule: RoundSchedule) => ({
  startsAt: schedule.startsAt ?? null,
  durationMinutes: schedule.durationMinutes ?? null,
  dueOn: schedule.dueOn ?? null,
});

/** A whole Self-rating as columns: what the request leaves out is cleared, and so is a blank note. */
const ratingOf = (rating: RoundRating) => ({
  selfRating: rating.selfRating ?? null,
  ratingNote: rating.ratingNote?.trim() ? rating.ratingNote : null,
});

/**
 * A Round's date for the list: its start, or the start of its due date's day (UTC: the server
 * doesn't know the user's time zone). Undated Rounds come last. This is Round order in UTC
 * (ADR-0054); inference and the web order in the user's zone with the contract's `inRoundOrder`.
 */
const roundDate = sql`coalesce(${rounds.startsAt}, ${rounds.dueOn}::timestamp at time zone 'UTC') asc nulls last`;

/**
 * Every query filters on the signed-in user (CurrentUser, from the Authorization middleware).
 * Another user's row and a missing row are the same 404, so the API never confirms an id exists.
 * Database failures are defects: a 500, reported to Sentry with the redaction in
 * platform/observability/redact.ts.
 */
export const ApplicationsLive = HttpApiBuilder.group(
  RoundtableApi,
  'applications',
  Effect.fn(function* (handlers) {
    const db = yield* Database;
    const skills = yield* Skills;

    const ownedBy = (userId: string, id: string) =>
      and(eq(applications.id, id), eq(applications.userId, userId));

    /** A Round the user owns, with its prep tasks, as every endpoint answers one. */
    const withPrep = <R extends { readonly id: string }>(round: R) =>
      prepTasksOf(db, [round.id]).pipe(
        Effect.map((byRound) => ({ ...round, prepTasks: byRound.get(round.id) ?? [] })),
      );

    /**
     * A Skill id a request names: the signed-in user's (archived or not), or `SkillNotFound`.
     * Run it before `changePrep`, not inside its transaction: it's personas' read, and no
     * transaction spans two modules (ADR-0044). Skills are never deleted, so one can't go missing
     * in between.
     */
    const checkSkill = (skillId: string | null | undefined) =>
      Effect.gen(function* () {
        if (skillId === undefined || skillId === null) return;

        const user = yield* CurrentUser;

        yield* skills.findOwned(user.id, skillId);
      });

    /**
     * Changes the Prep of the Round `roundId` of the user's application `id`, in one transaction
     * holding the Round's row, so two tasks added at once can't both pass the limit or take one
     * place. Another user's application is `ApplicationNotFound`; a Round that isn't the
     * application's, `RoundNotFound`. Answers the Round as it is afterwards, with its prep tasks.
     */
    const changePrep = <E>(
      params: { readonly id: string; readonly roundId: string },
      change: (tx: Transaction, roundId: string) => Effect.Effect<unknown, E>,
    ) =>
      Effect.gen(function* () {
        const user = yield* CurrentUser;

        return yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              const [application] = yield* tx
                .select({ id: applications.id })
                .from(applications)
                .where(ownedBy(user.id, params.id))
                .pipe(Effect.orDie);

              if (!application) return yield* new ApplicationNotFound();

              const [locked] = yield* tx
                .select({ id: rounds.id })
                .from(rounds)
                .where(and(eq(rounds.id, params.roundId), eq(rounds.applicationId, application.id)))
                .for('update')
                .pipe(Effect.orDie);

              if (!locked) return yield* new RoundNotFound();

              yield* change(tx, locked.id);

              const [round] = yield* tx
                .select()
                .from(rounds)
                .where(eq(rounds.id, locked.id))
                .pipe(Effect.orDie);

              if (!round) return yield* Effect.die(new Error('the locked round is gone'));

              const [answer] = yield* withPrepTasks(tx, [round]);

              if (!answer) return yield* Effect.die(new Error('the round has no answer'));

              return answer;
            }),
          )
          .pipe(Effect.catchTag('SqlError', Effect.die));
      });

    /** Fails with `PrepTaskNotFound` unless the Round `roundId` has the task `taskId`. */
    const findTask = (tx: Transaction, roundId: string, taskId: string) =>
      Effect.gen(function* () {
        const [task] = yield* tx
          .select({ id: prepTasks.id })
          .from(prepTasks)
          .where(and(eq(prepTasks.id, taskId), eq(prepTasks.roundId, roundId)))
          .pipe(Effect.orDie);

        if (!task) return yield* new PrepTaskNotFound();

        return task;
      });

    /** The Round `roundId` of the user's application `id`: none if either isn't theirs. */
    const ownedRound = (userId: string, id: string, roundId: string) =>
      and(
        eq(rounds.id, roundId),
        eq(rounds.applicationId, id),
        inArray(
          rounds.applicationId,
          db.select({ id: applications.id }).from(applications).where(ownedBy(userId, id)),
        ),
      );

    /**
     * Sets a Round's Tags to what `change` makes of them, in one transaction holding its row, so
     * two changes at once can't both pass the limit or both miss each other. Tags `change` leaves
     * as many as they were (adding one it has, removing one it hasn't) aren't written. Answers
     * the Round.
     */
    const changeTags = (
      params: { readonly id: string; readonly roundId: string },
      change: (tags: readonly string[]) => readonly string[],
    ) =>
      Effect.gen(function* () {
        const user = yield* CurrentUser;

        const result = yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              const [round] = yield* tx
                .select()
                .from(rounds)
                .where(ownedRound(user.id, params.id, params.roundId))
                .for('update');

              if (!round) return undefined;

              const tags = change(round.tags);

              if (tags.length === round.tags.length) return round;

              const [updated] = yield* tx
                .update(rounds)
                .set({ tags: [...tags] })
                .where(eq(rounds.id, round.id))
                .returning();

              if (!updated) return yield* Effect.die(new Error('update returned no row'));

              return updated;
            }),
          )
          .pipe(Effect.orDie);

        if (!result) return yield* new RoundNotFound();

        return yield* withPrep(result);
      });

    return handlers.handleAll({
      list: () =>
        Effect.gen(function* () {
          const user = yield* CurrentUser;

          return yield* db
            .select()
            .from(applications)
            .where(eq(applications.userId, user.id))
            .orderBy(desc(applications.updatedAt));
        }).pipe(Effect.orDie),

      get: ({ params }) =>
        Effect.gen(function* () {
          const user = yield* CurrentUser;

          const [row] = yield* db
            .select()
            .from(applications)
            .where(ownedBy(user.id, params.id))
            .pipe(Effect.orDie);

          if (!row) return yield* new ApplicationNotFound();

          return row;
        }),

      create: ({ payload }) =>
        Effect.gen(function* () {
          const user = yield* CurrentUser;

          const [row] = yield* db
            .insert(applications)
            .values({
              ...payload,
              userId: user.id,
              // A saved application isn't sent yet. Any other status was sent now: applied_at's
              // default.
              ...(payload.status === 'saved' && { appliedAt: null }),
            })
            .returning()
            .pipe(Effect.orDie);

          if (!row) return yield* Effect.die(new Error('insert returned no row'));

          return row;
        }),

      update: ({ params, payload: { timeZone, ...changes } }) =>
        Effect.gen(function* () {
          const user = yield* CurrentUser;

          // One transaction holding the application's row, so the status it changes from is the
          // one it had, and the Rounds a rejection fails fail with it.
          const row = yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                const [before] = yield* tx
                  .select({ status: applications.status })
                  .from(applications)
                  .where(ownedBy(user.id, params.id))
                  .for('update');

                if (!before) return undefined;

                const [updated] = yield* tx
                  .update(applications)
                  .set({
                    ...changes,
                    // Back to saved means not sent. Any other status was sent: one moving out of
                    // `saved` gets its applied date now, from Postgres's clock; one already sent
                    // keeps its date.
                    ...(changes.status && {
                      appliedAt:
                        changes.status === 'saved'
                          ? null
                          : sql`coalesce(${applications.appliedAt}, now())`,
                    }),
                  })
                  .where(ownedBy(user.id, params.id))
                  .returning();

                if (updated) yield* statusChanged(tx, before, updated, timeZone);

                return updated;
              }),
            )
            .pipe(Effect.orDie);

          if (!row) return yield* new ApplicationNotFound();

          return row;
        }),

      delete: ({ params }) =>
        Effect.gen(function* () {
          const user = yield* CurrentUser;

          const [row] = yield* db
            .delete(applications)
            .where(ownedBy(user.id, params.id))
            .returning({ id: applications.id })
            .pipe(Effect.orDie);

          if (!row) return yield* new ApplicationNotFound();
        }),

      listRounds: ({ params }) =>
        Effect.gen(function* () {
          const user = yield* CurrentUser;

          const [owned] = yield* db
            .select({ id: applications.id })
            .from(applications)
            .where(ownedBy(user.id, params.id))
            .pipe(Effect.orDie);

          if (!owned) return yield* new ApplicationNotFound();

          const listed = yield* db
            .select()
            .from(rounds)
            .where(eq(rounds.applicationId, owned.id))
            .orderBy(roundDate, asc(rounds.createdAt), asc(rounds.id))
            .pipe(Effect.orDie);

          return yield* withPrepTasks(db, listed);
        }),

      createRound: ({ params, payload }) =>
        Effect.gen(function* () {
          const user = yield* CurrentUser;

          // One transaction holding the application's row, so two first Rounds added at once
          // can't both miss each other, and a Round is never added to an application being
          // deleted.
          const row = yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                const [application] = yield* tx
                  .select({ id: applications.id, status: applications.status })
                  .from(applications)
                  .where(ownedBy(user.id, params.id))
                  .for('update');

                if (!application) return undefined;

                const earlier = yield* tx
                  .select()
                  .from(rounds)
                  .where(eq(rounds.applicationId, application.id));

                const [round] = yield* tx
                  .insert(rounds)
                  .values({
                    applicationId: application.id,
                    interviewType: payload.interviewType,
                    ...scheduleOf(payload),
                  })
                  .returning();

                if (!round) return yield* Effect.die(new Error('insert returned no row'));

                yield* roundAdded(tx, application, earlier, round, payload.timeZone);

                return round;
              }),
            )
            .pipe(Effect.orDie);

          if (!row) return yield* new ApplicationNotFound();

          // A new Round has no prep tasks yet.
          return { ...row, prepTasks: [] };
        }),

      scheduleRound: ({ params, payload }) =>
        Effect.gen(function* () {
          const user = yield* CurrentUser;

          const [row] = yield* db
            .update(rounds)
            .set(scheduleOf(payload))
            .where(ownedRound(user.id, params.id, params.roundId))
            .returning()
            .pipe(Effect.orDie);

          if (!row) return yield* new RoundNotFound();

          return yield* withPrep(row);
        }),

      rateRound: ({ params, payload }) =>
        Effect.gen(function* () {
          const user = yield* CurrentUser;

          const [row] = yield* db
            .update(rounds)
            .set(ratingOf(payload))
            .where(ownedRound(user.id, params.id, params.roundId))
            .returning()
            .pipe(Effect.orDie);

          if (!row) return yield* new RoundNotFound();

          return yield* withPrep(row);
        }),

      setRoundOutcome: ({ params, payload }) =>
        Effect.gen(function* () {
          const user = yield* CurrentUser;

          const [row] = yield* db
            .update(rounds)
            .set({ outcome: payload.outcome, outcomeSetByUser: true })
            .where(ownedRound(user.id, params.id, params.roundId))
            .returning()
            .pipe(Effect.orDie);

          if (!row) return yield* new RoundNotFound();

          return yield* withPrep(row);
        }),

      deleteRound: ({ params }) =>
        Effect.gen(function* () {
          const user = yield* CurrentUser;

          const [row] = yield* db
            .delete(rounds)
            .where(ownedRound(user.id, params.id, params.roundId))
            .returning({ id: rounds.id })
            .pipe(Effect.orDie);

          if (!row) return yield* new RoundNotFound();
        }),

      addTag: ({ params, payload }) => {
        const hasIt = (tags: readonly string[]) => tags.some((tag) => sameTag(tag, payload.tag));

        // One it has already, ignoring case and spaces, stays as it is; so does a full Round,
        // which comes back without the Tag.
        return changeTags(params, (tags) =>
          hasIt(tags) || tags.length >= MAX_TAGS ? tags : [...tags, payload.tag],
        ).pipe(
          Effect.filterOrFail(
            (round) => hasIt(round.tags),
            () => new TooManyTags(),
          ),
        );
      },

      removeTag: ({ params, query }) =>
        changeTags(params, (tags) => tags.filter((tag) => !sameTag(tag, query.tag))),

      // A blank note is no note.
      setPrepNotes: ({ params, payload }) =>
        changePrep(params, (tx, roundId) =>
          tx
            .update(rounds)
            .set({ prepNotes: payload.notes?.trim() ? payload.notes : null })
            .where(eq(rounds.id, roundId))
            .pipe(Effect.orDie),
        ),

      addPrepTask: ({ params, payload }) =>
        Effect.andThen(
          checkSkill(payload.skillId),
          changePrep(params, (tx, roundId) =>
            Effect.gen(function* () {
              const [existing] = yield* tx
                .select({ count: count(), last: max(prepTasks.position) })
                .from(prepTasks)
                .where(eq(prepTasks.roundId, roundId))
                .pipe(Effect.orDie);

              if ((existing?.count ?? 0) >= MAX_PREP_TASKS) return yield* new TooManyPrepTasks();

              yield* tx
                .insert(prepTasks)
                .values({
                  roundId,
                  title: payload.title,
                  skillId: payload.skillId ?? null,
                  position: (existing?.last ?? -1) + 1,
                })
                .pipe(Effect.orDie);
            }),
          ),
        ),

      // Marking a done task done keeps the date it was first done.
      updatePrepTask: ({ params, payload }) =>
        Effect.andThen(
          checkSkill(payload.skillId),
          changePrep(params, (tx, roundId) =>
            Effect.gen(function* () {
              const task = yield* findTask(tx, roundId, params.taskId);

              yield* tx
                .update(prepTasks)
                .set({
                  ...(payload.title !== undefined && { title: payload.title }),
                  ...(payload.skillId !== undefined && { skillId: payload.skillId }),
                  ...(payload.done !== undefined && {
                    completedAt: payload.done
                      ? sql`coalesce(${prepTasks.completedAt}, now())`
                      : null,
                  }),
                })
                .where(eq(prepTasks.id, task.id))
                .pipe(Effect.orDie);
            }),
          ),
        ),

      deletePrepTask: ({ params }) =>
        changePrep(params, (tx, roundId) =>
          Effect.gen(function* () {
            const task = yield* findTask(tx, roundId, params.taskId);

            yield* tx.delete(prepTasks).where(eq(prepTasks.id, task.id)).pipe(Effect.orDie);
          }),
        ),
    });
  }),
);
