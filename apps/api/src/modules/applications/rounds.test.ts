import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
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
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
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
    ];

    expect(malformed.map((res) => res.statusCode)).toEqual([400, 400, 400, 400, 400, 400]);
  });
});
