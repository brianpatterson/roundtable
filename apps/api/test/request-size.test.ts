// Request bodies have one size limit for every route: the contract's endpoints, which Effect
// reads, and Better Auth's, which get the body as a Web Request. Past it, a 413 before parsing.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_REQUEST_BODY_BYTES } from '../src/platform/http/body-limit.js';
import { env, setupTestApp } from './helpers.js';

describe('request body size', () => {
  const t = setupTestApp();
  const tooLong = 'x'.repeat(MAX_REQUEST_BODY_BYTES);

  beforeAll(async () => {
    await t.migrate();
    await t.reset();
  });
  afterAll(() => t.close());

  it.each([
    ['a contract endpoint', '/api/reports', { description: tooLong, pagePath: '/' }],
    [
      "one of Better Auth's",
      '/api/auth/sign-in/email',
      { email: 'someone@example.com', password: tooLong },
    ],
  ])('answers 413 to a body past the limit on %s', async (_, url, payload) => {
    const res = await t.inject({
      method: 'POST',
      url,
      headers: { origin: env.BETTER_AUTH_URL },
      payload,
    });

    expect(res.statusCode).toBe(413);
  });

  it('reads a body under the limit as before', async () => {
    const res = await t.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: { origin: env.BETTER_AUTH_URL },
      payload: { email: 'someone@example.com', password: 'x'.repeat(MAX_REQUEST_BODY_BYTES / 2) },
    });

    // Better Auth's own answer to a password that long: the body was read and parsed.
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'PASSWORD_TOO_LONG' });
  });
});
