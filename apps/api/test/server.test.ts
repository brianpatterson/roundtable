// The production wiring (serveApp: the API on a real Node HTTP server), not the web handler the
// other tests use. A layer provided in the wrong place passed every other test yet sent request
// logs to the console unredacted under the real server, so this checks the real one.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ErrorEvent } from '@sentry/node';
import { Cause, Effect, Exit, Fiber, Layer, Redacted, Schema } from 'effect';
import { generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:net';
import { serveApp } from '../src/server.js';
import { scrubEvent, Sentry } from '../src/platform/observability/error-tracking.js';
import { createLogger } from '../src/platform/observability/logging.js';
import { MAX_REQUEST_BODY_BYTES } from '../src/platform/http/body-limit.js';
import { env, setupTestApp, signUp } from './helpers.js';

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer();

    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Finite }))(
        probe.address(),
      );

      probe.close(() => resolve(port));
    });
  });

describe('the production server (serveApp)', () => {
  const events: ErrorEvent[] = [];
  const lines: string[] = [];

  const consoleOutput = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation(() => {}),
  );

  // Sign in on a working database, then serve with an unreachable one: the session lookup fails.
  const t = setupTestApp();
  const deadUrl = Redacted.make('postgres://app:app@localhost:1/nowhere');
  let cookie = '';
  let token = '';
  let base = '';
  let server: Fiber.Fiber<never, unknown> | undefined;

  beforeAll(async () => {
    await t.migrate();
    await t.reset();
    ({ cookie } = await signUp(t));
    token = decodeURIComponent(cookie.match(/session_token=([^;.]+)/)?.[1] ?? '');

    const port = await freePort();

    base = `http://127.0.0.1:${port}`;
    server = Effect.runFork(
      Layer.launch(
        serveApp({
          env: {
            ...env,
            DATABASE_URL: deadUrl,
            SENTRY_DSN: Redacted.make('https://public@o0.ingest.sentry.io/0'),
          },
          log: createLogger({ stream: { write: (line) => void lines.push(line) } }),
          errorTracking: {
            beforeSend: (event, hint) => {
              events.push(scrubEvent(event, hint));

              return null;
            },
          },
          port,
          host: '127.0.0.1',
        }),
      ),
    );

    for (let attempt = 0; attempt < 50; attempt++) {
      if (
        await fetch(`${base}/api/health`).then(
          () => true,
          () => false,
        )
      )
        return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    throw new Error('server did not start');
  });

  afterAll(async () => {
    if (server) await Effect.runPromise(Fiber.interrupt(server));

    for (const spy of consoleOutput) spy.mockRestore();
    await t.close();
  });

  it('logs every line, request logs included, as redacted JSON, and reports the failure', async () => {
    const res = await fetch(`${base}/api/applications`, { headers: { cookie } });

    expect(res.status).toBe(500);
    await Sentry.flush(2000);

    expect(token).not.toBe('');
    // Every line is pino JSON: nothing went to Effect's own console logger.
    expect(lines.length).toBeGreaterThan(0);

    for (const line of lines) expect(JSON.parse(line)).toHaveProperty('level');
    expect(lines.some((line) => line.includes('"http.status":500'))).toBe(true);
    expect(lines.join('')).not.toContain(token);
    expect(consoleOutput.flatMap((spy) => spy.mock.calls)).toEqual([]);

    // Our ErrorReporter saw the failure inside request handling (its top error is the session
    // lookup's Effect.tryPromise wrapper), with the redaction applied.
    const reported = events.find((e) => e.exception?.values?.at(-1)?.type === 'UnknownError');

    expect(reported).toBeDefined();

    // What's sent: Sentry deletes sdkProcessingMetadata before building the envelope
    // (@sentry/core createEventEnvelope). It holds the raw incoming request, cookie included,
    // for the SDK's own processing; event.request is what Sentry receives, and it's scrubbed.
    if (!reported) throw new Error('no event from our reporter');
    const { sdkProcessingMetadata: _internal, ...sent } = reported;

    expect(JSON.stringify(sent)).not.toContain(token);
    expect(JSON.stringify(sent.request ?? {})).not.toContain('session_token');
  });

  // The reset link carries its token in the path, and the Node server's Http integration attaches
  // the incoming request (url and transaction name) to every event from it.
  it('reports a failed reset link without the path segment after /reset-password/', async () => {
    const resetToken = 'ResetLinkPathSegment0123456789';
    const callbackURL = encodeURIComponent(`${env.BETTER_AUTH_URL}/reset-password`);
    const before = events.length;

    const res = await fetch(
      `${base}/api/auth/reset-password/${resetToken}?callbackURL=${callbackURL}`,
      { redirect: 'manual' },
    );

    expect(res.status).toBe(500);
    await Sentry.flush(2000);

    const reported = events
      .slice(before)
      .map(({ sdkProcessingMetadata: _internal, ...sent }) => sent);

    expect(reported.length).toBeGreaterThan(0);
    expect(JSON.stringify(reported)).not.toContain(resetToken);
    expect(reported.some((e) => e.request?.url?.endsWith('/reset-password/<redacted>'))).toBe(true);
  });

  // The Node server reads bodies its own way (and hands Better Auth a stream): the limit holds.
  it.each([
    ['a contract endpoint', '/api/reports'],
    ["one of Better Auth's", '/api/auth/sign-in/email'],
  ])('answers 413 to a body past the size limit on %s', async (_, path) => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: env.BETTER_AUTH_URL },
      body: JSON.stringify({ description: 'x'.repeat(MAX_REQUEST_BODY_BYTES), pagePath: '/' }),
    });

    expect(res.status).toBe(413);
  });

  // Last: it stops the server.
  it('logs that it is shutting down when stopped', async () => {
    if (server) await Effect.runPromise(Fiber.interrupt(server));
    server = undefined;

    expect(lines.map((line) => JSON.parse(line).msg)).toContain('Shutting down');
  });
});

// A bad GitHub App key fails the deploy's health check and rolls it back (ADR-0014), instead of
// going live and losing the first user report.
describe('starting the production server with the GitHub App', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

  const start = async (key: string | undefined) => {
    const port = await freePort();

    // Builds the whole server, port and all, then stops it: success means it started.
    return Effect.runPromiseExit(
      Effect.scoped(
        Layer.build(
          serveApp({
            env: {
              ...env,
              ...(key !== undefined && {
                GITHUB_ISSUES_APP_ID: '123',
                GITHUB_ISSUES_INSTALLATION_ID: '42',
                GITHUB_ISSUES_PRIVATE_KEY: Redacted.make(key),
                GITHUB_ISSUES_REPOSITORY: 'owner/repo',
              }),
            },
            log: createLogger({ enabled: false }),
            port,
            host: '127.0.0.1',
          }),
        ),
      ),
    );
  };

  it.each([
    ['malformed', 'not-a-key-secret-material'],
    ['truncated partway through', pem.slice(0, pem.length / 2)],
  ])('refuses to start when the key is %s, naming it but not quoting it', async (_, key) => {
    const exit = await start(key);

    expect(Exit.isFailure(exit)).toBe(true);

    const shown = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : '';

    expect(shown).toMatch(/GITHUB_ISSUES_PRIVATE_KEY.*invalid/);
    expect(shown).not.toContain('secret-material');

    // No line of the key, beyond the PEM header every key shares.
    for (const line of key.split('\n').slice(1).filter(Boolean)) {
      expect(shown).not.toContain(line);
    }
  });

  it.each([
    ['a valid key with real newlines', pem],
    ['a valid key on one line, with \\n for its newlines', pem.replaceAll('\n', '\\n')],
    ['no GitHub App configured', undefined],
  ])('starts with %s', async (_, key) => {
    expect(Exit.isSuccess(await start(key))).toBe(true);
  });
});
