import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DIAGNOSTIC_ERRORS_MAX,
  DIAGNOSTIC_MESSAGE_MAX,
  DIAGNOSTIC_REQUESTS_MAX,
  DIAGNOSTIC_STACK_MAX,
} from '@roundtable/contract';
import {
  clearDiagnostics,
  collectDiagnostics,
  recordError,
  recordRequest,
  recordUncaughtErrors,
  recordingFetch,
} from './diagnostics';

const answering = (status: number) => recordingFetch(async () => new Response(null, { status }));

const failing = recordingFetch(async () => {
  throw new TypeError('Failed to fetch');
});

beforeEach(() => clearDiagnostics());

afterEach(() => clearDiagnostics());

describe('recordingFetch', () => {
  it('notes an API request by method, path and status, without its query or hash', async () => {
    const response = await answering(500)('/api/auth/callback/github?code=secret#x', {
      method: 'post',
    });

    expect(response.status).toBe(500);
    expect(collectDiagnostics().requests).toEqual([
      { method: 'POST', path: '/api/auth/callback/github', status: 500, secondsBefore: 0 },
    ]);
  });

  it('notes a network failure as status 0 and still throws it', async () => {
    await expect(
      failing(new Request(`${window.location.origin}/api/applications`)),
    ).rejects.toThrow('Failed to fetch');

    expect(collectDiagnostics().requests).toEqual([
      { method: 'GET', path: '/api/applications', status: 0, secondsBefore: 0 },
    ]);
  });

  it('ignores other origins, pages that are not the API, and the report itself', async () => {
    await answering(200)('https://example.com/api/applications');
    await answering(200)('/index.html');
    await answering(201)('/api/reports', { method: 'POST' });

    expect(collectDiagnostics().requests).toEqual([]);
  });

  it('notes what a client reports through its own hook, as Better Auth does', () => {
    recordRequest('get', new URL('/api/auth/get-session?x=1', window.location.origin), 401);

    expect(collectDiagnostics().requests).toEqual([
      { method: 'GET', path: '/api/auth/get-session', status: 401, secondsBefore: 0 },
    ]);
  });

  it(`keeps only the latest ${DIAGNOSTIC_REQUESTS_MAX}, oldest first`, async () => {
    for (let i = 0; i < DIAGNOSTIC_REQUESTS_MAX + 3; i++) await answering(200)(`/api/x/${i}`);

    const paths = collectDiagnostics().requests?.map((r) => r.path);

    expect(paths).toHaveLength(DIAGNOSTIC_REQUESTS_MAX);
    expect(paths?.[0]).toBe('/api/x/3');
    expect(paths?.at(-1)).toBe(`/api/x/${DIAGNOSTIC_REQUESTS_MAX + 2}`);
  });
});

describe('recordError', () => {
  it('cuts the message and stack to the contract limits, and keeps the latest few', () => {
    const big = {
      message: 'm'.repeat(DIAGNOSTIC_MESSAGE_MAX * 2),
      stack: 's'.repeat(DIAGNOSTIC_STACK_MAX * 2),
    };

    recordError(big);

    for (let i = 0; i < DIAGNOSTIC_ERRORS_MAX; i++) recordError({ message: `rejection ${i}` });

    const errors = collectDiagnostics().errors ?? [];

    expect(errors).toHaveLength(DIAGNOSTIC_ERRORS_MAX);
    expect(errors[0]).toEqual({ message: 'rejection 0', secondsBefore: 0 });

    clearDiagnostics();
    recordError(big);
    const [only] = collectDiagnostics().errors ?? [];

    expect(only?.message).toHaveLength(DIAGNOSTIC_MESSAGE_MAX);
    expect(only?.stack).toHaveLength(DIAGNOSTIC_STACK_MAX);
  });
});

describe('recordUncaughtErrors', () => {
  recordUncaughtErrors();

  it('notes an uncaught Error with its name and stack, and a thrown non-Error by its message', () => {
    const error = new TypeError('x is undefined');

    window.dispatchEvent(new ErrorEvent('error', { error, message: 'Uncaught TypeError' }));
    window.dispatchEvent(new ErrorEvent('error', { error: 42, message: 'Uncaught 42' }));

    expect(collectDiagnostics().errors).toEqual([
      { message: 'TypeError: x is undefined', stack: error.stack, secondsBefore: 0 },
      { message: 'Uncaught 42', secondsBefore: 0 },
    ]);
  });

  it('notes an unhandled rejection', () => {
    const event = new Event('unhandledrejection');

    Object.assign(event, { reason: 'offline' });
    window.dispatchEvent(event);

    expect(collectDiagnostics().errors).toEqual([
      { message: 'Unhandled rejection: offline', secondsBefore: 0 },
    ]);
  });
});

describe('collectDiagnostics', () => {
  it('says how long before the report each thing happened, in whole seconds', async () => {
    const start = Date.now();

    await answering(404)('/api/applications/1');
    recordError({ message: 'Error: boom' });

    const diagnostics = collectDiagnostics(start + 12_400);

    expect(diagnostics.requests?.[0]?.secondsBefore).toBe(12);
    expect(diagnostics.errors?.[0]?.secondsBefore).toBe(12);
    expect(diagnostics.theme).toBe('system');
  });
});
