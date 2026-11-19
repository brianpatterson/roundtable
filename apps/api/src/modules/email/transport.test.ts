// The Resend transport against a scripted fetch: what it sends, and which failures it retries.
import { describe, expect } from 'vitest';
import { it } from '@effect/vitest';
import { Cause, Effect, Exit, Fiber, Redacted, Schedule, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { TestClock } from 'effect/testing';
import {
  EmailSendFailed,
  EmailTransport,
  makeResendTransport,
  resendLayer,
  type Email,
  type ResendOptions,
} from './transport.js';

const email: Email = { kind: 'verification', to: 'a@example.com', subject: 'Hi', text: 'Body' };

interface Sent {
  readonly url: string;
  readonly headers: Headers;
  readonly body: unknown;
}

/** Answers each request with the next response in `responses` and records what was sent. */
function scriptedFetch(responses: Array<() => Response | Promise<Response>>) {
  const sent: Sent[] = [];

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);

    sent.push({
      url: request.url,
      headers: request.headers,
      body: Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(await request.text()),
    });

    const next = responses[sent.length - 1];

    if (!next) throw new Error('no more scripted responses');

    return next();
  };

  return { fetch, sent };
}

/** What Resend answers: an email id, or an error `name` (and `message`). */
interface ResendReply {
  readonly id?: string;
  readonly name?: string;
  readonly message?: string;
}

const json = (status: number, body: ResendReply) => () =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** The failure a send ended with, if any. */
const failureOf = (exit: Exit.Exit<void, EmailSendFailed>) =>
  Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;

const options: ResendOptions = {
  apiKey: Redacted.make('re_test'),
  from: 'App <no-reply@mail.example.com>',
  retrySchedule: Schedule.spaced('1 millis'),
};

/** Sending `email` through the transport, as an Effect. */
const sending = (fetch: typeof globalThis.fetch, resend: ResendOptions = options) =>
  makeResendTransport(resend).pipe(
    Effect.flatMap((transport) => transport.send(email)),
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
  );

/** Sends `email` through the transport, with no real waiting between retries. */
function send(fetch: typeof globalThis.fetch, resend?: ResendOptions) {
  return Effect.runPromiseExit(sending(fetch, resend));
}

/** A response whose body fails halfway, like a connection reset while reading it. */
const brokenBody = (status: number) => () =>
  new Response(
    new ReadableStream({
      pull: (controller) => controller.error(new Error('connection reset')),
    }),
    { status },
  );

describe('Resend transport', () => {
  it('posts the email with the API key and an idempotency key', async () => {
    const { fetch, sent } = scriptedFetch([json(200, { id: '1' })]);

    expect(Exit.isSuccess(await send(fetch))).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe('https://api.resend.com/emails');
    expect(sent[0]?.headers.get('authorization')).toBe('Bearer re_test');
    expect(sent[0]?.headers.get('idempotency-key')).toMatch(/^verification\/[0-9a-f-]{36}$/);
    expect(sent[0]?.body).toEqual({
      from: 'App <no-reply@mail.example.com>',
      to: ['a@example.com'],
      subject: 'Hi',
      text: 'Body',
    });
  });

  it('retries a Resend outage with the same idempotency key, so it is delivered once', async () => {
    const { fetch, sent } = scriptedFetch([
      json(503, { name: 'service_unavailable' }),
      json(500, { name: 'application_error' }),
      json(200, { id: '1' }),
    ]);

    expect(Exit.isSuccess(await send(fetch))).toBe(true);
    expect(sent).toHaveLength(3);
    expect(new Set(sent.map((s) => s.headers.get('idempotency-key'))).size).toBe(1);
  });

  it('retries the per-second rate limit and a network failure', async () => {
    const { fetch, sent } = scriptedFetch([
      json(429, { name: 'rate_limit_exceeded' }),
      () => Promise.reject(new TypeError('fetch failed')),
      json(200, { id: '1' }),
    ]);

    expect(Exit.isSuccess(await send(fetch))).toBe(true);
    expect(sent).toHaveLength(3);
  });

  it('gives up after three attempts, with Resend’s reason', async () => {
    const { fetch, sent } = scriptedFetch([
      json(503, { name: 'service_unavailable' }),
      json(503, { name: 'service_unavailable' }),
      json(503, { name: 'service_unavailable' }),
    ]);

    const exit = await send(fetch);

    expect(sent).toHaveLength(3);
    const failure = failureOf(exit);

    expect(failure).toBeInstanceOf(EmailSendFailed);
    expect(failure).toMatchObject({ status: 503, retryable: true });
  });

  it.each([
    ['an unverified domain', 403, 'validation_error'],
    ['a used-up daily quota', 429, 'daily_quota_exceeded'],
    ['an invalid request', 422, 'missing_required_field'],
  ])('does not retry %s', async (_name, status, name) => {
    const { fetch, sent } = scriptedFetch([json(status, { name, message: 'domain not verified' })]);

    const exit = await send(fetch);

    expect(sent).toHaveLength(1);
    const failure = failureOf(exit);

    expect(failure).toBeInstanceOf(EmailSendFailed);
    expect(failure).toMatchObject({ status, retryable: false });
    expect(String(failure)).toContain(`HTTP ${status}`);
  });

  it('retries a concurrent request with the same idempotency key', async () => {
    const { fetch, sent } = scriptedFetch([
      json(409, { name: 'concurrent_idempotent_requests' }),
      json(200, { id: '1' }),
    ]);

    expect(Exit.isSuccess(await send(fetch))).toBe(true);
    expect(sent).toHaveLength(2);
  });

  it('treats any status from 300 up as a failure', async () => {
    const { fetch } = scriptedFetch([json(300, {})]);

    expect(failureOf(await send(fetch))).toMatchObject({ status: 300, retryable: false });
  });

  it('keeps at most 500 characters of what Resend says', async () => {
    const { fetch } = scriptedFetch([
      json(400, { name: 'validation_error', message: 'x'.repeat(1000) }),
    ]);

    const failure = failureOf(await send(fetch));

    expect(failure).toBeInstanceOf(EmailSendFailed);
    // The body is Resend's JSON reply: only its first 500 characters are kept.
    expect(failure).toMatchObject({
      message: expect.stringMatching(/^Resend rejected the email \(HTTP 400\): .{500}$/s),
    });
  });

  it('still fails cleanly, with the status, when the error body cannot be read', async () => {
    const { fetch, sent } = scriptedFetch([brokenBody(502), brokenBody(502), brokenBody(502)]);
    const failure = failureOf(await send(fetch));

    expect(sent).toHaveLength(3);
    expect(failure).toBeInstanceOf(EmailSendFailed);
    expect(failure).toMatchObject({
      status: 502,
      message: 'Resend rejected the email (HTTP 502): ',
      retryable: true,
    });
  });

  it('says Resend was unreachable when no attempt got an answer', async () => {
    const offline = () => Promise.reject(new TypeError('fetch failed'));
    const { fetch } = scriptedFetch([offline, offline, offline]);
    const failure = failureOf(await send(fetch));

    expect(failure).toBeInstanceOf(EmailSendFailed);
    expect(failure).toMatchObject({
      message: expect.stringMatching(/^Resend unreachable: /),
      retryable: true,
    });
  });

  it('retries on the schedule it is given', async () => {
    const { fetch, sent } = scriptedFetch([json(503, { name: 'service_unavailable' })]);

    await send(fetch, { ...options, retrySchedule: Schedule.recurs(0) });

    expect(sent).toHaveLength(1);
  });

  // Simulated clock (it.effect): the 10-second timeout and the default backoff pass instantly.
  it.effect('gives up on an attempt after 10 seconds, and retries it', () =>
    Effect.gen(function* () {
      let attempts = 0;

      // Never answers; gives up only when the transport aborts the request.
      const hanging: typeof globalThis.fetch = (_input, init) => {
        attempts++;

        return new Promise((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
        );
      };

      const fiber = yield* Effect.forkChild(Effect.exit(sending(hanging)));

      for (let i = 0; i < 6; i++) yield* TestClock.adjust('10 seconds');
      const failure = failureOf(yield* Fiber.join(fiber));

      expect(attempts).toBe(3);
      expect(failure).toBeInstanceOf(EmailSendFailed);
      expect(failure).toMatchObject({ message: 'Resend timed out', retryable: true });
    }),
  );

  it.effect('backs off between retries by default', () =>
    Effect.gen(function* () {
      const { fetch, sent } = scriptedFetch([
        json(503, { name: 'service_unavailable' }),
        json(200, { id: '1' }),
      ]);

      const fiber = yield* Effect.forkChild(
        Effect.exit(sending(fetch, { ...options, retrySchedule: undefined })),
      );

      // Not before the first backoff (0.5 s, jittered down to at most 20%)...
      yield* TestClock.adjust('300 millis');
      expect(sent).toHaveLength(1);

      // ...and done once it has passed.
      yield* TestClock.adjust('1 second');
      expect(Exit.isSuccess(yield* Fiber.join(fiber))).toBe(true);
      expect(sent).toHaveLength(2);
    }),
  );
});

describe('EmailTransport.fromPromise', () => {
  it('turns anything thrown into a failure that is not retried', async () => {
    const exit = await Effect.runPromiseExit(
      EmailTransport.use((transport) => transport.send(email)).pipe(
        Effect.provide(EmailTransport.fromPromise(() => Promise.reject('not an Error'))),
      ),
    );

    expect(failureOf(exit)).toMatchObject({ message: 'Email send failed', retryable: false });
  });
});

describe('resendLayer', () => {
  it('sends through fetch', async () => {
    const { fetch, sent } = scriptedFetch([json(200, { id: '1' })]);

    const exit = await Effect.runPromiseExit(
      EmailTransport.use((transport) => transport.send(email)).pipe(
        Effect.provide(resendLayer(options)),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
      ),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(sent).toHaveLength(1);
  });
});
