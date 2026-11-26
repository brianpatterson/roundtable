// An Application's Persona (GLOSSARY.md): which one it's made as, through the API, on the real
// database. The id is checked through personas' `Personas.findOwned` (ADR-0044).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Schema } from 'effect';
import {
  Application,
  ApplicationNotFound,
  PersonaArchived,
  PersonaNotFound,
} from '@roundtable/contract';
import { setupTestApp, signUp, type Json } from '#test/helpers';

const t = setupTestApp();
let cookie: string;

beforeAll(() => t.migrate());

beforeEach(async () => {
  await t.reset();
  ({ cookie } = await signUp(t));
});

afterAll(() => t.close());

type ApplicationJson = typeof Application.Encoded;

function request(method: 'GET' | 'POST' | 'PATCH', url: string, payload?: Json, as = cookie) {
  return t.inject({ method, url, payload, headers: { cookie: as } });
}

const MISSING_ID = '00000000-0000-4000-8000-000000000000';

async function createPersona(name: string, as = cookie) {
  const res = await request('POST', '/api/personas', { name }, as);

  expect(res.statusCode).toBe(201);

  return res.json<{ id: string }>().id;
}

async function archivePersona(id: string) {
  const res = await request('PATCH', `/api/personas/${id}`, { archived: true });

  expect(res.statusCode).toBe(200);
}

/** Creates an application, with `fields` added to the body, and answers the response. */
function create(fields: { readonly [key: string]: Json } = {}) {
  return request('POST', '/api/applications', { company: 'Acme', jobTitle: 'SWE', ...fields });
}

async function created(fields: { readonly [key: string]: Json } = {}) {
  const res = await create(fields);

  expect(res.statusCode).toBe(201);

  return res.json<ApplicationJson>();
}

const update = (id: string, payload: Json) => request('PATCH', `/api/applications/${id}`, payload);

const read = async (id: string) =>
  (await request('GET', `/api/applications/${id}`)).json<ApplicationJson>();

const expectError = (
  res: Awaited<ReturnType<typeof request>>,
  status: number,
  error: typeof ApplicationNotFound | typeof PersonaNotFound | typeof PersonaArchived,
) => {
  expect(res.statusCode).toBe(status);
  expect(() => Schema.decodeUnknownSync(error)(res.json())).not.toThrow();
};

describe('an Application’s Persona on create', () => {
  it('is the active Persona picked', async () => {
    const personaId = await createPersona('Backend engineer');

    const application = await created({ personaId });

    expect(application.personaId).toBe(personaId);
    expect((await read(application.id)).personaId).toBe(personaId);
  });

  it('is none without a personaId, or with null', async () => {
    expect((await created()).personaId).toBeNull();
    expect((await created({ personaId: null })).personaId).toBeNull();
  });

  it('refuses an archived Persona with 409, creating nothing', async () => {
    const personaId = await createPersona('Old persona');
    await archivePersona(personaId);

    expectError(await create({ personaId }), 409, PersonaArchived);
    expect((await request('GET', '/api/applications')).json()).toEqual([]);
  });

  it('refuses a Persona that doesn’t exist with 404', async () => {
    expectError(await create({ personaId: MISSING_ID }), 404, PersonaNotFound);
  });

  it('refuses a malformed Persona id with 400', async () => {
    expect((await create({ personaId: 'not-a-uuid' })).statusCode).toBe(400);
  });
});

describe('an Application’s Persona on update', () => {
  it('changes to another active Persona and clears with null, whatever the status', async () => {
    const first = await createPersona('Backend engineer');
    const second = await createPersona('Platform engineer');

    for (const status of ['saved', 'applied', 'rejected'] as const) {
      const { id } = await created({ status, personaId: first });

      const changed = await update(id, { personaId: second });

      expect(changed.statusCode).toBe(200);
      expect(changed.json<ApplicationJson>()).toMatchObject({ status, personaId: second });

      const cleared = await update(id, { personaId: null });

      expect(cleared.json<ApplicationJson>()).toMatchObject({ status, personaId: null });
      expect((await read(id)).personaId).toBeNull();
    }
  });

  it('refuses a newly picked archived Persona with 409, changing nothing', async () => {
    const kept = await createPersona('Backend engineer');
    const archived = await createPersona('Old persona');
    await archivePersona(archived);
    const { id } = await created({ personaId: kept });

    expectError(await update(id, { personaId: archived, company: 'Other' }), 409, PersonaArchived);
    expect(await read(id)).toMatchObject({ company: 'Acme', personaId: kept });
  });

  it('keeps a Persona archived since, updated without it or with the same id', async () => {
    const personaId = await createPersona('Backend engineer');
    const { id } = await created({ personaId });
    await archivePersona(personaId);

    const without = await update(id, { status: 'interviewing' });

    expect(without.statusCode).toBe(200);
    expect(without.json<ApplicationJson>().personaId).toBe(personaId);

    // The same id however it's written: a UUID's case doesn't change which one it is.
    for (const same of [personaId, personaId.toUpperCase()]) {
      const again = await update(id, { personaId: same, company: 'Acme Corp' });

      expect(again.statusCode).toBe(200);
      expect(again.json<ApplicationJson>().personaId).toBe(personaId);
    }

    // It's still returned, archived: the web app marks it.
    expect((await read(id)).personaId).toBe(personaId);
    expect((await request('GET', '/api/applications')).json<ApplicationJson[]>()).toMatchObject([
      { id, personaId },
    ]);
  });

  it('refuses a Persona that doesn’t exist with 404, and a malformed id with 400', async () => {
    const { id } = await created();

    expectError(await update(id, { personaId: MISSING_ID }), 404, PersonaNotFound);
    expect((await update(id, { personaId: 'not-a-uuid' })).statusCode).toBe(400);
    expect((await read(id)).personaId).toBeNull();
  });

  it('answers ApplicationNotFound for a missing Application with the user’s own Persona', async () => {
    const personaId = await createPersona('Backend engineer');

    expectError(await update(MISSING_ID, { personaId }), 404, ApplicationNotFound);
  });
});

// CLAUDE.md rule 8: another user's Persona is a 404, never a 403, and nothing is stored.
describe('another user’s Persona', () => {
  it('is PersonaNotFound on create and on update', async () => {
    const other = await signUp(t, 'other@example.com');
    const theirs = await createPersona('Their persona', other.cookie);
    const { id } = await created();

    expectError(await create({ personaId: theirs }), 404, PersonaNotFound);
    expectError(await update(id, { personaId: theirs }), 404, PersonaNotFound);
    expect((await request('GET', '/api/applications')).json<ApplicationJson[]>()).toMatchObject([
      { id, personaId: null },
    ]);
  });
});
