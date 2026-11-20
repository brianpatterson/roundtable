// The support module's contract: "Report a problem", which anyone can send, signed in or not
// (ADR-0037). A signed-in caller's report is linked to their account through OptionalSession.
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

/** Drops `?query` and `#hash`: they can hold tokens (a reset link's) and never go in a report. */
const withoutQuery = (path: string) => path.replace(/[?#].*$/s, '');

const isPagePath = (path: string) => path.length <= 200 && /^\/[A-Za-z0-9/_.-]*$/.test(path);

/**
 * The page the user was on, as a path. Only letters, digits and `/-_.`, at most 200 characters:
 * it goes in a GitHub issue title, so it must not be able to carry a sentence (ADR-0037). The
 * query and hash are dropped in both directions, so the client never sends them. (The check
 * ignores them too: the client checks `location.pathname + search` before encoding drops it.)
 */
const PagePath = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String.check(
      Schema.makeFilter((value: string) =>
        isPagePath(withoutQuery(value)) ? undefined : 'must be a page path',
      ),
    ),
    new SchemaTransformation.Transformation(
      SchemaGetter.transform(withoutQuery),
      SchemaGetter.transform(withoutQuery),
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
