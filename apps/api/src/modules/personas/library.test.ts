// The Library rules (library.ts), pinned once at its interface, through the endpoints of each of
// its instances: the skill library and Personas. What's a Persona's own (its Skills) is in
// personas.test.ts.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { Cause, Effect, Exit, Layer, Schema } from 'effect';
import {
  MAX_PERSONAS,
  MAX_SKILLS,
  Persona,
  PersonaNameTaken,
  PersonaNotFound,
  Skill,
  SkillNameTaken,
  SkillNotFound,
  TooManyPersonas,
  TooManySkills,
} from '@roundtable/contract';
import { Database } from '../../platform/database/effect.js';
import { env, setupTestApp, signUp, type InjectResponse, type Json } from '#test/helpers';
import { users } from '../identity/index.js';
import { Personas, Skills } from './index.js';
import { personas, skills } from './schema.js';

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

const database = Database.layer(env.DATABASE_URL);

/** A row to seed straight into an instance's table. */
interface SeedRow {
  readonly userId: string;
  readonly name: string;
  readonly archivedAt?: Date | null;
}

// Entries as they arrive on the wire: dates are still ISO 8601 strings.
interface EntryJson {
  readonly id: string;
  readonly name: string;
  readonly archivedAt: string | null;
  readonly createdAt: string;
}

/** One instance of the Library, as its endpoints and its errors name it. */
interface Instance {
  readonly entry: string;
  readonly path: string;
  readonly max: number;
  /** What a new entry has beyond the Library's columns. */
  readonly extra: object;
  /**
   * Each of these decodes a response's body as the typed client does, and throws unless it's what
   * the check is named after: one entry, a list of them, or the instance's own error.
   */
  readonly decodeEntry: (res: InjectResponse) => void;
  readonly decodeList: (res: InjectResponse) => void;
  readonly decodeTooMany: (res: InjectResponse) => void;
  readonly decodeNotFound: (res: InjectResponse) => void;
  readonly nameTaken: (res: InjectResponse) => { readonly archived: boolean };
  readonly seed: (rows: readonly SeedRow[]) => Promise<void>;
  /** How many rows the user has in the instance's table. */
  readonly rowCount: (owner: string) => Promise<number>;
  /** `findOwned` of the instance's service, its success encoded as on the wire. */
  readonly findOwned: (owner: string, id: string) => Promise<Exit.Exit<EntryJson, unknown>>;
  /** Whether `exit` failed with the instance's NotFound. */
  readonly failedNotFound: (exit: Exit.Exit<EntryJson, unknown>) => boolean;
}

const libraries: readonly Instance[] = [
  {
    entry: 'Skill',
    path: '/api/skills',
    max: MAX_SKILLS,
    extra: {},
    decodeEntry: (res) => {
      Schema.decodeUnknownSync(Skill)(res.json());
    },
    decodeList: (res) => {
      Schema.decodeUnknownSync(Schema.Array(Skill))(res.json());
    },
    decodeTooMany: (res) => {
      Schema.decodeUnknownSync(TooManySkills)(res.json());
    },
    decodeNotFound: (res) => {
      Schema.decodeUnknownSync(SkillNotFound)(res.json());
    },
    nameTaken: (res) => ({
      archived: Schema.decodeUnknownSync(SkillNameTaken)(res.json()).archived,
    }),
    seed: async (rows) => {
      await t.db.insert(skills).values([...rows]);
    },
    rowCount: async (owner) =>
      (await t.db.select().from(skills).where(eq(skills.userId, owner))).length,
    findOwned: (owner, id) =>
      Effect.runPromiseExit(
        Skills.use((library) => library.findOwned(owner, id)).pipe(
          Effect.map(Schema.encodeSync(Skill)),
          Effect.provide(Skills.layer.pipe(Layer.provide(database))),
        ),
      ),
    failedNotFound: (exit) =>
      Exit.isFailure(exit) && Cause.squash(exit.cause) instanceof SkillNotFound,
  },
  {
    entry: 'Persona',
    path: '/api/personas',
    max: MAX_PERSONAS,
    extra: { skillIds: [] },
    decodeEntry: (res) => {
      Schema.decodeUnknownSync(Persona)(res.json());
    },
    decodeList: (res) => {
      Schema.decodeUnknownSync(Schema.Array(Persona))(res.json());
    },
    decodeTooMany: (res) => {
      Schema.decodeUnknownSync(TooManyPersonas)(res.json());
    },
    decodeNotFound: (res) => {
      Schema.decodeUnknownSync(PersonaNotFound)(res.json());
    },
    nameTaken: (res) => ({
      archived: Schema.decodeUnknownSync(PersonaNameTaken)(res.json()).archived,
    }),
    seed: async (rows) => {
      await t.db.insert(personas).values([...rows]);
    },
    rowCount: async (owner) =>
      (await t.db.select().from(personas).where(eq(personas.userId, owner))).length,
    findOwned: (owner, id) =>
      Effect.runPromiseExit(
        Personas.use((library) => library.findOwned(owner, id)).pipe(
          Effect.map(Schema.encodeSync(Persona)),
          Effect.provide(Personas.layer.pipe(Layer.provide(database))),
        ),
      ),
    failedNotFound: (exit) =>
      Exit.isFailure(exit) && Cause.squash(exit.cause) instanceof PersonaNotFound,
  },
];

describe.each(libraries)('the $entry Library', (library) => {
  const { entry, path, max, extra } = library;

  function request(method: 'GET' | 'POST' | 'PATCH', url: string, payload?: Json, as = cookie) {
    return t.inject({ method, url, payload, headers: { cookie: as } });
  }

  const create = (name: Json, as = cookie) => request('POST', path, { name }, as);

  async function created(name: string, as = cookie) {
    const res = await create(name, as);

    expect(res.statusCode).toBe(201);

    return res.json<EntryJson>();
  }

  const patch = (id: string, payload: Json, as = cookie) =>
    request('PATCH', `${path}/${id}`, payload, as);

  /** A name-taken response's fields; fails the test for any other body. */
  const { nameTaken } = library;

  const list = async (as = cookie) =>
    (await request('GET', path, undefined, as)).json<EntryJson[]>();

  /** Expects `res` to be a 400 with the instance's TooMany. */
  const expectTooMany = (res: InjectResponse | undefined) => {
    expect(res?.statusCode).toBe(400);
    expect(() => res && library.decodeTooMany(res)).not.toThrow();
  };

  /** Expects `res` to be a 404 with the instance's NotFound. */
  const expectNotFound = (res: InjectResponse) => {
    expect(res.statusCode).toBe(404);
    expect(() => library.decodeNotFound(res)).not.toThrow();
  };

  /** `count` names, archiving every other one if `archiving`. */
  const seed = (count: number, archiving = false) =>
    library.seed(
      Array.from({ length: count }, (_, i) => ({
        userId,
        name: `${entry} ${i}`,
        archivedAt: archiving && i % 2 === 0 ? new Date() : null,
      })),
    );

  describe('adding', () => {
    it('answers 201 with the entry', async () => {
      const res = await create('System design');

      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({
        id: expect.any(String),
        name: 'System design',
        archivedAt: null,
        createdAt: expect.any(String),
        ...extra,
      });
      expect(() => library.decodeEntry(res)).not.toThrow();
    });

    it('stores the name trimmed', async () => {
      expect((await created('  System design \n')).name).toBe('System design');
      expect((await list()).map((e) => e.name)).toEqual(['System design']);
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

    it('refuses a name the user has, in any case and with spaces: 409', async () => {
      await created('System design');

      const res = await create('  system DESIGN ');

      expect(res.statusCode).toBe(409);
      expect(nameTaken(res)).toEqual({ archived: false });
      expect(await list()).toHaveLength(1);
    });

    it('refuses the name of an archived entry too, saying it is archived', async () => {
      const archived = await created('System design');

      await patch(archived.id, { archived: true });

      const res = await create('System Design');

      expect(res.statusCode).toBe(409);
      expect(nameTaken(res)).toEqual({ archived: true });
    });

    it('lets two users have an entry of the same name', async () => {
      await created('System design');

      const other = await signUp(t);

      expect((await create('System design', other.cookie)).statusCode).toBe(201);
    });

    it(`refuses one past the limit, archived ones counting: 400`, async () => {
      await seed(max, true);

      expectTooMany(await create('One more'));
      expect(await list()).toHaveLength(max);
    });

    it('allows the last one under the limit', async () => {
      await seed(max - 1);

      expect((await create('The last one')).statusCode).toBe(201);
    });

    it('adds one of two same names sent at once, and refuses the other', async () => {
      const results = await Promise.all([create('System design'), create('SYSTEM DESIGN')]);

      expect(results.map((res) => res.statusCode).sort()).toEqual([201, 409]);
    });

    it('adds only one of two sent at once at the limit, refusing the other with 400', async () => {
      await seed(max - 1);

      const results = await Promise.all([create('One'), create('Two')]);

      expect(results.map((res) => res.statusCode).sort()).toEqual([201, 400]);
      expectTooMany(results.find((res) => res.statusCode !== 201));
      expect(await list()).toHaveLength(max);
    });
  });

  describe('listing', () => {
    it('lists all of the user’s, archived included, by name ignoring case', async () => {
      await created('behavioral stories');
      const archived = await created('SQL');
      await created('Algorithms');
      await created('coding');

      await patch(archived.id, { archived: true });

      const res = await request('GET', path);
      const entries = res.json<EntryJson[]>();

      expect(entries.map((e) => e.name)).toEqual([
        'Algorithms',
        'behavioral stories',
        'coding',
        'SQL',
      ]);
      expect(entries.find((e) => e.name === 'SQL')?.archivedAt).toEqual(expect.any(String));
      expect(() => library.decodeList(res)).not.toThrow();
    });

    it('lists none of another user’s', async () => {
      await created('System design');

      const other = await signUp(t);

      expect(await list(other.cookie)).toEqual([]);
    });
  });

  describe('changing', () => {
    it('renames it, trimmed', async () => {
      const original = await created('System design');

      const res = await patch(original.id, { name: ' Distributed systems ' });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ...original, name: 'Distributed systems' });
    });

    it('renames it to its own name in another case', async () => {
      const original = await created('system design');

      const res = await patch(original.id, { name: 'System Design' });

      expect(res.statusCode).toBe(200);
      expect(res.json<EntryJson>().name).toBe('System Design');
    });

    it('refuses another entry’s name: 409, saying whether that one is archived', async () => {
      const original = await created('System design');
      const sql = await created('SQL');

      const active = await patch(original.id, { name: 'sql' });

      expect(active.statusCode).toBe(409);
      expect(nameTaken(active)).toEqual({ archived: false });

      await patch(sql.id, { archived: true });

      const archived = await patch(original.id, { name: ' SQL ' });

      expect(archived.statusCode).toBe(409);
      expect(nameTaken(archived)).toEqual({ archived: true });
      expect((await list()).map((e) => e.name)).toEqual(['SQL', 'System design']);
    });

    it.each([
      ['empty', { name: '' }],
      ['whitespace only', { name: '  ' }],
      ['over 80 characters', { name: 'x'.repeat(81) }],
      ['no field', {}],
      ['an archived that isn’t a boolean', { archived: 'yes' }],
    ])('refuses a change that is %s: 400', async (_case, payload) => {
      const original = await created('System design');

      expect((await patch(original.id, payload)).statusCode).toBe(400);
    });

    it('archives it, and restores it', async () => {
      const original = await created('System design');

      const archived = await patch(original.id, { archived: true });

      expect(archived.statusCode).toBe(200);
      expect(archived.json<EntryJson>().archivedAt).toEqual(expect.any(String));

      const restored = await patch(original.id, { archived: false });

      expect(restored.statusCode).toBe(200);
      expect(restored.json()).toEqual(original);
    });

    it('keeps the first archived date when archived again', async () => {
      const original = await created('System design');
      const first = (await patch(original.id, { archived: true })).json<EntryJson>();

      const again = await patch(original.id, { archived: true, name: 'Systems' });

      expect(again.json()).toEqual({ ...first, name: 'Systems' });
      expect((await list())[0]?.archivedAt).toBe(first.archivedAt);
    });

    it('answers 404 for another user’s entry, and leaves it alone', async () => {
      const original = await created('System design');
      const other = await signUp(t);

      expectNotFound(await patch(original.id, { name: 'Mine now', archived: true }, other.cookie));
      expect(await list()).toEqual([original]);
    });

    it('answers 404 for another user’s entry even when its new name is one of theirs', async () => {
      const original = await created('System design');
      const other = await signUp(t);

      await created('Taken', other.cookie);

      expectNotFound(await patch(original.id, { name: 'taken' }, other.cookie));
      expect(await list()).toEqual([original]);
    });

    it('answers 404 for an entry that doesn’t exist, and 400 for a malformed id', async () => {
      expectNotFound(await patch(crypto.randomUUID(), { archived: true }));
      expect((await patch('not-a-uuid', { archived: true })).statusCode).toBe(400);
    });
  });

  describe('what an entry can’t do', () => {
    it('has no delete', async () => {
      const original = await created('System design');

      const res = await t.inject({
        method: 'DELETE',
        url: `${path}/${original.id}`,
        headers: { cookie },
      });

      expect(res.statusCode).toBe(404);
      expect(await list()).toEqual([original]);
    });

    it('goes when the account is deleted', async () => {
      await created('System design');

      await t.db.delete(users).where(eq(users.id, userId));

      expect(await library.rowCount(userId)).toBe(0);
    });
  });

  describe('without a session', () => {
    it.each([
      ['GET', '', undefined],
      ['POST', '', { name: 'System design' }],
      ['PATCH', `/${crypto.randomUUID()}`, { archived: true }],
    ] as const)('%s answers 401', async (method, suffix, payload) => {
      expect((await t.inject({ method, url: `${path}${suffix}`, payload })).statusCode).toBe(401);
    });
  });

  // What another module uses to check an id before storing it (ADR-0044 rule 1).
  describe('findOwned', () => {
    it('finds the user’s entry, archived or not', async () => {
      const active = await created('System design');
      const archived = await created('SQL');

      await patch(archived.id, { archived: true });

      const found = await library.findOwned(userId, active.id);
      const foundArchived = await library.findOwned(userId, archived.id);

      expect(Exit.isSuccess(found) && found.value).toEqual(active);
      expect(Exit.isSuccess(foundArchived) && foundArchived.value.archivedAt).toEqual(
        expect.any(String),
      );
    });

    it.each([
      ['another user’s', async () => (await created('System design')).id, true],
      ['a missing', async () => crypto.randomUUID(), false],
      ['a malformed', async () => 'not-a-uuid', false],
    ])('fails with its NotFound for %s id', async (_case, makeId, asOther) => {
      const id = await makeId();
      const owner = asOther ? (await signUp(t)).user.id : userId;

      const exit = await library.findOwned(owner, id);

      expect(library.failedNotFound(exit)).toBe(true);
    });
  });
});
