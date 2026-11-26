// The web app's API client (ADR-0022 step 5): generated from the contract (`../index.ts`), so
// every call, payload and response is typed by it, and request bodies are checked before sending.
// TanStack Query wants Promises, so this is where Effect ends on the web side: each call runs to a
// Promise that resolves with the decoded response or rejects with an ApiError.
//
// It lives here rather than in apps/web so the API tests can run it against the real server
// (apps/api/test/client.test.ts) without a browser.
import { Effect } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { HttpApiClient } from 'effect/http-api';
import {
  RoundtableApi,
  type CreateApplication,
  type CreatePersona,
  type CreatePrepTask,
  type CreateReport,
  type CreateRound,
  type CreateSkill,
  type RoundOutcome,
  type RoundRating,
  type RoundSchedule,
  type UpdateApplication,
  type UpdatePersona,
  type UpdatePrepTask,
  type UpdateSkill,
} from '../index.js';
import { toApiError } from './errors.js';

export { ApiError } from './errors.js';

export interface ApiClientOptions {
  /** Where the API is. The web app passes its own origin; paths already start with /api. */
  readonly baseUrl: string;
  /** Replaces the global fetch, e.g. to call a server in-process from tests. */
  readonly fetch?: typeof globalThis.fetch;
}

type Client = HttpApiClient.ForApi<typeof RoundtableApi>;

export function makeApiClient(options: ApiClientOptions) {
  const run = <A, E>(call: (client: Client) => Effect.Effect<A, E>): Promise<A> =>
    Effect.runPromise(
      HttpApiClient.make(RoundtableApi, { baseUrl: options.baseUrl }).pipe(
        Effect.flatMap(call),
        Effect.mapError(toApiError),
        Effect.catchDefect((defect) => Effect.fail(toApiError(defect))),
        Effect.provide(FetchHttpClient.layer),
        options.fetch ? Effect.provideService(FetchHttpClient.Fetch, options.fetch) : (e) => e,
      ),
    );

  return {
    authConfig: () => run((client) => client.identity.authConfig()),
    listApplications: () => run((client) => client.applications.list()),
    getApplication: (id: string) => run((client) => client.applications.get({ params: { id } })),
    createApplication: (payload: CreateApplication) =>
      run((client) => client.applications.create({ payload })),
    updateApplication: (id: string, payload: UpdateApplication) =>
      run((client) => client.applications.update({ params: { id }, payload })),
    deleteApplication: (id: string) =>
      run((client) => client.applications.delete({ params: { id } })),
    listRounds: (applicationId: string) =>
      run((client) => client.applications.listRounds({ params: { id: applicationId } })),
    createRound: (applicationId: string, payload: CreateRound) =>
      run((client) => client.applications.createRound({ params: { id: applicationId }, payload })),
    scheduleRound: (applicationId: string, roundId: string, payload: RoundSchedule) =>
      run((client) =>
        client.applications.scheduleRound({ params: { id: applicationId, roundId }, payload }),
      ),
    rateRound: (applicationId: string, roundId: string, payload: RoundRating) =>
      run((client) =>
        client.applications.rateRound({ params: { id: applicationId, roundId }, payload }),
      ),
    setRoundOutcome: (applicationId: string, roundId: string, payload: RoundOutcome) =>
      run((client) =>
        client.applications.setRoundOutcome({ params: { id: applicationId, roundId }, payload }),
      ),
    deleteRound: (applicationId: string, roundId: string) =>
      run((client) => client.applications.deleteRound({ params: { id: applicationId, roundId } })),
    addTag: (applicationId: string, roundId: string, tag: string) =>
      run((client) =>
        client.applications.addTag({ params: { id: applicationId, roundId }, payload: { tag } }),
      ),
    removeTag: (applicationId: string, roundId: string, tag: string) =>
      run((client) =>
        client.applications.removeTag({ params: { id: applicationId, roundId }, query: { tag } }),
      ),
    /** Sets a Round's Prep notes; blank or null clears them. */
    setPrepNotes: (applicationId: string, roundId: string, notes: string | null) =>
      run((client) =>
        client.applications.setPrepNotes({
          params: { id: applicationId, roundId },
          payload: { notes },
        }),
      ),
    addPrepTask: (applicationId: string, roundId: string, payload: CreatePrepTask) =>
      run((client) =>
        client.applications.addPrepTask({ params: { id: applicationId, roundId }, payload }),
      ),
    updatePrepTask: (
      applicationId: string,
      roundId: string,
      taskId: string,
      payload: UpdatePrepTask,
    ) =>
      run((client) =>
        client.applications.updatePrepTask({
          params: { id: applicationId, roundId, taskId },
          payload,
        }),
      ),
    deletePrepTask: (applicationId: string, roundId: string, taskId: string) =>
      run((client) =>
        client.applications.deletePrepTask({ params: { id: applicationId, roundId, taskId } }),
      ),
    /** The upcoming Rounds across open Applications, with today in `timeZone` (UTC without). */
    agenda: (timeZone?: string) =>
      run((client) => client.agenda.list({ query: timeZone === undefined ? {} : { timeZone } })),
    /** Every Skill of the user's, archived ones included, by name ignoring case. */
    listSkills: () => run((client) => client.skills.list()),
    createSkill: (payload: CreateSkill) => run((client) => client.skills.create({ payload })),
    /** Renames, archives (`archived: true`) or restores (`archived: false`) a Skill. */
    updateSkill: (id: string, payload: UpdateSkill) =>
      run((client) => client.skills.update({ params: { id }, payload })),
    /** Every Persona of the user's, archived ones included, by name ignoring case. */
    listPersonas: () => run((client) => client.personas.list()),
    createPersona: (payload: CreatePersona) => run((client) => client.personas.create({ payload })),
    /** Renames, archives (`archived: true`) or restores (`archived: false`) a Persona. */
    updatePersona: (id: string, payload: UpdatePersona) =>
      run((client) => client.personas.update({ params: { id }, payload })),
    addPersonaSkill: (id: string, skillId: string) =>
      run((client) => client.personas.addSkill({ params: { id }, payload: { skillId } })),
    removePersonaSkill: (id: string, skillId: string) =>
      run((client) => client.personas.removeSkill({ params: { id, skillId } })),
    createReport: (payload: CreateReport) =>
      run((client) => client.support.createReport({ payload })),
  };
}

export type ApiClient = ReturnType<typeof makeApiClient>;
