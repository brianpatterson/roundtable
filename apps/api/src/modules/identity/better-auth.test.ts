import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ErrorEvent } from '@sentry/node';
import { Redacted, Schema } from 'effect';
import { AuthConfig } from '@roundtable/contract';
import { configuredProviders, createAuth, reportingFailures } from './better-auth.js';
import { createDb } from '../../platform/database/promise.js';
import { Sentry } from '../../platform/observability/error-tracking.js';
import { createLogger } from '../../platform/observability/logging.js';
import type { Email } from '../email/index.js';
import { env, setupTestApp, signUp } from '#test/helpers';

const startSocialSignIn = (t: ReturnType<typeof setupTestApp>, provider: string) =>
  t.inject({
    method: 'POST',
    url: '/api/auth/sign-in/social',
    headers: { origin: env.BETTER_AUTH_URL },
    payload: { provider, callbackURL: '/', errorCallbackURL: '/' },
  });

// One rule decides which providers are configured: the sign-in page's buttons (auth-config) and
// what Better Auth accepts must never disagree.
describe('configured sign-in providers', () => {
  const both = setupTestApp({
    env: {
      GITHUB_CLIENT_ID: 'gh-id',
      GITHUB_CLIENT_SECRET: Redacted.make('gh-secret'),
      GOOGLE_CLIENT_ID: 'google-id',
      GOOGLE_CLIENT_SECRET: Redacted.make('google-secret'),
    },
  });

  const none = setupTestApp();

  afterAll(async () => {
    await both.close();
    await none.close();
  });

  it('offers and accepts every provider with credentials', async () => {
    const config = await both.inject({ method: 'GET', url: '/api/auth-config' });

    expect(Schema.decodeUnknownSync(AuthConfig)(config.json())).toEqual({
      providers: ['github', 'google'],
    });

    for (const [provider, host] of [
      ['github', 'github.com'],
      ['google', 'accounts.google.com'],
    ] as const) {
      const start = await startSocialSignIn(both, provider);

      expect(start.statusCode).toBe(200);
      expect(new URL(start.json<{ url: string }>().url).host).toBe(host);
    }
  });

  it('needs both the client id and the secret', () => {
    expect(configuredProviders({ ...env, GITHUB_CLIENT_ID: 'gh-id' })).toEqual([]);
    expect(
      configuredProviders({ ...env, GOOGLE_CLIENT_SECRET: Redacted.make('google-secret') }),
    ).toEqual([]);
  });

  it('offers and accepts none without credentials', async () => {
    const config = await none.inject({ method: 'GET', url: '/api/auth-config' });

    expect(Schema.decodeUnknownSync(AuthConfig)(config.json())).toEqual({ providers: [] });
    expect((await startSocialSignIn(none, 'github')).statusCode).toBeGreaterThanOrEqual(400);
  });
});

// Better Auth's handler is a plain Request → Response outside our routes' error handling:
// identity reports its failures through ErrorReporter instead, exactly once.
describe('an unexpected Better Auth failure', () => {
  const events: ErrorEvent[] = [];
  const lines: string[] = [];

  const broken = setupTestApp({
    databaseUrl: 'postgres://app:app@localhost:1/nowhere',
    errorEvents: events,
    logStream: { write: (line) => void lines.push(line) },
  });

  afterAll(() => broken.close());

  it('is logged and reported once, marked as Better Auth, without the user input', async () => {
    const email = `outage-${crypto.randomUUID()}@example.com`;
    const password = 'correct horse battery staple';

    const res = await broken.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: { origin: env.BETTER_AUTH_URL },
      payload: { email, password },
    });

    expect(res.statusCode).toBe(500);
    await Sentry.flush(2000);

    const reported = events.filter((event) =>
      event.exception?.values?.some((value) => value.type === 'BetterAuthFailed'),
    );

    expect(reported).toHaveLength(1);
    expect(reported[0]!.extra).toMatchObject({ source: 'better-auth' });

    // The report names what failed, and keeps the original failure (the outage) as its cause.
    const values = reported[0]!.exception?.values ?? [];

    expect(values.find((value) => value.type === 'BetterAuthFailed')?.value).toBe(
      'Unexpected error in Better Auth',
    );
    expect(values.length).toBeGreaterThan(1);
    expect(lines.map((line) => JSON.parse(line).msg)).toContain('Unexpected error in Better Auth');

    for (const output of [JSON.stringify(events), ...lines]) {
      expect(output).not.toContain(email);
      expect(output).not.toContain(password);
    }
  });
});

/** Better Auth on its own, on the test database: for what the App's requests can't reach. */
function standaloneAuth() {
  const { db, pool } = createDb(env.DATABASE_URL, 'roundtable-test-admin');
  const auth = createAuth(db, env, async () => {}, createLogger({ enabled: false }));

  return { auth, close: () => pool.end() };
}

describe("Better Auth's handler, reporting failures", () => {
  const reported: Error[] = [];
  const request = new Request(`${env.BETTER_AUTH_URL}/api/auth/ok`);

  const handle = (outcome: () => Promise<Response>) =>
    reportingFailures(outcome, (error) => void reported.push(error))(request);

  beforeEach(() => {
    reported.length = 0;
  });

  it('passes its answers through and ignores 4xx, which are normal traffic', async () => {
    for (const status of [200, 302, 401, 403, 499]) {
      expect((await handle(async () => new Response(null, { status }))).status).toBe(status);
    }

    expect(reported).toEqual([]);
  });

  it('reports the 5xx it answers itself, and passes them through', async () => {
    const res = await handle(async () => new Response('{}', { status: 500 }));

    expect(res.status).toBe(500);
    expect(await res.text()).toBe('{}');
    expect(reported.map((error) => error.message)).toEqual(['Answered 500']);
  });

  it('reports what it throws and answers a bare 500', async () => {
    const crash = new Error('crash');
    const crashed = await handle(() => Promise.reject(crash));
    const thrownString = await handle(() => Promise.reject('a string'));

    for (const res of [crashed, thrownString]) {
      expect(res.status).toBe(500);
      expect(await res.text()).toBe('');
    }

    expect(reported).toHaveLength(2);
    expect(reported[0]).toBe(crash);
    expect(reported[1]?.message).toBe('Non-Error thrown in auth');
    expect(reported[1]?.cause).toBe('a string');
  });
});

// Better Auth turns rate limiting on only when NODE_ENV is production, which it reads once, when
// it loads. Each test switches it on for its own instance, and checks our limits per client IP.
describe('rate limits', () => {
  const t = setupTestApp();
  let auth: ReturnType<typeof standaloneAuth>;

  beforeAll(() => t.migrate());
  beforeEach(async () => {
    await t.reset();
    auth = standaloneAuth();
    (await auth.auth.$context).rateLimit.enabled = true;
  });
  afterAll(async () => {
    await auth.close();
    await t.close();
  });

  const post = (path: string, payload: Record<string, string>, ip = '203.0.113.7') =>
    auth.auth.handler(
      new Request(`${env.BETTER_AUTH_URL}/api/auth${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: env.BETTER_AUTH_URL,
          'x-forwarded-for': ip,
        },
        body: JSON.stringify(payload),
      }),
    );

  /** The status of each of `count` requests, all from one IP. */
  const statuses = async (count: number, request: (i: number) => Promise<Response>) => {
    const result: number[] = [];

    for (let i = 0; i < count; i++) result.push((await request(i)).status);

    return result;
  };

  it('allows 5 password reset requests an hour', async () => {
    const reset = () =>
      post('/request-password-reset', { email: 'someone@example.com', redirectTo: '/' });

    expect(await statuses(6, reset)).toEqual([200, 200, 200, 200, 200, 429]);
    // Per IP: another client isn't blocked.
    expect(
      (await post('/request-password-reset', { email: 'a@example.com' }, '203.0.113.8')).status,
    ).toBe(200);
  });

  it('allows 5 verification emails an hour', async () => {
    const resend = () => post('/send-verification-email', { email: 'someone@example.com' });

    expect(await statuses(6, resend)).toEqual([200, 200, 200, 200, 200, 429]);
  });

  it('allows 10 sign-ups an hour', async () => {
    const signUp = (i: number) =>
      post('/sign-up/email', {
        email: `user-${i}@example.com`,
        password: 'correct horse battery',
        name: 'Test User',
      });

    expect(await statuses(11, signUp)).toEqual([...Array(10).fill(200), 429]);
  });
});

describe('telemetry', () => {
  it('is off: Better Auth sends nothing about this app', async () => {
    const { auth, close } = standaloneAuth();

    // Better Auth skips telemetry under tests whatever the option says, so this pins the option.
    expect(auth.options.telemetry).toEqual({ enabled: false });
    await close();
  });
});

// Only some answers send an email: a reset for an existing account, a sign-up for a new address.
// The answer can't wait for it, or how long it takes says which case it was. The mailer here
// stays blocked until the test releases it: an answer that waited for it would never come.
describe("sending Better Auth's emails", () => {
  const delivered: Email[] = [];
  let release = () => {};
  const blocked = new Promise<void>((resolve) => (release = resolve));

  const accounts = setupTestApp();

  const t = setupTestApp({
    sendEmail: async (email) => {
      await blocked;
      delivered.push(email);
    },
  });

  beforeAll(async () => {
    await accounts.migrate();
    await accounts.reset();
  });
  afterAll(async () => {
    release();
    await t.close();
    await accounts.close();
  });

  it('answers before the email is sent, then sends it', async () => {
    const { email: existing } = await signUp(accounts);
    const created = `new-${crypto.randomUUID()}@example.com`;

    const reset = await t.inject({
      method: 'POST',
      url: '/api/auth/request-password-reset',
      headers: { origin: env.BETTER_AUTH_URL },
      payload: { email: existing, redirectTo: '/reset-password' },
    });

    const signedUp = await t.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      headers: { origin: env.BETTER_AUTH_URL },
      payload: { email: created, password: 'correct horse battery', name: 'Someone' },
    });

    expect([reset.statusCode, signedUp.statusCode]).toEqual([200, 200]);
    expect(delivered).toEqual([]);

    release();
    await t.settled();

    expect(delivered.map(({ to, kind }) => ({ to, kind }))).toEqual([
      { to: existing, kind: 'password-reset' },
      { to: created, kind: 'verification' },
    ]);
  });
});
