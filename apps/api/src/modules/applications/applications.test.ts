import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { Schema } from 'effect';
import { Application } from '@roundtable/contract';
import { setupTestApp, signUp, type Json } from '#test/helpers';
import { applications } from './schema.js';

const t = setupTestApp();
let cookie: string;

beforeAll(() => t.migrate());

beforeEach(async () => {
  await t.reset();
  ({ cookie } = await signUp(t));
});

afterAll(() => t.close());

afterEach(() => vi.useRealTimers());

// Responses as they arrive on the wire: dates are still ISO 8601 strings.
type ApplicationJson = typeof Application.Encoded;

// Raw request bodies, deliberately untyped by the contract: several tests send invalid input.
type Payload = Json;

function request(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: Payload) {
  return t.inject({ method, url, payload, headers: { cookie } });
}

async function create(body: Payload) {
  const res = await request('POST', '/api/applications', body);

  return { res, json: res.json<ApplicationJson>() };
}

describe('applications API', () => {
  it('creates an application with default status and timestamps', async () => {
    const { res, json } = await create({ company: 'Acme', jobTitle: 'Software Engineer' });
    expect(res.statusCode).toBe(201);
    expect(json).toMatchObject({
      company: 'Acme',
      jobTitle: 'Software Engineer',
      jobUrl: null,
      status: 'applied',
    });
    expect(json.createdAt).toBe(json.updatedAt);
    // Sent when it was created, by Postgres's clock (ADR-0045).
    expect(json.appliedAt).toBe(json.createdAt);
  });

  it('returns bodies that match the shared contract', async () => {
    const { json: created } = await create({ company: 'Acme', jobTitle: 'SWE' });
    const list = await request('GET', '/api/applications');
    const updated = await request('PATCH', `/api/applications/${created.id}`, { status: 'offer' });

    // The web client decodes every response with these schemas, so a mismatch would break it.
    expect(() => Schema.decodeSync(Application)(created)).not.toThrow();
    expect(() => Schema.decodeUnknownSync(Schema.Array(Application))(list.json())).not.toThrow();
    expect(() => Schema.decodeUnknownSync(Application)(updated.json())).not.toThrow();
  });

  it('rejects invalid input', async () => {
    const { res } = await create({ company: '', jobTitle: 'SWE', jobUrl: 'not a url' });
    expect(res.statusCode).toBe(400);
  });

  it('lists applications most recently updated first', async () => {
    const { json: first } = await create({ company: 'First', jobTitle: 'SWE' });
    await create({ company: 'Second', jobTitle: 'SWE' });
    await request('PATCH', `/api/applications/${first.id}`, { status: 'interviewing' });

    const res = await request('GET', '/api/applications');
    expect(res.json<ApplicationJson[]>().map((a) => a.company)).toEqual(['First', 'Second']);
  });

  it('updates status and bumps updatedAt', async () => {
    const { json: created } = await create({ company: 'Acme', jobTitle: 'SWE' });

    const res = await request('PATCH', `/api/applications/${created.id}`, {
      status: 'interviewing',
    });

    const updated = res.json<ApplicationJson>();
    expect(res.statusCode).toBe(200);
    expect(updated.status).toBe('interviewing');
    expect(new Date(updated.updatedAt) > new Date(created.updatedAt)).toBe(true);
    expect(updated.createdAt).toBe(created.createdAt);
  });

  it('bumps updatedAt even when the API clock is behind the database clock', async () => {
    const { json: created } = await create({ company: 'Acme', jobTitle: 'SWE' });

    // Clocks on different machines (or Docker Desktop's VM) drift apart. createdAt comes from
    // Postgres, so updatedAt must too, or an update can land "before" the row was created.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() - 60_000 });
    const res = await request('PATCH', `/api/applications/${created.id}`, { status: 'offer' });
    vi.useRealTimers();

    const updated = res.json<ApplicationJson>();
    expect(new Date(updated.updatedAt) > new Date(created.updatedAt)).toBe(true);
  });

  it('accepts only http(s) job URLs, on create and on update', async () => {
    const { res: ok, json: created } = await create({
      company: 'Acme',
      jobTitle: 'SWE',
      jobUrl: 'https://example.com/jobs/1',
    });

    expect(ok.statusCode).toBe(201);

    for (const jobUrl of ['javascript:alert(document.cookie)', 'data:text/html,x', 'ftp://x.y']) {
      const { res } = await create({ company: 'Acme', jobTitle: 'SWE', jobUrl });

      expect(res.statusCode, jobUrl).toBe(400);

      const patched = await request('PATCH', `/api/applications/${created.id}`, { jobUrl });

      expect(patched.statusCode, jobUrl).toBe(400);
    }
  });

  it('rejects an unknown status', async () => {
    const { json: created } = await create({ company: 'Acme', jobTitle: 'SWE' });
    const res = await request('PATCH', `/api/applications/${created.id}`, { status: 'ghosted' });
    expect(res.statusCode).toBe(400);
  });

  it('deletes an application', async () => {
    const { json: created } = await create({ company: 'Acme', jobTitle: 'SWE' });
    const del = await request('DELETE', `/api/applications/${created.id}`);
    expect(del.statusCode).toBe(204);
    const get = await request('GET', `/api/applications/${created.id}`);
    expect(get.statusCode).toBe(404);
  });

  it('returns 404 for an unknown id and 400 for a malformed one', async () => {
    const unknown = await request('GET', '/api/applications/00000000-0000-4000-8000-000000000000');
    const malformed = await request('GET', '/api/applications/abc');
    expect(unknown.statusCode).toBe(404);
    // ADR-0022: a malformed id fails the params schema before any handler runs. Existence never
    // leaks: a well-formed id that's missing or someone else's is still 404.
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ errors: [{ path: ['params', 'id'] }] });
  });
});

// Only the release before the fold writes `screening`, so these tests put such rows in the
// database directly, the way that release would.
describe('applied date and the status rework (ADR-0045)', () => {
  async function storeAs(id: string, values: Partial<typeof applications.$inferInsert>) {
    await t.db.update(applications).set(values).where(eq(applications.id, id));
  }

  it('keeps the applied date when a sent application changes status', async () => {
    const { json: created } = await create({ company: 'Acme', jobTitle: 'SWE', status: 'offer' });
    const res = await request('PATCH', `/api/applications/${created.id}`, { status: 'rejected' });

    expect(created.appliedAt).toBe(created.createdAt);
    expect(res.json<ApplicationJson>().appliedAt).toBe(created.appliedAt);
  });

  it('saves an application without an applied date', async () => {
    const { res, json } = await create({ company: 'Acme', jobTitle: 'SWE', status: 'saved' });

    expect(res.statusCode).toBe(201);
    expect(json).toMatchObject({ status: 'saved', appliedAt: null });
  });

  it('dates an application when it moves from saved to a sent status', async () => {
    const { json: created } = await create({ company: 'Acme', jobTitle: 'SWE', status: 'saved' });
    const res = await request('PATCH', `/api/applications/${created.id}`, { status: 'applied' });
    const sent = res.json<ApplicationJson>();

    expect(sent.status).toBe('applied');
    expect(sent.appliedAt).toBe(sent.updatedAt);
  });

  it('clears the applied date when a sent application moves back to saved', async () => {
    const { json: created } = await create({ company: 'Acme', jobTitle: 'SWE' });
    const res = await request('PATCH', `/api/applications/${created.id}`, { status: 'saved' });

    expect(res.json<ApplicationJson>()).toMatchObject({ status: 'saved', appliedAt: null });
  });

  it('leaves the applied date alone when only the details change', async () => {
    const { json: created } = await create({ company: 'Acme', jobTitle: 'SWE', status: 'saved' });
    const res = await request('PATCH', `/api/applications/${created.id}`, { jobTitle: 'Staff' });

    expect(res.json<ApplicationJson>()).toMatchObject({ status: 'saved', appliedAt: null });
  });

  it('reads a screening row as interviewing, in the list and on its own', async () => {
    const { json: created } = await create({ company: 'Acme', jobTitle: 'SWE' });

    await storeAs(created.id, { status: 'screening' });

    const one = await request('GET', `/api/applications/${created.id}`);
    const list = await request('GET', '/api/applications');

    expect(one.json<ApplicationJson>().status).toBe('interviewing');
    expect(list.json<ApplicationJson[]>().map((a) => a.status)).toEqual(['interviewing']);
  });

  it('refuses screening in request bodies', async () => {
    const { json: created } = await create({ company: 'Acme', jobTitle: 'SWE' });
    const { res } = await create({ company: 'Acme', jobTitle: 'SWE', status: 'screening' });

    const patched = await request('PATCH', `/api/applications/${created.id}`, {
      status: 'screening',
    });

    expect(res.statusCode).toBe(400);
    expect(patched.statusCode).toBe(400);
  });

  it('ignores an applied date in the request: the server sets it', async () => {
    const { res, json } = await create({
      company: 'Acme',
      jobTitle: 'SWE',
      appliedAt: '2020-01-01T00:00:00.000Z',
    });

    expect(res.statusCode).toBe(201);
    expect(json.appliedAt).toBe(json.createdAt);
  });
});
