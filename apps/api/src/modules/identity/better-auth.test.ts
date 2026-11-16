import { afterAll, describe, expect, it } from 'vitest';
import type { ErrorEvent } from '@sentry/node';
import { Redacted, Schema } from 'effect';
import { AuthConfig } from '@roundtable/contract';
import { Sentry } from '../../platform/observability/error-tracking.js';
import { env, setupTestApp } from '#test/helpers';

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

  it('offers and accepts none without credentials', async () => {
    const config = await none.inject({ method: 'GET', url: '/api/auth-config' });

    expect(Schema.decodeUnknownSync(AuthConfig)(config.json())).toEqual({ providers: [] });
    expect((await startSocialSignIn(none, 'github')).statusCode).toBeGreaterThanOrEqual(400);
  });
});

// Better Auth catches its own failures and answers 500 itself, so the server's reporting never
// sees them: identity reports them through ErrorReporter instead, exactly once.
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
    expect(lines.some((line) => line.includes('Unexpected error in Better Auth'))).toBe(true);

    for (const output of [JSON.stringify(events), ...lines]) {
      expect(output).not.toContain(email);
      expect(output).not.toContain(password);
    }
  });
});
