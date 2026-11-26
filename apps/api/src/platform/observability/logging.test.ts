import { DrizzleQueryError } from 'drizzle-orm/errors';
import { eq } from 'drizzle-orm';
import { Cause, Effect, Exit, Schema } from 'effect';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { betterAuthLogger, createLogger, effectLoggerLayer, serializeError } from './logging.js';
import { redactQueryParamsInJson } from './redact.js';
import { Database } from '../database/effect.js';
import { applications } from '../../modules/applications/index.js';
import { users } from '../../modules/identity/index.js';
import { env, linkPath, setupTestApp, signUp, takeEmail } from '#test/helpers';

// Drizzle's query error message ends with the query's parameters, and Better Auth looks sessions
// up by the raw token. These tests take the database away mid-session and read every line the
// server would write to its logs (and the console, where Better Auth logs by default).
describe('server logs during a database outage', () => {
  const t = setupTestApp();
  const lines: string[] = [];

  const broken = setupTestApp({
    databaseUrl: 'postgres://app:app@localhost:1/nowhere',
    logStream: { write: (line) => void lines.push(line) },
  });

  // Every console method: anything that bypasses the logger (Effect's default logger writes
  // with console.log) must not carry the token either.
  const consoleOutput = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation(() => {}),
  );

  beforeAll(async () => {
    await t.migrate();
    await t.reset();
  });
  afterAll(async () => {
    for (const spy of consoleOutput) spy.mockRestore();
    await broken.close();
    await t.close();
  });

  it('logs the failed query without its parameters', async () => {
    const { cookie } = await signUp(t);
    const token = decodeURIComponent(cookie.match(/session_token=([^;.]+)/)?.[1] ?? '');
    expect(token).not.toBe('');

    const res = await broken.inject({
      method: 'GET',
      url: '/api/applications',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(500);

    const logs = lines.join('');

    const consoleLogs = consoleOutput
      .flatMap((spy) => spy.mock.calls)
      .flat()
      .map((arg) => (arg instanceof Error ? `${arg.message}\n${arg.stack}` : String(arg)))
      .join('\n');

    expect(logs).not.toContain(token);
    expect(consoleLogs).not.toContain(token);
    // Still useful: which query failed is logged, only the values are gone.
    expect(logs).toContain('Failed query: select');
    // The values' shapes are kept: an agent can still see what kind of value was passed.
    expect(logs).toContain(`params: <redacted: string(${token.length})>`);
    // Better Auth's own log line now goes through our logger, not the console.
    expect(logs).toContain('[Better Auth]');
  });

  // Better Auth's routes run behind better-call's router, which prints a failure it doesn't
  // recognize to the console itself, unless the failure is rethrown to us.
  it("keeps Better Auth's routes' failed queries off the console", async () => {
    const user = await signUp(t);

    await t.inject({
      method: 'POST',
      url: '/api/auth/request-password-reset',
      headers: { origin: env.BETTER_AUTH_URL },
      payload: { email: user.email, redirectTo: '/reset-password' },
    });

    const resetPath = linkPath(takeEmail(t, user.email, 'Reset'));
    const resetSegment = new URL(resetPath, env.BETTER_AUTH_URL).pathname.split('/').pop() ?? '';

    expect(resetSegment).not.toBe('');

    for (const spy of consoleOutput) spy.mockClear();

    const responses = [
      await broken.inject({ method: 'GET', url: resetPath }),
      await broken.inject({
        method: 'POST',
        url: '/api/auth/sign-in/email',
        headers: { origin: env.BETTER_AUTH_URL },
        payload: { email: user.email, password: user.password },
      }),
      await broken.inject({
        method: 'POST',
        url: '/api/auth/sign-up/email',
        headers: { origin: env.BETTER_AUTH_URL },
        payload: { name: 'Someone', email: user.email, password: user.password },
      }),
    ];

    expect(responses.map((res) => res.statusCode)).toEqual([500, 500, 500]);

    const consoleLogs = consoleOutput
      .flatMap((spy) => spy.mock.calls)
      .flat()
      .map((arg) => (arg instanceof Error ? `${arg.message}\n${arg.stack}` : String(arg)))
      .join('\n');

    expect(consoleLogs).not.toContain(resetSegment);
    expect(consoleLogs).not.toContain(user.email);

    const logs = lines.join('');

    expect(logs).not.toContain(resetSegment);
    expect(logs).not.toContain(user.email);
  });
});

// Effect's request log line names the path. Better Auth's reset link carries its token in the
// path (/api/auth/reset-password/<token>), and the token is still good after the click.
describe('request log for a password reset link', () => {
  const lines: string[] = [];
  const t = setupTestApp({ logStream: { write: (line) => void lines.push(line) } });

  beforeAll(async () => {
    await t.migrate();
    await t.reset();
  });
  afterAll(() => t.close());

  it('names the route without the token', async () => {
    const { email } = await signUp(t);

    await t.inject({
      method: 'POST',
      url: '/api/auth/request-password-reset',
      headers: { origin: env.BETTER_AUTH_URL },
      payload: { email, redirectTo: `${env.BETTER_AUTH_URL}/reset-password` },
    });

    const link = linkPath(takeEmail(t, email, 'Reset your'));
    const token = new URL(link, env.BETTER_AUTH_URL).pathname.split('/').pop() ?? '';
    expect(token).not.toBe('');

    lines.length = 0;
    const click = await t.inject({ method: 'GET', url: link });
    expect(click.statusCode).toBe(302);

    const urls = lines.map((line) => JSON.parse(line)['http.url']);

    expect(lines.join('')).not.toContain(token);
    expect(urls).toContain('/api/auth/reset-password/<redacted>');
  });
});

describe('serializeError', () => {
  it("keeps the message, stack and causes but not Drizzle's params property", () => {
    const err = new Error('Failed to get session', {
      cause: new DrizzleQueryError(
        'select 1 where token = $1',
        ['secret-token'],
        new Error('ECONNREFUSED'),
      ),
    });

    const serialized = serializeError(err);

    expect(serialized.type).toBe('Error');
    expect(serialized.message).toBe(
      'Failed to get session: Failed query: select 1 where token = $1\nparams: <redacted: string(12)>: ECONNREFUSED',
    );
    expect(serialized.stack).toContain('caused by: DrizzleQueryError: Failed query');
    expect(Object.keys(serialized)).toEqual(['type', 'message', 'stack']);
    expect(
      JSON.stringify(serializeError(new DrizzleQueryError('select 1', ['secret-token']))),
    ).not.toContain('"params"');
  });
});

describe('serializeError with a real Postgres error', () => {
  const t = setupTestApp();

  beforeAll(async () => {
    await t.migrate();
    await t.reset();
  });
  afterAll(() => t.close());

  it("keeps Postgres's diagnostic fields but not the values", async () => {
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

    expect(err).toBeInstanceOf(Error);
    const serialized = serializeError(err!);

    expect(serialized.postgres).toEqual({
      code: '23505',
      severity: 'ERROR',
      schema: 'public',
      table: 'users',
      constraint: 'users_email_unique',
      routine: expect.any(String),
    });
    expect(serialized.message).toContain('params: <redacted: uuid, string(3), string(');
    // Postgres's `detail` ("Key (email)=(…) already exists") and the params hold the email.
    expect(JSON.stringify(serialized)).not.toContain(email);
  });
});

describe('serializeError with a query value Postgres rejects', () => {
  // A non-uuid compared with a uuid column: Postgres fails it as a data exception (22P02) and
  // quotes the rejected value in its own message, on either driver.
  const secret = 'not-a-uuid-but-a-secret-value';
  const t = setupTestApp();

  afterAll(() => t.close());

  const expectSafeAndUseful = (err: Error) => {
    const serialized = serializeError(err);

    expect(JSON.stringify(serialized)).not.toContain(secret);
    expect(serialized.message).toContain(`params: <redacted: string(${secret.length})>`);
    expect(serialized.message).toContain('invalid input syntax for type uuid: "<redacted>"');
    expect(serialized.postgres).toMatchObject({ code: '22P02', routine: 'string_to_uuid' });
  };

  it('Promise driver (pg)', async () => {
    const err = await t.db
      .select()
      .from(applications)
      .where(eq(applications.id, secret))
      .then(
        () => undefined,
        (error: Error) => error,
      );

    expect(err).toBeInstanceOf(Error);
    expectSafeAndUseful(err!);
  });

  it('Effect driver (@effect/sql-pg): the chain continues through the Effect Cause', async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const db = yield* Database;

        return yield* db.select().from(applications).where(eq(applications.id, secret));
      }).pipe(Effect.provide(Database.layer(env.DATABASE_URL))),
    );

    const err = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;

    expect(err).toBeInstanceOf(Error);
    expectSafeAndUseful(err instanceof Error ? err : new Error('query did not fail'));
  });
});

describe('redactQueryParamsInJson', () => {
  it('redacts parameter values inside a log line and leaves the rest of the JSON intact', () => {
    const line = JSON.stringify({
      msg: 'Failed query: select "token" from "sessions" where "token" = $1\nparams: secret-token',
      err: {
        stack:
          'Error: Failed query: select 1\nparams: secret-token,"quoted"\n    at NodePgPreparedQuery (session.js:41:11)',
      },
      other: 'untouched',
    });

    const redacted = redactQueryParamsInJson(line);

    expect(redacted).not.toContain('secret-token');
    // Already described by the serializer: left alone.
    const described = JSON.stringify({ msg: 'Failed query: select 1\nparams: <redacted: uuid>' });
    expect(redactQueryParamsInJson(described)).toBe(described);
    expect(JSON.parse(redacted)).toEqual({
      msg: 'Failed query: select "token" from "sessions" where "token" = $1\nparams: <redacted>',
      err: {
        stack:
          'Error: Failed query: select 1\nparams: <redacted>\n    at NodePgPreparedQuery (session.js:41:11)',
      },
      other: 'untouched',
    });
  });
});

/** The fields of a log line these tests read. */
const LogLine = Schema.Struct({
  level: Schema.Int,
  msg: Schema.String,
  kind: Schema.optional(Schema.String),
  err: Schema.optional(Schema.Struct({ type: Schema.String, message: Schema.String })),
});

const parseLogLine = Schema.decodeUnknownSync(Schema.fromJsonString(LogLine));

/** A logger whose lines land in `raw`, and parsed in `lines`. */
function capturedLogger() {
  const raw: string[] = [];
  const lines: (typeof LogLine.Type)[] = [];

  const log = createLogger({
    stream: {
      write: (line) => {
        raw.push(line);
        lines.push(parseLogLine(line));
      },
    },
  });

  return { log, raw, lines };
}

describe("Effect's logger, sent to pino", () => {
  const logged = (effect: Effect.Effect<void>) => {
    const { log, lines } = capturedLogger();

    Effect.runSync(effect.pipe(Effect.provide(effectLoggerLayer(log))));

    return lines;
  };

  it('joins the message parts and keeps annotations as fields, with no error', () => {
    const [line] = logged(
      Effect.log('Email sent', 'to', 'someone').pipe(Effect.annotateLogs({ kind: 'verification' })),
    );

    expect(line).toMatchObject({ level: 30, msg: 'Email sent to someone', kind: 'verification' });
    expect(line).not.toHaveProperty('err');
  });

  it('logs the error from a failure or a defect as err', () => {
    const lines = logged(
      Effect.gen(function* () {
        yield* Effect.logError('Send failed', Cause.fail(new Error('Resend is down')));
        yield* Effect.logError('Crashed', Cause.die(new TypeError('undefined is not a function')));
      }),
    );

    expect(lines).toMatchObject([
      { level: 50, msg: 'Send failed', err: { type: 'Error', message: 'Resend is down' } },
      {
        level: 50,
        msg: 'Crashed',
        err: { type: 'TypeError', message: 'undefined is not a function' },
      },
    ]);
  });
});

describe("Better Auth's logger, sent to pino", () => {
  it('keeps an Error argument as err, and drops the free-form rest', () => {
    const { log, raw, lines } = capturedLogger();
    const authLog = betterAuthLogger(log);

    authLog.log('error', 'Failed to create user', { email: 'a@example.com' }, new Error('boom'));
    authLog.log('warn', 'Something odd', 'a@example.com');

    expect(lines).toMatchObject([
      { level: 50, msg: '[Better Auth] Failed to create user', err: { message: 'boom' } },
      { level: 40, msg: '[Better Auth] Something odd' },
    ]);
    expect(lines[1]).not.toHaveProperty('err');
    expect(raw.join('')).not.toContain('a@example.com');
  });
});
