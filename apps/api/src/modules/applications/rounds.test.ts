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
    ];

    expect(malformed.map((res) => res.statusCode)).toEqual([400, 400, 400, 400]);
  });
});
