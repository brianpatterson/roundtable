// The applications module's contract: job applications, their Rounds, and their CRUD endpoints,
// all behind the identity module's Authorization middleware.
import { Effect, ErrorReporter, Schema, SchemaGetter, SchemaTransformation } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/http-api';
import { Authorization } from './identity.js';

/**
 * The stages an application can be in, in display order (ADR-0045). `saved` is a posting not yet
 * sent; every other status means it was sent, on its `appliedAt` date. The Postgres enum is made
 * from it (apps/api/src/modules/applications/schema.ts), in this order.
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
 * The statuses of an Application still in play: the Agenda shows their Rounds (ADR-0070). An
 * accepted, rejected or withdrawn one is over.
 */
export const OPEN_APPLICATION_STATUSES = [
  'saved',
  'applied',
  'interviewing',
  'offer',
] as const satisfies readonly ApplicationStatus[];

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

/**
 * Whether `value` names a time zone, like `America/New_York` or `UTC`: one `Intl` knows, written
 * as a name. An offset (`+05:30`) isn't one: places change offsets over the year.
 */
const isTimeZoneName = (value: string) => {
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/.test(value)) return false;

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });

    return true;
  } catch {
    return false;
  }
};

/**
 * The user's time zone, as the browser reports it. A request that changes what's inferred from a
 * Round's date sends it, so "the same day" is the user's day, not the server's. Without it, UTC.
 */
export const TimeZone = Schema.String.check(
  Schema.isMaxLength(64),
  Schema.makeFilter((value: string) => (isTimeZoneName(value) ? undefined : 'must be a time zone')),
);

/** Whether `value` is a time zone the API accepts. */
export const isTimeZone = Schema.is(TimeZone);

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
  /** The user's time zone: a change to rejected fails the latest Rounds of their day. */
  timeZone: Schema.optional(TimeZone),
}).check(
  Schema.makeFilter((value) =>
    Object.keys(value).some((key) => key !== 'timeZone')
      ? undefined
      : 'At least one field is required',
  ),
);

export type UpdateApplication = typeof UpdateApplication.Type;

/** An application as the API returns it: `Date`s in code, ISO 8601 strings on the wire. */
export const Application = Schema.Struct({
  id: Schema.String,
  company: Schema.String,
  jobTitle: Schema.String,
  jobUrl: Schema.NullOr(Schema.String),
  status: ApplicationStatus,
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
  /** The user's time zone: it puts a take-home's due day among the other Rounds. */
  timeZone: Schema.optional(TimeZone),
}).check(isConsistentSchedule);

export type CreateRound = typeof CreateRound.Type;

/** The most Tags one Round can have. */
export const MAX_TAGS = 10;

/** The most characters one Tag can have, once trimmed. */
export const MAX_TAG_LENGTH = 40;

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

/** A Self-rating's bounds: 1, it went badly, to 5, it went well. */
export const SELF_RATING = { minimum: 1, maximum: 5 } as const;

/** The longest note a Self-rating can have, in characters. */
export const MAX_RATING_NOTE = 2000;

const SelfRating = Schema.Int.check(Schema.isBetween(SELF_RATING));

const RatingNote = Schema.String.check(Schema.isMaxLength(MAX_RATING_NOTE));

/**
 * A Round's whole Self-rating (GLOSSARY.md), replacing the one it had: a score from 1 to 5 and a
 * note on what went wrong, each optional. What isn't given is cleared, so `{}` clears both, and a
 * blank note is no note.
 */
export const RoundRating = Schema.Struct({
  selfRating: Schema.optional(Schema.NullOr(SelfRating)),
  ratingNote: Schema.optional(Schema.NullOr(RatingNote)),
});

export type RoundRating = typeof RoundRating.Type;

/**
 * A Round's Outcome (GLOSSARY.md): whether the user advanced past it. `unknown` is never told.
 * The Postgres enum is made from it (apps/api/src/modules/applications/schema.ts), like
 * `INTERVIEW_TYPES`.
 */
export const OUTCOMES = ['pending', 'passed', 'failed', 'unknown'] as const;

export const Outcome = Schema.Literals(OUTCOMES);

export type Outcome = typeof Outcome.Type;

/** Sets a Round's Outcome, by the user: an inferred one never replaces it (ADR-0059). */
export const RoundOutcome = Schema.Struct({ outcome: Outcome });

export type RoundOutcome = typeof RoundOutcome.Type;

/** A field in a response. A server from before the field leaves it out: null. */
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
  /** The user's Self-rating of it, 1 (went badly) to 5 (went well), if they gave one. */
  selfRating: ResponseField(Schema.Int),
  /** Their note on what went wrong, if they wrote one. */
  ratingNote: ResponseField(Schema.String),
  /** Whether the user advanced past it. A server from before Outcomes leaves it out: pending. */
  outcome: Outcome.pipe(Schema.withDecodingDefaultKey(Effect.succeed('pending' as const))),
  /**
   * Whether the user set the Outcome (true) or it's still the one the Round started with or was
   * inferred (false). A server from before Outcomes leaves it out: false.
   */
  outcomeSetByUser: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  createdAt: Schema.DateFromString,
  updatedAt: Schema.DateFromString,
});

export type Round = typeof Round.Type;

/**
 * Whether a Round's Outcome was inferred (GLOSSARY.md): one the user didn't set that isn't the
 * pending every Round starts with. Only inference writes such a value (ADR-0061).
 */
export const isInferredOutcome = (round: Pick<Round, 'outcome' | 'outcomeSetByUser'>) =>
  !round.outcomeSetByUser && round.outcome !== 'pending';

// Round order (GLOSSARY.md): the order an Application's Rounds are listed in, in the user's time
// zone. Outcome inference in the API (ADR-0061) and the web's list both take it from here, so the
// order, and the time-zone arithmetic behind it, is defined once. The API's list keeps its own SQL
// order, by UTC days (ADR-0054).

/** What Round order reads of a Round: its start, or its due date, or neither. */
export type OrderedRound = Pick<Round, 'startsAt' | 'dueOn'>;

/** The calendar date and time an instant reads as in `timeZone`, as numbers. */
function zonedParts(instant: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(instant);

  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);

  return {
    year: part('year'),
    month: part('month'),
    day: part('day'),
    hour: part('hour'),
    minute: part('minute'),
    second: part('second'),
  };
}

/** How far `timeZone` is ahead of UTC at `instant`, in milliseconds. */
function offsetAt(instant: number, timeZone: string) {
  const { year, month, day, hour, minute, second } = zonedParts(instant, timeZone);
  const wallClock = Date.UTC(year, month - 1, day, hour, minute, second);

  return wallClock - (instant - (instant % 1000));
}

/** `2026-12-01` → the instant that day starts in `timeZone`. */
function startOfDay(date: string, timeZone: string) {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number);
  const midnightUtc = Date.UTC(year, month - 1, day);
  const guess = midnightUtc - offsetAt(midnightUtc, timeZone);

  // Again at the guess, in case an offset change falls between the two instants.
  return midnightUtc - offsetAt(guess, timeZone);
}

/** The calendar day an instant falls on in `timeZone`, `YYYY-MM-DD`. */
export function dayOf(instant: Date, timeZone: string) {
  const { year, month, day } = zonedParts(instant.getTime(), timeZone);

  return [year, month, day].map((n, i) => String(n).padStart(i === 0 ? 4 : 2, '0')).join('-');
}

/** When a Round sorts: its start, or the start of its due day in `timeZone`; none if unscheduled. */
const sortTime = ({ startsAt, dueOn }: OrderedRound, timeZone: string) =>
  startsAt?.getTime() ?? (dueOn === null ? null : startOfDay(dueOn, timeZone));

/**
 * The Rounds in Round order, as a sorted copy: dated ones first, a scheduled Round by its start
 * and a take-home by the start of its due day in `timeZone` (an IANA name, like `Asia/Tokyo`),
 * then the unscheduled ones. Rounds that tie keep the order given, so give them in the order they
 * were added.
 */
export function inRoundOrder<R extends OrderedRound>(rounds: readonly R[], timeZone: string): R[] {
  return rounds
    .map((round) => ({ round, time: sortTime(round, timeZone) }))
    .sort((a, b) => {
      if (a.time === null || b.time === null) {
        return (a.time === null ? 1 : 0) - (b.time === null ? 1 : 0);
      }

      return a.time - b.time;
    })
    .map(({ round }) => round);
}

/**
 * The calendar day a Round falls on in `timeZone`, `YYYY-MM-DD`: a take-home's due date as it is,
 * a scheduled Round's start as the user's day. Null for one not scheduled yet.
 */
export const roundDay = ({ startsAt, dueOn }: OrderedRound, timeZone: string): string | null =>
  dueOn ?? (startsAt ? dayOf(startsAt, timeZone) : null);

/**
 * A Round on the Agenda (GLOSSARY.md, ADR-0070): the Round, with its Application's company and job
 * title so it reads on its own. `applicationId` links to the Application.
 */
export const AgendaRound = Schema.Struct({
  ...Round.fields,
  company: Schema.String,
  jobTitle: Schema.String,
});

export type AgendaRound = typeof AgendaRound.Type;

/**
 * Agenda order, as a sorted copy: Round order in `timeZone` across Applications, where dated Rounds
 * at the same moment go by company. Undated Rounds come last in the order given, so give them in
 * the order they were added.
 */
export function inAgendaOrder<R extends OrderedRound & { readonly company: string }>(
  rounds: readonly R[],
  timeZone: string,
): R[] {
  const byCompany = (a: R, b: R) => a.company.localeCompare(b.company, 'en');
  const dated = rounds.filter((round) => roundDay(round, timeZone) !== null).sort(byCompany);
  const undated = rounds.filter((round) => roundDay(round, timeZone) === null);

  return [...inRoundOrder(dated, timeZone), ...undated];
}

/**
 * Whether a Round is upcoming at `now` (ADR-0070): on today or later in `timeZone`, so it stays
 * until its day ends even after it starts, or not scheduled yet.
 */
export const isUpcoming = (round: OrderedRound, now: Date, timeZone: string) => {
  const day = roundDay(round, timeZone);

  return day === null || day >= dayOf(now, timeZone);
};

/** The Agenda's query: the user's time zone, which says what today is. Without it, UTC. */
export const AgendaQuery = Schema.Struct({ timeZone: Schema.optional(TimeZone) });

export type AgendaQuery = typeof AgendaQuery.Type;

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
    // A change to rejected fails the latest pending Rounds whose Outcome the user hasn't set.
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
    // Adding the first Round of an applied application moves it to interviewing, and passes the
    // pending Rounds before it whose Outcome the user hasn't set.
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
    // Sets, changes or clears a Round's Self-rating and its note, as a whole.
    HttpApiEndpoint.put('rateRound', '/:id/rounds/:roundId/rating', {
      params: RoundParams,
      payload: RoundRating,
      success: Round,
      error: RoundNotFound,
    }),
    // Sets a Round's Outcome, and records that the user set it.
    HttpApiEndpoint.put('setRoundOutcome', '/:id/rounds/:roundId/outcome', {
      params: RoundParams,
      payload: RoundOutcome,
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

/**
 * The Agenda (ADR-0070): the user's upcoming Rounds across their open Applications, cut off by the
 * day in `timeZone`. Its path doesn't name the applications module, so it can move to its own.
 */
export class AgendaApi extends HttpApiGroup.make('agenda')
  .add(
    HttpApiEndpoint.get('list', '/', {
      query: AgendaQuery,
      success: Schema.Array(AgendaRound),
    }),
  )
  .middleware(Authorization)
  .prefix('/api/agenda') {}
