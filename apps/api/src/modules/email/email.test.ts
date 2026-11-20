// EmailLive on its own, over the test database: what email does with nothing but the environment
// (its limits, Resend or the log), seen through its public interface. Whole-app behavior (Better
// Auth's emails, what the requester is told) is in mailer.test.ts.
import { assert, describe, it } from '@effect/vitest';
import { Effect, Exit, Layer, Redacted, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { Database } from '../../platform/database/effect.js';
import { runMigrations } from '../../platform/database/migrate.js';
import { createDb } from '../../platform/database/promise.js';
import { createLogger, effectLoggerLayer } from '../../platform/observability/logging.js';
import { EmailLive, EmailTransport, Mailer, type Email, type SendEmail } from './index.js';
import { DailyEmailLimitReached } from './mailer.js';
import { EmailKind, EmailSendFailed } from './transport.js';
import { env } from '#test/helpers';
import type { Env } from '../../platform/config/env.js';

const admin = createDb(env.DATABASE_URL, 'roundtable-test-admin');

beforeAll(() => runMigrations(admin.db));

beforeEach(() => admin.pool.query('truncate table email_sends'));

afterAll(() => admin.pool.end());

const reset = (to: string): Email => ({
  kind: 'password-reset',
  to,
  subject: 'Reset your password',
  text: 'https://example.com/reset',
});

/** Sends each email through EmailLive built from `overrides`, delivering through `transport`. */
function sendAll(emails: readonly Email[], overrides: Partial<Env>, send?: SendEmail) {
  const lines: string[] = [];
  const log = createLogger({ stream: { write: (line) => void lines.push(line) } });

  const email = EmailLive({ ...env, ...overrides }, log, {
    transport: send && EmailTransport.fromPromise(send),
  }).pipe(Layer.provide(Database.layer(env.DATABASE_URL)));

  return Effect.gen(function* () {
    const mailer = yield* Mailer;

    yield* Effect.forEach(emails, (e) => mailer.send(e), { discard: true });

    return lines;
  }).pipe(Effect.provide(Layer.merge(email, effectLoggerLayer(log))));
}

/** The fields of a log line these tests compare; `err` is the error's message. */
const LogLine = Schema.Struct({
  level: Schema.Int,
  msg: Schema.String,
  kind: Schema.optional(EmailKind),
  limit: Schema.optional(Schema.Int),
  err: Schema.optional(Schema.Struct({ message: Schema.String })),
});

const parseLine = (line: string) => {
  const { err, ...fields } = Schema.decodeSync(Schema.fromJsonString(LogLine))(line);

  return err ? { ...fields, err: err.message } : fields;
};

/** A fetch that records each request and answers as Resend does to a sent email. */
const recordingFetch =
  (requests: Request[]): typeof globalThis.fetch =>
  async (input, init) => {
    requests.push(new Request(input, init));

    return Response.json({ id: 'email-id' });
  };

describe('EmailLive', () => {
  it.live('logs the email instead of sending it when Resend is not configured', () =>
    Effect.gen(function* () {
      const lines = yield* sendAll([reset('a@example.com')], {
        RESEND_API_KEY: undefined,
        EMAIL_FROM: undefined,
      });

      const logged = lines.filter((line) => line.includes('Email to a@example.com'));

      assert.lengthOf(logged, 1);
      assert.include(logged[0], 'https://example.com/reset');
    }),
  );

  it.live('sends through Resend when both its key and its sender are set', () =>
    Effect.gen(function* () {
      const requests: Request[] = [];

      const lines = yield* sendAll([reset('a@example.com')], {
        RESEND_API_KEY: Redacted.make('re_test'),
        EMAIL_FROM: 'App <no-reply@example.com>',
      }).pipe(Effect.provideService(FetchHttpClient.Fetch, recordingFetch(requests)));

      assert.lengthOf(requests, 1);
      assert.strictEqual(requests[0]?.url, 'https://api.resend.com/emails');
      assert.strictEqual(requests[0]?.headers.get('authorization'), 'Bearer re_test');
      assert.include(
        yield* Effect.promise(() => requests[0]!.text()),
        'App <no-reply@example.com>',
      );
      assert.isFalse(lines.some((line) => line.includes('Email to')));
    }),
  );

  it.live('logs the email when Resend has a key but no sender', () =>
    Effect.gen(function* () {
      const requests: Request[] = [];

      const lines = yield* sendAll([reset('a@example.com')], {
        RESEND_API_KEY: Redacted.make('re_test'),
        EMAIL_FROM: undefined,
      }).pipe(Effect.provideService(FetchHttpClient.Fetch, recordingFetch(requests)));

      assert.lengthOf(requests, 0);
      assert.isTrue(lines.some((line) => line.includes('Email to a@example.com')));
    }),
  );

  it.live('sends through the transport it is given, even when Resend is configured', () =>
    Effect.gen(function* () {
      const sent: Email[] = [];

      const lines = yield* sendAll(
        [reset('a@example.com')],
        { RESEND_API_KEY: Redacted.make('re_test'), EMAIL_FROM: 'App <no-reply@example.com>' },
        async (e) => void sent.push(e),
      );

      assert.lengthOf(sent, 1);
      assert.isFalse(lines.some((line) => line.includes('Email to')));
    }),
  );

  it.live('reads the per-address limit from EMAIL_LIMIT_PER_ADDRESS', () =>
    Effect.gen(function* () {
      const sent: Email[] = [];
      const five = Array.from({ length: 5 }, () => reset('a@example.com'));

      // Not the default (3), so the test fails if EmailLive ignores the variable.
      yield* sendAll(five, { EMAIL_LIMIT_PER_ADDRESS: 2 }, async (e) => void sent.push(e));

      assert.lengthOf(sent, 2);
    }),
  );

  it.live('reads the daily limit from EMAIL_LIMIT_PER_DAY', () =>
    Effect.gen(function* () {
      const sent: Email[] = [];

      yield* sendAll(
        [reset('a@example.com'), reset('b@example.com')],
        { EMAIL_LIMIT_PER_DAY: 1 },
        async (e) => void sent.push(e),
      );

      assert.deepStrictEqual(
        sent.map((e) => e.to),
        ['a@example.com'],
      );
    }),
  );
});

describe('the Mailer', () => {
  it.live('counts an address the same whatever its case, and stores it in lowercase', () =>
    Effect.gen(function* () {
      const sent: Email[] = [];

      yield* sendAll(
        [reset('Ann@Example.com'), reset('ann@example.com')],
        { EMAIL_LIMIT_PER_ADDRESS: 1 },
        async (e) => void sent.push(e),
      );

      assert.lengthOf(sent, 1);

      const { rows } = yield* Effect.promise(() =>
        admin.pool.query<{ recipient: string }>('select recipient from email_sends'),
      );

      assert.deepStrictEqual(
        rows.map((row) => row.recipient),
        ['ann@example.com'],
      );
    }),
  );

  it.live('holds the limit when sends to one address race each other', () =>
    Effect.gen(function* () {
      let sent = 0;

      const mailer = EmailLive(
        { ...env, EMAIL_LIMIT_PER_ADDRESS: 2 },
        createLogger({ enabled: false }),
        {
          transport: EmailTransport.fromPromise(async () => void sent++),
        },
      ).pipe(Layer.provide(Database.layer(env.DATABASE_URL)));

      // All at once: without the lock, each would count the same rows and all would pass.
      yield* Effect.gen(function* () {
        const { send } = yield* Mailer;

        yield* Effect.forEach(
          Array.from({ length: 8 }, () => reset('a@example.com')),
          (e) => send(e),
          { concurrency: 'unbounded', discard: true },
        );
      }).pipe(Effect.provide(mailer));

      assert.strictEqual(sent, 2);
    }),
  );

  it.live('logs a dropped email at the daily limit as an error, without the address', () =>
    Effect.gen(function* () {
      const lines = yield* sendAll(
        [reset('a@example.com'), reset('b@example.com')],
        { EMAIL_LIMIT_PER_DAY: 1 },
        async () => {},
      );

      const dropped = lines.map(parseLine).filter((line) => line.level === 50);

      assert.deepStrictEqual(dropped, [
        {
          level: 50,
          msg: 'Email not sent: daily email limit reached',
          kind: 'password-reset',
          limit: 1,
        },
      ]);
      assert.notInclude(lines.join(''), 'b@example.com');
    }),
  );

  it.live('logs a failed send with the kind and the error, without the address', () =>
    Effect.gen(function* () {
      const lines: string[] = [];
      const log = createLogger({ stream: { write: (line) => void lines.push(line) } });

      const mailer = EmailLive(env, log, {
        transport: EmailTransport.fromPromise(() => Promise.reject(new Error('Resend is down'))),
      }).pipe(Layer.provide(Database.layer(env.DATABASE_URL)));

      yield* Effect.exit(
        Effect.gen(function* () {
          const { send } = yield* Mailer;

          yield* send(reset('a@example.com'));
        }).pipe(Effect.provide(Layer.merge(mailer, effectLoggerLayer(log)))),
      );

      assert.deepStrictEqual(lines.map(parseLine), [
        { level: 50, msg: 'Email send failed', kind: 'password-reset', err: 'Resend is down' },
      ]);
      assert.notInclude(lines.join(''), 'a@example.com');
    }),
  );
});

describe('email kinds', () => {
  it('are listed once, and both errors use that list', () => {
    assert.deepStrictEqual(EmailKind.literals, ['password-reset', 'verification', 'user-report']);
    assert.strictEqual(EmailSendFailed.fields.kind, EmailKind);
    assert.strictEqual(DailyEmailLimitReached.fields.kind, EmailKind);
  });

  it('rejects a kind outside the list', () => {
    const decode = Schema.decodeUnknownExit(EmailKind);

    assert.isTrue(Exit.isSuccess(decode('verification')));
    assert.isTrue(Exit.isFailure(decode('newsletter')));
  });
});
