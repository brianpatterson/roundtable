// For tests: an in-memory adapter of the contract's RoundtableApi (ADR-0071). The web modules
// call the API through the typed client; in tests, that client's `fetch` reaches this instead of
// a server. Its handlers are the contract's own groups (HttpApiBuilder), so params, payloads and
// answers are decoded and encoded by the contract's schemas, an endpoint without a handler here
// fails to compile, and no test matches paths of its own. Its rules are the contract's too
// (OPEN_APPLICATION_STATUSES, isUpcoming, inAgendaOrder, inRoundOrder, sameTag), never copies.
//
// It stores what it's told and infers nothing: no Outcome inference and no move to interviewing.
// A test that needs one seeds it, or makes the change in an override. Inference is tested on the
// real API (inference.test.ts, rounds.test.ts).
import { Cause, Effect, ErrorReporter, Layer, Option } from 'effect';
import {
  HttpEffect,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from 'effect/http';
import { HttpApiBuilder, HttpApiMiddleware } from 'effect/http-api';
import { afterEach, beforeEach, vi } from 'vitest';
import {
  ApplicationNotFound,
  Authorization,
  CurrentUser,
  MAX_PREP_TASKS,
  MAX_TAGS,
  OPEN_APPLICATION_STATUSES,
  OptionalSession,
  PrepTaskNotFound,
  ReportNotFound,
  RoundNotFound,
  RoundtableApi,
  SkillNotFound,
  TooManyPrepTasks,
  TooManyTags,
  Unauthorized,
  Viewer,
  inAgendaOrder,
  inRoundOrder,
  isUpcoming,
  sameTag,
  type AgendaQuery,
  type Application,
  type ApplicationStatus,
  type AuthProvider,
  type CreateApplication,
  type CreatePrepTask,
  type CreateReport,
  type CreateRound,
  type CreateSkill,
  type Round,
  type RoundOutcome,
  type RoundPrepNotes,
  type RoundRating,
  type RoundSchedule,
  type RoundTag,
  type Skill,
  type UpdateApplication,
  type UpdatePrepTask,
  type UpdateSkill,
} from '@roundtable/contract';

/** When factory-made Applications and Rounds were created, unless a test says otherwise. */
const CREATED = new Date('2026-11-01T00:00:00.000Z');

/** An Application with every field defaulted: a test names only what it cares about. */
export const application = (fields: Partial<Application> = {}): Application => ({
  id: crypto.randomUUID(),
  company: 'Acme',
  jobTitle: 'Engineer',
  jobUrl: null,
  status: 'applied',
  appliedAt: CREATED,
  createdAt: CREATED,
  updatedAt: CREATED,
  ...fields,
});

/** A Round with every field defaulted: a test names only what it cares about. */
export const round = (fields: Partial<Round> = {}): Round => ({
  id: crypto.randomUUID(),
  applicationId: crypto.randomUUID(),
  interviewType: 'coding',
  tags: [],
  startsAt: null,
  durationMinutes: null,
  dueOn: null,
  selfRating: null,
  ratingNote: null,
  outcome: 'pending',
  outcomeSetByUser: false,
  prepNotes: null,
  prepTasks: [],
  createdAt: CREATED,
  updatedAt: CREATED,
  ...fields,
});

/** A Skill with every field defaulted: a test names only what it cares about. */
export const skill = (fields: Partial<Skill> = {}): Skill => ({
  id: crypto.randomUUID(),
  name: 'System design',
  archivedAt: null,
  createdAt: CREATED,
  ...fields,
});

/** The signed-in user, as Better Auth's session answers it. */
export interface FakeUser {
  readonly id: string;
  readonly name: string;
  readonly email: string;
}

const ADA: FakeUser = { id: 'user-1', name: 'Ada', email: 'ada@example.com' };

type Params = { readonly id: string };

type RoundParams = { readonly id: string; readonly roundId: string };

type PrepTaskParams = RoundParams & { readonly taskId: string };

/**
 * What each endpoint received, as the contract decoded it: the payload, or the query, or the
 * params when that's all it has. Better Auth's own routes (outside the contract) record nothing.
 */
export interface Received {
  'system.health': object;
  'identity.authConfig': object;
  'applications.list': object;
  'applications.get': Params;
  'applications.create': CreateApplication;
  'applications.update': UpdateApplication;
  'applications.delete': Params;
  'applications.listRounds': Params;
  'applications.createRound': CreateRound;
  'applications.scheduleRound': RoundSchedule;
  'applications.rateRound': RoundRating;
  'applications.setRoundOutcome': RoundOutcome;
  'applications.deleteRound': RoundParams;
  'applications.addTag': RoundTag;
  'applications.removeTag': RoundTag;
  'applications.setPrepNotes': RoundPrepNotes;
  'applications.addPrepTask': CreatePrepTask;
  'applications.updatePrepTask': UpdatePrepTask;
  'applications.deletePrepTask': PrepTaskParams;
  'agenda.list': AgendaQuery;
  'skills.list': object;
  'skills.create': CreateSkill;
  'skills.update': UpdateSkill;
  'support.createReport': CreateReport;
  'factoryReports.get': Params;
  'auth.getSession': object;
  'auth.signIn': object;
  'auth.signOut': object;
}

export type Endpoint = keyof Received;

/**
 * Replaces an endpoint's answer until the next test: given the request (a copy, its body unread),
 * a Response to answer with (a 500, say), or nothing to go on to the in-memory answer. It can wait
 * first, to hold a request in flight.
 */
export type Override = (request: Request) => Response | undefined | Promise<Response | undefined>;

/** One request the fake received: which endpoint answered it (none if none did), and its status. */
export interface Call {
  readonly endpoint: Endpoint | undefined;
  readonly status: number;
}

/** A 500 from the fake that no override asked for: its answer broke the contract, or it crashed. */
export class FakeApiViolation extends Error {
  override readonly name = 'FakeApiViolation';
}

/** A 500, the way a server failing for a reason of its own answers. */
export const serverError = () => new Response(null, { status: 500 });

/** Each request's place in `calls`, so a handler can say which endpoint it was. */
const CALL_HEADER = 'x-fake-api-call';

const OPEN = new Set<ApplicationStatus>(OPEN_APPLICATION_STATUSES);

export function createFakeApi() {
  let applications: Application[] = [];
  let rounds: Round[] = [];
  let skills: Skill[] = [];
  let user: FakeUser | null = ADA;
  let protectedCallsLeft = Number.POSITIVE_INFINITY;
  let sessionNumber = 1;
  let providers: readonly AuthProvider[] = [];
  let reportCount = 0;
  const overrides = new Map<Endpoint, Override>();
  const received: { endpoint: Endpoint; input: Received[Endpoint] }[] = [];

  const calls: {
    endpoint: Endpoint | undefined;
    status: number;
    overridden: boolean;
    /** The request as sent, its body unread, for the endpoint's override. */
    request: Request;
  }[] = [];

  const violations: FakeApiViolation[] = [];
  /** Why the fake failed unexpectedly (an answer the contract can't encode, say), not yet told. */
  const failures: string[] = [];

  const findApplication = (id: string) => applications.find((a) => a.id === id);

  const findRound = ({ id, roundId }: RoundParams) =>
    rounds.find((r) => r.id === roundId && r.applicationId === id);

  const replaceRound = (changed: Round) => {
    rounds = rounds.map((r) => (r.id === changed.id ? changed : r));

    return changed;
  };

  /**
   * Notes that call `index` reached `endpoint` with `input`, and answers with the endpoint's
   * override when it has one that answers.
   */
  const overridden = async <E extends Endpoint>(endpoint: E, index: number, input: Received[E]) => {
    const call = calls[index];

    if (call) call.endpoint = endpoint;

    received.push({ endpoint, input });

    if (!call) return undefined;

    const response = await overrides.get(endpoint)?.(call.request);

    if (response) call.overridden = true;

    return response;
  };

  /** An endpoint's answer: its override's, or `inMemory`'s. */
  const answer = <N extends Endpoint, A, E, R>(
    endpoint: N,
    input: Received[N],
    inMemory: Effect.Effect<A, E, R>,
  ) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const index = Number(request.headers[CALL_HEADER]);
      const response = yield* Effect.promise(() => overridden(endpoint, index, input));

      if (response) return HttpServerResponse.fromWeb(response);

      return yield* inMemory;
    });

  const notFound = () => new ApplicationNotFound();

  const roundNotFound = () => new RoundNotFound();

  /** Changes Round `params` with `change`, or fails: not found. */
  const changeRound = (params: RoundParams, change: (round: Round) => Round) =>
    Effect.suspend(() => {
      const existing = findRound(params);

      return existing
        ? Effect.succeed(replaceRound({ ...change(existing), updatedAt: new Date() }))
        : Effect.fail(roundNotFound());
    });

  /**
   * Changes the Prep of Round `params` with `change`, or fails: the Round not found, whether it or
   * its Application is missing. Answers the Round as it is afterwards.
   */
  const changePrep = <E>(
    params: RoundParams,
    change: (round: Round) => Effect.Effect<Round, E>,
  ): Effect.Effect<Round, E | RoundNotFound> =>
    Effect.gen(function* () {
      const existing = findRound(params);

      if (!existing) return yield* roundNotFound();

      const changed = yield* change(existing);

      return replaceRound({ ...changed, updatedAt: new Date() });
    });

  /** A Skill id a prep task names: one the fake holds, archived or not, or `SkillNotFound`. */
  const checkSkill = (skillId: string | null | undefined) =>
    skillId === undefined || skillId === null || skills.some((s) => s.id === skillId)
      ? Effect.void
      : Effect.fail(new SkillNotFound());

  const SystemFake = HttpApiBuilder.group(RoundtableApi, 'system', (handlers) =>
    Effect.succeed(
      handlers.handle('health', () =>
        answer(
          'system.health',
          {},
          Effect.sync(() => ({ ok: true, db: 'up' as const, time: new Date().toISOString() })),
        ),
      ),
    ),
  );

  const IdentityFake = HttpApiBuilder.group(RoundtableApi, 'identity', (handlers) =>
    Effect.succeed(
      handlers.handle('authConfig', () =>
        answer(
          'identity.authConfig',
          {},
          Effect.sync(() => ({ providers })),
        ),
      ),
    ),
  );

  const ApplicationsFake = HttpApiBuilder.group(RoundtableApi, 'applications', (handlers) =>
    Effect.succeed(
      handlers.handleAll({
        // Most recently updated first, like the API.
        list: () =>
          answer(
            'applications.list',
            {},
            Effect.sync(() =>
              applications.toSorted((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()),
            ),
          ),

        get: ({ params }) =>
          answer(
            'applications.get',
            params,
            Effect.suspend(() => {
              const existing = findApplication(params.id);

              return existing ? Effect.succeed(existing) : Effect.fail(notFound());
            }),
          ),

        create: ({ payload }) =>
          answer(
            'applications.create',
            payload,
            Effect.sync(() => {
              const now = new Date();
              const status = payload.status ?? 'applied';

              const created = application({
                company: payload.company,
                jobTitle: payload.jobTitle,
                jobUrl: payload.jobUrl ?? null,
                status,
                // A saved application isn't sent yet; any other was sent now.
                appliedAt: status === 'saved' ? null : now,
                createdAt: now,
                updatedAt: now,
              });

              applications = [...applications, created];

              return created;
            }),
          ),

        // Stores the change and dates an application leaving `saved`. Infers nothing.
        update: ({ params, payload }) =>
          answer(
            'applications.update',
            payload,
            Effect.suspend(() => {
              const existing = findApplication(params.id);

              if (!existing) return Effect.fail(notFound());

              const { timeZone: _, ...changes } = payload;
              const now = new Date();
              const status = changes.status ?? existing.status;
              const appliedAt = status === 'saved' ? null : (existing.appliedAt ?? now);

              const updated: Application = {
                ...existing,
                ...changes,
                appliedAt: changes.status === undefined ? existing.appliedAt : appliedAt,
                updatedAt: now,
              };

              applications = applications.map((a) => (a.id === updated.id ? updated : a));

              return Effect.succeed(updated);
            }),
          ),

        delete: ({ params }) =>
          answer(
            'applications.delete',
            params,
            Effect.suspend(() => {
              if (!findApplication(params.id)) return Effect.fail(notFound());

              applications = applications.filter((a) => a.id !== params.id);
              rounds = rounds.filter((r) => r.applicationId !== params.id);

              return Effect.void;
            }),
          ),

        // Round order in UTC, like the API's list (ADR-0054).
        listRounds: ({ params }) =>
          answer(
            'applications.listRounds',
            params,
            Effect.suspend(() =>
              findApplication(params.id)
                ? Effect.succeed(
                    inRoundOrder(
                      rounds.filter((r) => r.applicationId === params.id),
                      'UTC',
                    ),
                  )
                : Effect.fail(notFound()),
            ),
          ),

        createRound: ({ params, payload }) =>
          answer(
            'applications.createRound',
            payload,
            Effect.suspend(() => {
              if (!findApplication(params.id)) return Effect.fail(notFound());

              const now = new Date();

              const created = round({
                applicationId: params.id,
                interviewType: payload.interviewType,
                startsAt: payload.startsAt ?? null,
                durationMinutes: payload.durationMinutes ?? null,
                dueOn: payload.dueOn ?? null,
                createdAt: now,
                updatedAt: now,
              });

              rounds = [...rounds, created];

              return Effect.succeed(created);
            }),
          ),

        // The whole schedule: what isn't given is cleared.
        scheduleRound: ({ params, payload }) =>
          answer(
            'applications.scheduleRound',
            payload,
            changeRound(params, (existing) => ({
              ...existing,
              startsAt: payload.startsAt ?? null,
              durationMinutes: payload.durationMinutes ?? null,
              dueOn: payload.dueOn ?? null,
            })),
          ),

        // The whole Self-rating: what isn't given is cleared, and so is a blank note.
        rateRound: ({ params, payload }) =>
          answer(
            'applications.rateRound',
            payload,
            changeRound(params, (existing) => ({
              ...existing,
              selfRating: payload.selfRating ?? null,
              ratingNote: payload.ratingNote?.trim() ? payload.ratingNote : null,
            })),
          ),

        setRoundOutcome: ({ params, payload }) =>
          answer(
            'applications.setRoundOutcome',
            payload,
            changeRound(params, (existing) => ({
              ...existing,
              outcome: payload.outcome,
              outcomeSetByUser: true,
            })),
          ),

        deleteRound: ({ params }) =>
          answer(
            'applications.deleteRound',
            params,
            Effect.suspend(() => {
              if (!findRound(params)) return Effect.fail(roundNotFound());

              rounds = rounds.filter((r) => r.id !== params.roundId);

              return Effect.void;
            }),
          ),

        // One it has already stays as it is; a full Round fails.
        addTag: ({ params, payload }) =>
          answer(
            'applications.addTag',
            payload,
            Effect.gen(function* () {
              const existing = findRound(params);

              if (!existing) return yield* roundNotFound();

              if (existing.tags.some((tag) => sameTag(tag, payload.tag))) return existing;

              if (existing.tags.length >= MAX_TAGS) return yield* new TooManyTags();

              return yield* changeRound(params, (r) => ({ ...r, tags: [...r.tags, payload.tag] }));
            }),
          ),

        removeTag: ({ params, query }) =>
          answer(
            'applications.removeTag',
            query,
            changeRound(params, (existing) => ({
              ...existing,
              tags: existing.tags.filter((tag) => !sameTag(tag, query.tag)),
            })),
          ),

        // A blank note is no note.
        setPrepNotes: ({ params, payload }) =>
          answer(
            'applications.setPrepNotes',
            payload,
            changePrep(params, (existing) =>
              Effect.succeed({
                ...existing,
                prepNotes: payload.notes?.trim() ? payload.notes : null,
              }),
            ),
          ),

        addPrepTask: ({ params, payload }) =>
          answer(
            'applications.addPrepTask',
            payload,
            changePrep(params, (existing) =>
              Effect.gen(function* () {
                if (existing.prepTasks.length >= MAX_PREP_TASKS) {
                  return yield* new TooManyPrepTasks();
                }

                yield* checkSkill(payload.skillId);

                const task = {
                  id: crypto.randomUUID(),
                  title: payload.title,
                  skillId: payload.skillId ?? null,
                  completedAt: null,
                };

                return { ...existing, prepTasks: [...existing.prepTasks, task] };
              }),
            ),
          ),

        updatePrepTask: ({ params, payload }) =>
          answer(
            'applications.updatePrepTask',
            payload,
            changePrep(params, (existing) =>
              Effect.gen(function* () {
                if (!existing.prepTasks.some((task) => task.id === params.taskId)) {
                  return yield* new PrepTaskNotFound();
                }

                yield* checkSkill(payload.skillId);

                const prepTasks = existing.prepTasks.map((task) =>
                  task.id === params.taskId
                    ? {
                        ...task,
                        title: payload.title ?? task.title,
                        skillId: payload.skillId === undefined ? task.skillId : payload.skillId,
                        completedAt:
                          payload.done === undefined
                            ? task.completedAt
                            : payload.done
                              ? (task.completedAt ?? new Date())
                              : null,
                      }
                    : task,
                );

                return { ...existing, prepTasks };
              }),
            ),
          ),

        deletePrepTask: ({ params }) =>
          answer(
            'applications.deletePrepTask',
            params,
            changePrep(params, (existing) =>
              existing.prepTasks.some((task) => task.id === params.taskId)
                ? Effect.succeed({
                    ...existing,
                    prepTasks: existing.prepTasks.filter((task) => task.id !== params.taskId),
                  })
                : Effect.fail(new PrepTaskNotFound()),
            ),
          ),
      }),
    ),
  );

  // The Agenda as the API answers it (ADR-0070): the upcoming Rounds of open Applications, in
  // Agenda order, with today in the user's time zone.
  const AgendaFake = HttpApiBuilder.group(RoundtableApi, 'agenda', (handlers) =>
    Effect.succeed(
      handlers.handle('list', ({ query }) =>
        answer(
          'agenda.list',
          query,
          Effect.sync(() => {
            const timeZone = query.timeZone ?? 'UTC';
            const now = new Date();

            // Without Prep notes: the Agenda doesn't carry them.
            const onAgenda = rounds.flatMap(({ prepNotes: _prepNotes, ...r }) => {
              const owner = findApplication(r.applicationId);

              return owner && OPEN.has(owner.status)
                ? [{ ...r, company: owner.company, jobTitle: owner.jobTitle }]
                : [];
            });

            return inAgendaOrder(
              onAgenda.filter((r) => isUpcoming(r, now, timeZone)),
              timeZone,
            );
          }),
        ),
      ),
    ),
  );

  // The skill library: stores what it's told. It enforces neither the name rule nor the limit
  // (the API's database does both); a test that needs a 409 or a 400 overrides the endpoint.
  const SkillsFake = HttpApiBuilder.group(RoundtableApi, 'skills', (handlers) =>
    Effect.succeed(
      handlers.handleAll({
        list: () =>
          answer(
            'skills.list',
            {},
            Effect.sync(() =>
              skills.toSorted((a, b) =>
                a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }),
              ),
            ),
          ),

        create: ({ payload }) =>
          answer(
            'skills.create',
            payload,
            Effect.sync(() => {
              const created = skill({ name: payload.name, createdAt: new Date() });

              skills = [...skills, created];

              return created;
            }),
          ),

        update: ({ params, payload }) =>
          answer(
            'skills.update',
            payload,
            Effect.suspend(() => {
              const existing = skills.find((s) => s.id === params.id);

              if (!existing) return Effect.fail(new SkillNotFound());

              const archivedAt =
                payload.archived === undefined
                  ? existing.archivedAt
                  : payload.archived
                    ? (existing.archivedAt ?? new Date())
                    : null;

              const updated: Skill = {
                ...existing,
                name: payload.name ?? existing.name,
                archivedAt,
              };

              skills = skills.map((s) => (s.id === updated.id ? updated : s));

              return Effect.succeed(updated);
            }),
          ),
      }),
    ),
  );

  const SupportFake = HttpApiBuilder.group(RoundtableApi, 'support', (handlers) =>
    Effect.succeed(
      handlers.handle('createReport', ({ payload }) =>
        answer(
          'support.createReport',
          payload,
          Effect.sync(() => {
            reportCount += 1;

            return { id: `report-${reportCount}` };
          }),
        ),
      ),
    ),
  );

  const FactoryReportsFake = HttpApiBuilder.group(RoundtableApi, 'factoryReports', (handlers) =>
    Effect.succeed(
      handlers.handle('get', ({ params }) =>
        answer('factoryReports.get', params, Effect.fail(new ReportNotFound())),
      ),
    ),
  );

  /** The session's user for a call behind Authorization; the session ends once its calls run out. */
  const sessionUser = () => {
    if (user && protectedCallsLeft <= 0) user = null;

    protectedCallsLeft -= 1;

    return user;
  };

  const AuthorizationFake = Layer.succeed(
    Authorization,
    Authorization.of((httpEffect) =>
      Effect.gen(function* () {
        const signedIn = sessionUser();

        if (!signedIn) return yield* new Unauthorized();

        return yield* Effect.provideService(httpEffect, CurrentUser, { id: signedIn.id });
      }),
    ),
  );

  const OptionalSessionFake = Layer.succeed(
    OptionalSession,
    OptionalSession.of((httpEffect) =>
      Effect.suspend(() =>
        Effect.provideService(
          httpEffect,
          Viewer,
          Option.fromNullishOr(user).pipe(Option.map(({ id }) => ({ id }))),
        ),
      ),
    ),
  );

  /** Better Auth's session, as its client reads it: each sign-in is a new one. */
  const sessionOf = (signedIn: FakeUser) => ({
    session: {
      id: `session-${sessionNumber}`,
      userId: signedIn.id,
      token: `token-${sessionNumber}`,
      expiresAt: '2099-01-01T00:00:00.000Z',
      createdAt: CREATED.toISOString(),
      updatedAt: CREATED.toISOString(),
    },
    user: {
      ...signedIn,
      emailVerified: true,
      createdAt: CREATED.toISOString(),
      updatedAt: CREATED.toISOString(),
    },
  });

  /** One of Better Auth's own routes, outside the contract, the way the identity module mounts it. */
  const authRoute = (path: HttpRouter.PathInput, endpoint: Endpoint, respond: () => Response) =>
    HttpRouter.add(
      '*',
      path,
      HttpEffect.fromWebHandler(async (request) => {
        const response = await overridden(endpoint, Number(request.headers.get(CALL_HEADER)), {});

        return response ?? respond();
      }),
    );

  const BetterAuthFake = Layer.mergeAll(
    authRoute('/api/auth/get-session', 'auth.getSession', () =>
      Response.json(user ? sessionOf(user) : null),
    ),
    // Any email and password sign in as Ada, for as long as the test needs.
    authRoute('/api/auth/sign-in/email', 'auth.signIn', () => {
      user = ADA;
      sessionNumber += 1;
      protectedCallsLeft = Number.POSITIVE_INFINITY;

      const { session, user: signedIn } = sessionOf(ADA);

      return Response.json({ redirect: false, token: session.token, user: signedIn });
    }),
    authRoute('/api/auth/sign-out', 'auth.signOut', () => {
      user = null;

      return Response.json({ success: true });
    }),
  );

  const api = HttpApiBuilder.layer(RoundtableApi).pipe(
    Layer.provide([
      SystemFake,
      IdentityFake,
      ApplicationsFake,
      AgendaFake,
      SkillsFake,
      SupportFake,
      FactoryReportsFake,
    ]),
    Layer.provide([AuthorizationFake, OptionalSessionFake]),
    // An answer that doesn't encode with the contract is a 500 that says why, like the API's.
    Layer.provide(HttpApiMiddleware.layerProblemDetails({ includeDetails: true })),
  );

  // The cause of each unexpected failure, so a violation says what was wrong, not only "500".
  const failureReporter = ErrorReporter.layer([
    ErrorReporter.make(({ cause }) => {
      failures.push(Cause.pretty(cause));
    }),
  ]);

  const { handler } = HttpRouter.toWebHandler(
    Layer.mergeAll(api, BetterAuthFake).pipe(
      Layer.provideMerge(failureReporter),
      Layer.provide(HttpServer.layerServices),
    ),
    { disableLogger: true },
  );

  /** For the typed client and Better Auth's: answers as the API would, from memory. */
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);

    const index =
      calls.push({ endpoint: undefined, status: 0, overridden: false, request: request.clone() }) -
      1;

    request.headers.set(CALL_HEADER, String(index));

    const response = await handler(request);
    const call = calls[index];

    if (call) call.status = response.status;

    if (response.status >= 500 && !call?.overridden) {
      const violation = new FakeApiViolation(
        `The fake API failed ${request.method} ${new URL(request.url).pathname} (${call?.endpoint ?? 'no endpoint'}): ${await response.text()}\n${failures.splice(0).join('\n')}`,
      );

      violations.push(violation);
      throw violation;
    }

    return response;
  };

  return {
    fetch,

    /** Adds an Application, every field defaulted, and returns it. */
    seedApplication(fields: Partial<Application> = {}) {
      const seeded = application(fields);

      applications = [...applications, seeded];

      return seeded;
    },

    /** Adds a Round to the Application `applicationId`, every field defaulted, and returns it. */
    seedRound(applicationId: string, fields: Partial<Round> = {}) {
      const seeded = round({ ...fields, applicationId });

      rounds = [...rounds, seeded];

      return seeded;
    },

    /** Adds a Skill, every field defaulted, and returns it. */
    seedSkill(fields: Partial<Skill> = {}) {
      const seeded = skill(fields);

      skills = [...skills, seeded];

      return seeded;
    },

    /** The Application `id` as the fake holds it now. */
    application: (id: string) => findApplication(id),

    /** The Application `applicationId`'s Rounds, in the order they were added. */
    rounds: (applicationId: string) => rounds.filter((r) => r.applicationId === applicationId),

    /** Changes an Application outside the app, as another tab would. */
    changeApplication(id: string, changes: Partial<Application>) {
      applications = applications.map((a) => (a.id === id ? { ...a, ...changes } : a));
    },

    /** Deletes an Application and its Rounds outside the app, as another tab would. */
    removeApplication(id: string) {
      applications = applications.filter((a) => a.id !== id);
      rounds = rounds.filter((r) => r.applicationId !== id);
    },

    /** Changes a Round outside the app, as another tab (or the API's inference) would. */
    changeRound(id: string, changes: Partial<Round>) {
      rounds = rounds.map((r) => (r.id === id ? { ...r, ...changes } : r));
    },

    /** Deletes a Round outside the app, as another tab would. */
    removeRound(id: string) {
      rounds = rounds.filter((r) => r.id !== id);
    },

    /** What `endpoint` received, oldest first, as the contract decoded it. */
    received<E extends Endpoint>(endpoint: E): Received[E][] {
      return received.flatMap((r) =>
        // SAFETY: `overridden` records each endpoint's own decoded input under its name.
        r.endpoint === endpoint ? [r.input as Received[E]] : [],
      );
    },

    /** Every request the fake received, oldest first. */
    calls: (): Call[] => calls.map(({ endpoint, status }) => ({ endpoint, status })),

    /** Overrides `endpoint`'s answer until the next test (see `Override`). */
    on(endpoint: Endpoint, override: Override) {
      overrides.set(endpoint, override);
    },

    /** Drops `endpoint`'s override: it answers from memory again. */
    off(endpoint: Endpoint) {
      overrides.delete(endpoint);
    },

    /** The social sign-in providers the sign-in page is offered. */
    offerProviders(offered: readonly AuthProvider[]) {
      providers = offered;
    },

    /** Signs the user out on the server: Better Auth's session answers null, the API 401. */
    endSession() {
      user = null;
    },

    /**
     * The session runs out after `calls` more calls behind Authorization: the next one answers 401
     * and Better Auth's session then answers null.
     */
    expireSessionAfter(callsLeft: number) {
      protectedCallsLeft = callsLeft;
    },

    /** The 500s the fake gave without an override asking, since the last check. */
    takeViolations: () => violations.splice(0),

    /** Empties the fake and drops every override: signed in as Ada, with nothing stored. */
    reset() {
      applications = [];
      rounds = [];
      skills = [];
      user = ADA;
      protectedCallsLeft = Number.POSITIVE_INFINITY;
      sessionNumber = 1;
      providers = [];
      reportCount = 0;
      overrides.clear();
      received.length = 0;
      calls.length = 0;
      violations.length = 0;
      failures.length = 0;
    },
  };
}

export type FakeApi = ReturnType<typeof createFakeApi>;

/**
 * A fake API for one test file: emptied before each test, with `fetch` pointing at it, and each
 * test failed afterwards if the fake broke the contract while answering it.
 */
export function setUpFakeApi() {
  const fake = createFakeApi();

  beforeEach(() => {
    fake.reset();
    vi.stubGlobal('fetch', fake.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();

    const [violation] = fake.takeViolations();

    if (violation) throw violation;
  });

  return fake;
}
