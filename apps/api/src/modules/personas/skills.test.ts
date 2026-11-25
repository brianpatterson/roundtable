import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { Cause, Effect, Exit, Layer, Schema } from 'effect';
import {
  MAX_SKILLS,
  Skill,
  SkillNameTaken,
  SkillNotFound,
  TooManySkills,
} from '@roundtable/contract';
import { Database } from '../../platform/database/effect.js';
import { env, setupTestApp, signUp, type InjectResponse, type Json } from '#test/helpers';
import { users } from '../identity/index.js';
import { Skills, skills } from './index.js';

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
type SkillJson = typeof Skill.Encoded;

function request(method: 'GET' | 'POST' | 'PATCH', url: string, payload?: Json, as = cookie) {
  return t.inject({ method, url, payload, headers: { cookie: as } });
}

const create = (name: Json, as = cookie) => request('POST', '/api/skills', { name }, as);

async function created(name: string) {
  const res = await create(name);

  expect(res.statusCode).toBe(201);

  return res.json<SkillJson>();
}

const patch = (id: string, payload: Json, as = cookie) =>
  request('PATCH', `/api/skills/${id}`, payload, as);

/** An error response, decoded as the typed client decodes it. */
const decodedError = (res: InjectResponse) =>
  Schema.decodeUnknownSync(Schema.Union([SkillNameTaken, SkillNotFound, TooManySkills]))(
    res.json(),
  );

/** A `SkillNameTaken` response's fields; fails the test for any other body. */
const nameTaken = (res: InjectResponse) => ({
  archived: Schema.decodeUnknownSync(SkillNameTaken)(res.json()).archived,
});

const list = async () => (await request('GET', '/api/skills')).json<SkillJson[]>();

describe('adding a Skill', () => {
  it('answers 201 with the Skill', async () => {
    const res = await create('System design');

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      id: expect.any(String),
      name: 'System design',
      archivedAt: null,
      createdAt: expect.any(String),
    });
    expect(() => Schema.decodeUnknownSync(Skill)(res.json())).not.toThrow();
  });

  it('stores the name trimmed', async () => {
    expect((await created('  System design \n')).name).toBe('System design');
    expect((await list()).map((s) => s.name)).toEqual(['System design']);
  });

  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['over 80 characters', 'x'.repeat(81)],
    ['not a string', 5],
  ])('refuses a name that is %s: 400', async (_case, name) => {
    expect((await create(name)).statusCode).toBe(400);
    expect(await list()).toEqual([]);
  });

  it('accepts 80 characters', async () => {
    expect((await create('x'.repeat(80))).statusCode).toBe(201);
  });

  it('refuses a name the user has, in any case and with spaces: 409 SkillNameTaken', async () => {
    await created('System design');

    const res = await create('  system DESIGN ');

    expect(res.statusCode).toBe(409);
    expect(nameTaken(res)).toEqual({ archived: false });
    expect(await list()).toHaveLength(1);
  });

  it('refuses the name of an archived Skill too, saying it is archived', async () => {
    const skill = await created('System design');

    await patch(skill.id, { archived: true });

    const res = await create('System Design');

    expect(res.statusCode).toBe(409);
    expect(nameTaken(res)).toEqual({ archived: true });
  });

  it('lets two users have a Skill of the same name', async () => {
    await created('System design');

    const other = await signUp(t);

    expect((await create('System design', other.cookie)).statusCode).toBe(201);
  });

  it(`refuses a Skill past ${MAX_SKILLS}, archived ones counting: 400 TooManySkills`, async () => {
    await t.db.insert(skills).values(
      Array.from({ length: MAX_SKILLS }, (_, i) => ({
        userId,
        name: `Skill ${i}`,
        archivedAt: i % 2 === 0 ? new Date() : null,
      })),
    );

    const res = await create('One more');

    expect(res.statusCode).toBe(400);
    expect(Schema.is(TooManySkills)(decodedError(res))).toBe(true);
    expect(await list()).toHaveLength(MAX_SKILLS);
  });

  it('allows the last Skill under the limit', async () => {
    await t.db
      .insert(skills)
      .values(Array.from({ length: MAX_SKILLS - 1 }, (_, i) => ({ userId, name: `Skill ${i}` })));

    expect((await create('The last one')).statusCode).toBe(201);
  });

  it('adds one of two same names sent at once, and refuses the other', async () => {
    const results = await Promise.all([create('System design'), create('SYSTEM DESIGN')]);

    expect(results.map((res) => res.statusCode).sort()).toEqual([201, 409]);
  });
});

describe('listing Skills', () => {
  it('lists all of the user’s, archived included, by name ignoring case', async () => {
    await created('behavioral stories');
    const archived = await created('SQL');
    await created('Algorithms');
    await created('coding');

    await patch(archived.id, { archived: true });

    const skillList = await list();

    expect(skillList.map((s) => s.name)).toEqual([
      'Algorithms',
      'behavioral stories',
      'coding',
      'SQL',
    ]);
    expect(skillList.find((s) => s.name === 'SQL')?.archivedAt).toEqual(expect.any(String));
    expect(() => Schema.decodeSync(Schema.Array(Skill))(skillList)).not.toThrow();
  });

  it('lists none of another user’s', async () => {
    await created('System design');

    const other = await signUp(t);

    expect((await request('GET', '/api/skills', undefined, other.cookie)).json()).toEqual([]);
  });
});

describe('changing a Skill', () => {
  it('renames it, trimmed', async () => {
    const skill = await created('System design');

    const res = await patch(skill.id, { name: ' Distributed systems ' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ...skill, name: 'Distributed systems' });
  });

  it('renames it to its own name in another case', async () => {
    const skill = await created('system design');

    const res = await patch(skill.id, { name: 'System Design' });

    expect(res.statusCode).toBe(200);
    expect(res.json<SkillJson>().name).toBe('System Design');
  });

  it('refuses another Skill’s name: 409, saying whether that one is archived', async () => {
    const skill = await created('System design');
    const sql = await created('SQL');

    const active = await patch(skill.id, { name: 'sql' });

    expect(active.statusCode).toBe(409);
    expect(nameTaken(active)).toEqual({ archived: false });

    await patch(sql.id, { archived: true });

    const archived = await patch(skill.id, { name: ' SQL ' });

    expect(archived.statusCode).toBe(409);
    expect(nameTaken(archived)).toEqual({ archived: true });
    expect((await list()).map((s) => s.name)).toEqual(['SQL', 'System design']);
  });

  it.each([
    ['empty', { name: '' }],
    ['whitespace only', { name: '  ' }],
    ['over 80 characters', { name: 'x'.repeat(81) }],
    ['no field', {}],
    ['an archived that isn’t a boolean', { archived: 'yes' }],
  ])('refuses a change that is %s: 400', async (_case, payload) => {
    const skill = await created('System design');

    expect((await patch(skill.id, payload)).statusCode).toBe(400);
  });

  it('archives it, and restores it', async () => {
    const skill = await created('System design');

    const archived = await patch(skill.id, { archived: true });

    expect(archived.statusCode).toBe(200);
    expect(archived.json<SkillJson>().archivedAt).toEqual(expect.any(String));

    const restored = await patch(skill.id, { archived: false });

    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toEqual(skill);
  });

  it('keeps the first archived date when archived again', async () => {
    const skill = await created('System design');
    const first = (await patch(skill.id, { archived: true })).json<SkillJson>();

    const again = await patch(skill.id, { archived: true, name: 'Systems' });

    expect(again.json()).toEqual({ ...first, name: 'Systems' });
  });

  it('answers 404 SkillNotFound for another user’s Skill, and leaves it alone', async () => {
    const skill = await created('System design');
    const other = await signUp(t);

    const res = await patch(skill.id, { name: 'Mine now', archived: true }, other.cookie);

    expect(res.statusCode).toBe(404);
    expect(Schema.is(SkillNotFound)(decodedError(res))).toBe(true);
    expect(await list()).toEqual([skill]);
  });

  it('answers 404 for another user’s Skill even when its new name is one of this user’s', async () => {
    const skill = await created('System design');
    const other = await signUp(t);

    await create('Taken', other.cookie);

    expect((await patch(skill.id, { name: 'taken' }, other.cookie)).statusCode).toBe(404);
  });

  it('answers 404 for a Skill that doesn’t exist, and 400 for a malformed id', async () => {
    expect((await patch(crypto.randomUUID(), { archived: true })).statusCode).toBe(404);
    expect((await patch('not-a-uuid', { archived: true })).statusCode).toBe(400);
  });
});

describe('what a Skill can’t do', () => {
  it('has no delete', async () => {
    const skill = await created('System design');

    const res = await t.inject({
      method: 'DELETE',
      url: `/api/skills/${skill.id}`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(404);
    expect(await list()).toEqual([skill]);
  });

  it('goes when the account is deleted', async () => {
    await created('System design');

    await t.db.delete(users).where(eq(users.id, userId));

    expect(await t.db.select().from(skills).where(eq(skills.userId, userId))).toEqual([]);
  });
});

describe('without a session', () => {
  it.each([
    ['GET', '/api/skills', undefined],
    ['POST', '/api/skills', { name: 'System design' }],
    ['PATCH', `/api/skills/${crypto.randomUUID()}`, { archived: true }],
  ] as const)('%s %s answers 401', async (method, url, payload) => {
    expect((await t.inject({ method, url, payload })).statusCode).toBe(401);
  });
});

// What another module uses to check a Skill id before storing it (ADR-0044 rule 1).
describe('Skills.findOwned', () => {
  const findOwned = (owner: string, id: string) =>
    Effect.runPromiseExit(
      Skills.use((library) => library.findOwned(owner, id)).pipe(
        Effect.provide(Skills.layer.pipe(Layer.provide(Database.layer(env.DATABASE_URL)))),
      ),
    );

  it('finds the user’s Skill, archived or not', async () => {
    const active = await created('System design');
    const archived = await created('SQL');

    await patch(archived.id, { archived: true });

    const found = await findOwned(userId, active.id);
    const foundArchived = await findOwned(userId, archived.id);

    expect(Exit.isSuccess(found) && Schema.encodeSync(Skill)(found.value)).toEqual(active);
    expect(Exit.isSuccess(foundArchived) && foundArchived.value.archivedAt).toBeInstanceOf(Date);
  });

  it.each([
    ['another user’s', async () => (await created('System design')).id, true],
    ['a missing', async () => crypto.randomUUID(), false],
    ['a malformed', async () => 'not-a-uuid', false],
  ])('fails with SkillNotFound for %s id', async (_case, makeId, asOther) => {
    const id = await makeId();
    const owner = asOther ? (await signUp(t)).user.id : userId;

    const exit = await findOwned(owner, id);

    expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBeInstanceOf(SkillNotFound);
  });
});
