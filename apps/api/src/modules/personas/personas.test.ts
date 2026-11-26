import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { Effect, Exit, Layer, Schema } from 'effect';
import {
  MAX_PERSONA_SKILLS,
  Persona,
  PersonaNotFound,
  SkillArchived,
  SkillNotFound,
  TooManyPersonaSkills,
} from '@roundtable/contract';
import { Database } from '../../platform/database/effect.js';
import { env, setupTestApp, signUp, type InjectResponse, type Json } from '#test/helpers';
import { users } from '../identity/index.js';
import { Personas } from './index.js';
import { personaSkills, skills } from './schema.js';

const t = setupTestApp();
let cookie: string;
let userId: string;

beforeAll(() => t.migrate());

beforeEach(async () => {
  await t.reset();
  ({
    cookie,
    user: { id: userId },
  } = await signUp(t));
});

afterAll(() => t.close());

// Responses as they arrive on the wire: dates are still ISO 8601 strings.
type PersonaJson = typeof Persona.Encoded;

function request(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: Json,
  as = cookie,
) {
  return t.inject({ method, url, payload, headers: { cookie: as } });
}

const create = (name: Json, as = cookie) => request('POST', '/api/personas', { name }, as);

async function created(name: string, as = cookie) {
  const res = await create(name, as);

  expect(res.statusCode).toBe(201);

  return res.json<PersonaJson>();
}

const patch = (id: string, payload: Json, as = cookie) =>
  request('PATCH', `/api/personas/${id}`, payload, as);

const addSkill = (id: string, skillId: string, as = cookie) =>
  request('POST', `/api/personas/${id}/skills`, { skillId }, as);

const removeSkill = (id: string, skillId: string, as = cookie) =>
  request('DELETE', `/api/personas/${id}/skills/${skillId}`, undefined, as);

/** A Skill of the user's, through the skill library's own endpoint. */
async function skill(name: string, as = cookie) {
  const res = await request('POST', '/api/skills', { name }, as);

  expect(res.statusCode).toBe(201);

  return res.json<{ id: string }>().id;
}

const archiveSkill = (id: string) => request('PATCH', `/api/skills/${id}`, { archived: true });

/** An error response, decoded as the typed client decodes it. */
const decodedError = (res: InjectResponse) =>
  Schema.decodeUnknownSync(
    Schema.Union([PersonaNotFound, TooManyPersonaSkills, SkillArchived, SkillNotFound]),
  )(res.json());

const list = async (as = cookie) =>
  (await request('GET', '/api/personas', undefined, as)).json<PersonaJson[]>();

// The Library rules a Persona shares with Skills (names, the limit, archiving, another user's) are
// in library.test.ts. These are what a Persona answers with beyond them: its Skills.
describe('a Persona as the Library answers it', () => {
  it('lists each with its Skills', async () => {
    const sql = await skill('SQL');
    const backend = await created('Backend engineer');
    await created('data engineer');

    await addSkill(backend.id, sql);

    const personaList = await list();

    expect(personaList.map((p) => p.skillIds)).toEqual([[sql], []]);
    expect(() => Schema.decodeSync(Schema.Array(Persona))(personaList)).not.toThrow();
  });

  it('answers a change with its Skills', async () => {
    const persona = await created('Backend engineer');
    const sql = await skill('SQL');

    await addSkill(persona.id, sql);

    expect((await patch(persona.id, { name: 'Backend' })).json<PersonaJson>().skillIds).toEqual([
      sql,
    ]);
  });
});

describe('a Persona’s Skills', () => {
  it('adds an active Skill of the user’s: 200 with the Persona', async () => {
    const persona = await created('Backend engineer');
    const sql = await skill('SQL');

    const res = await addSkill(persona.id, sql);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ...persona, skillIds: [sql] });
    expect((await list())[0]?.skillIds).toEqual([sql]);
  });

  it('adds a Skill it has already as a no-op', async () => {
    const persona = await created('Backend engineer');
    const sql = await skill('SQL');

    await addSkill(persona.id, sql);

    const res = await addSkill(persona.id, sql);

    expect(res.statusCode).toBe(200);
    expect(res.json<PersonaJson>().skillIds).toEqual([sql]);
  });

  it('refuses an archived Skill it doesn’t have: 409 SkillArchived', async () => {
    const persona = await created('Backend engineer');
    const sql = await skill('SQL');

    await archiveSkill(sql);

    const res = await addSkill(persona.id, sql);

    expect(res.statusCode).toBe(409);
    expect(Schema.is(SkillArchived)(decodedError(res))).toBe(true);
    expect((await list())[0]?.skillIds).toEqual([]);
  });

  it('keeps an archived Skill it has, and adding it again changes nothing', async () => {
    const persona = await created('Backend engineer');
    const sql = await skill('SQL');

    await addSkill(persona.id, sql);
    await archiveSkill(sql);

    expect((await list())[0]?.skillIds).toEqual([sql]);

    const again = await addSkill(persona.id, sql);

    expect(again.statusCode).toBe(200);
    expect(again.json<PersonaJson>().skillIds).toEqual([sql]);
  });

  it(`refuses a Skill past ${MAX_PERSONA_SKILLS}: 400 TooManyPersonaSkills`, async () => {
    const persona = await created('Backend engineer');

    const library = await t.db
      .insert(skills)
      .values(Array.from({ length: MAX_PERSONA_SKILLS + 1 }, (_, i) => ({ userId, name: `S${i}` })))
      .returning({ id: skills.id });

    await t.db
      .insert(personaSkills)
      .values(
        library
          .slice(0, MAX_PERSONA_SKILLS)
          .map(({ id }) => ({ personaId: persona.id, skillId: id })),
      );

    const last = library[MAX_PERSONA_SKILLS]?.id ?? '';

    const res = await addSkill(persona.id, last);

    expect(res.statusCode).toBe(400);
    expect(Schema.is(TooManyPersonaSkills)(decodedError(res))).toBe(true);
    expect((await list())[0]?.skillIds).toHaveLength(MAX_PERSONA_SKILLS);
  });

  it('adds only one of two Skills sent at once at the limit, and both of one Skill once', async () => {
    const persona = await created('Backend engineer');

    const library = await t.db
      .insert(skills)
      .values(Array.from({ length: MAX_PERSONA_SKILLS + 1 }, (_, i) => ({ userId, name: `S${i}` })))
      .returning({ id: skills.id });

    const ids = library.map(({ id }) => id);

    const same = await Promise.all([
      addSkill(persona.id, ids[0] ?? ''),
      addSkill(persona.id, ids[0] ?? ''),
    ]);

    expect(same.map((res) => res.statusCode)).toEqual([200, 200]);

    await t.db
      .insert(personaSkills)
      .values(
        ids.slice(1, MAX_PERSONA_SKILLS - 1).map((skillId) => ({ personaId: persona.id, skillId })),
      );

    const results = await Promise.all([
      addSkill(persona.id, ids[MAX_PERSONA_SKILLS - 1] ?? ''),
      addSkill(persona.id, ids[MAX_PERSONA_SKILLS] ?? ''),
    ]);

    expect(results.map((res) => res.statusCode).sort()).toEqual([200, 400]);
  });

  it('lists skillIds in Skill name order, ignoring case', async () => {
    const persona = await created('Backend engineer');
    const sql = await skill('SQL');
    const algorithms = await skill('algorithms');
    const behavioral = await skill('Behavioral stories');

    await addSkill(persona.id, sql);
    await addSkill(persona.id, algorithms);

    const res = await addSkill(persona.id, behavioral);

    expect(res.json<PersonaJson>().skillIds).toEqual([algorithms, behavioral, sql]);

    // Renaming a Skill reorders it.
    await request('PATCH', `/api/skills/${sql}`, { name: 'Architecture' });

    expect((await list())[0]?.skillIds).toEqual([algorithms, sql, behavioral]);
  });

  it('removes a Skill: 200 with the Persona without it', async () => {
    const persona = await created('Backend engineer');
    const sql = await skill('SQL');
    const algorithms = await skill('Algorithms');

    await addSkill(persona.id, sql);
    await addSkill(persona.id, algorithms);

    const res = await removeSkill(persona.id, sql);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ...persona, skillIds: [algorithms] });
  });

  it('removes a Skill it doesn’t have as a no-op', async () => {
    const persona = await created('Backend engineer');
    const sql = await skill('SQL');

    const res = await removeSkill(persona.id, sql);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(persona);
  });

  it('adds and removes Skills on an archived Persona, and renames it', async () => {
    const persona = await created('Backend engineer');
    const sql = await skill('SQL');

    await patch(persona.id, { archived: true });

    expect((await addSkill(persona.id, sql)).json<PersonaJson>().skillIds).toEqual([sql]);
    expect((await removeSkill(persona.id, sql)).json<PersonaJson>().skillIds).toEqual([]);

    const renamed = await patch(persona.id, { name: 'Backend' });

    expect(renamed.statusCode).toBe(200);
    expect(renamed.json<PersonaJson>()).toMatchObject({
      name: 'Backend',
      archivedAt: expect.any(String),
    });
  });

  it('answers 404 PersonaNotFound for another user’s Persona, and leaves it alone', async () => {
    const persona = await created('Backend engineer');
    const sql = await skill('SQL');

    await addSkill(persona.id, sql);

    const other = await signUp(t);
    const theirs = await skill('SQL', other.cookie);

    for (const res of [
      await addSkill(persona.id, theirs, other.cookie),
      await removeSkill(persona.id, theirs, other.cookie),
      await removeSkill(persona.id, sql, other.cookie),
    ]) {
      expect(res.statusCode).toBe(404);
      expect(Schema.is(PersonaNotFound)(decodedError(res))).toBe(true);
    }

    expect((await list())[0]?.skillIds).toEqual([sql]);
  });

  it('answers 404 SkillNotFound for another user’s Skill on the user’s Persona', async () => {
    const persona = await created('Backend engineer');
    const other = await signUp(t);
    const theirs = await skill('SQL', other.cookie);

    for (const res of [await addSkill(persona.id, theirs), await removeSkill(persona.id, theirs)]) {
      expect(res.statusCode).toBe(404);
      expect(Schema.is(SkillNotFound)(decodedError(res))).toBe(true);
    }

    expect((await list())[0]?.skillIds).toEqual([]);
  });

  it('answers 404 for a Skill or Persona that doesn’t exist', async () => {
    const persona = await created('Backend engineer');
    const sql = await skill('SQL');

    expect((await addSkill(persona.id, crypto.randomUUID())).statusCode).toBe(404);
    expect((await addSkill(crypto.randomUUID(), sql)).statusCode).toBe(404);
    expect((await removeSkill(crypto.randomUUID(), sql)).statusCode).toBe(404);
  });

  it('answers 400 for a malformed id', async () => {
    const persona = await created('Backend engineer');
    const sql = await skill('SQL');

    expect((await addSkill('not-a-uuid', sql)).statusCode).toBe(400);
    expect((await addSkill(persona.id, 'not-a-uuid')).statusCode).toBe(400);
    expect((await removeSkill('not-a-uuid', sql)).statusCode).toBe(400);
    expect((await removeSkill(persona.id, 'not-a-uuid')).statusCode).toBe(400);
  });
});

describe('what a Persona can’t do', () => {
  it('goes with its Skill links when the account is deleted', async () => {
    const persona = await created('Backend engineer');

    await addSkill(persona.id, await skill('SQL'));

    await t.db.delete(users).where(eq(users.id, userId));

    expect(
      await t.db
        .select()
        .from(personaSkills)
        .where(inArray(personaSkills.personaId, [persona.id])),
    ).toEqual([]);
  });
});

describe('without a session', () => {
  const id = crypto.randomUUID();
  const skillId = crypto.randomUUID();

  it.each([
    ['POST', `/api/personas/${id}/skills`, { skillId }],
    ['DELETE', `/api/personas/${id}/skills/${skillId}`, undefined],
  ] as const)('%s %s answers 401', async (method, url, payload) => {
    expect((await t.inject({ method, url, payload })).statusCode).toBe(401);
  });
});

// What another module uses to check a Persona id before storing it (ADR-0044 rule 1).
describe('Personas.findOwned', () => {
  const findOwned = (owner: string, id: string) =>
    Effect.runPromiseExit(
      Personas.use((service) => service.findOwned(owner, id)).pipe(
        Effect.provide(Personas.layer.pipe(Layer.provide(Database.layer(env.DATABASE_URL)))),
      ),
    );

  it('finds the user’s Persona, archived or not, with its Skills', async () => {
    const active = await created('Backend engineer');
    const archived = await created('Mobile');
    const sql = await skill('SQL');

    await patch(archived.id, { archived: true });
    await addSkill(active.id, sql);

    const found = await findOwned(userId, active.id);
    const foundArchived = await findOwned(userId, archived.id);

    expect(Exit.isSuccess(found) && Schema.encodeSync(Persona)(found.value)).toEqual({
      ...active,
      skillIds: [sql],
    });
    expect(Exit.isSuccess(foundArchived) && foundArchived.value.archivedAt).toBeInstanceOf(Date);
  });
});
