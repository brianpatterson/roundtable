import { createHash, timingSafeEqual } from 'node:crypto';
import { and, eq, gt, sql } from 'drizzle-orm';
import { Effect, Option, Redacted, Schema } from 'effect';
import { HttpServerRequest } from 'effect/http';
import { HttpApiBuilder } from 'effect/http-api';
import {
  ReportDiagnostics,
  ReportNotFound,
  RoundtableApi,
  Unauthorized,
} from '@roundtable/contract';
import type { Env } from '../../platform/config/env.js';
import { Database } from '../../platform/database/effect.js';
import { browserFamily } from './handlers.js';
import { userReports } from './schema.js';

/** Reports older than this are a 404 to the factory: a leaked token reads only recent ones. */
export const FACTORY_REPORT_MAX_AGE_DAYS = 30;

/** The column is typed, not checked: decode what comes back from storage. */
const decodeDiagnostics = Schema.decodeUnknownOption(ReportDiagnostics);

const digest = (value: string) => createHash('sha256').update(value).digest();

/**
 * Whether an Authorization header carries the factory's token. Compares fixed-length digests, so
 * the comparison takes the same time whatever the header holds. No token configured: never.
 */
export function hasFactoryToken(header: string | undefined, token: string | undefined): boolean {
  const prefix = 'Bearer ';

  if (!token || !header?.startsWith(prefix)) return false;

  return timingSafeEqual(digest(header.slice(prefix.length)), digest(token));
}

/**
 * One report as the factory's implementer reads it (ADR-0041): the user's words and what their
 * browser saw, never who sent it. Only with FACTORY_REPORTS_TOKEN, only reports under 30 days old.
 */
export const FactoryReportsApiLive = (env: Env) =>
  HttpApiBuilder.group(
    RoundtableApi,
    'factoryReports',
    Effect.fn(function* (handlers) {
      const db = yield* Database;
      // Unwrapped once, only to compare against the request's header.
      const token = env.FACTORY_REPORTS_TOKEN && Redacted.value(env.FACTORY_REPORTS_TOKEN);

      return handlers.handleAll({
        get: ({ params }) =>
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;

            if (!hasFactoryToken(request.headers['authorization'], token)) {
              return yield* new Unauthorized();
            }

            const [report] = yield* db
              .select()
              .from(userReports)
              .where(
                and(
                  eq(userReports.id, params.id),
                  gt(
                    userReports.createdAt,
                    sql`now() - make_interval(days => ${FACTORY_REPORT_MAX_AGE_DAYS})`,
                  ),
                ),
              )
              .pipe(Effect.orDie);

            if (!report) return yield* new ReportNotFound();

            // A row that doesn't decode (it can't be written so, but a column is only typed)
            // costs the factory its diagnostics, not the whole report.
            const diagnostics =
              report.diagnostics === null
                ? null
                : Option.getOrNull(decodeDiagnostics(report.diagnostics));

            if (report.diagnostics !== null && diagnostics === null) {
              yield* Effect.logWarning("A report's stored diagnostics don't decode").pipe(
                Effect.annotateLogs({ reportId: report.id }),
              );
            }

            yield* Effect.logInfo('Problem report read by the factory').pipe(
              Effect.annotateLogs({ reportId: report.id }),
            );

            return {
              id: report.id,
              description: report.description,
              pagePath: report.pagePath,
              release: report.release,
              browser: browserFamily(report.userAgent ?? undefined),
              signedIn: report.userId !== null,
              createdAt: report.createdAt,
              diagnostics,
            };
          }),
      });
    }),
  );
