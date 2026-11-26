import { afterEach, describe, expect, it } from 'vitest';
import { Redacted } from 'effect';
import type { ErrorEvent } from '@sentry/node';
import { initErrorTracking, scrubEvent, Sentry } from './error-tracking.js';
import { redactQueryParams } from './redact.js';
import { users } from '../../modules/identity/index.js';
import { env, setupTestApp, signUp } from '#test/helpers';

const DEAD_DATABASE = 'postgres://app:app@localhost:1/nowhere';

describe('scrubEvent', () => {
  it('drops query strings, cookies, bodies and identifying headers', () => {
    const event = scrubEvent({
      type: undefined,
      request: {
        url: 'https://example.com/api/auth/verify-email?token=secret',
        query_string: 'token=secret',
        cookies: { session: 'x' },
        data: '{"password":"hunter2"}',
        headers: { Cookie: 'a=b', authorization: 'Bearer x', 'user-agent': 'test' },
      },
    });

    expect(event.request).toEqual({
      url: 'https://example.com/api/auth/verify-email',
      headers: { 'user-agent': 'test' },
    });
  });

  it('drops only those exact headers', () => {
    const event = scrubEvent({
      type: undefined,
      request: { headers: { 'cookie-policy': 'v1', 'x-authorization': 'none' } },
    });

    expect(event.request?.headers).toEqual({
      'cookie-policy': 'v1',
      'x-authorization': 'none',
    });
  });

  it('handles events without a URL, headers, exception values or Postgres fields', () => {
    const event = scrubEvent(
      { type: undefined, request: {}, exception: { values: [{ type: 'Error' }] } },
      { originalException: new Error('not a database error') },
    );

    expect(event).toEqual({
      type: undefined,
      request: {},
      exception: { values: [{ type: 'Error' }] },
    });
  });

  it('drops query values from breadcrumbs', () => {
    const event = scrubEvent({
      type: undefined,
      breadcrumbs: [
        { message: 'Failed query: select 1 where token = $1\nparams: secret-token' },
        { category: 'http' },
      ],
    });

    expect(event.breadcrumbs).toEqual([
      { message: 'Failed query: select 1 where token = $1\nparams: <redacted>' },
      { category: 'http' },
    ]);
  });

  it('drops the path segment after /reset-password/ from the url, transaction and breadcrumbs', () => {
    const event = scrubEvent({
      type: undefined,
      transaction: 'GET /api/auth/reset-password/abc123',
      request: { url: 'https://example.test/api/auth/reset-password/abc123?callbackURL=x' },
      breadcrumbs: [
        { message: 'GET /api/auth/reset-password/abc123' },
        { category: 'http', data: { url: 'https://example.test/api/auth/reset-password/abc123' } },
        { category: 'http', data: { status_code: 500 } },
      ],
    });

    expect(event.transaction).toBe('GET /api/auth/reset-password/<redacted>');
    expect(event.request?.url).toBe('https://example.test/api/auth/reset-password/<redacted>');
    expect(event.breadcrumbs).toEqual([
      { message: 'GET /api/auth/reset-password/<redacted>' },
      {
        category: 'http',
        data: { url: 'https://example.test/api/auth/reset-password/<redacted>' },
      },
      { category: 'http', data: { status_code: 500 } },
    ]);
  });
});

describe('Sentry options', () => {
  const events: ErrorEvent[] = [];

  afterEach(async () => {
    events.length = 0;
    await Sentry.close();
  });

  // Sentry on its own, capturing events as they'd be sent, before scrubEvent.
  const start = (overrides: Partial<typeof env> = {}) =>
    initErrorTracking(
      { ...env, SENTRY_DSN: Redacted.make('https://public@o0.ingest.sentry.io/0'), ...overrides },
      {
        beforeSend: (event) => {
          events.push(event);

          return null;
        },
      },
    );

  // The tests reach the App in-process, so Sentry's HTTP integration never sees their requests
  // and can't show what it would collect from one. These pin the options that decide it.
  it('collects no user, cookies, bodies, query strings, query values or local variables', () => {
    start();

    expect(Sentry.getClient()?.getOptions().dataCollection).toEqual({
      userInfo: false,
      cookies: false,
      httpHeaders: {
        request: { allow: ['user-agent', 'content-type', 'origin'] },
        response: false,
      },
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      stackFrameVariables: false,
    });
  });

  it('keeps console output out of events', async () => {
    start();
    // Libraries (Better Auth) console.error whole error objects; this one stands in for them.
    const write = process.stdout.write;
    process.stdout.write = () => true;

    try {
      console.log('session=console-secret');
    } finally {
      process.stdout.write = write;
    }

    Sentry.captureException(new Error('after the console'));
    await Sentry.flush(2000);

    expect(events).toHaveLength(1);
    // (Breadcrumbs only: the event's stack context quotes this file, secret included.)
    expect(JSON.stringify(events[0]?.breadcrumbs ?? [])).not.toContain('console-secret');
  });

  it("names the environment, or 'development' without NODE_ENV", () => {
    start({ NODE_ENV: undefined });
    expect(Sentry.getClient()?.getOptions().environment).toBe('development');
  });
});

describe('redactQueryParams', () => {
  it("drops a Drizzle error's parameter values but keeps the SQL and the stack", () => {
    const stack =
      'Error: Failed query: select * from "sessions" where "token" = $1\n' +
      'params: secret-token,other\n' +
      '    at NodePgPreparedQuery.queryWithCache (session.js:41:11)';

    expect(redactQueryParams(stack)).toBe(
      'Error: Failed query: select * from "sessions" where "token" = $1\n' +
        'params: <redacted>\n' +
        '    at NodePgPreparedQuery.queryWithCache (session.js:41:11)',
    );
    expect(redactQueryParams('Failed query: select 1\nparams: a\nb')).toBe(
      'Failed query: select 1\nparams: <redacted>',
    );
    expect(redactQueryParams('some other error')).toBe('some other error');
    // Already described (by the logger or scrubEvent): left alone.
    expect(redactQueryParams('Failed query: select 1\nparams: <redacted: uuid>')).toBe(
      'Failed query: select 1\nparams: <redacted: uuid>',
    );
  });
});

describe('error reporting', () => {
  const events: ErrorEvent[] = [];

  afterEach(() => {
    events.length = 0;
  });

  // Each app starts Sentry when it's built, reporting into `events`, and closes it when closed.
  const failing = () =>
    setupTestApp({
      errorEvents: events,
      sendEmail: async () => {
        throw new Error('Resend is down');
      },
    });

  it('reports a failed email send, which Better Auth itself swallows', async () => {
    const t = failing();
    await t.migrate();
    await t.reset();

    const res = await t.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email?token=leak',
      headers: { origin: env.BETTER_AUTH_URL },
      payload: { email: 'x@example.com', password: 'correct horse battery', name: 'X' },
    });

    // Better Auth still answers 200 ("check your email"): the failure is only visible in Sentry.
    expect(res.statusCode).toBe(200);
    await t.settled();
    await Sentry.flush(2000);
    const event = events.find((e) => e.exception?.values?.[0]?.value === 'Resend is down');

    // Which flow broke (ErrorReporter.attributes on EmailSendFailed), never the address.
    expect(event?.extra).toMatchObject({ emailKind: 'verification' });
    expect(JSON.stringify(event)).not.toContain('x@example.com');
    await t.close();
  });

  it('reports the daily email limit once it drops an email', async () => {
    const t = setupTestApp({ env: { EMAIL_LIMIT_PER_DAY: 1 }, errorEvents: events });
    await t.migrate();
    await t.reset();

    for (const name of ['a', 'b']) {
      await t.inject({
        method: 'POST',
        url: '/api/auth/sign-up/email',
        headers: { origin: env.BETTER_AUTH_URL },
        payload: { email: `${name}@example.com`, password: 'correct horse battery', name },
      });
    }

    await t.settled();
    await Sentry.flush(2000);
    const event = events.find((e) => e.exception?.values?.[0]?.type === 'DailyEmailLimitReached');

    expect(event?.extra).toMatchObject({ emailKind: 'verification', limit: 1 });
    expect(t.sentEmails).toHaveLength(1);
    await t.close();
  });

  it('reports a crash in one of our own routes, without the query string', async () => {
    const t = setupTestApp({ crashRoute: true, errorEvents: events });
    const res = await t.inject({ method: 'GET', url: '/api/test-crash?token=leak' });

    expect(res.statusCode).toBe(500);
    await Sentry.flush(2000);
    const event = events.find((e) => e.exception?.values?.[0]?.value === 'route exploded');

    expect(event).toBeDefined();
    // (Not the whole event: it includes this file's source lines as context, which say 'leak'.)
    expect(JSON.stringify(event!.request ?? {})).not.toContain('leak');
    await t.close();
  });

  it('keeps query parameters, like a session token, out of database errors', async () => {
    // Sign up on the working database to get a real session cookie.
    const t = setupTestApp();
    await t.migrate();
    await t.reset();
    const { cookie } = await signUp(t);
    const token = decodeURIComponent(cookie.match(/session_token=([^;.]+)/)?.[1] ?? '');
    expect(token).not.toBe('');

    // Same request against an unreachable database: Better Auth's session lookup fails, and
    // Drizzle's error message ends with the query's parameters (here, the raw token).
    const broken = setupTestApp({ databaseUrl: DEAD_DATABASE, errorEvents: events });

    const res = await broken.inject({
      method: 'GET',
      url: '/api/applications',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(500);
    await Sentry.flush(2000);

    const event = events.find((e) =>
      e.exception?.values?.some((v) => v.value?.startsWith('Failed query:')),
    );

    expect(event).toBeDefined();
    expect(JSON.stringify(event)).not.toContain(token);
    expect(JSON.stringify(event)).toContain(`params: <redacted: string(${token.length})>`);
    // The SQL itself stays: it's what tells you which query failed.
    expect(JSON.stringify(event)).toContain('from \\"sessions\\"');
    await broken.close();
    await t.close();
  });

  it("adds Postgres's diagnostic fields to a database error, without its values", async () => {
    // Sentry on its own, no App: this checks scrubEvent on a captured error.
    initErrorTracking(
      { ...env, SENTRY_DSN: Redacted.make('https://public@o0.ingest.sentry.io/0') },
      {
        beforeSend: (event, hint) => {
          events.push(scrubEvent(event, hint));

          return null;
        },
      },
    );
    const t = setupTestApp();
    await t.migrate();
    await t.reset();
    const email = `dup-${crypto.randomUUID()}@example.com`;
    const row = { id: crypto.randomUUID(), name: 'Dup', email };
    await t.db.insert(users).values(row);

    const err = await t.db
      .insert(users)
      .values({ ...row, id: crypto.randomUUID() })
      .then(
        () => undefined,
        (error: Error) => error,
      );

    Sentry.captureException(err);
    await Sentry.flush(2000);
    const event = events.find((e) => e.contexts?.postgres);
    expect(event?.contexts?.postgres).toMatchObject({
      code: '23505',
      table: 'users',
      constraint: 'users_email_unique',
    });
    expect(JSON.stringify(event)).not.toContain(email);
    await Sentry.close();
    await t.close();
  });

  it('does not report expected errors like a wrong password', async () => {
    const t = setupTestApp({ errorEvents: events });
    await t.migrate();
    await t.reset();
    const { email } = await signUp(t);

    const res = await t.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: { origin: env.BETTER_AUTH_URL },
      payload: { email, password: 'wrong password here' },
    });

    expect(res.statusCode).toBe(401);
    await Sentry.flush(2000);
    expect(events).toHaveLength(0);
    await t.close();
  });
});
