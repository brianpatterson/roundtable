import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { Effect } from 'effect';
import { HttpApiBuilder } from 'effect/http-api';
import {
  ApplicationNotFound,
  CurrentUser,
  MAX_TAGS,
  RoundNotFound,
  RoundtableApi,
  TooManyTags,
  currentStatus,
  sameTag,
} from '@roundtable/contract';
import { Database } from '../../platform/database/effect.js';
import { applications, rounds } from './schema.js';

type Row = typeof applications.$inferSelect;

/** A row as the API returns it: a `screening` the previous release wrote reads as interviewing. */
const toApplication = (row: Row) => ({ ...row, status: currentStatus(row.status) });

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

    const ownedBy = (userId: string, id: string) =>
      and(eq(applications.id, id), eq(applications.userId, userId));

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

        return result;
      });

    return handlers.handleAll({
      list: () =>
        Effect.gen(function* () {
          const user = yield* CurrentUser;

          return yield* db
            .select()
            .from(applications)
            .where(eq(applications.userId, user.id))
            .orderBy(desc(applications.updatedAt))
            .pipe(Effect.map((rows) => rows.map(toApplication)));
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

          return toApplication(row);
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

          return toApplication(row);
        }),

      update: ({ params, payload }) =>
        Effect.gen(function* () {
          const user = yield* CurrentUser;

          const [row] = yield* db
            .update(applications)
            .set({
              ...payload,
              // Back to saved means not sent. Any other status was sent: one moving out of
              // `saved` gets its applied date now, from Postgres's clock; one already sent keeps
              // its date.
              ...(payload.status && {
                appliedAt:
                  payload.status === 'saved'
                    ? null
                    : sql`coalesce(${applications.appliedAt}, now())`,
              }),
            })
            .where(ownedBy(user.id, params.id))
            .returning()
            .pipe(Effect.orDie);

          if (!row) return yield* new ApplicationNotFound();

          return toApplication(row);
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

          return yield* db
            .select()
            .from(rounds)
            .where(eq(rounds.applicationId, owned.id))
            .orderBy(asc(rounds.createdAt))
            .pipe(Effect.orDie);
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

                const [earlier] = yield* tx
                  .select({ id: rounds.id })
                  .from(rounds)
                  .where(eq(rounds.applicationId, application.id))
                  .limit(1);

                const [round] = yield* tx
                  .insert(rounds)
                  .values({ applicationId: application.id, interviewType: payload.interviewType })
                  .returning();

                // Its first Round moves an applied application to interviewing (GLOSSARY.md). Any
                // other status was set by the user, and stays.
                if (!earlier && application.status === 'applied') {
                  yield* tx
                    .update(applications)
                    .set({ status: 'interviewing' })
                    .where(eq(applications.id, application.id));
                }

                return round;
              }),
            )
            .pipe(Effect.orDie);

          if (!row) return yield* new ApplicationNotFound();

          return row;
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

        // One it has already, ignoring case and spaces, stays as it is; so does a full Round.
        return changeTags(params, (tags) =>
          hasIt(tags) || tags.length >= MAX_TAGS ? tags : [...tags, payload.tag],
        ).pipe(
          Effect.flatMap((round) =>
            hasIt(round.tags) ? Effect.succeed(round) : Effect.fail(new TooManyTags()),
          ),
        );
      },

      removeTag: ({ params, query }) =>
        changeTags(params, (tags) => tags.filter((tag) => !sameTag(tag, query.tag))),
    });
  }),
);
