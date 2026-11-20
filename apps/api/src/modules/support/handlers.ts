import { createHmac } from 'node:crypto';
import { and, eq, gt, sql } from 'drizzle-orm';
import { Cause, Effect, ErrorReporter, Option, Redacted } from 'effect';
import { HttpServerRequest } from 'effect/http';
import { HttpApiBuilder } from 'effect/http-api';
import { ReportRateLimited, RoundtableApi, Viewer } from '@roundtable/contract';
import type { Env } from '../../platform/config/env.js';
import { Database } from '../../platform/database/effect.js';
import { Mailer } from '../email/index.js';
import { GitHubIssues } from './github.js';
import { userReports } from './schema.js';

/** Reports one client address may send per hour; the next one is a 429. */
export const REPORTS_PER_HOUR = 5;

/**
 * The labels every report issue gets. Never `ready`: a human decides what the factory builds
 * (ADR-0025), and a public form must not be able to start it.
 */
export const REPORT_ISSUE_LABELS = ['bug', 'user-report'] as const;

/**
 * The client's address. Caddy, the only way in, appends the address it saw to X-Forwarded-For
 * and drops what an untrusted client sent, so the last entry is the real one. Without a proxy
 * (development, tests) it's the socket's address.
 */
function clientAddress(request: HttpServerRequest.HttpServerRequest): string {
  const forwarded = request.headers['x-forwarded-for']?.split(',').at(-1)?.trim();

  return forwarded || Option.getOrElse(request.remoteAddress, () => 'unknown');
}

/** A browser family from a user agent: a fixed word, never the user agent itself (ADR-0038). */
export function browserFamily(userAgent: string | undefined): string {
  if (!userAgent) return 'Unknown';

  // Order matters: Edge and Opera also say Chrome, and Chrome also says Safari.
  const families: Array<[RegExp, string]> = [
    [/Edg\//, 'Edge'],
    [/OPR\/|Opera/, 'Opera'],
    [/Firefox\/|FxiOS/, 'Firefox'],
    [/Chrome\/|CriOS/, 'Chrome'],
    [/Safari\//, 'Safari'],
  ];

  return families.find(([pattern]) => pattern.test(userAgent))?.[1] ?? 'Other';
}

type StoredReport = typeof userReports.$inferSelect;

/** The issue for a report: safe context only, never anything the user typed (ADR-0038). */
export function reportIssue(report: StoredReport) {
  return {
    title: `User report ${report.id}: ${report.pagePath}`,
    body: [
      'A user reported a problem from the app. What they wrote is stored privately and was',
      'emailed to the owner; it is deliberately not in this issue.',
      '',
      `- Report: ${report.id}`,
      `- Page: \`${report.pagePath}\``,
      `- Release: \`${report.release}\``,
      `- Time: ${report.createdAt.toISOString()}`,
      `- Browser: ${browserFamily(report.userAgent ?? undefined)}`,
    ].join('\n'),
    labels: [...REPORT_ISSUE_LABELS],
  };
}

/** The owner's email: the whole report, the description included. */
function ownerEmail(to: string, report: StoredReport, issue: string) {
  return {
    kind: 'user-report' as const,
    to,
    subject: `User report ${report.id}: ${report.pagePath}`,
    text: [
      `Report: ${report.id}`,
      `Time: ${report.createdAt.toISOString()}`,
      `Page: ${report.pagePath}`,
      `Release: ${report.release}`,
      `User: ${report.userId ?? 'signed out'}`,
      `Reply to: ${report.replyEmail ?? 'no address given'}`,
      `User agent: ${report.userAgent ?? 'unknown'}`,
      `GitHub issue: ${issue}`,
      '',
      'What they wrote:',
      '',
      report.description,
    ].join('\n'),
  };
}

/** Logs and reports a failure, then carries on: the report is already stored. */
const reportFailure =
  (message: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Effect.logError(message, cause).pipe(
          Effect.andThen(ErrorReporter.report(cause)),
          Effect.as(undefined),
        ),
      ),
    );

/**
 * "Report a problem" (ADR-0038). Public, behind OptionalSession: a signed-in caller's report
 * carries their user id. Stores the report, then opens a GitHub issue with safe context and
 * emails the owner the full report. Those two are best effort: their failures are reported, and
 * the user still gets the confirmation.
 */
export const SupportApiLive = (env: Env) =>
  HttpApiBuilder.group(
    RoundtableApi,
    'support',
    Effect.fn(function* (handlers) {
      const db = yield* Database;
      const mailer = yield* Mailer;
      const issues = yield* GitHubIssues;
      const release = env.SENTRY_RELEASE ?? 'unknown';
      const hmacKey = Redacted.value(env.BETTER_AUTH_SECRET);

      const keyFor = (address: string) =>
        createHmac('sha256', hmacKey).update(`report-client:${address}`).digest('hex');

      /** Stores the report unless this address is over its hourly limit. One lock: rare writes. */
      const store = (values: typeof userReports.$inferInsert) =>
        db.transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.execute(sql`select pg_advisory_xact_lock(hashtext('user_reports'))`);

            const [recent] = yield* tx
              .select({ count: sql<number>`count(*)::int` })
              .from(userReports)
              .where(
                and(
                  eq(userReports.clientKey, values.clientKey),
                  gt(userReports.createdAt, sql`now() - interval '1 hour'`),
                ),
              );

            if ((recent?.count ?? 0) >= REPORTS_PER_HOUR) return undefined;

            const [row] = yield* tx.insert(userReports).values(values).returning();

            return row;
          }),
        );

      /** Claims one of the day's issues for this report; false once the cap is reached. */
      const claimIssue = (id: string) =>
        db.transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.execute(sql`select pg_advisory_xact_lock(hashtext('user_report_issues'))`);

            const [today] = yield* tx
              .select({ count: sql<number>`count(*)::int` })
              .from(userReports)
              .where(gt(userReports.issueRequestedAt, sql`now() - interval '24 hours'`));

            if ((today?.count ?? 0) >= env.REPORT_LIMIT_PER_DAY) return false;

            yield* tx
              .update(userReports)
              .set({ issueRequestedAt: sql`now()` })
              .where(eq(userReports.id, id));

            return true;
          }),
        );

      const openIssue = Effect.fnUntraced(function* (report: StoredReport) {
        if (!(yield* claimIssue(report.id).pipe(Effect.orDie))) {
          yield* Effect.logWarning('GitHub issue not opened: daily report limit reached').pipe(
            Effect.annotateLogs({ limit: env.REPORT_LIMIT_PER_DAY }),
          );

          return 'not opened: daily limit reached';
        }

        const opened = yield* issues.open(reportIssue(report)).pipe(
          Effect.tapError((error) => ErrorReporter.report(Cause.fail(error))),
          Effect.tapError((error) =>
            Effect.logError('GitHub issue not opened').pipe(
              Effect.annotateLogs({ status: error.status }),
            ),
          ),
          Effect.catchTag('IssueOpenFailed', () => Effect.succeed('failed' as const)),
        );

        if (opened === 'failed') return 'not opened: GitHub failed (see the logs)';

        if (!opened) return 'not opened: GITHUB_ISSUES_TOKEN is not set';

        yield* db
          .update(userReports)
          .set({ issueUrl: opened.url })
          .where(eq(userReports.id, report.id))
          .pipe(Effect.orDie);

        return opened.url;
      });

      const emailOwner = Effect.fnUntraced(function* (report: StoredReport, issue: string) {
        if (!env.REPORTS_EMAIL) {
          yield* Effect.logInfo('Report not emailed: REPORTS_EMAIL is not set');

          return;
        }

        yield* (
          mailer
            .send(ownerEmail(env.REPORTS_EMAIL, report, issue))
            // The Mailer has already logged and reported a failed send.
            .pipe(Effect.catchTag('EmailSendFailed', () => Effect.void))
        );
      });

      return handlers.handleAll({
        createReport: ({ payload }) =>
          Effect.gen(function* () {
            const viewer = yield* Viewer;
            const request = yield* HttpServerRequest.HttpServerRequest;
            const userAgent = request.headers['user-agent']?.slice(0, 500);

            const report = yield* store({
              description: payload.description,
              replyEmail: payload.replyEmail ?? null,
              userId: Option.match(viewer, { onNone: () => null, onSome: (user) => user.id }),
              pagePath: payload.pagePath,
              release,
              userAgent: userAgent ?? null,
              clientKey: keyFor(clientAddress(request)),
            }).pipe(Effect.orDie);

            if (!report) return yield* new ReportRateLimited();

            yield* Effect.logInfo('Problem report stored').pipe(
              Effect.annotateLogs({ reportId: report.id }),
            );

            const issue = yield* openIssue(report).pipe(reportFailure('Opening the issue failed'));

            yield* emailOwner(report, issue ?? 'not opened: unexpected error (see the logs)').pipe(
              reportFailure('Emailing the report failed'),
            );

            return { id: report.id };
          }),
      });
    }),
  );
