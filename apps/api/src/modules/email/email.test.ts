// EmailLive on its own, over the test database: what email does with nothing but the environment
// (its limits, Resend or the log), seen through its public interface. Whole-app behavior (Better
// Auth's emails, what the requester is told) is in mailer.test.ts.
import { assert, describe, it } from '@effect/vitest';
import { Effect, Exit, Layer, Redacted, Schema } from 'effect';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { Database } from '../../platform/database/effect.js';
import { runMigrations } from '../../platform/database/migrate.js';
import { createDb } from '../../platform/database/promise.js';
import { createLogger } from '../../platform/observability/logging.js';
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
  }).pipe(Effect.provide(email));
}

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

      yield* sendAll(five, { EMAIL_LIMIT_PER_ADDRESS: 3 }, async (e) => void sent.push(e));

      assert.lengthOf(sent, 3);
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

describe('email kinds', () => {
  it('are listed once, and both errors use that list', () => {
    assert.deepStrictEqual(EmailKind.literals, ['password-reset', 'verification']);
    assert.strictEqual(EmailSendFailed.fields.kind, EmailKind);
    assert.strictEqual(DailyEmailLimitReached.fields.kind, EmailKind);
  });

  it('rejects a kind outside the list', () => {
    const decode = Schema.decodeUnknownExit(EmailKind);

    assert.isTrue(Exit.isSuccess(decode('verification')));
    assert.isTrue(Exit.isFailure(decode('newsletter')));
  });
});
