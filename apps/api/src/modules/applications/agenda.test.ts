import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Schema } from 'effect';
import { AgendaRound, APPLICATION_STATUSES, Application } from '@roundtable/contract';
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

type AgendaJson = (typeof AgendaRound.Encoded)[];

/**
 * When every Agenda here is read: Tuesday 24 November 2026, 10:00 UTC. That's 05:00 the same day
 * in New York and 19:00 in Tokyo.
 */
const NOW = new Date('2026-11-24T10:00:00Z');

function request(method: 'GET' | 'POST' | 'PATCH', url: string, payload?: Json, as = cookie) {
  return t.inject({ method, url, payload, headers: { cookie: as } });
}

async function createApplication(company: string, as = cookie) {
  const res = await request(
    'POST',
    '/api/applications',
    { company, jobTitle: `${company} engineer`, status: 'interviewing' },
    as,
  );

  return res.json<ApplicationJson>();
}

/** Adds a Round with `schedule` (none: not scheduled yet) to the application. */
async function addRound(
  applicationId: string,
  schedule: { readonly [key: string]: Json } = {},
  as = cookie,
) {
  const res = await request(
    'POST',
    `/api/applications/${applicationId}/rounds`,
    { interviewType: 'coding', ...schedule },
    as,
  );

  expect(res.statusCode).toBe(201);

  return res.json<{ id: string }>();
}

/** Reads the Agenda as it is at `NOW`, with `query` (`?timeZone=…`) if given. */
async function readAgenda(query = '', as = cookie) {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });

  try {
    return await t.inject({ method: 'GET', url: `/api/agenda${query}`, headers: { cookie: as } });
  } finally {
    vi.useRealTimers();
  }
}

async function agenda(query = '') {
  const res = await readAgenda(query);

  expect(res.statusCode).toBe(200);

  return res.json<AgendaJson>();
}

describe('agenda API', () => {
  it('returns upcoming Rounds across Applications, each with its Application', async () => {
    const acme = await createApplication('Acme');
    const globex = await createApplication('Globex');
    const screen = await addRound(acme.id, { startsAt: '2026-11-25T15:00:00Z' });
    const design = await addRound(globex.id, { startsAt: '2026-11-26T15:00:00Z' });

    const res = await readAgenda('?timeZone=America/New_York');

    expect(res.statusCode).toBe(200);

    const rounds = Schema.decodeUnknownSync(Schema.Array(AgendaRound))(res.json());

    expect(rounds).toMatchObject([
      {
        id: screen.id,
        applicationId: acme.id,
        company: 'Acme',
        jobTitle: 'Acme engineer',
        interviewType: 'coding',
        startsAt: new Date('2026-11-25T15:00:00Z'),
        outcome: 'pending',
      },
      { id: design.id, applicationId: globex.id, company: 'Globex', jobTitle: 'Globex engineer' },
    ]);
  });

  it('leaves out the Rounds of rejected, withdrawn and accepted Applications', async () => {
    for (const status of APPLICATION_STATUSES) {
      const application = await createApplication(status);

      await addRound(application.id);

      const res = await request('PATCH', `/api/applications/${application.id}`, { status });

      expect(res.statusCode).toBe(200);
    }

    const companies = (await agenda()).map((round) => round.company);

    expect(companies).toEqual(['saved', 'applied', 'interviewing', 'offer']);
  });

  it('keeps a Round from earlier today, even finished, and drops one from yesterday', async () => {
    const application = await createApplication('Acme');

    // Midnight in New York, an hour long: over by 01:00, four hours before NOW there.
    const today = await addRound(application.id, {
      startsAt: '2026-11-24T05:00:00Z',
      durationMinutes: 60,
    });

    // A minute before midnight in New York: yesterday there.
    await addRound(application.id, { startsAt: '2026-11-24T04:59:00Z' });

    const ids = (await agenda('?timeZone=America/New_York')).map((round) => round.id);

    expect(ids).toEqual([today.id]);
  });

  it('keeps a take-home due today and drops one due yesterday', async () => {
    const application = await createApplication('Acme');
    const today = await addRound(application.id, { dueOn: '2026-11-24' });

    await addRound(application.id, { dueOn: '2026-11-23' });

    const ids = (await agenda('?timeZone=America/New_York')).map((round) => round.id);

    expect(ids).toEqual([today.id]);
  });

  it('cuts off by the day in the user’s time zone, not UTC’s', async () => {
    const application = await createApplication('Acme');

    // 23:30 UTC on Monday is 08:30 on Tuesday in Tokyo, where NOW is Tuesday too.
    const round = await addRound(application.id, { startsAt: '2026-11-23T23:30:00Z' });

    expect((await agenda('?timeZone=Asia/Tokyo')).map((r) => r.id)).toEqual([round.id]);
    expect(await agenda('?timeZone=UTC')).toEqual([]);
  });

  it('uses UTC days without a time zone', async () => {
    const application = await createApplication('Acme');

    // Midnight UTC on Tuesday: Monday evening in New York.
    const round = await addRound(application.id, { startsAt: '2026-11-24T00:00:00Z' });

    expect((await agenda()).map((r) => r.id)).toEqual([round.id]);
    expect(await agenda('?timeZone=America/New_York')).toEqual([]);
  });

  it.each(['%2B05%3A30', 'Mars%2FOlympus_Mons', ''])(
    'refuses the time zone "%s" with a 400',
    async (timeZone) => {
      const res = await readAgenda(`?timeZone=${timeZone}`);

      expect(res.statusCode).toBe(400);
    },
  );

  it('puts Rounds with no date after every dated one, in the order they were added', async () => {
    const zeta = await createApplication('Zeta');
    const acme = await createApplication('Acme');
    const first = await addRound(zeta.id);
    const dated = await addRound(acme.id, { dueOn: '2027-06-01' });
    const second = await addRound(acme.id);

    const ids = (await agenda()).map((round) => round.id);

    expect(ids).toEqual([dated.id, first.id, second.id]);
  });

  it('orders dated Rounds across Applications, and those at the same moment by company', async () => {
    const zeta = await createApplication('Zeta');
    const beta = await createApplication('Beta');
    const acme = await createApplication('Acme');
    const mid = await createApplication('Mid');

    // Added in an order unlike the one expected.
    const takeHome = await addRound(mid.id, { dueOn: '2026-11-26' });
    const zetaRound = await addRound(zeta.id, { startsAt: '2026-11-25T15:00:00Z' });
    const acmeRound = await addRound(acme.id, { startsAt: '2026-11-25T15:00:00Z' });
    const betaRound = await addRound(beta.id, { startsAt: '2026-11-25T12:00:00Z' });

    const ids = (await agenda('?timeZone=UTC')).map((round) => round.id);

    expect(ids).toEqual([betaRound.id, acmeRound.id, zetaRound.id, takeHome.id]);
  });

  it('shows none of another user’s Rounds', async () => {
    const other = await signUp(t, 'other@example.com');
    const theirs = await createApplication('Theirs', other.cookie);

    await addRound(theirs.id, { startsAt: '2026-11-25T15:00:00Z' }, other.cookie);
    await addRound(theirs.id, {}, other.cookie);

    expect(await agenda()).toEqual([]);

    const res = await readAgenda('', other.cookie);

    expect(res.json<AgendaJson>()).toHaveLength(2);
  });

  it('answers 401 without a session', async () => {
    const res = await t.inject({ method: 'GET', url: '/api/agenda' });

    expect(res.statusCode).toBe(401);
  });
});
