import { and, asc, eq, getTableColumns, inArray } from 'drizzle-orm';
import { Clock, Effect } from 'effect';
import { HttpApiBuilder } from 'effect/http-api';
import {
  CurrentUser,
  OPEN_APPLICATION_STATUSES,
  RoundtableApi,
  inAgendaOrder,
  isUpcoming,
} from '@roundtable/contract';
import { Database } from '../../platform/database/effect.js';
import { applications, rounds } from './schema.js';

/**
 * The Agenda (ADR-0070): the signed-in user's Rounds on their open Applications, in one query, in
 * the order they were added. The day cut-off and Agenda order are the contract's, in the user's
 * time zone (UTC without one), so the server and the web app agree on both. Rounds per user are
 * few, so they're filtered here rather than in SQL.
 */
export const AgendaLive = HttpApiBuilder.group(
  RoundtableApi,
  'agenda',
  Effect.fn(function* (handlers) {
    const db = yield* Database;

    return handlers.handle('list', ({ query }) =>
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const timeZone = query.timeZone ?? 'UTC';
        const now = new Date(yield* Clock.currentTimeMillis);

        const rows = yield* db
          .select({
            ...getTableColumns(rounds),
            company: applications.company,
            jobTitle: applications.jobTitle,
          })
          .from(rounds)
          .innerJoin(applications, eq(rounds.applicationId, applications.id))
          .where(
            and(
              eq(applications.userId, user.id),
              inArray(applications.status, [...OPEN_APPLICATION_STATUSES]),
            ),
          )
          .orderBy(asc(rounds.createdAt), asc(rounds.id));

        const upcoming = rows.filter((round) => isUpcoming(round, now, timeZone));

        return inAgendaOrder(upcoming, timeZone);
      }).pipe(Effect.orDie),
    );
  }),
);
