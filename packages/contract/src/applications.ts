// The applications module's contract: job applications and their CRUD endpoints, all behind the
// identity module's Authorization middleware.
import { Effect, ErrorReporter, Schema, SchemaGetter, SchemaTransformation } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/http-api';
import { Authorization } from './identity.js';

/**
 * The stages an application can be in, in display order (ADR-0045). `saved` is a posting not yet
 * sent; every other status means it was sent, on its `appliedAt` date.
 */
export const APPLICATION_STATUSES = [
  'saved',
  'applied',
  'interviewing',
  'offer',
  'accepted',
  'rejected',
  'withdrawn',
] as const;

export const ApplicationStatus = Schema.Literals(APPLICATION_STATUSES);

export type ApplicationStatus = typeof ApplicationStatus.Type;

/**
 * The Postgres enum's values, in its order (apps/api/src/modules/applications/schema.ts).
 * `screening` was folded into `interviewing` (ADR-0045) but stays in the enum until a later
 * release drops it: the release before the fold may still write it during a deploy or rollback.
 */
export const STORED_APPLICATION_STATUSES = [
  'saved',
  'applied',
  'screening',
  'interviewing',
  'offer',
  'accepted',
  'rejected',
  'withdrawn',
] as const;

export type StoredApplicationStatus = (typeof STORED_APPLICATION_STATUSES)[number];

/** What a stored status means now: `screening` reads as `interviewing`. */
export const currentStatus = (status: StoredApplicationStatus): ApplicationStatus =>
  status === 'screening' ? 'interviewing' : status;

/**
 * A status in a response. Decodes a stored `screening` as `interviewing`, so the web app keeps
 * working against a server from before the fold (a tab left open across a rollback).
 */
const ResponseStatus = Schema.Literals(STORED_APPLICATION_STATUSES).pipe(
  Schema.decodeTo(
    ApplicationStatus,
    new SchemaTransformation.Transformation(
      SchemaGetter.transform<ApplicationStatus, StoredApplicationStatus>(currentStatus),
      SchemaGetter.passthroughSubtype<StoredApplicationStatus, ApplicationStatus>(),
    ),
  ),
);

const MAX_TEXT = 200;

/**
 * Company and job title: 1–200 characters once trimmed. Trimmed in both directions: the server
 * trims what it receives, and the typed client trims what it sends. (`Schema.Trim` only trims on
 * decode, so the client would refuse to encode " Acme" from a form instead of sending "Acme".)
 */
const Text = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String.check(
      Schema.makeFilter((value: string) => {
        const length = value.trim().length;

        if (length === 0) return 'must not be blank';

        return length > MAX_TEXT ? `must be at most ${MAX_TEXT} characters` : undefined;
      }),
    ),
    new SchemaTransformation.Transformation(SchemaGetter.trim(), SchemaGetter.trim()),
  ),
);

const isWebUrl = (value: string) =>
  URL.canParse(value) && ['http:', 'https:'].includes(new URL(value).protocol);

/**
 * http(s) only: the web app renders it as a link, so `javascript:` or `data:` URLs would be a
 * stored-XSS path if React or the CSP ever stopped blocking them.
 */
const JobUrl = Schema.String.check(
  Schema.isMaxLength(2000),
  Schema.makeFilter((value: string) => (isWebUrl(value) ? undefined : 'must be an http(s) URL')),
);

export const CreateApplication = Schema.Struct({
  company: Text,
  jobTitle: Text,
  jobUrl: Schema.optional(Schema.NullOr(JobUrl)),
  status: Schema.optional(ApplicationStatus),
});

export type CreateApplication = typeof CreateApplication.Type;

export const UpdateApplication = Schema.Struct({
  company: Schema.optional(Text),
  jobTitle: Schema.optional(Text),
  jobUrl: Schema.optional(Schema.NullOr(JobUrl)),
  status: Schema.optional(ApplicationStatus),
}).check(
  Schema.makeFilter((value) =>
    Object.keys(value).length > 0 ? undefined : 'At least one field is required',
  ),
);

export type UpdateApplication = typeof UpdateApplication.Type;

/** An application as the API returns it: `Date`s in code, ISO 8601 strings on the wire. */
export const Application = Schema.Struct({
  id: Schema.String,
  company: Schema.String,
  jobTitle: Schema.String,
  jobUrl: Schema.NullOr(Schema.String),
  status: ResponseStatus,
  /**
   * When it was sent: null while `saved`. Set by the server, never by a request (ADR-0045). A
   * server from before the column leaves it out, which reads as null.
   */
  appliedAt: Schema.NullOr(Schema.DateFromString).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  createdAt: Schema.DateFromString,
  updatedAt: Schema.DateFromString,
});

export type Application = typeof Application.Type;

// Expected outcomes set ErrorReporter.ignore, or Sentry reports every 404 as an error
// (ADR-0022). contract.test.ts fails if a 4xx error forgets it.

/** A missing application, or another user's: always 404, never 403, so existence never leaks. */
export class ApplicationNotFound extends Schema.TaggedError<
  ApplicationNotFound,
  { readonly brand: unique symbol }
>()('ApplicationNotFound', {}, { httpApiStatus: 404 }) {
  readonly [ErrorReporter.ignore] = true;
}

/** An application's id: a UUID. */
const ApplicationId = Schema.String.check(Schema.isUUID());

/**
 * Whether `value` could be an application's id. The web app checks a URL's id with it, so a
 * malformed one shows "not found" without asking the server.
 */
export const isApplicationId = Schema.is(ApplicationId);

/** A malformed id fails the params schema: 400 (ADR-0022), before any handler runs. */
const IdParams = { id: ApplicationId };

export class ApplicationsApi extends HttpApiGroup.make('applications')
  .add(
    HttpApiEndpoint.get('list', '/', { success: Schema.Array(Application) }),
    HttpApiEndpoint.get('get', '/:id', {
      params: IdParams,
      success: Application,
      error: ApplicationNotFound,
    }),
    HttpApiEndpoint.post('create', '/', {
      payload: CreateApplication,
      success: Application.pipe(HttpApiSchema.status(201)),
    }),
    HttpApiEndpoint.patch('update', '/:id', {
      params: IdParams,
      payload: UpdateApplication,
      success: Application,
      error: ApplicationNotFound,
    }),
    HttpApiEndpoint.delete('delete', '/:id', {
      params: IdParams,
      success: HttpApiSchema.NoContent,
      error: ApplicationNotFound,
    }),
  )
  .middleware(Authorization)
  .prefix('/api/applications') {}
