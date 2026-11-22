// The applications module's contract: job applications, their Rounds, and their CRUD endpoints,
// all behind the identity module's Authorization middleware.
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

/**
 * What a Round tests (GLOSSARY.md), in display order. Fixed, so analytics can compare like with
 * like. The Postgres enum is made from it (apps/api/src/modules/applications/schema.ts): a new
 * type needs a migration, and removing one needs expand/contract (ADR-0014).
 */
export const INTERVIEW_TYPES = [
  'recruiter_screen',
  'hiring_manager',
  'coding',
  'system_design',
  'behavioral',
  'take_home',
  'presentation',
  'other',
] as const;

export const InterviewType = Schema.Literals(INTERVIEW_TYPES);

export type InterviewType = typeof InterviewType.Type;

/** A duration's bounds, in whole minutes: a five-minute call to an eight-hour onsite. */
export const ROUND_DURATION_MINUTES = { minimum: 5, maximum: 480 } as const;

/** The earliest date a Round can have, and the latest: a date Postgres stores as given. */
const EARLIEST = '1970-01-01';

const LATEST = '9999-12-31';

/**
 * When a scheduled Round starts: an instant, an ISO 8601 string on the wire. The web app turns the
 * user's local date and time into it, and shows it back in their time zone.
 */
const StartsAt = Schema.DateFromString.check(
  Schema.isBetweenDate({
    minimum: new Date(`${EARLIEST}T00:00:00Z`),
    maximum: new Date(`${LATEST}T23:59:59Z`),
  }),
);

const DurationMinutes = Schema.Int.check(Schema.isBetween(ROUND_DURATION_MINUTES));

/** `2026-11-25`: a real calendar date in Postgres's range, with no time and no time zone. */
const isCalendarDate = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < EARLIEST) return false;

  const time = Date.parse(`${value}T00:00:00Z`);

  // `Date.parse` rolls 2026-02-30 over to March, so the date must come back unchanged.
  return !Number.isNaN(time) && new Date(time).toISOString().startsWith(value);
};

/** When a take-home is due: a calendar date (`YYYY-MM-DD`), the same wherever the user is. */
const DueOn = Schema.String.check(
  Schema.makeFilter((value: string) =>
    isCalendarDate(value) ? undefined : 'must be a date (YYYY-MM-DD)',
  ),
);

/**
 * A Round's schedule (GLOSSARY.md): a start, with a duration when the company gave one; a due date
 * (a take-home); or neither, not scheduled yet. Null and absent mean the same: not set.
 */
const scheduleFields = {
  startsAt: Schema.optional(Schema.NullOr(StartsAt)),
  durationMinutes: Schema.optional(Schema.NullOr(DurationMinutes)),
  dueOn: Schema.optional(Schema.NullOr(DueOn)),
};

interface ScheduleFields {
  readonly startsAt?: Date | null | undefined;
  readonly durationMinutes?: number | null | undefined;
  readonly dueOn?: string | null | undefined;
}

/** A start and a due date can't both be set, and a duration needs a start. */
const isConsistentSchedule = Schema.makeFilter((value: ScheduleFields) => {
  const starts = value.startsAt !== undefined && value.startsAt !== null;

  if (starts && value.dueOn !== undefined && value.dueOn !== null) {
    return 'A round has a start time or a due date, not both';
  }

  const hasDuration = value.durationMinutes !== undefined && value.durationMinutes !== null;

  return hasDuration && !starts ? 'A duration needs a start time' : undefined;
});

export const CreateRound = Schema.Struct({
  interviewType: InterviewType,
  ...scheduleFields,
}).check(isConsistentSchedule);

export type CreateRound = typeof CreateRound.Type;

/** The most Tags one Round can have. */
export const MAX_TAGS = 10;

const MAX_TAG_LENGTH = 40;

/**
 * A Tag (GLOSSARY.md): free-form detail the Interview type doesn't carry, 1–40 characters once
 * trimmed. Trimmed in both directions, like `Text`.
 */
export const Tag = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String.check(
      Schema.makeFilter((value: string) => {
        const length = value.trim().length;

        if (length === 0) return 'must not be blank';

        return length > MAX_TAG_LENGTH ? `must be at most ${MAX_TAG_LENGTH} characters` : undefined;
      }),
    ),
    new SchemaTransformation.Transformation(SchemaGetter.trim(), SchemaGetter.trim()),
  ),
);

/** Adds a Tag to a Round, or one in the request's path to remove. */
export const RoundTag = Schema.Struct({ tag: Tag });

export type RoundTag = typeof RoundTag.Type;

/** Whether two Tags are the same one: case and surrounding spaces don't count. */
export const sameTag = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * A Round's whole schedule, replacing the one it had: what isn't given is cleared, so `{}` makes
 * it not scheduled yet.
 */
export const RoundSchedule = Schema.Struct(scheduleFields).check(isConsistentSchedule);

export type RoundSchedule = typeof RoundSchedule.Type;

/** A schedule field in a response. A server from before the schedule leaves it out: null. */
const ResponseField = <S extends Schema.Top>(schema: S) =>
  Schema.NullOr(schema).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null)));

/** A Round as the API returns it: one interview within an Application. */
export const Round = Schema.Struct({
  id: Schema.String,
  applicationId: Schema.String,
  interviewType: InterviewType,
  /**
   * Its Tags, in the order they were added, none the same as another. A server from before Tags
   * leaves them out, which reads as none.
   */
  tags: Schema.Array(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  /** When it starts, if it's scheduled. */
  startsAt: ResponseField(Schema.DateFromString),
  /** How long it lasts, in minutes: only with a start, and only when the company said. */
  durationMinutes: ResponseField(Schema.Int),
  /** When it's due (a take-home), as `YYYY-MM-DD`. Never set with a start. */
  dueOn: ResponseField(Schema.String),
  createdAt: Schema.DateFromString,
  updatedAt: Schema.DateFromString,
});

export type Round = typeof Round.Type;

/**
 * A missing Round, one of another application, or one of another user's: always 404, never 403.
 */
export class RoundNotFound extends Schema.TaggedError<
  RoundNotFound,
  { readonly brand: unique symbol }
>()('RoundNotFound', {}, { httpApiStatus: 404 }) {
  readonly [ErrorReporter.ignore] = true;
}

/** A Round already has `MAX_TAGS` Tags, so a new one can't be added: a 400, like a bad body. */
export class TooManyTags extends Schema.TaggedError<
  TooManyTags,
  { readonly brand: unique symbol }
>()('TooManyTags', {}, { httpApiStatus: 400 }) {
  readonly [ErrorReporter.ignore] = true;
}

/** A Round's path: its application's id and its own, both UUIDs; a malformed one is a 400. */
const RoundParams = { id: ApplicationId, roundId: Schema.String.check(Schema.isUUID()) };

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
    // An application's Rounds: dated ones first, in date order, then the rest in the order they
    // were added.
    HttpApiEndpoint.get('listRounds', '/:id/rounds', {
      params: IdParams,
      success: Schema.Array(Round),
      error: ApplicationNotFound,
    }),
    // Adding the first Round of an applied application moves it to interviewing.
    HttpApiEndpoint.post('createRound', '/:id/rounds', {
      params: IdParams,
      payload: CreateRound,
      success: Round.pipe(HttpApiSchema.status(201)),
      error: ApplicationNotFound,
    }),
    // Sets, changes or clears a Round's schedule, as a whole.
    HttpApiEndpoint.put('scheduleRound', '/:id/rounds/:roundId/schedule', {
      params: RoundParams,
      payload: RoundSchedule,
      success: Round,
      error: RoundNotFound,
    }),
    HttpApiEndpoint.delete('deleteRound', '/:id/rounds/:roundId', {
      params: RoundParams,
      success: HttpApiSchema.NoContent,
      error: RoundNotFound,
    }),
    // Adds a Tag to a Round. One the Round already has (ignoring case and surrounding spaces) is
    // left as it is. Answers the Round with its Tags.
    HttpApiEndpoint.post('addTag', '/:id/rounds/:roundId/tags', {
      params: RoundParams,
      payload: RoundTag,
      success: Round,
      error: [RoundNotFound, TooManyTags],
    }),
    // Removes a Tag from a Round, matched ignoring case. One it doesn't have is already gone.
    // The Tag is in the query string: it's free-form, and a `/` in a path segment can't be.
    HttpApiEndpoint.delete('removeTag', '/:id/rounds/:roundId/tags', {
      params: RoundParams,
      query: RoundTag,
      success: Round,
      error: RoundNotFound,
    }),
  )
  .middleware(Authorization)
  .prefix('/api/applications') {}
