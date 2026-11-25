import { Round, type InterviewType } from '@roundtable/contract';
import { makeApiClient } from '@roundtable/contract/client';
import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import { round, serverError, setUpFakeApi } from './fake-api';

// The adapter through its interface: the real typed client, with its `fetch`.
const fake = setUpFakeApi();

const client = () => makeApiClient({ baseUrl: 'http://localhost', fetch: fake.fetch });

describe('the fake API', () => {
  it('leaves the Rounds of accepted, rejected and withdrawn Applications off the Agenda', async () => {
    for (const status of ['accepted', 'rejected', 'withdrawn', 'interviewing'] as const) {
      const { id } = fake.seedApplication({ status, company: status });

      fake.seedRound(id);
    }

    const agenda = await client().agenda();

    expect(agenda.map((r) => r.company)).toEqual(['interviewing']);
  });

  it('fails the request, and the test, when its answer doesn’t encode with the contract', async () => {
    const { id } = fake.seedApplication();

    // SAFETY: deliberately not an Interview type, to break the contract.
    fake.seedRound(id, { interviewType: 'pairing' as InterviewType });

    await expect(client().listRounds(id)).rejects.toThrow();

    const [violation, ...others] = fake.takeViolations();

    expect(others).toEqual([]);
    expect(violation?.message).toContain('applications.listRounds');
    expect(violation?.message).toContain('SchemaError');
    expect(violation?.message).toContain('["interviewType"]');
  });

  it('defaults every field of a Round, so it encodes with the contract as it is', async () => {
    expect(() => Schema.encodeSync(Round)(round())).not.toThrow();

    const { id } = fake.seedApplication();
    const seeded = fake.seedRound(id);

    expect(await client().listRounds(id)).toEqual([seeded]);
  });

  describe('overrides', () => {
    it('answers with an override’s response, a 500 here', async () => {
      fake.on('applications.list', serverError);

      await expect(client().listApplications()).rejects.toThrow();
      expect(fake.calls()).toEqual([{ endpoint: 'applications.list', status: 500 }]);
      expect(fake.takeViolations()).toEqual([]);
    });

    it('drops the override before the next test', async () => {
      fake.seedApplication({ company: 'Globex' });

      expect((await client().listApplications()).map((a) => a.company)).toEqual(['Globex']);
    });

    it('holds an answer until the override lets it go', async () => {
      let release = () => {};

      const held = new Promise<undefined>((resolve) => {
        release = () => resolve(undefined);
      });

      fake.on('applications.create', () => held);

      let answered = false;

      const created = client()
        .createApplication({ company: 'Acme', jobTitle: 'Engineer' })
        .then((application) => {
          answered = true;

          return application;
        });

      await expect.poll(() => fake.received('applications.create')).toHaveLength(1);
      expect(answered).toBe(false);

      release();

      expect((await created).company).toBe('Acme');
      expect(fake.received('applications.create')).toEqual([
        { company: 'Acme', jobTitle: 'Engineer' },
      ]);
    });

    it('gives the override the request, its body unread', async () => {
      const seen: { method: string; path: string; body: unknown }[] = [];

      fake.on('applications.create', async (request) => {
        seen.push({
          method: request.method,
          path: new URL(request.url).pathname,
          body: await request.json(),
        });

        return undefined;
      });

      const created = await client().createApplication({ company: 'Acme', jobTitle: 'Engineer' });

      expect(created.company).toBe('Acme');
      expect(seen).toEqual([
        {
          method: 'POST',
          path: '/api/applications',
          body: { company: 'Acme', jobTitle: 'Engineer' },
        },
      ]);
    });
  });

  it('answers 401 once the session has run out, and Better Auth’s session then answers null', async () => {
    fake.expireSessionAfter(1);

    await client().listApplications();
    await expect(client().listApplications()).rejects.toThrow();
    expect(fake.calls().map((call) => call.status)).toEqual([200, 401]);

    const session = await fake.fetch('http://localhost/api/auth/get-session');

    expect(await session.json()).toBeNull();
  });

  it('stores what it’s told, inferring nothing from a new Round', async () => {
    const { id } = fake.seedApplication({ status: 'applied' });
    const earlier = fake.seedRound(id);

    await client().createRound(id, { interviewType: 'coding' });

    expect(fake.application(id)?.status).toBe('applied');
    expect(fake.rounds(id)[0]).toEqual(earlier);
  });
});
