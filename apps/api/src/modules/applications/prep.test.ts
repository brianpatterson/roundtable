// Prep (GLOSSARY.md): a Round's notes and prep tasks, through the API, on the real database.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { Schema } from 'effect';
import {
  AgendaRound,
  MAX_PREP_NOTES,
  MAX_PREP_TASK_TITLE,
  MAX_PREP_TASKS,
  PrepTaskNotFound,
  Round,
  SkillNotFound,
  TooManyPrepTasks,
} from '@roundtable/contract';
import { setupTestApp, signUp, type Json } from '#test/helpers';
import { prepTasks } from './schema.js';

const t = setupTestApp();
let cookie: string;

beforeAll(() => t.migrate());

beforeEach(async () => {
  await t.reset();
  ({ cookie } = await signUp(t));
});

afterAll(() => t.close());

type RoundJson = typeof Round.Encoded;

type TaskJson = RoundJson['prepTasks'] extends readonly (infer T)[] | undefined ? T : never;

function request(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: Json,
  as = cookie,
) {
  return t.inject({ method, url, payload, headers: { cookie: as } });
}

const MISSING_ID = '00000000-0000-4000-8000-000000000000';

/** A new application with one Round (not scheduled: always on the Agenda), as `as`. */
async function createRound(as = cookie) {
  const application = await request(
    'POST',
    '/api/applications',
    { company: 'Acme', jobTitle: 'SWE', status: 'interviewing' },
    as,
  );

  const { id: applicationId } = application.json<{ id: string }>();

  const round = await request(
    'POST',
    `/api/applications/${applicationId}/rounds`,
    { interviewType: 'coding' },
    as,
  );

  expect(round.statusCode).toBe(201);

  const { id: roundId } = round.json<RoundJson>();

  return { applicationId, roundId, url: `/api/applications/${applicationId}/rounds/${roundId}` };
}

type RoundRef = Awaited<ReturnType<typeof createRound>>;

async function createSkill(name: string, as = cookie) {
  const res = await request('POST', '/api/skills', { name }, as);

  expect(res.statusCode).toBe(201);

  return res.json<{ id: string }>().id;
}

/** Adds a prep task and answers the one added. */
async function addTask(round: RoundRef, payload: { readonly [key: string]: Json }) {
  const res = await request('POST', `${round.url}/prep-tasks`, payload);

  expect(res.statusCode).toBe(201);

  const tasks = res.json<RoundJson>().prepTasks ?? [];
  const added = tasks.at(-1);

  if (!added) throw new Error('no task was added');

  return added;
}

async function listed(round: RoundRef) {
  const res = await request('GET', `/api/applications/${round.applicationId}/rounds`);

  expect(res.statusCode).toBe(200);

  const found = res.json<RoundJson[]>().find((r) => r.id === round.roundId);

  if (!found) throw new Error('the round is not listed');

  return found;
}

const titles = (tasks: readonly TaskJson[] | undefined) => (tasks ?? []).map((task) => task.title);

describe('a Round’s Prep', () => {
  it('reads with no notes and no prep tasks to start with', async () => {
    const round = await createRound();

    expect(await listed(round)).toMatchObject({ prepNotes: null, prepTasks: [] });
  });

  it('decodes a Round from a server before Prep as having none', () => {
    const before = {
      id: MISSING_ID,
      applicationId: MISSING_ID,
      interviewType: 'coding',
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
    };

    expect(Schema.decodeUnknownSync(Round)(before)).toMatchObject({
      prepNotes: null,
      prepTasks: [],
    });
  });
});

describe('Prep notes', () => {
  it('saves them and answers the Round', async () => {
    const round = await createRound();

    const res = await request('PUT', `${round.url}/prep-notes`, { notes: 'Read up on caching' });

    expect(res.statusCode).toBe(200);
    expect(res.json<RoundJson>()).toMatchObject({
      id: round.roundId,
      prepNotes: 'Read up on caching',
    });
    expect(() => Schema.decodeUnknownSync(Round)(res.json())).not.toThrow();
    expect((await listed(round)).prepNotes).toBe('Read up on caching');
  });

  it('clears them with an empty or whitespace-only value', async () => {
    const round = await createRound();

    for (const notes of ['', '  \n\t ']) {
      await request('PUT', `${round.url}/prep-notes`, { notes: 'Something' });

      const res = await request('PUT', `${round.url}/prep-notes`, { notes });

      expect(res.statusCode, JSON.stringify(notes)).toBe(200);
      expect(res.json<RoundJson>().prepNotes).toBeNull();
    }
  });

  it(`accepts ${MAX_PREP_NOTES} characters and refuses one more`, async () => {
    const round = await createRound();

    const longest = await request('PUT', `${round.url}/prep-notes`, {
      notes: 'a'.repeat(MAX_PREP_NOTES),
    });

    expect(longest.statusCode).toBe(200);

    const tooLong = await request('PUT', `${round.url}/prep-notes`, {
      notes: 'b'.repeat(MAX_PREP_NOTES + 1),
    });

    expect(tooLong.statusCode).toBe(400);
    expect((await listed(round)).prepNotes).toBe('a'.repeat(MAX_PREP_NOTES));
  });
});

describe('prep tasks', () => {
  it('adds a task last and not done, answering the Round with 201', async () => {
    const round = await createRound();

    await addTask(round, { title: 'First' });

    const res = await request('POST', `${round.url}/prep-tasks`, { title: '  Second  ' });

    expect(res.statusCode).toBe(201);
    expect(() => Schema.decodeUnknownSync(Round)(res.json())).not.toThrow();

    const tasks = res.json<RoundJson>().prepTasks;

    expect(titles(tasks)).toEqual(['First', 'Second']);
    expect(tasks?.[1]).toMatchObject({ skillId: null, completedAt: null });
    expect(titles((await listed(round)).prepTasks)).toEqual(['First', 'Second']);
  });

  it('lists tasks in the order added, after one is deleted and another added', async () => {
    const round = await createRound();
    await addTask(round, { title: 'One' });
    const two = await addTask(round, { title: 'Two' });
    await addTask(round, { title: 'Three' });

    await request('DELETE', `${round.url}/prep-tasks/${two.id}`);
    await addTask(round, { title: 'Four' });

    expect(titles((await listed(round)).prepTasks)).toEqual(['One', 'Three', 'Four']);
  });

  it('refuses a blank title, or one too long', async () => {
    const round = await createRound();

    for (const title of ['', '   ', 'x'.repeat(MAX_PREP_TASK_TITLE + 1)]) {
      const res = await request('POST', `${round.url}/prep-tasks`, { title });

      expect(res.statusCode, title.slice(0, 10)).toBe(400);
    }

    expect((await listed(round)).prepTasks).toEqual([]);

    const longest = await request('POST', `${round.url}/prep-tasks`, {
      title: 'x'.repeat(MAX_PREP_TASK_TITLE),
    });

    expect(longest.statusCode).toBe(201);
  });

  it(`refuses a task past ${MAX_PREP_TASKS} with TooManyPrepTasks`, async () => {
    const round = await createRound();

    for (let n = 1; n <= MAX_PREP_TASKS; n++) await addTask(round, { title: `Task ${n}` });

    const res = await request('POST', `${round.url}/prep-tasks`, { title: 'One too many' });

    expect(res.statusCode).toBe(400);
    expect(Schema.decodeUnknownSync(TooManyPrepTasks)(res.json())).toBeInstanceOf(TooManyPrepTasks);
    expect((await listed(round)).prepTasks).toHaveLength(MAX_PREP_TASKS);
  });

  it(`keeps to the limit when two tasks are added at once to a Round with ${MAX_PREP_TASKS - 1}`, async () => {
    const round = await createRound();

    for (let n = 1; n < MAX_PREP_TASKS; n++) await addTask(round, { title: `Task ${n}` });

    const answers = await Promise.all(
      ['First', 'Second'].map((title) => request('POST', `${round.url}/prep-tasks`, { title })),
    );

    expect(answers.map((res) => res.statusCode).sort()).toEqual([201, 400]);

    const refused = answers.find((res) => res.statusCode === 400);

    expect(Schema.decodeUnknownSync(TooManyPrepTasks)(refused?.json())).toBeInstanceOf(
      TooManyPrepTasks,
    );
    expect((await listed(round)).prepTasks).toHaveLength(MAX_PREP_TASKS);
  });

  it('renames a task, trimmed', async () => {
    const round = await createRound();
    const task = await addTask(round, { title: 'Old' });

    const res = await request('PATCH', `${round.url}/prep-tasks/${task.id}`, { title: ' New ' });

    expect(res.statusCode).toBe(200);
    expect(titles(res.json<RoundJson>().prepTasks)).toEqual(['New']);
  });

  it('marks a task done, keeps when it was first done, and marks it not done', async () => {
    const round = await createRound();
    const task = await addTask(round, { title: 'Practice' });
    const url = `${round.url}/prep-tasks/${task.id}`;

    const done = await request('PATCH', url, { done: true });
    const completedAt = done.json<RoundJson>().prepTasks?.[0]?.completedAt;

    expect(done.statusCode).toBe(200);
    expect(completedAt).toEqual(expect.any(String));

    const again = await request('PATCH', url, { done: true });

    expect(again.json<RoundJson>().prepTasks?.[0]?.completedAt).toBe(completedAt);

    const undone = await request('PATCH', url, { done: false });

    expect(undone.json<RoundJson>().prepTasks?.[0]?.completedAt).toBeNull();
  });

  it('refuses a change with no fields', async () => {
    const round = await createRound();
    const task = await addTask(round, { title: 'Practice' });

    const res = await request('PATCH', `${round.url}/prep-tasks/${task.id}`, {});

    expect(res.statusCode).toBe(400);
  });

  it('deletes a task and answers the Round', async () => {
    const round = await createRound();
    const task = await addTask(round, { title: 'Gone' });
    await addTask(round, { title: 'Stays' });

    const res = await request('DELETE', `${round.url}/prep-tasks/${task.id}`);

    expect(res.statusCode).toBe(200);
    expect(titles(res.json<RoundJson>().prepTasks)).toEqual(['Stays']);

    const again = await request('DELETE', `${round.url}/prep-tasks/${task.id}`);

    expect(again.statusCode).toBe(404);
    expect(Schema.decodeUnknownSync(PrepTaskNotFound)(again.json())).toBeInstanceOf(
      PrepTaskNotFound,
    );
  });

  it('answers a malformed task id with 400', async () => {
    const round = await createRound();

    const malformed = await request('PATCH', `${round.url}/prep-tasks/not-a-uuid`, { done: true });

    expect(malformed.statusCode).toBe(400);
  });

  it('answers a task of another Round of the same user as not found', async () => {
    const round = await createRound();
    const other = await createRound();
    const task = await addTask(other, { title: 'Theirs' });

    const patched = await request('PATCH', `${round.url}/prep-tasks/${task.id}`, { done: true });
    const deleted = await request('DELETE', `${round.url}/prep-tasks/${task.id}`);

    expect(patched.statusCode).toBe(404);
    expect(deleted.statusCode).toBe(404);
    expect((await listed(other)).prepTasks).toMatchObject([{ title: 'Theirs', completedAt: null }]);
  });

  it('goes with its Round, and with its application', async () => {
    const round = await createRound();
    const task = await addTask(round, { title: 'With the round' });
    const other = await createRound();
    const otherTask = await addTask(other, { title: 'With the application' });

    await request('DELETE', round.url);
    await request('DELETE', `/api/applications/${other.applicationId}`);

    const left = await t.db
      .select({ id: prepTasks.id })
      .from(prepTasks)
      .where(inArray(prepTasks.id, [task.id, otherTask.id]));

    expect(left).toEqual([]);
  });
});

describe('a prep task’s Skill', () => {
  it('names one of the user’s Skills, archived ones included, and clears it with null', async () => {
    const round = await createRound();
    const skillId = await createSkill('System design');
    const archived = await createSkill('Old skill');
    await request('PATCH', `/api/skills/${archived}`, { archived: true });

    const task = await addTask(round, { title: 'Design a cache', skillId });

    expect(task.skillId).toBe(skillId);

    const url = `${round.url}/prep-tasks/${task.id}`;
    const changed = await request('PATCH', url, { skillId: archived });

    expect(changed.statusCode).toBe(200);
    expect(changed.json<RoundJson>().prepTasks?.[0]?.skillId).toBe(archived);

    const cleared = await request('PATCH', url, { skillId: null });

    expect(cleared.json<RoundJson>().prepTasks?.[0]?.skillId).toBeNull();
  });

  it('refuses a Skill that doesn’t exist, storing nothing', async () => {
    const round = await createRound();

    const res = await request('POST', `${round.url}/prep-tasks`, {
      title: 'Practice',
      skillId: MISSING_ID,
    });

    expect(res.statusCode).toBe(404);
    expect(Schema.decodeUnknownSync(SkillNotFound)(res.json())).toBeInstanceOf(SkillNotFound);
    expect((await listed(round)).prepTasks).toEqual([]);
  });

  it('refuses another user’s Skill, adding or changing, storing nothing', async () => {
    const round = await createRound();
    const task = await addTask(round, { title: 'Practice' });
    const other = await signUp(t);
    const theirSkill = await createSkill('Their skill', other.cookie);

    const added = await request('POST', `${round.url}/prep-tasks`, {
      title: 'With their skill',
      skillId: theirSkill,
    });

    const patched = await request('PATCH', `${round.url}/prep-tasks/${task.id}`, {
      title: 'Renamed',
      skillId: theirSkill,
    });

    for (const res of [added, patched]) {
      expect(res.statusCode).toBe(404);
      expect(Schema.decodeUnknownSync(SkillNotFound)(res.json())).toBeInstanceOf(SkillNotFound);
    }

    expect((await listed(round)).prepTasks).toMatchObject([{ title: 'Practice', skillId: null }]);
  });

  it('refuses a malformed Skill id with 400', async () => {
    const round = await createRound();

    const res = await request('POST', `${round.url}/prep-tasks`, {
      title: 'Practice',
      skillId: 'not-a-uuid',
    });

    expect(res.statusCode).toBe(400);
  });
});

// CLAUDE.md rule 8: another user's rows are a 404, never a 403. Their Round, or a Round of their
// Application, is RoundNotFound on every Round endpoint: rounds.test.ts pins it for all of them.
describe('another user’s Prep', () => {
  let theirs: RoundRef;
  let theirTask: TaskJson;
  let mine: string;

  beforeEach(async () => {
    theirs = await createRound();
    theirTask = await addTask(theirs, { title: 'Their task' });
    ({ cookie: mine } = await signUp(t));
  });

  it('answers their task under my Round as PrepTaskNotFound', async () => {
    const own = await createRound(mine);
    const url = `${own.url}/prep-tasks/${theirTask.id}`;

    for (const res of [
      await request('PATCH', url, { done: true }, mine),
      await request('DELETE', url, undefined, mine),
    ]) {
      expect(res.statusCode).toBe(404);
      expect(Schema.decodeUnknownSync(PrepTaskNotFound)(res.json())).toBeInstanceOf(
        PrepTaskNotFound,
      );
    }

    expect((await listed(theirs)).prepTasks).toMatchObject([{ title: 'Their task' }]);
  });
});

describe('Prep on the Agenda', () => {
  it('carries each Round’s prep tasks but not its notes', async () => {
    const first = await createRound();
    const second = await createRound();
    await request('PUT', `${first.url}/prep-notes`, { notes: 'Private' });
    await addTask(first, { title: 'A' });
    await addTask(first, { title: 'B' });
    await addTask(second, { title: 'C' });

    const res = await request('GET', '/api/agenda');

    expect(res.statusCode).toBe(200);
    expect(() => Schema.decodeUnknownSync(Schema.Array(AgendaRound))(res.json())).not.toThrow();

    const items = res.json<(typeof AgendaRound.Encoded)[]>();
    const byId = new Map(items.map((item) => [item.id, item]));

    expect(titles(byId.get(first.roundId)?.prepTasks)).toEqual(['A', 'B']);
    expect(titles(byId.get(second.roundId)?.prepTasks)).toEqual(['C']);

    for (const item of items) expect(item).not.toHaveProperty('prepNotes');
  });
});
