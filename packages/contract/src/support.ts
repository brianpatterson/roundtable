// The support module's contract: "Report a problem", which anyone can send, signed in or not
// (ADR-0038). A signed-in caller's report is linked to their account through OptionalSession.
import { ErrorReporter, Schema, SchemaGetter, SchemaTransformation } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/http-api';
import { OptionalSession, Unauthorized } from './identity.js';

export const REPORT_DESCRIPTION_MAX = 2000;

/**
 * What went wrong, in the user's words: 1–2,000 characters once trimmed, trimmed in both
 * directions (the typed client encodes what it sends; see `Text` in applications.ts).
 */
const Description = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String.check(
      Schema.makeFilter((value: string) => {
        const length = value.trim().length;

        if (length === 0) return 'must not be blank';

        return length > REPORT_DESCRIPTION_MAX
          ? `must be at most ${REPORT_DESCRIPTION_MAX} characters`
          : undefined;
      }),
    ),
    new SchemaTransformation.Transformation(SchemaGetter.trim(), SchemaGetter.trim()),
  ),
);

/** Loose on purpose: one @, no spaces, a dot in the domain. The owner replies by hand. */
const ReplyEmail = Schema.String.check(
  Schema.isMaxLength(254),
  Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, { message: 'must be an email address' }),
);

export const REPORT_PAGE_PATH_MAX = 500;

/**
 * Drops `?query` and `#hash`, which can hold tokens (a reset link's) and never go in a report,
 * and keeps at most 500 characters.
 */
const pagePath = (path: string) => path.replace(/[?#].*$/s, '').slice(0, REPORT_PAGE_PATH_MAX);

/**
 * The page the user was on, as a path: any path, so a user on a mistyped link can still report
 * it. It never goes in a GitHub issue as sent: the server names a known page or `other` there
 * (ADR-0038). The query and hash are dropped in both directions, so the client never sends them.
 * (The check ignores them too: the client checks its value before encoding drops them.)
 */
const PagePath = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String.check(
      Schema.makeFilter((value: string) =>
        pagePath(value).startsWith('/') ? undefined : 'must be a page path',
      ),
    ),
    new SchemaTransformation.Transformation(
      SchemaGetter.transform(pagePath),
      SchemaGetter.transform(pagePath),
    ),
  ),
);

/** Text the browser captured, already cut to `max` characters by the client before sending. */
const Captured = (max: number) => Schema.String.check(Schema.isMaxLength(max));

const Count = (max: number) => Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: max }));

export const DIAGNOSTIC_REQUESTS_MAX = 20;

export const DIAGNOSTIC_ERRORS_MAX = 5;

export const DIAGNOSTIC_MESSAGE_MAX = 500;

export const DIAGNOSTIC_STACK_MAX = 4000;

/**
 * What the browser saw before the report, gathered by the web app rather than typed: the API
 * requests it made and the errors it hit. Private like the description (ADR-0041): stored, emailed
 * to the owner and given to the factory's implementer, never put in a GitHub issue. Every list
 * and string is bounded; the client trims to these limits before sending.
 */
export const ReportDiagnostics = Schema.Struct({
  viewport: Schema.optional(Schema.Struct({ width: Count(100_000), height: Count(100_000) })),
  theme: Schema.optional(Schema.Literals(['light', 'dark', 'system'])),
  /** The latest API requests, oldest first: path without its query, and 0 for a network failure. */
  requests: Schema.optional(
    Schema.Array(
      Schema.Struct({
        method: Captured(10),
        path: Captured(REPORT_PAGE_PATH_MAX),
        status: Count(999),
        secondsBefore: Count(86_400),
      }),
    ).check(Schema.isMaxLength(DIAGNOSTIC_REQUESTS_MAX)),
  ),
  /** The latest uncaught errors and unhandled rejections, oldest first. */
  errors: Schema.optional(
    Schema.Array(
      Schema.Struct({
        message: Captured(DIAGNOSTIC_MESSAGE_MAX),
        stack: Schema.optional(Captured(DIAGNOSTIC_STACK_MAX)),
        secondsBefore: Count(86_400),
      }),
    ).check(Schema.isMaxLength(DIAGNOSTIC_ERRORS_MAX)),
  ),
});

export type ReportDiagnostics = typeof ReportDiagnostics.Type;

export const CreateReport = Schema.Struct({
  description: Description,
  replyEmail: Schema.optional(Schema.NullOr(ReplyEmail)),
  pagePath: PagePath,
  diagnostics: Schema.optional(ReportDiagnostics),
});

export type CreateReport = typeof CreateReport.Type;

/** The confirmation: the id the user can quote if they write again. */
export const ReportReceipt = Schema.Struct({ id: Schema.String });

export type ReportReceipt = typeof ReportReceipt.Type;

/** Too many reports in an hour, from one address or from everyone: nothing was stored or sent. */
export class ReportRateLimited extends Schema.TaggedError<
  ReportRateLimited,
  { readonly brand: unique symbol }
>()('ReportRateLimited', {}, { httpApiStatus: 429 }) {
  readonly [ErrorReporter.ignore] = true;
}

/** Public: works signed out (the sign-in page) and signed in (the shell). */
export class SupportApi extends HttpApiGroup.make('support')
  .add(
    HttpApiEndpoint.post('createReport', '/', {
      payload: CreateReport,
      success: ReportReceipt.pipe(HttpApiSchema.status(201)),
      error: ReportRateLimited,
    }),
  )
  .middleware(OptionalSession)
  .prefix('/api/reports') {}

/** No report with that id, or one older than the factory may read: nothing to say which. */
export class ReportNotFound extends Schema.TaggedError<
  ReportNotFound,
  { readonly brand: unique symbol }
>()('ReportNotFound', {}, { httpApiStatus: 404 }) {
  readonly [ErrorReporter.ignore] = true;
}

/**
 * A report as the factory's implementer gets it (ADR-0041): what the user wrote and what their
 * browser saw, so it can reproduce the bug. Never who sent it: no reply address, user id or full
 * user agent.
 */
export const FactoryReport = Schema.Struct({
  id: Schema.String,
  description: Schema.String,
  pagePath: Schema.String,
  release: Schema.String,
  browser: Schema.String,
  signedIn: Schema.Boolean,
  createdAt: Schema.DateFromString,
  diagnostics: Schema.NullOr(ReportDiagnostics),
});

export type FactoryReport = typeof FactoryReport.Type;

/**
 * For the factory's implementer only (ADR-0041), with `Authorization: Bearer
 * <FACTORY_REPORTS_TOKEN>`; anything else is a 401. Not behind a session: no user calls it.
 */
export class FactoryReportsApi extends HttpApiGroup.make('factoryReports')
  .add(
    HttpApiEndpoint.get('get', '/:id', {
      params: { id: Schema.String.check(Schema.isUUID()) },
      success: FactoryReport,
      error: [Unauthorized, ReportNotFound],
    }),
  )
  .prefix('/api/factory/reports') {}
