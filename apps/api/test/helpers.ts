import type { ErrorEvent } from '@sentry/node';
import { Effect, Redacted } from 'effect';
import { HttpRouter } from 'effect/http';
import { HttpApi } from 'effect/http-api';
import { RoundtableApi } from '@roundtable/contract';
import { appWebHandler } from '../src/server.js';
import { createDb } from '../src/platform/database/promise.js';
import { runMigrations } from '../src/platform/database/migrate.js';
import { EmailTransport, type Email, type SendEmail } from '../src/modules/email/index.js';
import { loadEnv, type Env } from '../src/platform/config/env.js';
import { scrubEvent } from '../src/platform/observability/error-tracking.js';
import { createLogger } from '../src/platform/observability/logging.js';
import { testDatabaseUrl } from './test-database.js';

export const env = loadEnv({
  DATABASE_URL: testDatabaseUrl,
  BETTER_AUTH_SECRET: 'test-secret-that-is-at-least-32-characters-long',
  BETTER_AUTH_URL: 'http://localhost:5173',
});

/** A JSON request body: what tests send, valid or deliberately not. */
// `undefined` properties are allowed because JSON.stringify drops them, as a client would.
export type Json =
  string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json | undefined };

export interface InjectRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  url: string;
  headers?: Readonly<Record<string, string>>;
  payload?: Json;
}

export interface Cookie {
  name: string;
  value: string;
  /** Set-Cookie attributes the tests check: what makes a session cookie safe. */
  httpOnly: boolean;
  secure: boolean;
  sameSite?: string;
}

export interface InjectResponse {
  statusCode: number;
  /** Lower-case names. `set-cookie` is parsed into `cookies` instead. */
  headers: Readonly<Record<string, string>>;
  cookies: readonly Cookie[];
  body: string;
  json<T = unknown>(): T;
}

export interface TestAppOptions {
  env?: Partial<Env>;
  /** Replaces the mailer that captures emails in `sentEmails` (e.g. with one that throws). */
  sendEmail?: SendEmail;
  /** Point the app at another database, e.g. an unreachable one to test outages. */
  databaseUrl?: string;
  /** Where the app's log lines go; logging is off otherwise. */
  logStream?: { write(line: string): void };
  /** Add GET /api/test-crash, which throws 'route exploded': for error-reporting tests. */
  crashRoute?: boolean;
  /**
   * Turn error tracking on, scrubbed as in production, capturing each event here instead of
   * sending it. Sentry has one client per process: one such app at a time.
   */
  errorEvents?: ErrorEvent[];
}

/** Sentry only starts with a DSN; this one is never sent to, since beforeSend drops events. */
const TEST_SENTRY_DSN = Redacted.make('https://public@o0.ingest.sentry.io/0');

/**
 * A test app on the test database, reached through `inject` with no network. Tests use only
 * `inject` and the helpers below, never the server framework, so the server behind it can change
 * (ADR-0022 step 4) while the same tests keep checking the same behaviour.
 */
export function setupTestApp(options: TestAppOptions = {}) {
  // For migrations and resets: test-only work the App knows nothing about, as in production.
  const admin = createDb(env.DATABASE_URL, 'roundtable-test-admin');
  const sentEmails: Email[] = [];
  const { errorEvents } = options;

  const appEnv: Env = {
    ...env,
    ...options.env,
    ...(options.databaseUrl && { DATABASE_URL: Redacted.make(options.databaseUrl) }),
    ...(errorEvents && { SENTRY_DSN: TEST_SENTRY_DSN }),
  };

  const { handler, dispose } = appWebHandler({
    env: appEnv,
    log: createLogger({ stream: options.logStream, enabled: Boolean(options.logStream) }),
    emailTransport: EmailTransport.fromPromise(
      options.sendEmail ??
        (async (email) => {
          sentEmails.push(email);
        }),
    ),
    errorTracking: errorEvents && {
      // Capture instead of sending anywhere.
      beforeSend: (event, hint) => {
        errorEvents.push(scrubEvent(event, hint));

        return null;
      },
    },
    extraRoutes: options.crashRoute
      ? HttpRouter.add('GET', '/api/test-crash', Effect.die(new Error('route exploded')))
      : undefined,
  });

  const inject = (request: InjectRequest) => injectWeb(handler, request);

  return {
    inject,
    /**
     * A fetch that reaches this app in-process, for clients that take one (like the web app's typed
     * client). Like a browser on the same origin, it sends `cookie` with every request.
     */
    fetchAs:
      (cookie?: string): typeof globalThis.fetch =>
      (input, init) => {
        const request = new Request(input, init);

        if (cookie) request.headers.set('cookie', cookie);

        return handler(request);
      },
    /** Every route the server answers, as "METHOD /path", except Better Auth's `/api/auth/*`. */
    routes: () => answeredRoutes(inject),
    db: admin.db,
    sentEmails,
    migrate: () => runMigrations(admin.db),
    /**
     * Empties every table in `public`, whichever module owns it. Drizzle's migration history is
     * in its own `drizzle` schema, so it stays.
     */
    reset: async () => {
      sentEmails.length = 0;

      const { rows } = await admin.pool.query<{ name: string }>(
        `select quote_ident(tablename) as name from pg_tables where schemaname = 'public'`,
      );

      if (rows.length > 0) {
        await admin.pool.query(`truncate table ${rows.map((row) => row.name).join(', ')}`);
      }
    },
    /** Stops the App (closing its pools, flushing Sentry) and the test's own connections. */
    close: async () => {
      await dispose();
      await admin.pool.end();
    },
  };
}

/** `name=value` from each Set-Cookie header, with the value URL-decoded. */
export function parseSetCookies(setCookies: readonly string[]): Cookie[] {
  return setCookies.map((line) => {
    const [pair = '', ...attributes] = line.split(';').map((part) => part.trim());
    const separator = pair.indexOf('=');
    const raw = pair.slice(separator + 1);
    const flags = attributes.map((attribute) => attribute.toLowerCase());
    const sameSite = flags.find((flag) => flag.startsWith('samesite='))?.slice('samesite='.length);

    const cookie: Cookie = {
      name: pair.slice(0, separator),
      value: raw,
      httpOnly: flags.includes('httponly'),
      secure: flags.includes('secure'),
    };

    if (sameSite) cookie.sameSite = sameSite;

    try {
      cookie.value = decodeURIComponent(raw);
    } catch {
      // Not percent-encoded: keep it as sent.
    }

    return cookie;
  });
}

type WebHandler = (request: Request) => Promise<Response>;

async function injectWeb(handler: WebHandler, request: InjectRequest): Promise<InjectResponse> {
  // A JSON body is sent the way a browser or client would: serialised, with its content type.
  // GET and DELETE carry no body, as with a real client.
  const hasBody =
    request.payload !== undefined && request.method !== 'GET' && request.method !== 'DELETE';

  const headers = new Headers(request.headers);

  if (hasBody && !headers.has('content-type')) headers.set('content-type', 'application/json');

  const res = await handler(
    new Request(new URL(request.url, 'http://localhost'), {
      method: request.method,
      headers,
      body: hasBody ? JSON.stringify(request.payload) : undefined,
    }),
  );

  const body = await res.text();
  const responseHeaders: Record<string, string> = {};

  res.headers.forEach((value, name) => {
    if (name !== 'set-cookie') responseHeaders[name] = value;
  });

  return {
    statusCode: res.status,
    headers: responseHeaders,
    cookies: parseSetCookies(res.headers.getSetCookie()),
    body,
    json: () => JSON.parse(body),
  };
}

/**
 * The contract's endpoints that the running server actually answers. Unauthenticated, every
 * applications endpoint stops at the session check (401) and the public ones answer (200); an
 * endpoint the server doesn't serve gets the router's 404 instead.
 */
async function answeredRoutes(inject: (request: InjectRequest) => Promise<InjectResponse>) {
  const declared: { method: InjectRequest['method']; path: string }[] = [];

  HttpApi.reflect(RoundtableApi, {
    onGroup: () => {},
    onEndpoint: ({ endpoint }) => {
      if (isInjectMethod(endpoint.method))
        declared.push({ method: endpoint.method, path: endpoint.path });
    },
  });

  const answered: string[] = [];

  for (const { method, path } of declared) {
    const url = path.replace(':id', crypto.randomUUID());
    const hasBody = method === 'POST' || method === 'PATCH';
    const res = await inject({ method, url, payload: hasBody ? {} : undefined });

    if (res.statusCode !== 404) answered.push(`${method} ${path}`);
  }

  return answered.sort();
}

const isInjectMethod = (method: string): method is InjectRequest['method'] =>
  ['GET', 'POST', 'PATCH', 'DELETE'].includes(method);

export type TestApp = ReturnType<typeof setupTestApp>;

/** Finds (and removes) the most recent email sent to `to` whose subject contains `subject`. */
export function takeEmail(t: TestApp, to: string, subject: string): Email {
  const index = t.sentEmails.findLastIndex((e) => e.to === to && e.subject.includes(subject));

  if (index === -1) throw new Error(`no "${subject}" email to ${to}`);

  return t.sentEmails.splice(index, 1)[0]!;
}

/** The link in an email, as a path the test app can `inject` (the email has the public origin). */
export function linkPath(email: Email): string {
  const match = email.text.match(/https?:\/\/\S+/);

  if (!match) throw new Error(`no link in email: ${email.text}`);
  const url = new URL(match[0]);

  return url.pathname + url.search;
}

/** Signs up through the real endpoint without verifying the email. No session yet. */
export async function signUpUnverified(
  t: TestApp,
  email = `user-${crypto.randomUUID()}@example.com`,
  password = 'correct horse battery',
) {
  const res = await t.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    headers: { origin: env.BETTER_AUTH_URL },
    payload: { email, password, name: 'Test User' },
  });

  if (res.statusCode !== 200) throw new Error(`sign-up failed: ${res.statusCode} ${res.body}`);

  return { email, password, res };
}

/**
 * Signs up a new user, clicks the verification link like a real user, and returns the session
 * cookie that verification sets.
 */
export async function signUp(t: TestApp, email?: string, password?: string) {
  const signedUp = await signUpUnverified(t, email, password);

  const verify = await t.inject({
    method: 'GET',
    url: linkPath(takeEmail(t, signedUp.email, 'Confirm your email')),
  });

  if (verify.statusCode !== 302) {
    throw new Error(`verification failed: ${verify.statusCode} ${verify.body}`);
  }

  const cookie = verify.cookies.map((c) => `${c.name}=${c.value}`).join('; ');

  if (!cookie.includes('session_token')) throw new Error('verification did not sign in');

  const session = await t.inject({
    method: 'GET',
    url: '/api/auth/get-session',
    headers: { cookie },
  });

  return {
    email: signedUp.email,
    password: signedUp.password,
    cookie,
    user: session.json<{ user: { id: string } }>().user,
  };
}
