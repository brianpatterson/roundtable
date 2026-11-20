// The factory's read endpoint for problem reports (ADR-0041), through the real app and the
// app_test database: who may read a report, what it holds, and what it never holds.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { Redacted, Schema } from 'effect';
import { FactoryReport } from '@roundtable/contract';
import { setupTestApp, signUp, type TestApp } from '#test/helpers';
import { FACTORY_REPORT_MAX_AGE_DAYS, hasFactoryToken } from './factory-reports.js';
import { userReports } from './schema.js';

const TOKEN = 'factory-token-0123456789abcdef0123456789abcdef';

const diagnostics = {
  viewport: { width: 360, height: 740 },
  theme: 'dark',
  requests: [{ method: 'GET', path: '/api/applications', status: 500, secondsBefore: 4 }],
  errors: [
    { message: 'TypeError: x is undefined', stack: 'at List (List.tsx:12)', secondsBefore: 3 },
  ],
};

async function sendReport(t: TestApp, cookie?: string) {
  const res = await t.inject({
    method: 'POST',
    url: '/api/reports',
    headers: {
      'user-agent': 'Mozilla/5.0 Firefox/128.0 secret-extension/1.2',
      'x-forwarded-for': `203.0.113.${Math.floor(Math.random() * 250)}`,
      ...(cookie && { cookie }),
    },
    payload: {
      description: 'The list is empty after I add an application',
      replyEmail: 'me@example.com',
      pagePath: '/',
      diagnostics,
    },
  });

  expect(res.statusCode).toBe(201);

  return res.json<{ id: string }>().id;
}

const read = (t: TestApp, id: string, authorization?: string) =>
  t.inject({
    method: 'GET',
    url: `/api/factory/reports/${id}`,
    headers: authorization ? { authorization } : {},
  });

describe('the factory reads a report', () => {
  const t = setupTestApp({ env: { FACTORY_REPORTS_TOKEN: Redacted.make(TOKEN) } });

  beforeAll(() => t.migrate());
  beforeEach(() => t.reset());
  afterAll(() => t.close());

  it('with the token: what the user wrote and what their browser saw', async () => {
    const id = await sendReport(t);
    const res = await read(t, id, `Bearer ${TOKEN}`);

    expect(res.statusCode).toBe(200);
    const report = Schema.decodeUnknownSync(FactoryReport)(res.json());

    expect(report).toMatchObject({
      id,
      description: 'The list is empty after I add an application',
      pagePath: '/',
      browser: 'Firefox',
      signedIn: false,
      diagnostics,
    });
  });

  it('never says who sent it: no reply address, user id or user agent', async () => {
    const { cookie } = await signUp(t);
    const id = await sendReport(t, cookie);
    const res = await read(t, id, `Bearer ${TOKEN}`);
    const [row] = await t.db.select().from(userReports).where(eq(userReports.id, id));

    expect(res.json<{ signedIn: boolean }>().signedIn).toBe(true);
    expect(Object.keys(res.json<object>()).sort()).toEqual([
      'browser',
      'createdAt',
      'description',
      'diagnostics',
      'id',
      'pagePath',
      'release',
      'signedIn',
    ]);
    expect(res.body).not.toContain('me@example.com');
    expect(res.body).not.toContain(row!.userId!);
    expect(res.body).not.toContain('secret-extension');
  });

  it.each([
    ['no Authorization header', undefined],
    ['a wrong token', 'Bearer not-the-token'],
    ['the token without Bearer', TOKEN],
    ['a session-style scheme', `Basic ${TOKEN}`],
  ])('refuses %s with a 401', async (_name, authorization) => {
    const id = await sendReport(t);
    const res = await read(t, id, authorization);

    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain('The list is empty');
  });

  it('a stored diagnostics value that does not decode costs only the diagnostics', async () => {
    const id = await sendReport(t);

    await t.db
      .update(userReports)
      .set({ diagnostics: sql`'{"theme":"pink"}'::jsonb` })
      .where(eq(userReports.id, id));

    const res = await read(t, id, `Bearer ${TOKEN}`);

    expect(res.statusCode).toBe(200);
    expect(res.json<{ description: string; diagnostics: unknown }>()).toMatchObject({
      description: 'The list is empty after I add an application',
      diagnostics: null,
    });
  });

  it('an unknown id is a 404, and a malformed one a 400', async () => {
    expect((await read(t, crypto.randomUUID(), `Bearer ${TOKEN}`)).statusCode).toBe(404);
    expect((await read(t, 'not-a-uuid', `Bearer ${TOKEN}`)).statusCode).toBe(400);
  });

  it(`a report older than ${FACTORY_REPORT_MAX_AGE_DAYS} days is a 404`, async () => {
    const id = await sendReport(t);

    await t.db
      .update(userReports)
      .set({
        createdAt: sql`now() - make_interval(days => ${FACTORY_REPORT_MAX_AGE_DAYS}, mins => 1)`,
      })
      .where(eq(userReports.id, id));

    expect((await read(t, id, `Bearer ${TOKEN}`)).statusCode).toBe(404);
  });
});

describe('without FACTORY_REPORTS_TOKEN', () => {
  const t = setupTestApp();

  beforeAll(() => t.migrate());
  beforeEach(() => t.reset());
  afterAll(() => t.close());

  it('nobody can read a report', async () => {
    const id = await sendReport(t);

    expect((await read(t, id, 'Bearer ')).statusCode).toBe(401);
    expect((await read(t, id, 'Bearer undefined')).statusCode).toBe(401);
  });
});

describe('hasFactoryToken', () => {
  it('matches only the exact token after "Bearer "', () => {
    expect(hasFactoryToken(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(hasFactoryToken(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
    expect(hasFactoryToken(`Bearer ${TOKEN.slice(0, -1)}`, TOKEN)).toBe(false);
    expect(hasFactoryToken(`bearer ${TOKEN}`, TOKEN)).toBe(false);
    expect(hasFactoryToken(undefined, TOKEN)).toBe(false);
    expect(hasFactoryToken('Bearer ', undefined)).toBe(false);
    expect(hasFactoryToken('Bearer ', '')).toBe(false);
  });
});
