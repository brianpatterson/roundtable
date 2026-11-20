// The support module's contract: "Report a problem", which anyone can send, signed in or not
// (ADR-0038). A signed-in caller's report is linked to their account through OptionalSession.
import { ErrorReporter, Schema, SchemaGetter, SchemaTransformation } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/http-api';
import { OptionalSession } from './identity.js';

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

export const CreateReport = Schema.Struct({
  description: Description,
  replyEmail: Schema.optional(Schema.NullOr(ReplyEmail)),
  pagePath: PagePath,
});

export type CreateReport = typeof CreateReport.Type;

/** The confirmation: the id the user can quote if they write again. */
export const ReportReceipt = Schema.Struct({ id: Schema.String });

export type ReportReceipt = typeof ReportReceipt.Type;

/** Too many reports from one address in an hour: nothing was stored or sent. */
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
