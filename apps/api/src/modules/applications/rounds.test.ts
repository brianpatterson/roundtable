import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { Schema } from 'effect';
import {
  Application,
  INTERVIEW_TYPES,
  MAX_TAGS,
  Round,
  RoundNotFound,
  TooManyTags,
} from '@roundtable/contract';
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

const tagsOf = (round: RoundJson) => `${roundsOf(round.applicationId)}/${round.id}/tags`;

function addTag(round: RoundJson, tag: string, as = cookie) {
  return request('POST', tagsOf(round), { tag }, as);
}

function removeTag(round: RoundJson, tag: string, as = cookie) {
  return request('DELETE', `${tagsOf(round)}?tag=${encodeURIComponent(tag)}`, undefined, as);
}

async function tagsListed(round: RoundJson) {
  const list = await request('GET', roundsOf(round.applicationId));

  return list.json<RoundJson[]>().find((r) => r.id === round.id)?.tags;
}

async function newRound() {
  const application = await createApplication();

  return (await addRound(application.id)).json<RoundJson>();
}

describe('Tags on a Round', () => {
  it('starts a Round with none', async () => {
    const round = await newRound();

    expect(round.tags).toEqual([]);
  });

  it('adds Tags, trimmed, in the order they were added, and lists them with the Round', async () => {
    const round = await newRound();

    await addTag(round, 'React');
    const res = await addTag(round, '  live debugging ');

    expect(res.statusCode).toBe(200);
    expect(res.json<RoundJson>()).toMatchObject({
      id: round.id,
      tags: ['React', 'live debugging'],
    });
    expect(() => Schema.decodeUnknownSync(Round)(res.json())).not.toThrow();
    expect(await tagsListed(round)).toEqual(['React', 'live debugging']);
  });

  it('keeps one Tag when the same one is added again in another case or with spaces', async () => {
    const round = await newRound();

    await addTag(round, 'SQL');

    for (const tag of ['sql', ' Sql ', 'SQL']) {
      const res = await addTag(round, tag);

      expect(res.statusCode, tag).toBe(200);
      expect(res.json<RoundJson>().tags, tag).toEqual(['SQL']);
    }

    expect(await tagsListed(round)).toEqual(['SQL']);
  });

  it('removes a Tag, matched ignoring case, keeping the others in order', async () => {
    const round = await newRound();

    for (const tag of ['React', 'SQL', 'Go']) await addTag(round, tag);

    const res = await removeTag(round, 'sql');

    expect(res.statusCode).toBe(200);
    expect(res.json<RoundJson>().tags).toEqual(['React', 'Go']);
    expect(await tagsListed(round)).toEqual(['React', 'Go']);
  });

  it('removes a Tag with characters a path couldn’t hold', async () => {
    const round = await newRound();

    await addTag(round, 'CI/CD & ops?');
    const res = await removeTag(round, 'CI/CD & ops?');

    expect(res.statusCode).toBe(200);
    expect(await tagsListed(round)).toEqual([]);
  });

  it('answers a Tag the Round doesn’t have with the Round as it is', async () => {
    const round = await newRound();

    await addTag(round, 'React');
    const res = await removeTag(round, 'Vue');

    expect(res.statusCode).toBe(200);
    expect(res.json<RoundJson>().tags).toEqual(['React']);
  });

  it('rejects a blank Tag, or one longer than 40 characters once trimmed', async () => {
    const round = await newRound();

    for (const tag of ['', '   ', 'x'.repeat(41), ` ${'x'.repeat(41)} `]) {
      const res = await addTag(round, tag);

      expect(res.statusCode, JSON.stringify(tag)).toBe(400);
    }

    expect((await request('POST', tagsOf(round), {})).statusCode).toBe(400);
    expect((await addTag(round, ` ${'x'.repeat(40)} `)).statusCode).toBe(200);
    expect(await tagsListed(round)).toEqual(['x'.repeat(40)]);
  });

  it('rejects an eleventh Tag with TooManyTags, but still accepts one it has', async () => {
    const round = await newRound();
    const ten = Array.from({ length: MAX_TAGS }, (_, i) => `tag ${i + 1}`);

    for (const tag of ten) expect((await addTag(round, tag)).statusCode).toBe(200);

    const res = await addTag(round, 'one more');

    expect(res.statusCode).toBe(400);
    expect(Schema.decodeUnknownSync(TooManyTags)(res.json())).toBeInstanceOf(TooManyTags);
    expect((await addTag(round, 'TAG 3')).statusCode).toBe(200);
    expect(await tagsListed(round)).toEqual(ten);

    await removeTag(round, 'tag 1');
    expect((await addTag(round, 'one more')).json<RoundJson>().tags).toHaveLength(MAX_TAGS);
  });

  it('keeps to the limit when Tags are added at once', async () => {
    const round = await newRound();
    const tags = Array.from({ length: MAX_TAGS + 5 }, (_, i) => `tag ${i + 1}`);

    const answers = await Promise.all(tags.map((tag) => addTag(round, tag)));

    expect(answers.filter((res) => res.statusCode === 200)).toHaveLength(MAX_TAGS);
    expect(await tagsListed(round)).toHaveLength(MAX_TAGS);
  });

  it('answers 404 for a Round that doesn’t exist or is under another application', async () => {
    const round = await newRound();
    const other = await createApplication();
    const elsewhere = { ...round, applicationId: other.id };
    const missing = { ...round, id: MISSING_ID };

    expect((await addTag(elsewhere, 'React')).statusCode).toBe(404);
    expect((await removeTag(elsewhere, 'React')).statusCode).toBe(404);
    expect((await addTag(missing, 'React')).statusCode).toBe(404);
    expect((await removeTag(missing, 'React')).statusCode).toBe(404);
    expect(await tagsListed(round)).toEqual([]);
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
    ['a due date before 1970', { dueOn: '1969-12-31' }],
  ])('refuses %s with 400, adding nothing', async (_name, schedule) => {
    const application = await createApplication();

    const res = await addRoundWith(application.id, schedule);

    expect(res.statusCode).toBe(400);
    expect((await request('GET', roundsOf(application.id))).json()).toEqual([]);
  });

  it('accepts the earliest start and due date', async () => {
    const application = await createApplication();

    const start = await addRoundWith(application.id, { startsAt: '1970-01-01T00:00:00.000Z' });
    const due = await addRoundWith(application.id, { dueOn: '1970-01-01' });

    expect(start.json<RoundJson>().startsAt).toBe('1970-01-01T00:00:00.000Z');
    expect(due.json<RoundJson>().dueOn).toBe('1970-01-01');
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

const ratingOf = (round: RoundJson) => `${roundsOf(round.applicationId)}/${round.id}/rating`;

/** The Self-rating fields of a Round as the API returns it. */
const ratingIn = (round: RoundJson) => ({
  selfRating: round.selfRating,
  ratingNote: round.ratingNote,
});

const NOT_RATED = { selfRating: null, ratingNote: null };

describe('rating a Round', () => {
  it('starts a Round not rated', async () => {
    const round = await newRound();

    expect(ratingIn(round)).toEqual(NOT_RATED);
  });

  it('rates a Round from 1 to 5, and lists the rating with it', async () => {
    const round = await newRound();

    for (const selfRating of [1, 2, 3, 4, 5]) {
      const res = await request('PUT', ratingOf(round), { selfRating });

      expect(res.statusCode).toBe(200);
      expect(ratingIn(res.json<RoundJson>())).toEqual({ selfRating, ratingNote: null });
    }

    const [listed] = (await request('GET', roundsOf(round.applicationId))).json<RoundJson[]>();

    expect(ratingIn(listed ?? round)).toEqual({ selfRating: 5, ratingNote: null });
  });

  it('saves a note with the rating, up to 2000 characters, or a note alone', async () => {
    const round = await newRound();

    const both = await request('PUT', ratingOf(round), {
      selfRating: 2,
      ratingNote: 'Ran out of time on the second part',
    });

    expect(ratingIn(both.json<RoundJson>())).toEqual({
      selfRating: 2,
      ratingNote: 'Ran out of time on the second part',
    });

    const longest = await request('PUT', ratingOf(round), {
      selfRating: 3,
      ratingNote: 'x'.repeat(2000),
    });

    expect(longest.json<RoundJson>().ratingNote).toHaveLength(2000);

    const noteAlone = await request('PUT', ratingOf(round), { ratingNote: 'Nerves' });

    expect(ratingIn(noteAlone.json<RoundJson>())).toEqual({
      selfRating: null,
      ratingNote: 'Nerves',
    });
  });

  it('changes and clears the rating and the note, replacing them as a whole', async () => {
    const round = await newRound();

    await request('PUT', ratingOf(round), { selfRating: 2, ratingNote: 'Rushed' });

    const changed = await request('PUT', ratingOf(round), { selfRating: 4, ratingNote: 'Better' });

    expect(ratingIn(changed.json<RoundJson>())).toEqual({ selfRating: 4, ratingNote: 'Better' });

    // What isn't sent is cleared: the note goes, the rating stays as sent.
    const noteCleared = await request('PUT', ratingOf(round), { selfRating: 4 });

    expect(ratingIn(noteCleared.json<RoundJson>())).toEqual({ selfRating: 4, ratingNote: null });

    const ratingCleared = await request('PUT', ratingOf(round), {
      selfRating: null,
      ratingNote: 'Kept',
    });

    expect(ratingIn(ratingCleared.json<RoundJson>())).toEqual({
      selfRating: null,
      ratingNote: 'Kept',
    });

    const cleared = await request('PUT', ratingOf(round), {});

    expect(cleared.statusCode).toBe(200);
    expect(ratingIn(cleared.json<RoundJson>())).toEqual(NOT_RATED);

    const [listed] = (await request('GET', roundsOf(round.applicationId))).json<RoundJson[]>();

    expect(listed).toEqual(cleared.json());
  });

  it('stores a blank note as no note', async () => {
    const round = await newRound();

    const res = await request('PUT', ratingOf(round), { selfRating: 3, ratingNote: '  \n ' });

    expect(ratingIn(res.json<RoundJson>())).toEqual({ selfRating: 3, ratingNote: null });
  });

  it.each([
    ['a rating of 0', { selfRating: 0 }],
    ['a rating of 6', { selfRating: 6 }],
    ['a negative rating', { selfRating: -1 }],
    ['a fractional rating', { selfRating: 2.5 }],
    ['a rating as text', { selfRating: '3' }],
    ['a note over 2000 characters', { selfRating: 3, ratingNote: 'x'.repeat(2001) }],
    ['a note that isn’t text', { ratingNote: 42 }],
  ])('refuses %s with 400, keeping the old rating', async (_name, rating) => {
    const round = await newRound();

    await request('PUT', ratingOf(round), { selfRating: 4, ratingNote: 'Fine' });

    const res = await request('PUT', ratingOf(round), rating);

    expect(res.statusCode).toBe(400);

    const [listed] = (await request('GET', roundsOf(round.applicationId))).json<RoundJson[]>();

    expect(ratingIn(listed ?? round)).toEqual({ selfRating: 4, ratingNote: 'Fine' });
  });

  // The contract keeps these out; the table refuses them too, whatever writes to it.
  it('refuses a rating outside 1–5 or a longer note in the database itself', async () => {
    const application = await createApplication();
    const base = { applicationId: application.id, interviewType: 'coding' as const };

    const insert = (values: Partial<typeof rounds.$inferInsert>) =>
      t.db.insert(rounds).values({ ...base, ...values });

    await expect(insert({ selfRating: 0 })).rejects.toThrow();
    await expect(insert({ selfRating: 6 })).rejects.toThrow();
    await expect(insert({ ratingNote: 'x'.repeat(2001) })).rejects.toThrow();
    await expect(insert({ selfRating: 5, ratingNote: 'x'.repeat(2000) })).resolves.toBeDefined();
  });

  it('answers 404 for a missing Round, or one under another of the user’s applications', async () => {
    const round = await newRound();
    const other = await createApplication();

    const elsewhere = await request('PUT', ratingOf({ ...round, applicationId: other.id }), {
      selfRating: 3,
    });

    const missing = await request('PUT', ratingOf({ ...round, id: MISSING_ID }), { selfRating: 3 });

    expect([elsewhere.statusCode, missing.statusCode]).toEqual([404, 404]);
    expect((await request('GET', roundsOf(round.applicationId))).json()).toEqual([round]);
  });
});

const outcomeOf = (round: RoundJson) => `${roundsOf(round.applicationId)}/${round.id}/outcome`;

/** The Outcome fields of a Round as the API returns it. */
const outcomeIn = (round: RoundJson) => ({
  outcome: round.outcome,
  outcomeSetByUser: round.outcomeSetByUser,
});

describe('a Round’s Outcome', () => {
  it('starts a Round pending, not set by the user', async () => {
    const round = await newRound();

    expect(outcomeIn(round)).toEqual({ outcome: 'pending', outcomeSetByUser: false });
  });

  // Rows from before the column: the migration's default makes them pending.
  it('reads a Round inserted without an Outcome as pending, not set by the user', async () => {
    const application = await createApplication();

    await t.db.insert(rounds).values({ applicationId: application.id, interviewType: 'coding' });

    const [listed] = (await request('GET', roundsOf(application.id))).json<RoundJson[]>();

    expect(listed && outcomeIn(listed)).toEqual({ outcome: 'pending', outcomeSetByUser: false });
  });

  it('sets it to passed, failed, unknown and back to pending, each saved and listed', async () => {
    const round = await newRound();

    for (const outcome of ['passed', 'failed', 'unknown', 'pending']) {
      const res = await request('PUT', outcomeOf(round), { outcome });

      expect(res.statusCode).toBe(200);
      expect(outcomeIn(res.json<RoundJson>())).toEqual({ outcome, outcomeSetByUser: true });

      const [listed] = (await request('GET', roundsOf(round.applicationId))).json<RoundJson[]>();

      expect(listed && outcomeIn(listed)).toEqual({ outcome, outcomeSetByUser: true });
    }
  });

  it('changes nothing else on the Round', async () => {
    const round = await newRound();

    await request('PUT', ratingOf(round), { selfRating: 4, ratingNote: 'Fine' });

    const res = await request('PUT', outcomeOf(round), { outcome: 'passed' });

    expect(res.json<RoundJson>()).toMatchObject({
      interviewType: round.interviewType,
      selfRating: 4,
      ratingNote: 'Fine',
    });
  });

  it.each([
    ['an Outcome outside the four', { outcome: 'advanced' }],
    ['an Outcome in another case', { outcome: 'Passed' }],
    ['no Outcome', {}],
    ['a null Outcome', { outcome: null }],
  ])('refuses %s with 400, keeping the old one', async (_name, body) => {
    const round = await newRound();

    await request('PUT', outcomeOf(round), { outcome: 'failed' });

    const res = await request('PUT', outcomeOf(round), body);

    expect(res.statusCode).toBe(400);

    const [listed] = (await request('GET', roundsOf(round.applicationId))).json<RoundJson[]>();

    expect(listed && outcomeIn(listed)).toEqual({ outcome: 'failed', outcomeSetByUser: true });
  });

  it('refuses an Outcome outside the four in the database itself', async () => {
    const application = await createApplication();

    await expect(
      t.db.execute(
        sql`insert into rounds (application_id, interview_type, outcome) values (${application.id}, 'coding', 'advanced')`,
      ),
    ).rejects.toThrow();
  });

  it('answers 404 for a missing Round, or one under another of the user’s applications', async () => {
    const round = await newRound();
    const other = await createApplication();

    const elsewhere = await request('PUT', outcomeOf({ ...round, applicationId: other.id }), {
      outcome: 'passed',
    });

    const missing = await request('PUT', outcomeOf({ ...round, id: MISSING_ID }), {
      outcome: 'passed',
    });

    expect([elsewhere.statusCode, missing.statusCode]).toEqual([404, 404]);
    expect((await request('GET', roundsOf(round.applicationId))).json()).toEqual([round]);
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

  it('rates as not found, changing nothing', async () => {
    const res = await request(
      'PUT',
      ratingOf(theirRound),
      { selfRating: 1, ratingNote: 'Not mine to rate' },
      mine,
    );

    expect(res.statusCode).toBe(404);
    expect(Schema.decodeUnknownSync(RoundNotFound)(res.json())).toBeInstanceOf(RoundNotFound);
    expect((await request('GET', roundsOf(theirs.id))).json<RoundJson[]>()).toEqual([theirRound]);
  });

  it('sets their Outcome as not found, changing nothing', async () => {
    const res = await request('PUT', outcomeOf(theirRound), { outcome: 'failed' }, mine);

    expect(res.statusCode).toBe(404);
    expect(Schema.decodeUnknownSync(RoundNotFound)(res.json())).toBeInstanceOf(RoundNotFound);
    expect((await request('GET', roundsOf(theirs.id))).json<RoundJson[]>()).toEqual([theirRound]);
  });

  it('deletes as not found, deleting nothing', async () => {
    const res = await request('DELETE', `${roundsOf(theirs.id)}/${theirRound.id}`, undefined, mine);

    expect(res.statusCode).toBe(404);
    expect((await request('GET', roundsOf(theirs.id))).json<RoundJson[]>()).toEqual([theirRound]);
  });

  it('changes their Tags as not found, changing nothing', async () => {
    await addTag(theirRound, 'React');

    const added = await addTag(theirRound, 'SQL', mine);
    const removed = await removeTag(theirRound, 'React', mine);

    expect([added.statusCode, removed.statusCode]).toEqual([404, 404]);
    expect(Schema.decodeUnknownSync(RoundNotFound)(added.json())).toBeInstanceOf(RoundNotFound);
    expect(await tagsListed(theirRound)).toEqual(['React']);
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
      await addTag({ ...theirRound, applicationId: 'abc' }, 'React'),
      await removeTag({ ...theirRound, id: 'abc' }, 'React'),
      await request('PUT', scheduleOf('abc', theirRound.id), {}),
      await request('PUT', scheduleOf(theirs.id, 'abc'), {}),
      await request('PUT', ratingOf({ ...theirRound, applicationId: 'abc' }), {}),
      await request('PUT', ratingOf({ ...theirRound, id: 'abc' }), {}),
      await request('PUT', outcomeOf({ ...theirRound, applicationId: 'abc' }), {
        outcome: 'passed',
      }),
      await request('PUT', outcomeOf({ ...theirRound, id: 'abc' }), { outcome: 'passed' }),
    ];

    expect(malformed.map((res) => res.statusCode)).toEqual(Array(12).fill(400));
  });
});
