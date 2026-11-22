import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { Schema } from 'effect';
import { Application, INTERVIEW_TYPES, Round } from '@roundtable/contract';
import { setupTestApp, signUp, type Json } from '#test/helpers';
import { rounds } from './schema.js';

const t = setupTestApp();
let cookie: string;

beforeAll(() => t.migrate());

beforeEach(async () => {
  await t.reset();
  ({ cookie } = await signUp(t));
});

afterAll(() => t.close());

// Responses as they arrive on the wire: dates are still ISO 8601 strings.
type ApplicationJson = typeof Application.Encoded;

type RoundJson = typeof Round.Encoded;

function request(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: Json,
  as = cookie,
) {
  return t.inject({ method, url, payload, headers: { cookie: as } });
}

async function createApplication(status = 'applied') {
  const res = await request('POST', '/api/applications', {
    company: 'Acme',
    jobTitle: 'SWE',
    status,
  });

  return res.json<ApplicationJson>();
}

const roundsOf = (applicationId: string) => `/api/applications/${applicationId}/rounds`;

async function addRound(applicationId: string, interviewType = 'coding', as = cookie) {
  return request('POST', roundsOf(applicationId), { interviewType }, as);
}

async function statusOf(applicationId: string) {
  const res = await request('GET', `/api/applications/${applicationId}`);

  return res.json<ApplicationJson>().status;
}

const MISSING_ID = '00000000-0000-4000-8000-000000000000';

describe('rounds API', () => {
  it('adds a Round of each interview type and lists them in the order they were added', async () => {
    const application = await createApplication();

    for (const interviewType of INTERVIEW_TYPES) {
      const res = await addRound(application.id, interviewType);

      expect(res.statusCode, interviewType).toBe(201);
      expect(res.json<RoundJson>()).toMatchObject({ applicationId: application.id, interviewType });
      expect(() => Schema.decodeUnknownSync(Round)(res.json())).not.toThrow();
    }

    const list = await request('GET', roundsOf(application.id));

    expect(list.statusCode).toBe(200);
    expect(list.json<RoundJson[]>().map((r) => r.interviewType)).toEqual([...INTERVIEW_TYPES]);
    expect(() => Schema.decodeUnknownSync(Schema.Array(Round))(list.json())).not.toThrow();
  });

  it('lists no Rounds for an application without any, and only its own', async () => {
    const empty = await createApplication();
    const other = await createApplication();

    await addRound(other.id);

    const list = await request('GET', roundsOf(empty.id));

    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual([]);
  });

  it('rejects an interview type outside the list', async () => {
    const application = await createApplication();

    for (const interviewType of ['onsite', '', 'Coding']) {
      const res = await addRound(application.id, interviewType);

      expect(res.statusCode, interviewType).toBe(400);
    }

    const missing = await request('POST', roundsOf(application.id), {});

    expect(missing.statusCode).toBe(400);
    expect((await request('GET', roundsOf(application.id))).json()).toEqual([]);
  });

  it('deletes a Round', async () => {
    const application = await createApplication();
    const kept = (await addRound(application.id, 'coding')).json<RoundJson>();
    const deleted = (await addRound(application.id, 'behavioral')).json<RoundJson>();

    const res = await request('DELETE', `${roundsOf(application.id)}/${deleted.id}`);

    expect(res.statusCode).toBe(204);
    expect((await request('GET', roundsOf(application.id))).json<RoundJson[]>()).toEqual([kept]);

    const again = await request('DELETE', `${roundsOf(application.id)}/${deleted.id}`);

    expect(again.statusCode).toBe(404);
  });

  it('answers 404 for a Round under another of the user’s applications', async () => {
    const first = await createApplication();
    const second = await createApplication();
    const round = (await addRound(first.id)).json<RoundJson>();

    const res = await request('DELETE', `${roundsOf(second.id)}/${round.id}`);

    expect(res.statusCode).toBe(404);
    expect((await request('GET', roundsOf(first.id))).json<RoundJson[]>()).toHaveLength(1);
  });

  it('deletes an application’s Rounds with it', async () => {
    const application = await createApplication();

    await addRound(application.id);
    await addRound(application.id);
    await request('DELETE', `/api/applications/${application.id}`);

    const left = await t.db.select().from(rounds).where(eq(rounds.applicationId, application.id));

    expect(left).toEqual([]);
    expect((await request('GET', roundsOf(application.id))).statusCode).toBe(404);
  });
});

describe('the first Round and the application’s status', () => {
  it('moves an applied application to interviewing', async () => {
    const application = await createApplication('applied');

    await addRound(application.id);

    expect(await statusOf(application.id)).toBe('interviewing');
  });

  it.each(['saved', 'interviewing', 'offer', 'accepted', 'rejected', 'withdrawn'])(
    'leaves a %s application alone',
    async (status) => {
      const application = await createApplication(status);

      await addRound(application.id);

      expect(await statusOf(application.id)).toBe(status);
    },
  );

  it('leaves an applied application with Rounds alone: only the first Round moves it', async () => {
    const application = await createApplication('applied');

    await addRound(application.id);
    await request('PATCH', `/api/applications/${application.id}`, { status: 'applied' });
    await addRound(application.id);

    expect(await statusOf(application.id)).toBe('applied');
  });
});

const scheduleOf = (applicationId: string, roundId: string) =>
  `${roundsOf(applicationId)}/${roundId}/schedule`;

const addRoundWith = (applicationId: string, schedule: Record<string, Json>) =>
  request('POST', roundsOf(applicationId), { interviewType: 'coding', ...schedule });

/** The schedule fields of a Round as the API returns it. */
const scheduleIn = (round: RoundJson) => ({
  startsAt: round.startsAt,
  durationMinutes: round.durationMinutes,
  dueOn: round.dueOn,
});

const NOT_SCHEDULED = { startsAt: null, durationMinutes: null, dueOn: null };

describe('scheduling a Round', () => {
  it('adds a Round with a start and a duration', async () => {
    const application = await createApplication();

    const res = await addRoundWith(application.id, {
      startsAt: '2026-11-25T15:30:00.000Z',
      durationMinutes: 45,
    });

    expect(res.statusCode).toBe(201);
    expect(scheduleIn(res.json<RoundJson>())).toEqual({
      startsAt: '2026-11-25T15:30:00.000Z',
      durationMinutes: 45,
      dueOn: null,
    });
    expect(Schema.decodeUnknownSync(Round)(res.json()).startsAt).toEqual(
      new Date('2026-11-25T15:30:00.000Z'),
    );
  });

  it('adds a Round with a start and no duration', async () => {
    const application = await createApplication();

    const res = await addRoundWith(application.id, { startsAt: '2026-11-25T15:30:00+09:00' });

    expect(res.statusCode).toBe(201);
    expect(scheduleIn(res.json<RoundJson>())).toEqual({
      startsAt: '2026-11-25T06:30:00.000Z',
      durationMinutes: null,
      dueOn: null,
    });
  });

  it('adds a take-home with a due date', async () => {
    const application = await createApplication();

    const res = await addRoundWith(application.id, { dueOn: '2026-12-01' });

    expect(res.statusCode).toBe(201);
    expect(scheduleIn(res.json<RoundJson>())).toEqual({ ...NOT_SCHEDULED, dueOn: '2026-12-01' });
  });

  it('adds a Round not scheduled yet, with or without nulls', async () => {
    const application = await createApplication();

    const bare = await addRound(application.id);
    const nulls = await addRoundWith(application.id, NOT_SCHEDULED);

    expect(scheduleIn(bare.json<RoundJson>())).toEqual(NOT_SCHEDULED);
    expect(nulls.statusCode).toBe(201);
    expect(scheduleIn(nulls.json<RoundJson>())).toEqual(NOT_SCHEDULED);
  });

  it.each([
    ['a start and a due date', { startsAt: '2026-11-25T15:30:00Z', dueOn: '2026-11-25' }],
    ['a duration without a start', { durationMinutes: 30 }],
    ['a duration with a due date', { dueOn: '2026-11-25', durationMinutes: 30 }],
    ['a duration under 5 minutes', { startsAt: '2026-11-25T15:30:00Z', durationMinutes: 4 }],
    ['a duration over 480 minutes', { startsAt: '2026-11-25T15:30:00Z', durationMinutes: 481 }],
    ['a fractional duration', { startsAt: '2026-11-25T15:30:00Z', durationMinutes: 30.5 }],
    ['a duration as text', { startsAt: '2026-11-25T15:30:00Z', durationMinutes: '30' }],
    ['a start that isn’t a date', { startsAt: 'tomorrow' }],
    ['a start before 1970', { startsAt: '1969-12-31T23:59:59Z' }],
    ['a due date with a time', { dueOn: '2026-11-25T10:00:00Z' }],
    ['a due date that doesn’t exist', { dueOn: '2026-02-30' }],
    ['a due date before 1970', { dueOn: '0000-01-01' }],
  ])('refuses %s with 400, adding nothing', async (_name, schedule) => {
    const application = await createApplication();

    const res = await addRoundWith(application.id, schedule);

    expect(res.statusCode).toBe(400);
    expect((await request('GET', roundsOf(application.id))).json()).toEqual([]);
  });

  it('accepts the shortest and longest durations', async () => {
    const application = await createApplication();
    const startsAt = '2026-11-25T15:30:00.000Z';

    const shortest = await addRoundWith(application.id, { startsAt, durationMinutes: 5 });
    const longest = await addRoundWith(application.id, { startsAt, durationMinutes: 480 });

    expect(shortest.json<RoundJson>().durationMinutes).toBe(5);
    expect(longest.json<RoundJson>().durationMinutes).toBe(480);
  });

  it('sets, changes and clears an existing Round’s schedule', async () => {
    const application = await createApplication();
    const round = (await addRound(application.id)).json<RoundJson>();
    const path = scheduleOf(application.id, round.id);

    const set = await request('PUT', path, {
      startsAt: '2026-11-25T15:30:00.000Z',
      durationMinutes: 60,
    });

    expect(set.statusCode).toBe(200);
    expect(scheduleIn(set.json<RoundJson>())).toEqual({
      startsAt: '2026-11-25T15:30:00.000Z',
      durationMinutes: 60,
      dueOn: null,
    });

    // The schedule is replaced as a whole: the start and duration go with a due date.
    const changed = await request('PUT', path, { dueOn: '2026-11-28' });

    expect(scheduleIn(changed.json<RoundJson>())).toEqual({
      ...NOT_SCHEDULED,
      dueOn: '2026-11-28',
    });

    const cleared = await request('PUT', path, {});

    expect(cleared.statusCode).toBe(200);
    expect(scheduleIn(cleared.json<RoundJson>())).toEqual(NOT_SCHEDULED);

    const [listed] = (await request('GET', roundsOf(application.id))).json<RoundJson[]>();

    expect(listed).toEqual(cleared.json());
    expect(listed?.interviewType).toBe('coding');
  });

  it('refuses an inconsistent schedule with 400, keeping the old one', async () => {
    const application = await createApplication();
    const round = (await addRoundWith(application.id, { dueOn: '2026-11-28' })).json<RoundJson>();
    const path = scheduleOf(application.id, round.id);

    const both = await request('PUT', path, {
      startsAt: '2026-11-25T15:30:00Z',
      dueOn: '2026-11-28',
    });

    const durationOnly = await request('PUT', path, { durationMinutes: 30 });

    expect([both.statusCode, durationOnly.statusCode]).toEqual([400, 400]);
    expect((await request('GET', roundsOf(application.id))).json()).toEqual([round]);
  });

  // The contract keeps these out; the table refuses them too, whatever writes to it.
  it('refuses an inconsistent schedule in the database itself', async () => {
    const application = await createApplication();
    const startsAt = new Date('2026-11-25T15:30:00Z');
    const base = { applicationId: application.id, interviewType: 'coding' as const };

    const insert = (values: Partial<typeof rounds.$inferInsert>) =>
      t.db.insert(rounds).values({ ...base, ...values });

    await expect(insert({ startsAt, dueOn: '2026-11-25' })).rejects.toThrow();
    await expect(insert({ durationMinutes: 30 })).rejects.toThrow();
    await expect(insert({ startsAt, durationMinutes: 4 })).rejects.toThrow();
    await expect(insert({ startsAt, durationMinutes: 481 })).rejects.toThrow();
    await expect(insert({ startsAt, durationMinutes: 480 })).resolves.toBeDefined();
  });

  it('answers 404 for a missing Round, or one under another of the user’s applications', async () => {
    const first = await createApplication();
    const second = await createApplication();
    const round = (await addRound(first.id)).json<RoundJson>();

    const elsewhere = await request('PUT', scheduleOf(second.id, round.id), {
      dueOn: '2026-11-28',
    });

    const missing = await request('PUT', scheduleOf(first.id, MISSING_ID), { dueOn: '2026-11-28' });

    expect([elsewhere.statusCode, missing.statusCode]).toEqual([404, 404]);
    expect((await request('GET', roundsOf(first.id))).json()).toEqual([round]);
  });
});

describe('the order Rounds are listed in', () => {
  it('lists dated Rounds by date, a take-home by its due date, then the rest as added', async () => {
    const application = await createApplication();

    const add = async (interviewType: string, schedule: Record<string, Json>) =>
      (
        await request('POST', roundsOf(application.id), { interviewType, ...schedule })
      ).json<RoundJson>().id;

    const unscheduledFirst = await add('recruiter_screen', {});
    const late = await add('system_design', { startsAt: '2026-12-10T17:00:00Z' });
    const takeHome = await add('take_home', { dueOn: '2026-12-03' });
    const unscheduledSecond = await add('behavioral', {});
    const early = await add('coding', { startsAt: '2026-12-01T17:00:00Z', durationMinutes: 60 });

    const list = (await request('GET', roundsOf(application.id))).json<RoundJson[]>();

    expect(list.map((r) => r.id)).toEqual([
      early,
      takeHome,
      late,
      unscheduledFirst,
      unscheduledSecond,
    ]);
  });

  it('moves a Round when its schedule changes', async () => {
    const application = await createApplication();
    const first = (await addRound(application.id, 'coding')).json<RoundJson>();
    const second = (await addRound(application.id, 'behavioral')).json<RoundJson>();

    await request('PUT', scheduleOf(application.id, second.id), { dueOn: '2026-12-03' });

    const ids = async () =>
      (await request('GET', roundsOf(application.id))).json<RoundJson[]>().map((r) => r.id);

    expect(await ids()).toEqual([second.id, first.id]);

    await request('PUT', scheduleOf(application.id, second.id), {});

    expect(await ids()).toEqual([first.id, second.id]);
  });
});

// CLAUDE.md rule 8: another user's rows are a 404, never a 403, and a malformed id is a 400.
describe('another user’s Rounds', () => {
  let theirs: ApplicationJson;
  let theirRound: RoundJson;
  let mine: string;

  beforeEach(async () => {
    theirs = await createApplication('applied');
    theirRound = (await addRound(theirs.id)).json<RoundJson>();
    ({ cookie: mine } = await signUp(t));
  });

  it('lists as not found', async () => {
    const res = await request('GET', roundsOf(theirs.id), undefined, mine);

    expect(res.statusCode).toBe(404);
  });

  it('adds as not found, adding nothing', async () => {
    const res = await addRound(theirs.id, 'coding', mine);

    expect(res.statusCode).toBe(404);
    expect((await request('GET', roundsOf(theirs.id))).json<RoundJson[]>()).toEqual([theirRound]);
  });

  it('schedules as not found, changing nothing', async () => {
    const res = await request(
      'PUT',
      scheduleOf(theirs.id, theirRound.id),
      { dueOn: '2026-11-28' },
      mine,
    );

    expect(res.statusCode).toBe(404);
    expect((await request('GET', roundsOf(theirs.id))).json<RoundJson[]>()).toEqual([theirRound]);
  });

  it('deletes as not found, deleting nothing', async () => {
    const res = await request('DELETE', `${roundsOf(theirs.id)}/${theirRound.id}`, undefined, mine);

    expect(res.statusCode).toBe(404);
    expect((await request('GET', roundsOf(theirs.id))).json<RoundJson[]>()).toEqual([theirRound]);
  });

  it('answers a missing application the same as theirs', async () => {
    expect((await request('GET', roundsOf(MISSING_ID))).statusCode).toBe(404);
    expect((await addRound(MISSING_ID)).statusCode).toBe(404);
    expect((await request('DELETE', `${roundsOf(MISSING_ID)}/${MISSING_ID}`)).statusCode).toBe(404);
  });

  it('answers a malformed id with 400 on every endpoint', async () => {
    const malformed = [
      await request('GET', roundsOf('abc')),
      await addRound('abc'),
      await request('DELETE', `${roundsOf('abc')}/${theirRound.id}`),
      await request('DELETE', `${roundsOf(theirs.id)}/abc`),
      await request('PUT', scheduleOf('abc', theirRound.id), {}),
      await request('PUT', scheduleOf(theirs.id, 'abc'), {}),
    ];

    expect(malformed.map((res) => res.statusCode)).toEqual([400, 400, 400, 400, 400, 400]);
  });
});
